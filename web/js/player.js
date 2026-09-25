// ============================================================
// 統一プレイヤー (Web 版)
//
// MP3(ファイル) と YouTube(IFrame API) を同じ surface で扱う。
// duration / currentTime / paused / playbackRate / seek / volume
// を外から同じ形で読み書きできるようにする。
//
// バックグラウンド再生:
//   - MP3 は <audio> 要素なのでタブを離れても鳴り続ける
//   - YouTube は IFrame API。iPhone の Safari ではページが非表示に
//     なると YouTube 内部の再生が止められるため、多くの環境では
//     「他アプリを開いたら PiP(小窓)で映し続ける」のが実質の解。
//     onPageHide で PiP を立ち上げ、戻ってきたら閉じる。
//   - Media Session API でロック画面・コントロールセンターに
//     曲名・アートワーク・再生操作を出す(MP3 / YouTube 両方)。
// ============================================================

const YT_IFRAME_SRC = 'https://www.youtube.com/iframe_api';

let ytApiPromise = null;

const loadYouTubeIframeApi = () => {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') { try { prev(); } catch (e) { /* 無視 */ } }
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = YT_IFRAME_SRC;
    document.head.appendChild(tag);
  });
  return ytApiPromise;
};

export const createPlayer = ({ videoHost, audioHost, onState }) => {
  // source: { kind: 'yt', videoId, title, artist, artwork } か
  //         { kind: 'file', file | url, title, artist, artwork, duration }
  let current = null;
  let ytPlayer = null;
  let audioEl = null;
  let ytReady = false;
  let pendingPlay = false;
  let smoothTime = 0;
  let lastTickAt = 0;

  const notify = (patch) => { if (onState) onState(patch, current); };

  const ensureAudio = () => {
    if (audioEl) return audioEl;
    audioEl = document.createElement('audio');
    audioEl.preload = 'auto';
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.crossOrigin = 'anonymous';
    audioHost.appendChild(audioEl);
    audioEl.addEventListener('timeupdate', () => notify({}));
    audioEl.addEventListener('play', () => notify({}));
    audioEl.addEventListener('pause', () => notify({}));
    audioEl.addEventListener('ended', () => notify({ ended: true }));
    return audioEl;
  };

  const ensureYouTube = async () => {
    if (ytPlayer) return ytPlayer;
    const YT = await loadYouTubeIframeApi();
    ytPlayer = new YT.Player(videoHost, {
      videoId: '',
      playerVars: {
        playsinline: 1,          // iOS でインライン再生に必須
        rel: 0,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        iv_load_policy: 3,
      },
      events: {
        onReady: () => {
          ytReady = true;
          if (pendingPlay) {
            pendingPlay = false;
            try { ytPlayer.playVideo(); } catch (e) { /* ユーザー操作待ち */ }
          }
          notify({});
        },
        onStateChange: (e) => {
          // ENDED=0, PLAYING=1, PAUSED=2
          if (e.data === 0) notify({ ended: true });
          notify({});
        },
      },
    });
    return ytPlayer;
  };

  const stopAll = () => {
    if (audioEl) { try { audioEl.pause(); } catch (e) { /* 無視 */ } }
    if (ytPlayer && ytReady) { try { ytPlayer.stopVideo(); } catch (e) { /* 無視 */ } }
  };

  const load = async (source, autoplay = false) => {
    if (current && current.key === source.key) return;
    stopAll();
    // 前の曲の Blob URL を回収する
    if (current?.kind === 'file' && current._objectUrl) {
      try { URL.revokeObjectURL(current._objectUrl); } catch (e) { /* 無視 */ }
    }
    current = source;
    pendingPlay = false;
    smoothTime = 0;

    if (source.kind === 'yt') {
      const player = await ensureYouTube();
      if (current !== source) return;
      // iOS では pause→play の往復にユーザー操作の文脈が要る。
      // すぐ鳴らすなら loadVideoById の勢いでそのまま鳴らす。
      if (autoplay) {
        player.loadVideoById(source.videoId);
      } else {
        player.loadVideoById(source.videoId);
        player.pauseVideo();
      }
    } else {
      const audio = ensureAudio();
      const url = source.url || URL.createObjectURL(source.file);
      source._objectUrl = source.url ? null : url;
      audio.src = url;
      audio.load();
    }
    notify({});
  };

  const play = async () => {
    if (!current) return;
    if (current.kind === 'yt') {
      if (!ytReady) { pendingPlay = true; await ensureYouTube(); return; }
      try { ytPlayer.playVideo(); } catch (e) { pendingPlay = true; }
    } else {
      const audio = ensureAudio();
      try { await audio.play(); } catch (e) { /* ユーザー操作が必要 */ }
    }
  };

  const pause = () => {
    if (!current) return;
    if (current.kind === 'yt') {
      if (ytReady) { try { ytPlayer.pauseVideo(); } catch (e) { /* 無視 */ } }
    } else if (audioEl) {
      audioEl.pause();
    }
  };

  const seek = (sec) => {
    if (!current) return;
    if (current.kind === 'yt') {
      if (ytReady) { try { ytPlayer.seekTo(sec, true); } catch (e) { /* 無視 */ } }
    } else if (audioEl && Number.isFinite(audioEl.duration)) {
      audioEl.currentTime = Math.min(Math.max(0, sec), audioEl.duration);
    }
    smoothTime = sec;
  };

  const getDuration = () => {
    if (!current) return 0;
    if (current.kind === 'yt') {
      if (!ytReady) return Number(current.duration) || 0;
      const d = ytPlayer.getDuration();
      return Number.isFinite(d) ? d : 0;
    }
    return (audioEl && Number.isFinite(audioEl.duration)) ? audioEl.duration : (Number(current.duration) || 0);
  };

  const getTime = () => {
    if (!current) return 0;
    if (current.kind === 'yt') {
      if (!ytReady) return smoothTime;
      const t = ytPlayer.getCurrentTime();
      return Number.isFinite(t) ? t : smoothTime;
    }
    return audioEl ? audioEl.currentTime : 0;
  };

  // 滑らかな再生位置。getCurrentTime は 1 秒に数回しか更新されないので、
  // 実時間で補間して塗りをなめらかに動かす(拡張の readSmoothPlaybackTime と同じ発想)。
  const getSmoothTime = () => {
    const now = performance.now();
    const dt = lastTickAt ? Math.min(0.25, (now - lastTickAt) / 1000) : 0;
    lastTickAt = now;

    const raw = getTime();
    const playing = !isPaused() && getDuration() > 0;
    if (playing) {
      // YouTube の raw は階段状に進む。前回の補間値より進んでいたらそれに追従。
      smoothTime = Math.max(smoothTime + dt, raw > smoothTime ? raw : smoothTime);
      const dur = getDuration();
      if (dur > 0 && smoothTime > dur) smoothTime = dur;
      if (Math.abs(smoothTime - raw) > 1.5) smoothTime = raw; // シークされた
    } else {
      smoothTime = raw;
    }
    return smoothTime;
  };

  const isPaused = () => {
    if (!current) return true;
    if (current.kind === 'yt') {
      if (!ytReady) return true;
      return ytPlayer.getPlayerState() !== 1; // PLAYING 以外は止まっている扱い
    }
    return audioEl ? audioEl.paused : true;
  };

  const setVolume = (v) => {
    if (audioEl) audioEl.volume = Math.min(1, Math.max(0, v));
    if (ytPlayer && ytReady && ytPlayer.setVolume) {
      try { ytPlayer.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100)); } catch (e) { /* 無視 */ }
    }
  };

  const setRate = (r) => {
    if (audioEl) audioEl.playbackRate = r;
    if (ytPlayer && ytReady && ytPlayer.setPlaybackRate) {
      try { ytPlayer.setPlaybackRate(r); } catch (e) { /* 無視 */ }
    }
  };

  return {
    load,
    play,
    pause,
    seek,
    getDuration,
    getTime,
    getSmoothTime,
    isPaused,
    setVolume,
    setRate,
    // iOS ではユーザー操作の文脈が切れると playVideo が通らない。
    // ページを開いた時点で IFrame API とプレイヤーを準備しておく。
    prepare: ensureYouTube,
    get current() { return current; },
  };
};

