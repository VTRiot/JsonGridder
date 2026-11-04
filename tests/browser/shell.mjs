// アプリの殻の試験。実物のエディタ、文書モデル、殻をつなぎ、Rust の呼び出しだけを偽物にする。
import { parse, stringify } from 'lossless-json'
import { testContrast } from './contrast.mjs'
import { testDark } from './dark.mjs'
import { testLanguage } from './language.mjs'
import { testTranslate } from './translate.mjs'

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

/**
 * テキストの表示の lint の誤りの印（ガター）が出るまで待ち、描き方を返す（B68）。
 * 印の描画の後に 2 フレーム待つので、画像を読もうとしていれば CSP の違反（window.__csp）がここで見える。
 */
async function lintMarkerFacts(page) {
  const shown = await page
    .waitForSelector('.cm-lint-marker-error', { timeout: h.STATE_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false)
  return page.evaluate(
    (found) =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const marker = document.querySelector('.cm-lint-marker-error')
            const style = marker ? getComputedStyle(marker) : null
            const box = marker?.getBoundingClientRect()
            resolve({
              shown: found,
              content: style?.content,
              painted: Boolean(box && box.width > 0 && style.backgroundColor !== 'rgba(0, 0, 0, 0)'),
              blocked: window.__csp.filter((entry) => entry.startsWith('img-src'))
            })
          })
        )
      ),
    shown
  )
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

/** 左ペイン（D7）の項目を押す。ラベルは配列のパス（根の配列は「文書全体」）。 */
async function pickTarget(page, label) {
  await page.click(`.app-target-pane-item[data-label="${label}"]`, { timeout: h.STATE_TIMEOUT_MS })
}

/** 左ペインの今の中身。隠れていれば shown が false。 */
const paneFacts = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.app-target-pane')
    return {
      shown: pane !== null && !pane.hidden,
      items: [...document.querySelectorAll('.app-target-pane-item')].map(
        (item) => `${item.dataset.label}:${item.querySelector('.app-target-pane-count')?.textContent}${item.classList.contains('is-selected') ? '*' : ''}`
      ),
      more: document.querySelector('.app-target-pane-more')?.textContent ?? null
    }
  })
const reachesPane = (page, expected) =>
  h.reaches(
    page,
    (want) => {
      const pane = document.querySelector('.app-target-pane')
      const shown = pane !== null && !pane.hidden
      if (want === null) return !shown
      const items = [...document.querySelectorAll('.app-target-pane-item')].map(
        (item) => `${item.dataset.label}:${item.querySelector('.app-target-pane-count')?.textContent}${item.classList.contains('is-selected') ? '*' : ''}`
      )
      return shown && items.join('|') === want
    },
    expected
  )

function record(name, passed, detail = '') {
  h.record(name, passed, detail)
}

/**
 * 開いて表へ移る。正しい文書は既定でツリーで開く（Step10 D3）ので、表を前提にする試験はここから始める。
 * 表の対象は開くときに選ばれた候補の先頭のまま。
 */
async function openTable(page, path, options = {}) {
  const outcome = await open(page, path, options)
  await h.switchTo(page, '表')
  return outcome
}

/** 条件 10。開いた文書の既定の表示。Step10 D3 で、正しい文書は全部ツリー。表の対象には候補の先頭が入る。 */
async function testDefaultViews(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  const cases = [
    ['/first.json', 'ツリー', []],
    ['/object.json', 'ツリー', ITEMS],
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

  // 表の対象に入れておいた候補の先頭が、Table を押すと出る
  await open(page, '/object.json', { discardConfirmed: true })
  await h.switchTo(page, '表')
  const headers = (await page.locator('.jse-table-mode th').allInnerTexts()).map((s) => s.trim())
  record('既定の表示 Table を押すと候補の先頭（items）が表に出る', headers.includes('a') && sameTarget((await state(page)).target, ITEMS), headers.join('|'))

  await nextOpen(page, { textOnly: true })
  await open(page, '/broken.json')
  record('既定の表示 不正な JSON: テキスト', await h.reachesMode(page, 'テキスト'))
  const switchFacts = await page.evaluate(() =>
    [...document.querySelectorAll('.app-view-switch-button')].map((b) => [b.getAttribute('aria-checked'), b.getAttribute('aria-disabled')].join())
  )
  record('既定の表示 不正な JSON: 切り替えはどちらも選ばず押せない', switchFacts.join('|') === 'false,true|false,true', switchFacts.join('|'))
  // 押せない印（aria-disabled）の付いたボタンを実際に押す。表へ入らないことを見る
  await page.click('.app-view-switch-button[data-mode="table"]', { timeout: h.STATE_TIMEOUT_MS, force: true })
  record('既定の表示 不正な JSON: Table を押しても表へ入らない', (await page.locator('.jse-table-mode').count()) === 0 && (await h.reachesMode(page, 'テキスト')))
  const upstream = await page.locator('.jse-main .jse-group-button').count()
  record('既定の表示 主の画面に上流の表示のボタンが無い', upstream === 0, String(upstream))

  await page.evaluate(() => window.fixture.emit({ kind: 'Open', path: 'C:\\docs\\日本語 😀.json', discardConfirmed: false }))
  const titled = await h.reaches(page, () => /^日本語 😀\.json - JsonGridder \d+\.\d+\.\d+/.test(document.title))
  record('タイトルは ファイル名 - JsonGridder 版', titled, await page.title())
  const { titles } = await state(page)
  record('タイトルを窓へ渡す', titles.at(-1) === (await page.title()), titles.at(-1))
  record('既定の表示: エラーが無い', problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const bannerFacts = (page) =>
  page.evaluate(() => {
    const banner = document.querySelector('.app-invalid-banner')
    return { shown: banner !== null && !banner.hidden, kind: banner?.dataset.kind ?? null, text: banner?.innerText.trim() ?? '' }
  })
const reachesBanner = (page, kind) =>
  h.reaches(
    page,
    (expected) => {
      const banner = document.querySelector('.app-invalid-banner')
      return expected === null ? banner?.hidden === true : banner?.hidden === false && banner.dataset.kind === expected
    },
    kind
  )
const statusFacts = (page) =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll('.app-status-row .app-status-item')].map((item) => [item.dataset.item, item.innerText.trim()]))
  )
const reachesStatus = (page, item, text) =>
  h.reaches(
    page,
    ([name, expected]) => {
      const found = document.querySelector(`.app-status-row [data-item="${name}"]`)
      return expected === null ? found === null : found?.innerText.trim() === expected
    },
    [item, text]
  )

