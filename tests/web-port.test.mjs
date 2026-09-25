// ── Web 版 (web/) のテスト ────────────────────────────────────
// 拡張機能から移植した核心部が、同じ性質を持っているかを見る。
// Node 標準の node:test で動く。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SIMP = await import('../web/js/simpmusic.js');
const ENGINE = await import('../web/js/lyrics-engine.js');

// ── LRC パーサー ─────────────────────────────────────────────

test('parseLRCInternal は行同期LRCを時刻順に読む', () => {
  const { lines, hasTs } = SIMP.parseLRCInternal('[00:02.00] B\n[00:01.00] A\n[00:03.50] C');
  assert.equal(hasTs, true);
  assert.deepEqual(lines.map((l) => l.time), [1, 2, 3.5]);
  assert.deepEqual(lines.map((l) => l.text), ['A', 'B', 'C']);
});

test('parseLRCInternal は1行に複数のタイムタグがあっても行を起こす', () => {
  const { lines } = SIMP.parseLRCInternal('[00:01.00][00:05.00] サビ');
  assert.deepEqual(lines.map((l) => l.time), [1, 5]);
  assert.deepEqual(lines.map((l) => l.text), ['サビ', 'サビ']);
});

test('parseLRCInternal はタイムスタンプの無いテキストをそのまま保持する', () => {
  const { lines, hasTs } = SIMP.parseLRCInternal('一行目\n二行目');
  assert.equal(hasTs, false);
  assert.deepEqual(lines.map((l) => l.text), ['一行目', '二行目']);
});

test('parseLRCInternal は語タグ <00:01.00> を表示文字列から落とす', () => {
  const { lines } = SIMP.parseLRCInternal('[00:01.00]<00:01.00>ハ<00:01.50>ロ');
  assert.equal(lines[0].text, 'ハロ');
});

// ── 拡張LRC (richSync) パーサー ─────────────────────────────

test('parseDynamicLrc は語タグを文字時刻に展開する', () => {
  const dyn = SIMP.parseDynamicLrc(
    '[00:01.00] <00:01.00>He<00:01.20>llo <00:01.60>world\n[00:03.00] <00:03.00>next',
  );
  assert.equal(dyn.length, 2);
  assert.equal(dyn[0].startTimeMs, 1000);
  assert.equal(dyn[0].text, 'Hello world');
  const times = dyn[0].chars.map((c) => c.t);
  assert.equal(times[0], 1000);
  assert.ok(times[1] >= times[0]);
});

test('parseDynamicLrc は行末を次の行まで引き延ばさない(間奏補正)', () => {
  // 1行目の末尾は estimateCharDurationMs ベースの上限で打ち切られる。
  // 次の行が 30 秒後でも、文字時刻は 1 行目の進み方から大きく外れない。
  const dyn = SIMP.parseDynamicLrc(
    '[00:01.00] <00:01.00>a<00:01.10>b<00:01.20>c\n[00:30.00] <00:30.00>d',
  );
  const last = dyn[0].chars[dyn[0].chars.length - 1];
  assert.ok(last.t < 5000, `末尾の時刻が異常に遅い: ${last.t}`);
});

// ── SimpMusic 変換 ───────────────────────────────────────────

test('pickBestSimpMusicEntry は richSync を最も良く評価する', () => {
  const best = SIMP.pickBestSimpMusicEntry([
    { plainLyric: 'plain', vote: 9 },
    { syncedLyrics: '[00:01.00] synced', vote: 5 },
    { richSyncLyrics: '[00:01.00] <00:01.00>rich', vote: -9 },
  ]);
  assert.equal(best.richSyncLyrics.includes('rich'), true);
});

test('convertSimpMusicEntry は richSync を行+文字データにする', () => {
  const converted = SIMP.convertSimpMusicEntry({
    richSyncLyrics: '[00:01.00] <00:01.00>ハ<00:01.30>ロ\n[00:05.00] <00:05.00>ワ',
  });
  assert.equal(converted.hasTimestamp, true);
  assert.equal(converted.lines.length, 2);
  assert.equal(converted.lines[0].time, 1);
  assert.equal(converted.dynamicLines.length, 2);
  assert.equal(converted.lines[0].text, 'ハロ');
});

