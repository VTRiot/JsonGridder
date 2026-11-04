// ヘッドレスのブラウザ試験。窓は出ない。Microsoft Edge を使う。
// 開発用の NODE_ENV でも配布物が本番のコードになることを、ここで一緒に確かめる。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { build } from 'vite'
import { testContrast } from './contrast.mjs'
import { testEditorFixes } from './editorFixes.mjs'
import { testSearch } from './search.mjs'
import { testShell } from './shell.mjs'
import { testTranslate } from './translate.mjs'
import { testWrap } from './wrap.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LOAD_TIMEOUT_MS = 15000
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

const results = []
function record(name, passed, detail = '') {
  results.push(passed)
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`)
}

function cspFromConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  return Object.entries(config.app.security.csp)
    .map(([name, value]) => `${name} ${name === 'connect-src' ? "'self'" : value}`)
    .join('; ')
}

function serve(dir, csp) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost')
    if (pathname === '/favicon.ico') {
      // ブラウザが自分で取りに来るだけで、製品は参照しない
      response.writeHead(204)
      response.end()
      return
    }
    const file = path.join(dir, pathname === '/' ? 'index.html' : pathname)
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      console.log(`404 ${pathname}`)
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': csp
    })
    response.end(fs.readFileSync(file))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` }))
  })
}

async function openPage(browser, url) {
  const page = await browser.newPage()
  const problems = []
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
  page.on('pageerror', (error) => problems.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  await page.goto(url)
  await page.waitForSelector('.jse-main', { timeout: LOAD_TIMEOUT_MS })
  return { page, problems }
}

const modeButtons = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.jse-group-button')].map((b) => b.textContent.trim()))

async function testDistribution(browser, dist) {
  const script = fs
    .readdirSync(path.join(dist, 'assets'))
    .filter((name) => name.startsWith('index-') && name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(dist, 'assets', name), 'utf8'))
    .join('\n')
  record('配布物に開発用のコードが混ざらない', !/\bhmr\b/i.test(script))

  const { server, base } = await serve(dist, cspFromConfig())
  const { page, problems } = await openPage(browser, base)
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.app-view-switch-button')].map((b) => b.textContent.trim())
  )
  // 設定が無いので既定の英語で出る。切り替えは殻の 2 つだけで、上流の Text/Tree/Table は主の画面に出ない
  record('配布物の切り替えは Tree と Table の 2 つで既定の英語', labels.join() === 'Tree,Table', labels.join())
  record('配布物の主の画面に上流の表示のボタンが無い', (await modeButtons(page)).length === 0, (await modeButtons(page)).join())
  record('配布物の既定の表示はツリー', (await page.$('.jse-tree-mode')) !== null)

  const expected = { table: '.jse-table-mode', tree: '.jse-tree-mode' }
  for (const [mode, selector] of Object.entries(expected)) {
    await page.click(`.app-view-switch-button[data-mode="${mode}"]`)
    const shown = await page.waitForSelector(selector, { timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false)
    record(`配布物の ${mode} が表示される`, shown)
  }
  const display = await page.evaluate(() => getComputedStyle(document.querySelector('.jse-main')).display)
  record('配布物のスタイルが効く', display === 'flex', display)
  const violations = await page.evaluate(() => window.__csp)
  record('配布物の CSP 違反が 0 件', violations.length === 0, violations.join(' / '))
  record('配布物のエラーが 0 件', problems.length === 0, problems.slice(0, 3).join(' / '))
  await page.close()
  server.close()
}

async function testDictionary(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  const { page, problems } = await openPage(browser, base)

  await page.evaluate(() =>
    window.fixture.applyDictionary((dictionary) => {
      dictionary['editor.modeTable'] = '差し替えた表'
    })
  )
  await page.waitForSelector('.jse-group-button:has-text("差し替えた表")', { timeout: LOAD_TIMEOUT_MS })
  record('辞書の値を変えるとエディタの文言が変わる', (await modeButtons(page)).includes('差し替えた表'))

  await page.evaluate(() =>
    window.fixture.applyDictionary((dictionary) => {
      delete dictionary['editor.modeTree']
    })
  )
  await page.waitForSelector('.jse-group-button:has-text("tree")', { timeout: LOAD_TIMEOUT_MS })
  const labels = await modeButtons(page)
  record('欠けたキーは上流の英語へ落ちる', labels.includes('tree') && labels.includes('表'), labels.join())
  record('キーが欠けても画面が残る', (await page.locator('.jse-table-mode').count()) === 1)

  await page.evaluate(() =>
    window.fixture.applyDictionary((dictionary) => {
      dictionary['editor.noSuchKey'] = '未知のキー'
    })
  )
  await page.evaluate(() =>
    window.fixture.applyDictionary((dictionary) => {
      for (const key of Object.keys(dictionary)) delete dictionary[key]
    })
  )
  await page.waitForSelector('.jse-group-button:has-text("table")', { timeout: LOAD_TIMEOUT_MS })
  record('未知のキーと空の辞書で例外が出ない', problems.length === 0, problems.slice(0, 3).join(' / '))
  await page.close()
  server.close()
}

