// ============================================================
// SimpMusic Lyrics クライアント + LRC パーサー (Web 版)
//
// 拡張機能の src/js/module/api.js (SimpMusic 経路・parseDynamicLrc・
// parseLRCInternal) と extra-providers.js (候補の点数付け) を、
// ブラウザ単体で動く形に移植したもの。
//
// api-lyrics.simpmusic.org は CORS で access-control-allow-origin: * を
// 返すため、GitHub Pages から直接 fetch できる(プロキシ不要)。
//   GET /v1/{videoId}   その動画の歌詞(richSync / synced / plain)
//   GET /v1/search?q=   曲名検索(videoId つき)
// ============================================================

export const SIMPMUSIC_ENDPOINT = 'https://api-lyrics.simpmusic.org/v1';

const decodeHtmlEntities = (value) => String(value ?? '')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  })
  .replace(/&#(\d+);/g, (_, dec) => {
    const code = parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  })
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  // &amp; は最後。先に戻すと "&amp;lt;" が "<" まで解けてしまう。
  .replace(/&amp;/g, '&');

export const toFiniteMs = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// ── LRC の時刻 [mm:ss.xx] → ms ───────────────────────────────
export const parseLrcTimeToMs = (ts) => {
  const s = String(ts || '').trim();
  const m = s.match(/^(\d+):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const ss = parseInt(m[2], 10);
  let frac = m[3] || '0';
  if (frac.length === 1) frac = frac + '00';
  else if (frac.length === 2) frac = frac + '0';
  const ms = parseInt(frac.slice(0, 3), 10);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(ms)) return null;
  return (mm * 60 + ss) * 1000 + ms;
};

// ── 通常 LRC → 行配列 (拡張 lyrics-ui.js の parseLRCInternal と同じ) ──
export const parseLRCInternal = (lrc) => {
  if (!lrc) return { lines: [], hasTs: false };
  const tagTest = /\[\s*\d{1,3}\s*:\s*\d{2}\s*(?:[.:]\s*\d{1,4}\s*)?\]/;
  // 語タグ <00:12.34> はここでは行同期として読むので表示文字列から落とす
  const LRC_WORD_TAG = /<\s*\d{1,3}\s*:\s*\d{2}\s*(?:[.:]\s*\d{1,3}\s*)?>/g;

  if (!tagTest.test(lrc)) {
    const lines = lrc.split(/\r?\n/).map((line) => {
      const text = (line ?? '').replace(LRC_WORD_TAG, '').replace(/^\s+|\s+$/g, '');
      return { time: null, text };
    });
    return { lines, hasTs: false };
  }

  const rows = lrc.split(/\r?\n/);
  const result = [];
  const tagExp = /\[\s*(\d{1,3})\s*:\s*(\d{2})\s*(?:[.:]\s*(\d{1,4})\s*)?\]/g;

  rows.forEach((lineStr) => {
    const line = (lineStr ?? '').trim();
    if (!line) return;

    const tags = [];
    let match;
    tagExp.lastIndex = 0;
    while ((match = tagExp.exec(line)) !== null) {
      const time = parseLrcTimeToMs(`${match[1]}:${match[2]}${match[3] ? '.' + match[3] : ''}`);
      if (time !== null) tags.push(time / 1000);
    }

    if (tags.length > 0) {
      const text = line
        .replace(/\[\s*\d{1,3}\s*:\s*\d{2}\s*(?:[.:]\s*\d{1,4}\s*)?\]/g, '')
        .replace(LRC_WORD_TAG, '')
        .trim();
      tags.forEach((time) => result.push({ time, text }));
    }
  });

  result.sort((a, b) => (a.time || 0) - (b.time || 0));
  return { lines: result, hasTs: true };
};

// ── 1文字ぶんの妥当な長さ (api.js と同じ) ────────────────────
const CHAR_DURATION_FALLBACK_MS = 300;
const CHAR_DURATION_MIN_MS = 120;
const CHAR_DURATION_MAX_MS = 900;

export const estimateCharDurationMs = (chars) => {
  if (!Array.isArray(chars) || chars.length < 2) return CHAR_DURATION_FALLBACK_MS;
  const gaps = [];
  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1]?.t;
    const cur = chars[i]?.t;
    if (typeof prev === 'number' && typeof cur === 'number' && cur > prev) gaps.push(cur - prev);
  }
  if (!gaps.length) return CHAR_DURATION_FALLBACK_MS;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(CHAR_DURATION_MAX_MS, Math.max(CHAR_DURATION_MIN_MS, median));
};

