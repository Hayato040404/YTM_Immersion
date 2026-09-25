// ============================================================
// 永続化 (Web 版)
//
// - お気に入り・履歴: localStorage (小さい JSON)
// - 歌詞キャッシュ: localStorage (videoId 単位。24h TTL)
// - MP3 の複製: IndexedDB (お気に入りにしたファイルをここにも
//   入れておくと、次に開いた時もそのまま再生できる)
// ============================================================

const FAV_KEY = 'immersion.favorites';
const RECENT_KEY = 'immersion.recent';
const LYRICS_CACHE_KEY = 'immersion.lyricsCache';
const SETTINGS_KEY = 'immersion.settings';

const LYRICS_TTL_MS = 24 * 60 * 60 * 1000;
const LYRICS_MAX = 64;
const RECENT_MAX = 32;

const readJson = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
};

const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
};

// ── お気に入り ───────────────────────────────────────────────
// { key, kind, videoId?, title, artist, durationSec, artwork, addedAt }
export const getFavorites = () => readJson(FAV_KEY, []);

export const isFavorite = (key) => getFavorites().some((f) => f.key === key);

export const addFavorite = (item) => {
  const list = getFavorites().filter((f) => f.key !== item.key);
  list.unshift({ ...item, addedAt: Date.now() });
  return writeJson(FAV_KEY, list.slice(0, 200));
};

export const removeFavorite = (key) => (
  writeJson(FAV_KEY, getFavorites().filter((f) => f.key !== key))
);

export const toggleFavorite = (item) => {
  if (isFavorite(item.key)) {
    removeFavorite(item.key);
    return false;
  }
  addFavorite(item);
  return true;
};

// ── 履歴 ─────────────────────────────────────────────────────
export const getRecent = () => readJson(RECENT_KEY, []);

export const pushRecent = (item) => {
  const list = getRecent().filter((f) => f.key !== item.key);
  list.unshift({ ...item, playedAt: Date.now() });
  return writeJson(RECENT_KEY, list.slice(0, RECENT_MAX));
};

export const clearRecent = () => writeJson(RECENT_KEY, []);

// ── 歌詞キャッシュ (videoId 単位) ────────────────────────────
export const getCachedLyrics = (videoId) => {
  const cache = readJson(LYRICS_CACHE_KEY, {});
  const entry = cache[videoId];
  if (!entry) return null;
  if (Date.now() - entry.at > LYRICS_TTL_MS) {
    delete cache[videoId];
    writeJson(LYRICS_CACHE_KEY, cache);
    return null;
  }
  return entry.value;
};

export const setCachedLyrics = (videoId, value) => {
  const cache = readJson(LYRICS_CACHE_KEY, {});
  cache[videoId] = { at: Date.now(), value };
  const keys = Object.keys(cache);
  // 古い順に捨てる
  if (keys.length > LYRICS_MAX) {
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const key of keys.slice(0, keys.length - LYRICS_MAX)) delete cache[key];
  }
  return writeJson(LYRICS_CACHE_KEY, cache);
};

export const clearLyricsCache = () => writeJson(LYRICS_CACHE_KEY, {});

// ── 設定 ─────────────────────────────────────────────────────
const DEFAULT_SETTINGS = { autoPip: true, syncOffsetMs: 0 };

export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) });

export const setSettings = (patch) => {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_KEY, next);
  return next;
};

// ── MP3 の複製 (IndexedDB) ───────────────────────────────────
const DB_NAME = 'immersion-player';
const STORE_NAME = 'audio';
const DB_VERSION = 1;

const openDb = () => new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const putBlob = async (key, blob) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
};

const getBlob = async (key) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
};

const deleteBlob = async (key) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
};

// お気に入りにした MP3 を複製しておく。key は favorites の key と揃える。
export const saveAudioCopy = (key, blob) => putBlob(`audio:${key}`, blob).catch(() => {});
export const loadAudioCopy = (key) => getBlob(`audio:${key}`).catch(() => null);
export const deleteAudioCopy = (key) => deleteBlob(`audio:${key}`).catch(() => {});