// ── Media Session (ロック画面・コントロールセンター) ─────────
// metadata は曲が変わった時に1回だけ作る。毎フレーム new すると
// ロック画面の表示がちらつく。playing 状態だけを別で動かす。
export const updateMediaSession = ({ title, artist, artwork, handlers }) => {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || '',
      artist: artist || '',
      album: '',
      artwork: artwork ? [
        { src: artwork, sizes: '512x512', type: 'image/jpeg' },
        { src: artwork, sizes: '256x256', type: 'image/jpeg' },
      ] : [],
    });
    if (handlers.play) navigator.mediaSession.setActionHandler('play', handlers.play);
    if (handlers.pause) navigator.mediaSession.setActionHandler('pause', handlers.pause);
    if (handlers.seekTo) navigator.mediaSession.setActionHandler('seekto', (d) => handlers.seekTo(d.seekTime));
    if (handlers.prev) navigator.mediaSession.setActionHandler('previoustrack', handlers.prev);
    if (handlers.next) navigator.mediaSession.setActionHandler('nexttrack', handlers.next);
  } catch (e) { /* 対応外の操作は黙って諦める */ }
};

export const setMediaSessionPlaybackState = (paused) => {
  if (!('mediaSession' in navigator)) return;
  try {
    const next = paused ? 'paused' : 'playing';
    if (navigator.mediaSession.playbackState !== next) {
      navigator.mediaSession.playbackState = next;
    }
  } catch (e) { /* 無視 */ }
};
