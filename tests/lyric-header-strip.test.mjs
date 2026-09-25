// 歌詞の先頭に紛れ込む見出し行の除去。
//
// 取得元によっては1行目が曲そのものではない:
//   - QQ音楽由来の同期データ … 「制作人：〜」などのクレジット行
//   - SimpMusic の richsync  … 「曲名 - アーティスト (…)」の見出し行
// どちらもタイムスタンプ付きなので、そのまま出すとイントロの間ずっと
// 曲名がハイライトされ続ける。
//
// 誤って歌詞を消す方が害が大きいので、ここでは「消えるべきものが消える」
// より「消えてはいけないものが残る」側を厚く固めてある。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const start = source.indexOf('const parseLRCInternal')
const end = source.indexOf('const MAX_SINGER_NUMBER')
assert.ok(start !== -1 && end !== -1, '切り出しの目印が変わっていないか確認')

const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(
  `${source.slice(start, end)}
   globalThis._x = { parseLRCInternal, stripLeadingHeaderLines, isLyricCreditLine }`,
  sandbox,
)
const { parseLRCInternal, stripLeadingHeaderLines, isLyricCreditLine } = sandbox._x

const strip = (lrc, title) => stripLeadingHeaderLines(parseLRCInternal(lrc).lines, title)

// 3.2秒間隔で普通に歌が続く行を作る
const body = (count = 12, startSec = 20) => Array.from({ length: count }, (_, i) => {
  const t = startSec + i * 3.2
  const mm = String(Math.floor(t / 60)).padStart(2, '0')
  const ss = (t % 60).toFixed(2).padStart(5, '0')
  return `[${mm}:${ss}] line ${i}`
}).join('\n')

// ── クレジット行 ──────────────────────────────────────────

test('先頭のクレジット行を落とす', () => {
  const kept = strip(`[00:00.00] 制作人：Someone\n${body()}`, 'Song')
  assert.equal(kept.length, 12)
  assert.equal(kept[0].text, 'line 0')
})

test('連続する複数のクレジット行をまとめて落とす', () => {
  const kept = strip(
    `[00:00.00] 作詞：A\n[00:00.10] 作曲：B\n[00:00.20] 編曲：C\n${body()}`,
    'Song',
  )
  assert.equal(kept.length, 12)
  assert.equal(kept[0].text, 'line 0')
})

test('「作詞作曲」のような連結ラベルにも当たる', () => {
  assert.equal(isLyricCreditLine('作詞作曲：A'), true)
  assert.equal(isLyricCreditLine('Produced by: A'), true)
  assert.equal(isLyricCreditLine('ＬＹＲＩＣＳ：A'), true)
})

test('曲中のクレジット風の行は落とさない', () => {
  const lrc = `${body(6)}\n[01:00.00] 作詞：A\n${body(6, 70)}`
  const kept = strip(lrc, 'Song')
  assert.equal(kept.length, 13, '先頭で打ち切るので曲中の行は残る')
})

test('コロンがあるだけの歌詞行はクレジット行ではない', () => {
  assert.equal(isLyricCreditLine('ねえ：どうして'), false)
  assert.equal(isLyricCreditLine('I said: hello'), false)
  assert.equal(isLyricCreditLine('普通の歌詞'), false)
})

// ── 曲名の見出し行 ────────────────────────────────────────

test('曲の頭にあり、次の歌詞まで大きく空いた曲名行を落とす', () => {
  // 0.62秒に見出し、歌い出しは22.27秒 (実データと同じ形)
  const kept = strip(`[00:00.62] Chocolate - Artist (Album)\n${body(12, 22.27)}`, 'Chocolate')
  assert.equal(kept.length, 12)
  assert.equal(kept[0].text, 'line 0')
})

test('曲名がそのまま歌い出しの曲は落とさない', () => {
  // 間隔が普通なので見出しではない
  const kept = strip(`[00:20.00] Chocolate\n${body(12, 23.2)}`, 'Chocolate')
  assert.equal(kept.length, 13)
  assert.equal(kept[0].text, 'Chocolate')
})

test('大きく空いていても、曲の頭に無い曲名行は落とさない', () => {
  // 30秒に置かれた曲名。長い間奏明けの歌い出しかもしれない
  const kept = strip(`[00:30.00] Chocolate\n${body(12, 60)}`, 'Chocolate')
  assert.equal(kept.length, 13)
})

test('曲の頭にあっても、次の歌詞がすぐ来るなら落とさない', () => {
  const kept = strip(`[00:00.62] Chocolate\n${body(12, 4)}`, 'Chocolate')
  assert.equal(kept.length, 13)
})

test('曲名を含まない行は見出しとして落とさない', () => {
  const kept = strip(`[00:00.62] Something else\n${body(12, 22.27)}`, 'Chocolate')
  assert.equal(kept.length, 13)
})

test('曲名が分からない時は見出し判定をしない', () => {
  const kept = strip(`[00:00.62] Chocolate - Artist\n${body(12, 22.27)}`, '')
  assert.equal(kept.length, 13)
})

// ── 退行防止 ──────────────────────────────────────────────

test('きれいな歌詞は1行も削らない', () => {
  const lrc = body(20, 1.93)
  assert.equal(strip(lrc, 'Song').length, 20)
})

test('1行目が0秒ちょうどでも、本物の歌詞なら残す', () => {
  // LRCHub には歌い出しが 00:00.00 のレコードが実在する
  const kept = strip(`[00:00.00] line a\n${body(12, 3.06)}`, 'Song')
  assert.equal(kept.length, 13)
})

test('行数が少なすぎるデータには触らない', () => {
  const lrc = '[00:00.00] 制作人：A\n[00:20.00] line'
  assert.equal(strip(lrc, 'Song').length, 2)
})

test('全部がクレジット行でも空にはしない', () => {
  const lrc = '[00:00.00] 作詞：A\n[00:00.10] 作曲：B\n[00:00.20] 編曲：C'
  assert.ok(strip(lrc, 'Song').length > 0)
})
