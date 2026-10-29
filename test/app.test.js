const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isYouTubeUrl,
  parseYouTubeUrlInfo,
  summarizeFormats,
  parseTimestampToSeconds,
  formatSecondsToTimestamp,
  buildDownloadArgs,
  parseVttToCues,
  cuesToSrt,
} = require('../lib/ytdlp');
const { parseProgressLine } = require('../lib/jobManager');
const { ensureBinaries } = require('../lib/binaries');

test('URL validation & playlist detection', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  assert.equal(isYouTubeUrl('https://www.youtube.com/shorts/abc123xyz'), true);
  assert.equal(isYouTubeUrl('https://evil.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(isYouTubeUrl('javascript:alert(1)'), false);

  const watchWithList = parseYouTubeUrlInfo(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345'
  );
  assert.equal(watchWithList.valid, true);
  assert.equal(watchWithList.videoId, 'dQw4w9WgXcQ');
  assert.equal(watchWithList.listId, 'PL12345');
  assert.equal(watchWithList.hasPlaylistParam, true);
  assert.equal(watchWithList.isPurePlaylist, false);

  const purePl = parseYouTubeUrlInfo('https://www.youtube.com/playlist?list=PL12345');
  assert.equal(purePl.isPurePlaylist, true);
});

test('Timestamp parsing and formatting', () => {
  assert.equal(parseTimestampToSeconds('01:30'), 90);
  assert.equal(parseTimestampToSeconds('1:02:03'), 3723);
  assert.equal(parseTimestampToSeconds(45), 45);
  assert.equal(formatSecondsToTimestamp(90), '01:30');
  assert.equal(formatSecondsToTimestamp(3723), '01:02:03');
});

test('Smart format summarization', () => {
  const sampleRawFormats = [
    { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', filesize: 3_000_000, abr: 128 },
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 60, filesize: 45_000_000 },
    { format_id: '136', ext: 'mp4', vcodec: 'vp9', acodec: 'none', height: 720, fps: 30, filesize: 20_000_000 },
  ];

  const formats = summarizeFormats(sampleRawFormats, 180);
  const f1080 = formats.find((f) => f.id === '1080p');
  const f2160 = formats.find((f) => f.id === '2160p');
  const fMp3 = formats.find((f) => f.id === 'mp3');

  assert.equal(f1080.available, true);
  assert.equal(f1080.codec, 'H.264');
  assert.equal(f1080.fps, 60);
  assert.equal(f1080.sizeBytes, 48_000_000);
  assert.equal(f2160.available, false);
  assert.equal(fMp3.available, true);
});

test('buildDownloadArgs constructs clip, SponsorBlock, metadata, and chapter flags', () => {
  const args = buildDownloadArgs({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    format: '1080p',
    clipStart: 15,
    clipEnd: 75,
    sponsorBlock: true,
    embedMetadata: true,
    embedThumbnail: true,
    splitChapters: true,
    embedSubs: true,
    subLang: 'en',
  });

  assert.ok(args.includes('--download-sections'));
  assert.ok(args.includes('*00:15-01:15'));
  assert.ok(args.includes('--force-keyframes-at-cuts'));
  assert.ok(args.includes('--sponsorblock-remove'));
  assert.ok(args.includes('--add-metadata'));
  assert.ok(args.includes('--embed-thumbnail'));
  assert.ok(args.includes('--split-chapters'));
  assert.ok(args.includes('--embed-subs'));
});

test('VTT parser cleans inline tags, deduplicates rolling captions, and outputs SRT', () => {
  const sampleVtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.500 align:start position:0%
Hello <00:00:01.500><c>world</c> from YouTube

00:00:03.500 --> 00:00:06.000 align:start position:0%
Hello world from YouTube
this is line two
`;

  const cues = parseVttToCues(sampleVtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world from YouTube');
  assert.equal(cues[1].text, 'this is line two');

  const srt = cuesToSrt(cues);
  assert.ok(srt.includes('00:00:01,000 --> 00:00:03,500'));
  assert.ok(srt.includes('this is line two'));
});

test('Progress parser extracts percentage, speed, and ETA', () => {
  const parsed = parseProgressLine('PROG: 42.5%| 12.40MiB/s| 00:08| 54.20MiB|downloading');
  assert.equal(parsed.percent, 42.5);
  assert.equal(parsed.speed, '12.40MiB/s');
  assert.equal(parsed.eta, '00:08');
  assert.equal(parsed.totalSize, '54.20MiB');
});

test('Binary bootstrapper resolves yt-dlp and ffmpeg', async () => {
  const status = await ensureBinaries();
  assert.equal(status.ready, true);
  assert.ok(status.ytdlpPath);
  assert.ok(status.ytdlpVersion);
  assert.equal(status.ffmpegReady, true);
});