// ── 拡張 LRC (<mm:ss.xx>語) → 行 + 文字時刻 (api.js と同じ) ──
export const parseDynamicLrc = (text) => {
  const out = [];
  if (!text) return out;
  const rows = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parsed = [];
  for (const raw of rows) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(/^\[(\d+:\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/);
    if (!m) continue;
    parsed.push({ lineMs: parseLrcTimeToMs(m[1]), rest: m[2] || '' });
  }

  const pushDistributed = (chars, chunk, startMs, endMs) => {
    if (!chunk) return;
    const arr = Array.from(chunk);
    const n = arr.length;
    if (!n) return;
    const s = (typeof startMs === 'number') ? startMs : null;
    const e = (typeof endMs === 'number') ? endMs : null;
    if (s == null) {
      for (const ch of arr) chars.push({ t: 0, c: ch });
      return;
    }
    if (e == null || e <= s) {
      for (const ch of arr) chars.push({ t: s, c: ch });
      return;
    }
    const dur = Math.max(1, e - s);
    const step = dur / n;
    for (let i = 0; i < n; i++) chars.push({ t: s + Math.floor(step * i), c: arr[i] });
  };

  for (let li = 0; li < parsed.length; li++) {
    const { lineMs, rest } = parsed[li];
    const nextLineMs = (li + 1 < parsed.length && typeof parsed[li + 1].lineMs === 'number')
      ? parsed[li + 1].lineMs
      : null;
    const tagRe = /<(\d+:\d{2}(?:\.\d{1,3})?)>/g;
    const chars = [];
    let prevMs = null;
    let prevEnd = 0;

    for (;;) {
      const mm = tagRe.exec(rest);
      if (!mm) break;
      const tagMs = parseLrcTimeToMs(mm[1]);
      if (prevMs == null && tagMs != null && mm.index > prevEnd) {
        pushDistributed(chars, rest.slice(prevEnd, mm.index), tagMs, tagMs);
      }
      if (prevMs != null) {
        pushDistributed(chars, rest.slice(prevEnd, mm.index), prevMs, tagMs);
      }
      prevMs = tagMs;
      prevEnd = mm.index + mm[0].length;
    }

    if (prevMs != null) {
      const tail = rest.slice(prevEnd);
      let endMs = nextLineMs;
      if (typeof endMs !== 'number') endMs = prevMs + 1500;
      if (endMs <= prevMs) endMs = prevMs + 200;
      // 行末の文字を「次の行が始まるまで」で割ると、間奏に入る行で破綻する。
      // その行自身の文字の進み方から妥当な上限を作り、短い方を採る。
      const tailCount = Math.max(1, Array.from(tail).length);
      endMs = Math.min(endMs, prevMs + estimateCharDurationMs(chars) * tailCount);
      pushDistributed(chars, tail, prevMs, endMs);
    }

    out.push({
      startTimeMs: (typeof lineMs === 'number' ? lineMs : (chars.length ? chars[0].t : 0)),
      text: chars.map((c) => c.c).join(''),
      chars,
    });
  }

  return out;
};

// ── 先頭の見出し・クレジット行を落とす (lyrics-ui.js と同じ) ──
const LYRIC_CREDIT_LABELS = [
  '制作人', '製作人', '制作', '製作', '出品', '监制', '監製',
  '作詞', '作词', '作曲', '编曲', '編曲', '词曲', '詞曲',
  '词', '詞', '曲', '编', '編',
  '原唱', '翻唱', '演唱', '主唱', '歌手', '专辑', '專輯',
  '混音', '録音', '录音', '母带', '母帶', '和声', '和聲',
  'produced by', 'producer', 'lyrics', 'lyricist', 'lyric',
  'music', 'composer', 'composed by', 'arranged by', 'arranger',
  'vocal', 'chorus', 'mixing', 'mastering', 'op', 'sp',
];

const normalizeCreditLabel = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, '');

const LYRIC_CREDIT_LABEL_KEYS = LYRIC_CREDIT_LABELS.map(normalizeCreditLabel);

