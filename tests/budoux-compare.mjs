// 折り返し位置の比較用。テストではなく調査用の使い捨てスクリプト。
//
//   curl -sL -o /tmp/budoux-ja.json \
//     https://raw.githubusercontent.com/google/budoux/main/budoux/models/ja.json
//   node tests/budoux-compare.mjs /tmp/budoux-ja.json
//
// いまの手書き規則 (lyrics-ui.js の shouldMergeLyricSegments) と
// BudouX の文節モデルで、行のどこが折り返し可能になるかを並べて出す。
// 判定の本体はソースから切り出して動かすので、本番と同じ挙動を見ている。

import fs from 'node:fs'
import vm from 'node:vm'

// ── 1. 現行の規則を lyrics-ui.js から切り出す ──────────────────
const lyricsUiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const rulesStart = lyricsUiSource.indexOf('const _jaWordSegmenter')
const rulesEnd = lyricsUiSource.indexOf('const optimizeLineBreaks', rulesStart)
if (rulesStart === -1 || rulesEnd === -1) {
  throw new Error('折り返し規則の切り出しに失敗した。目印の名前が変わっていないか確認')
}
const rulesSource = lyricsUiSource.slice(rulesStart, rulesEnd)

const sandbox = { Intl, console }
vm.createContext(sandbox)
vm.runInContext(`${rulesSource}\nglobalThis._rules = { shouldMergeLyricSegments, _jaWordSegmenter }`, sandbox)
const { shouldMergeLyricSegments, _jaWordSegmenter } = sandbox._rules

// 現行パイプライン: Intl.Segmenter で語に割り、規則で繋ぎ直す。
// 返すのは「折り返し可能な位置」の文字オフセット集合。
const currentBoundaries = (text) => {
  const segments = Array.from(_jaWordSegmenter.segment(text))
  const boundaries = new Set()
  let offset = 0
  for (let i = 0; i < segments.length; i++) {
    offset += segments[i].segment.length
    const next = segments[i + 1]
    if (!next) break
    if (shouldMergeLyricSegments(segments[i].segment, next.segment)) continue
    boundaries.add(offset)
  }
  return boundaries
}

// ── 2. BudouX (parser.ts の parseBoundaries をそのまま写した) ──
const modelPath = process.argv[2] || process.env.BUDOUX_MODEL
if (!modelPath) {
  console.error('モデルの場所を渡してください: node tests/budoux-compare.mjs <ja.json>')
  process.exit(1)
}
const rawModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
const model = new Map(Object.entries(rawModel).map(([k, v]) => [k, new Map(Object.entries(v))]))
const baseScore = -0.5 * [...model.values()]
  .flatMap(group => [...group.values()])
  .reduce((a, b) => a + b, 0)

const FEATURES = [
  ['UW1', -3, -2], ['UW2', -2, -1], ['UW3', -1, 0], ['UW4', 0, 1], ['UW5', 1, 2], ['UW6', 2, 3],
  ['BW1', -2, 0], ['BW2', -1, 1], ['BW3', 0, 2],
  ['TW1', -3, 0], ['TW2', -2, 1], ['TW3', -1, 2], ['TW4', 0, 3],
]

// 位置ごとの素点。0 を超えた所が文節の切れ目。
// 超えなかった点数も、上限を超えた塊を割る時の「次に良い場所」に使う。
const budouxScores = (text) => {
  const scores = new Array(text.length).fill(-Infinity)
  for (let i = 1; i < text.length; i++) {
    let score = baseScore
    for (const [key, from, to] of FEATURES) {
      score += model.get(key)?.get(text.substring(i + from, i + to)) || 0
    }
    scores[i] = score
  }
  return scores
}

const budouxBoundaries = (text) => {
  const scores = budouxScores(text)
  const boundaries = new Set()
  for (let i = 1; i < text.length; i++) if (scores[i] > 0) boundaries.add(i)
  return boundaries
}