/** D6、D12。テキストでしか開けない文書の警告の帯と、隠す表示。Rust の理由は検査の表から引く。 */
async function testInvalidBanner(browser, base) {
  const name = '警告の帯'
  const { page, problems } = await shellPage(browser, base)
  // 実物と同じく、Rust がテキストに限ると判定した文書として開く
  const openTextOnly = async (path) => {
    await nextOpen(page, { textOnly: true })
    return open(page, path, { discardConfirmed: true })
  }

  await openTextOnly('/duplicate.json')
  record(`${name}: 重複キーの文書はテキスト`, await h.reachesMode(page, 'テキスト'))
  record(`${name}: 重複キーの帯が出る`, await reachesBanner(page, 'duplicateKey'), JSON.stringify(await bannerFacts(page)))
  let facts = await bannerFacts(page)
  record(
    `${name}: 重複キーはキー名と 2 つの位置`,
    facts.text === 'この .json は不正です。不正の理由: キー「a」が 2 か所にあります（2 行 3 列と 3 行 3 列）。',
    facts.text
  )
  record(`${name}: 帯は文書を書き換えない`, (await docText(page)) === (await page.evaluate(() => window.fixture.file('/duplicate.json'))))
  const switchFacts = await page.evaluate(() => [...document.querySelectorAll('.app-view-switch-button')].map((b) => b.getAttribute('aria-disabled')).join())
  record(`${name}: Tree と Table は押せない`, switchFacts === 'true,true', switchFacts)
  record(`${name}: 左ペインを出さない（D12）`, await reachesPane(page, null), JSON.stringify(await paneFacts(page)))
  record(`${name}: 状態の行に件数を出さない（D12）`, await reachesStatus(page, 'rows', null), JSON.stringify(await statusFacts(page)))
  record(`${name}: 状態の行は文字コード、改行、保存の状態`, await reachesStatus(page, 'save', '保存済み'), JSON.stringify(await statusFacts(page)))
  let status = await statusFacts(page)
  record(`${name}: 文字コードと改行`, status.encoding === 'UTF-8' && status.eol === 'LF', JSON.stringify(status))

  // 不正のまま打鍵すると、帯は残る（理由が表に無い入力は総称の文言）
  const before = await docText(page)
  await page.evaluate(([from]) => window.fixture.typeAt(' ', from), [before.length])
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 不正のまま打鍵しても帯が残る`, await reachesBanner(page, 'unknown'), JSON.stringify(await bannerFacts(page)))
  facts = await bannerFacts(page)
  record(`${name}: 理由が取れないときは総称の文言`, facts.text === 'この .json は不正です。不正の理由: 表とツリーで内容を保てない文書です。', facts.text)

  // 直すと帯が消え、Tree へ移れる
  const typed = await docText(page)
  const second = typed.lastIndexOf('"a"')
  await page.evaluate(([from, to]) => window.fixture.typeAt('"b"', from, to), [second, second + 3])
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 直すと帯が消える`, await reachesBanner(page, null), JSON.stringify(await bannerFacts(page)))
  record(`${name}: 直すと Tree へ移れる`, await h.switchTo(page, 'ツリー'))
  record(`${name}: 直した文書はツリーでも帯が無い`, (await bannerFacts(page)).shown === false)
  record(`${name}: 直した文書が残る`, canonical(await docText(page)) === '{"a":1,"b":2}', await docText(page))
  record(`${name}: 編集したので未保存`, await reachesStatus(page, 'save', '未保存'), JSON.stringify(await statusFacts(page)))

  // undo でテキストへ戻った正しい文書では帯を出さない
  await page.evaluate(() => window.fixture.setMode('text'))
  record(`${name}: テキストへ戻った正しい文書`, await h.reachesMode(page, 'テキスト'))
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 正しい文書のテキストの表示では帯を出さない`, (await bannerFacts(page)).shown === false)
  const enabled = await page.evaluate(() => [...document.querySelectorAll('.app-view-switch-button')].map((b) => `${b.getAttribute('aria-checked')}/${b.getAttribute('aria-disabled')}`).join())
  record(`${name}: 正しい文書のテキストの表示ではどちらも選ばず押せる`, enabled === 'false/false,false/false', enabled)
  record(`${name}: 正しい文書のテキストの表示でも件数を出さない`, await reachesStatus(page, 'rows', null))
  const cases = [
    ['/reserved.json', 'reservedKey', 'キー「constructor」は表とツリーで扱えない名前です（2 行 2 列）。'],
    ['/deep.json', 'depthExceeded', '入れ子が 1000 段を超えています（1 行 1001 列）。'],
    ['/broken.json', 'syntax', '1 行 9 列で JSON の書き方が正しくありません。']
  ]
  for (const [path, kind, reason] of cases) {
    await openTextOnly(path)
    const shown = await reachesBanner(page, kind)
    facts = await bannerFacts(page)
    record(`${name} ${path}: ${kind} の帯`, shown && facts.text === `この .json は不正です。不正の理由: ${reason}`, facts.text)
    record(`${name} ${path}: Table を押しても表へ入らない`, !(await h.switchTo(page, '表')) && (await h.reachesMode(page, 'テキスト')))
  }

  // 言語を替えると帯の文言も替わる
  await page.evaluate(() => window.fixture.setLanguage('en'))
  record(
    `${name}: 英語の帯`,
    await h.reaches(page, () => document.querySelector('.app-invalid-banner')?.innerText.trim() === 'This .json is invalid. Reason: JSON syntax error at line 1, column 9.'),
    (await bannerFacts(page)).text
  )
  record(`${name}: 英語の状態の行`, await reachesStatus(page, 'save', 'Saved'), JSON.stringify(await statusFacts(page)))
  await page.evaluate(() => window.fixture.setLanguage('ja'))

  // 正しい文書を開くと帯が消える。件数は表のときだけ
  await open(page, '/first.json', { discardConfirmed: true })
  record(`${name}: 正しい文書を開くと帯が消える`, await reachesBanner(page, null))
  record(`${name}: ツリーでは件数を出さない`, await reachesStatus(page, 'rows', null), JSON.stringify(await statusFacts(page)))
  await h.switchTo(page, '表')
  record(`${name}: 表では今の対象の件数`, await reachesStatus(page, 'rows', '2 件'), JSON.stringify(await statusFacts(page)))
  await open(page, '/i19.json', { discardConfirmed: true })
  await h.switchTo(page, '表')
  // 利用者が対象を選ぶ経路（表の対象の行）で替える
  await pickTarget(page, 'meta.rows')
  record(`${name}: 対象を替えると件数も替わる`, await reachesStatus(page, 'rows', '1 件'), JSON.stringify(await statusFacts(page)))

  await nextOpen(page, { encoding: 'shiftJis', format: { eol: 'crlf', eolDominant: 'crlf', indent: { kind: 'spaces', count: 2 }, finalNewline: true } })
  await open(page, '/crlf.json', { discardConfirmed: true })
  record(`${name}: 開いたファイルの文字コード`, await reachesStatus(page, 'encoding', 'Shift_JIS'), JSON.stringify(await statusFacts(page)))
  record(`${name}: 開いたファイルの改行`, await reachesStatus(page, 'eol', 'CRLF'), JSON.stringify(await statusFacts(page)))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
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

  await openTable(page, '/first.json')
  await editCell(page, 'x', 'edited')
  outcome = await open(page, '/second.json')
  shown = await state(page)
  record('未保存なら開かず Rust へ判断を渡す', outcome.kind === 'NeedsUnsavedDecision' && shown.dirty, outcome.kind)
  record('判断は開く先のパスで Rust へ行く', shown.openRequests.at(-1) === '/second.json', shown.openRequests.join())
  record('未保存の判断の間は編集が残る', (await docText(page)).includes('edited'))
  outcome = await open(page, '/second.json', { discardConfirmed: true })
  record('破棄の決定で開く', outcome.kind === 'Opened', outcome.kind)

  // 開く処理は確認より先に入力を確定する。断っても利用者の入力は消えず、未保存として残る
  await openTable(page, '/first.json')
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
  record('10 MB 超の配列もツリーで開く', await h.reachesMode(page, 'ツリー'))

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
  await openTable(page, I19)
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

  const reopened = await openTable(page, I19)
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

  await openTable(page, SLASH_KEY, { discardConfirmed: true })
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

// 主の画面の元に戻すとやり直すはコマンドの行（S4）。押す関数は上流の項目のまま
const COMMAND = (name) => `.app-command-button[data-command="${name}"]`
const undo = (page) => page.click(COMMAND('undo'), { timeout: h.STATE_TIMEOUT_MS })
const redo = (page) => page.click(COMMAND('redo'), { timeout: h.STATE_TIMEOUT_MS })

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
  await openTable(page, I19)
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
  for (const { name, path, find, replace, pane } of [
    { name: '対象の改名', path: I19, find: '"items"', replace: '"renamed"', pane: 'renamed:2|meta.rows:1|tags:2' },
    { name: '対象の削除', path: '/delete.json', find: ',"items":[{"a":1}]', replace: '', pane: null }
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
    // 左ペインは今の文書の配列を出し、どれにも印を付けない。配列が無くなれば出さない（D12）
    record(`${name}: 左ペインが今の文書に合う`, await reachesPane(page, pane), JSON.stringify(await paneFacts(page)))
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
  await openTable(page, I19)
  await editCell(page, 'x', 'edited', { commit: false })
  await pickTarget(page, 'meta.rows')
  record(`${name}: 替わる`, await reachesTarget(page, ROWS))
  record(`${name}: 入力が文書に残る`, parse(await docText(page)).items[0].name === 'edited', await docText(page))
  const table = await page.locator('.jse-table-mode').innerText()
  record(`${name}: 新しい対象が表に出る`, table.includes('v') && !table.includes('edited'), table.slice(0, 80))
  record(`${name}: 左ペインの印が替わる`, await reachesPane(page, 'items:2|meta.rows:1*|tags:2'), JSON.stringify(await paneFacts(page)))
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
  await openTable(page, I19)
  // 根がオブジェクトの文書の「文書全体」は表にできる配列ではないので、左ペインに出さない（D7、D12）
  const facts = await paneFacts(page)
  record(`${name}: 根がオブジェクトなら左ペインに文書全体が無い`, facts.shown && !facts.items.some((item) => item.startsWith('文書全体')), JSON.stringify(facts))
  // 対象が空になる経路（テキストで対象を消した後など）は残る。器の公開の口で空にして、案内の画面を出す
  await setTarget(page, [])
  record(`${name}: 対象が空になる`, await reachesTarget(page, []))
  await page.click('.jse-nested-array-action:has-text("編集")', { timeout: h.STATE_TIMEOUT_MS }).catch(async () => {
    await page.click('.jse-nested-array-action', { timeout: h.STATE_TIMEOUT_MS })
  })
  record(`${name}: 案内の Edit は対象を替える`, await reachesTarget(page, ITEMS), JSON.stringify((await state(page)).target))
  record(`${name}: モーダルを開かない`, (await page.locator('dialog[open]').count()) === 0)
  record(`${name}: 案内の Edit の後は左ペインの印が付く`, await reachesPane(page, 'items:2*|meta.rows:1|tags:2'), JSON.stringify(await paneFacts(page)))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** D7、D13、D12。左ペイン「表にできる配列」。ツリーで押すと表で開き、表で押すと対象を替える。 */
async function testTargetPane(browser, base) {
  const name = '左ペイン'
  const { page, problems } = await shellPage(browser, base)

  // 既定はツリー。ツリーでも件数つきで出し、表の対象（候補の先頭）に印を付ける
  await open(page, I19)
  record(`${name}: 開いた直後はツリー`, await h.reachesMode(page, 'ツリー'))
  record(`${name}: ツリーでも件数つきで出す（D13）`, await reachesPane(page, 'items:2*|meta.rows:1|tags:2'), JSON.stringify(await paneFacts(page)))
  const title = await page.evaluate(() => document.querySelector('.app-target-pane-title')?.textContent)
  record(`${name}: 見出しは辞書から`, title === '表にできる配列', title)
  const placed = await page.evaluate(() => {
    const pane = document.querySelector('.app-target-pane').getBoundingClientRect()
    const editor = document.querySelector('.app-editor').getBoundingClientRect()
    return pane.right <= editor.left + 1 && Math.abs(pane.top - editor.top) <= 1
  })
  record(`${name}: エディタの左に並ぶ`, placed)

  // ツリーで押すと、その配列を表で開く
  await pickTarget(page, 'meta.rows')
  record(`${name}: ツリーで押すと表へ移る`, await h.reachesMode(page, '表'))
  record(`${name}: ツリーで押した配列が表の対象`, await reachesTarget(page, ROWS), JSON.stringify((await state(page)).target))
  const headers = (await page.locator('.jse-table-mode th').allInnerTexts()).map((s) => s.trim())
  record(`${name}: その配列の列が表に出る`, headers.includes('k'), headers.join('|'))
  record(`${name}: 印が押した項目へ移る`, await reachesPane(page, 'items:2|meta.rows:1*|tags:2'), JSON.stringify(await paneFacts(page)))
  record(`${name}: 状態の行の件数も替わる`, await reachesStatus(page, 'rows', '1 件'), JSON.stringify(await statusFacts(page)))

  // 表で押すと対象を替え、表のまま
  await pickTarget(page, 'tags')
  record(`${name}: 表で押すと対象を替える`, await reachesTarget(page, ['tags']))
  record(`${name}: 表のまま`, await h.reachesMode(page, '表'))
  record(`${name}: 押しても未保存にならない`, !(await state(page)).dirty)

  // ツリーへ戻っても、印は表の対象のまま（次に Table を押すと出る配列）
  await h.switchTo(page, 'ツリー')
  record(`${name}: ツリーへ戻っても印は表の対象`, await reachesPane(page, 'items:2|meta.rows:1|tags:2*'), JSON.stringify(await paneFacts(page)))

  // 正しい文書のテキストの表示（undo で戻った形）では出さない（D12）
  await page.evaluate(() => window.fixture.setMode('text'))
  record(`${name}: テキストの表示`, await h.reachesMode(page, 'テキスト'))
  record(`${name}: テキストの表示では出さない（D12）`, await reachesPane(page, null), JSON.stringify(await paneFacts(page)))
  await h.switchTo(page, 'ツリー')
  record(`${name}: ツリーへ戻ると出る`, await reachesPane(page, 'items:2|meta.rows:1|tags:2*'), JSON.stringify(await paneFacts(page)))

  // テキストでしか開けない文書は、配列があっても出さない（D12）
  await nextOpen(page, { textOnly: true })
  await open(page, I19, { discardConfirmed: true })
  record(`${name}: テキストでしか開けない文書はテキスト`, await h.reachesMode(page, 'テキスト'))
  record(`${name}: テキストでしか開けない文書では出さない（D12）`, await reachesPane(page, null), JSON.stringify(await paneFacts(page)))

  // 根の配列は「文書全体」。候補の無い文書では出さない
  await open(page, '/first.json', { discardConfirmed: true })
  record(`${name}: 根の配列は文書全体`, await reachesPane(page, '文書全体:2*'), JSON.stringify(await paneFacts(page)))
  await open(page, '/plain.json', { discardConfirmed: true })
  record(`${name}: 候補の無い文書では出さない（D12）`, await reachesPane(page, null), JSON.stringify(await paneFacts(page)))

  // 上限を超えた分は「ほか N 件」
  const many = JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`k${index}`, [index]])))
  await page.evaluate((text) => window.fixture.addFile('/many.json', text), many)
  await open(page, '/many.json', { discardConfirmed: true })
  const reachedMore = await h.reaches(page, () => document.querySelector('.app-target-pane-more')?.textContent === 'ほか 2 件')
  const manyFacts = await paneFacts(page)
  record(`${name}: 99 件まで出し、残りは「ほか 2 件」`, reachedMore && manyFacts.items.length === 99, `${manyFacts.items.length} ${manyFacts.more}`)

  // Options の切り替え（D13）。ツリーでは出さず、表では出す。設定へ保存する
  await open(page, I19, { discardConfirmed: true })
  const toggle = async () => {
    await page.click('.app-menubar-button:has-text("オプション")')
    await page.click('.app-menu-item:has-text("ツリーのときは左ペインを出さない")')
  }
  await toggle()
  record(`${name}: 切り替えるとツリーでは出さない`, await reachesPane(page, null), JSON.stringify(await paneFacts(page)))
  await h.switchTo(page, '表')
  record(`${name}: 切り替えても表では出す`, await reachesPane(page, 'items:2*|meta.rows:1|tags:2'), JSON.stringify(await paneFacts(page)))
  await page.click('.app-menubar-button:has-text("オプション")')
  const checked = await page.locator('.app-menu-item:has-text("ツリーのときは左ペインを出さない")').getAttribute('aria-checked')
  record(`${name}: Options の項目に印が付く`, checked === 'true', String(checked))
  await page.keyboard.press('Escape')
  await h.switchTo(page, 'ツリー')
  await toggle()
  record(`${name}: 戻すとツリーで出る`, await reachesPane(page, 'items:2*|meta.rows:1|tags:2'), JSON.stringify(await paneFacts(page)))
  const calls = await page.evaluate(() => window.fixture.state().hideTargetsCalls)
  record(`${name}: 選んだ順に設定へ保存する`, JSON.stringify(calls) === '[true,false]', JSON.stringify(calls))
  record(`${name}: 切り替えで文書と印が変わらない`, !(await state(page)).dirty)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()

  // 起動の設定で切り替えが入っていれば、ツリーで出さない
  const started = await h.openPage(browser, `${base}?shell&hideTargets=on`)
  await started.page.waitForFunction(() => window.fixture !== undefined)
  await open(started.page, I19)
  record(`${name}: 起動の設定が効く`, await h.reaches(started.page, () => {
    const pane = document.querySelector('.app-target-pane')
    return window.fixture.state().mode === 'tree' && pane !== null && pane.hidden
  }))
  await h.switchTo(started.page, '表')
  record(`${name}: 起動の設定でも表では出す`, await reachesPane(started.page, 'items:2*|meta.rows:1|tags:2'), JSON.stringify(await paneFacts(started.page)))
  record(`${name}: 起動の設定: エラーが無い`, started.problems.length === 0, started.problems.slice(0, 2).join(' / '))
  await started.page.close()
}

/** I1。開く→全部の表示と対象を回す→保存で 1 バイトも書かない。 */
async function testRoundTrip(browser, base) {
  const { page, problems } = await shellPage(browser, base)
  for (const { path, targets } of [
    // 左ペインの項目を順に押す。根がオブジェクトの文書には「文書全体」が無い（D12）。根の配列には有る
    { path: '/crlf-object.json', targets: ['items'] },
    { path: I19, targets: ['meta.rows', 'tags', 'items'] },
    { path: '/crlf.json', targets: ['文書全体'] }
  ]) {
    const name = `I1 ${path}`
    await openTable(page, path, { discardConfirmed: true })
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
  await openTable(page, '/first.json')
  const labels = await page.locator('.app-menubar-button').allInnerTexts()
  record(`${name}: 4 つのメニュー（Edit は File と Options の間）`, labels.join() === 'ファイル(F),編集(E),オプション(O),ヘルプ(H)', labels.join())

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
  record(`${name}: About は版を出す`, (await state(page)).asks.at(-1)?.body.includes('0.2.0'), JSON.stringify((await state(page)).asks.at(-1)))
  await page.click('.app-menubar-button:has-text("ファイル")')
  await page.click('.app-menu-item:has-text("終了")')
  record(`${name}: 終了`, (await state(page)).exits === 1)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const TRANSLATION_DIALOG = 'dialog.app-translation-dialog'
const FAKE_KEY = 'test-not-a-real-key-AbCdEf0123456789'

/** 翻訳の設定のダイアログ（Step10-002 T3）。Options から開き、キーを画面に残さず、保存の失敗を成功と言わない。 */
async function testTranslationSettings(browser, base) {
  const name = '翻訳の設定'
  const { page, problems } = await shellPage(browser, base)
  await openTable(page, '/first.json')
  const before = await docText(page)
  const openDialog = async () => {
    await page.click('.app-menubar-button:has-text("オプション")')
    await page.click('.app-menu-item:has-text("翻訳の設定")')
    return page.waitForSelector(`${TRANSLATION_DIALOG}[open]`, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  }
  record(`${name}: Options から開く`, await openDialog())
  record(`${name}: モーダルとして出る（ダイアログの外は操作できない）`, await page.evaluate((selector) => document.querySelector(selector)?.matches(':modal') === true, TRANSLATION_DIALOG))
  const slot = (tier, selector) => `${TRANSLATION_DIALOG} .app-translation-key-block[data-tier="${tier}"] ${selector}`
  const tiersShown = await page.evaluate(
    (selector) => [...document.querySelectorAll(`${selector} .app-translation-key-block`)].map((block) => block.dataset.tier),
    TRANSLATION_DIALOG
  )
  record(`${name}: 無料枠用と有料用のキーの欄が 2 つある`, JSON.stringify(tiersShown) === JSON.stringify(['free', 'paid']), JSON.stringify(tiersShown))
  record(`${name}: 無料枠か有料かのラジオは無い`, (await page.locator(`${TRANSLATION_DIALOG} input[type="radio"]`).count()) === 0)
  const freeShown = await page.isVisible(slot('free', '[data-notice="free"]'))
  const freeText = await page.locator(slot('free', '[data-notice="free"]')).innerText()
  record(`${name}: 無料枠の欄に製品の改善の注記が見える`, freeShown && freeText.includes('製品の改善'), freeText)
  // 注記は地の文: 縁も地の色も無い（入力欄に見えない）
  const noteStyle = await page.evaluate((selector) => {
    const style = getComputedStyle(document.querySelector(selector))
    return { border: style.borderTopStyle, background: style.backgroundColor }
  }, slot('free', '[data-notice="free"]'))
  record(
    `${name}: 無料枠の注記は囲みの無い地の文`,
    noteStyle.border === 'none' && (noteStyle.background === 'rgba(0, 0, 0, 0)' || noteStyle.background === 'transparent'),
    JSON.stringify(noteStyle)
  )
  record(`${name}: 既定は無効`, !(await page.isChecked(`${TRANSLATION_DIALOG} [data-field="enabled"]`)))
  record(`${name}: 以前のキーが無ければ移す欄は出ない`, !(await page.isVisible(`${TRANSLATION_DIALOG} [data-legacy]`)))

  // 保存できなかった（読み直しで無い）キー: 誤りを出し、入力欄は空、成功と言わない
  await page.evaluate(() => window.fixture.loseKeyWrites(true))
  await page.fill(slot('free', '.app-translation-key-input'), FAKE_KEY)
  await page.click(slot('free', '[data-action="saveKey"]'))
  await page.waitForSelector('.app-translation-message:not([hidden])', { timeout: h.STATE_TIMEOUT_MS })
  const failed = await page.locator('.app-translation-message').innerText()
  record(`${name}: 保存できなかったキーは誤りとして出る`, failed.includes('保存できませんでした') && !failed.includes('保存しました'), failed)
  record(`${name}: 失敗の後の入力欄は空`, (await page.inputValue(slot('free', '.app-translation-key-input'))) === '')
  record(`${name}: 失敗の後は未設定のまま`, (await page.locator(slot('free', '.app-translation-key-status')).innerText()) === '未設定')

  // 保存できるキー（有料の欄で Enter で保存）
  await page.evaluate(() => window.fixture.loseKeyWrites(false))
  await page.fill(slot('paid', '.app-translation-key-input'), FAKE_KEY)
  await page.press(slot('paid', '.app-translation-key-input'), 'Enter')
  const saved = await h.reaches(
    page,
    (selector) => document.querySelector(selector)?.dataset.saved === 'true',
    slot('paid', '.app-translation-key-status')
  )
  record(`${name}: 有料の欄で Enter でキーを保存し、その欄だけ保存済みと出る`, saved && (await page.locator(slot('free', '.app-translation-key-status')).innerText()) === '未設定')
  record(`${name}: Enter でダイアログが閉じない`, await page.isVisible(TRANSLATION_DIALOG))
  const html = await page.evaluate(() => document.documentElement.outerHTML)
  const probe = FAKE_KEY.slice(-12)
  record(`${name}: キーは画面のどこにも残らない`, !html.includes(probe) && (await page.inputValue(slot('paid', '.app-translation-key-input'))) === '')
  const calls = await page.evaluate(() => window.fixture.translation())
  record(
    `${name}: キーは 2 回の操作で 2 回だけ、押した欄の枠で渡る`,
    JSON.stringify(calls.keyLengths) === JSON.stringify([FAKE_KEY.length, FAKE_KEY.length]) && JSON.stringify(calls.keyTiersSaved) === JSON.stringify(['free', 'paid']),
    JSON.stringify(calls)
  )

  // 有効にして保存すると閉じて殻へ届く。無料枠か有料かは保存しない
  await page.check(`${TRANSLATION_DIALOG} [data-field="enabled"]`)
  await page.click(`${TRANSLATION_DIALOG} [data-action="save"]`)
  record(`${name}: 保存で閉じる`, await h.reaches(page, (selector) => document.querySelector(selector) === null, TRANSLATION_DIALOG))
  const after = await page.evaluate(() => window.fixture.translation())
  record(
    `${name}: 値を 1 回で保存し、殻が有効を知る（tier は送らない）`,
    after.saves.length === 1 && after.saves[0].enabled === true && !('tier' in after.saves[0]) && after.saves[0].machineNotice === true && after.enabledInShell === true,
    JSON.stringify(after)
  )

  // Esc で閉じる。取り消しは保存しない
  record(
    `${name}: 開き直すと保存した値が出る`,
    (await openDialog()) && (await page.isChecked(`${TRANSLATION_DIALOG} [data-field="enabled"]`)) && (await page.locator(slot('paid', '.app-translation-key-status')).innerText()).startsWith('保存済み')
  )
  await page.fill(slot('free', '.app-translation-key-input'), FAKE_KEY)
  await page.keyboard.press('Escape')
  record(`${name}: Esc で閉じる`, await h.reaches(page, (selector) => document.querySelector(selector) === null, TRANSLATION_DIALOG))
  record(`${name}: Esc で閉じた入力は送らない`, (await page.evaluate(() => window.fixture.translation())).keyLengths.length === 2)
  record(`${name}: 閉じた後にキーが画面に残らない`, !(await page.evaluate(() => document.documentElement.outerHTML)).includes(probe))
  record(`${name}: 文書は変わらない`, (await docText(page)) === before && !(await state(page)).dirty)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** F5 より前のキー（Step10-002 F5）。開いただけでは振り分けず、選んだ枠へ移す。 */
async function testTranslationLegacyKey(browser, base) {
  const name = '翻訳の以前のキー'
  const { page, problems } = await h.openPage(browser, `${base}?shell&legacy=1`)
  await page.waitForFunction(() => window.fixture !== undefined)
  await openTable(page, '/first.json')
  await page.click('.app-menubar-button:has-text("オプション")')
  await page.click('.app-menu-item:has-text("翻訳の設定")')
  await page.waitForSelector(`${TRANSLATION_DIALOG}[open]`, { timeout: h.STATE_TIMEOUT_MS })
  const legacy = `${TRANSLATION_DIALOG} [data-legacy]`
  const shownText = await page.locator(legacy).innerText()
  record(`${name}: 「以前のキー（どちらか選んで移す）」と移す 2 つのボタンが出る`, shownText.includes('以前のキー（どちらか選んで移す）') && (await page.locator(`${legacy} [data-action="moveKey"]`).count()) === 2, shownText)
  const untouched = await page.evaluate(() => window.fixture.translation())
  record(`${name}: 開いただけでは移さない`, untouched.moves.length === 0 && untouched.hasLegacyKey === true && untouched.keyTiers.length === 0, JSON.stringify(untouched))
  await page.click(`${legacy} [data-action="moveKey"][data-tier="paid"]`)
  const moved = await h.reaches(page, (selector) => document.querySelector(selector)?.hidden === true, legacy)
  const after = await page.evaluate(() => window.fixture.translation())
  record(`${name}: 有料用へ移すと、以前のキーの欄が消え、有料の欄が保存済み`, moved && JSON.stringify(after.moves) === '["paid"]' && JSON.stringify(after.keyTiers) === '["paid"]', JSON.stringify(after))
  record(
    `${name}: 有料の欄が保存済み、無料枠の欄は未設定`,
    (await page.locator(`${TRANSLATION_DIALOG} .app-translation-key-block[data-tier="paid"] .app-translation-key-status`).innerText()).startsWith('保存済み') &&
      (await page.locator(`${TRANSLATION_DIALOG} .app-translation-key-block[data-tier="free"] .app-translation-key-status`).innerText()) === '未設定'
  )
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
  await openTable(page, '/japanese.json')
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
  await openTable(page, FIRST)
  record(`${name}: 開いた直後は立たない`, !(await lastReport(page)).unsaved)
  record(`${name}: タイトルに * が無い`, !(await page.title()).startsWith('*'), await page.title())

  await editing(page, 'x', 'typing')
  let report = await lastReport(page)
  record(`${name}: セルの編集中に立つ`, report.unsaved, JSON.stringify(report))
  record(`${name}: タイトルの * と一緒に届く`, report.title.startsWith('*'), report.title)
  record(`${name}: 画面のタイトルにも * が付く`, (await page.title()).startsWith('*'), await page.title())
  await page.keyboard.press('Escape')

  await openTable(page, FIRST, { discardConfirmed: true })
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

  await openTable(page, '/cells.json', { discardConfirmed: true })
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
  await openTable(page, FIRST)
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
  await h.switchTo(page, 'テキスト')
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

  await openTable(page, FIRST)
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
  // lint の印が出るまで待つ。待たないと、印が出る前に先へ進むかどうかで、印の画像が
  // CSP に止められた誤りが出たり出なかったりする（B68）。印は CSS だけで描き、画像を読まない
  const lintMarker = await lintMarkerFacts(page)
  record(
    `${name}: 不正な text の lint の印を CSS で描く`,
    lintMarker.shown && lintMarker.content === 'normal' && lintMarker.painted && lintMarker.blocked.length === 0,
    JSON.stringify(lintMarker)
  )
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
  await openTable(page, '/nested-cell.json', { discardConfirmed: true })
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
  await openTable(page, FIRST)
  await editCell(page, 'x', 'edited')
  await nextSave(page, { kind: 'ExternalChange' })
  await setAnswers(page, [0])
  await setPicked(page, '/kept.json')
  let result = await flow(page, 'current')
  let shown = await state(page)
  record(`${name}: 既定の別名で保存は元へ書かない`, result === 'saved' && shown.path === '/kept.json', result)
  record(`${name}: 元のファイルが残る`, !(await evaluateFixture(page, 'file', FIRST)).includes('edited'))

  await openTable(page, FIRST, { discardConfirmed: true })
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
    await openTable(page, path, { discardConfirmed: true })
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
  // 主の画面の整形のボタンはコマンドの行に出さない（計画 S4、7 つの命令に絞る）。同じ関数（handleFormat）を Ctrl+I で呼ぶ
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+i')
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

  await openTable(page, FIRST)
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
  await openTable(page, NESTED)
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
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
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

/** S4。クリップボードを器の偽物にする。書いた文字を残し、読みは決めた文字を返す。 */
const fakeClipboard = (page, text) =>
  page.evaluate((value) => {
    window.__written = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => value,
        writeText: async (written) => {
          window.__written.push(written)
        }
      }
    })
  }, text)
const written = (page) => page.evaluate(() => window.__written)
const commandFacts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.app-command-bar > *')].map((child) =>
      child.classList.contains('app-command-separator')
        ? '|'
        : `${child.dataset.command}${child.getAttribute('aria-disabled') === 'true' ? '-' : ''}`
    )
  )
const reachesCommand = (page, command, enabled) =>
  h.reaches(
    page,
    ([name, want]) => document.querySelector(`.app-command-button[data-command="${name}"]`)?.getAttribute('aria-disabled') === String(!want),
    [command, enabled]
  )

/** 主のエディタの上流のメニューの帯が見えるか（S4 で隠す）。 */
const upstreamBarShown = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.app-editor > .jse-main > div > .jse-menu')
    return bar !== null && getComputedStyle(bar).display !== 'none'
  })

/** S4。コマンドの行（元に戻す、やり直す ｜ 検索と置換、並べ替え、絞り込みと変換 ｜ 展開、折りたたみ）。 */
async function testCommandBar(browser, base) {
  const name = 'コマンドの行'
  const { page, problems } = await shellPage(browser, base)
  await open(page, I19)
  const placed = await page.evaluate(() => {
    const order = [...document.querySelector('.app-shell').children].map((child) => child.className.split(' ')[0])
    return order.slice(0, 2).join('|')
  })
  record(`${name}: メニューの行のすぐ下`, placed === 'app-menu-host|app-command-bar', placed)
  record(
    `${name}: 7 つの命令と群の区切り（ツリー）`,
    (await commandFacts(page)).join() === 'undo-,redo-,|,search,sort,transform,|,expandAll,collapseAll',
    (await commandFacts(page)).join()
  )
  const labels = (await page.locator('.app-command-button').allInnerTexts()).map((s) => s.trim())
  record(`${name}: 文言は辞書から`, labels.join() === '元に戻す,やり直し,検索と置換,並べ替え,絞り込みと変換,展開,折りたたみ', labels.join())
  record(`${name}: 主の画面の上流の帯は隠す`, !(await upstreamBarShown(page)))
  const upstreamButtons = await page.locator('.app-editor > .jse-main .jse-menu button').count()
  record(`${name}: 上流の帯に項目を残さない`, upstreamButtons === 0, String(upstreamButtons))
  record(`${name}: ツリーの場所の行は上流のまま出る`, (await page.locator('.jse-tree-mode .jse-navigation-bar').count()) === 1)

  // 展開と折りたたみ（ツリー）。上流の項目の関数を呼ぶ
  const nodes = () => page.locator('.jse-tree-mode .jse-json-node').count()
  await page.click(COMMAND('collapseAll'))
  const collapsed = await nodes()
  await page.click(COMMAND('expandAll'))
  const expanded = await nodes()
  record(`${name}: 折りたたみと展開が効く`, expanded > collapsed, `${collapsed} -> ${expanded}`)
  record(`${name}: 展開や折りたたみでは未保存にならない`, !(await state(page)).dirty)

  // 検索と置換、並べ替え、絞り込みと変換
  await page.click(COMMAND('search'))
  record(`${name}: 検索の欄が開く`, await h.reaches(page, () => document.querySelector('.jse-search-box') !== null))
  await page.click(COMMAND('search'))
  record(`${name}: もう一度押すと閉じる`, await h.reaches(page, () => document.querySelector('.jse-search-box') === null))
  await page.click(COMMAND('sort'))
  record(`${name}: 並べ替えの画面が開く`, await h.reaches(page, () => document.querySelector('.jse-sort-modal') !== null))
  await page.keyboard.press('Escape')
  await h.reaches(page, () => document.querySelector('dialog[open]') === null)
  await page.click(COMMAND('transform'))
  record(`${name}: 絞り込みと変換の画面が開く`, await h.reaches(page, () => document.querySelector('.jse-transform-modal') !== null))
  await page.keyboard.press('Escape')
  await h.reaches(page, () => document.querySelector('dialog[open]') === null)

  // 表: 展開と折りたたみは上流に無いので押せない（位置は動かさない）
  await h.switchTo(page, '表')
  record(
    `${name}: 表では展開と折りたたみを押せない`,
    (await commandFacts(page)).join() === 'undo,redo-,|,search,sort,transform,|,expandAll-,collapseAll-',
    (await commandFacts(page)).join()
  )

  // 元に戻すとやり直すは上流と同じ状態で、押すと上流の関数（Ctrl+Z と同じ結果）
  await open(page, FIRST, { discardConfirmed: true })
  record(`${name}: 開いた直後は元に戻すを押せない`, await reachesCommand(page, 'undo', false))
  await h.switchTo(page, '表')
  // 表示の切り替えも上流の履歴の 1 項目（undo で表示が戻る）
  record(`${name}: 表へ切り替えると元に戻すを押せる（上流の表示の履歴）`, await reachesCommand(page, 'undo', true))
  const before = await docText(page)
  await editCell(page, 'x', 'edited')
  record(`${name}: 編集すると元に戻すを押せる`, await reachesCommand(page, 'undo', true))
  record(`${name}: やり直すはまだ押せない`, await reachesCommand(page, 'redo', false))
  await page.click(COMMAND('undo'))
  record(`${name}: 元に戻すで編集の前へ`, await h.reaches(page, (text) => window.fixture.text() === text, before))
  record(`${name}: 元に戻した後はやり直すを押せる`, await reachesCommand(page, 'redo', true))
  await page.click(COMMAND('redo'))
  record(`${name}: やり直すで編集が戻る`, await h.reaches(page, () => window.fixture.text().includes('edited')))
  await page.keyboard.press('Control+z')
  record(`${name}: キーの undo とコマンドの行の状態が合う`, await reachesCommand(page, 'redo', true))

  // 入れ子の値のモーダルの中は上流の帯のまま（Text のボタンも残る。問い 2 の答え）
  await page.close()
  const modal = await nestedModal(browser, base)
  const modalFacts = await modal.page.evaluate(() => {
    const bar = document.querySelector('dialog[open] .jse-menu')
    return {
      shown: bar !== null && getComputedStyle(bar).display !== 'none',
      text: bar?.querySelectorAll('.jse-group-button').length ?? 0,
      undo: bar?.querySelector('.jse-undo') !== null
    }
  })
  record(`${name}: 入れ子の値のモーダルの帯は上流のまま`, modalFacts.shown && modalFacts.text === 3 && modalFacts.undo, JSON.stringify(modalFacts))
  await modal.page.close()
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
}

/** S4。Edit メニュー（元に戻す、やり直す ｜ 切り取り、コピー、貼り付け ｜ 検索と置換）。 */
async function testEditMenu(browser, base) {
  const name = 'Edit メニュー'
  const { page, problems } = await shellPage(browser, base)
  await fakeClipboard(page, '"pasted"')
  const openEdit = async () => {
    await page.click('.app-menubar-button:has-text("編集")', { timeout: h.STATE_TIMEOUT_MS })
    await page.waitForSelector('.app-menu-popup', { timeout: h.STATE_TIMEOUT_MS })
  }
  const editFacts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.app-menu-popup > *')].map((child) =>
        child.classList.contains('app-menu-separator')
          ? '|'
          : `${child.querySelector('.app-menu-label').textContent}${child.getAttribute('aria-disabled') === 'true' ? '-' : ''}`
      )
    )
  const choose = async (label) => {
    await openEdit()
    await page.click(`.app-menu-item:has-text("${label}")`, { timeout: h.STATE_TIMEOUT_MS })
  }

  await open(page, FIRST)
  await page.keyboard.press('Alt+e')
  record(`${name}: Alt+E で開く`, (await page.locator('.app-menu-popup').count()) === 1)
  await page.keyboard.press('Escape')
  await openEdit()
  record(
    `${name}: 開いた直後の項目`,
    (await editFacts()).join() === '元に戻す(U)-,やり直し(R)-,|,切り取り(T)-,コピー(C)-,貼り付け(P)-,|,検索と置換(F),|,テキストで開く(O)',
    (await editFacts()).join()
  )
  await page.keyboard.press('Escape')

  // 表のセル: コピーは Ctrl+C と同じ文字、貼り付けは右クリックと同じ結果
  await h.switchTo(page, '表')
  await page.getByText('x', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await openEdit()
  record(
    `${name}: セルを選ぶと切り取り、コピー、貼り付けを押せる（元に戻すは表示の切り替えの分）`,
    (await editFacts()).join() === '元に戻す(U),やり直し(R)-,|,切り取り(T),コピー(C),貼り付け(P),|,検索と置換(F),|,テキストで開く(O)',
    (await editFacts()).join()
  )
  await page.keyboard.press('Escape')
  await choose('コピー')
  await h.reaches(page, () => window.__written.length === 1)
  await page.keyboard.press('Control+c')
  await h.reaches(page, () => window.__written.length === 2)
  const copies = await written(page)
  record(`${name}: コピーは Ctrl+C と同じ文字`, copies.length === 2 && copies[0] === copies[1] && copies[0].includes('x'), JSON.stringify(copies))
  record(`${name}: コピーでは未保存にならない`, !(await state(page)).dirty)

  await choose('貼り付け')
  record(`${name}: 貼り付けでセルが替わる`, await h.reaches(page, () => window.fixture.text().includes('pasted')), await docText(page))
  record(`${name}: 貼り付けは確認の窓に落ちない`, (await page.locator('.jse-copy-paste').count()) === 0)
  record(`${name}: 貼り付けで未保存の印が立つ`, (await state(page)).dirty)
  await choose('元に戻す')
  record(`${name}: 元に戻すで貼り付けの前へ`, await h.reaches(page, () => !window.fixture.text().includes('pasted') && window.fixture.text().includes('"x"')))
  await choose('やり直し')
  record(`${name}: やり直しで貼り付けが戻る`, await h.reaches(page, () => window.fixture.text().includes('pasted')))

  await page.getByText('y', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await choose('切り取り')
  record(`${name}: 切り取りで値が消え、クリップボードへ書く`, await h.reaches(page, () => !window.fixture.text().includes('"y"') && window.__written.at(-1)?.includes('y')), JSON.stringify(await written(page)))

  await choose('検索と置換')
  record(`${name}: 検索と置換は置換の欄つきで開く（表）`, await h.reaches(page, () => document.querySelector('.jse-search-box .jse-replace-input') !== null))
  await page.keyboard.press('Escape')

  // ツリー
  await open(page, I19, { discardConfirmed: true })
  await page.locator('.jse-tree-mode .jse-value').first().click({ timeout: h.STATE_TIMEOUT_MS })
  await choose('コピー')
  record(`${name}: ツリーのコピー`, await h.reaches(page, () => window.__written.at(-1)?.includes('1.0') === true), JSON.stringify((await written(page)).at(-1)))
  await choose('検索と置換')
  record(`${name}: 検索と置換は置換の欄つきで開く（ツリー）`, await h.reaches(page, () => document.querySelector('.jse-search-box .jse-replace-input') !== null))
  await page.keyboard.press('Escape')

  // テキストの表示: 右クリックのメニューと同じ CodeMirror の操作
  await page.evaluate(() => window.fixture.setMode('text'))
  await page.click('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+a')
  await choose('コピー')
  const whole = await docText(page)
  record(`${name}: テキストのコピーは選択を書く`, await h.reaches(page, (text) => window.__written.at(-1) === text, whole))
  await choose('検索と置換')
  record(
    `${name}: テキストの検索と置換は置換の欄へ`,
    await h.reaches(page, () => document.activeElement?.getAttribute('name') === 'replace')
  )
  await page.keyboard.press('Escape')
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** S5、D5。Edit の「テキストで開く」と、窓に戻ったときの外の変更の読み直し。外のアプリは偽物（起動は記録だけ）。 */
async function testTextEditorAndOutside(browser, base) {
  const name = 'テキストで開く'
  const { page, problems } = await shellPage(browser, base)
  const openEdit = async () => {
    await page.click('.app-menubar-button:has-text("編集")', { timeout: h.STATE_TIMEOUT_MS })
    await page.waitForSelector('.app-menu-popup', { timeout: h.STATE_TIMEOUT_MS })
  }
  const lastItem = () =>
    page.evaluate(() => {
      const item = [...document.querySelectorAll('.app-menu-popup .app-menu-item')].at(-1)
      return `${item?.querySelector('.app-menu-label')?.textContent}${item?.getAttribute('aria-disabled') === 'true' ? '-' : ''}`
    })
  const launches = () => evaluateFixture(page, 'launches')
  const askCount = async () => (await state(page)).asks.length
  const focusWindow = () => evaluateFixture(page, 'focusWindow')

  await openEdit()
  record(`${name}: 無題の文書では押せない`, (await lastItem()) === 'テキストで開く(O)-', await lastItem())
  await page.keyboard.press('Escape')

  await open(page, FIRST)
  await openEdit()
  record(`${name}: 開いた文書では押せる`, (await lastItem()) === 'テキストで開く(O)', await lastItem())
  await page.click('.app-menu-item:has-text("テキストで開く")', { timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 未保存が無ければ聞かずに開く`, await h.reaches(page, () => window.fixture.launches().length === 1))
  record(`${name}: 開くのは基準のファイル`, JSON.stringify(await launches()) === JSON.stringify([FIRST]), JSON.stringify(await launches()))
  record(`${name}: 確認を出さない`, (await askCount()) === 0)

  // 未保存があれば先に聞く。保存して開く
  await h.switchTo(page, '表')
  await editCell(page, 'x', 'edited')
  await setAnswers(page, [0])
  await openEdit()
  await page.click('.app-menu-item:has-text("テキストで開く")', { timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 未保存なら先に聞く`, await h.reaches(page, () => window.fixture.launches().length === 2))
  let shown = await state(page)
  record(`${name}: 確認のボタン`, shown.asks.at(-1)?.buttons.join() === '保存して開く,保存せずに開く,キャンセル', shown.asks.at(-1)?.buttons.join())
  record(`${name}: 保存して開くは保存してから開く`, (await evaluateFixture(page, 'file', FIRST)).includes('edited') && !shown.dirty)

  // 関連付けが自分の EXE
  await evaluateFixture(page, 'nextLaunch', { kind: 'SelfAssociated' })
  await openEdit()
  await page.click('.app-menu-item:has-text("テキストで開く")', { timeout: h.STATE_TIMEOUT_MS })
  record(
    `${name}: 関連付けが自分なら開かず知らせる`,
    await h.reaches(page, () => document.querySelector('.app-notice')?.innerText.includes('JsonGridder') === true),
    await page.locator('.app-notice').innerText().catch(() => '')
  )

  // 外の変更: 未保存が無ければ読み直す
  const outer = '外の変更'
  const outside1 = '[{"a":1.0,"b":"outside"},{"a":2,"b":"y"}]'
  await evaluateFixture(page, 'addFile', FIRST, outside1)
  const asksBefore = await askCount()
  await focusWindow()
  record(`${outer}: 未保存が無ければ窓に戻ると読み直す`, await h.reaches(page, (text) => window.fixture.text() === text, outside1), await docText(page))
  record(`${outer}: 読み直しは聞かない`, (await askCount()) === asksBefore)
  record(`${outer}: 読み直した後は保存済み`, !(await state(page)).dirty)
  record(
    `${outer}: 読み直したと知らせる`,
    await h.reaches(page, () => document.querySelector('.app-notice')?.innerText.includes('読み直しました') === true)
  )

  // 未保存があれば聞く。残すを選ぶと文書も印も変えず、同じ変更では 2 度聞かない
  await h.switchTo(page, '表')
  await editCell(page, 'outside', 'mine')
  await evaluateFixture(page, 'addFile', FIRST, '[{"a":1.0,"b":"outside2"},{"a":2,"b":"y"}]')
  await setAnswers(page, [1])
  const asked = await askCount()
  await focusWindow()
  record(`${outer}: 未保存があれば聞く`, await h.reaches(page, (count) => window.fixture.state().asks.length === count + 1, asked))
  shown = await state(page)
  record(`${outer}: 確認のボタン（既定は残す）`, shown.asks.at(-1)?.buttons.join() === '読み直す,自分の編集を残す' && shown.asks.at(-1)?.default === 1, JSON.stringify(shown.asks.at(-1)))
  record(`${outer}: 残すを選ぶと自分の編集のまま`, (await docText(page)).includes('mine') && shown.dirty, await docText(page))
  await focusWindow()
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${outer}: 同じ変更では 2 度聞かない`, (await askCount()) === asked + 1, String(await askCount()))

  // 別の変更で、読み直すを選ぶ
  const outside3 = '[{"a":1.0,"b":"outside3"},{"a":2,"b":"y"}]'
  await evaluateFixture(page, 'addFile', FIRST, outside3)
  await setAnswers(page, [0])
  await focusWindow()
  record(`${outer}: 読み直すを選ぶと外の版へ`, await h.reaches(page, (text) => window.fixture.text() === text, outside3), await docText(page))

  // 読み直した文書が不正なら、テキストで開き帯を出す（D6 の流れ）
  const duplicate = await evaluateFixture(page, 'file', '/duplicate.json')
  await evaluateFixture(page, 'addFile', FIRST, duplicate)
  await nextOpen(page, { textOnly: true })
  await focusWindow()
  record(`${outer}: 不正になった文書はテキストで開く`, await h.reachesMode(page, 'テキスト'))
  record(`${outer}: 帯を出す`, await reachesBanner(page, 'duplicateKey'), JSON.stringify(await bannerFacts(page)))

  // 自分の保存の直後は外の変更と見なさない
  await open(page, '/second.json', { discardConfirmed: true })
  await h.switchTo(page, 'テキスト')
  await page.evaluate(() => window.fixture.typeAt(' ', 0, 0))
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${outer}: 保存の前に未保存`, (await state(page)).dirty)
  record(`${outer}: 保存する`, (await flow(page, 'current')) === 'saved')
  const afterSave = await askCount()
  const text = await docText(page)
  await focusWindow()
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${outer}: 自分の保存の直後は読み直さない`, (await askCount()) === afterSave && (await docText(page)) === text)

  // ファイルが消えたら 1 回だけ知らせる
  await evaluateFixture(page, 'removeFile', '/second.json')
  await focusWindow()
  record(
    `${outer}: 消えたら知らせる`,
    await h.reaches(page, () => document.querySelector('.app-notice')?.innerText.includes('見つからなくなりました') === true)
  )
  record(`${outer}: 消えても読み直さない`, (await docText(page)) === text)

  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/**
 * 未保存の無い読み直しの後、前の表示と表の対象が新しい文書でも使えれば保つ。
 * 対象の配列が消えた、またはテキストでしか開けない文書になったときだけツリー（かテキスト）へ落とす。
 */
