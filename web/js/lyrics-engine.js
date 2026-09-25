// ============================================================
// Apple Music 風の文字同期エンジン (Web 版)
//
// 拡張機能 src/js/module/lyrics-ui.js の核心部をそのまま移植:
//   - 行ぜんたいで1本の「塗りの先端」(--sweep)を流す
//   - 塗りの先端は節目(文字ごとの時刻と横位置)を必ず通しつつ
//     間を3次エルミート(Fritsch-Carlson 単調接線)で結ぶ
//   - 持ち上がり・膨らみは JS で transform を書かず、キーフレームを
//     Web Animations に渡して合成側で小数のまま動かす
//   - 伸ばした音だけが膨らんで光る(強さは音の長さで決める)
//   - 行送りは臨界減衰のばね。目標が変わっても速度を引き継ぐ
//
// CSS 側の変数: --sweep / --feather / --wx / --wg / --wglowa / --wglowr
// 塗り・光の CSS は app.css の同名ブロック(拡張 style.css と同じ)。
// ============================================================

// ── 定数 (lyrics-ui.js と同じ値) ─────────────────────────────
const WORD_FEATHER_EM = 0.3;
const WORD_LIFT_EM = 0.05;
const WORD_LIFT_MIN_SEC = 1.0;
const WORD_EMPHASIS_PREROLL_SEC = 0.4;
const WORD_EMPHASIS_STRETCH = 1.4;
const WORD_DEFAULT_SEC = 0.4;
const WORD_STEP = 512;
const SWEEP_STEP = 32;

const MOTION_FRAME_MS = 40;
const MOTION_MIN_FRAMES = 8;
const MOTION_MAX_FRAMES = 40;
const MOTION_RESYNC_SEC = 0.08;

const SCROLL_STIFFNESS = 120;
const SCROLL_DAMPING = 2 * Math.sqrt(SCROLL_STIFFNESS);
const SCROLL_SETTLE_PX = 0.5;
const SCROLL_SETTLE_VEL = 8;
const SCROLL_HANDOVER_PX = 4;
const SCROLL_USER_RESUME_SEC = 3;

const smoothstep = (x) => (x <= 0 ? 0 : (x >= 1 ? 1 : x * x * (3 - 2 * x)));
export const bellCurve = (x) => (x <= 0 || x >= 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * x));

const emphasisCurve = (durSec, scale) => {
  const x = durSec / scale;
  return x > 1 ? Math.sqrt(x) : Math.pow(x, 1.8);
};
export const emphasisScaleAmount = (durSec) => Math.min(1.2, emphasisCurve(durSec, 1.8) * 0.7);
export const emphasisGlowAmount = (durSec) => Math.min(0.7, emphasisCurve(durSec, 2.4) * 0.45);

const isSpaceGlyph = (c) => c === ' ' || c === ' ' || c === '\t' || c === '　';

// 日本語など空白で区切れない言語は Intl.Segmenter で語にまとめる。
const lyricUnitSegmenter = (() => {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      return new Intl.Segmenter('ja', { granularity: 'word' });
    }
  } catch (e) { /* 使えなければ下の簡易規則に落とす */ }
  return null;
})();

const CJK_GLYPH_RE = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿＀-ﾟ￠-￦가-힯]/;
const CJK_TAIL_RE = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーｰ゛゜々〆、。，．！？!?)）」』】〕》〉”’]/;

// ── dynamicLines の chars → 1文字+開始秒の並び ───────────────
const flattenLyricGlyphs = (chars, lineEndSec) => {
  const flat = [];
  if (!Array.isArray(chars)) return flat;

  const timeAt = (i) => {
    const v = Number(chars[i]?.t);
    return Number.isFinite(v) ? v / 1000 : null;
  };

  for (let i = 0; i < chars.length; i++) {
    const raw = String(chars[i]?.c ?? '');
    if (!raw) continue;
    const start = timeAt(i);

    let next = null;
    for (let j = i + 1; j < chars.length; j++) {
      const t = timeAt(j);
      if (t !== null) { next = t; break; }
    }
    if (next === null) {
      next = Number.isFinite(lineEndSec)
        ? lineEndSec
        : (start === null ? null : start + WORD_DEFAULT_SEC);
    }

    const glyphs = Array.from(raw);
    const step = (start !== null && next !== null && next > start)
      ? (next - start) / glyphs.length
      : 0;
    glyphs.forEach((g, k) => {
      flat.push({ c: g, t: start === null ? null : start + step * k });
    });
  }
  return flat;
};