const isLyricCreditLine = (text) => {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const m = raw.match(/^([^:：]{1,24})[:：]/);
  if (!m) return false;
  const label = normalizeCreditLabel(m[1]);
  if (!label) return false;
  return LYRIC_CREDIT_LABEL_KEYS.some((known) => label.includes(known));
};

const normalizeLyricHeaderText = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, '');

const isLyricTitleHeaderLine = (line, nextLine, medianGapSec, trackTitle) => {
  const title = normalizeLyricHeaderText(trackTitle);
  const text = normalizeLyricHeaderText(line?.text);
  if (!title || !text || title.length < 2) return false;
  if (!text.includes(title)) return false;
  if (typeof line?.time !== 'number' || line.time > 5) return false;
  if (typeof nextLine?.time !== 'number') return false;
  const gap = nextLine.time - line.time;
  if (gap < 10) return false;
  if (!(medianGapSec > 0) || gap < medianGapSec * 4) return false;
  return true;
};

const MAX_STRIPPED_HEADER_LINES = 6;

export const stripLeadingHeaderLines = (lines, trackTitle) => {
  if (!Array.isArray(lines) || lines.length < 3) return lines;

  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]?.time;
    const cur = lines[i]?.time;
    if (typeof prev === 'number' && typeof cur === 'number') gaps.push(cur - prev);
  }
  gaps.sort((a, b) => a - b);
  const medianGapSec = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  let start = 0;
  while (start < lines.length - 1 && start < MAX_STRIPPED_HEADER_LINES) {
    const line = lines[start];
    if (isLyricCreditLine(line?.text)) { start += 1; continue; }
    if (isLyricTitleHeaderLine(line, lines[start + 1], medianGapSec, trackTitle)) {
      start += 1;
      continue;
    }
    break;
  }

  if (!start) return lines;
  return lines.slice(start);
};