const MARK_TEXT = '777,'
const MARK_DIGITS = '777'
const CELL_TEXT = 'x'
const CELL_EDIT = 'edited'
const REPLACED_MARK = 'replaced'
const STATE_TIMEOUT_MS = 3000
const UNDO_SETTLE_MS = 400 // テキストの遅延の時間より長く待つ

const activeMode = (page) =>
  page.evaluate(() => document.querySelector('.jse-group-button.jse-selected')?.textContent.trim() ?? '')

const documentText = (page) => page.evaluate(() => window.fixture.text())

const editorText = (page) => page.evaluate(() => document.querySelector('.jse-main')?.innerText ?? '')

/** 条件が満ちるまで待つ。止まった画面は待っても変わらないので、時間切れで false を返す。 */
const reaches = (page, fn, arg) =>
  page.waitForFunction(fn, arg, { timeout: STATE_TIMEOUT_MS }).then(
    () => true,
    () => false
  )

/** 殻（?shell と配布物）の表示の名前。殻は Tree と Table だけを出し、テキストの表示はどちらも選ばない。 */
const SHELL_MODES = {
  テキスト: 'text',
  text: 'text',
  ツリー: 'tree',
  tree: 'tree',
  Tree: 'tree',
  表: 'table',
  table: 'table',
  Table: 'table'
}

/**
 * 殻のある画面は殻の切り替え（`data-mode`）で、無い画面は上流のボタンで今の表示を見る。
 * 殻のある画面では、モーダルの中のエディタの上流のボタンを主の表示と取り違えない。
 */
const reachesMode = (page, label) =>
  reaches(
    page,
    ([expected, shellMode]) => {
      const shell = document.querySelector('.app-view-switch')
      if (shell) return shell.dataset.mode === shellMode
      return document.querySelector('.jse-group-button.jse-selected')?.textContent.trim() === expected
    },
    [label, SHELL_MODES[label]]
  )

const documentHas = (page, text) => reaches(page, (expected) => window.fixture.text().includes(expected), text)

const documentLacks = (page, text) => reaches(page, (expected) => !window.fixture.text().includes(expected), text)

/**
 * 表示を切り替える。殻のある画面では殻の切り替えを押す。殻にテキストのボタンは無いので、
 * テキストの表示は試験の器の setMode（エディタの公開の口。門番を通る）で入る。
 */
