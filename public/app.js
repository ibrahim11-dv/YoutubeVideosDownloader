(() => {
  const urlInput = document.getElementById('urlInput');
  const clearBtn = document.getElementById('clearBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const chosen = document.getElementById('chosen');
  const loader = document.getElementById('loader');
  const errorBanner = document.getElementById('errorBanner');

  // Top telemetry & theme controls
  const engineLed = document.getElementById('engineLed');
  const engineStatusText = document.getElementById('engineStatusText');
  const batchModeBtn = document.getElementById('batchModeBtn');
  const colorModeBtn = document.getElementById('colorModeBtn');
  const themeModeBtn = document.getElementById('themeModeBtn');

  // Batch & Playlist controls
  const batchContainer = document.getElementById('batchContainer');
  const batchInput = document.getElementById('batchInput');
  const batchCountLabel = document.getElementById('batchCountLabel');
  const batchQueueEachBtn = document.getElementById('batchQueueEachBtn');
  const batchZipBtn = document.getElementById('batchZipBtn');
  const playlistBanner = document.getElementById('playlistBanner');
  const playlistBannerText = document.getElementById('playlistBannerText');
  const loadPlaylistBtn = document.getElementById('loadPlaylistBtn');
  const loadSingleVideoBtn = document.getElementById('loadSingleVideoBtn');

  // Video Inspector & Trimmer
  const videoInfo = document.getElementById('videoInfo');
  const videoIdBadge = document.getElementById('videoIdBadge');
  const thumbnail = document.getElementById('thumbnail');
  const videoTitle = document.getElementById('videoTitle');
  const videoDuration = document.getElementById('videoDuration');
  const videoChannel = document.getElementById('videoChannel');
  const videoViews = document.getElementById('videoViews');
  const videoDate = document.getElementById('videoDate');

  const trimStartSlider = document.getElementById('trimStartSlider');
  const trimEndSlider = document.getElementById('trimEndSlider');
  const rangeFill = document.getElementById('rangeFill');
  const clipStartInput = document.getElementById('clipStartInput');
  const clipEndInput = document.getElementById('clipEndInput');
  const trimRangeLabel = document.getElementById('trimRangeLabel');
  const clipDurationBadge = document.getElementById('clipDurationBadge');
  const resetTrimBtn = document.getElementById('resetTrimBtn');

  // Chapters & Subtitles
  const chaptersWrap = document.getElementById('chaptersWrap');
  const chapterCountLabel = document.getElementById('chapterCountLabel');
  const chapterPills = document.getElementById('chapterPills');

  const subsDrawer = document.getElementById('subsDrawer');
  const subsStatusLabel = document.getElementById('subsStatusLabel');
  const subLangSelect = document.getElementById('subLangSelect');
  const loadTranscriptBtn = document.getElementById('loadTranscriptBtn');
  const dlSrtBtn = document.getElementById('dlSrtBtn');
  const dlVttBtn = document.getElementById('dlVttBtn');
  const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
  const transcriptBox = document.getElementById('transcriptBox');

  // Playlist Card
  const playlistCard = document.getElementById('playlistCard');
  const playlistCountBadge = document.getElementById('playlistCountBadge');
  const playlistTitle = document.getElementById('playlistTitle');
  const playlistUploader = document.getElementById('playlistUploader');
  const playlistList = document.getElementById('playlistList');
  const plSearchInput = document.getElementById('plSearchInput');
  const plNumberFiles = document.getElementById('plNumberFiles');
  const plSelectAllBtn = document.getElementById('plSelectAllBtn');
  const plSelect10Btn = document.getElementById('plSelect10Btn');
  const plSelectNoneBtn = document.getElementById('plSelectNoneBtn');
  const plSelectedCount = document.getElementById('plSelectedCount');
  const plQueueSeparateBtn = document.getElementById('plQueueSeparateBtn');
  const plQueueZipBtn = document.getElementById('plQueueZipBtn');

  // DSP Switches
  const optSponsorBlock = document.getElementById('optSponsorBlock');
  const optEmbedMeta = document.getElementById('optEmbedMeta');
  const optSplitChapters = document.getElementById('optSplitChapters');
  const optEmbedSubs = document.getElementById('optEmbedSubs');

  // Queue
  const queueEmpty = document.getElementById('queueEmpty');
  const queueList = document.getElementById('queueList');
  const queueActiveCount = document.getElementById('queueActiveCount');

  // State
  const API_BASE =
    window.location.protocol === 'file:' ||
    (window.location.hostname && window.location.port && window.location.port !== '3000')
      ? 'http://localhost:3000'
      : '';

  let debounceTimer = null;
  let requestId = 0;
  let currentDurationSec = 0;
  let currentVideoInfo = null;
  let currentPlaylist = null;
  let lastTranscriptText = '';
  const activeJobs = new Map();

  // Helpers
  function formatTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  function parseTimeInput(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return null;
    if (bytes >= 1024 * 1024 * 1024) {
      return `~${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `~${Math.round(bytes / 1024)} KB`;
  }

  function formatUploadDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return 'YOUTUBE';
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }

  function currentFormat() {
    const checked = document.querySelector('input[name="format"]:checked');
    return checked ? checked.value : '720p';
  }

  function showError(msg) {
    if (!msg) {
      errorBanner.classList.remove('on');
      errorBanner.textContent = '';
      return;
    }
    errorBanner.textContent = `ERR // ${msg}`;
    errorBanner.classList.add('on');
  }

  // Poll Engine Status
  async function checkSystemStatus() {
    try {
      const r = await fetch(`${API_BASE}/api/system`);
      const data = await r.json();
      if (data.ready) {
        engineLed.className = 'led online';
        const ffTag = data.ffmpegReady ? '+ FFMPEG' : '(NO FFMPEG)';
        engineStatusText.textContent = `ENGINE ONLINE · YT-DLP ${data.ytdlpVersion || ''} ${ffTag}`;
      } else if (data.bootstrapping) {
        engineLed.className = 'led';
        engineStatusText.textContent = 'BOOTSTRAPPING YT-DLP + FFMPEG BINARIES...';
        setTimeout(checkSystemStatus, 1800);
      } else if (data.error) {
        engineLed.className = 'led error';
        engineStatusText.textContent = `ENGINE ERROR: ${data.error}`;
      } else {
        setTimeout(checkSystemStatus, 1800);
      }
    } catch {
      engineLed.className = 'led error';
      engineStatusText.textContent = 'BACKEND OFFLINE (RUN npm start ON PORT 3000)';
      setTimeout(checkSystemStatus, 3000);
    }
  }
  checkSystemStatus();

  // Aesthetic & Mode Toggles
  colorModeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isSignal = html.getAttribute('data-color') === 'signal';
    html.setAttribute('data-color', isSignal ? 'bw' : 'signal');
    colorModeBtn.textContent = isSignal ? 'THUMB: B&W RAW' : 'THUMB: COLOR SIGNAL';
    colorModeBtn.classList.toggle('active', !isSignal);
  });

  themeModeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isPaper = html.getAttribute('data-theme') === 'paper';
    html.setAttribute('data-theme', isPaper ? 'dark' : 'paper');
    themeModeBtn.textContent = isPaper ? 'THEME: DARK' : 'THEME: PAPER';
    themeModeBtn.classList.toggle('active', !isPaper);
  });

  batchModeBtn.addEventListener('click', () => {
    const isOn = batchContainer.classList.toggle('on');
    batchModeBtn.textContent = isOn ? 'BATCH MODE: ON' : 'BATCH MODE: OFF';
    batchModeBtn.classList.toggle('active', isOn);
    if (isOn) batchInput.focus();
  });

  // Format Tabs & Selection
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.format').forEach((el) => {
        if (tab === 'all' || el.dataset.cat === tab) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });
    });
  });

  document.querySelectorAll('input[name="format"]').forEach((r) => {
    r.addEventListener('change', () => {
      const val = currentFormat();
      chosen.textContent = val === 'highest' ? 'BEST' : val.toUpperCase();
    });
  });

  // Global Paste Shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      navigator.clipboard?.readText().then((txt) => {
        if (txt && (txt.includes('youtube.com') || txt.includes('youtu.be'))) {
          urlInput.value = txt.trim();
          urlInput.dispatchEvent(new Event('input'));
        }
      }).catch(() => {});
    }
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) {
        urlInput.value = txt.trim();
        urlInput.dispatchEvent(new Event('input'));
      }
    } catch {
      urlInput.focus();
    }
  });

  // URL Input Listener
  urlInput.addEventListener('input', function () {
    clearBtn.style.display = this.value ? 'block' : 'none';
    showError(null);

    const url = this.value.trim();
    clearTimeout(debounceTimer);

    if (!url) {
      hideInspector();
      return;
    }

    debounceTimer = setTimeout(() => {
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        fetchInfo(url, 'auto');
      } else {
        hideInspector();
      }
    }, 380);
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    showError(null);
    hideInspector();
    urlInput.focus();
  });

  loadPlaylistBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) fetchInfo(url, '1');
  });

  loadSingleVideoBtn?.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (url) fetchInfo(url, '0');
  });

  // Fetch Video or Playlist Info
  async function fetchInfo(url, playlistMode = 'auto', attempt = 1) {
    const id = ++requestId;
    loader.classList.add('on');
    showError(null);

    try {
      const r = await fetch(
        `${API_BASE}/api/info?url=${encodeURIComponent(url)}&playlist=${encodeURIComponent(playlistMode)}`
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to inspect URL');
      if (id !== requestId) return;
      loader.classList.remove('on');

      if (data.type === 'playlist' && data.playlistDetails) {
        if (data.hasVideoParam) {
          playlistBanner.classList.add('on');
          if (playlistBannerText) playlistBannerText.textContent = `PLAYLIST LOADED (${data.playlistDetails.entryCount} TRACKS)`;
          loadPlaylistBtn.classList.add('active');
          loadSingleVideoBtn?.classList.remove('active');
        } else {
          playlistBanner.classList.remove('on');
        }
        showPlaylist(data.playlistDetails);
      } else if (data.info) {
        if (data.hasPlaylistParam) {
          playlistBanner.classList.add('on');
          if (playlistBannerText) playlistBannerText.textContent = 'SINGLE VIDEO LOADED FROM PLAYLIST LINK';
          loadPlaylistBtn.classList.remove('active');
          loadSingleVideoBtn?.classList.add('active');
        } else {
          playlistBanner.classList.remove('on');
        }
        showVideo(data.info);
      }
    } catch (err) {
      if (id !== requestId) return;
      if (attempt < 2 && err.message && err.message.toLowerCase().includes('fetch')) {
        // Retry once if server was restarting
        requestId--;
        setTimeout(() => fetchInfo(url, playlistMode, attempt + 1), 800);
        return;
      }
      loader.classList.remove('on');
      hideInspector();
      showError(
        err.message === 'Failed to fetch'
          ? 'Cannot reach backend server on http://localhost:3000 — ensure server is running'
          : err.message
      );
    }
  }

  function getClipRatio() {
    if (!currentDurationSec || currentDurationSec <= 0) return 1;
    const s = Number(trimStartSlider.value) || 0;
    const e = Number(trimEndSlider.value) || currentDurationSec;
    const span = Math.max(1, e - s);
    return Math.min(1, span / currentDurationSec);
  }

  function renderFormatTelemetry(formats = []) {
    const ratio = getClipRatio();
    for (const fmt of formats) {
      const container = document.getElementById(`meta-${fmt.id}`);
      const labelEl = document.querySelector(`.format[data-fmt="${fmt.id}"]`);
      if (!container || !labelEl) continue;

      labelEl.classList.toggle('unavailable', !fmt.available);
      if (fmt.id === 'highest') {
        const tagEl = document.getElementById('tag-highest');
        if (tagEl && fmt.tag) tagEl.textContent = fmt.tag;
      }

      if (!fmt.available) {
        container.innerHTML = `<span class="badge">UNAVAILABLE</span>`;
        continue;
      }

      const badges = [];
      if (fmt.codec) badges.push(`<span class="badge">${fmt.codec}</span>`);
      if (fmt.fps && fmt.fps > 30) badges.push(`<span class="badge">${fmt.fps}FPS</span>`);
      if (fmt.hdr) badges.push(`<span class="badge">HDR</span>`);
      if (fmt.sizeBytes) {
        const scaled = Math.round(fmt.sizeBytes * ratio);
        const sizeStr = formatBytes(scaled);
        if (sizeStr) badges.push(`<span class="badge size">${sizeStr}</span>`);
      }
      container.innerHTML = badges.join('');
    }
  }

  function updateTrimmerUI(source) {
    if (!currentDurationSec) return;
    let startVal = Number(trimStartSlider.value);
    let endVal = Number(trimEndSlider.value);

    if (source === 'start' && startVal >= endVal) {
      startVal = Math.max(0, endVal - 1);
      trimStartSlider.value = startVal;
    } else if (source === 'end' && endVal <= startVal) {
      endVal = Math.min(currentDurationSec, startVal + 1);
      trimEndSlider.value = endVal;
    }

    const leftPct = (startVal / currentDurationSec) * 100;
    const rightPct = (endVal / currentDurationSec) * 100;
    rangeFill.style.left = `${leftPct}%`;
    rangeFill.style.width = `${Math.max(0, rightPct - leftPct)}%`;

    clipStartInput.value = formatTime(startVal);
    clipEndInput.value = formatTime(endVal);

    const clipDur = Math.max(0, endVal - startVal);
    const isFull = startVal === 0 && endVal >= currentDurationSec;
    trimRangeLabel.textContent = isFull
      ? 'FULL LENGTH (NO CUT)'
      : `${formatTime(startVal)} → ${formatTime(endVal)}`;
    clipDurationBadge.textContent = isFull
      ? `FULL (${formatTime(currentDurationSec)})`
      : `CLIP: ${formatTime(clipDur)}`;

    if (currentVideoInfo?.formats) {
      renderFormatTelemetry(currentVideoInfo.formats);
    }
  }

  trimStartSlider.addEventListener('input', () => updateTrimmerUI('start'));
  trimEndSlider.addEventListener('input', () => updateTrimmerUI('end'));

  clipStartInput.addEventListener('change', () => {
    const sec = parseTimeInput(clipStartInput.value);
    if (sec !== null && currentDurationSec > 0) {
      trimStartSlider.value = Math.min(Math.max(0, sec), Number(trimEndSlider.value) - 1);
      updateTrimmerUI('start');
    }
  });

  clipEndInput.addEventListener('change', () => {
    const sec = parseTimeInput(clipEndInput.value);
    if (sec !== null && currentDurationSec > 0) {
      trimEndSlider.value = Math.max(Math.min(currentDurationSec, sec), Number(trimStartSlider.value) + 1);
      updateTrimmerUI('end');
    }
  });

  resetTrimBtn.addEventListener('click', () => {
    if (!currentDurationSec) return;
    trimStartSlider.value = 0;
    trimEndSlider.value = currentDurationSec;
    document.querySelectorAll('.chapter-pill').forEach((p) => p.classList.remove('active'));
    updateTrimmerUI();
  });

  function showVideo(info) {
    currentVideoInfo = info;
    currentPlaylist = null;
    playlistCard.classList.remove('on');
    const mainBtnLabel = downloadBtn.querySelector('span:first-child');
    if (mainBtnLabel) mainBtnLabel.textContent = 'EXTRACT MASTER';

    const d = info.videoDetails;
    currentDurationSec = parseInt(d.lengthSeconds, 10) || 0;

    videoIdBadge.textContent = `ID: ${d.id || ' YT'}`;
    videoTitle.textContent = d.title;
    videoDuration.textContent = formatTime(currentDurationSec);
    videoChannel.textContent = d.uploader || 'YouTube';
    videoViews.textContent = `${Number(d.viewCount || 0).toLocaleString()} VIEWS`;
    videoDate.textContent = formatUploadDate(d.uploadDate);
    thumbnail.src =
      (Array.isArray(d.thumbnails) && d.thumbnails[d.thumbnails.length - 1]?.url) ||
      d.thumbnail ||
      '';

    // Initialize Trimmer
    trimStartSlider.max = currentDurationSec || 100;
    trimEndSlider.max = currentDurationSec || 100;
    trimStartSlider.value = 0;
    trimEndSlider.value = currentDurationSec || 100;
    updateTrimmerUI();

    // Formats
    if (Array.isArray(info.formats)) {
      renderFormatTelemetry(info.formats);
    }

    // Chapters
    if (Array.isArray(info.chapters) && info.chapters.length > 0) {
      chaptersWrap.classList.add('on');
      chapterCountLabel.textContent = `${info.chapters.length} CHAPTERS`;
      chapterPills.innerHTML = '';
      info.chapters.forEach((ch) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chapter-pill';
        btn.textContent = `${String(ch.index).padStart(2, '0')} · ${ch.title} (${formatTime(ch.startTime)})`;
        btn.addEventListener('click', () => {
          document.querySelectorAll('.chapter-pill').forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          trimStartSlider.value = ch.startTime;
          trimEndSlider.value = ch.endTime;
          updateTrimmerUI();
        });
        chapterPills.appendChild(btn);
      });
    } else {
      chaptersWrap.classList.remove('on');
    }

    // Subtitles Drawer
    subsDrawer.classList.add('on');
    transcriptBox.classList.remove('on');
    transcriptBox.innerHTML = '';
    lastTranscriptText = '';
    subLangSelect.innerHTML = '';

    const subs = Array.isArray(info.subtitles) && info.subtitles.length > 0
      ? info.subtitles
      : [{ lang: 'en', name: 'English (Auto/Fallback)', isAuto: true }];

    subs.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.lang;
      opt.textContent = `${s.name} [${s.lang}]`;
      subLangSelect.appendChild(opt);
    });
    subsStatusLabel.textContent = `${subs.length} TRACK(S) AVAILABLE`;

    videoInfo.classList.add('on');
  }

  function showPlaylist(pl) {
    currentPlaylist = pl;
    currentVideoInfo = null;
    videoInfo.classList.remove('on');

    const totalDurStr = pl.totalDurationSec ? ` · ${formatTime(pl.totalDurationSec)}` : '';
    playlistCountBadge.textContent = `${pl.entryCount} TRACKS${totalDurStr}`;
    playlistTitle.textContent = pl.title;
    playlistUploader.textContent = `CHANNEL // ${pl.uploader}`;
    playlistList.innerHTML = '';
    if (plSearchInput) plSearchInput.value = '';

    pl.entries.forEach((item) => {
      const row = document.createElement('label');
      row.className = 'playlist-item';
      row.dataset.search = `${item.title} ${item.uploader || ''}`.toLowerCase();
      row.innerHTML = `
        <input type="checkbox" class="pl-check" value="${item.url}" data-title="${item.title.replace(/"/g, '&quot;')}" checked>
        <img src="${item.thumbnail}" alt="">
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          <b>${String(item.index).padStart(2, '0')}.</b> ${item.title}
        </div>
        <span class="pl-dur">${formatTime(item.duration)}</span>
        <button type="button" class="mini-btn pl-single-dl" title="Download this track now">↓</button>
      `;
      row.querySelector('.pl-check').addEventListener('change', updatePlaylistSelectedCount);
      row.querySelector('.pl-single-dl').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        enqueueJob({ url: item.url, title: item.title });
      });
      playlistList.appendChild(row);
    });

    updatePlaylistSelectedCount();
    playlistCard.classList.add('on');
  }

  function updatePlaylistSelectedCount() {
    const checked = playlistList.querySelectorAll('.pl-check:checked');
    plSelectedCount.textContent = `${checked.length} OF ${currentPlaylist?.entryCount || 0} SELECTED`;
    const mainBtnLabel = downloadBtn.querySelector('span:first-child');
    if (mainBtnLabel) {
      mainBtnLabel.textContent = currentPlaylist
        ? `DOWNLOAD PLAYLIST (${checked.length})`
        : 'EXTRACT MASTER';
    }
  }

  plSearchInput?.addEventListener('input', () => {
    const q = plSearchInput.value.trim().toLowerCase();
    playlistList.querySelectorAll('.playlist-item').forEach((row) => {
      const match = !q || (row.dataset.search || '').includes(q);
      row.classList.toggle('hidden-track', !match);
    });
  });

  plSelectAllBtn.addEventListener('click', () => {
    playlistList.querySelectorAll('.playlist-item:not(.hidden-track) .pl-check').forEach((c) => (c.checked = true));
    updatePlaylistSelectedCount();
  });

  plSelect10Btn?.addEventListener('click', () => {
    const visible = Array.from(playlistList.querySelectorAll('.playlist-item:not(.hidden-track) .pl-check'));
    visible.forEach((c, idx) => (c.checked = idx < 10));
    updatePlaylistSelectedCount();
  });

  plSelectNoneBtn.addEventListener('click', () => {
    playlistList.querySelectorAll('.pl-check').forEach((c) => (c.checked = false));
    updatePlaylistSelectedCount();
  });

  function hideInspector() {
    videoInfo.classList.remove('on');
    playlistCard.classList.remove('on');
    playlistBanner.classList.remove('on');
    currentVideoInfo = null;
    currentPlaylist = null;
    const mainBtnLabel = downloadBtn.querySelector('span:first-child');
    if (mainBtnLabel) mainBtnLabel.textContent = 'EXTRACT MASTER';
  }

  // Subtitles & Transcript Actions
  loadTranscriptBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const lang = subLangSelect.value || 'en';
    subsStatusLabel.textContent = 'EXTRACTING TRANSCRIPT...';
    loadTranscriptBtn.disabled = true;

    try {
      const r = await fetch(`${API_BASE}/api/transcript?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load transcript');

      lastTranscriptText = data.plainText || '';
      transcriptBox.innerHTML = '';
      data.cues.forEach((cue) => {
        const line = document.createElement('div');
        line.className = 'cue-line';
        line.title = 'Click to set trimmer IN point to this timestamp';
        line.innerHTML = `<span class="cue-ts">${cue.startFormatted}</span><span>${cue.text}</span>`;
        line.addEventListener('click', () => {
          if (currentDurationSec > 0) {
            trimStartSlider.value = Math.floor(cue.startSeconds);
            updateTrimmerUI('start');
          }
        });
        transcriptBox.appendChild(line);
      });
      transcriptBox.classList.add('on');
      subsStatusLabel.textContent = `${data.cues.length} CUES LOADED (CLICK LINE TO SET CUT TIME)`;
    } catch (err) {
      subsStatusLabel.textContent = `ERR: ${err.message}`;
    } finally {
      loadTranscriptBtn.disabled = false;
    }
  });

  dlSrtBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const lang = subLangSelect.value || 'en';
    window.location.href = `${API_BASE}/api/transcript?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}&format=srt`;
  });

  dlVttBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const lang = subLangSelect.value || 'en';
    window.location.href = `${API_BASE}/api/transcript?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}&format=vtt`;
  });

  copyTranscriptBtn.addEventListener('click', async () => {
    if (!lastTranscriptText) {
      await loadTranscriptBtn.click();
    }
    if (lastTranscriptText) {
      await navigator.clipboard.writeText(lastTranscriptText);
      const prev = copyTranscriptBtn.textContent;
      copyTranscriptBtn.textContent = 'COPIED!';
      setTimeout(() => (copyTranscriptBtn.textContent = prev), 1500);
    }
  });

  // Batch Paste Actions
  function getBatchUrls() {
    return (batchInput.value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.includes('youtube.com') || s.includes('youtu.be'));
  }

  batchInput.addEventListener('input', () => {
    const urls = getBatchUrls();
    batchCountLabel.textContent = `${urls.length} VALID LINK(S) DETECTED`;
  });

  batchQueueEachBtn.addEventListener('click', () => {
    const urls = getBatchUrls();
    if (!urls.length) return showError('Paste at least one valid YouTube URL in Batch Mode');
    urls.forEach((u, i) => enqueueJob({ url: u, title: `Batch Item #${i + 1}` }));
  });

  batchZipBtn.addEventListener('click', () => {
    const urls = getBatchUrls();
    if (!urls.length) return showError('Paste at least one valid YouTube URL in Batch Mode');
    enqueueJob({ urls, title: `Batch Archive (${urls.length} files)` });
  });

  // Playlist Queue Actions
  plQueueSeparateBtn.addEventListener('click', () => {
    const checked = Array.from(playlistList.querySelectorAll('.pl-check:checked'));
    if (!checked.length) return showError('Select at least one track from the playlist');
    checked.forEach((el) => {
      enqueueJob({ url: el.value, title: el.dataset.title || 'Playlist Track' });
    });
  });

  plQueueZipBtn.addEventListener('click', () => {
    const checked = Array.from(playlistList.querySelectorAll('.pl-check:checked'));
    if (!checked.length) return showError('Select at least one track from the playlist');
    const urls = checked.map((el) => el.value);
    enqueueJob({
      urls,
      title: `${currentPlaylist?.title || 'Playlist'} (${urls.length} tracks)`,
      numberFiles: plNumberFiles ? plNumberFiles.checked : true,
    });
  });

  // Master Trigger Button
  downloadBtn.addEventListener('click', () => {
    if (currentPlaylist) {
      plQueueZipBtn.click();
      return;
    }

    const url = urlInput.value.trim();
    if (!url) {
      urlInput.focus();
      return;
    }

    const isTrimmed =
      currentDurationSec > 0 &&
      (Number(trimStartSlider.value) > 0 || Number(trimEndSlider.value) < currentDurationSec);

    enqueueJob({
      url,
      title: currentVideoInfo?.videoDetails?.title || 'YouTube Media',
      clipStart: isTrimmed ? Number(trimStartSlider.value) : null,
      clipEnd: isTrimmed ? Number(trimEndSlider.value) : null,
    });
  });

  // Enqueue Job & Connect Live SSE Telemetry
  async function enqueueJob(customOpts = {}) {
    showError(null);
    const payload = {
      url: customOpts.url,
      urls: customOpts.urls,
      title: customOpts.title || 'YouTube Media',
      format: currentFormat(),
      clipStart: customOpts.clipStart ?? null,
      clipEnd: customOpts.clipEnd ?? null,
      sponsorBlock: optSponsorBlock.checked,
      embedMetadata: optEmbedMeta.checked,
      embedThumbnail: optEmbedMeta.checked,
      splitChapters: optSplitChapters.checked,
      embedSubs: optEmbedSubs.checked,
      subLang: subLangSelect.value || 'en',
      numberFiles: customOpts.numberFiles !== false,
    };

    try {
      const r = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Unable to start download job');

      createJobTelemetryCard(data.job);
    } catch (err) {
      showError(err.message);
    }
  }

  function updateQueueHeaderCount() {
    let running = 0;
    for (const j of activeJobs.values()) {
      if (j.status === 'running') running++;
    }
    queueActiveCount.textContent = `${running} ACTIVE JOB${running === 1 ? '' : 'S'}`;
    queueEmpty.style.display = activeJobs.size === 0 ? 'block' : 'none';
  }

  function createJobTelemetryCard(job) {
    activeJobs.set(job.id, job);
    updateQueueHeaderCount();

    const card = document.createElement('div');
    card.className = 'job-card';
    card.id = `job-${job.id}`;
    card.innerHTML = `
      <div class="job-top">
        <div class="job-title">
          <span class="job-fmt-pill">${job.format.toUpperCase()}</span>
          <span class="job-name"></span>
        </div>
        <div class="job-actions">
          <a class="mini-btn active job-save-btn" style="display:none; text-decoration:none;" href="${API_BASE}/api/jobs/${job.id}/file">SAVE FILE</a>
          <button type="button" class="mini-btn job-cancel-btn">ABORT</button>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-bar" style="width:0%"></div>
      </div>
      <div class="job-metrics">
        <span>STAGE: <b class="m-stage">${job.stage}</b></span>
        <span>PROGRESS: <b class="m-pct">0.0%</b></span>
        <span>SPEED: <b class="m-speed">---</b></span>
        <span>ETA: <b class="m-eta">---</b></span>
      </div>
    `;

    card.querySelector('.job-name').textContent = job.title;
    const cancelBtn = card.querySelector('.job-cancel-btn');
    const saveBtn = card.querySelector('.job-save-btn');
    const barEl = card.querySelector('.progress-bar');
    const stageEl = card.querySelector('.m-stage');
    const pctEl = card.querySelector('.m-pct');
    const speedEl = card.querySelector('.m-speed');
    const etaEl = card.querySelector('.m-eta');

    queueList.prepend(card);

    const es = new EventSource(`${API_BASE}/api/jobs/${job.id}/events`);
    let downloadTriggered = false;

    const renderSnap = (snap) => {
      activeJobs.set(snap.id, snap);
      updateQueueHeaderCount();

      const pct = Number(snap.percent) || 0;
      barEl.style.width = `${pct}%`;
      stageEl.textContent = snap.error ? `ERR: ${snap.error}` : snap.stage || snap.status.toUpperCase();
      pctEl.textContent = `${pct.toFixed(1)}%`;
      speedEl.textContent = snap.speed || (snap.status === 'completed' ? 'DONE' : '---');
      etaEl.textContent = snap.eta || '---';

      if (snap.status === 'completed') {
        card.classList.add('completed');
        saveBtn.style.display = 'inline-block';
        cancelBtn.textContent = 'DISMISS';
        es.close();
        if (!downloadTriggered) {
          downloadTriggered = true;
          const iframe = document.createElement('iframe');
          iframe.style.display = 'none';
          iframe.src = `${API_BASE}/api/jobs/${snap.id}/file`;
          document.body.appendChild(iframe);
          setTimeout(() => iframe.remove(), 60000);
        }
      } else if (snap.status === 'error' || snap.status === 'cancelled') {
        card.classList.add('error');
        cancelBtn.textContent = 'DISMISS';
        es.close();
      }
    };

    es.addEventListener('update', (e) => renderSnap(JSON.parse(e.data)));
    es.addEventListener('complete', (e) => renderSnap(JSON.parse(e.data)));
    es.addEventListener('error', (e) => {
      if (e.data) renderSnap(JSON.parse(e.data));
      es.close();
    });

    cancelBtn.addEventListener('click', async () => {
      es.close();
      await fetch(`${API_BASE}/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
      activeJobs.delete(job.id);
      card.remove();
      updateQueueHeaderCount();
    });
  }
})();
