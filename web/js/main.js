// ============================================================
// アプリ本体 (Web 版)
//
// 使い方の流れ:
//   1. 検索バーに YouTube リンク / 曲名 を入れるか、MP3 を読ませる
//   2. 曲が決まると SimpMusic から歌詞を引いて Apple Music 風に流す
//   3. お気に入り (ハート) はワンタップで再再生
//
// 画面は拡張の PIP (document Picture-in-Picture) と同じ構成:
//   ヘッダー(アートワーク+曲名+歌手+ハート) / 歌詞 / 操作ボタン
//   スマホではそれがそのまま全画面になる。
//
// バックグラウンド再生:
//   - MP3 は <audio> なのでタブを離れても鳴り続ける (iOS も含む)
//   - YouTube は IFrame API。デスクトップ Chrome ではページを離れる
//     ときに Document PiP (拡張の PIP と同じ小窓) を出して鳴らし続ける。
//     iPhone の Safari/Chrome は YouTube のバックグラウンド再生を
//     システムが止めるため、そこは PiP(動画小窓)が使えない環境。
// ============================================================

import {
  fetchLyricsByVideoId,
  searchSimpMusic,
  resolveVideoIdForTrack,
  extractYouTubeId,
  parseTrackFilename,
  stripLeadingHeaderLines,
} from './simpmusic.js';
import {
  createPlayer,
  updateMediaSession,
  setMediaSessionPlaybackState,
} from './player.js';
import {
  createLyricsView,
  renderLyricsInto,
} from './lyrics-engine.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

// ── 要素 ─────────────────────────────────────────────────────
const ui = {
  searchInput: $('search-input'),
  searchBtn: $('search-btn'),
  fileInput: $('file-input'),
  results: $('results'),
  favoritesList: $('panel-favorites'),
  recentList: $('panel-recent'),
  playerScreen: $('player-screen'),
  homeScreen: $('home-screen'),
  artwork: $('player-artwork'),
  title: $('player-title'),
  artist: $('player-artist'),
  likeBtn: $('player-like-btn'),
  likePath: $('player-like-icon-path'),
  lyricsContainer: $('lyrics-container'),
  prevBtn: $('player-prev'),
  playBtn: $('player-play'),
  playIcon: $('player-play-icon'),
  pauseIcon: $('player-pause-icon'),
  nextBtn: $('player-next'),
  closeBtn: $('player-close'),
  bgLayer: $('player-bg-layer'),
  currentTime: $('time-current'),
  duration: $('time-duration'),
  seekBar: $('seek-bar'),
  videoHost: $('yt-host'),
  audioHost: $('audio-host'),
  tabSearch: $('tab-search'),
  tabFav: $('tab-favorites'),
  tabRecent: $('tab-recent'),
  panelSearch: $('panel-search'),
  panelFav: $('panel-favorites'),
  panelRecent: $('panel-recent'),
  searchProgress: $('search-progress'),
  nowBar: $('now-playing-bar'),
  nowArt: $('now-bar-art'),
  nowTitle: $('now-bar-title'),
  nowPlayIcon: $('now-bar-play-icon'),
  nowPauseIcon: $('now-bar-pause-icon'),
};

// ── 状態 ─────────────────────────────────────────────────────
const state = {
  track: null,
  lyrics: null,
  view: null,
  pipWindow: null,
  pipView: null,
  pipLyrics: null,
  rafId: 0,
  results: [],
};

const player = createPlayer({
  videoHost: ui.videoHost,
  audioHost: ui.audioHost,
  onState: () => {},
});

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const youTubeThumb = (videoId) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;

// ── 曲の解決 ─────────────────────────────────────────────────
const buildTrackFromVideoId = async (videoId, hint = {}) => {
  let title = hint.title || '';
  let artist = hint.artist || '';
  // oEmbed で曲名・歌手を取る(CORS 許可済み)。検索結果と違って確実な表記。
  if (!title) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
      if (res.ok) {
        const json = await res.json();
        title = String(json.title || '');
        artist = String(json.author_name || '');
      }
    } catch (e) { /* 取れなくても進む */ }
  }
  return {
    key: `yt:${videoId}`,
    kind: 'yt',
    videoId,
    title: title || 'Unknown title',
    artist,
    durationSec: Number(hint.durationSec) || 0,
    artwork: youTubeThumb(videoId),
  };
};