// ── 2.5 併用案 ────────────────────────────────────────────
// BudouX を土台にして、
//   (a) 英字の連なりは BudouX に渡さない (空白で切る。今と同じ)
//   (b) 既存の助詞・語尾テーブルは「繋げる方向にだけ」効かせる
// という組み合わせ。既存の規則から「切る」権限を取り上げるのが要点。
const LATIN_RUN_RE = /[A-Za-z0-9'’\-.,!?:; ]+/g

const hybridBoundaries = (text) => {
  const boundaries = new Set()

  // (a) 英字の区間とそれ以外に分ける
  const latinRuns = []
  let m
  LATIN_RUN_RE.lastIndex = 0
  while ((m = LATIN_RUN_RE.exec(text)) !== null) {
    if (m[0].trim().length) latinRuns.push([m.index, m.index + m[0].length])
  }

  let cursor = 0
  for (const [from, to] of latinRuns) {
    if (from > cursor) {
      const run = text.slice(cursor, from)
      for (const b of budouxBoundaries(run)) boundaries.add(cursor + b)
      boundaries.add(from)
    }
    // 英字の中は空白でだけ切る
    for (let i = from; i < to; i++) {
      if (text[i] === ' ' && i + 1 < to) boundaries.add(i + 1)
    }
    if (to < text.length) boundaries.add(to)
    cursor = to
  }
  if (cursor < text.length) {
    const run = text.slice(cursor)
    for (const b of budouxBoundaries(run)) boundaries.add(cursor + b)
  }
  boundaries.delete(0)

  // (b) 助詞・語尾・小書き仮名・閉じ括弧で始まる塊は前にぶら下げる。
  // 判定は「元の隣り合う塊どうし」で行う。繋げた後の塊を使うと、頭の漢字が
  // 残り続けて hasKanji がずっと真になり、行がまるごと1塊になってしまう。
  const sorted = [...boundaries].sort((a, b) => a - b)
  const edges = [0, ...sorted, text.length]
  for (let i = 0; i < edges.length - 2; i++) {
    const prev = text.slice(edges[i], edges[i + 1])
    const next = text.slice(edges[i + 1], edges[i + 2])
    if (shouldMergeLyricSegments(prev, next)) boundaries.delete(edges[i + 1])
  }
  return boundaries
}

// 併用案の弱点は、BudouX が仮名の多い行を切らなすぎること
// (「ちょっとだけ笑ってみせた」で1行まるごと1塊)。塊が長いまま行幅を
// 超えると overflow-wrap: break-word が発動して語中で割れるので、
// 上限を超えた塊は、BudouX の素点がいちばん高かった位置で割る。
// 現行規則の境界を戻すやり方だと「一度だけや / り直せたら」のように
// 規則側の悪い切れ目をそのまま拾ってしまうので、モデルの二番手を使う。
const MAX_CHUNK = Number(process.env.MAX_CHUNK || 8)
// 小書き仮名・長音・句読点・閉じ括弧は、どう詰まっても行頭に置かない
const LOOSE_HEAD_RE = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮーｰ゛゜々〆、。，．！？!?)）\]」』】〕》〉”’]/

const guardedBoundaries = (text) => {
  const boundaries = hybridBoundaries(text)
  const scores = budouxScores(text)

  for (;;) {
    const sorted = [0, ...[...boundaries].sort((a, b) => a - b), text.length]
    let split = null
    for (let i = 0; i < sorted.length - 1; i++) {
      const [from, to] = [sorted[i], sorted[i + 1]]
      if (to - from <= MAX_CHUNK) continue
      // 端で割ると1文字だけの塊が出るので、内側だけを見る。
      // まず拒否規則を守れる位置から探し、全滅したら
      // 「行頭に来てはいけない字」だけを避けて割る(割らない方が害が大きい)。
      let best = null
      let loose = null
      for (let j = from + 2; j <= to - 2; j++) {
        const next = text.slice(j, to)
        if (LOOSE_HEAD_RE.test(next)) continue
        if (loose === null || scores[j] > scores[loose]) loose = j
        if (shouldMergeLyricSegments(text.slice(from, j), next)) continue
        if (best === null || scores[j] > scores[best]) best = j
      }
      best = best ?? loose
      if (best === null) continue
      split = best
      break
    }
    if (split === null) break
    boundaries.add(split)
  }
  return boundaries
}

// ── 3. 比較 ────────────────────────────────────────────────
const chunks = (text, boundaries) => {
  const out = []
  let start = 0
  for (const b of [...boundaries].sort((a, b) => a - b)) {
    out.push(text.slice(start, b))
    start = b
  }
  out.push(text.slice(start))
  return out.filter(c => c !== '')
}

const LINES = fs.readFileSync(new URL('./budoux-compare-lines.txt', import.meta.url), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

const VARIANTS = [
  ['現行  ', currentBoundaries],
  ['BudouX', budouxBoundaries],
  ['併用  ', hybridBoundaries],
  ['併用+上限', guardedBoundaries],
]

const stats = VARIANTS.map(([name]) => ({ name, longest: [], solo: 0, total: 0 }))
const diffs = []
let same = 0

for (const line of LINES) {
  const rendered = VARIANTS.map(([, fn], i) => {
    const cs = chunks(line, fn(line))
    stats[i].longest.push(Math.max(...cs.map(c => c.length)))
    // 1文字だけの塊は、日本語では折り返し位置としてほぼ常に誤り
    // (「見 / 失った」「振り / 返って / み / れ / ば」)。切りすぎの目安に使う。
    stats[i].solo += cs.filter(c => c.length === 1 && !/\s/.test(c)).length
    stats[i].total += cs.length
    return cs
  })

  if (rendered[0].join(' ') === rendered[3].join(' ')) { same++; continue }
  diffs.push({ line, rendered })
}

const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)

console.log(`対象 ${LINES.length} 行 / 現行と併用+上限が同じ ${same} 行 / 差あり ${diffs.length} 行\n`)

for (const d of diffs) {
  console.log(`  ${d.line}`)
  VARIANTS.forEach(([name], i) => {
    console.log(`    ${name}: ${d.rendered[i].join(' / ')}`)
  })
  console.log('')
}

console.log('── まとめ ──')
for (const s of stats) {
  console.log(
    `${s.name} : 塊 ${s.total} 個 / 1文字だけの塊 ${s.solo} 個 / ` +
    `最長 平均 ${avg(s.longest)} 字 / 最長が10字超の行 ${s.longest.filter(n => n > 10).length}`,
  )
}
