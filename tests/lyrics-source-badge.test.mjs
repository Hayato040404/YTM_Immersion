// 左下の取得元バッジ。
//
// 聴いているだけの間は画面に何も足さない。没入が主眼なので常設の表示は
// 置かない。ただし「歌詞がずれている」と気づいた人は必ず何か操作しようと
// してマウスを動かすので、その瞬間に出す(body.ytm-pointer-active)。
// 動画プレイヤーの操作盤と同じ作法。
//
// 出し方はこのひと通りだけで、設定は置かない。かつて「いまの取得元を画面に
// 表示する」という設定があったが、手を動かした時だけ出す方式にした時点で、
// OFF でも出るのに名前は「表示する」のままという嘘になっていた。聴いている
// 間は出ず、触れば出るなら、切りたい理由が無い。選ばせる必要のない物を設定に
// 並べないこと。設定を戻すなら、まず OFF が本当に「出さない」かを決めること。
//
// デバッグ(ytm_debug)で画面に出してはいけない。フラグを立てた人が欲しいのは
// コンソールへの記録であって、消せない常設表示ではない。

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

const start = uiSource.indexOf('function updateLyricsSourceDebugBadge(payload) {')
const end = uiSource.indexOf('function updateLyricsSourceState(payload')
assert.ok(start !== -1 && end !== -1, '切り出しの目印が変わっていないか確認')
const fnSource = uiSource.slice(start, end)

const run = ({ debugEnabled, source = 'lrclib' }) => {
  let present = true
  let logged = 0
  let opened = 0
  const classes = new Set()
  const el = {
    textContent: '',
    title: '',
    classList: {
      toggle(name, on) { on ? classes.add(name) : classes.delete(name) },
      contains(name) { return classes.has(name) },
    },
    setAttribute() {},
    addEventListener() {},
    remove() { present = false },
  }
  const context = {
    config: {},
    YTMLog: { enabled: debugEnabled, log() { logged += 1 } },
    currentLyricsSource: source,
    selectLyricsPayload: () => ({ quality: 2 }),
    createEl: () => el,
    toggleLyricsMenu: () => { opened += 1 },
    LYRICS_SOURCE_LABELS: { lrclib: 'LRCLIB' },
    LYRICS_QUALITY_LABELS: ['', '時刻なし', '行同期'],
    document: { body: {}, getElementById: () => (present ? el : null) },
  }
  vm.runInNewContext(`${fnSource}\nupdateLyricsSourceDebugBadge({});`, context)
  return { present, logged, opened, classes: [...classes], text: el.textContent }
}

test('取得元が分かればバッジを用意する', () => {
  // 置いておくだけ。見えるかどうかは CSS(ytm-pointer-active)が決める
  const r = run({ debugEnabled: false })
  assert.equal(r.present, true)
  assert.match(r.text, /LRCLIB/)
})

test('取得元が分からなければ置かない', () => {
  assert.equal(run({ debugEnabled: false, source: null }).present, false)
})

test('出しっぱなしにする経路を作らない', () => {
  // かつての ytm-source-pinned。設定ごと無くしたので、どこにも残っていないこと
  for (const [name, src] of [['JS', uiSource], ['CSS', cssSource]]) {
    assert.doesNotMatch(src, /ytm-source-pinned/, `${name} に出しっぱなしの経路が残っている`)
  }
  assert.doesNotMatch(uiSource, /showLyricsSource|show-source-toggle/, '設定の残骸がある')
  assert.equal(run({ debugEnabled: true }).classes.includes('ytm-source-pinned'), false)
})

test('デバッグで増えるのはコンソールへの記録だけ', () => {
  assert.equal(run({ debugEnabled: true }).logged, 1)
  assert.equal(run({ debugEnabled: false }).logged, 0)
})