const buildTrackFromFile = (file) => {
  const parsed = parseTrackFilename(file.name);
  return {
    key: `file:${file.name}:${file.size}`,
    kind: 'file',
    file,
    title: parsed.title,
    artist: parsed.artist,
    durationSec: 0,
    artwork: '',
  };
};

// ── 検索 ─────────────────────────────────────────────────────
const setSearchProgress = (text) => {
  ui.searchProgress.textContent = text || '';
  ui.searchProgress.style.display = text ? 'block' : 'none';
};

const runSearch = async (query) => {
  const q = String(query || '').trim();
  if (!q) return;
  setSearchProgress('検索中…');

  // YouTube リンクならそのまま
  const videoId = extractYouTubeId(q);
  if (videoId) {
    setSearchProgress('曲情報を取得中…');
    const track = await buildTrackFromVideoId(videoId);
    state.results = [{ track }];
    renderResults();
    setSearchProgress('');
    playTrack(track);
    return;
  }

  // 曲名検索は SimpMusic (videoId つきで返ってくる)
  try {
    const candidates = await searchSimpMusic(q);
    state.results = candidates.map((c) => ({
      track: {
        key: `yt:${c.videoId}`,
        kind: 'yt',
        videoId: c.videoId,
        title: c.title,
        artist: c.artist,
        durationSec: c.durationSec || 0,
        artwork: youTubeThumb(c.videoId),
      },
    }));
  } catch (e) {
    state.results = [];
  }
  renderResults();
  setSearchProgress(state.results.length ? '' : '見つかりませんでした');
};

const renderResults = () => {
  ui.results.innerHTML = '';
  for (const item of state.results) {
    ui.results.appendChild(buildTrackRow(item.track));
  }
};

// ── 曲リスト行 ───────────────────────────────────────────────
const buildTrackRow = (track) => {
  const row = document.createElement('div');
  row.className = 'track-row';
  row.innerHTML = `
    <img class="track-art" src="${escapeHtml(track.artwork || '')}" alt="" ${track.artwork ? '' : 'hidden'}>
    <div class="track-info">
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="track-artist">${escapeHtml(track.artist || ' ')}</div>
    </div>
    <span class="track-kind">${track.kind === 'yt' ? 'YouTube' : 'MP3'}</span>
  `;
  row.addEventListener('click', () => playTrack(track));
  return row;
};

const renderList = (el, items) => {
  el.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'まだ何もありません';
    el.appendChild(empty);
    return;
  }
  for (const track of items) el.appendChild(buildTrackRow(track));
};

const refreshLists = () => {
  renderList(ui.favoritesList, store.getFavorites());
  renderList(ui.recentList, store.getRecent());
};

// ── お気に入りボタン ─────────────────────────────────────────
const LIKE_ON = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
const LIKE_OFF = 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.01 4.38.38-3.32 2.88 1 4.28L12 15.4z';

const refreshLikeButton = () => {
  const liked = state.track && store.isFavorite(state.track.key);
  ui.likePath.setAttribute('d', liked ? LIKE_ON : LIKE_OFF);
  ui.likeBtn.classList.toggle('liked', !!liked);
};

const onLikeClick = () => {
  if (!state.track) return;
  const added = store.toggleFavorite({
    key: state.track.key,
    kind: state.track.kind,
    videoId: state.track.videoId || null,
    title: state.track.title,
    artist: state.track.artist,
    durationSec: state.track.durationSec || 0,
    artwork: state.track.artwork || '',
  });
  // MP3 は IndexedDB に複製して、次に開いた時も再生できるようにする
  if (state.track.kind === 'file') {
    if (added && state.track.file) store.saveAudioCopy(state.track.key, state.track.file);
    if (!added) store.deleteAudioCopy(state.track.key);
  }
  refreshLikeButton();
  refreshLists();
};

// ── 再生 ─────────────────────────────────────────────────────
const playTrack = async (track) => {
  state.track = track;
  showPlayer(track);
  refreshLikeButton();
  store.pushRecent({
    key: track.key, kind: track.kind, videoId: track.videoId || null,
    title: track.title, artist: track.artist,
    durationSec: track.durationSec || 0, artwork: track.artwork || '',
  });
  refreshLists();
  startRaf();

  await player.load(track, true);
  player.play();

  updateMediaSession({
    title: track.title,
    artist: track.artist,
    artwork: track.artwork,
    handlers: {
      play: () => player.play(),
      pause: () => player.pause(),
      seekTo: (t) => player.seek(t),
      prev: () => stepTrack(1),
      next: () => stepTrack(-1),
    },
  });

  loadLyrics(track);
};

