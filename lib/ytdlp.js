const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureBinaries } = require('./binaries');

function normalizeYouTubeUrl(u) {
  if (typeof u !== 'string') return '';
  let s = u.trim();
  if (!s) return '';
  if (/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

function isYouTubeUrl(u) {
  const s = normalizeYouTubeUrl(u);
  if (!s) return false;
  try {
    const { hostname, protocol } = new URL(s);
    return (
      ['http:', 'https:'].includes(protocol) &&
      /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function parseYouTubeUrlInfo(u) {
  const s = normalizeYouTubeUrl(u);
  if (!isYouTubeUrl(s)) return { valid: false };
  const parsed = new URL(s);
  const listId = parsed.searchParams.get('list');
  const videoId =
    parsed.hostname === 'youtu.be'
      ? parsed.pathname.slice(1).split('/')[0]
      : parsed.searchParams.get('v') ||
        (parsed.pathname.startsWith('/shorts/') ? parsed.pathname.split('/')[2] : null);
  const isPurePlaylist = Boolean(
    listId && (!videoId || parsed.pathname.startsWith('/playlist'))
  );
  return {
    valid: true,
    url: s,
    videoId: videoId || null,
    listId: listId || null,
    isPurePlaylist,
    hasPlaylistParam: Boolean(listId),
  };
}

async function runYtDlp(args, { timeoutMs = 120000 } = {}) {
  const bins = await ensureBinaries();
  const fullArgs = [];
  if (bins.ffmpegPath && bins.ffmpegPath !== 'ffmpeg') {
    fullArgs.push('--ffmpeg-location', bins.ffmpegPath);
  }
  fullArgs.push(...args);

  return new Promise((resolve, reject) => {
    const proc = spawn(bins.ytdlpPath, fullArgs, { windowsHide: true });
    let out = '';
    let err = '';

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error('yt-dlp operation timed out'));
          }, timeoutMs)
        : null;

    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function normalizeCodecName(vcodec = '') {
  if (!vcodec || vcodec === 'none') return null;
  if (vcodec.startsWith('av01')) return 'AV1';
  if (vcodec.startsWith('vp9') || vcodec.startsWith('vp09')) return 'VP9';
  if (vcodec.startsWith('avc1') || vcodec.startsWith('h264')) return 'H.264';
  if (vcodec.startsWith('hev1') || vcodec.startsWith('hvc1')) return 'HEVC';
  return vcodec.split('.')[0].toUpperCase();
}

function estimateStreamBytes(f, durationSec) {
  if (typeof f.filesize === 'number' && f.filesize > 0) return f.filesize;
  if (typeof f.filesize_approx === 'number' && f.filesize_approx > 0) return f.filesize_approx;
  const br = f.tbr || f.vbr || f.abr;
  if (br && durationSec > 0) {
    return Math.round((br * 1000 * durationSec) / 8);
  }
  return null;
}

function summarizeFormats(rawFormats = [], durationSec = 0) {
  const audioFormats = rawFormats.filter(
    (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  audioFormats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  const bestAudio = audioFormats[0] || null;
  const bestAudioBytes = bestAudio
    ? estimateStreamBytes(bestAudio, durationSec)
    : durationSec > 0
    ? Math.round((160 * 1000 * durationSec) / 8)
    : 0;

  const tiers = [
    { id: '2160p', label: '2160p', tag: '4K UHD', height: 2160 },
    { id: '1440p', label: '1440p', tag: '2K QHD', height: 1440 },
    { id: '1080p', label: '1080p', tag: 'Full HD', height: 1080 },
    { id: '720p', label: '720p', tag: 'HD', height: 720 },
    { id: '480p', label: '480p', tag: 'Standard', height: 480 },
    { id: '360p', label: '360p', tag: 'Compact', height: 360 },
  ];

  const videoStreams = rawFormats.filter(
    (f) => f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number'
  );

  const videoOptions = [];

  for (const tier of tiers) {
    // Match streams close to this tier height
    const candidates = videoStreams.filter((f) => {
      if (tier.height === 2160) return f.height >= 1900 && f.height <= 2300;
      if (tier.height === 1440) return f.height >= 1300 && f.height < 1900;
      if (tier.height === 1080) return f.height >= 950 && f.height < 1300;
      if (tier.height === 720) return f.height >= 650 && f.height < 950;
      if (tier.height === 480) return f.height >= 420 && f.height < 650;
      if (tier.height === 360) return f.height >= 280 && f.height < 420;
      return f.height === tier.height;
    });

    if (candidates.length === 0) {
      videoOptions.push({
        id: tier.id,
        category: 'video',
        label: tier.label,
        tag: tier.tag,
        available: false,
        codec: null,
        fps: null,
        sizeBytes: null,
      });
      continue;
    }

    // Prefer mp4/avc1 or highest bitrate candidate
    candidates.sort((a, b) => {
      const aMp4 = a.ext === 'mp4' ? 1 : 0;
      const bMp4 = b.ext === 'mp4' ? 1 : 0;
      if (aMp4 !== bMp4) return bMp4 - aMp4;
      return (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0);
    });

    const chosen = candidates[0];
    const vBytes = estimateStreamBytes(chosen, durationSec);
    const hasBundledAudio = chosen.acodec && chosen.acodec !== 'none';
    const totalBytes = vBytes
      ? vBytes + (hasBundledAudio ? 0 : bestAudioBytes || 0)
      : null;

    videoOptions.push({
      id: tier.id,
      category: 'video',
      label: tier.label,
      tag: tier.tag,
      available: true,
      codec: normalizeCodecName(chosen.vcodec),
      fps: chosen.fps ? Math.round(chosen.fps) : 30,
      hdr: Boolean(chosen.dynamic_range && chosen.dynamic_range !== 'SDR'),
      sizeBytes: totalBytes,
    });
  }

  // Add "highest" option
  const highestAvailable = videoOptions.find((v) => v.available) || null;
  videoOptions.unshift({
    id: 'highest',
    category: 'video',
    label: 'BEST',
    tag: highestAvailable ? `Max (${highestAvailable.label})` : 'Highest Available',
    available: true,
    codec: highestAvailable ? highestAvailable.codec : 'AUTO',
    fps: highestAvailable ? highestAvailable.fps : null,
    sizeBytes: highestAvailable ? highestAvailable.sizeBytes : null,
  });

  // Audio options
  const mp3Bytes = durationSec > 0 ? Math.round((320 * 1000 * durationSec) / 8) : bestAudioBytes;
  const m4aBytes = bestAudioBytes || (durationSec > 0 ? Math.round((160 * 1000 * durationSec) / 8) : null);
  const flacBytes = durationSec > 0 ? Math.round((900 * 1000 * durationSec) / 8) : null;
  const wavBytes = durationSec > 0 ? Math.round((1411 * 1000 * durationSec) / 8) : null;

  const audioOptions = [
    {
      id: 'mp3',
      category: 'audio',
      label: 'MP3',
      tag: '320kbps VBR · ID3',
      available: true,
      codec: 'LAME MP3',
      sizeBytes: mp3Bytes,
    },
    {
      id: 'm4a',
      category: 'audio',
      label: 'M4A',
      tag: 'AAC Studio Audio',
      available: true,
      codec: 'AAC',
      sizeBytes: m4aBytes,
    },
    {
      id: 'flac',
      category: 'audio',
      label: 'FLAC',
      tag: 'Lossless Archival',
      available: true,
      codec: 'FLAC 16-bit',
      sizeBytes: flacBytes,
    },
    {
      id: 'wav',
      category: 'audio',
      label: 'WAV',
      tag: 'Uncompressed PCM',
      available: true,
      codec: 'PCM 16-bit',
      sizeBytes: wavBytes,
    },
  ];

  return [...videoOptions, ...audioOptions];
}

function extractSubtitlesList(d) {
  const subs = [];
  const seen = new Set();

  if (d.subtitles && typeof d.subtitles === 'object') {
    for (const [lang, tracks] of Object.entries(d.subtitles)) {
      if (lang === 'live_chat') continue;
      const trackName = (Array.isArray(tracks) && tracks[0]?.name) || lang;
      subs.push({ lang, name: trackName, isAuto: false });
      seen.add(lang);
    }
  }

  if (d.automatic_captions && typeof d.automatic_captions === 'object') {
    // Prioritize English and common languages or original language so we don't flood with 150 auto-translations
    const preferred = new Set(['en', 'en-US', 'en-GB', 'fr', 'es', 'de', 'ar', 'ja', 'pt', 'ru', 'zh-Hans', d.language].filter(Boolean));
    for (const [lang, tracks] of Object.entries(d.automatic_captions)) {
      if (seen.has(lang)) continue;
      const baseLang = lang.split('-')[0];
      if (!preferred.has(lang) && !preferred.has(baseLang) && subs.length >= 12) continue;
      const trackName = (Array.isArray(tracks) && tracks[0]?.name) || `${lang} (Auto)`;
      subs.push({ lang, name: `${trackName} [AUTO]`, isAuto: true });
      seen.add(lang);
    }
  }

  return subs;
}

async function fetchMediaInfo(url, { playlistMode = 'auto' } = {}) {
  const parsed = parseYouTubeUrlInfo(url);
  if (!parsed.valid) {
    throw new Error('Invalid YouTube URL');
  }

  const usePlaylist =
    playlistMode === true ||
    playlistMode === '1' ||
    (playlistMode === 'auto' && parsed.hasPlaylistParam);

  if (usePlaylist && parsed.listId) {
    const isMix = parsed.listId.startsWith('RD');
    const targetUrl =
      isMix || parsed.isPurePlaylist
        ? parsed.url
        : `https://www.youtube.com/playlist?list=${encodeURIComponent(parsed.listId)}`;

    const stdout = await runYtDlp([
      '-4',
      '--dump-single-json',
      '--flat-playlist',
      '--yes-playlist',
      '--playlist-end',
      '100',
      '--no-warnings',
      '--',
      targetUrl,
    ]);
    const d = JSON.parse(stdout);
    const entries = (d.entries || [])
      .filter((e) => e && e.id && e.title !== '[Deleted video]' && e.title !== '[Private video]')
      .slice(0, 100)
      .map((e, idx) => ({
        index: idx + 1,
        id: e.id,
        title: e.title || `Track ${idx + 1}`,
        duration: Math.round(e.duration || 0),
        uploader: e.uploader || e.channel || d.uploader || '',
        url: e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        thumbnail:
          (Array.isArray(e.thumbnails) && e.thumbnails[e.thumbnails.length - 1]?.url) ||
          `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      }));

    const totalDurationSec = entries.reduce((acc, item) => acc + (item.duration || 0), 0);

    return {
      type: 'playlist',
      hasVideoParam: Boolean(parsed.videoId),
      videoId: parsed.videoId,
      listId: parsed.listId,
      playlistDetails: {
        id: d.id || parsed.listId,
        title: d.title || 'YouTube Playlist',
        uploader: d.uploader || d.channel || 'YouTube',
        entryCount: entries.length,
        totalDurationSec,
        entries,
      },
    };
  }

  const stdout = await runYtDlp([
    '-4',
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--',
    parsed.url,
  ]);
  const d = JSON.parse(stdout);
  const durationSec = Math.round(d.duration || 0);
  const formats = summarizeFormats(d.formats || [], durationSec);
  const chapters = Array.isArray(d.chapters)
    ? d.chapters.map((c, idx) => ({
        index: idx + 1,
        title: c.title || `Chapter ${idx + 1}`,
        startTime: Math.max(0, Math.floor(c.start_time || 0)),
        endTime: Math.ceil(c.end_time || durationSec),
      }))
    : [];
  const subtitles = extractSubtitlesList(d);

  return {
    type: 'video',
    hasPlaylistParam: parsed.hasPlaylistParam,
    listId: parsed.listId,
    info: {
      videoDetails: {
        id: d.id,
        title: d.title || 'Untitled Video',
        uploader: d.uploader || d.channel || 'Unknown Channel',
        channelUrl: d.channel_url || d.uploader_url || null,
        lengthSeconds: String(durationSec),
        viewCount: d.view_count || 0,
        uploadDate: d.upload_date || null,
        description: d.description || '',
        thumbnails: d.thumbnails || [{ url: d.thumbnail }],
        thumbnail: d.thumbnail,
      },
      formats,
      chapters,
      subtitles,
    },
  };
}

function parseTimestampToSeconds(val) {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val >= 0 ? Math.floor(val) : null;
  }
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    return Math.floor(parseFloat(str));
  }
  const parts = str.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function formatSecondsToTimestamp(sec, forceHours = false) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0 || forceHours) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function formatArgs(format) {
  const heights = {
    '360p': 360,
    '480p': 480,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '2160p': 2160,
  };

  if (format === 'mp3') {
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
  if (format === 'm4a') {
    return ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-x', '--audio-format', 'm4a', '--audio-quality', '0'];
  }
  if (format === 'flac') {
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'flac', '--audio-quality', '0'];
  }
  if (format === 'wav') {
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'wav', '--audio-quality', '0'];
  }

  if (heights[format]) {
    const h = heights[format];
    return [
      '-f',
      `bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '-S',
      'ext:mp4:m4a',
      '--merge-output-format',
      'mp4',
    ];
  }

  // "highest"
  return ['-f', 'bv*+ba/b', '-S', 'ext:mp4:m4a', '--merge-output-format', 'mp4'];
}

function buildDownloadArgs(options = {}) {
  const {
    url,
    format = '720p',
    clipStart,
    clipEnd,
    sponsorBlock = false,
    embedMetadata = false,
    embedThumbnail = false,
    splitChapters = false,
    embedSubs = false,
    subLang = 'en',
    outputTemplate,
    withProgress = true,
  } = options;

  const args = [
    '-4',
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
  ];

  if (withProgress) {
    args.push(
      '--newline',
      '--progress-template',
      'PROG:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_str)s|%(progress.status)s'
    );
  }

  if (outputTemplate) {
    args.push('-o', outputTemplate);
  }

  args.push(...formatArgs(format));

  const startSec = parseTimestampToSeconds(clipStart);
  const endSec = parseTimestampToSeconds(clipEnd);
  if (startSec !== null || endSec !== null) {
    const startStr = startSec !== null ? formatSecondsToTimestamp(startSec) : '00:00';
    const endStr = endSec !== null && endSec > (startSec || 0) ? formatSecondsToTimestamp(endSec) : 'inf';
    args.push('--download-sections', `*${startStr}-${endStr}`);
    args.push('--force-keyframes-at-cuts');
  }

  if (sponsorBlock) {
    args.push('--sponsorblock-remove', 'sponsor,intro,outro,selfpromo,interaction');
  }

  if (embedMetadata) {
    args.push('--add-metadata');
  }

  if (embedThumbnail && format !== 'wav') {
    args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  }

  if (splitChapters) {
    args.push('--split-chapters');
  }

  if (embedSubs && !['mp3', 'wav', 'flac', 'm4a'].includes(format)) {
    const safeLang = String(subLang || 'en').replace(/[^a-zA-Z0-9_-]/g, '') || 'en';
    args.push('--embed-subs', '--write-auto-subs', '--sub-langs', safeLang);
  }

  if (url) {
    args.push('--', url);
  }

  return args;
}

function parseVttTimeToSeconds(ts) {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return 0;
}

function formatSrtTimestamp(sec) {
  const totalMs = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function parseVttToCues(vttText) {
  if (!vttText || typeof vttText !== 'string') return [];
  const lines = vttText.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const [rawStart, rawEndWithSettings] = line.split('-->');
      const rawEnd = rawEndWithSettings.trim().split(/\s+/)[0];
      const startSeconds = parseVttTimeToSeconds(rawStart);
      const endSeconds = parseVttTimeToSeconds(rawEnd);
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const cleaned = lines[i]
          .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
          .replace(/<\/?c[^>]*>/g, '')
          .replace(/<\/?[a-zA-Z0-9]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
        if (cleaned) textLines.push(cleaned);
        i++;
      }
      const combined = textLines.join(' ').replace(/\s+/g, ' ').trim();
      if (combined && endSeconds - startSeconds >= 0.05) {
        const prev = cues[cues.length - 1];
        if (!prev || prev.text !== combined) {
          // Handle rolling YouTube auto-caption overlap where combined starts with prev.text
          let finalText = combined;
          if (prev && combined.startsWith(prev.text) && combined.length > prev.text.length) {
            finalText = combined.slice(prev.text.length).trim();
          }
          if (finalText && (!prev || prev.text !== finalText)) {
            cues.push({
              startSeconds,
              endSeconds,
              startFormatted: formatSecondsToTimestamp(startSeconds),
              endFormatted: formatSecondsToTimestamp(endSeconds),
              text: finalText,
            });
          }
        }
      }
    } else {
      i++;
    }
  }

  return cues;
}

function cuesToSrt(cues = []) {
  return cues
    .map((cue, idx) => {
      return `${idx + 1}\n${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(cue.endSeconds)}\n${cue.text}\n`;
    })
    .join('\n');
}

async function fetchTranscript(url, lang = 'en') {
  if (!isYouTubeUrl(url)) throw new Error('Invalid YouTube URL');
  const safeLang = String(lang || 'en').replace(/[^a-zA-Z0-9_-]/g, '') || 'en';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-subs-'));

  try {
    await runYtDlp([
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      safeLang,
      '--sub-format',
      'vtt',
      '-o',
      path.join(tmpDir, 'sub.%(ext)s'),
      '--',
      url,
    ]);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.vtt'));
    if (files.length === 0) {
      throw new Error(`No subtitles found for language "${safeLang}"`);
    }

    const vttRaw = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const cues = parseVttToCues(vttRaw);
    const plainText = cues.map((c) => c.text).join(' ');
    const srtText = cuesToSrt(cues);

    return {
      lang: safeLang,
      cues,
      plainText,
      srtText,
      vttText: vttRaw,
    };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = {
  normalizeYouTubeUrl,
  isYouTubeUrl,
  parseYouTubeUrlInfo,
  runYtDlp,
  summarizeFormats,
  fetchMediaInfo,
  parseTimestampToSeconds,
  formatSecondsToTimestamp,
  formatArgs,
  buildDownloadArgs,
  parseVttToCues,
  cuesToSrt,
  fetchTranscript,
};
