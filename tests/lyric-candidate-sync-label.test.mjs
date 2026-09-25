// 候補メニューに同期の粒度を出す。
//
// どれを選べば単語単位で光るのかが、選ぶ前に分からなかった。
// 表示設定(useAnimatedCaptions)には依らせない。見せたいのは
// 「この候補が何を持っているか」であって「今どう表示されるか」ではない。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const uiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const cssSource = fs.readFileSync(
  new URL('../src/css/style.css', import.meta.url),
  'utf8',
)

const start = uiSource.indexOf('const hasCharacterSyncedLines = (value) => (')
const end = uiSource.indexOf('const buildCandidateLabel')
assert.ok(start !== -1 && end !== -1, '切り出しの目印が変わっていないか確認')
const sandbox = { console }
vm.createContext(sandbox)
vm.runInContext(
  `${uiSource.slice(start, end)}\nglobalThis._d = describeCandidateSync`,
  sandbox,
)
const describe = sandbox._d

test('srv3 を持つ候補は字幕同期', () => {
  assert.equal(describe({ animated_lyrics: '<timedtext/>', lyrics: '[00:01.00]あ' }), '字幕同期')
})

test('文字ごとの時刻を持つ候補は単語同期', () => {
  assert.equal(
    describe({ dynamicLines: [{ chars: [{ c: 'あ', t: 100 }] }], lyrics: '[00:01.00]あ' }),
    '単語同期',
  )
})

test('行の時刻だけなら行同期', () => {
  assert.equal(describe({ lyrics: '[00:01.00]あ\n[00:02.00]い' }), '行同期')
})

test('時刻が無ければ時刻なし', () => {
  assert.equal(describe({ lyrics: 'あ\nい' }), '時刻なし')
})

test('粒度の高い方を優先して出す', () => {
  // 同じ候補が複数持っている時、実際に使われる上位を見せる
  const both = {
    animated_lyrics: '<timedtext/>',
    dynamicLines: [{ chars: [{ c: 'あ', t: 100 }] }],
    lyrics: '[00:01.00]あ',
  }
  assert.equal(describe(both), '字幕同期')
})

test('中身をまだ読み込んでいない候補は決めつけない', () => {
  assert.equal(describe({ lyricsComplete: false, record_id: 'r1' }), null)
  assert.equal(describe({ lyricsComplete: false, has_synced: true }), '行同期以上')
})

test('壊れた入力で落ちない', () => {
  for (const v of [null, undefined, 'あ', 42, {}]) {
    assert.doesNotThrow(() => describe(v))
  }
  assert.equal(describe({}), null)
})

test('ボタンに粒度が付く', () => {
  assert.match(uiSource, /const syncLabel = describeCandidateSync\(cand\)/)
  assert.match(uiSource, /tag\.className = 'ytm-candidate-sync'/)
})

test('粒度の見た目が CSS にある', () => {
  assert.match(cssSource, /\.ytm-candidate-sync\s*\{/)
})

test('品質ラベルの並びが quality の段と合っている', () => {
  // 統合時に上流が 3(単語同期) と 4(srv3) を入れ替えた。
  // 片方だけ直すと左下のバッジが嘘をつく。
  const labels = uiSource.match(/const LYRICS_QUALITY_LABELS = \[([^\]]+)\]/)
  assert.ok(labels, 'ラベル定義が見つからない')
  assert.match(labels[1], /'行同期',\s*'単語同期',\s*'字幕同期'/)

  const quality = uiSource.slice(
    uiSource.indexOf('const quality = useAnimated'),
    uiSource.indexOf('return {', uiSource.indexOf('const quality = useAnimated')),
  )
  assert.match(quality, /useAnimated\s*\n?\s*\?\s*4/, 'srv3 が 4 でなくなっている')
  assert.match(quality, /nextDynamicLines\s*\n?\s*\?\s*3/, '単語同期が 3 でなくなっている')
})
