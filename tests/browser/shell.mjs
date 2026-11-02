// アプリの殻の試験。実物のエディタ、文書モデル、殻をつなぎ、Rust の呼び出しだけを偽物にする。
import { parse, stringify } from 'lossless-json'
import { testContrast } from './contrast.mjs'
import { testDark } from './dark.mjs'
import { testLanguage } from './language.mjs'

const ANSWER_ACCEPT = 0
const ANSWER_CANCEL = 1
const INPUT_SETTLE_MS = 600
const ITEMS = ['items']
const ROWS = ['meta', 'rows']
const I19 = '/i19.json'
const SLASH_KEY = '/slash.json'

let h

const state = (page) => page.evaluate(() => window.fixture.state())
const docText = (page) => page.evaluate(() => window.fixture.text())
const open = (page, path, options = {}) =>
  page.evaluate(([target, opts]) => window.fixture.open(target, opts), [path, options])
const save = (page) => page.evaluate(() => window.fixture.save())
const setTarget = (page, path) => page.evaluate((target) => window.fixture.setTarget(target), path)
const setAnswer = (page, answer) => page.evaluate((value) => window.fixture.setAnswer(value), answer)
const nextOpen = (page, value) => page.evaluate((next) => window.fixture.nextOpen(next), value)
const sameTarget = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const canonical = (text) => stringify(parse(text))

async function shellPage(browser, base) {
  const { page, problems } = await h.openPage(browser, `${base}?shell`)
  await page.waitForFunction(() => window.fixture !== undefined)
  return { page, problems }
}

const reachesTarget = (page, path) =>
  h.reaches(
    page,
    (expected) => JSON.stringify(window.fixture.state().target) === expected,
    JSON.stringify(path)
  )