// ── 文字の並び → 語の単位 (拡張と同じ。空白・Segmenter・CJK処理込み) ──
export const buildLyricWordUnits = (chars, lineEndSec) => {
  const flat = flattenLyricGlyphs(chars, lineEndSec);

  // 前後がどちらも CJK の空白は語の区切りではなく書式。捨てる。
  const isFormattingSpace = new Array(flat.length).fill(false);
  {
    let spaces = 0;
    let betweenCjk = 0;
    for (let i = 0; i < flat.length; i++) {
      if (!isSpaceGlyph(flat[i].c)) continue;
      spaces += 1;
      const prev = flat[i - 1];
      const next = flat[i + 1];
      if (prev && next && CJK_GLYPH_RE.test(prev.c) && CJK_GLYPH_RE.test(next.c)) {
        isFormattingSpace[i] = true;
        betweenCjk += 1;
      }
    }
    if (!spaces || betweenCjk / spaces <= 0.5) isFormattingSpace.fill(false);
  }

  const boundaries = new Set();
  if (flat.length && lyricUnitSegmenter) {
    try {
      let text = '';
      const flatIndexAt = new Map();
      for (let i = 0; i < flat.length; i++) {
        if (isFormattingSpace[i]) continue;
        flatIndexAt.set(text.length, i);
        text += flat[i].c;
      }
      for (const seg of lyricUnitSegmenter.segment(text)) {
        const index = flatIndexAt.get(seg.index);
        if (index !== undefined) boundaries.add(index);
      }
    } catch (e) { /* 落ちたら下の簡易規則へ */ }
  }
  const useSegmenter = boundaries.size > 0;

  const units = [];
  let current = null;
  let currentIsCjk = false;

  flat.forEach((glyph, index) => {
    if (isSpaceGlyph(glyph.c)) {
      if (isFormattingSpace[index]) return;
      const last = units[units.length - 1];
      if (last && last.type === 'space') last.text += glyph.c;
      else units.push({ type: 'space', text: glyph.c });
      current = null;
      return;
    }

    const isTail = CJK_TAIL_RE.test(glyph.c);
    let needsNewUnit;
    if (useSegmenter) {
      needsNewUnit = !current || (!isTail && boundaries.has(index));
    } else {
      const isCjk = CJK_GLYPH_RE.test(glyph.c);
      needsNewUnit = !current || (!isTail && (isCjk || currentIsCjk));
      if (needsNewUnit) currentIsCjk = isCjk;
    }

    if (needsNewUnit) {
      current = { type: 'word', text: '', times: [], offsets: [], endIndex: index };
      units.push(current);
    }
    current.offsets.push(current.text.length);
    current.text += glyph.c;
    current.times.push(glyph.t);
    current.endIndex = index;
  });

  // 各語の終わりは「その語の最後の文字の次に来るもの」の時刻。
  // 捨てた書式空白の時刻は拾わない(塗りが止まる原因になる)。
  for (const unit of units) {
    if (unit.type !== 'word') continue;
    let end = null;
    for (let i = unit.endIndex + 1; i < flat.length; i++) {
      if (isFormattingSpace[i]) continue;
      if (flat[i].t !== null) { end = flat[i].t; break; }
    }
    const start = unit.times.find((t) => t !== null) ?? null;
    if (end === null) end = Number.isFinite(lineEndSec) ? lineEndSec : null;
    unit.start = start;
    unit.end = (end !== null && start !== null && end > start)
      ? end
      : (start === null ? null : start + WORD_DEFAULT_SEC);
  }

  return units;
};