// ── 歌詞 ─────────────────────────────────────────────────────
const applyLyrics = (result) => {
  // 見出し・クレジット行を落とす(拡張と同じ)
  const lines = stripLeadingHeaderLines(result.lines, state.track.title);
  state.lyrics = { ...result, lines };

  state.view = createLyricsView(ui.lyricsContainer, {
    onSeek: (t) => player.seek(t),
  });
  const rows = renderLyricsInto(ui.lyricsContainer, state.lyrics.lines, state.lyrics.dynamicLines);
  state.view.setRows(rows);

  // PIP が開いているならそちらにも同じ歌詞を出す
  if (state.pipWindow) renderPipLyrics();
};

const loadLyrics = async (track) => {
  state.lyrics = null;
  ui.lyricsContainer.innerHTML = '<div class="lyric-loading">歌詞を探しています…</div>';

  let result = null;

  if (track.videoId) {
    result = store.getCachedLyrics(track.videoId);
    if (!result) {
      result = await fetchLyricsByVideoId(track.videoId);
      if (result) store.setCachedLyrics(track.videoId, result);
    }
  }

  // MP3 など videoId が無い曲は、曲名(+長さ)で SimpMusic 検索して
  // 最も近い曲の歌詞を借りる。
  if (!result && track.kind === 'file' && track.title) {
    const hit = await resolveVideoIdForTrack({
      track: track.title,
      artist: track.artist,
      durationSec: track.durationSec || player.getDuration(),
    });
    if (hit) result = await fetchLyricsByVideoId(hit.videoId);
  }

  if (state.track !== track) return; // 曲が変わっていたら破棄

  if (!result) {
    ui.lyricsContainer.innerHTML = '<div class="lyric-loading">歌詞が見つかりませんでした</div>';
    if (state.pipWindow) renderPipLyrics();
    return;
  }
  applyLyrics(result);
};

// ── プレイヤー画面 ───────────────────────────────────────────
const showPlayer = (track) => {
  ui.homeScreen.style.display = 'none';
  ui.playerScreen.style.display = 'flex';
  ui.title.textContent = track.title;
  ui.artist.textContent = track.artist || '';
  ui.artwork.src = track.artwork || '';
  ui.artwork.hidden = !track.artwork;
  ui.bgLayer.style.backgroundImage = track.artwork ? `url('${track.artwork}')` : 'none';
  document.body.classList.add('player-open');
};

const closePlayer = () => {
  ui.playerScreen.style.display = 'none';
  ui.homeScreen.style.display = 'block';
  document.body.classList.remove('player-open');
  // 再生は続ける。ホームに再生中バーを出す。
  refreshNowBar();
};

// ── 再生中バー ───────────────────────────────────────────────
const refreshNowBar = () => {
  const show = !!state.track && ui.playerScreen.style.display === 'none';
  ui.nowBar.style.display = show ? 'flex' : 'none';
  if (show) {
    ui.nowTitle.textContent = state.track.title;
    ui.nowArt.src = state.track.artwork || '';
    ui.nowArt.hidden = !state.track.artwork;
  }
};

// ── RAF ループ ───────────────────────────────────────────────
let seekDragging = false;

const startRaf = () => {
  stopRaf();
  const loop = () => {
    state.rafId = requestAnimationFrame(loop);
    const now = performance.now();
    if (state.view) state.view.stepScroll(now);
    if (state.pipView) state.pipView.stepScroll(now);

    const playing = !player.isPaused();
    const t = player.getSmoothTime();
    const dur = player.getDuration();

    if (state.view && state.lyrics?.hasTimestamp) state.view.update(t);
    if (state.pipView && state.lyrics?.hasTimestamp) state.pipView.update(t);
    if (state.pipWindow) syncPipPlayIcon(playing);

    if (state.track) {
      ui.currentTime.textContent = formatTime(t);
      ui.duration.textContent = formatTime(dur);
      if (dur > 0) {
        const val = Math.min(1, t / dur);
        if (!seekDragging) {
          ui.seekBar.value = String(val);
          ui.seekBar.style.setProperty('--fill', `${(val * 100).toFixed(1)}%`);
        }
      }
      ui.playIcon.style.display = playing ? 'none' : 'block';
      ui.pauseIcon.style.display = playing ? 'block' : 'none';
      ui.nowPlayIcon.style.display = playing ? 'none' : 'block';
      ui.nowPauseIcon.style.display = playing ? 'block' : 'none';

      // metadata ではなく playbackState だけを動かす(毎フレーム new しない)
      setMediaSessionPlaybackState(!playing);
    }
  };
  state.rafId = requestAnimationFrame(loop);
};

