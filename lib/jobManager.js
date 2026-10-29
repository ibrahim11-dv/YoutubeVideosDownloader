const { spawn } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { ensureBinaries } = require('./binaries');
const { isYouTubeUrl, buildDownloadArgs } = require('./ytdlp');

const jobs = new Map();
const JOB_TTL_MS = 25 * 60 * 1000; // 25 minutes

function createZipFromDir(sourceDir, outZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });

    output.on('close', () => resolve(outZipPath));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function parseProgressLine(line) {
  const idx = line.indexOf('PROG:');
  if (idx === -1) return null;
  const payload = line.slice(idx + 5).trim();
  const [rawPct, rawSpeed, rawEta, rawTotal, rawStatus] = payload.split('|').map((s) => (s || '').trim());

  const pctNum = parseFloat(rawPct.replace('%', ''));
  return {
    percent: Number.isFinite(pctNum) ? Math.min(100, Math.max(0, pctNum)) : null,
    speed: rawSpeed && rawSpeed !== 'NA' && rawSpeed !== 'Unknown B/s' ? rawSpeed : null,
    eta: rawEta && rawEta !== 'NA' && rawEta !== 'Unknown' ? rawEta : null,
    totalSize: rawTotal && rawTotal !== 'NA' ? rawTotal : null,
    status: rawStatus || 'downloading',
  };
}