async function testReloadKeepsView(browser, base) {
  const name = '読み直しの後の表示'
  const { page, problems } = await shellPage(browser, base)
  const PATH = '/keep.json'
  const shown = async () => {
    const { mode, target } = await state(page)
    const switched = await page.evaluate(() => document.querySelector('.app-view-switch')?.dataset.mode)
    return { mode, target, switched }
  }
  const reachesView = (mode, target, text) =>
    h.reaches(
      page,
      ([wantMode, wantTarget, wantText]) => {
        const now = window.fixture.state()
        return (
          window.fixture.text() === wantText &&
          now.mode === wantMode &&
          JSON.stringify(now.target) === JSON.stringify(wantTarget) &&
          document.querySelector('.app-view-switch')?.dataset.mode === wantMode
        )
      },
      [mode, target, text]
    )
  const reload = async (text) => {
    await evaluateFixture(page, 'addFile', PATH, text)
    await evaluateFixture(page, 'focusWindow')
  }

  await evaluateFixture(page, 'addFile', PATH, '{"users":[{"id":1},{"id":2}],"tags":["a","b","c"]}')
  await open(page, PATH)
  await setTarget(page, ['tags'])
  await h.switchTo(page, '表')
  record(`${name}: 前提（表で tags を開いている）`, sameTarget((await shown()).target, ['tags']) && (await shown()).mode === 'table', JSON.stringify(await shown()))

  // 保つ側: 表で開いていて、同じ配列が新しい文書にある
  const kept = '{"users":[{"id":1},{"id":2},{"id":3}],"tags":["a","b","c","d"]}'
  await reload(kept)
  record(`${name}: 表のまま同じ対象（tags）を保つ`, await reachesView('table', ['tags'], kept), JSON.stringify(await shown()))
  record(`${name}: 表に新しい文書の行が出る`, (await page.locator('.jse-table-mode td:has-text("d")').count()) > 0)
  record(`${name}: 保った後は保存済み`, !(await state(page)).dirty)
  // 表へは切り替えと同じ経路で戻した。履歴に表示の切り替えが載り、元に戻すでツリーへ戻る（文書は同じ）
  await page.click(COMMAND('undo'), { timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: 表へ戻すのは切り替えと同じ経路（元に戻すでツリーへ）`, await reachesView('tree', ['tags'], kept), JSON.stringify(await shown()))
  await page.click(COMMAND('redo'), { timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: やり直すで表へ`, await reachesView('table', ['tags'], kept), JSON.stringify(await shown()))

  // 保つ側: ツリーで開いていれば、ツリーのまま前の対象を保つ（開く処理の既定の先頭は users）
  await h.switchTo(page, 'ツリー')
  const keptTree = '{"users":[{"id":1}],"tags":["a","b"]}'
  await reload(keptTree)
  record(`${name}: ツリーのまま前の対象（tags）を保つ`, await reachesView('tree', ['tags'], keptTree), JSON.stringify(await shown()))

  // 落とす側: 表の対象の配列が消えた
  await h.switchTo(page, '表')
  const gone = '{"users":[{"id":1},{"id":2}]}'
  await reload(gone)
  record(`${name}: 配列が消えたらツリーと先頭の候補へ`, await reachesView('tree', ['users'], gone), JSON.stringify(await shown()))
  record(`${name}: 消えた配列の後も保存済み`, !(await state(page)).dirty)

  // 落とす側: テキストでしか開けない文書になった
  await h.switchTo(page, '表')
  record(`${name}: 前提（表で users）`, (await shown()).mode === 'table', JSON.stringify(await shown()))
  const duplicate = await evaluateFixture(page, 'file', '/duplicate.json')
  await nextOpen(page, { textOnly: true })
  await reload(duplicate)
  record(`${name}: テキストでしか開けなければテキストのまま（表へ戻さない）`, await h.reachesMode(page, 'テキスト'), JSON.stringify(await shown()))
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 少し待っても表へ移らない`, (await state(page)).mode === 'text', JSON.stringify(await shown()))
  record(`${name}: 帯を出す`, await reachesBanner(page, 'duplicateKey'), JSON.stringify(await bannerFacts(page)))

  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** テキストでしか開けない文書では、効かない命令を押せない見た目にする。 */
async function testTextOnlyCommands(browser, base) {
  const name = 'コマンドの行（テキストでしか開けない文書）'
  const { page, problems } = await shellPage(browser, base)
  await nextOpen(page, { textOnly: true })
  await open(page, '/duplicate.json')
  await reachesBanner(page, 'duplicateKey')
  record(
    `${name}: 並べ替え、変換、展開、折りたたみを押せない`,
    await h.reaches(
      page,
      () => ['sort', 'transform', 'expandAll', 'collapseAll'].every((command) => document.querySelector(`.app-command-button[data-command="${command}"]`)?.getAttribute('aria-disabled') === 'true')
    ),
    (await commandFacts(page)).join()
  )
  const color = await page.evaluate(() => {
    const style = (command) => getComputedStyle(document.querySelector(`.app-command-button[data-command="${command}"]`)).color
    return { sort: style('sort'), search: style('search') }
  })
  record(`${name}: 押せない見た目（補助の文字の色）`, color.sort !== color.search, JSON.stringify(color))
  record(`${name}: 検索と置換は押せる`, await reachesCommand(page, 'search', true))
  // 押せない印の付いたボタンを実際に押す。並べ替えの画面は開かない
  await page.click(COMMAND('sort'), { timeout: h.STATE_TIMEOUT_MS, force: true })
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 押しても並べ替えの画面は開かない`, (await page.locator('.jse-sort-modal').count()) === 0)
  // 元に戻すとやり直すは今のまま（打鍵すると元に戻すを押せる）
  const before = await docText(page)
  await page.evaluate(([from]) => window.fixture.typeAt(' ', from), [before.length])
  record(`${name}: 打鍵すると元に戻すを押せる`, await reachesCommand(page, 'undo', true))
  await page.click(COMMAND('undo'))
  record(`${name}: 元に戻すが効く`, await h.reaches(page, (text) => window.fixture.text() === text, before))

  // 直すと押せる
  const typed = await docText(page)
  const second = typed.lastIndexOf('"a"')
  await page.evaluate(([from, to]) => window.fixture.typeAt('"b"', from, to), [second, second + 3])
  await page.waitForTimeout(INPUT_SETTLE_MS)
  record(`${name}: 直すと並べ替えを押せる`, await reachesCommand(page, 'sort', true), (await commandFacts(page)).join())
  record(`${name}: 直すと変換を押せる`, await reachesCommand(page, 'transform', true))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const locationFacts = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.app-location-row')
    return {
      shown: row !== null && !row.hidden,
      segments: [...document.querySelectorAll('.app-location-row .app-location-segment')].map((s) => s.textContent)
    }
  })
