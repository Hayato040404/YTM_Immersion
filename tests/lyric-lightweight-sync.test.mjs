// 軽量モードでも文字同期を動かす。
//
// 以前は軽量モードで文字同期を丸ごと止めていたが、止める根拠が無かった。
//
//   塗り(--sweep)        … Web Animations のキーフレーム = 合成側。毎フレーム 0
//   持ち上がり・膨らみ    … 同上。毎フレーム 0
//   光(--wg→text-shadow) … メインスレッドから毎フレーム書く。実測 1.0〜1.4回/フレーム
//
// 軽量モードが本当に止めたいのは backdrop-filter のぼかしと背景ドリフトで、
// あちらは「ドリフトの毎フレーム、ビューポート全面のブラーを再計算」する。
// 設定の文言も「背景アニメーション停止」であって歌詞の話ではない。
//
// なので軽量モードで落とすのは光だけにする。動きは同じにする。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const uiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const cssSource = fs.readFileSync(
  new URL('../src/css/style.css', import.meta.url),
  'utf8',
)

test('軽量モードでも文字同期を有効にする', () => {
  assert.match(uiSource, /const useWordSync = !!config\.appleSyncStyle;/)
  assert.doesNotMatch(
    uiSource,
    /useWordSync = !!config\.appleSyncStyle && !config\.lowCpuMode/,
    '軽量モードで文字同期ごと止める形に戻っている',
  )
})

test('Apple Music 風の見た目も軽量モードで残す', () => {
  assert.match(
    uiSource,
    /classList\.toggle\('ytm-apple-sync', !!config\.appleSyncStyle\)/,
  )
})

test('光と持ち上がりが別の旗になっている', () => {
  // 兼用のままだと、光を落とすと合成側で動く持ち上がりまで消える
  assert.match(uiSource, /span\._glow = span\._emp &&/)
  assert.match(uiSource, /config\.lowCpuMode\);/)
})

test('毎フレーム書くのは光の旗で判断する', () => {
  const loop = uiSource.slice(
    uiSource.indexOf("writeLyricVar(span, '--wg'") - 400,
    uiSource.indexOf("writeLyricVar(span, '--wg'") + 80,
  )
  assert.match(loop, /if \(!span\._glow/)
  assert.doesNotMatch(loop, /if \(!span\._emp/, '光を持ち上がりの旗で判断している')
})

test('持ち上がりは軽量モードでも動く', () => {
  // 合成側のキーフレームは _emp で判断し続けること
  const motion = uiSource.slice(
    uiSource.indexOf('const createLyricWordMotion'),
    uiSource.indexOf('const syncLyricWordMotion'),
  )
  assert.match(motion, /if \(!span\._emp \|\| !Number\.isFinite\(span\._start\)\) continue;/)
  assert.doesNotMatch(motion, /_glow/, '持ち上がりまで光の旗で止めている')
})

test('軽量モードでは文字の影を宣言ごと消す', () => {
  assert.match(
    cssSource,
    /body\.ytm-lightweight-mode\.ytm-apple-sync[^{]*\.lyric-word\s*\{\s*\n\s*text-shadow: none;/,
  )
})

test('軽量モードが止めるものは背景側に残っている', () => {
  // 本来の目的(ぼかしと背景ドリフト)まで消していないこと
  assert.match(cssSource, /:not\(\.ytm-lightweight-mode\) #ytm-custom-bg \{[\s\S]{0,40}animation: ytmBgDrift/)
  const gated = cssSource.match(/:not\(\.ytm-lightweight-mode\)/g) || []
  assert.ok(gated.length >= 20, `軽量モードの対象が減っている (${gated.length})`)
  assert.match(cssSource, /backdrop-filter/, 'ぼかしの指定ごと消えている')
})
