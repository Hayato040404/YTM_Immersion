// 別の曲のデータを弾く。
//
// 取得元によっては、videoId に紐づいたレコードの中身が別の曲のことがある。
// 実測: 夢灯籠(S6kjwLlKXnk / 131秒)のレコードに「夏のせい」の歌詞が入って
// いた。songTitle も artistName も正しく「夢灯籠 / RADWIMPS」なので、
// メタデータの突き合わせでは気づけない。
//
// 唯一の手がかりが時刻。歌詞が 317 秒まで続いていて、曲の 2.4 倍あった。
//
// 正しいデータを巻き込まないことを重視する。版違いで歌詞が曲より
// 数十秒長いことは普通にある(手元の実測で最大 62 秒)。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../src/js/background.js', import.meta.url),
  'utf8',
)
const start = source.indexOf('const LYRICS_OVERSHOOT_RATIO')
const end = source.indexOf('// 取得元をまたいだ候補メニューの表示名')
assert.ok(start !== -1 && end !== -1, '切り出しの目印が変わっていないか確認')
const sandbox = { console, Number, String }
vm.createContext(sandbox)
vm.runInContext(
  `${source.slice(start, end)}
   globalThis._last = lastLyricTimeSec
   globalThis._ok = lyricsBelongToTrack`,
  sandbox,
)
const { _last: lastLyricTimeSec, _ok: belongs } = sandbox

const lrc = (times) => times.map(t => {
  const m = String(Math.floor(t / 60)).padStart(2, '0')
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `[${m}:${s}] ら`
}).join('\n')

test('曲の長さを大きく超える歌詞は弾く', () => {
  // 夢灯籠 131秒 に 夏のせい 317秒 の歌詞
  assert.equal(belongs(lrc([0, 100, 200, 317.7]), 131), false)
})

test('版違いで少し長いだけの歌詞は通す', () => {
  // Pretender: 曲 229秒 に対して歌詞が 291秒まで
  assert.equal(belongs(lrc([0, 120, 291.1]), 229), true)
})

test('曲より短い歌詞は当然通す', () => {
  assert.equal(belongs(lrc([0, 120, 266.7]), 282), true)
  assert.equal(belongs(lrc([0, 90, 175.5]), 200), true)
})

test('曲の長さが分からない時は弾かない', () => {
  // 弾く方に倒すと、長さが取れない場面で歌詞が出なくなる
  for (const d of [null, undefined, 0, -1, NaN, 'abc']) {
    assert.equal(belongs(lrc([0, 100, 999]), d), true, `長さ ${d} で弾いている`)
  }
})

test('時刻を持たない歌詞は対象外', () => {
  assert.equal(belongs('あいうえお\nかきくけこ', 131), true)
  assert.equal(lastLyricTimeSec('あいうえお'), null)
})

test('最後の時刻を拾う(行の並びが前後していても)', () => {
  assert.equal(lastLyricTimeSec('[01:00.00] あ\n[00:10.00] い'), 60)
})

test('時:分:秒 の形も読む', () => {
  assert.equal(lastLyricTimeSec('[01:02:03.00] あ'), 3723)
})

test('空の入力で落ちない', () => {
  assert.equal(lastLyricTimeSec(''), null)
  assert.equal(lastLyricTimeSec(null), null)
  assert.equal(belongs('', 200), true)
})