const stopRaf = () => {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
};

// ── シークバー ───────────────────────────────────────────────
ui.seekBar.addEventListener('input', () => {
  seekDragging = true;
  ui.seekBar.style.setProperty('--fill', `${(parseFloat(ui.seekBar.value) * 100).toFixed(1)}%`);
});
ui.seekBar.addEventListener('change', () => {
  const dur = player.getDuration();
  if (dur > 0) player.seek(parseFloat(ui.seekBar.value) * dur);
  seekDragging = false;
});

// ── 操作ボタン ───────────────────────────────────────────────
const togglePlay = () => { if (player.isPaused()) player.play(); else player.pause(); };
ui.playBtn.addEventListener('click', togglePlay);
ui.likeBtn.addEventListener('click', onLikeClick);
// 再生中バーをタップしたらプレイヤーへ戻る
ui.nowBar.addEventListener('click', () => {
  if (state.track) showPlayer(state.track);
  ui.nowBar.style.display = 'none';
});
ui.closeBtn.addEventListener('click', () => { closePlayer(); refreshNowBar(); });
ui.prevBtn.addEventListener('click', () => stepTrack(1));
ui.nextBtn.addEventListener('click', () => stepTrack(-1));

// 履歴を「新しい順」として前後の曲を辿る
const stepTrack = (dir) => {
  const list = store.getRecent();
  if (list.length < 2) return;
  const idx = list.findIndex((f) => f.key === state.track?.key);
  const at = idx < 0 ? 0 : (idx + dir + list.length) % list.length;
  resumeFromItem(list[at]);
};

// お気に入り/履歴の項目から再生を復帰させる
const resumeFromItem = async (item) => {
  const track = { ...item };
  if (item.kind === 'file') {
    const blob = await store.loadAudioCopy(item.key);
    if (!blob) {
      // 複製が無い=元ファイルをもう読ませていない。案内して終わり。
      alert('この曲の音声ファイルがありません。もう一度 MP3 を読み込んでください。');
      return;
    }
    track.file = new File([blob], `${item.title || 'audio'}.mp3`, { type: blob.type || 'audio/mpeg' });
  }
  playTrack(track);
};

// ── タブ ─────────────────────────────────────────────────────
const switchTab = (tab) => {
  for (const [el, active] of [
    [ui.tabSearch, tab === 'search'], [ui.tabFav, tab === 'fav'], [ui.tabRecent, tab === 'recent'],
  ]) el.classList.toggle('active', active);
  ui.panelSearch.style.display = tab === 'search' ? 'block' : 'none';
  ui.panelFav.style.display = tab === 'fav' ? 'block' : 'none';
  ui.panelRecent.style.display = tab === 'recent' ? 'block' : 'none';
};
ui.tabSearch.addEventListener('click', () => switchTab('search'));
ui.tabFav.addEventListener('click', () => switchTab('fav'));
ui.tabRecent.addEventListener('click', () => switchTab('recent'));

// ── 検索フォーム ─────────────────────────────────────────────
ui.searchBtn.addEventListener('click', () => runSearch(ui.searchInput.value));
ui.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch(ui.searchInput.value);
});
ui.fileInput.addEventListener('change', () => {
  const files = Array.from(ui.fileInput.files || []);
  if (!files.length) return;
  const tracks = files.map(buildTrackFromFile);
  state.results = tracks.map((track) => ({ track }));
  renderResults();
  playTrack(tracks[0]);
});

// ── Document PiP (デスクトップ Chrome / Edge) ────────────────
// 拡張の PIP と同じ小窓。YouTube はページを離れると鳴らなくなるので、
// 非表示になる直前に開いて鳴らし続ける。MP3 は要らないが開いても良い。
const PIP_WIDTH = 380;
const PIP_HEIGHT = 600;