test('押すと歌詞メニューが開く', () => {
  assert.match(fnSource, /el\.addEventListener\('click', open\)/)
  assert.match(fnSource, /toggleLyricsMenu\(\)/)
  assert.match(fnSource, /role', 'button'/, '読み上げから押せることが分からない')
})

// バッジは「⌄」を出しているのだから、押して開いたものは押して閉じられること。
// 外側クリックで閉じる係は capture で先に走るので、バッジの分は除外しないと
// 「閉じる → 即座に開き直す」になって永遠に閉じられない。
const loadToggle = (visibleAtStart) => {
  const src = uiSource.slice(
    uiSource.indexOf('const toggleLyricsMenu'),
    uiSource.indexOf('function updateLyricsSourceDebugBadge'),
  )
  const classes = new Set(visibleAtStart ? ['visible'] : [])
  let opened = 0
  const context = {
    ui: { uploadMenu: { classList: {
      contains: (n) => classes.has(n),
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
    } } },
    openLyricsMenu: () => { opened += 1; classes.add('visible') },
    hideCandidateHoverPreview: () => {},
  }
  vm.runInNewContext(`${src}\ntoggleLyricsMenu();`, context)
  return { visible: classes.has('visible'), opened }
}

test('もう一度押すと歌詞メニューが閉じる', () => {
  assert.equal(loadToggle(false).visible, true, '閉じている時に押しても開かない')
  const second = loadToggle(true)
  assert.equal(second.visible, false, '開いている時に押しても閉じない')
  assert.equal(second.opened, 0, '閉じるはずの押下で開き直している')
})

test('外側クリックで閉じる係はバッジを触らない', () => {
  const closer = uiSource.slice(
    uiSource.indexOf('if (!uploadMenuGlobalSetup)'),
    uiSource.indexOf('function setupDeleteDialog'),
  )
  assert.match(closer, /#ytm-lyrics-source-debug/)
})

test('手を動かした時だけ出す(常設しない)', () => {
  assert.match(cssSource, /#ytm-lyrics-source-debug \{[\s\S]*?opacity: 0;/)
  assert.match(
    cssSource,
    /body\.ytm-pointer-active #ytm-lyrics-source-debug \{[\s\S]*?opacity: 1;/,
  )
})

test('マウスが止まったら引っ込む', () => {
  assert.match(uiSource, /const POINTER_IDLE_HIDE_MS = \d+;/)
  assert.match(uiSource, /document\.body\.classList\.remove\('ytm-pointer-active'\)/)
  // 毎フレーム走るので、重い処理を足さないこと
  const watch = uiSource.slice(
    uiSource.indexOf('const notePointerActivity'),
    uiSource.indexOf('const setupPointerActivityWatch'),
  )
  assert.doesNotMatch(watch, /querySelector|getBoundingClientRect|storage\./)
})

const loadPointerWatch = () => {
  const src = uiSource.slice(
    uiSource.indexOf('const POINTER_IDLE_HIDE_MS'),
    uiSource.indexOf('const setupPointerActivityWatch'),
  )
  const classes = new Set()
  let timer = null
  let armed = 0
  const context = {
    document: { body: { classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
    } } },
    setTimeout: (fn) => { armed += 1; timer = fn; return armed },
    clearTimeout: () => { timer = null },
  }
  vm.runInNewContext(`${src}\nthis.note = notePointerActivity;`, context)
  return {
    move: (x, y) => context.note({ type: 'mousemove', clientX: x, clientY: y }),
    press: () => context.note({ type: 'mousedown', clientX: 0, clientY: 0 }),
    idle: () => { const fn = timer; timer = null; if (fn) fn() },
    visible: () => classes.has('ytm-pointer-active'),
    armed: () => armed,
  }
}

test('手を置いたままなら引っ込む(同じ座標の mousemove は操作ではない)', () => {
  // Chrome は scrollTop が動くと、カーソルの下の物を取り直すために同じ座標の
  // mousemove を投げる。歌詞は行が変わるたび毎フレーム scrollTop を書くので、
  // これを操作と数えるとバッジが曲の間じゅう出たままになる。
  const w = loadPointerWatch()
  w.move(10, 10)
  assert.equal(w.visible(), true)
  assert.equal(w.armed(), 1)
  w.move(10, 10)
  assert.equal(w.armed(), 1, '同じ座標でタイマーを張り直している')
  w.idle()
  assert.equal(w.visible(), false, '手を動かしていないのに引っ込まない')
})

test('本当に動かせば出る', () => {
  const w = loadPointerWatch()
  w.move(10, 10)
  w.move(11, 10)
  assert.equal(w.armed(), 2)
  const p = loadPointerWatch()
  p.press()
  assert.equal(p.visible(), true, '押した時は座標を見ずに出す')
})

// ── ズレ直し ────────────────────────────────────────────
// 歌詞のズレは、気づくのが歌詞を見ている時なのに、直すつまみは設定パネルの
// 奥にあった。「取得元を替える」と「ズレを直す」は同じ問題への2つの答えなので
// 同じ場所に置く。

test('ズレ直しが歌詞メニューの中にある', () => {
  assert.match(uiSource, /data-action="offset-minus"/)
  assert.match(uiSource, /data-action="offset-plus"/)
  assert.match(uiSource, /data-action="offset-reset"/)
  assert.match(uiSource, /data-role="offset-value"/)
})

test('押してもメニューが閉じない', () => {
  // 合うまで何度も押すものなので、1回で閉じると使えない
  const handler = uiSource.slice(
    uiSource.indexOf("ui.uploadMenu.addEventListener('click'"),
    uiSource.indexOf("const target = ev.target.closest('.ytm-upload-menu-item')"),
  )
  assert.match(handler, /ev\.stopPropagation\(\)/)
  assert.match(handler, /return;/)
  assert.doesNotMatch(handler, /toggleMenu\(false\)/, '押すたびに閉じている')
})

test('既存の syncOffset をそのまま使う', () => {
  // 値の置き場を増やさない。設定パネルの数値と食い違わせない
  assert.match(uiSource, /config\.syncOffset = clamped;/)
  assert.match(uiSource, /storage\.set\('ytm_sync_offset', clamped\)/)
  assert.match(uiSource, /getElementById\('sync-offset-input'\)/)
})

test('極端な値で止める', () => {
  assert.match(uiSource, /const LYRIC_OFFSET_MAX_MS = \d+;/)
  assert.match(uiSource, /Math\.max\(-LYRIC_OFFSET_MAX_MS, Math\.min\(LYRIC_OFFSET_MAX_MS/)
})

test('表示の見た目が CSS にある', () => {
  assert.match(cssSource, /\.ytm-offset-btn\s*\{/)
  assert.match(cssSource, /\.ytm-offset-value\s*\{/)
})
