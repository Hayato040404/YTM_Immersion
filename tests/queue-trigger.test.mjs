// キューを開くきっかけの帯。
//
// 右端 20px にマウスを載せると開く作りだった。単一モニタなら画面の端が
// カーソルを止めてくれるので乱暴に右へ振れば必ず当たるが、デュアルモニタで
// 左側にウィンドウを置くと、ウィンドウの右端は画面の端ではないので止まらない。
// 20px を狙って止める必要があり、行き過ぎると隣のモニタへ抜ける。
//
// 帯を広げるだけだと、今度は隣のモニタへ移動する途中や右端のスクロールバーを
// 掴みに行く途中で掠めて開いてしまう。広げるのと短い滞留は対で必要。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const cssSource = read('src/css/style.css')
const queueSource = read('src/js/module/queue-manager.js')

const triggerRule = cssSource.slice(
  cssSource.indexOf('#ytm-queue-trigger {'),
  cssSource.indexOf('}', cssSource.indexOf('#ytm-queue-trigger {')),
)

test('帯が端を頼らずに当たる幅になっている', () => {
  const width = triggerRule.match(/width:\s*(\d+)px/)
  assert.ok(width, '幅の指定が見つからない')
  assert.ok(
    Number(width[1]) >= 40,
    `幅 ${width[1]}px は狭い。画面の端が無い側では狙えない`,
  )
})

test('帯は画面の高さいっぱいのまま', () => {
  assert.match(triggerRule, /height:\s*100vh/)
  assert.match(triggerRule, /right:\s*0/)
})

test('入った瞬間には開かない', () => {
  assert.match(queueSource, /const QUEUE_OPEN_DWELL_MS = \d+;/)
  const ms = Number(queueSource.match(/const QUEUE_OPEN_DWELL_MS = (\d+);/)[1])
  assert.ok(ms >= 100 && ms <= 400, `滞留 ${ms}ms は極端`)
  assert.doesNotMatch(
    queueSource,
    /trigger\.addEventListener\('mouseenter', openPanel\)/,
    '即座に開く形に戻っている',
  )
})

test('滞留の途中で離れたら開かない', () => {
  const block = queueSource.slice(
    queueSource.indexOf("trigger.addEventListener('mouseenter'"),
    queueSource.indexOf("panel.addEventListener('mouseenter'"),
  )
  assert.match(block, /trigger\.matches\(':hover'\)/, '離れたあとに開いてしまう')
})

test('離れたら滞留の予約を取り消す', () => {
  const leave = queueSource.slice(
    queueSource.indexOf("trigger.addEventListener('mouseleave'"),
    queueSource.indexOf("trigger.addEventListener('mouseleave'") + 300,
  )
  assert.match(leave, /cancelDwell\(\)/)
})