const syncPipPlayIcon = (playing) => {
  const doc = state.pipWindow?.document;
  if (!doc) return;
  const play = doc.getElementById('pip-play-icon');
  const pause = doc.getElementById('pip-pause-icon');
  if (play) play.style.display = playing ? 'none' : 'block';
  if (pause) pause.style.display = playing ? 'block' : 'none';
};

const renderPipLyrics = () => {
  if (!state.pipWindow || !state.pipLyrics) return;
  if (state.lyrics) {
    state.pipView = createLyricsView(state.pipLyrics, {
      onSeek: (t) => player.seek(t),
    });
    const rows = renderLyricsInto(state.pipLyrics, state.lyrics.lines, state.lyrics.dynamicLines);
    state.pipView.setRows(rows);
  } else {
    state.pipView = null;
    state.pipLyrics.innerHTML = '<div class="lyric-loading">歌詞がありません</div>';
  }
};

const openPip = async () => {
  if (state.pipWindow || !('documentPictureInPicture' in window)) return;
  if (!state.track) return;
  try {
    const win = await window.documentPictureInPicture.requestWindow({
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
    });
    state.pipWindow = win;
    const doc = win.document;

    // 同一オリジンの CSS はリンクごと複製すれば読み込まれる
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      doc.head.appendChild(node.cloneNode(true));
    }
    doc.body.className = 'pip-mode';

    const artworkUrl = escapeHtml(state.track.artwork || '');
    doc.body.innerHTML = `
      <div id="pip-container">
        <div id="pip-bg-layer" style="background-image: url('${artworkUrl}')"></div>
        <div id="pip-noise-layer"></div>
        <div class="pip-header">
          <div class="artwork-box"><img src="${artworkUrl}" alt="" ${artworkUrl ? '' : 'hidden'}></div>
          <div class="info-box">
            <div id="pip-title">${escapeHtml(state.track.title)}</div>
            <div id="pip-artist">${escapeHtml(state.track.artist || '')}</div>
          </div>
        </div>
        <div id="pip-lyrics-container"></div>
        <div class="controls-box">
          <button id="pip-prev-btn" class="control-btn sub-btn" type="button">
            <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button id="pip-play-btn" class="control-btn main-btn" type="button">
            <svg id="pip-play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            <svg id="pip-pause-icon" viewBox="0 0 24 24" style="display:none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
          </button>
          <button id="pip-next-btn" class="control-btn sub-btn" type="button">
            <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
        </div>
      </div>
    `;

    state.pipLyrics = doc.getElementById('pip-lyrics-container');
    doc.getElementById('pip-play-btn').addEventListener('click', togglePlay);
    doc.getElementById('pip-prev-btn').addEventListener('click', () => stepTrack(1));
    doc.getElementById('pip-next-btn').addEventListener('click', () => stepTrack(-1));

    renderPipLyrics();

    win.addEventListener('pagehide', () => {
      state.pipWindow = null;
      state.pipView = null;
      state.pipLyrics = null;
    });
  } catch (e) { /* 開けない環境では諦める */ }
};

const closePip = () => {
  try { state.pipWindow?.close(); } catch (e) { /* 破棄済み */ }
  state.pipWindow = null;
  state.pipView = null;
  state.pipLyrics = null;
};

document.addEventListener('visibilitychange', () => {
  // YouTube は隠れると止まる。MP3 は止まらないが、小窓があると操作しやすい。
  if (document.hidden) {
    const wantsPip = state.track?.kind === 'yt' || !!state.pipWindow;
    if (wantsPip && store.getSettings().autoPip) openPip();
  }
});

// ── 起動 ─────────────────────────────────────────────────────
const init = () => {
  refreshLists();
  switchTab('search');
  ui.playerScreen.style.display = 'none';
  ui.nowBar.style.display = 'none';

  // YouTube IFrame API とプレイヤーを先に温めておく。
  // iOS ではユーザー操作の文脈が切れると playVideo が通らないため、
  // クリックの時点で準備が終わっていることが重要。
  player.prepare();

  // URL に ?v= か #v= があればそこから即再生(共有リンクで開けるように)
  const paramMatch = (location.search + location.hash).match(/[?&#]v=([\w-]{11})/);
  if (paramMatch) {
    buildTrackFromVideoId(paramMatch[1]).then((track) => {
      state.results = [{ track }];
      renderResults();
      playTrack(track);
    });
  }
};

init();