const reachesLocation = (page, segments) =>
  h.reaches(
    page,
    (want) => {
      const row = document.querySelector('.app-location-row')
      const shown = row !== null && !row.hidden
      if (want === null) return !shown
      return shown && [...row.querySelectorAll('.app-location-segment')].map((s) => s.textContent).join('|') === want
    },
    segments
  )

/** S4（問い 1 の答え）。表の場所の行。ツリーは上流の場所の行、テキストでは出さない（D12）。 */
async function testLocationRow(browser, base) {
  const name = '場所の行'
  const { page, problems } = await shellPage(browser, base)
  await page.evaluate(() =>
    window.fixture.addFile('/users.json', '{"users":[{"id":1,"address":{"city":"Tokyo"}},{"id":2,"address":{"city":"Osaka"}}]}')
  )
  await open(page, '/users.json')
  record(`${name}: ツリーでは殻の行を出さない`, await reachesLocation(page, null), JSON.stringify(await locationFacts(page)))
  await h.switchTo(page, '表')
  record(`${name}: 表を開くと対象だけ`, await reachesLocation(page, 'users'), JSON.stringify(await locationFacts(page)))
  await page.getByText('Osaka', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: セルを押すと対象 > 行 > 入れ子のキー`, await reachesLocation(page, 'users|1|address|city'), JSON.stringify(await locationFacts(page)))
  const placed = await page.evaluate(() => {
    const row = document.querySelector('.app-location-row').getBoundingClientRect()
    const editor = document.querySelector('.app-editor').getBoundingClientRect()
    const pane = document.querySelector('.app-target-pane').getBoundingClientRect()
    return Math.abs(row.bottom - editor.top) <= 1 && row.left >= pane.right - 1
  })
  record(`${name}: エディタの上、左ペインの右`, placed)
  record(`${name}: 押しても未保存にならない`, !(await state(page)).dirty)

  await page.keyboard.press('ArrowLeft')
  record(`${name}: 選択を動かすと追う`, await reachesLocation(page, 'users|1|id'), JSON.stringify(await locationFacts(page)))

  await h.switchTo(page, 'ツリー')
  record(`${name}: ツリーへ戻ると出さない`, await reachesLocation(page, null))
  await page.evaluate(() => window.fixture.setMode('text'))
  record(`${name}: テキストの表示では出さない（D12）`, await reachesLocation(page, null))

  // 根の配列は「文書全体」
  await open(page, FIRST, { discardConfirmed: true })
  await h.switchTo(page, '表')
  record(`${name}: 根の配列で選択が無ければ文書全体`, await reachesLocation(page, '文書全体'), JSON.stringify(await locationFacts(page)))
  await page.getByText('y', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 根の配列のセル`, await reachesLocation(page, '1|b'), JSON.stringify(await locationFacts(page)))

  // テキストでしか開けない文書では出さない（D12）
  await nextOpen(page, { textOnly: true })
  await open(page, '/broken.json', { discardConfirmed: true })
  record(`${name}: テキストでしか開けない文書では出さない（D12）`, await reachesLocation(page, null))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

export async function testShell(browser, base, helpers) {
  h = helpers
  await testDefaultViews(browser, base)
  await testInvalidBanner(browser, base)
  await testConfirmations(browser, base)
  await testOuterKept(browser, base)
  await testHistoryEnds(browser, base)
  await testTargetInvalidated(browser, base)
  await testSwitchWhileEditing(browser, base)
  await testWholeDocument(browser, base)
  await testTargetPane(browser, base)
  await testRoundTrip(browser, base)
  await testMenu(browser, base)
  await testTranslationSettings(browser, base)
  await testTranslationLegacyKey(browser, base)
  await testTranslate(browser, base, h)
  await testCommandBar(browser, base)
  await testEditMenu(browser, base)
  await testTextEditorAndOutside(browser, base)
  await testReloadKeepsView(browser, base)
  await testTextOnlyCommands(browser, base)
  await testLocationRow(browser, base)
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