async function switchTo(page, label) {
  const shell = await page.$('.app-view-switch')
  if (shell && SHELL_MODES[label] === 'text') {
    await page.evaluate(() => window.fixture.setMode('text')).catch(() => {})
  } else if (shell) {
    await page
      .click(`.app-view-switch-button[data-mode="${SHELL_MODES[label]}"]`, { timeout: STATE_TIMEOUT_MS })
      .catch(() => {})
  } else {
    await page.click(`.jse-group-button:has-text("${label}")`, { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  }
  return reachesMode(page, label)
}

/** 3 つの表示を順に回す。更新が止まっていれば最初の切り替えで false になる。 */
async function cyclesAllModes(page) {
  for (const label of ['tree', 'table', 'text']) {
    if (!(await switchTo(page, label))) return false
  }
  return true
}

/**
 * テキストの表示で書き込み、同じタスクの中で action を実行する。遅延の待ちと競争しない。
 * 戻り値は、action の直前に変更がまだ渡っていなかったか（試験の前提）。
 */
function typeAndAct(page, action) {
  return page.evaluate(
    ([mark, { kind, value }]) => {
      const { fixture } = window
      const before = fixture.changes.length
      fixture.typeNow(mark)
      const pending = fixture.changes.length === before
      if (kind === 'mode-button') {
        const buttons = [...document.querySelectorAll('.jse-group-button')]
        buttons.find((button) => button.textContent.trim() === value).click()
      } else if (kind === 'menu-button') {
        document.querySelector(value).click()
      } else if (kind === 'set-mode') {
        fixture.setMode(value)
      } else {
        fixture.replaceContent(value)
      }
      return pending
    },
    [MARK_TEXT, action]
  )
}

async function openTextMode(browser, base) {
  const { page, problems } = await openPage(browser, `${base}?direct`)
  await page.click('.jse-group-button:has-text("text")')
  await page.waitForSelector('.cm-content', { timeout: LOAD_TIMEOUT_MS })
  return { page, problems }
}

async function editCell(page) {
  await page.getByText(CELL_TEXT, { exact: true }).dblclick({ timeout: STATE_TIMEOUT_MS }).catch(() => {})
  await page.keyboard.press('Control+A')
  await page.keyboard.type(CELL_EDIT)
  await page.keyboard.press('Enter')
}

/** 表示の切り替えで、遅延中の入力が確定し、続けて編集できる。 */
async function testPendingSwitch(browser, base, label) {
  const name = `遅延中に ${label} へ切り替える`
  const { page, problems } = await openTextMode(browser, base)
  record(`${name}: 切り替えの時点で変更が渡っていない`, await typeAndAct(page, { kind: 'mode-button', value: label }))
  record(`${name}: 切り替わる`, await reachesMode(page, label), await activeMode(page))
  record(`${name}: 打った文字が文書に入る`, await documentHas(page, MARK_DIGITS), await documentText(page))
  record(`${name}: 打った文字が画面に出る`, (await editorText(page)).includes(MARK_DIGITS))
  const changes = await page.evaluate(() => window.fixture.changes.length)
  record(`${name}: 確定の通知は 1 回`, changes === 1, String(changes))

  record(`${name}: 続けて表へ切り替わる`, await switchTo(page, 'table'))
  await editCell(page)
  record(`${name}: 続けてセルを編集できる`, await documentHas(page, CELL_EDIT), await documentText(page))
  record(`${name}: 編集の後も 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  const text = await documentText(page)
  record(`${name}: 両方の編集が文書に残る`, text.includes(MARK_DIGITS) && text.includes(CELL_EDIT), text)
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 履歴の順序は、テキストの編集、表示の切り替えの順。undo と redo による表示の変更も確かめる。 */
async function testPendingHistory(browser, base) {
  const name = '遅延中の切り替えの履歴'
  const { page, problems } = await openTextMode(browser, base)
  await typeAndAct(page, { kind: 'mode-button', value: 'table' })
  record(`${name}: 切り替わる`, await reachesMode(page, 'table'))

  const undo = () => page.click('.jse-undo', { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  const redo = () => page.click('.jse-redo', { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  await undo()
  record(`${name}: 1 回目の undo は表示だけを戻す`, await reachesMode(page, 'text'), await activeMode(page))
  record(`${name}: 1 回目の undo で文字は残る`, await documentHas(page, MARK_DIGITS), await documentText(page))
  await undo()
  record(`${name}: 2 回目の undo は文字を戻す`, await documentLacks(page, MARK_DIGITS), await documentText(page))
  record(`${name}: 2 回目の undo で表示は変わらない`, (await activeMode(page)) === 'text', await activeMode(page))
  await undo()
  record(`${name}: 3 回目の undo は最初の表示へ戻す`, await reachesMode(page, 'table'), await activeMode(page))
  await redo()
  record(`${name}: 1 回目の redo は表示を進める`, await reachesMode(page, 'text'), await activeMode(page))
  await redo()
  record(`${name}: 2 回目の redo は文字を戻す`, await documentHas(page, MARK_DIGITS), await documentText(page))
  await redo()
  record(`${name}: 3 回目の redo は表へ進める`, await reachesMode(page, 'table'), await activeMode(page))
  record(`${name}: 打った文字が表に出る`, (await editorText(page)).includes(MARK_DIGITS))
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 遅延中の undo は、入力を確定してから戻す。続く undo で表示が変わっても止まらない。 */
async function testPendingUndo(browser, base) {
  const name = '遅延中の undo'
  const { page, problems } = await openTextMode(browser, base)
  record(`${name}: undo の時点で変更が渡っていない`, await typeAndAct(page, { kind: 'menu-button', value: '.jse-undo' }))
  record(`${name}: 打った文字が戻る`, await documentLacks(page, MARK_DIGITS), await documentText(page))
  record(`${name}: 表示は変わらない`, (await activeMode(page)) === 'text', await activeMode(page))
  await page.click('.jse-undo', { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: 次の undo で表示が戻る`, await reachesMode(page, 'table'), await activeMode(page))
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 利用者の操作でなく、外から表示を変える経路。 */
async function testPendingExternalMode(browser, base) {
  const name = '遅延中に外から表示を変える'
  const { page, problems } = await openTextMode(browser, base)
  record(`${name}: 変更の時点で変更が渡っていない`, await typeAndAct(page, { kind: 'set-mode', value: 'table' }))
  record(`${name}: 切り替わる`, await reachesMode(page, 'table'), await activeMode(page))
  record(`${name}: 打った文字が文書に入る`, await documentHas(page, MARK_DIGITS), await documentText(page))
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** テキストの表示が壊される経路。壊される時の確定がエディタを止めない。 */
async function testPendingReplace(browser, base) {
  const name = '遅延中に文書を置き換える'
  const { page, problems } = await openTextMode(browser, base)
  record(
    `${name}: 置き換えの時点で変更が渡っていない`,
    await typeAndAct(page, { kind: 'replace', value: { json: { [REPLACED_MARK]: true } } })
  )
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const MODAL = '.jse-jsoneditor-modal'
const MODAL_PATH = `${MODAL} .jse-path`
const MODAL_BODY = `${MODAL} .jse-modal-inline-editor`
const MODAL_ACTIONS = `${MODAL} .jse-modal-contents > .jse-actions`
const MODAL_APPLY = `${MODAL_ACTIONS} .jse-primary`
const MODAL_BACK = `${MODAL_ACTIONS} .jse-secondary`
const MODAL_CLOSE = `${MODAL} .jse-header .jse-close`
const MODAL_ERROR = `${MODAL_ACTIONS} .jse-error`
const INVALID_TEXT = '}'
// 窓の左上の隅。モーダルの枠の外
const BACKDROP_POINT = 2
const MODAL_OPEN_MS = 200
// テキストの表示の遅延（300 ms）を十分に過ぎる待ち
const INPUT_SETTLE_MS = 600
const OUTER_PATH = '[0].n'
const INNER_PATH = '[0].n[0].m'
const PARENT_MARK = 'keep'
const NESTED_ROWS = [
  { n: [{ m: [1, 2], o: PARENT_MARK }], k: 1 },
  { n: [{ m: [3] }], k: 2 }
]
const withOuterValue = (value) => JSON.stringify({ json: [{ ...NESTED_ROWS[0], n: value }, NESTED_ROWS[1]] })
const NESTED_DOCUMENT = JSON.stringify({ json: NESTED_ROWS })

const modalPath = (page) => page.evaluate((selector) => document.querySelector(selector)?.value ?? null, MODAL_PATH)

const modalBody = (page) => page.evaluate((selector) => document.querySelector(selector)?.innerText ?? '', MODAL_BODY)

const reachesModalPath = (page, expected) =>
  reaches(
    page,
    ([selector, value]) => document.querySelector(selector)?.value === value,
    [MODAL_PATH, expected]
  )

const reachesModalClosed = (page) =>
  reaches(page, (selector) => document.querySelector(selector) === null, MODAL)

async function openModal(page, depth) {
  await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: STATE_TIMEOUT_MS })
  await page.waitForSelector(MODAL, { timeout: STATE_TIMEOUT_MS })
  await page.waitForTimeout(MODAL_OPEN_MS)
  if (depth === 2) {
    await page.locator(`${MODAL} .jse-table-mode .jse-inline-value`).first().dblclick({ timeout: STATE_TIMEOUT_MS })
    record(`モーダルの 2 段目が開く`, await reachesModalPath(page, INNER_PATH), String(await modalPath(page)))
    await page.waitForTimeout(MODAL_OPEN_MS)
  }
  await page.click(`${MODAL} .jse-group-button:has-text("text")`, { timeout: STATE_TIMEOUT_MS })
  await page.waitForSelector(`${MODAL} .cm-content`, { timeout: STATE_TIMEOUT_MS })
  await page.waitForTimeout(MODAL_OPEN_MS)
}

/** 打つ操作と離れる操作の組み。pending は同じタスクの合成の操作で、遅延の時間と競争しない。 */
const TIMINGS = {
  pending: { label: '遅延中', sameTask: true },
  settled: { label: '待った対照', settle: true },
  real: { label: '実キーと実マウス', realInput: true },
  ime: { label: '変換中', realInput: true, composition: true }
}

function typeAndLeaveInOneTask(page, { kind, selector }, typing) {
  return page.evaluate(
    ([mark, modal, leaveKind, leaveSelector, withTyping]) => {
      if (withTyping) window.fixture.typeNow(mark)
      if (leaveKind === 'esc') {
        const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        document.querySelector(`${modal} .cm-content`).dispatchEvent(key)
      } else if (leaveKind === 'backdrop') {
        document.querySelector(modal).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      } else if (leaveKind === 'close-event') {
        document.querySelector(modal).dispatchEvent(new Event('close'))
      } else {
        document.querySelector(leaveSelector).click()
      }
    },
    [MARK_TEXT, MODAL, kind, selector, typing]
  )
}

async function placeCursorAtFirstValue(page) {
  await page.click(`${MODAL} .cm-content`, { timeout: STATE_TIMEOUT_MS })
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
}

/** 変換中の状態は CDP で作る。OS の IME は通らない。 */
async function composeMark(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', {
    text: MARK_TEXT,
    selectionStart: MARK_TEXT.length,
    selectionEnd: MARK_TEXT.length
  })
}

async function leaveByRealInput(page, { kind, selector }) {
  if (kind === 'esc') {
    await page.keyboard.press('Escape')
  } else if (kind === 'backdrop') {
    await page.mouse.click(BACKDROP_POINT, BACKDROP_POINT)
  } else {
    await page.click(selector, { timeout: STATE_TIMEOUT_MS })
  }
}

/**
 * 段を離れる全経路。cancel は打った文字を捨てる操作で、文書は開いた時のまま。apply は打った文字を入れる操作。
 */
async function testModalLeave(browser, base, { depth, route, timing, cancel, readOnly = false }) {
  const { label, sameTask, settle, realInput, composition } = TIMINGS[timing]
  const name = `モーダル ${depth} 段の ${route.name}${readOnly ? '（読み取り専用）' : ''}（${label}）`
  const { page, problems } = await openPage(browser, `${base}?direct&nested${readOnly ? '&readonly' : ''}`)
  await openModal(page, depth)
  if (settle) {
    await page.evaluate((mark) => window.fixture.typeNow(mark), MARK_TEXT)
    await page.waitForTimeout(INPUT_SETTLE_MS)
    await typeAndLeaveInOneTask(page, route, false)
  } else if (sameTask) {
    await typeAndLeaveInOneTask(page, route, true)
  } else if (realInput) {
    await placeCursorAtFirstValue(page)
    if (composition) await composeMark(page)
    else await page.keyboard.type(MARK_TEXT)
    await leaveByRealInput(page, route)
  }

  if (depth === 2) {
    record(`${name}: 親の段へ戻る`, await reachesModalPath(page, OUTER_PATH), String(await modalPath(page)))
    const body = await modalBody(page)
    record(`${name}: 親の値が残る`, body.includes(PARENT_MARK), body.replace(/\s+/g, ' '))
    if (cancel) record(`${name}: 親に打った文字が入らない`, !body.includes(MARK_DIGITS), body.replace(/\s+/g, ' '))
    await page.click(MODAL_APPLY, { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  }
  record(`${name}: モーダルが閉じる`, await reachesModalClosed(page))

  const typedDepth1 = [Number(MARK_DIGITS), NESTED_ROWS[0].n[0]]
  const typedDepth2 = [{ ...NESTED_ROWS[0].n[0], m: [Number(MARK_DIGITS), 1, 2] }]
  const expected = cancel ? NESTED_DOCUMENT : withOuterValue(depth === 2 ? typedDepth2 : typedDepth1)
  const text = await documentText(page)
  record(`${name}: 文書が期待どおり`, text === expected, text)
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page), await activeMode(page))
  record(`${name}: 回した後も文書が同じ`, (await documentText(page)) === expected, await documentText(page))
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 遅延中の入力が不正な JSON なら、Apply は段を下ろさず、誤りを出し、親も文書も変えない。 */
async function testModalInvalidApply(browser, base, depth) {
  const name = `モーダル ${depth} 段の Apply（遅延中の不正な JSON）`
  const { page, problems } = await openPage(browser, `${base}?direct&nested`)
  await openModal(page, depth)
  await page.evaluate(
    ([text, selector]) => {
      window.fixture.typeNow(text)
      document.querySelector(selector).click()
    },
    [INVALID_TEXT, MODAL_APPLY]
  )
  const stays = depth === 2 ? INNER_PATH : OUTER_PATH
  record(`${name}: 誤りが出る`, await reaches(page, (selector) => !!document.querySelector(selector), MODAL_ERROR))
  record(`${name}: 段を下ろさない`, (await modalPath(page)) === stays, String(await modalPath(page)))
  if (depth === 2) {
    await page.click(MODAL_BACK, { timeout: STATE_TIMEOUT_MS }).catch(() => {})
    record(`${name}: 戻ると親の段`, await reachesModalPath(page, OUTER_PATH), String(await modalPath(page)))
    const body = await modalBody(page)
    record(`${name}: 親の値が残る`, body.includes(PARENT_MARK), body.replace(/\s+/g, ' '))
  }
  await page.click(MODAL_CLOSE, { timeout: STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: モーダルが閉じる`, await reachesModalClosed(page))
  const text = await documentText(page)
  record(`${name}: 文書が変わらない`, text === NESTED_DOCUMENT, text)
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

async function testModalLeaves(browser, base) {
  const esc = { name: 'Esc', kind: 'esc' }
  const backdrop = { name: '枠の外', kind: 'backdrop' }
  const close = { name: '閉じるボタン', kind: 'click', selector: MODAL_CLOSE }
  const back = { name: '戻る', kind: 'click', selector: MODAL_BACK }
  const apply = { name: 'Apply', kind: 'click', selector: MODAL_APPLY }
  const closeEvent = { name: 'close イベント', kind: 'close-event' }
  const readOnlyClose = { name: 'Close', kind: 'click', selector: MODAL_APPLY }
  const everyTiming = Object.keys(TIMINGS)
  const synthetic = ['pending', 'settled']
  const cases = [
    { depth: 2, route: esc, cancel: true, timings: everyTiming },
    { depth: 2, route: back, cancel: true, timings: everyTiming },
    { depth: 2, route: close, cancel: true, timings: everyTiming },
    { depth: 2, route: backdrop, cancel: true, timings: everyTiming },
    { depth: 2, route: apply, cancel: false, timings: everyTiming },
    { depth: 2, route: closeEvent, cancel: true, timings: synthetic },
    { depth: 2, route: readOnlyClose, cancel: true, timings: synthetic, readOnly: true },
    { depth: 1, route: esc, cancel: true, timings: everyTiming },
    { depth: 1, route: close, cancel: true, timings: everyTiming },
    { depth: 1, route: backdrop, cancel: true, timings: everyTiming },
    { depth: 1, route: apply, cancel: false, timings: everyTiming },
    { depth: 1, route: closeEvent, cancel: true, timings: synthetic },
    { depth: 1, route: readOnlyClose, cancel: true, timings: synthetic, readOnly: true }
  ]
  for (const { timings, ...item } of cases) {
    for (const timing of timings) {
      await testModalLeave(browser, base, { ...item, timing })
    }
  }
  await testModalInvalidApply(browser, base, 2)
  await testModalInvalidApply(browser, base, 1)
}

const FIRST = '/first.json'
const SECOND = '/second.json'
const SECOND_TEXT = '{"other":[1,2,3]}'

async function documentPage(browser, base, mode, path = FIRST) {
  const { page, problems } = await openPage(browser, `${base}?document`)
  await page.evaluate((target) => window.fixture.open(target, {}), path)
  await switchTo(page, mode)
  return { page, problems }
}

const openDocument = (page, path, options = {}) =>
  page.evaluate(([target, opts]) => window.fixture.open(target, opts).then((result) => result.kind), [path, options])

const documentState = (page) => page.evaluate(() => window.fixture.state())

/** 開いた文書が残り、3 つの表示を回せて、回した後も文書が変わらない。 */
async function expectReplaced(page, problems, name, path = SECOND) {
  const state = await documentState(page)
  record(`${name}: 基準が新しい文書になる`, state.path === path && !state.dirty, JSON.stringify(state))
  record(`${name}: 新しい文書が残る`, (await documentText(page)) === SECOND_TEXT, await documentText(page))
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
  record(`${name}: 回した後も文書が同じ`, (await documentText(page)) === SECOND_TEXT, await documentText(page))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
}

async function startCellEdit(page) {
  await page.getByText(CELL_TEXT, { exact: true }).dblclick({ timeout: STATE_TIMEOUT_MS }).catch(() => {})
  await page.keyboard.press('Control+A')
  await page.keyboard.type(CELL_EDIT)
}

/** 確定前の入力は、決定を求めた後も残り、捨てる決定の後は新しい文書が残る。 */
async function testOpenWhileTyping(browser, base) {
  const name = '遅延中に別のファイルを開く'
  const { page, problems } = await documentPage(browser, base, 'text')
  const [kind, pending] = await page.evaluate(([mark, path]) => {
    const before = window.fixture.changes.length
    window.fixture.typeNow(mark)
    const waiting = window.fixture.changes.length === before
    return window.fixture.open(path, {}).then((result) => [result.kind, waiting])
  }, [MARK_TEXT, SECOND])
  record(`${name}: 開く時点で変更が渡っていない`, pending)
  record(`${name}: 未保存の決定を求める`, kind === 'NeedsUnsavedDecision', kind)
  record(`${name}: 入力が文書に残る`, (await documentText(page)).includes(MARK_DIGITS), await documentText(page))
  record(`${name}: 捨てる決定で開く`, (await openDocument(page, SECOND, { discardConfirmed: true })) === 'Opened')
  await expectReplaced(page, problems, name)
  await page.close()
}

async function testOpenWhileEditingCell(browser, base) {
  const name = 'セルの編集中に別のファイルを開く'
  const { page, problems } = await documentPage(browser, base, 'table')
  await startCellEdit(page)
  const kind = await openDocument(page, SECOND)
  record(`${name}: 未保存の決定を求める`, kind === 'NeedsUnsavedDecision', kind)
  record(`${name}: 編集が文書に残る`, (await documentText(page)).includes(CELL_EDIT), await documentText(page))
  record(`${name}: 捨てる決定で開く`, (await openDocument(page, SECOND, { discardConfirmed: true })) === 'Opened')
  await expectReplaced(page, problems, name)
  await page.close()
}

/** 窓にフォーカスが無いとセルは確定しない。入力を黙って捨てず、古い文書を新しいパスへ結び付けない。 */
async function testOpenWithoutWindowFocus(browser, base) {
  const name = '窓のフォーカスが無いセルの編集中に開く'
  const { page, problems } = await documentPage(browser, base, 'table')
  await startCellEdit(page)
  await page.evaluate(() => window.fixture.dropWindowFocus())
  const kind = await openDocument(page, SECOND)
  const state = await documentState(page)
  record(`${name}: 未保存の決定を求める`, kind === 'NeedsUnsavedDecision', kind)
  record(`${name}: 基準を変えない`, state.path === FIRST, JSON.stringify(state))
  record(`${name}: 未保存が立つ`, state.dirty)
  record(`${name}: 編集が文書に残る`, (await documentText(page)).includes(CELL_EDIT), await documentText(page))
  record(`${name}: 捨てる決定で開く`, (await openDocument(page, SECOND, { discardConfirmed: true })) === 'Opened')
  await expectReplaced(page, problems, name)
  await page.close()
}

async function testOpenWithSelection(browser, base, mode) {
  const name = `${mode} で選択が残ったまま開く`
  const { page, problems } = await documentPage(browser, base, mode)
  if (mode === 'table') {
    await page.getByText(CELL_TEXT, { exact: true }).click({ timeout: STATE_TIMEOUT_MS })
  } else {
    const collapsed = page.locator('.jse-tree-mode .jse-expand')
    await collapsed.first().click({ timeout: STATE_TIMEOUT_MS }).catch(() => {})
    await page.evaluate(() => window.fixture.selectDeep())
  }
  const kind = await openDocument(page, SECOND)
  record(`${name}: 開く`, kind === 'Opened', kind)
  await expectReplaced(page, problems, name)
  await page.close()
}

async function testOpenTextOnly(browser, base) {
  const name = 'テキストに限る文書を表で選択が残ったまま開く'
  const { page, problems } = await documentPage(browser, base, 'table')
  await page.getByText(CELL_TEXT, { exact: true }).click({ timeout: STATE_TIMEOUT_MS })
  await page.evaluate(() => window.fixture.markTextOnly())
  const kind = await openDocument(page, '/broken.json')
  record(`${name}: 開く`, kind === 'Opened', kind)
  record(`${name}: テキストの表示へ移る`, await reachesMode(page, 'text'), await activeMode(page))
  const text = await documentText(page)
  record(`${name}: 文書が変わらない`, text === '{"a":1, /* c */ "b":', text)
  record(`${name}: 未保存が立たない`, !(await documentState(page)).dirty)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** モーダルを開いたままの置き換えは Apply で古い文書へ戻るので、開くのも保存も止める。 */
async function testOpenWithModal(browser, base, name, showModal, path) {
  const { page, problems } = await documentPage(browser, base, 'table', path)
  await showModal(page)
  const before = await documentText(page)
  const kind = await openDocument(page, SECOND)
  const saved = await page.evaluate(() => window.fixture.save().then((result) => result.kind))
  const state = await documentState(page)
  record(`${name}: 開かない`, kind === 'Blocked', kind)
  record(`${name}: 保存しない`, saved === 'Blocked' && state.writes === 0, saved)
  record(`${name}: 文書が変わらない`, (await documentText(page)) === before, await documentText(page))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

const showCellModal = async (page) => {
  await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: STATE_TIMEOUT_MS })
  await page.waitForSelector(MODAL, { timeout: STATE_TIMEOUT_MS })
  await page.waitForTimeout(MODAL_OPEN_MS)
}

const showTransformModal = async (page) => {
  await page.click('.jse-contents .jse-transform, .jse-menu .jse-transform', { timeout: STATE_TIMEOUT_MS })
  await page.waitForSelector('.jse-transform-modal', { timeout: STATE_TIMEOUT_MS })
}

/** 開く→全部の表示を回す→保存で 1 バイトも書かない。 */
async function testRoundTripWritesNothing(browser, base) {
  const name = '開いて表示を回しただけの文書'
  const { page, problems } = await documentPage(browser, base, 'table', '/crlf.json')
  record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
  record(`${name}: 未保存が立たない`, !(await documentState(page)).dirty)
  const kind = await page.evaluate(() => window.fixture.save().then((result) => result.kind))
  record(`${name}: 保存で書かない`, kind === 'NoChange' && (await documentState(page)).writes === 0, kind)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

async function testSaveTakesPendingInput(browser, base) {
  let name = 'セルの編集中に保存する'
  let { page, problems } = await documentPage(browser, base, 'table')
  await startCellEdit(page)
  let kind = await page.evaluate(() => window.fixture.save().then((result) => result.kind))
  let state = await documentState(page)
  record(`${name}: 編集が書かれる`, kind === 'Saved' && state.written?.includes(CELL_EDIT), String(state.written))
  record(`${name}: 数値の字面が残る`, state.written?.includes('1.0'), String(state.written))
  record(`${name}: 未保存が下りる`, !state.dirty)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()

  name = '遅延中に保存する'
  ;({ page, problems } = await documentPage(browser, base, 'text'))
  kind = await page.evaluate((mark) => {
    window.fixture.typeNow(mark)
    return window.fixture.save().then((result) => result.kind)
  }, MARK_TEXT)
  state = await documentState(page)
  record(`${name}: 入力が書かれる`, kind === 'Saved' && state.written?.includes(MARK_DIGITS), String(state.written))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}

/** 整形だけの編集の後に表で編集して undo すると、比較が整形を見失わないかの記録。合否に入れない。 */
async function noteFormatThenUndo(browser, base) {
  const { page } = await documentPage(browser, base, 'text')
  await page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    const { view } = content.cmTile.root
    view.dispatch({ changes: { from: 0, insert: ' ' } })
  })
  await page.waitForTimeout(UNDO_SETTLE_MS)
  await switchTo(page, 'table')
  await editCell(page)
  await page.waitForTimeout(UNDO_SETTLE_MS)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(UNDO_SETTLE_MS)
  const text = await documentText(page)
  const kind = await page.evaluate(() => window.fixture.save().then((result) => result.kind))
  const state = await documentState(page)
  console.log(`NOTE 整形→表で編集→undo の後: 文書=${JSON.stringify(text)} 保存=${kind} 書いた内容=${JSON.stringify(state.written)}`)
  await page.close()
}

async function testDocumentModel(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testOpenWhileTyping(browser, base)
  await testOpenWhileEditingCell(browser, base)
  await testOpenWithoutWindowFocus(browser, base)
  await testOpenWithSelection(browser, base, 'table')
  await testOpenWithSelection(browser, base, 'tree')
  await testOpenTextOnly(browser, base)
  await testOpenWithModal(browser, base, 'セルのモーダルを開いたまま', showCellModal, '/nested.json')
  await testOpenWithModal(browser, base, 'Transform を開いたまま', showTransformModal, FIRST)
  await testRoundTripWritesNothing(browser, base)
  await testSaveTakesPendingInput(browser, base)
  await noteFormatThenUndo(browser, base)
  server.close()
}

async function testPendingEdits(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testPendingSwitch(browser, base, 'table')
  await testPendingSwitch(browser, base, 'tree')
  await testPendingHistory(browser, base)
  await testPendingUndo(browser, base)
  await testPendingExternalMode(browser, base)
  await testPendingReplace(browser, base)
  await testModalLeaves(browser, base)
  server.close()
}

// ここで development にしても配布物が本番になることが、この試験の前提
process.env.NODE_ENV = 'development'
const dist = path.join(root, 'dist')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jgv-browser-'))
const fixture = path.join(workDir, 'fixture')

await build({ root, logLevel: 'warn' })
await build({
  root: path.join(root, 'tests/browser/fixture'),
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: { outDir: fixture, emptyOutDir: true }
})

/** 製品の既定のエディタの群を回す。`only` は群の名前の一覧で、変異の確かめが使う。 */
async function testProductDefaults(browser, fixture, only) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testEditorFixes(
    browser,
    base,
    { record, openPage, reaches, switchTo, cyclesAllModes: cyclesProductModes, reachesMode, STATE_TIMEOUT_MS },
    only
  )
  server.close()
}

/** 製品の既定の入口（?product）は試験の器で ja に固定しているので、ボタンの名前が日本語になる。 */
async function cyclesProductModes(page) {
  for (const label of ['ツリー', '表', 'テキスト']) {
    if (!(await switchTo(page, label))) return false
  }
  return true
}

async function testAppShell(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testShell(browser, base, { record, openPage, reaches, switchTo, reachesMode, STATE_TIMEOUT_MS })
  server.close()
}

async function testSearchGroup(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testSearch(browser, base, { record, openPage, switchTo })
  server.close()
}

/** 翻訳の右クリックと小窓だけを回す（--only-translate）。全体では殻の試験の中で回る。 */
async function testTranslateGroup(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testTranslate(browser, base, { record, openPage, reaches, switchTo, reachesMode, STATE_TIMEOUT_MS })
  server.close()
}

/** コントラストの全数点検だけを回す（--only-contrast）。gate の全体では殻の試験の中で回る。 */
async function testContrastGroup(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testContrast(browser, base, { record, openPage, reaches, switchTo, reachesMode, STATE_TIMEOUT_MS })
  server.close()
}

/** 右端で折り返すと列の幅のドラッグ（--only-wrap）。全体では殻の試験の後に回る。 */
async function testWrapGroup(browser, fixture) {
  const { server, base } = await serve(fixture, "default-src 'self'; style-src 'self' 'unsafe-inline'")
  await testWrap(browser, base, { record, openPage, reaches, switchTo, reachesMode, STATE_TIMEOUT_MS })
  server.close()
}

const onlyContrast = process.argv.includes('--only-contrast')
const onlyWrap = process.argv.includes('--only-wrap')
const onlyDocument = process.argv.includes('--only-document')
const onlySearch = process.argv.includes('--only-search')
const onlyShell = process.argv.includes('--only-shell')
const onlyTranslate = process.argv.includes('--only-translate')
const onlyFixes = process.argv.find((value) => value.startsWith('--only-fixes'))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  if (onlyContrast) {
    await testContrastGroup(browser, fixture)
  } else if (onlyWrap) {
    await testWrapGroup(browser, fixture)
  } else if (onlyTranslate) {
    await testTranslateGroup(browser, fixture)
  } else if (onlySearch) {
    await testSearchGroup(browser, fixture)
  } else if (onlyShell) {
    await testDistribution(browser, dist)
    await testAppShell(browser, fixture)
  } else if (onlyFixes !== undefined) {
    const [, groups] = onlyFixes.split('=')
    await testProductDefaults(browser, fixture, groups?.split(','))
  } else {
    if (!onlyDocument) {
      await testDistribution(browser, dist)
      await testDictionary(browser, fixture)
      await testPendingEdits(browser, fixture)
      await testProductDefaults(browser, fixture)
      await testSearchGroup(browser, fixture)
    }
    await testDocumentModel(browser, fixture)
    await testAppShell(browser, fixture)
    await testWrapGroup(browser, fixture)
  }
} finally {
  await browser.close()
  fs.rmSync(workDir, { recursive: true, force: true })
}

const failed = results.filter((passed) => !passed).length
console.log(`browser: ${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
