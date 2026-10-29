const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', '.bin');
const IS_WIN = process.platform === 'win32';
const LOCAL_YTDLP = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

let cachedStatus = {
  ready: false,
  bootstrapping: false,
  ytdlpPath: null,
  ytdlpVersion: null,
  ffmpegPath: null,
  ffmpegReady: false,
  error: null,
};

let bootstrapPromise = null;

function execVersion(bin, args = ['--version']) {
  return new Promise((resolve) => {
    try {
      const proc = spawn(bin, args, { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString()));
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code === 0 && out.trim()) {
          resolve(out.trim().split(/\r?\n/)[0]);
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

async function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    const ver = await execVersion(process.env.FFMPEG_PATH, ['-version']);
    if (ver) return process.env.FFMPEG_PATH;
  }

  const sysVer = await execVersion('ffmpeg', ['-version']);
  if (sysVer) return 'ffmpeg';

  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
    // If postinstall was skipped, trigger ffmpeg-static's installer
    const installScript = path.join(
      path.dirname(require.resolve('ffmpeg-static/package.json')),
      'install.js'
    );
    if (fs.existsSync(installScript)) {
      await new Promise((resolve) => {
        const p = spawn(process.execPath, [installScript], { windowsHide: true });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
      if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        return ffmpegStatic;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getYtDlpDownloadUrl() {
  if (process.platform === 'win32') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  }
  if (process.platform === 'darwin') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  }
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
}

async function downloadYtDlp(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const url = getYtDlpDownloadUrl();
  console.log(`[bootstrap] Downloading standalone yt-dlp from ${url} ...`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
  if (!IS_WIN) {
    fs.chmodSync(tmpPath, 0o755);
  }
  fs.renameSync(tmpPath, targetPath);
  console.log(`[bootstrap] Saved yt-dlp binary to ${targetPath}`);
}

async function resolveYtDlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    LOCAL_YTDLP,
    'yt-dlp',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const ver = await execVersion(candidate, ['--version']);
    if (ver) {
      return { path: candidate, version: ver };
    }
  }

  // Bootstrap into .bin/
  await downloadYtDlp(LOCAL_YTDLP);
  const ver = await execVersion(LOCAL_YTDLP, ['--version']);
  if (!ver) {
    throw new Error('Downloaded yt-dlp binary could not be executed');
  }
  return { path: LOCAL_YTDLP, version: ver };
}

async function ensureBinaries() {
  if (cachedStatus.ready && cachedStatus.ytdlpPath) {
    return cachedStatus;
  }
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  cachedStatus.bootstrapping = true;
  cachedStatus.error = null;

  bootstrapPromise = (async () => {
    try {
      const [ytdlp, ffmpegPath] = await Promise.all([
        resolveYtDlp(),
        resolveFfmpeg(),
      ]);

      cachedStatus = {
        ready: true,
        bootstrapping: false,
        ytdlpPath: ytdlp.path,
        ytdlpVersion: ytdlp.version,
        ffmpegPath: ffmpegPath,
        ffmpegReady: Boolean(ffmpegPath),
        error: null,
      };
      return cachedStatus;
    } catch (err) {
      cachedStatus = {
        ...cachedStatus,
        ready: false,
        bootstrapping: false,
        error: err.message,
      };
      throw err;
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

function getBinaryStatus() {
  return { ...cachedStatus };
}

module.exports = {
  ensureBinaries,
  getBinaryStatus,
  LOCAL_YTDLP,
};
