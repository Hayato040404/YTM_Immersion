// YouTube Music を候補メニューに並べる。
//
// YTM だけは background を通らない(Service Worker の fetch には
// Origin: chrome-extension:// が付いて YouTube に 403 で弾かれるので、
// content script が直接叩いている)。そのぶん background が組む候補一覧にも
// 入らず、どのモードでもメニューに出てこなかった。
// LRCHub優先では結果を見てすらいなかったので、取得だけして捨てていた。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const uiSource = fs.readFileSync(
  new URL('../src/js/module/lyrics-ui.js', import.meta.url),
  'utf8',
)
const bgSource = fs.readFileSync(
  new URL('../src/js/background.js', import.meta.url),
  'utf8',
)

function createHarness(initial = null) {
  const slice = uiSource.slice(
    uiSource.indexOf('const getCandidateId = (cand, idx = 0) => {'),
    uiSource.indexOf('const getCandidateRecordId = (candidate) => {'),
  )
  assert.ok(slice.includes('const offerYtmCandidate ='), '候補まわりを切り出せていない')

  const context = {
    LYRICS_SOURCE_LABELS: { ytm: 'YouTube Music' },
  }
  vm.runInNewContext(`
    let lyricsCandidates = ${JSON.stringify(initial)};
    ${slice}
    globalThis.offer = offerYtmCandidate;
    globalThis.merge = mergeLyricsCandidates;
    globalThis.list = () => lyricsCandidates;
  `, context, { filename: 'lyric-ytm-candidate.js' })
  return context
}

test('YTM の歌詞が候補として並ぶ', () => {
  const h = createHarness([{ id: 'provider_lrchub', label: 'LRC Hub', providerCandidate: true }])

  assert.equal(h.offer({ lyrics: '[00:01.00] line', hasSynced: true }), true)
  const added = h.list().find(c => c.id === 'provider_ytm')
  assert.ok(added, '候補に入っていない')
  assert.equal(added.label, 'YouTube Music')
  assert.equal(added.lyricsSource, 'ytm')
  assert.equal(added.providerCandidate, true)
  assert.equal(added.has_synced, true)
  // LRCHub のレコードではないので、選んでも追加取得や選択報告を走らせない
  assert.equal(added.record_id, null)
  assert.equal(added.lyricsComplete, true)
})

test('歌詞が無い結果は並べない', () => {
  const h = createHarness()
  assert.equal(h.offer({ lyrics: '   ', hasSynced: true }), false)
  assert.equal(h.offer({ hasSynced: false }), false)
  assert.equal(h.list(), null)
})

test('同じ曲で二度届いても増えない', () => {
  const h = createHarness()
  assert.equal(h.offer({ lyrics: '[00:01.00] line', hasSynced: true }), true)
  assert.equal(h.offer({ lyrics: '[00:01.00] line', hasSynced: true }), false)
  assert.equal(h.list().filter(c => c.id === 'provider_ytm').length, 1)
})

test('時刻なしで出したあと、同期版が見つかったら置き換える', () => {
  const h = createHarness()
  h.offer({ lyrics: 'plain text', hasSynced: false })
  assert.equal(h.list()[0].has_synced, false)

  // 別リリース探索が同期版を見つけた(onUpgrade)
  assert.equal(h.offer({ lyrics: '[00:01.00] line', hasSynced: true }), true)
  assert.equal(h.list().length, 1, '2つ並んでいる')
  assert.equal(h.list()[0].has_synced, true)

  // 逆向きには落とさない
  assert.equal(h.offer({ lyrics: 'plain text', hasSynced: false }), false)
  assert.equal(h.list()[0].has_synced, true)
})

test('他の取得元と同じ形をしている', () => {
  // 片方にだけ項目が増えると、候補メニューやキャッシュの扱いがずれる
  const keysOf = (src, marker) => {
    const body = src.slice(src.indexOf(marker))
    const obj = body.slice(body.indexOf('return {'), body.indexOf('};'))
    return new Set([...obj.matchAll(/^\s{4}([a-z_]+):/gim)].map(m => m[1]))
  }
  const mine = keysOf(uiSource, 'const buildYtmCandidate =')
  const theirs = keysOf(bgSource, 'const buildProviderCandidate =')
  assert.ok(theirs.size > 5, '比較元を読み違えている')
  assert.deepEqual(
    [...theirs].filter(k => !mine.has(k)), [],
    'background 側にあってこちらに無い項目がある',
  )
})

test('優先モードに関わらず候補へ流す', () => {
  const block = uiSource.slice(
    uiSource.indexOf('const noteYtmCandidate = (res) => {'),
    uiSource.indexOf('const scheduleYtmLateUpgrade = () => {'),
  )
  assert.ok(block, '合流の仕掛けが無い')
  // 表示に使うかどうかの分岐(preferYtm)に巻き込まれていないこと
  assert.doesNotMatch(block, /preferYtm/, '優先設定で候補が出たり出なかったりする')
  assert.match(
    block,
    /void ytmPromise\s*\n\s*\.then\(noteYtmCandidate\)/,
    '取得結果を候補へ繋いでいない',
  )
  // 曲が変わっていたら捨てる
  assert.match(block, /thisKey !== currentKey/)
})

test('表示中の YTM は候補に重ねて出さない', () => {
  const block = uiSource.slice(
    uiSource.indexOf('const ownCandidates = [];'),
    uiSource.indexOf('ownCandidates.forEach('),
  )
  assert.match(block, /source === currentLyricsSource/)
})

test('同期の粒度が候補に出る', () => {
  const slice = uiSource.slice(
    uiSource.indexOf('const describeCandidateSync = (cand) => {'),
    uiSource.indexOf('const buildCandidateLabel = (cand, idx = 0) => {'),
  )
  const context = { hasCharacterSyncedLines: () => false }
  vm.runInNewContext(`${slice}\nglobalThis.describe = describeCandidateSync;`, context)

  assert.equal(
    context.describe({ lyrics: '[00:01.00] line', lyricsComplete: true, has_synced: true }),
    '行同期',
  )
  assert.equal(
    context.describe({ lyrics: 'plain text', lyricsComplete: true, has_synced: false }),
    '時刻なし',
  )
})
