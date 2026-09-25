// 稀に起きる2つの取りこぼし。
//
// ■ 背景が入れ替わらない
// 曲が変わっても前の画像の読み込みは止まらない(DOM から外しても onload は
// 発火する)。前の画像が遅れて読み終わると、新しい背景を古いもので塗り潰す。
// アートワーク本体は replaceChildren で即座に入れ替わるので、
// 「背景だけ前の曲のまま」に見える。
//
// ■ 自動スクロールが止まる
// スクロールはばねで毎フレーム scrollTop を書く。他の要因で scrollTop が
// 4px 以上動くと(翻訳の到着で行の高さが変わる、リサイズなど)ばねは手を引くが、
// 「その行へスクロール済み」の印は付いたままなので、次の行が来るまで
// 追従が戻らない。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const uiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)

// ── 背景 ──────────────────────────────────────────────

test('古い画像の読み込みは新しい背景を塗り潰さない', () => {
  const fn = uiSource.slice(
    uiSource.indexOf('function updateMetaUI(meta) {'),
    uiSource.indexOf('ui.lyrics.innerHTML', uiSource.indexOf('function updateMetaUI(meta) {')),
  )
  assert.match(fn, /const bgToken = \+\+_bgLoadToken;/)
  assert.match(fn, /if \(bgToken !== _bgLoadToken\) return;/)
  // onload と onerror の両方を塞いでいること
  const guards = fn.match(/if \(bgToken !== _bgLoadToken\) return;/g) || []
  assert.equal(guards.length, 2, `塞ぎ漏れがある (${guards.length}箇所)`)
})

test('世代は曲ごとに進む', () => {
  const sandbox = { console }
  vm.createContext(sandbox)
  vm.runInContext(`
    let _bgLoadToken = 0;
    const next = () => ++_bgLoadToken;
    const stale = (t) => t !== _bgLoadToken;
    globalThis.next = next; globalThis.stale = stale;
  `, sandbox)
  const first = sandbox.next()
  const second = sandbox.next()
  assert.equal(sandbox.stale(first), true, '前の曲の読み込みが通ってしまう')
  assert.equal(sandbox.stale(second), false, '今の曲の読み込みが捨てられている')
})

// ── 自動スクロール ────────────────────────────────────

test('ばねが手を引いたら「スクロール済み」の印を戻す', () => {
  const fn = uiSource.slice(
    uiSource.indexOf('const stepLyricScroll ='),
    uiSource.indexOf('let _lastScrollStepAt'),
  )
  const handover = fn.slice(0, fn.indexOf('const target = container._scrollTarget;'))
  assert.match(handover, /container\._scrollTarget = undefined;/)
  assert.match(
    handover,
    /container\._lastScrolledIndex = -1;/,
    '印を戻さないと次の行まで追従が止まる',
  )
})

test('即時ジャンプの意図を、見送った回に捨てない', () => {
  // 捨てると、動けるようになった時に 0 秒位置からゆっくり流れる
  const block = uiSource.slice(
    uiSource.indexOf("const scrollBehavior = container._instantNextScroll"),
    uiSource.indexOf('ReplayManager.incrementLyricCount()'),
  )
  const bailAt = block.indexOf('if (isUserScrolling) continue;')
  const clearAt = block.indexOf('container._instantNextScroll = false;')
  assert.ok(bailAt !== -1 && clearAt !== -1)
  assert.ok(bailAt < clearAt, '見送る前に意図を捨てている')
})

test('ユーザーが掴んでいる間は出し直さない', () => {
  const block = uiSource.slice(
    uiSource.indexOf("const scrollBehavior = container._instantNextScroll"),
    uiSource.indexOf('ReplayManager.incrementLyricCount()'),
  )
  assert.match(block, /if \(isUserScrolling\) continue;/)
})

// ── 端に当たった時の記録 ──────────────────────────────
//
// 歌詞をクリックすると後方シークになり、「即時ジャンプ」経路を通る。
// 曲頭の行を中央に寄せる行き先は 0 を下回ることがある(上下の余白は 30vh、
// 中央は clientHeight/2 = 32.5vh。行が 5vh より低いと負になる)。
// scrollTop は 0 に丸められるので、丸める前の値を「書いた位置」として
// 覚えると、以後ずっと「誰かが 18px 動かした」と誤判定して追従が死ぬ。