function detectStageFromLine(line) {
  if (line.includes('[Merger]') || line.includes('Merging formats')) {
    return 'MERGING STREAMS';
  }
  if (line.includes('[ExtractAudio]')) {
    return 'TRANSCODING AUDIO';
  }
  if (line.includes('[ModifyChapters]') || line.includes('[SponsorBlock]')) {
    return 'SPONSORBLOCK / CHAPTERS';
  }
  if (line.includes('[SplitChapters]')) {
    return 'SPLITTING CHAPTERS';
  }
  if (line.includes('[EmbedThumbnail]') || line.includes('[Metadata]')) {
    return 'EMBEDDING METADATA';
  }
  if (line.includes('[EmbedSubtitle]')) {
    return 'MUXING SUBTITLES';
  }
  if (line.includes('[download] Destination:')) {
    return 'DOWNLOADING STREAM';
  }
  return null;
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
  if (job.proc && !job.proc.killed) {
    try {
      job.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  if (job.tmpDir && fs.existsSync(job.tmpDir)) {
    fs.rm(job.tmpDir, { recursive: true, force: true }, () => {});
  }
  jobs.delete(jobId);
}

function emitJobUpdate(job, eventType = 'update') {
  const snapshot = getJobSnapshot(job);
  job.emitter.emit(eventType, snapshot);
}

function getJobSnapshot(job) {
  return {
    id: job.id,
    title: job.title,
    format: job.format,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    totalSize: job.totalSize,
    batchCurrent: job.batchCurrent,
    batchTotal: job.batchTotal,
    fileName: job.fileName,
    fileSize: job.fileSize,
    error: job.error,
    createdAt: job.createdAt,
  };
}

async function runSingleYtDlpDownload(job, url, outDir, itemIndex, totalItems) {
  const bins = await ensureBinaries();
  const chaptersDir = path.join(outDir, 'chapters');
  if (job.options.splitChapters) {
    fs.mkdirSync(chaptersDir, { recursive: true });
  }

  const prefix =
    totalItems > 1 && job.options.numberFiles !== false
      ? `${String(itemIndex).padStart(2, '0')} - `
      : '';
  const outputTemplate = path.join(outDir, `${prefix}%(title).100B.%(ext)s`);

  const args = [];
  if (bins.ffmpegPath && bins.ffmpegPath !== 'ffmpeg') {
    args.push('--ffmpeg-location', bins.ffmpegPath);
  }

  if (job.options.splitChapters) {
    args.push(
      '-o',
      `chapter:${path.join(chaptersDir, '%(section_number)02d - %(section_title).80B.%(ext)s')}`
    );
  }

  args.push(
    ...buildDownloadArgs({
      ...job.options,
      url,
      outputTemplate,
      withProgress: true,
    })
  );

  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Job cancelled'));

    const proc = spawn(bins.ytdlpPath, args, { windowsHide: true });
    job.proc = proc;
    let stderrTail = '';

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        if (!line.trim()) continue;

        const stage = detectStageFromLine(line);
        if (stage) {
          job.stage = totalItems > 1 ? `[TRACK ${itemIndex}/${totalItems}] ${stage}` : stage;
          emitJobUpdate(job);
        }

        const prog = parseProgressLine(line);
        if (prog) {
          if (prog.percent !== null) {
            if (totalItems > 1) {
              const basePct = ((itemIndex - 1) / totalItems) * 100;
              job.percent = Math.round((basePct + prog.percent / totalItems) * 10) / 10;
            } else {
              job.percent = Math.round(prog.percent * 10) / 10;
            }
          }
          if (prog.speed) job.speed = prog.speed;
          if (prog.eta) job.eta = prog.eta;
          if (prog.totalSize) job.totalSize = prog.totalSize;
          if (!job.stage || job.stage === 'INITIALIZING') {
            job.stage = totalItems > 1 ? `[TRACK ${itemIndex}/${totalItems}] DOWNLOADING` : 'DOWNLOADING';
          }
          emitJobUpdate(job);
        }
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1200);
      handleChunk(d);
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('Job cancelled'));
      if (code === 0) return resolve({ chaptersDir });
      reject(new Error(stderrTail.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function createJob(options = {}) {
  const urls = Array.isArray(options.urls) && options.urls.length > 0
    ? options.urls
    : [options.url];

  if (urls.length === 0 || !urls.every(isYouTubeUrl)) {
    throw new Error('Invalid YouTube URL(s) provided');
  }

  const id = crypto.randomBytes(6).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ytdl-job-${id}-`));
  const workDir = path.join(tmpDir, 'output');
  fs.mkdirSync(workDir, { recursive: true });

  const emitter = new EventEmitter();
  // Prevent Node.js ERR_UNHANDLED_ERROR crash if 'error' is emitted after SSE client disconnects
  emitter.on('error', () => {});

  const job = {
    id,
    title: options.title || (urls.length > 1 ? `Playlist / Batch (${urls.length} tracks)` : 'YouTube Media'),
    format: options.format || '720p',
    options: {
      format: options.format || '720p',
      clipStart: options.clipStart,
      clipEnd: options.clipEnd,
      sponsorBlock: Boolean(options.sponsorBlock),
      embedMetadata: Boolean(options.embedMetadata),
      embedThumbnail: Boolean(options.embedThumbnail),
      splitChapters: Boolean(options.splitChapters),
      embedSubs: Boolean(options.embedSubs),
      subLang: options.subLang || 'en',
      numberFiles: options.numberFiles !== false,
    },
    urls,
    status: 'running',
    stage: 'INITIALIZING ENGINE',
    percent: 0,
    speed: null,
    eta: null,
    totalSize: null,
    batchCurrent: 1,
    batchTotal: urls.length,
    tmpDir,
    workDir,
    filePath: null,
    fileName: null,
    fileSize: null,
    error: null,
    cancelled: false,
    proc: null,
    emitter,
    createdAt: Date.now(),
    cleanupTimer: setTimeout(() => cleanupJob(id), JOB_TTL_MS),
  };

  jobs.set(id, job);

  // Execute asynchronously
  (async () => {
    try {
      for (let i = 0; i < urls.length; i++) {
        if (job.cancelled) throw new Error('Cancelled by user');
        job.batchCurrent = i + 1;
        job.stage = urls.length > 1 ? `[TRACK ${i + 1}/${urls.length}] STARTING` : 'STARTING DOWNLOAD';
        emitJobUpdate(job);

        try {
          await runSingleYtDlpDownload(job, urls[i], workDir, i + 1, urls.length);
        } catch (trackErr) {
          // In a multi-track playlist batch, skip unavailable/restricted tracks if others succeed
          if (urls.length > 1 && !job.cancelled) {
            console.warn(`[playlist] Skipping failed track ${i + 1}/${urls.length}:`, trackErr.message);
            continue;
          }
          throw trackErr;
        }
      }

      const chaptersDir = path.join(workDir, 'chapters');
      const hasSplitChapters =
        job.options.splitChapters &&
        fs.existsSync(chaptersDir) &&
        fs.readdirSync(chaptersDir).length > 0;

      if (hasSplitChapters) {
        job.stage = 'PACKAGING CHAPTERS ZIP';
        job.percent = 99;
        emitJobUpdate(job);

        const safeBase = (job.title || 'chapters').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 70);
        const zipName = `${safeBase}_chapters.zip`;
        const zipPath = path.join(tmpDir, zipName);
        await createZipFromDir(chaptersDir, zipPath);

        job.filePath = zipPath;
        job.fileName = zipName;
      } else {
        const producedFiles = fs
          .readdirSync(workDir)
          .filter((f) => {
            const full = path.join(workDir, f);
            return (
              fs.statSync(full).isFile() &&
              !f.endsWith('.part') &&
              !f.endsWith('.ytdl') &&
              !f.endsWith('.jpg') &&
              !f.endsWith('.webp')
            );
          });

        if (producedFiles.length === 0) {
          throw new Error('No output media file was produced');
        }

        if (producedFiles.length > 1) {
          job.stage = `PACKAGING PLAYLIST ZIP (${producedFiles.length} FILES)`;
          job.percent = 99;
          emitJobUpdate(job);

          const safeBase = (job.title || 'youtube_playlist').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 70);
          const zipName = `${safeBase}.zip`;
          const zipPath = path.join(tmpDir, zipName);
          await createZipFromDir(workDir, zipPath);

          job.filePath = zipPath;
          job.fileName = zipName;
        } else {
          job.filePath = path.join(workDir, producedFiles[0]);
          job.fileName = producedFiles[0];
        }
      }

      const stat = fs.statSync(job.filePath);
      job.fileSize = stat.size;
      job.percent = 100;
      job.speed = null;
      job.eta = '00:00';
      job.stage = 'READY FOR TRANSFER';
      job.status = 'completed';
      emitJobUpdate(job, 'complete');
    } catch (err) {
      if (job.cancelled) {
        job.status = 'cancelled';
        job.stage = 'CANCELLED';
      } else {
        job.status = 'error';
        job.stage = 'FAILED';
        job.error = err.message || 'Download failed';
      }
      emitJobUpdate(job, 'error');
    }
  })();

  return getJobSnapshot(job);
}

function getJob(id) {
  return jobs.get(id) || null;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  if (job.proc && !job.proc.killed) {
    try {
      job.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  cleanupJob(id);
  return true;
}

module.exports = {
  createJob,
  getJob,
  getJobSnapshot,
  cancelJob,
  cleanupJob,
  parseProgressLine,
};