test('convertSimpMusicEntry は synced → plain の順に落ちる', () => {
  const synced = SIMP.convertSimpMusicEntry({ syncedLyrics: '[00:01.00] synced' });
  assert.equal(synced.lines[0].text, 'synced');
  assert.equal(synced.dynamicLines, null);

  const plain = SIMP.convertSimpMusicEntry({ plainLyric: 'plain' });
  assert.equal(plain.lines[0].text, 'plain');
  assert.equal(plain.hasTimestamp, false);

  assert.equal(SIMP.convertSimpMusicEntry(null), null);
  assert.equal(SIMP.convertSimpMusicEntry({ plainLyric: '  ' }), null);
});

// ── 曲候補の点数付け (extra-providers.js と同じ) ────────────

test('scoreRemoteCandidate は曲名が一致しない候補を論外にする', () => {
  assert.equal(SIMP.scoreRemoteCandidate({ title: '全然違う曲' }, { track: '群青' }), -1);
  assert.ok(SIMP.scoreRemoteCandidate({ title: '群青' }, { track: '群青' }) > 0);
});

test('pickRemoteCandidate は長さが近い候補を優先する', () => {
  const hit = SIMP.pickRemoteCandidate(
    [
      { title: '群青', artist: 'YOASOBI', durationSec: 220 },
      { title: '群青', artist: 'YOASOBI', durationSec: 201 },
    ],
    { track: '群青', artist: 'YOASOBI', durationSec: 200 },
  );
  assert.equal(hit.durationSec, 201);
});

// ── YouTube URL / ファイル名 ────────────────────────────────

