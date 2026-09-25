// 折り返しのまとまり。
//
// 同期ありの行は語ごとの span、行同期の行は lyric-phrase の span に
// 分かれる。まとまりの中では折り返さないので、まとまりの切り方が
// そのまま見た目の改行位置になる。
//
// 閉じ括弧は suffixes にあって前の語に付くが、開き括弧には相棒が無く、
// 単独のまとまりとして行末に取り残されていた。
// 「君を知りたい(」で折り返して次の行が「君を知りたい)」になる。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const start = source.indexOf('const LYRIC_PHRASE_RULES')
const end = source.indexOf('const groupLyricUnitsIntoPhrases')
assert.ok(start !== -1 && end !== -1, '切り出しの目印が変わっていないか確認')
const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(
  `${source.slice(start, end)}\nglobalThis._m = shouldMergeLyricSegments`,
  sandbox,
)
const shouldMerge = sandbox._m

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' })
// 実際の折り返し単位に切る
const phrases = (text) => {
  const words = Array.from(segmenter.segment(text)).map(s => s.segment)
  const out = []
  let buffer = ''
  words.forEach((w, i) => {
    buffer += w
    if (i < words.length - 1 && shouldMerge(w, words[i + 1])) return
    out.push(buffer)
    buffer = ''
  })
  return out
}

test('開き括弧だけのまとまりを作らない', () => {
  for (const text of [
    '君を知りたい(君を知りたい)',
    '夢で見ていた(夢で見ていた)',
    '振り向く時に(振り向く時に)',
  ]) {
    const parts = phrases(text)
    assert.ok(!parts.some(p => /[(（「『[{【]$/.test(p)),
      `開き括弧が行末に残る: ${parts.join(' | ')}`)
  }
})

test('開き括弧は次の語と同じまとまりに入る', () => {
  const parts = phrases('君を知りたい(君を知りたい)')
  const opener = parts.find(p => p.includes('('))
  assert.ok(opener.length > 1, `括弧が単独: ${parts.join(' | ')}`)
  assert.ok(opener.startsWith('('), `括弧が語の途中にある: ${opener}`)
})

test('閉じ括弧はこれまでどおり前の語に付く', () => {
  const parts = phrases('君を知りたい(君を知りたい)')
  assert.ok(!parts.some(p => /^[)）」』\]}】]/.test(p)),
    `閉じ括弧が行頭に落ちる: ${parts.join(' | ')}`)
})

test('英語の括弧でも同じ', () => {
  const parts = phrases('Hello (world) again')
  assert.ok(!parts.some(p => p.trim() === '('), parts.join(' | '))
})

test('括弧の無い行は今までどおり', () => {
  assert.deepEqual(phrases('顔も名前さえもわからない'),
    phrases('顔も名前さえもわからない'))
  const parts = phrases('顔も名前さえもわからない')
  assert.ok(parts.length >= 1)
  assert.equal(parts.join(''), '顔も名前さえもわからない')
})
