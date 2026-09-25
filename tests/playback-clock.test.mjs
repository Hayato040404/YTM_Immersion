import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const lyricsUiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing marker: ${endMarker}`)
  return source.slice(start, end)
}

const clockSource = sourceBetween(
  lyricsUiSource,
  '// ── 再生位置の補間',
  'let _hasDynamicRenderRanges',
)

function loadClock() {
  const state = { now: 0 }
  const context = {
    performance: { now: () => state.now },
    Date: { now: () => state.now },
  }
  vm.runInNewContext(
    `${clockSource}\nthis.read = readSmoothPlaybackTime; this.reset = resetPlaybackClock;`,
    context,
  )
  return { ...context, state }
}

// video.currentTime は音声バッファ単位でしか進まない。実測に近い形として
// 「rAF は 16.7ms ごと、currentTime は stepMs ごとにしか動かない」を再現する。
function runPlayback({ read, state }, { frames, frameMs = 16.7, stepMs = 60 }) {
  const video = { currentTime: 0, playbackRate: 1 }
  const out = []
  for (let i = 0; i < frames; i += 1) {
    state.now = i * frameMs
    video.currentTime = Math.floor(state.now / stepMs) * stepMs / 1000
    out.push(read(video))
  }
  return out
}

const deltas = series => series.slice(1).map((v, i) => v - series[i])

test('a coarse currentTime alone advances in visible steps', () => {
  // 前提の確認。補間しないと、同じ値が数フレーム続いて一段飛ぶ。
  const raw = []
  for (let i = 0; i < 60; i += 1) {
    raw.push(Math.floor((i * 16.7) / 60) * 60 / 1000)
  }
  const d = deltas(raw)
  const stalled = d.filter(v => v === 0).length
  assert.ok(stalled > d.length / 2, 'raw currentTime should stall on most frames')
  assert.ok(Math.max(...d) >= 0.059, 'raw currentTime should jump a whole step')
})

test('the interpolated clock advances on every frame instead of stalling', () => {
  const clock = loadClock()
  const series = runPlayback(clock, { frames: 120 })
  const d = deltas(series)

  assert.equal(d.filter(v => v === 0).length, 0, 'no frame may stall')
  // 1フレームぶんの進み方が揃っていること(階段状でない)
  // 1フレーム 16.7ms に対して、実際の進み方がその近くに収まっていること
  const maxStep = Math.max(...d)
  const minStep = Math.min(...d)
  assert.ok(maxStep < 0.019, `largest frame step was ${maxStep}s`)
  assert.ok(minStep > 0.014, `smallest frame step was ${minStep}s`)
})

test('the interpolated clock never runs backwards', () => {
  const clock = loadClock()
  const series = runPlayback(clock, { frames: 200, stepMs: 100 })
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i] >= series[i - 1], `went backwards at frame ${i}`)
  }
})

test('a coarser currentTime is still smoothed out', () => {
  // 更新間隔が 100ms まで粗くなっても段差が出ないこと
  const clock = loadClock()
  const d = deltas(runPlayback(clock, { frames: 200, stepMs: 100 }))
  assert.ok(Math.max(...d) < 0.021, `largest frame step was ${Math.max(...d)}s`)
})

test('the interpolated clock stays close to the real playback position', () => {
  const clock = loadClock()
  const { read, state } = clock
  const video = { currentTime: 0, playbackRate: 1 }
  let worst = 0
  for (let i = 0; i < 600; i += 1) {
    state.now = i * 16.7
    const trueTime = state.now / 1000
    video.currentTime = Math.floor(state.now / 60) * 60 / 1000
    const drift = Math.abs(read(video) - trueTime)
    if (drift > worst) worst = drift
  }
  // 実測値そのものは最大 60ms 遅れる。補間はそれより悪化させない。
  assert.ok(worst <= 0.07, `worst drift was ${worst}s`)
})

test('a seek resets the clock instead of sticking at the old position', () => {
  const clock = loadClock()
  const { read, state } = clock
  const video = { currentTime: 0, playbackRate: 1 }

  for (let i = 0; i < 60; i += 1) {
    state.now = i * 16.7
    video.currentTime = Math.floor(state.now / 60) * 60 / 1000
    read(video)
  }

  // 後方シーク
  state.now += 16.7
  video.currentTime = 5
  assert.ok(Math.abs(read(video) - 5) < 0.01, 'must follow a backward seek')

  // 前方シーク
  state.now += 16.7
  video.currentTime = 120
  assert.ok(Math.abs(read(video) - 120) < 0.01, 'must follow a forward seek')
})

test('a stalled currentTime does not let the clock run away', () => {
  const clock = loadClock()
  const { read, state } = clock
  const video = { currentTime: 30, playbackRate: 1 }

  read(video)
  // バッファ切れ等で currentTime が5秒間まったく動かない
  state.now += 5000
  const t = read(video)
  assert.ok(t - 30 <= 0.3, `clock ran away to ${t}`)
})

test('the clock follows a changed playback rate', () => {
  const clock = loadClock()
  const { read, state } = clock
  const video = { currentTime: 10, playbackRate: 2 }

  read(video)
  for (let i = 0; i < 40; i += 1) {
    state.now += 16.7
    video.currentTime = 10 + (state.now / 1000) * 2
    read(video)
  }
  // 2倍速では実時間の2倍のスピードで進む
  const expected = 10 + (state.now / 1000) * 2
  assert.ok(Math.abs(read(video) - expected) < 0.05, 'must track a doubled rate')
})

test('restarting the raf loop resets the clock', () => {
  assert.match(lyricsUiSource, /resetPlaybackClock\(\);/)
  assert.match(lyricsUiSource, /let t = readSmoothPlaybackTime\(v\);/)
})