// ── SimpMusic のエントリ選び (api.js と同じ) ─────────────────
export const pickBestSimpMusicEntry = (items) => {
  if (!Array.isArray(items) || !items.length) return null;
  const rank = (item) => {
    if (!item || typeof item !== 'object') return -1;
    let score = 0;
    if (typeof item.richSyncLyrics === 'string' && item.richSyncLyrics.trim()) score += 100;
    else if (typeof item.syncedLyrics === 'string' && item.syncedLyrics.trim()) score += 50;
    else if (typeof item.plainLyric === 'string' && item.plainLyric.trim()) score += 10;
    else return -1;
    const vote = Number(item.vote);
    if (Number.isFinite(vote)) score += Math.max(-9, Math.min(9, vote));
    return score;
  };
  let best = null;
  let bestScore = -1;
  for (const item of items) {
    const score = rank(item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
};

// richSync → { lines, dynamicLines }。lines は dynamicLines から作るので
// 時刻が必ず一致し、行↔文字データのペアリングで迷わない。
export const convertSimpMusicEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;

  const rich = decodeHtmlEntities(entry.richSyncLyrics || '').trim();
  if (rich) {
    const dynamicLines = parseDynamicLrc(rich);
    if (dynamicLines.length) {
      const lines = dynamicLines
        .map((dl) => ({ time: dl.startTimeMs / 1000, text: dl.text }))
        .filter((l) => Number.isFinite(l.time));
      if (lines.length) {
        return { lines, dynamicLines, hasTimestamp: true };
      }
    }
  }

  const synced = decodeHtmlEntities(entry.syncedLyrics || '').trim();
  if (synced) {
    const { lines, hasTs } = parseLRCInternal(synced);
    if (lines.length) {
      return { lines, dynamicLines: null, hasTimestamp: hasTs };
    }
  }

  const plain = decodeHtmlEntities(entry.plainLyric || '').trim();
  if (plain) {
    const lines = plain.split(/\r?\n/).map((text) => ({ time: null, text }));
    return { lines, dynamicLines: null, hasTimestamp: false };
  }

  return null;
};

// ── 曲候補の点数付け (extra-providers.js と同じ) ─────────────
const normalizeTrackTitle = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const normalizeArtist = (s) => (s || '').toLowerCase().replace(/\s+/g, '').trim();

export const scoreRemoteCandidate = (candidate, want) => {
  const wantTitle = normalizeTrackTitle(want?.track);
  const wantArtist = normalizeArtist(want?.artist);
  const wantSec = Number(want?.durationSec);

  const title = normalizeTrackTitle(candidate?.title);
  const artist = normalizeArtist(candidate?.artist);
  const sec = Number(candidate?.durationSec);

  if (!title) return -1;

  let score = 0;
  if (wantTitle) {
    if (title === wantTitle) score += 4;
    else if (title.includes(wantTitle) || wantTitle.includes(title)) score += 2;
    else return -1;
  }

  if (wantArtist && artist) {
    if (artist === wantArtist) score += 3;
    else if (artist.includes(wantArtist) || wantArtist.includes(artist)) score += 2;
  }

  if (Number.isFinite(wantSec) && wantSec > 0 && Number.isFinite(sec) && sec > 0) {
    const diff = Math.abs(sec - wantSec);
    if (diff <= 3) score += 4;
    else if (diff <= 8) score += 1;
    else score -= 3;
  }
  return score;
};

export const pickRemoteCandidate = (candidates, want) => {
  let best = null;
  let bestScore = 3; // MIN_MATCH_SCORE(4) - 1
  for (const candidate of (Array.isArray(candidates) ? candidates : [])) {
    const score = scoreRemoteCandidate(candidate, want);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

// ── 通信 ─────────────────────────────────────────────────────
const fetchCache = new Map();
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_MAX = 128;

const trimCache = () => {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (now - entry.at >= FETCH_TTL_MS) fetchCache.delete(key);
  }
  while (fetchCache.size > FETCH_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest === undefined) break;
    fetchCache.delete(oldest);
  }
};

const getJson = async (url) => {
  const key = url;
  const cached = fetchCache.get(key);
  if (cached && Date.now() - cached.at < FETCH_TTL_MS) return cached.value;
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  // 404 は「登録が無い」。異常ではないので黙って null。
  if (!res.ok) return null;
  const json = await res.json();
  fetchCache.set(key, { at: Date.now(), value: json });
  trimCache();
  return json;
};

// videoId から歌詞を取る。戻り値は { lines, dynamicLines, hasTimestamp, meta }
export const fetchLyricsByVideoId = async (videoId) => {
  const id = String(videoId || '').trim();
  if (!id) return null;
  const json = await getJson(`${SIMPMUSIC_ENDPOINT}/${encodeURIComponent(id)}`);
  if (!json) return null;
  const items = Array.isArray(json?.data) ? json.data : [];
  const best = pickBestSimpMusicEntry(items);
  const converted = convertSimpMusicEntry(best);
  if (!converted) return null;
  return {
    ...converted,
    meta: {
      title: String(best?.songTitle || '').trim(),
      artist: String(best?.artistName || '').trim(),
      videoId: id,
    },
  };
};

// 曲名で検索して videoId 候補を返す
export const searchSimpMusic = async (query) => {
  const q = String(query || '').trim();
  if (!q) return [];
  const json = await getJson(`${SIMPMUSIC_ENDPOINT}/search?q=${encodeURIComponent(q)}`);
  const items = Array.isArray(json?.data) ? json.data : [];
  return items
    .filter((item) => item && item.videoId)
    .map((item) => ({
      videoId: String(item.videoId),
      title: String(item.songTitle || '').trim(),
      artist: String(item.artistName || '').trim(),
      durationSec: toFiniteMs(item.durationSeconds) === null ? null : Number(item.durationSeconds),
    }));
};

// MP3 など「videoId を知らない曲」の歌詞を、曲名(+アーティスト+長さ)で引く。
// 検索で最も似ている候補の videoId を選んでから歌詞を取る。
export const resolveVideoIdForTrack = async ({ track, artist, durationSec }) => {
  const title = String(track || '').trim();
  if (!title) return null;
  const candidates = await searchSimpMusic(artist ? `${track} ${artist}` : track);
  const hit = pickRemoteCandidate(candidates, { track: title, artist, durationSec });
  return hit || null;
};

// YouTube URL / 共有リンクから videoId を抜く
export const extractYouTubeId = (input) => {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return s;
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*?v=)([\w-]{11})/i,
    /(?:youtu\.be\/)([\w-]{11})/i,
    /(?:youtube\.com\/(?:embed|shorts|v|live)\/)([\w-]{11})/i,
    /(?:music\.youtube\.com\/watch\?[^#]*?v=)([\w-]{11})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
};

// ファイル名から「アーティスト - 曲名」を推測する
export const parseTrackFilename = (name) => {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.{1,80}?)\s*[-–—]\s*(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: '', title: base };
};