test('extractYouTubeId は代表的な URL 形式を全部読む', () => {
  assert.equal(SIMP.extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(SIMP.extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=1'), 'dQw4w9WgXcQ');
  assert.equal(SIMP.extractYouTubeId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x'), 'dQw4w9WgXcQ');
  assert.equal(SIMP.extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(SIMP.extractYouTubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(SIMP.extractYouTubeId('https://example.com/nothing'), null);
  assert.equal(SIMP.extractYouTubeId(''), null);
});

test('parseTrackFilename は「アーティスト - 曲名」を分ける', () => {
  assert.deepEqual(
    SIMP.parseTrackFilename('YOASOBI - 群青.mp3'),
    { artist: 'YOASOBI', title: '群青' },
  );
  assert.deepEqual(
    SIMP.parseTrackFilename('群青.mp3'),
    { artist: '', title: '群青' },
  );
});

// ── 語の組み立て (拡張 buildLyricWordUnits と同じ性質) ──────

test('buildLyricWordUnits は英語を語ごとに切る', () => {
  const dyn = SIMP.parseDynamicLrc(
    '[00:01.00] <00:01.00>He<00:01.20>llo <00:01.60>world',
  );
  const units = ENGINE.buildLyricWordUnits(dyn[0].chars, 2.5);
  const words = units.filter((u) => u.type === 'word');
  assert.deepEqual(words.map((w) => w.text), ['Hello', 'world']);
  // 空白は語に含まれず素のテキストとして挟まれる
  assert.equal(units.some((u) => u.type === 'space'), true);
});

test('buildLyricWordUnits は日本語を語にまとめ、伸ばした音の終わりを持つ', () => {
  const dyn = SIMP.parseDynamicLrc(
    '[00:01.00] <00:01.00>こ<00:01.20>ん<00:01.40>に<00:01.60>ち<00:01.80>は',
  );
  const units = ENGINE.buildLyricWordUnits(dyn[0].chars, 2.5);
  const words = units.filter((u) => u.type === 'word');
  assert.equal(words.length >= 1, true);
  for (const word of words) {
    assert.ok(Number.isFinite(word.start));
    assert.ok(Number.isFinite(word.end));
    assert.ok(word.end > word.start);
  }
});

test('buildLyricWordUnits は前後がCJKの空白を捨てる(書式の空白)', () => {
  // 文字と文字の間すべてに空白が入ったデータ。捨てないと1文字ずつ点く。
  const dyn = SIMP.parseDynamicLrc(
    '[00:01.00] <00:01.00>こ <00:01.20>ん <00:01.40>に <00:01.60>ち <00:01.80>は',
  );
  const units = ENGINE.buildLyricWordUnits(dyn[0].chars, 2.5);
  // 捨てられた空白は space 単位として残らない
  const spaces = units.filter((u) => u.type === 'space');
  assert.equal(spaces.length, 0);
  const joined = units.map((u) => u.text).join('');
  assert.equal(joined.includes('こんにちは'), true);
});

// ── フレーズまとめ ───────────────────────────────────────────

test('groupLyricUnitsIntoPhrases は助詞を前にぶら下げる', () => {
  const units = [
    { type: 'word', text: '君', times: [1], offsets: [0], start: 1, end: 1.5 },
    { type: 'word', text: 'を', times: [1.5], offsets: [0], start: 1.5, end: 2 },
    { type: 'word', text: '知り', times: [2], offsets: [0], start: 2, end: 2.5 },
    { type: 'word', text: 'たい', times: [2.5], offsets: [0], start: 2.5, end: 3 },
  ];
  const phrases = ENGINE.groupLyricUnitsIntoPhrases(units);
  assert.deepEqual(phrases.map((p) => p.map((u) => u.text).join('')), ['君を', '知りたい']);
});

// ── 単調接線・強調カーブ ────────────────────────────────────

test('buildMonotoneTangents は単調なデータに対して非負になる', () => {
  const m = ENGINE.buildMonotoneTangents([0, 1, 2, 3], [0, 10, 12, 40]);
  for (const v of m) assert.ok(v >= 0);
});

test('emphasisScaleAmount は長い音ほど強く、頭打ちになる', () => {
  const short = ENGINE.emphasisScaleAmount(0.2);
  const long = ENGINE.emphasisScaleAmount(3);
  assert.ok(long > short);
  assert.ok(long <= 1.2);
});

test('bellCurve は両端が0で中央が1', () => {
  assert.equal(ENGINE.bellCurve(0), 0);
  assert.equal(ENGINE.bellCurve(1), 0);
  assert.ok(Math.abs(ENGINE.bellCurve(0.5) - 1) < 1e-9);
});

// ── 歌詞の見出し落とし ──────────────────────────────────────

test('stripLeadingHeaderLines は先頭のクレジット行だけを落とす', () => {
  const lines = [
    { time: 0.1, text: '作詞：誰か' },
    { time: 0.2, text: '作曲：誰か' },
    { time: 1, text: '歌い出し' },
    { time: 5, text: '二行目' },
  ];
  const stripped = SIMP.stripLeadingHeaderLines(lines, '曲名');
  assert.equal(stripped[0].text, '歌い出し');
});

test('stripLeadingHeaderLines は曲名そのものの歌い出しを巻き込まない', () => {
  // 曲名が含まれていても、次の行までの空きが普通なら見出し扱いしない
  const lines = [
    { time: 0.5, text: '群青' },
    { time: 2, text: '舞い上がれ' },
  ];
  const stripped = SIMP.stripLeadingHeaderLines(lines, '群青');
  assert.equal(stripped[0].text, '群青');
});

// ── 移植元との一致確認 (CSS/JS の対応) ──────────────────────

test('web の歌詞CSSは拡張のApple同期CSSと同じ骨格を持つ', () => {
  const webCss = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');
  // 塗りのグラデーション式。これが違うと見え方が変わる。
  assert.match(webCss, /calc\(\(var\(--sweep\) - var\(--wx\) - var\(--feather\)\) \* 1px\)/);
  assert.match(webCss, /-webkit-background-clip:\s*text/);
  assert.match(webCss, /--ytm-rest-alpha:\s*0\.26/);
  assert.match(webCss, /@property --sweep/);
  // 誤って background-size を使うと、はみ出した語が透明になって消える
  assert.doesNotMatch(webCss, /background-size:\s*\d+px/);
});

test('web のエンジンはWeb Animationsで文字を動かす(JSでtransformを書かない)', () => {
  const engine = readFileSync(new URL('../web/js/lyrics-engine.js', import.meta.url), 'utf8');
  assert.match(engine, /\.animate\(/);
  // 原点はベースライン寄りに置く(拡張と同じ)。これは CSS の担当。
  // 毎フレームの transform 直書きが戻ってきたらカクカクの再発
  assert.doesNotMatch(engine, /style\.transform\s*=/);
  const webCss = readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');
  assert.match(webCss, /transform-origin:\s*50% 78%/);
});

test('web は SimpMusic のエンドポイントを向いている', () => {
  const simp = readFileSync(new URL('../web/js/simpmusic.js', import.meta.url), 'utf8');
  assert.match(simp, /https:\/\/api-lyrics\.simpmusic\.org\/v1/);
});