// ── 行の折り返しのまとめ (shouldMergeLyricSegments と同じ規則) ──
const LYRIC_PHRASE_RULES = {
  suffixes: new Set([
    'て', 'に', 'を', 'は', 'が', 'の', 'へ', 'と', 'も', 'で', 'や', 'し', 'から', 'より', 'だけ', 'まで', 'こそ', 'さえ', 'でも', 'など', 'なら', 'くらい', 'ぐらい', 'ばかり',
    'ね', 'よ', 'な', 'さ', 'わ', 'ぞ', 'ぜ', 'かしら', 'かな', 'かも', 'だし', 'もん', 'もの',
    'って', 'けど', 'けれど', 'のに', 'ので', 'ため', 'よう', 'こと', 'わけ', 'ほう', 'ところ', 'とおり',
    'た', 'だ', 'ない', 'たい', 'ます', 'ません', 'う', 'れる', 'られる', 'せる', 'させる', 'ん', 'ず',
    'てた', 'てる', 'ちゃう', 'じゃん', 'なきゃ', 'なくちゃ', 'く', 'き', 'けれ', 'れば',
    'った', 'たら', 'たり',
    'か', 'かい', 'だい', 'いる', 'ある', 'くる', 'いく', 'みる', 'おく', 'しまう', 'ほしい', 'あげる', 'くれる', 'もらう',
    '、', '。', '，', '．', '…', '・', '！', '？', '!', '?', '~', '～', '“', '”', '‘', '’', ')', ']', '}', '」', '』', '】', '）',
  ]),
  isEnglish: (w) => /^[a-zA-Z0-9'\-.,!?:;]+$/.test(w),
  isSpace: (w) => /^\s+$/.test(w),
  isOpenParen: (w) => /^[\(\[\{「『（【]$/.test(w),
  hasKanji: (w) => /[一-鿿]/.test(w),
  isHiragana: (w) => /^[぀-ゟー]+$/.test(w),
  isKatakana: (w) => /^[゠-ヿー]+$/.test(w),
  startsWithSmallKana: (w) => /^[ぁぃぅぇぉっゃゅょゎゕゖ]/.test(w),
};

const shouldMergeLyricSegments = (word, nextWord) => {
  if (!nextWord) return false;
  const r = LYRIC_PHRASE_RULES;
  if (r.isOpenParen(word)) return true;
  if (r.startsWithSmallKana(nextWord)) return true;
  if (r.suffixes.has(nextWord)) return !r.isOpenParen(nextWord);
  if (r.hasKanji(word) && r.isHiragana(nextWord)) return true;
  if (r.isKatakana(word) && r.isKatakana(nextWord)) return true;
  if ((r.isEnglish(word) || r.isSpace(word)) &&
    (r.isEnglish(nextWord) || r.isSpace(nextWord))) return true;
  return false;
};

export const groupLyricUnitsIntoPhrases = (units) => {
  const phrases = [];
  let current = null;
  for (let i = 0; i < units.length; i++) {
    if (!current) {
      current = [];
      phrases.push(current);
    }
    current.push(units[i]);
    const next = units[i + 1];
    if (!next) break;
    if (shouldMergeLyricSegments(units[i].text, next.text)) continue;
    current = null;
  }
  return phrases;
};

// ── 行ぜんたいの「時刻 → 進んだ px」表 (measureLyricLineSweep) ──
export const measureLyricLineSweep = (row) => {
  const doc = row.ownerDocument || document;
  const view = doc.defaultView || window;
  const spans = row._ytmWordSpans;
  if (!Array.isArray(spans) || !spans.length) {
    row._sweepReady = true;
    return;
  }
  if (!row.offsetWidth && !row.offsetHeight) return; // まだレイアウトが無い
  row._sweepReady = true;

  try {
    // 1. 語を表示上の行ごとにまとめ、行の幅を出す
    const rowsByTop = new Map();
    for (const span of spans) {
      const top = span.offsetTop;
      let bucket = rowsByTop.get(top);
      if (!bucket) rowsByTop.set(top, (bucket = { right: 0 }));
      bucket.right = Math.max(bucket.right, span.offsetLeft + span.offsetWidth);
    }
    const tops = Array.from(rowsByTop.keys()).sort((a, b) => a - b);
    let carry = 0;
    for (const top of tops) {
      rowsByTop.get(top).origin = carry;
      carry += rowsByTop.get(top).right;
    }

    // 2. 語の開始位置を CSS 変数として渡し、文字ごとの位置表を作る
    const times = [];
    const xs = [];
    const range = doc.createRange();

    for (const span of spans) {
      const origin = rowsByTop.get(span.offsetTop)?.origin || 0;
      const wordX = origin + span.offsetLeft;
      const width = span.offsetWidth;
      span._wx = wordX;
      span.style.setProperty('--wx', String(wordX));

      const node = span.firstChild;
      const offsets = span._offsets;
      let fractions = null;
      if (node && node.nodeType === 3 && Array.isArray(offsets) && offsets.length > 1) {
        const len = node.data.length;
        const raw = [];
        for (const offset of offsets) {
          range.setStart(node, 0);
          range.setEnd(node, Math.min(offset, len));
          raw.push(range.getBoundingClientRect().width);
        }
        const last = (() => {
          range.setStart(node, 0);
          range.setEnd(node, len);
          return range.getBoundingClientRect().width;
        })();
        if (last > 0) fractions = raw.map((w) => w / last);
      }

      span._times.forEach((t, i) => {
        if (t === null) return;
        const frac = fractions ? (fractions[i] ?? (i / span._times.length)) : (i / span._times.length);
        times.push(t);
        xs.push(wordX + width * frac);
      });

      // 語の終わりも節目として入れる
      if (Number.isFinite(span._end)) {
        times.push(span._end);
        xs.push(wordX + width);
      }
    }

    // 3. 時刻で並べ、単調にする
    const order = times.map((t, i) => i).sort((a, b) => times[a] - times[b] || xs[a] - xs[b]);
    const st = [];
    const sx = [];
    for (const i of order) {
      if (st.length && times[i] <= st[st.length - 1]) {
        sx[sx.length - 1] = Math.max(sx[sx.length - 1], xs[i]);
        continue;
      }
      st.push(times[i]);
      sx.push(Math.max(xs[i], sx.length ? sx[sx.length - 1] : 0));
    }
    row._sweepT = st;
    row._sweepX = sx;
    row._sweepM = buildMonotoneTangents(st, sx);
    row._sweepEnd = carry;
    row._sweepIndex = 0;

    // 4. ぼかし半幅は文字サイズ基準の px
    const fontPx = (view ? parseFloat(view.getComputedStyle(row).fontSize) : NaN) || 32;
    row.style.setProperty('--feather', (WORD_FEATHER_EM * fontPx).toFixed(1));

    // 5. 語ごとの強調の強さ
    for (const span of spans) {
      const dur = (Number.isFinite(span._end) && Number.isFinite(span._start) && span._end > span._start)
        ? span._end - span._start
        : WORD_DEFAULT_SEC;
      const scaleAmount = emphasisScaleAmount(dur);
      const glowAmount = emphasisGlowAmount(dur);
      span._emp = scaleAmount > 0.05 || glowAmount > 0.05;
      span._empStart = span._start - WORD_EMPHASIS_PREROLL_SEC;
      span._empDur = Math.max(WORD_LIFT_MIN_SEC, dur) * WORD_EMPHASIS_STRETCH;
      span._amp = scaleAmount;
      span._glow = span._emp;
      if (span._glow) {
        span.style.setProperty('--wglowa', glowAmount.toFixed(3));
        span.style.setProperty('--wglowr', Math.min(0.3, glowAmount * 0.3).toFixed(3));
      }
    }
  } catch (e) {
    row._sweepT = null;
    row._sweepX = null;
  }
};

// ── 単調接線 (Fritsch-Carlson 重み付き調和平均) ───────────────
export const buildMonotoneTangents = (ts, xs) => {
  const n = ts.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;

  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = ts[i + 1] - ts[i];
    d[i] = h[i] > 0 ? (xs[i + 1] - xs[i]) / h[i] : 0;
  }

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] === 0 || d[i] === 0 || (d[i - 1] < 0) !== (d[i] < 0)) {
      m[i] = 0;
      continue;
    }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return m;
};

// 時刻 → 行の先頭から進んだ px
export const lyricSweepAt = (row, t) => {
  const st = row._sweepT;
  const sx = row._sweepX;
  if (!st || st.length === 0) return 0;
  if (t <= st[0]) return 0;
  if (t >= st[st.length - 1]) return row._sweepEnd || sx[sx.length - 1];

  let i = row._sweepIndex || 0;
  if (i >= st.length - 1) i = st.length - 2;
  if (t < st[i]) i = 0;
  while (i + 1 < st.length - 1 && t >= st[i + 1]) i++;
  row._sweepIndex = i;

  const t0 = st[i];
  const t1 = st[i + 1];
  const x0 = sx[i];
  const x1 = sx[i + 1];
  if (!(t1 > t0)) return x1;

  const h = t1 - t0;
  const u = (t - t0) / h;
  const sm = row._sweepM;
  if (!sm) return x0 + (x1 - x0) * u;

  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * x0
    + (u3 - 2 * u2 + u) * h * sm[i]
    + (-2 * u3 + 3 * u2) * x1
    + (u3 - u2) * h * sm[i + 1];
};

// ── 文字の動き (Web Animations のキーフレーム) ───────────────
const buildLyricWordKeyframes = (span, origin) => {
  const from = span._empStart;
  const dur = span._empDur;
  if (!Number.isFinite(from) || !(dur > 0)) return null;

  const amp = span._amp || 0;
  const count = Math.max(
    MOTION_MIN_FRAMES,
    Math.min(MOTION_MAX_FRAMES, Math.round((dur * 1000) / MOTION_FRAME_MS)),
  );

  const frames = [];
  for (let i = 0; i <= count; i++) {
    const env = bellCurve(i / count);
    frames.push({
      offset: i / count,
      transform: `translateY(${(-WORD_LIFT_EM * env).toFixed(4)}em)`
        + ` scale(${(1 + env * amp * 0.085).toFixed(4)})`,
    });
  }

  return { frames, delay: (from - origin) * 1000, duration: dur * 1000 };
};

// 塗りの先端もキーフレームで渡す。エルミート → ベジェに書き直せるので
// 節目の数だけのキーフレームで滑らかな曲線がブラウザに渡る。
const buildLyricSweepKeyframes = (row) => {
  const ts = row._sweepT;
  const xs = row._sweepX;
  const ms = row._sweepM;
  if (!ts || ts.length < 2) return null;

  const from = ts[0];
  const total = ts[ts.length - 1] - from;
  if (!(total > 0)) return null;

  const frames = [];
  for (let i = 0; i < ts.length; i++) {
    const offset = (ts[i] - from) / total;
    if (frames.length && offset <= frames[frames.length - 1].offset) continue;
    const frame = { offset: Math.min(1, Math.max(0, offset)), '--sweep': xs[i].toFixed(2) };

    if (i < ts.length - 1 && ms) {
      const h = ts[i + 1] - ts[i];
      const dx = xs[i + 1] - xs[i];
      if (h > 0 && dx > 0) {
        const y1 = Math.min(1, Math.max(0, (ms[i] * h) / (3 * dx)));
        const y2 = Math.min(1, Math.max(0, 1 - (ms[i + 1] * h) / (3 * dx)));
        frame.easing = `cubic-bezier(0.3333, ${y1.toFixed(4)}, 0.6667, ${y2.toFixed(4)})`;
      } else {
        frame.easing = 'linear';
      }
    }
    frames.push(frame);
  }

  if (frames.length < 2) return null;
  frames[0].offset = 0;
  frames[frames.length - 1].offset = 1;
  return { frames, from, duration: total * 1000 };
};

const createLyricWordMotion = (row) => {
  row._motionReady = true;
  const spans = row._ytmWordSpans;
  if (!spans || !spans.length) return;
  if (typeof spans[0].animate !== 'function') return;

  const origin = spans.map((sp) => sp._start).find((v) => Number.isFinite(v));
  if (!Number.isFinite(origin)) return;
  row._motionOrigin = origin;

  const animations = [];

  const sweep = buildLyricSweepKeyframes(row);
  if (sweep && typeof row.animate === 'function') {
    try {
      const animation = row.animate(sweep.frames, {
        duration: sweep.duration,
        delay: (sweep.from - origin) * 1000,
        fill: 'both',
        easing: 'linear',
      });
      animation.pause();
      animations.push(animation);
      row._sweepAnimated = true;
    } catch (e) {
      row._sweepAnimated = false;
    }
  }

  for (const span of spans) {
    if (!span._emp || !Number.isFinite(span._start)) continue;
    const built = buildLyricWordKeyframes(span, origin);
    if (!built) continue;
    const { frames, delay, duration } = built;
    try {
      const animation = span.animate(frames, {
        duration,
        delay,
        fill: 'both',
        easing: 'linear',
      });
      animation.pause();
      animations.push(animation);
    } catch (e) { /* 作れなくても塗りは動く */ }
  }
  row._motions = animations;
};

const syncLyricWordMotion = (row, t, rate) => {
  const motions = row._motions;
  if (!motions || !motions.length) return;
  const local = (t - row._motionOrigin) * 1000;
  const now = performance.now();

  if (row._motionSyncedAt !== undefined) {
    const predicted = row._motionSyncedLocal + (now - row._motionSyncedAt) * rate;
    if (Math.abs(predicted - local) <= MOTION_RESYNC_SEC * 1000) return;
  }

  for (const animation of motions) {
    try {
      animation.currentTime = local;
      if (animation.playbackRate !== rate) animation.playbackRate = rate;
      animation.play();
    } catch (e) { /* 破棄済み */ }
  }
  row._motionSyncedLocal = local;
  row._motionSyncedAt = now;
};

const stopLyricWordMotion = (row) => {
  const motions = row._motions;
  if (!motions) return;
  row._motionSyncedAt = undefined;
  for (const animation of motions) {
    try { animation.pause(); animation.currentTime = 0; } catch (e) { /* 破棄済み */ }
  }
};

export const writeLyricVar = (el, key, cacheKey, value, step) => {
  const q = Math.round(value * step) / step;
  if (el[cacheKey] === q) return;
  el[cacheKey] = q;
  el.style.setProperty(key, String(q));
};

// ── 行の DOM を作る ──────────────────────────────────────────
export const buildLyricRow = (doc, { time, text, dynamicLine }) => {
  const row = doc.createElement('div');
  row.className = 'lyric-line';
  if (Number.isFinite(time)) {
    row.dataset.startTime = String(time);
  } else {
    row.classList.add('no-timestamp');
  }

  const mainSpan = doc.createElement('span');
  mainSpan.className = 'lyric-main';

  const hasChars = dynamicLine && Array.isArray(dynamicLine.chars) && dynamicLine.chars.length > 1;
  const lineEndSec = Number.isFinite(dynamicLine?.endTimeMs)
    ? dynamicLine.endTimeMs / 1000
    : null;

  if (hasChars) {
    const wordSpans = [];
    const units = buildLyricWordUnits(dynamicLine.chars, lineEndSec);
    for (const phrase of groupLyricUnitsIntoPhrases(units)) {
      const phraseSpan = doc.createElement('span');
      phraseSpan.className = 'lyric-phrase lyric-phrase-sync';
      for (const unit of phrase) {
        if (unit.type === 'space') {
          phraseSpan.appendChild(doc.createTextNode(unit.text));
          continue;
        }
        if (!unit.text) continue;
        const wordSpan = doc.createElement('span');
        wordSpan.className = 'lyric-word';
        wordSpan.textContent = unit.text;
        wordSpan._times = unit.times;
        wordSpan._offsets = unit.offsets;
        wordSpan._start = unit.start;
        wordSpan._end = unit.end;
        wordSpan._emp = false;
        phraseSpan.appendChild(wordSpan);
        wordSpans.push(wordSpan);
      }
      if (phraseSpan.childNodes.length) mainSpan.appendChild(phraseSpan);
    }
    if (wordSpans.length) {
      row._ytmWordSpans = wordSpans;
      row.classList.add('ytm-word-sync');
    } else {
      mainSpan.textContent = text || '';
    }
  } else {
    mainSpan.textContent = text || '';
  }

  row.appendChild(mainSpan);
  if (!mainSpan.textContent) row.classList.add('empty-line');
  return row;
};

// ── 再描画 + 1曲ぶんの再生 ───────────────────────────────────
export const renderLyricsInto = (container, lines, dynamicLines, options = {}) => {
  const doc = container.ownerDocument || document;
  container.innerHTML = '';
  container.scrollTop = 0;
  container._scrollPos = 0;
  container._scrollVel = 0;
  container._scrollTarget = undefined;
  container._scrollLastWritten = 0;
  container._lastScrolledIndex = -1;
  container._instantNextScroll = true;

  const dyn = Array.isArray(dynamicLines) ? dynamicLines : [];
  // dynamicLines は行の時刻で引く。同時刻の重複は順に消費する。
  const used = new Set();
  const findDyn = (time) => {
    if (!dyn.length || !Number.isFinite(time)) return null;
    let hit = null;
    for (let i = 0; i < dyn.length; i++) {
      if (used.has(i)) continue;
      const startSec = Number(dyn[i]?.startTimeMs);
      if (!Number.isFinite(startSec)) continue;
      if (Math.abs(startSec / 1000 - time) <= 0.15) { hit = i; break; }
    }
    if (hit === null) return null;
    used.add(hit);
    return dyn[hit];
  };

  const rows = [];
  (Array.isArray(lines) ? lines : []).forEach((line) => {
    const row = buildLyricRow(doc, {
      time: line.time,
      text: line.text,
      dynamicLine: findDyn(line.time),
    });
    container.appendChild(row);
    rows.push(row);
  });

  // 計測は offsetLeft を読むので、描画後に少しずつ先に済ませておく
  const pending = rows.filter((r) => r._ytmWordSpans);
  let index = 0;
  const step = () => {
    const end = Math.min(index + 8, pending.length);
    for (; index < end; index++) {
      const row = pending[index];
      if (!row.isConnected) continue;
      if (!row._sweepReady) measureLyricLineSweep(row);
      if (options.onRowReady) options.onRowReady(row);
    }
    if (index < pending.length) requestAnimationFrame(step);
  };
  if (pending.length) requestAnimationFrame(step);

  return rows;
};

// ── ばねスクロール (臨界減衰。目標が変わっても速度を引き継ぐ) ──
const snapLyricScroll = (container) => {
  if (!container || container._scrollTarget === undefined) return;
  container.scrollTop = container._scrollTarget;
  container._scrollPos = container.scrollTop;
  container._scrollLastWritten = container.scrollTop;
  container._scrollVel = 0;
  container._scrollTarget = undefined;
};

export const requestLyricScroll = (container, target, instant) => {
  if (!container) return;
  if (instant) {
    container._scrollTarget = target;
    snapLyricScroll(container);
    return;
  }
  const written = container._scrollLastWritten;
  if (written === undefined || Math.abs(container.scrollTop - written) > SCROLL_HANDOVER_PX) {
    container._scrollPos = container.scrollTop;
    container._scrollVel = 0;
  }
  container._scrollTarget = target;
};

const stepLyricScroll = (container, dt) => {
  if (!container || container._scrollTarget === undefined) return;

  if (container._scrollLastWritten !== undefined &&
    Math.abs(container.scrollTop - container._scrollLastWritten) > SCROLL_HANDOVER_PX) {
    container._scrollTarget = undefined;
    container._scrollVel = 0;
    container._lastScrolledIndex = -1;
    return;
  }

  const target = container._scrollTarget;
  let pos = container._scrollPos ?? container.scrollTop;
  let vel = container._scrollVel || 0;
  const diff = pos - target;

  if (Math.abs(diff) < SCROLL_SETTLE_PX && Math.abs(vel) < SCROLL_SETTLE_VEL) {
    snapLyricScroll(container);
    return;
  }

  vel += (-SCROLL_STIFFNESS * diff - SCROLL_DAMPING * vel) * dt;
  pos += vel * dt;

  container._scrollPos = pos;
  container._scrollVel = vel;
  container.scrollTop = pos;
  container._scrollLastWritten = container.scrollTop;
};

// ── エンジン本体 ─────────────────────────────────────────────
// 一つの歌詞コンテナに対して、ハイライト・塗り・スクロールをまとめて面倒を見る。
export const createLyricsView = (container, { onSeek } = {}) => {
  let rows = [];
  let lastActiveIndex = -2;
  let lastScrollStepAt = 0;
  let userScrollUntil = 0;

  container.addEventListener('scroll', () => {
    if (performance.now() < (container._suppressUserScrollUntil || 0)) return;
    // 自動スクロールが書いたぶんはユーザー操作ではない
    if (container._scrollLastWritten !== undefined &&
      Math.abs(container.scrollTop - container._scrollLastWritten) <= SCROLL_HANDOVER_PX) return;
    userScrollUntil = performance.now() + SCROLL_USER_RESUME_SEC * 1000;
  }, { passive: true });

  container.addEventListener('click', (e) => {
    const target = e.target.closest('.lyric-line');
    if (!target) return;
    const timeStr = target.dataset.startTime;
    if (timeStr && onSeek) {
      const time = parseFloat(timeStr);
      if (!Number.isNaN(time)) onSeek(time);
    }
  });

  const isUserScrolling = () => performance.now() < userScrollUntil;

  const paintActiveRow = (row, t) => {
    const spans = row._ytmWordSpans;
    if (!spans || !spans.length) return;
    if (!row._sweepReady) measureLyricLineSweep(row);
    if (!row._motionReady) createLyricWordMotion(row);
    syncLyricWordMotion(row, t, 1);

    // 塗りもキーフレームで渡してある。渡せなかった時だけ自分で書く。
    if (!row._sweepAnimated) {
      writeLyricVar(row, '--sweep', '_sweep', lyricSweepAt(row, t), SWEEP_STEP);
    }
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (!span._glow || !Number.isFinite(span._start)) continue;
      const env = bellCurve((t - span._empStart) / span._empDur);
      writeLyricVar(span, '--wg', '_wg', env, WORD_STEP);
    }
  };

  const update = (t, force = false) => {
    if (!rows.length) return;

    // いまの行を探す(次の行の開始時刻までがその行の持ち時間)
    let idx = -1;
    for (let i = 0; i < rows.length; i++) {
      const time = Number(rows[i].dataset.startTime);
      if (!Number.isFinite(time)) continue;
      if (time <= t + 0.02) idx = i;
      else break;
    }

    if (idx !== lastActiveIndex || force) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const isActive = i === idx;
        if (r._ytmIsActive !== isActive) {
          r._ytmIsActive = isActive;
          r.classList.toggle('active', isActive);
        }
        const isPast = idx >= 0 && !isActive && i < idx;
        if (r._ytmIsPast !== isPast) {
          r._ytmIsPast = isPast;
          r.classList.toggle('lyric-past', isPast);
        }
        if (!isActive && r._ytmWordSpans && r._ytmWasActive) {
          stopLyricWordMotion(r);
          if (!r._sweepAnimated) writeLyricVar(r, '--sweep', '_sweep', 0, SWEEP_STEP);
          r._sweepIndex = 0;
        }
        r._ytmWasActive = isActive;
      }

      if (idx >= 0 && idx !== container._lastScrolledIndex) {
        if (!isUserScrolling()) {
          const r = rows[idx];
          const containerRect = container.getBoundingClientRect();
          const rRect = r.getBoundingClientRect();
          const anchor = container.clientHeight * 0.38 - rRect.height / 2;
          const targetScroll = container.scrollTop + rRect.top - containerRect.top - anchor;
          const instant = container._instantNextScroll;
          container._instantNextScroll = false;
          container._suppressUserScrollUntil = performance.now() + (instant ? 300 : 220);
          requestLyricScroll(container, targetScroll, instant);
          container._lastScrolledIndex = idx;
        }
      }

      lastActiveIndex = idx;
    }

    // アクティブ行の塗りは毎フレーム
    if (idx >= 0) paintActiveRow(rows[idx], t);
  };

  const pause = () => {
    for (const row of rows) {
      if (!row._motions) continue;
      row._motionSyncedAt = undefined;
      for (const animation of row._motions) {
        try { if (animation.playState === 'running') animation.pause(); } catch (e) { /* 破棄済み */ }
      }
    }
  };

  const stepScroll = (nowMs) => {
    const dt = lastScrollStepAt ? Math.min(0.05, (nowMs - lastScrollStepAt) / 1000) : 0;
    lastScrollStepAt = nowMs;
    if (dt <= 0) return;
    stepLyricScroll(container, dt);
  };

  const invalidateSweeps = () => {
    for (const row of rows) {
      if (!row._ytmWordSpans) continue;
      row._sweepReady = false;
      row._motionReady = false;
      if (row._motions) {
        for (const animation of row._motions) {
          try { animation.cancel(); } catch (e) { /* 破棄済み */ }
        }
        row._motions = null;
      }
    }
    container._lastScrolledIndex = -1;
  };

  const reset = () => {
    for (const row of rows) stopLyricWordMotion(row);
    lastActiveIndex = -2;
    container._lastScrolledIndex = -1;
    container._instantNextScroll = true;
  };

  return {
    update,
    pause,
    stepScroll,
    invalidateSweeps,
    reset,
    get rows() { return rows; },
    setRows(newRows) { rows = newRows; reset(); },
  };
};