async function editCell(page, shown, value, { commit = true } = {}) {
  await page.getByText(shown, { exact: true }).dblclick({ timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  await page.keyboard.press('Control+A')
  await page.keyboard.type(value)
  if (commit) await page.keyboard.press('Enter')
}

async function pickTarget(page, label) {
  await page.click('.app-targetbar-button', { timeout: h.STATE_TIMEOUT_MS })
  await page.click(`.app-targetbar .app-menu-item:has-text("${label}")`, { timeout: h.STATE_TIMEOUT_MS })
}

function record(name, passed, detail = '') {
  h.record(name, passed, detail)
}

/** 条件 10。開いた文書の既定の表示。 */
async function testDefaultViews(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  const cases = [
    ['/first.json', '表', []],
    ['/object.json', '表', ITEMS],
    ['/plain.json', 'ツリー', []],
    ['/empty-array.json', 'ツリー', []]
  ]
  for (const [path, mode, target] of cases) {
    const { kind } = await open(page, path)
    const shown = await state(page)
    record(`既定の表示 ${path}: 開く`, kind === 'Opened', kind)
    record(`既定の表示 ${path}: ${mode}`, await h.reachesMode(page, mode), shown.mode)
    record(`既定の表示 ${path}: 対象`, sameTarget(shown.target, target), JSON.stringify(shown.target))
  }

  await nextOpen(page, { textOnly: true })
  await open(page, '/broken.json')
  record('既定の表示 不正な JSON: テキスト', await h.reachesMode(page, 'テキスト'))

  await page.evaluate(() => window.fixture.emit({ kind: 'Open', path: 'C:\\docs\\日本語 😀.json', discardConfirmed: false }))
  const titled = await h.reaches(page, () => /^日本語 😀\.json - JsonGridder \d+\.\d+\.\d+/.test(document.title))
  record('タイトルは ファイル名 - JsonGridder 版', titled, await page.title())
  const { titles } = await state(page)
  record('タイトルを窓へ渡す', titles.at(-1) === (await page.title()), titles.at(-1))
  record('既定の表示: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** サイズの上限と開く前の確認。 */
async function testConfirmations(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  await open(page, '/first.json')
  const before = await docText(page)

  await setAnswer(page, ANSWER_CANCEL)
  let outcome = await open(page, '/sjis.json')
  record('文字コードの確認を断ると開かない', outcome.kind === 'NeedsEncodingConfirm', outcome.kind)
  record('文字コードの確認を断ると文書が変わらない', (await docText(page)) === before)
  let shown = await state(page)
  record('文字コードの確認を断ると印が変わらない', shown.path === '/first.json' && !shown.dirty)

  await setAnswer(page, ANSWER_ACCEPT)
  outcome = await open(page, '/sjis.json')
  record('文字コードの確認を認めると開く', outcome.kind === 'Opened', outcome.kind)

  await setAnswer(page, ANSWER_CANCEL)
  outcome = await open(page, '/big.json')
  shown = await state(page)
  const request = shown.asks.at(-1)
  record('100 MB 超の確認の既定はキャンセル', request.default === request.cancel, JSON.stringify(request))
  record('サイズの確認を断ると開かない', outcome.kind === 'NeedsSizeConfirm' && shown.path === '/sjis.json', outcome.kind)
  await setAnswer(page, ANSWER_ACCEPT)
  outcome = await open(page, '/big.json')
  record('サイズの確認を認めると開く', outcome.kind === 'Opened', outcome.kind)

  await open(page, '/first.json')
  await editCell(page, 'x', 'edited')
  outcome = await open(page, '/second.json')
  shown = await state(page)
  record('未保存なら開かず Rust へ判断を渡す', outcome.kind === 'NeedsUnsavedDecision' && shown.dirty, outcome.kind)
  record('判断は開く先のパスで Rust へ行く', shown.openRequests.at(-1) === '/second.json', shown.openRequests.join())
  record('未保存の判断の間は編集が残る', (await docText(page)).includes('edited'))
  outcome = await open(page, '/second.json', { discardConfirmed: true })
  record('破棄の決定で開く', outcome.kind === 'Opened', outcome.kind)

  // 開く処理は確認より先に入力を確定する。断っても利用者の入力は消えず、未保存として残る
  await open(page, '/first.json')
  await editCell(page, 'x', 'typing', { commit: false })
  await setAnswer(page, ANSWER_CANCEL)
  outcome = await open(page, '/sjis.json')
  shown = await state(page)
  record('セルの編集中に確認を断っても入力が残る', (await docText(page)).includes('typing'), outcome.kind)
  record('セルの編集中に確認を断ると未保存になる', shown.dirty && shown.path === '/first.json')
  await setAnswer(page, ANSWER_ACCEPT)
  await open(page, '/second.json', { discardConfirmed: true })

  await nextOpen(page, { sizeClass: 'noTextMode' })
  await h.switchTo(page, 'テキスト')
  await open(page, '/plain.json')
  record('10 MB 超の文書はテキストの表示のまま開かない', await h.reachesMode(page, 'ツリー'))
  await nextOpen(page, { sizeClass: 'noTextMode' })
  await open(page, '/first.json')
  record('10 MB 超の配列は表で開く', await h.reachesMode(page, '表'))

  await nextOpen(page, { reply: { kind: 'Refused', reason: 'tooLarge', scan: null } })
  await open(page, '/first.json')
  let notice = await page.locator('.app-notice').innerText()
  record('開けない理由を日本語で出す', notice.includes('大きすぎる'), notice)

  await nextOpen(page, { scan: { numericKeyReorder: true } })
  await open(page, '/first.json')
  notice = await page.locator('.app-notice').innerText()
  record('数字キーを開くときに知らせる', notice.includes('数字だけのキー'), notice)
  record('確認: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 6。1 セル編集して保存し、編集したセル以外が開いたときと同じ。 */
async function testOuterKept(browser, base) {
  const name = 'I19'
  const { page, problems } = await shellPage(browser, base)
  await open(page, I19)
  const original = await docText(page)
  const expectedTarget = (await state(page)).target
  record(`${name}: 対象を選んで表で開く`, sameTarget(expectedTarget, ITEMS), JSON.stringify(expectedTarget))

  await editCell(page, 'x', 'edited')
  const saved = await save(page)
  let shown = await state(page)
  record(`${name}: 保存する`, saved.kind === 'Saved', saved.kind)
  const expected = parse(original)
  expected.items[0].name = 'edited'
  record(
    `${name}: 編集したセル以外の全キー、全値、数値の字面、キー順が同じ`,
    canonical(shown.written) === stringify(expected),
    shown.written
  )

  await h.switchTo(page, 'ツリー')
  const tree = await page.locator('.jse-tree-mode').innerText()
  record(`${name}: ツリーで文書全体が見える`, tree.includes('version') && tree.includes('tags'), tree.slice(0, 80))
  await h.switchTo(page, 'テキスト')
  const text = await docText(page)
  record(`${name}: テキストで文書全体が見える`, text.includes('"big"') && text.includes('"tags"'), text.slice(0, 80))
  await h.switchTo(page, '表')
  record(`${name}: 表へ戻ると対象が残る`, sameTarget((await state(page)).target, ITEMS))

  const reopened = await open(page, I19)
  record(`${name}: 開き直せる`, reopened.kind === 'Opened', reopened.kind)
  record(`${name}: 開き直した文書が書いた内容`, (await docText(page)) === shown.written)

  const beforePatch = parse(await docText(page))
  await page.evaluate(() => window.fixture.patch([{ op: 'replace', path: '/items/1/name', value: 'patched' }]))
  await h.switchTo(page, 'ツリー')
  const patched = parse(await docText(page))
  beforePatch.items[1].name = 'patched'
  record(`${name}: 公開の patch の後も文書全体が残る`, stringify(patched) === stringify(beforePatch), stringify(patched))
  const outside = await page.evaluate(() => {
    try {
      window.fixture.patch([{ op: 'replace', path: '/version', value: 2 }])
      return 'applied'
    } catch (error) {
      return String(error)
    }
  })
  record(`${name}: ツリーの公開の patch は文書全体へ届く`, outside === 'applied', outside)
  await h.switchTo(page, '表')
  const refused = await page.evaluate(() => {
    try {
      window.fixture.patch([{ op: 'replace', path: '/version', value: 3 }])
      return 'applied'
    } catch (error) {
      return String(error)
    }
  })
  record(`${name}: 表の公開の patch は対象の外を断る`, refused.includes('outside'), refused)

  await open(page, SLASH_KEY, { discardConfirmed: true })
  shown = await state(page)
  record(`${name}: キーの / と ~ を逃がす`, sameTarget(shown.target, ['a/b~c', 'rows']), JSON.stringify(shown.target))
  const slashOriginal = await docText(page)
  await editCell(page, 'v1', 'edited')
  await save(page)
  shown = await state(page)
  const slashExpected = parse(slashOriginal)
  slashExpected['a/b~c'].rows[0].v = 'edited'
  record(`${name}: 逃がしたキーの下へ書く`, canonical(shown.written) === stringify(slashExpected), shown.written)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const undo = (page) => page.click('.jse-undo', { timeout: h.STATE_TIMEOUT_MS })
const redo = (page) => page.click('.jse-redo', { timeout: h.STATE_TIMEOUT_MS })

async function outerAfterSave(page) {
  await page.waitForTimeout(INPUT_SETTLE_MS)
  const before = (await state(page)).writes
  const { kind } = await save(page)
  const { written, writes } = await state(page)
  const text = writes > before ? written : await docText(page)
  const document = parse(text)
  return { kind, outer: stringify({ version: document.version, big: document.big, meta: document.meta, tags: document.tags }), document }
}

/** 条件 7 の (a)。表で編集→ツリーで編集→テキスト→履歴の端まで。 */
async function testHistoryEnds(browser, base) {
  const name = '履歴の端まで'
  const { page, problems } = await shellPage(browser, base)
  await open(page, I19)
  const original = await docText(page)
  const parsed = parse(original)
  const outer = stringify({ version: parsed.version, big: parsed.big, meta: parsed.meta, tags: parsed.tags })

  await editCell(page, 'x', 'edited')
  await h.switchTo(page, 'ツリー')
  await editCell(page, 'p', 'tree-edit')
  await h.switchTo(page, 'テキスト')

  const treeEdited = stringify({ ...parsed, tags: ['tree-edit', 'q'] })
  const sameOuter = (result, expectEdit) =>
    stringify({ version: result.document.version, big: result.document.big, meta: result.document.meta }) ===
      stringify({ version: parsed.version, big: parsed.big, meta: parsed.meta }) &&
    (expectEdit ? stringify(result.document.tags) === stringify(parse(treeEdited).tags) : result.outer === outer)

  let step = await outerAfterSave(page)
  record(`${name}: 開始の外側`, sameOuter(step, true), step.outer)
  await undo(page)
  record(`${name}: undo 1 はツリーへ戻る`, await h.reachesMode(page, 'ツリー'))
  await undo(page)
  step = await outerAfterSave(page)
  record(`${name}: undo 2 はツリーの編集を戻す`, sameOuter(step, false), step.outer)
  await undo(page)
  record(`${name}: undo 3 は表へ戻る`, await h.reachesMode(page, '表'))
  record(`${name}: undo 3 で対象が残る`, await reachesTarget(page, ITEMS))
  await undo(page)
  step = await outerAfterSave(page)
  record(`${name}: undo 4 は表の編集を戻す`, stringify(step.document) === stringify(parsed), stringify(step.document))

  await redo(page)
  step = await outerAfterSave(page)
  record(`${name}: redo 1 は表の編集を進める`, step.document.items[0].name === 'edited' && sameOuter(step, false), stringify(step.document))
  await redo(page)
  record(`${name}: redo 2 はツリーへ進む`, await h.reachesMode(page, 'ツリー'))
  await redo(page)
  step = await outerAfterSave(page)
  record(`${name}: redo 3 はツリーの編集を進める`, sameOuter(step, true), step.outer)
  await redo(page)
  record(`${name}: redo 4 はテキストへ進む`, await h.reachesMode(page, 'テキスト'))
  step = await outerAfterSave(page)
  record(`${name}: 端の文書に両方の編集が残る`, step.document.items[0].name === 'edited' && sameOuter(step, true), stringify(step.document))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 7 の (b)。テキストで対象を改名、削除してから表へ。 */
async function testTargetInvalidated(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  for (const { name, path, find, replace } of [
    { name: '対象の改名', path: I19, find: '"items"', replace: '"renamed"' },
    { name: '対象の削除', path: '/delete.json', find: ',"items":[{"a":1}]', replace: '' }
  ]) {
    await open(page, path, { discardConfirmed: true })
    await h.switchTo(page, 'テキスト')
    const before = await docText(page)
    await page.evaluate(([text, from, to]) => window.fixture.typeAt(text, from, to), [
      replace,
      before.indexOf(find),
      before.indexOf(find) + find.length
    ])
    await page.waitForTimeout(INPUT_SETTLE_MS)
    await h.switchTo(page, '表')
    record(`${name}: 文書全体へ戻る`, await reachesTarget(page, []), JSON.stringify((await state(page)).target))
    const notice = await page.locator('.app-notice').innerText().catch(() => '')
    record(`${name}: 知らせる`, notice.includes('表の対象'), notice)
    const expected = before.replace(find, replace)
    record(`${name}: 文書を書き戻さない`, (await docText(page)) === expected, await docText(page))
    const { kind } = await save(page)
    const { written } = await state(page)
    record(`${name}: 保存しても外側が同じ`, kind === 'Saved' && canonical(written) === canonical(expected), written)
  }
  record('対象の無効化: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 7 の (c)。セルの編集中に対象を替えて、入力が残り、undo が対象を追う。 */
async function testSwitchWhileEditing(browser, base) {
  const name = 'セルの編集中に対象を替える'
  const { page, problems } = await shellPage(browser, base)
  await open(page, I19)
  await editCell(page, 'x', 'edited', { commit: false })
  await pickTarget(page, 'meta.rows')
  record(`${name}: 替わる`, await reachesTarget(page, ROWS))
  record(`${name}: 入力が文書に残る`, parse(await docText(page)).items[0].name === 'edited', await docText(page))
  const table = await page.locator('.jse-table-mode').innerText()
  record(`${name}: 新しい対象が表に出る`, table.includes('v') && !table.includes('edited'), table.slice(0, 80))
  record(`${name}: 対象の表示が替わる`, (await page.locator('.app-targetbar-button').innerText()).includes('meta.rows'))
  const previous = await docText(page)

  await undo(page)
  record(`${name}: undo は対象を追う`, await reachesTarget(page, ITEMS), JSON.stringify((await state(page)).target))
  const undone = parse(await docText(page))
  record(`${name}: undo で編集が戻る`, undone.items[0].name === 'x', await docText(page))
  record(`${name}: undo の後も文書全体`, undone.version !== undefined && undone.tags !== undefined)
  await redo(page)
  record(`${name}: redo で編集が戻る`, (await h.reaches(page, () => window.fixture.text().includes('edited'))))
  record(`${name}: redo の文書が同じ`, canonical(await docText(page)) === canonical(previous))

  await setTarget(page, ROWS)
  await editCell(page, 'v', 'rows-edit')
  await setTarget(page, ITEMS)
  await undo(page)
  record(`${name}: 別の配列の編集の undo でその配列へ移る`, await reachesTarget(page, ROWS))
  record(`${name}: 別の配列の編集が戻る`, parse(await docText(page)).meta.rows[0].k === 'v', await docText(page))
  await page.waitForFunction(() => document.querySelector('.jse-table-mode') !== null)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 文書全体へ戻す経路と、案内の画面の Edit。 */
async function testWholeDocument(browser, base) {
  const name = '文書全体へ戻す'
  const { page, problems } = await shellPage(browser, base)
  await open(page, I19)
  await pickTarget(page, '文書全体')
  record(`${name}: 対象が空になる`, await reachesTarget(page, []))
  record(`${name}: 対象の表示が残る`, await page.locator('.app-targetbar-button').isVisible())
  await page.click('.jse-nested-array-action:has-text("編集")', { timeout: h.STATE_TIMEOUT_MS }).catch(async () => {
    await page.click('.jse-nested-array-action', { timeout: h.STATE_TIMEOUT_MS })
  })
  record(`${name}: 案内の Edit は対象を替える`, await reachesTarget(page, ITEMS), JSON.stringify((await state(page)).target))
  record(`${name}: モーダルを開かない`, (await page.locator('dialog[open]').count()) === 0)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** I1。開く→全部の表示と対象を回す→保存で 1 バイトも書かない。 */
async function testRoundTrip(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  for (const { path, targets } of [
    { path: '/crlf-object.json', targets: ['文書全体', 'items'] },
    { path: I19, targets: ['meta.rows', 'tags', '文書全体', 'items'] },
    { path: '/crlf.json', targets: [] }
  ]) {
    const name = `I1 ${path}`
    await open(page, path, { discardConfirmed: true })
    const before = await docText(page)
    for (const label of targets) await pickTarget(page, label)
    for (const mode of ['ツリー', 'テキスト', '表']) await h.switchTo(page, mode)
    const shown = await state(page)
    record(`${name}: 未保存が立たない`, !shown.dirty)
    record(`${name}: タイトルに印が無い`, !(await page.title()).startsWith('*'), await page.title())
    record(`${name}: 文書が字面まで同じ`, (await docText(page)) === before)
    const { kind } = await save(page)
    record(`${name}: 保存で書かない`, kind === 'NoChange' && (await state(page)).writes === 0, kind)
  }
  record('I1: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const SECRET_CLICKS = 8
const SECRET_WINDOW_MS = 2000
const SECRET_SLOW_STEP_MS = 320 // 8 回で 2240 ms（窓の 2000 ms を超える）
const MENUBAR_BLANK_X = 600 // 最後のメニューの右の空白（花びらは右端なので別の所）
const PETAL = '.app-menubar-petal'

const ceremonyCalls = (page) => page.evaluate(() => window.fixture.state().ceremonyCalls)

/** 花びら（既定）・空白（'.app-menubar'）・指定の要素を count 回押す。stepMs の間隔で。 */
async function clickBlank(page, count, stepMs = 0, selector = PETAL) {
  for (let index = 0; index < count; index++) {
    if (selector === '.app-menubar') {
      const box = await page.locator('.app-menubar').boundingBox()
      await page.mouse.click(box.x + MENUBAR_BLANK_X, box.y + box.height / 2)
    } else if (selector === PETAL) {
      // 揺れの最中は locator.click が止まるのを待って遅れるので、位置を取って直接押す
      const box = await page.locator(PETAL).boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    } else {
      await page.locator(selector).first().click()
    }
    if (stepMs > 0) await page.waitForTimeout(stepMs)
  }
}

const optionsItems = async (page) => {
  await page.click('.app-menubar-button:has-text("オプション")')
  const items = await page.locator('.app-menu-popup .app-menu-item').allInnerTexts()
  const ceremony = page.locator('.app-menu-item', { hasText: '起動セレモニー' })
  const checked = (await ceremony.count()) === 1 ? await ceremony.getAttribute('aria-checked') : null
  return { items, ceremony, checked }
}

/** 隠しコマンド。花びらを 2000 ms 以内に 8 回押すと起動セレモニーの旗が反転し、Options に項目が出る。 */
async function testSplashCeremony(browser, base) {
  const name = '起動セレモニーの隠しコマンド'
  const mount = async (query) => {
    const { page, problems } = await h.openPage(browser, `${base}?shell${query}`)
    await page.waitForFunction(() => window.fixture !== undefined)
    return { page, problems }
  }

  // 7 回では反応しない
  let { page, problems } = await mount('')
  await clickBlank(page, SECRET_CLICKS - 1)
  record(`${name}: 7 回では反転しない`, (await ceremonyCalls(page)).length === 0, JSON.stringify(await ceremonyCalls(page)))
  // 続く 1 回で 8 回目になる（数え直されていない）
  await clickBlank(page, 1)
  const calls = await ceremonyCalls(page)
  record(`${name}: 8 回で反転して保存する（既定オフ -> オン、解禁を書く）`, calls.length === 1 && calls[0].enabled === true && calls[0].unlock === true, JSON.stringify(calls))
  record(`${name}: 通知の帯に「オン」`, (await page.locator('.app-notice').innerText()).includes('起動セレモニー: オン'))
  let { items, ceremony, checked } = await optionsItems(page)
  record(`${name}: 解禁後の Options に項目が出る`, items.some((text) => text.includes('起動セレモニー')), items.join())
  record(`${name}: チェックが状態（オン）と合う`, checked === 'true', String(checked))
  await ceremony.click()
  const afterPick = await ceremonyCalls(page)
  record(`${name}: 項目を選ぶと反転して保存する`, afterPick.length === 2 && afterPick[1].enabled === false && afterPick[1].unlock === false, JSON.stringify(afterPick))
  ;({ checked } = await optionsItems(page))
  record(`${name}: 選んだ後のチェックはオフ`, checked === 'false', String(checked))
  await page.keyboard.press('Escape')
  // もう一度 8 回でオンへ戻り、通知はオン
  await clickBlank(page, SECRET_CLICKS)
  record(`${name}: 次の 8 回でオンへ戻る`, (await ceremonyCalls(page)).at(-1)?.enabled === true)
  record(`${name}: 回数と時間の定数`, SECRET_CLICKS === 8 && SECRET_WINDOW_MS === 2000)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()

  // 遅い 8 回（2000 ms を超える）では反転しない
  ;({ page, problems } = await mount(''))
  await clickBlank(page, SECRET_CLICKS, SECRET_SLOW_STEP_MS)
  record(`${name}: 2000 ms を超える 8 回では反転しない`, (await ceremonyCalls(page)).length === 0, JSON.stringify(await ceremonyCalls(page)))
  ;({ items } = await optionsItems(page))
  record(`${name}: 解禁前は項目を出さない`, !items.some((text) => text.includes('起動セレモニー')), items.join())
  await page.close()

  // 項目（ボタン）の上の 8 回では反転しない
  ;({ page } = await mount(''))
  await clickBlank(page, SECRET_CLICKS, 0, '.app-menubar-button >> nth=2')
  record(`${name}: メニューの項目の上の 8 回では反転しない`, (await ceremonyCalls(page)).length === 0, JSON.stringify(await ceremonyCalls(page)))
  await page.close()

  // 空白の 8 回では反転しない
  ;({ page } = await mount(''))
  await clickBlank(page, SECRET_CLICKS, 0, '.app-menubar')
  record(`${name}: 空白の 8 回では反転しない`, (await ceremonyCalls(page)).length === 0, JSON.stringify(await ceremonyCalls(page)))
  await page.close()

  // 花びらの作り: 飾り（aria-hidden、title 無し、Tab で届かない）、押すと揺れ、8 回目は回る
  ;({ page } = await mount(''))
  const petalFacts = await page.evaluate(() => {
    const el = document.querySelector('.app-menubar-petal')
    return { hidden: el.getAttribute('aria-hidden'), title: el.getAttribute('title'), label: el.getAttribute('aria-label'), tab: el.tabIndex, svg: el.querySelector('svg') !== null }
  })
  record(`${name}: 花びらは飾り（aria-hidden・title 無し・Tab で届かない）`, petalFacts.hidden === 'true' && petalFacts.title === null && petalFacts.label === null && petalFacts.tab === -1 && petalFacts.svg, JSON.stringify(petalFacts))
  const wobble = await page.evaluate(() => {
    const el = document.querySelector('.app-menubar-petal')
    el.click()
    return el.classList.contains('is-wobble')
  })
  record(`${name}: 押すと揺れのクラスが付く`, wobble === true)
  await clickBlank(page, SECRET_CLICKS - 2)
  const spin = await page.evaluate(() => {
    const el = document.querySelector('.app-menubar-petal')
    el.click()
    return el.classList.contains('is-spin')
  })
  record(`${name}: 8 回目で反転して花びらが回る`, spin === true && (await ceremonyCalls(page)).length === 1, JSON.stringify(await ceremonyCalls(page)))
  const focusKept = await page.evaluate(() => !document.activeElement?.classList.contains('app-menubar-petal'))
  record(`${name}: 花びらはフォーカスを持たない`, focusKept)
  await page.close()

  // reduced-motion では揺らさない（回数の数えは変わらない）
  ;({ page } = await mount(''))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await page.evaluate(() => {
    const el = document.querySelector('.app-menubar-petal')
    el.click()
    return el.classList.contains('is-wobble')
  })
  record(`${name}: reduced-motion では揺れのクラスが付かない`, reduced === false)
  await clickBlank(page, SECRET_CLICKS - 1)
  record(`${name}: reduced-motion でも 8 回で反転する`, (await ceremonyCalls(page)).length === 1, JSON.stringify(await ceremonyCalls(page)))
  await page.close()

  // ライトとダークで花びらが見える（不透明度が 0 でない・地と色が違う）
  for (const theme of ['light', 'dark']) {
    ;({ page } = await mount(`&theme=${theme}`))
    const look = await page.evaluate(() => {
      const el = document.querySelector('.app-menubar-petal')
      const style = getComputedStyle(el)
      const bar = getComputedStyle(document.querySelector('.app-menubar'))
      const box = el.getBoundingClientRect()
      return { opacity: Number(style.opacity), color: style.color, bg: bar.backgroundColor, w: box.width, h: box.height, cursor: style.cursor }
    })
    record(`${name}: ${theme} で花びらが見える`, look.opacity > 0.3 && look.opacity < 0.6 && look.color !== look.bg && look.w >= 14 && look.cursor === 'pointer', JSON.stringify(look))
    await page.hover(PETAL)
    await page.waitForTimeout(250)
    const hovered = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.app-menubar-petal')).opacity))
    record(`${name}: ${theme} でマウスを乗せると濃くなる`, hovered > 0.8, String(hovered))
    await page.close()
  }

  // 解禁済みで起動すると項目があり、チェックは保存された状態
  ;({ page } = await mount('&unlocked=1&ceremony=on'))
  ;({ checked } = await optionsItems(page))
  record(`${name}: 解禁済みの起動で項目があり、チェックはオン`, checked === 'true', String(checked))
  await page.close()
  ;({ page } = await mount('&unlocked=1'))
  ;({ checked } = await optionsItems(page))
  record(`${name}: 解禁済みでオフの起動ではチェックなし`, checked === 'false', String(checked))
  await page.close()
}

async function testMenu(browser, base) {
  const name = 'メニュー'
  const { page, problems } = await shellPage(browser, base)
  await open(page, '/first.json')
  const labels = await page.locator('.app-menubar-button').allInnerTexts()
  record(`${name}: 3 つのメニュー`, labels.join() === 'ファイル(F),オプション(O),ヘルプ(H)', labels.join())

  await page.getByText('x', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+o')
  record(`${name}: セルにフォーカスがあっても Ctrl+O が効く`, (await state(page)).picks === 1)

  await page.keyboard.press('Alt+f')
  const popup = page.locator('.app-menu-popup')
  record(`${name}: Alt+F で開く`, (await popup.innerText()).includes('開く'))
  const save = page.locator('.app-menu-item', { hasText: '保存(S)' })
  record(`${name}: 保存の入口が押せる`, (await save.getAttribute('aria-disabled')) !== 'true')
  await page.keyboard.press('Escape')
  record(`${name}: Esc で閉じる`, (await popup.count()) === 0)

  await page.keyboard.press('Alt')
  record(
    `${name}: Alt 単独でメニューバーへ入る`,
    await h.reaches(page, () => document.activeElement?.classList.contains('app-menubar-button'))
  )
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  record(`${name}: 矢印と Enter で開く`, (await state(page)).picks === 2)

  await page.click('.app-menubar-button:has-text("オプション")')
  await page.click('.app-menu-item:has-text("ダーク")')
  record(`${name}: ダークの入口`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page.click('.app-menubar-button:has-text("オプション")')
  await page.hover('.app-menu-item:has-text("言語")')
  await page.click('.app-menu-item:has-text("English")')
  record(`${name}: 言語の入口で文書の言語が替わる`, (await page.evaluate(() => document.documentElement.lang)) === 'en')
  record(`${name}: 英語の辞書が画面に届く`, /^File/.test(await page.locator('.app-menubar-button').first().innerText()))
  await page.click('.app-menubar-button:has-text("Options")')
  await page.hover('.app-menu-item:has-text("Language")')
  await page.click('.app-menu-item:has-text("日本語")')
  record(`${name}: 日本語へ戻せる`, (await page.locator('.app-menubar-button').first().innerText()) === 'ファイル(F)')

  await page.click('.app-menubar-button:has-text("ヘルプ")')
  await page.click('.app-menu-item:has-text("について")')
  record(`${name}: About は版を出す`, (await state(page)).asks.at(-1)?.body.includes('0.1.0'), JSON.stringify((await state(page)).asks.at(-1)))
  await page.click('.app-menubar-button:has-text("ファイル")')
  await page.click('.app-menu-item:has-text("終了")')
  record(`${name}: 終了`, (await state(page)).exits === 1)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** ドロップと引数は Rust が `Open` で送る。2 件以上は Rust の通知が来る。 */
async function testShellEvents(browser, base) {
  const name = '殻の通知'
  const { page, problems } = await shellPage(browser, base)
  await page.evaluate(() => {
    window.fixture.emit({ kind: 'Notice', key: 'app.notice.dropOneFile' })
    window.fixture.emit({ kind: 'Open', path: '/first.json', discardConfirmed: false })
  })
  record(`${name}: Open で開く`, await h.reaches(page, () => window.fixture.state().path === '/first.json'))
  const notice = await page.locator('.app-notice').innerText()
  record(`${name}: 辞書の文言を出す`, notice.includes('1 ファイルだけ'), notice)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const CELL_FONTS = ['Consolas', 'BIZ UDGothic', 'MS Gothic']
const UI_FONTS = ['Segoe UI', 'Yu Gothic UI', 'Meiryo UI']

/** 文書の言語と、日本語の文字に実際に使われたフォント。セルは等幅、殻は UI の指定を使う。 */
async function testFonts(browser, base) {
  const name = 'フォント'
  const { page, problems } = await shellPage(browser, base)
  await open(page, '/japanese.json')
  const cell = page.getByText('日本語の値', { exact: true })
  await cell.waitFor({ timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 文書の言語`, (await page.evaluate(() => document.documentElement.lang)) === 'ja')
  const family = await cell.evaluate((node) => getComputedStyle(node).fontFamily)
  record(`${name}: セルの指定が効く`, family.includes('BIZ UDGothic'), family)

  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const fontsOf = async (selector) => {
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId })
    return fonts.map(({ familyName }) => familyName)
  }
  const inCell = await fontsOf('.jse-table-mode td .jse-value')
  record(`${name}: セルの実際のフォント`, inCell.length > 0 && inCell.every((font) => CELL_FONTS.includes(font)), inCell.join())
  const inMenu = await fontsOf('.app-menubar-button')
  record(`${name}: メニューの実際のフォント`, inMenu.length > 0 && inMenu.every((font) => UI_FONTS.includes(font)), inMenu.join())
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const evaluateFixture = (page, name, ...args) =>
  page.evaluate(([method, values]) => window.fixture[method](...values), [name, args])
const flow = (page, destination) => evaluateFixture(page, 'flow', destination)
const setAnswers = (page, values) => evaluateFixture(page, 'setAnswers', values)
const setPicked = (page, path) => evaluateFixture(page, 'setPickedPath', path)
const nextSave = (page, reply) => evaluateFixture(page, 'nextSave', reply)
const emit = (page, event) => evaluateFixture(page, 'emit', event)
const lastReport = async (page) => (await state(page)).reports.at(-1)
const editing = (page, shown, value) => editCell(page, shown, value, { commit: false })
const FIRST = '/first.json'
const CANCEL_THIRD = 2
const SAVE_ANYWAY = 0

/** 条件 3。打鍵の時点で Rust へ印が届く。確定も onChange も待たない。 */
async function testEditMark(browser, base) {
  const name = '未保存の印'
  const { page, problems } = await shellPage(browser, base)
  await open(page, FIRST)
  record(`${name}: 開いた直後は立たない`, !(await lastReport(page)).unsaved)
  record(`${name}: タイトルに * が無い`, !(await page.title()).startsWith('*'), await page.title())

  await editing(page, 'x', 'typing')
  let report = await lastReport(page)
  record(`${name}: セルの編集中に立つ`, report.unsaved, JSON.stringify(report))
  record(`${name}: タイトルの * と一緒に届く`, report.title.startsWith('*'), report.title)
  record(`${name}: 画面のタイトルにも * が付く`, (await page.title()).startsWith('*'), await page.title())
  await page.keyboard.press('Escape')

  await open(page, FIRST, { discardConfirmed: true })
  await page.getByText('y', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.type('z')
  report = await lastReport(page)
  record(`${name}: 選択したセルへ 1 字打っただけで立つ`, report.unsaved, JSON.stringify(report))
  await page.keyboard.press('Escape')

  await open(page, FIRST, { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.type('1')
  report = await lastReport(page)
  record(`${name}: テキストのデバウンス中に立つ`, report.unsaved, JSON.stringify(report))

  await open(page, FIRST, { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 })
  report = await lastReport(page)
  record(`${name}: IME の変換中に立つ`, report.unsaved, JSON.stringify(report))
  await session.send('Input.insertText', { text: '' })

  await open(page, FIRST, { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+f')
  await page.waitForSelector('.cm-panels input', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.type('x')
  record(`${name}: テキストの検索の欄では立たない`, !(await lastReport(page)).unsaved)
  await page.keyboard.press('Escape')

  await h.switchTo(page, '表')
  await page.getByText('x', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+f')
  await page.waitForSelector('.jse-search-box input', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.type('x')
  record(`${name}: 表の検索の欄では立たない`, !(await lastReport(page)).unsaved)
  await page.keyboard.press('Escape')

  await open(page, '/cells.json', { discardConfirmed: true })
  await page.locator('.jse-table-mode td').filter({ hasNotText: '1' }).last().click({ timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.type('z')
  record(`${name}: キーを足せないセルでは立たない`, !(await lastReport(page)).unsaved, await docText(page))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 14。キーとメニューが保存の 1 関数を通る。 */
async function testSaveKeys(browser, base) {
  const name = '保存の経路'
  const { page, problems } = await shellPage(browser, base)
  await open(page, FIRST)
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(INPUT_SETTLE_MS)
  let shown = await state(page)
  record(`${name}: 未編集の Ctrl+S は書かない`, shown.writes === 0)
  record(`${name}: 未編集の Ctrl+S で確認が出ない`, shown.reports.every(({ unsaved }) => !unsaved))

  await editing(page, 'x', 'edited')
  await page.keyboard.press('Control+s')
  await h.reaches(page, () => window.fixture.state().writes === 1)
  shown = await state(page)
  record(`${name}: Ctrl+S が編集中のセルを書く`, shown.written?.includes('edited'), String(shown.written))
  record(`${name}: 保存で印が下りる`, !shown.dirty && !(await lastReport(page)).unsaved)
  record(`${name}: 保存で * が消える`, !(await page.title()).startsWith('*'), await page.title())

  // 条件 14 の (b)
  await page.keyboard.press('Escape')
  await page.locator('.jse-group-button').first().click()
  await h.switchTo(page, '表')
  await editCell(page, 'y', 'second')
  await undo(page)
  await flow(page, 'current')
  shown = await state(page)
  record(`${name}: 編集→undo の保存は書かない`, shown.writes === 1, String(shown.writes))
  record(`${name}: 編集→undo の保存で印が下りる`, !shown.dirty)
  await redo(page)
  await h.reaches(page, () => window.fixture.state().dirty)
  record(`${name}: redo の後は未保存`, (await state(page)).dirty && (await lastReport(page)).unsaved)
  await undo(page)
  await flow(page, 'current')

  // 条件 14 の (c)
  await editCell(page, 'y', 'third')
  await setPicked(page, null)
  let result = await flow(page, 'choosePath')
  record(`${name}: 別名の取り消し`, result === 'cancelled' && (await state(page)).dirty, result)
  await setPicked(page, '/other.json')
  await page.keyboard.press('Control+Shift+s')
  await h.reaches(page, () => window.fixture.state().path === '/other.json')
  shown = await state(page)
  record(`${name}: Ctrl+Shift+S で対象が新しいパスになる`, shown.path === '/other.json' && !shown.dirty, String(shown.path))
  record(`${name}: タイトルが新しいパスになる`, (await page.title()).startsWith('other.json'), await page.title())
  const original = await evaluateFixture(page, 'file', FIRST)
  await editCell(page, 'third', 'fourth')
  await page.keyboard.press('Control+s')
  await h.reaches(page, () => window.fixture.file('/other.json').includes('fourth'))
  record(`${name}: 次の保存は新しいパスへ`, (await evaluateFixture(page, 'file', '/other.json')).includes('fourth'))
  record(`${name}: 元のファイルは変わらない`, (await evaluateFixture(page, 'file', FIRST)) === original, original)

  await page.click('.app-menubar-button:has-text("ファイル")')
  await page.click('.app-menu-item:has-text("名前を付けて保存")')
  await h.reaches(page, () => window.fixture.state().picksForSave === 3)
  record(`${name}: メニューの別名保存`, (await state(page)).picksForSave === 3, String((await state(page)).picksForSave))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 3、13。閉じる確認の「保存」は Rust から届き、結果を印と一緒に返す。 */
async function testSaveAndContinue(browser, base) {
  const name = '閉じる確認の保存'
  const { page, problems } = await shellPage(browser, base)
  const finishedWith = async (id) => {
    await h.reaches(page, (expected) => window.fixture.state().finished.some((item) => item.id === expected), id)
    return (await state(page)).finished.find((item) => item.id === id)
  }

  await open(page, FIRST)
  await editing(page, 'x', 'pending')
  await emit(page, { kind: 'SaveAndContinue', id: 1 })
  let finished = await finishedWith(1)
  let shown = await state(page)
  record(`${name}: 確定前の入力を書く`, shown.written?.includes('pending'), String(shown.written))
  record(`${name}: 成功を印と一緒に返す`, finished?.ok === true && !finished.report.unsaved, JSON.stringify(finished))

  await editCell(page, 'pending', 'second')
  await nextSave(page, { kind: 'ExternalChange' })
  await setAnswers(page, [CANCEL_THIRD])
  await emit(page, { kind: 'SaveAndContinue', id: 2 })
  finished = await finishedWith(2)
  shown = await state(page)
  const external = shown.asks.at(-1)
  record(`${name}: 外部変更の 3 択の既定は別名で保存`, external.buttons[external.default] === '別名で保存', JSON.stringify(external))
  record(`${name}: 外部変更のキャンセルでは閉じない`, finished?.ok === false && finished.report.unsaved, JSON.stringify(finished))
  record(`${name}: 外部変更のキャンセルで書かない`, shown.writes === 1)

  await nextSave(page, { kind: 'Failed', code: 5 })
  await setAnswers(page, [0])
  await emit(page, { kind: 'SaveAndContinue', id: 3 })
  finished = await finishedWith(3)
  record(`${name}: 保存の失敗では閉じない`, finished?.ok === false && finished.report.unsaved, JSON.stringify(finished))

  await nextSave(page, { kind: 'ReadOnly' })
  await setAnswers(page, [0])
  await setPicked(page, null)
  await emit(page, { kind: 'SaveAndContinue', id: 4 })
  finished = await finishedWith(4)
  record(`${name}: 読取専用から別名を取り消すと閉じない`, finished?.ok === false, JSON.stringify(finished))

  await open(page, '/first.json', { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.evaluate(() => window.fixture.typeAt('}', 0, 0))
  await nextSave(page, { kind: 'NeedsConfirm', reasons: ['unparsable'] })
  await setAnswers(page, [1])
  await emit(page, { kind: 'SaveAndContinue', id: 5 })
  finished = await finishedWith(5)
  shown = await state(page)
  const invalid = shown.asks.at(-1)
  record(`${name}: 不正な text は確認が出る`, invalid.body.includes('JSON として読めません'), invalid.body)
  record(`${name}: 不正な text の確認の既定はキャンセル`, invalid.default === invalid.cancel)
  record(`${name}: 不正な text のキャンセルで閉じない`, finished?.ok === false)
  record(`${name}: 不正な text のキャンセルで編集が残る`, (await docText(page)).startsWith('}'), await docText(page))

  await nextSave(page, { kind: 'NeedsConfirm', reasons: ['unparsable'] })
  await setAnswers(page, [SAVE_ANYWAY])
  const result = await flow(page, 'current')
  shown = await state(page)
  record(`${name}: 不正な text を認めると書く`, result === 'saved' && shown.written.startsWith('}'), result)

  await evaluateFixture(page, 'addFile', '/nested-cell.json', '[{"n":[{"m":1}],"k":"kept"}]')
  await open(page, '/nested-cell.json', { discardConfirmed: true })
  await editCell(page, 'kept', 'edited')
  await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: h.STATE_TIMEOUT_MS })
  await page.waitForSelector('dialog[open]', { timeout: h.STATE_TIMEOUT_MS })
  const before = (await state(page)).writes
  await emit(page, { kind: 'SaveAndContinue', id: 6 })
  finished = await finishedWith(6)
  const notice = await page.locator('.app-notice').innerText()
  record(`${name}: モーダルの間は閉じない`, finished?.ok === false, JSON.stringify(finished))
  record(`${name}: モーダルの間は理由を出す`, notice.includes('ダイアログを閉じて'), notice)
  record(`${name}: モーダルの間は書かない`, (await state(page)).writes === before)
  await page.keyboard.press('Control+Shift+s')
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: モーダルの間は保存先を聞かない`, (await state(page)).picksForSave === 1)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 11、14（I9、I14）。 */
async function testOutsideChanges(browser, base) {
  const name = '外部の変更'
  const { page, problems } = await shellPage(browser, base)
  await open(page, FIRST)
  await editCell(page, 'x', 'edited')
  await nextSave(page, { kind: 'ExternalChange' })
  await setAnswers(page, [0])
  await setPicked(page, '/kept.json')
  let result = await flow(page, 'current')
  let shown = await state(page)
  record(`${name}: 既定の別名で保存は元へ書かない`, result === 'saved' && shown.path === '/kept.json', result)
  record(`${name}: 元のファイルが残る`, !(await evaluateFixture(page, 'file', FIRST)).includes('edited'))

  await open(page, FIRST, { discardConfirmed: true })
  await editCell(page, 'x', 'edited')
  await nextSave(page, { kind: 'ExternalChange' })
  await setAnswers(page, [1])
  result = await flow(page, 'current')
  record(`${name}: 上書きを選ぶと書く`, result === 'saved' && (await evaluateFixture(page, 'file', FIRST)).includes('edited'), result)

  await open(page, '/second.json', { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.evaluate(() => window.fixture.typeAt(' ', 0, 0))
  await nextSave(page, { kind: 'Missing' })
  await setAnswers(page, [CANCEL_THIRD])
  result = await flow(page, 'current')
  shown = await state(page)
  record(`${name}: 消失の確認`, result === 'cancelled' && shown.asks.at(-1).buttons[0] === '新しく保存', JSON.stringify(shown.asks.at(-1)))

  await nextSave(page, { kind: 'Unrepresentable', codePoint: 0x1f600, offset: 1 })
  await setAnswers(page, [0])
  await setPicked(page, '/utf8.json')
  result = await flow(page, 'current')
  shown = await state(page)
  record(`${name}: 表せない文字は UTF-8 の別名へ`, result === 'saved' && shown.asks.at(-1).body.includes('U+1F600'), result)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const LF = { eol: 'lf', eolDominant: 'lf' }
const I5_CASES = [
  { label: '字下げ 4', text: '[\n    {\n        "b": "x"\n    }\n]', format: { ...LF, indent: { kind: 'spaces', count: 4 }, finalNewline: false } },
  { label: 'タブ', text: '[\n\t{\n\t\t"b": "x"\n\t}\n]', format: { ...LF, indent: { kind: 'tab' }, finalNewline: false } },
  { label: 'CRLF', text: '[\r\n  {\r\n    "b": "x"\r\n  }\r\n]\r\n', format: { eol: 'crlf', eolDominant: 'crlf', indent: { kind: 'spaces', count: 2 }, finalNewline: true } },
  { label: '末尾改行なし', text: '[\n  {\n    "b": "x"\n  }\n]', format: { ...LF, indent: { kind: 'spaces', count: 2 }, finalNewline: false } },
  { label: '末尾改行あり', text: '[\n  {\n    "b": "x"\n  }\n]\n', format: { ...LF, indent: { kind: 'spaces', count: 2 }, finalNewline: true } },
  { label: '字下げ 12', text: `[\n${' '.repeat(12)}{\n${' '.repeat(24)}"b": "x"\n${' '.repeat(12)}}\n]`, format: { ...LF, indent: { kind: 'spaces', count: 12 }, finalNewline: false } },
  { label: '字下げなし', text: '[{"b":"x"}]', format: { ...LF, indent: { kind: 'none' }, finalNewline: false } }
]

/** I5。表で編集→テキストで打つ→保存で、編集した字だけが変わる。 */
async function testFormatKept(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  for (const [index, { label, text, format }] of I5_CASES.entries()) {
    const name = `I5 ${label}`
    const path = `/i5-${index}.json`
    await evaluateFixture(page, 'addFile', path, text)
    await nextOpen(page, { format })
    await open(page, path, { discardConfirmed: true })
    await h.reachesMode(page, '表')
    await editCell(page, 'x', 'edited')
    await h.switchTo(page, 'テキスト')
    // 画面の字面は、開いたときの書式で書いた文書。CodeMirror の改行は LF
    const at = text.replaceAll('\r\n', '\n').replace('"x"', '"edited"').indexOf('edited')
    await page.evaluate(([from]) => window.fixture.typeAt('Z', from, from), [at])
    await page.waitForTimeout(INPUT_SETTLE_MS)
    const result = await flow(page, 'current')
    const expected = text.replace('"x"', '"Zedited"')
    const written = await evaluateFixture(page, 'file', path)
    record(`${name}: 編集した字だけが変わる`, result === 'saved' && written === expected, JSON.stringify(written))

    await h.switchTo(page, '表')
    await editCell(page, 'Zedited', 'again')
    await flow(page, 'current')
    const writes = (await state(page)).writes
    await h.switchTo(page, 'テキスト')
    await flow(page, 'current')
    const after = await state(page)
    record(`${name}: 保存の後にテキストへ移っただけでは書かない`, after.writes === writes && !after.dirty, String(after.writes - writes))
    await h.switchTo(page, '表')
  }

  await nextOpen(page, { format: I5_CASES.at(-1).format, textOnly: true })
  await evaluateFixture(page, 'addFile', '/compact.json', '[1,2]')
  await open(page, '/compact.json', { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.click('.jse-format', { timeout: h.STATE_TIMEOUT_MS })
  record('I5: 字下げなしの文書でも整形が効く', await h.reaches(page, () => window.fixture.text().includes('\n')), await docText(page))
  record('I5: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 条件 14b。 */
async function testRedoKey(browser, base) {
  const name = 'Ctrl+Y'
  const { page, problems } = await shellPage(browser, base)
  const hasEdit = () => h.reaches(page, () => window.fixture.text().includes('edited'))
  const lacksEdit = () => h.reaches(page, () => !window.fixture.text().includes('edited'))

  await open(page, FIRST)
  await editCell(page, 'x', 'edited')
  await page.keyboard.press('Control+z')
  record(`${name}: 表の undo`, await lacksEdit())
  await page.keyboard.press('Control+y')
  record(`${name}: 表の redo`, await hasEdit())

  await page.keyboard.press('Control+z')
  await lacksEdit()
  await editing(page, 'y', 'cell')
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 編集中のセルでは文書の履歴を動かさない`, !(await docText(page)).includes('edited'), await docText(page))

  await open(page, I19, { discardConfirmed: true })
  await h.switchTo(page, 'ツリー')
  await editCell(page, 'p', 'edited')
  await page.keyboard.press('Control+z')
  record(`${name}: ツリーの undo`, await lacksEdit())
  await page.keyboard.press('Control+y')
  record(`${name}: ツリーの redo`, await hasEdit())

  await open(page, '/second.json', { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ')
  await page.waitForTimeout(INPUT_SETTLE_MS)
  await page.keyboard.press('Control+z')
  record(`${name}: テキストの undo`, await h.reaches(page, () => !window.fixture.text().endsWith(' ')))
  await page.keyboard.press('Control+y')
  record(`${name}: テキストの redo`, await h.reaches(page, () => window.fixture.text().endsWith(' ')))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const NESTED = '/nested-cell.json'
const NESTED_TEXT = '[{"n":[{"m":1},{"m":2}],"k":"kept"}]'

/** CodeMirror は貼り付けを `paste` の中で処理し、`input` を出さない。 */
const pasteInto = (page, selector) =>
  page.evaluate((target) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '[9,9,9]')
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    document.querySelector(target).dispatchEvent(event)
  }, selector)

/** 入れ子のセルのモーダルを開き、本体と別の写しを編集する状態にする。 */
async function nestedModal(browser, base) {
  const context = await shellPage(browser, base)
  const { page } = context
  await page.evaluate(([path, text]) => window.fixture.addFile(path, text), [NESTED, NESTED_TEXT])
  await open(page, NESTED)
  await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: h.STATE_TIMEOUT_MS })
  await page.waitForSelector('dialog[open]', { timeout: h.STATE_TIMEOUT_MS })
  return context
}

async function modalTextView(page) {
  await page.click('dialog[open] .jse-group-button:has-text("テキスト")', { timeout: h.STATE_TIMEOUT_MS })
  await page.click('dialog[open] .cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+End')
}

/** `input` が来ない編集。デバウンスも Apply も待たずに印が立つ。 */
async function testEditKeys(browser, base) {
  const name = '編集のキー'
  const { page, problems } = await shellPage(browser, base)
  const inTextView = async () => {
    await open(page, FIRST, { discardConfirmed: true })
    await h.switchTo(page, 'テキスト')
    await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
    await page.keyboard.press('Control+End')
  }

  const edits = [
    ['Enter', () => page.keyboard.press('Enter')],
    ['Backspace', () => page.keyboard.press('Backspace')],
    ['Ctrl+X', () => page.keyboard.press('Control+x')],
    ['Ctrl+Z', () => page.keyboard.press('Control+z')],
    ['貼り付け', () => pasteInto(page, '.cm-content')]
  ]
  for (const [label, act] of edits) {
    await inTextView()
    await act()
    const report = await lastReport(page)
    record(`${name}: テキストの ${label} で即時に立つ`, report.unsaved, JSON.stringify(report))
  }

  await inTextView()
  for (const key of ['ArrowLeft', 'Home', 'Control+Home', 'Control+a', 'Control+c', 'Escape']) {
    await page.keyboard.press(key)
  }
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 動くだけ、写すだけでは立たない`, !(await lastReport(page)).unsaved)
  // 不正な text の lint のアイコンは fixture の CSP に触れる。製品の CSP は data: の画像を許す
  const real = problems.filter((problem) => !problem.includes('Content Security Policy'))
  record(`${name}: エラーが無い`, real.length === 0, real.slice(0, 2).join(' / '))
  await page.close()

  const modalEdits = [
    ['テキストの Backspace', modalTextView, (target) => target.keyboard.press('Backspace')],
    ['テキストの Enter', modalTextView, (target) => target.keyboard.press('Enter')],
    ['テキストの貼り付け', modalTextView, (target) => pasteInto(target, 'dialog[open] .cm-content')],
    [
      '表の Delete',
      (target) => target.locator('dialog[open] .jse-table-mode td .jse-value').first().click({ timeout: h.STATE_TIMEOUT_MS }),
      (target) => target.keyboard.press('Delete')
    ]
  ]
  for (const [label, prepare, act] of modalEdits) {
    const modal = await nestedModal(browser, base)
    await prepare(modal.page)
    await act(modal.page)
    const report = await lastReport(modal.page)
    const stillOpen = await modal.page.evaluate(() => document.querySelector('dialog[open]') !== null)
    record(`${name}: モーダルの ${label} で Apply の前に立つ`, stillOpen && report.unsaved, JSON.stringify(report))
    await modal.page.close()
  }
}

/** 閉じる確認の保存の間の入力。保存は成功し、印を立てたまま返すので Rust は閉じない。 */
async function testEditDuringCloseSave(browser, base) {
  const name = '閉じる確認の保存の間の入力'
  const { page, problems } = await shellPage(browser, base)
  await open(page, FIRST)
  await h.switchTo(page, 'テキスト')
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ')
  await page.waitForTimeout(INPUT_SETTLE_MS)

  const before = await page.evaluate(() => {
    window.fixture.holdSave()
    return window.fixture.saveStarts()
  })
  await emit(page, { kind: 'SaveAndContinue', id: 1 })
  await h.reaches(page, (started) => window.fixture.saveStarts() > started, before)
  await page.keyboard.press('Enter')
  await page.evaluate(() => window.fixture.releaseSave())
  await h.reaches(page, () => window.fixture.state().finished.length === 1)
  const [finished] = (await state(page)).finished
  record(`${name}: 保存は成功し、印を立てて返す`, finished.ok && finished.report.unsaved, JSON.stringify(finished))
  await page.waitForTimeout(INPUT_SETTLE_MS)
  const shown = await state(page)
  record(`${name}: 入力はエディタに残り、書かれていない`, !shown.written.endsWith('\n') && shown.dirty, String(shown.written))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 未編集でも、ディスクの実物を見る。同じなら書かず、違えば編集済みと同じ 3 択へ入る。 */
async function testUneditedSaveLooksAtDisk(browser, base) {
  const name = '未編集の保存とディスク'
  const { page, problems } = await shellPage(browser, base)
  const flow = (destination) => page.evaluate((target) => window.fixture.flow(target), destination)
  const file = () => page.evaluate((path) => window.fixture.file(path), FIRST)
  const lastAsk = async () => (await state(page)).asks.at(-1)

  await open(page, FIRST)
  const original = await file()
  let result = await flow('current')
  let shown = await state(page)
  record(`${name}: ディスクが同じなら書かず聞かない`, result === 'noChange' && shown.writes === 0 && shown.asks.length === 0, result)

  await page.evaluate((path) => window.fixture.removeFile(path), FIRST)
  await setAnswers(page, [CANCEL_THIRD])
  result = await flow('current')
  let ask = await lastAsk()
  record(`${name}: 消えたファイルの Ctrl+S は 3 択`, result === 'cancelled' && ask.title === 'ファイルが見つかりません' && ask.buttons.length === 3, JSON.stringify(ask))
  await setPicked(page, FIRST)
  await setAnswers(page, [CANCEL_THIRD])
  result = await flow('choosePath')
  record(`${name}: 消えたファイルの同じパスの別名保存も 3 択`, result === 'cancelled' && (await lastAsk()).title === 'ファイルが見つかりません', result)
  await setAnswers(page, [0])
  result = await flow('current')
  record(`${name}: 新しく保存で基準を書く`, result === 'saved' && (await file()) === original, result)

  await page.evaluate((path) => window.fixture.addFile(path, '[2]'), FIRST)
  await setPicked(page, FIRST)
  await setAnswers(page, [CANCEL_THIRD])
  result = await flow('choosePath')
  ask = await lastAsk()
  record(`${name}: 外部で変わったファイルの同じパスの別名保存は 3 択`, result === 'cancelled' && ask.title === 'ファイルが変更されています' && ask.buttons.length === 3, JSON.stringify(ask))
  record(`${name}: 断ると外部の内容のまま`, (await file()) === '[2]')
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

export async function testShell(browser, base, helpers) {
  h = helpers
  await testDefaultViews(browser, base)
  await testConfirmations(browser, base)
  await testOuterKept(browser, base)
  await testHistoryEnds(browser, base)
  await testTargetInvalidated(browser, base)
  await testSwitchWhileEditing(browser, base)
  await testWholeDocument(browser, base)
  await testRoundTrip(browser, base)
  await testMenu(browser, base)
  await testSplashCeremony(browser, base)
  await testShellEvents(browser, base)
  await testFonts(browser, base)
  await testEditMark(browser, base)
  await testEditKeys(browser, base)
  await testSaveKeys(browser, base)
  await testSaveAndContinue(browser, base)
  await testEditDuringCloseSave(browser, base)
  await testUneditedSaveLooksAtDisk(browser, base)
  await testOutsideChanges(browser, base)
  await testFormatKept(browser, base)
  await testRedoKey(browser, base)
  await testDark(browser, base, h)
  await testContrast(browser, base, h)
  await testLanguage(browser, base, h)
}
