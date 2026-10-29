const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureBinaries, getBinaryStatus } = require('./lib/binaries');
const {
  isYouTubeUrl,
  normalizeYouTubeUrl,
  runYtDlp,
  fetchMediaInfo,
  fetchTranscript,
  buildDownloadArgs,
} = require('./lib/ytdlp');
const {
  createJob,
  getJob,
  getJobSnapshot,
  cancelJob,
  cleanupJob,
} = require('./lib/jobManager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Trigger binary check/bootstrap in background on startup
ensureBinaries().catch((err) => {
  console.error('[bootstrap] Initial binary check failed:', err.message);
});

app.get('/api/system', async (req, res) => {
  const current = getBinaryStatus();
  if (!current.ready && !current.bootstrapping) {
    ensureBinaries().catch(() => {});
  }
  res.json(getBinaryStatus());
});

app.get('/api/info', async (req, res) => {
  const url = normalizeYouTubeUrl(req.query.url);
  const { playlist = 'auto' } = req.query;
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const playlistMode =
    playlist === '1' || playlist === 'true'
      ? true
      : playlist === '0' || playlist === 'false'
      ? false
      : 'auto';

  try {
    const data = await fetchMediaInfo(url, { playlistMode });
    res.json(data);
  } catch (error) {
    console.error('[/api/info]', error.message);
    res.status(400).json({ error: error.message || 'Unable to fetch media information' });
  }
});

app.get('/api/transcript', async (req, res) => {
  const url = normalizeYouTubeUrl(req.query.url);
  const { lang = 'en', format } = req.query;
  if (!isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    const data = await fetchTranscript(url, lang);
    if (format === 'srt') {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="subtitles_${data.lang}.srt"`);
      return res.send(data.srtText);
    }
    if (format === 'vtt') {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="subtitles_${data.lang}.vtt"`);
      return res.send(data.vttText);
    }
    if (format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transcript_${data.lang}.txt"`);
      return res.send(data.plainText);
    }
    res.json(data);
  } catch (error) {
    console.error('[/api/transcript]', error.message);
    res.status(400).json({ error: error.message || 'Unable to extract transcript' });
  }
});

app.post('/api/jobs', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.url) body.url = normalizeYouTubeUrl(body.url);
    if (Array.isArray(body.urls)) body.urls = body.urls.map(normalizeYouTubeUrl);
    const job = createJob(body);
    res.status(201).json({ job });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to start download job' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job: getJobSnapshot(job) });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // Send immediate snapshot
  sendEvent('update', getJobSnapshot(job));
  if (job.status === 'completed') {
    sendEvent('complete', getJobSnapshot(job));
  } else if (job.status === 'error' || job.status === 'cancelled') {
    sendEvent('error', getJobSnapshot(job));
  }

  const onUpdate = (snap) => sendEvent('update', snap);
  const onComplete = (snap) => sendEvent('complete', snap);
  const onError = (snap) => sendEvent('error', snap);

  job.emitter.on('update', onUpdate);
  job.emitter.on('complete', onComplete);
  job.emitter.on('error', onError);

  req.on('close', () => {
    job.emitter.off('update', onUpdate);
    job.emitter.off('complete', onComplete);
    job.emitter.off('error', onError);
  });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== 'completed' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send('File not ready or already cleaned up');
  }

  res.download(job.filePath, job.fileName, (err) => {
    if (!err) {
      setTimeout(() => cleanupJob(job.id), 60 * 1000);
    }
  });
});

app.delete('/api/jobs/:id', (req, res) => {
  const ok = cancelJob(req.params.id);
  res.json({ ok });
});

// Backwards-compatible legacy endpoints
app.get('/info', async (req, res) => {
  const url = normalizeYouTubeUrl(req.query.url);
  if (!isYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const data = await fetchMediaInfo(url, { playlistMode: false });
    res.json(data);
  } catch (error) {
    console.error('[/info]', error.message);
    res.status(400).json({ error: 'Unable to fetch information' });
  }
});

app.get('/download', async (req, res) => {
  const url = normalizeYouTubeUrl(req.query.url);
  const { format } = req.query;
  if (!isYouTubeUrl(url)) return res.status(400).send('Invalid YouTube URL');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    await runYtDlp(
      buildDownloadArgs({
        url,
        format: format || '720p',
        outputTemplate: path.join(tmpDir, '%(title).120B.%(ext)s'),
        withProgress: false,
      })
    );

    const file = fs.readdirSync(tmpDir)[0];
    if (!file) throw new Error('No output file produced');

    res.on('close', cleanup);
    res.download(path.join(tmpDir, file), file);
  } catch (error) {
    console.error('[/download]', error.message);
    cleanup();
    if (!res.headersSent) res.status(400).send('Error downloading video');
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}

module.exports = app;