function createScrollHarness() {
  const slice = uiSource.slice(
    uiSource.indexOf('const SCROLL_STIFFNESS = 120;'),
    uiSource.indexOf('const stepLyricScrolls = (nowMs) => {'),
  )
  assert.ok(slice.includes('const stepLyricScroll ='), 'ばねの一式を切り出せていない')

  const context = {
    performance,
    ui: { lyrics: null },
    suppressUserScrollDetection() {},
  }
  vm.runInNewContext(`${slice}
    globalThis.snap = snapLyricScroll;
    globalThis.request = requestLyricScroll;
    globalThis.step = stepLyricScroll;
    globalThis.reset = resetLyricScrollState;
  `, context, { filename: 'lyric-scroll.js' })
  return context
}

function makeContainer(maxScroll) {
  let top = 0
  return {
    get scrollTop() { return top },
    // ブラウザと同じく 0〜最大スクロール量に丸める
    set scrollTop(v) { top = Math.min(Math.max(0, Number(v) || 0), maxScroll) },
  }
}

function settle(h, container, seconds = 2) {
  for (let i = 0; i < seconds * 60; i++) h.step(container, 1 / 60)
}

test('範囲外へ即時ジャンプしても、次の行から追従が続く', () => {
  const h = createScrollHarness()
  const container = makeContainer(2000)

  h.request(container, -18, true) // 曲頭の行をクリック＝後方シーク
  assert.equal(container.scrollTop, 0)
  assert.equal(
    container._scrollLastWritten, 0,
    '丸める前の値を覚えている。次のフレームから追従が死ぬ',
  )

  h.request(container, 300, false)
  settle(h, container)
  assert.ok(
    Math.abs(container.scrollTop - 300) < 1,
    `次の行へ動いていない (scrollTop=${container.scrollTop})`,
  )
})

test('曲末のように下の端を超えた行き先でも、記録は実際の位置に合う', () => {
  const h = createScrollHarness()
  const container = makeContainer(500)

  h.request(container, 900, false) // 最終行の中央寄せは最大量を超えうる
  settle(h, container)
  assert.equal(container.scrollTop, 500)
  assert.equal(container._scrollLastWritten, 500)

  h.request(container, 200, false)
  settle(h, container)
  assert.ok(
    Math.abs(container.scrollTop - 200) < 1,
    `戻れていない (scrollTop=${container.scrollTop})`,
  )
})

test('ばねの外から先頭へ戻す時は記録も一緒に戻す', () => {
  const h = createScrollHarness()
  const container = makeContainer(2000)

  h.request(container, 800, false)
  settle(h, container)
  assert.ok(container.scrollTop > 700)

  h.reset(container) // 曲が変わって再描画
  assert.equal(container.scrollTop, 0)
  assert.equal(container._scrollLastWritten, 0)
  assert.equal(container._scrollTarget, undefined)

  h.request(container, 400, false)
  settle(h, container)
  assert.ok(
    Math.abs(container.scrollTop - 400) < 1,
    `再描画のあと追従していない (scrollTop=${container.scrollTop})`,
  )
})

test('本物のユーザー操作には、これまで通り手を引く', () => {
  const h = createScrollHarness()
  const container = makeContainer(2000)

  h.request(container, 800, false)
  h.step(container, 1 / 60)
  container.scrollTop = container.scrollTop + 120 // ホイールで掴んだ
  h.step(container, 1 / 60)
  assert.equal(container._scrollTarget, undefined, '譲っていない')
  assert.equal(container._lastScrolledIndex, -1, '出し直せる印になっていない')
})

test('先頭へ戻す2箇所は、ばねの後始末を通している', () => {
  const render = uiSource.slice(
    uiSource.indexOf('function renderLyrics(data) {'),
    uiSource.indexOf('_previousActiveIndices.clear();'),
  )
  assert.match(render, /resetLyricScrollState\(ui\.lyrics\)/)
  assert.doesNotMatch(
    uiSource.slice(uiSource.indexOf('const tick = async () => {')),
    /ui\.lyrics\.scrollTop = 0/,
    '記録を残したまま scrollTop を書いている',
  )
})
