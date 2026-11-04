// アプリの殻の通しの 1 本。起動引数で開く→編集→保存→閉じる確認→外部変更→別のファイル→履歴→
// 消えたファイル→設定の順に、実 EXE で確かめる。
// 画面の操作はデバッグの口から送り、OS の入力は試験の窓が前面のときだけ送る。ダイアログのボタンは
// UI Automation で押す。写真は撮らず、実クリップボードも使わない。
// 深い文書の開き方（発注書 56 行）もここで 1 回測り、--out に shell-through-depth.json で残す。
import fs from 'node:fs'
import path from 'node:path'
import {
  DOCUMENT_CELL,
  SAMPLE_JSON,
  SELECTOR_TIMEOUT_MS,
  activeMode,
  connect,
  createReport,
  freePort,
  launch,
  osInput,
  productRoot,
  runCli,
  sleep,
  stop,
  switchMode,
  tempDocument,
  waitForDocument
} from './lib.mjs'

const DIALOG_CLASS = '#32770'
const POLL_MS = 200
const WAIT_TIMEOUT_MS = 10000
const OPEN_DIALOG_TIMEOUT_MS = 15000
const SETTLE_MS = 500
const EDIT_SETTLE_MS = 700
const SCREEN_TOLERANCE_PX = 2
// ダイアログのボタンの位置。並びは「3 択」の判定で確かめる
const CANCEL_BUTTON = 2
const UNSAVED_DONT_SAVE = 1
const EXTERNAL_OVERWRITE = 1
const DEPTHS = [64, 128, 256, 512, 768, 1000]

const dictionary = JSON.parse(fs.readFileSync(path.join(productRoot, 'src/i18n/en.json'), 'utf8'))
const say = (key) => dictionary[key]
const DIRTY = say('app.window.dirtyMark')
const CRLF_JSON = SAMPLE_JSON.replaceAll('\n', '\r\n')
const accessStripped = (key) => say(key).replace('&', '')

function readSettings(app) {
  return fs.existsSync(app.settingsPath) ? JSON.parse(fs.readFileSync(app.settingsPath, 'utf8')) : null
}

async function until(probe, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value || Date.now() > deadline) return value
    await sleep(POLL_MS)
  }
}

const info = (app) => osInput(app.child.pid, 'info')

const waitDialog = (app, title, timeoutMs) =>
  until(() => {
    const window = info(app)
    return window.CLASS === DIALOG_CLASS && window.TITLE === title ? window : null
  }, timeoutMs)

const waitTitle = (app, wanted) =>
  until(() => {
    const window = info(app)
    return window.CLASS !== DIALOG_CLASS && window.TITLE === wanted ? window : null
  })

const VERSION = JSON.parse(fs.readFileSync(path.join(productRoot, 'package.json'), 'utf8')).version
const titleOf = (file, dirty = false) => `${dirty ? DIRTY : ''}${path.basename(file)} - ${say('app.title')} ${VERSION}`

// ダイアログの窓が見えてから UI Automation の項目がそろうまでに間がある
const press = (app, position) => until(() => osInput(app.child.pid, 'press', String(position)).PRESSED === '1')

const buttons = async (app) => ((await until(() => osInput(app.child.pid, 'buttons').BUTTONS)) ?? '').split('|')

const chooseFile = (app, file) => until(() => osInput(app.child.pid, 'openfile', file).PRESSED === '1')

async function editCell(page, from, to) {
  await page.getByText(from, { exact: true }).dblclick({ timeout: SELECTOR_TIMEOUT_MS })
  await sleep(SETTLE_MS)
  await page.keyboard.press('Control+A')
  await page.keyboard.type(to)
  await page.keyboard.press('Enter')
  await sleep(EDIT_SETTLE_MS)
}

const readNotice = (page) => page.evaluate(() => document.querySelector('.app-notice:not([hidden])')?.textContent ?? '')

/** 帯は前の知らせを残していることがあるので、望む文に変わるまで待つ。最後に読めた文を返す。 */
async function waitNotice(page, wanted) {
  await until(async () => (await readNotice(page)) === wanted)
  return readNotice(page)
}

async function openMenuItem(page, groupIndex, label) {
  await page.locator('.app-menubar-button').nth(groupIndex).click()
  await page.locator('.app-menu-item', { hasText: label }).click()
  await sleep(SETTLE_MS)
}

/** 履歴の一覧を開く。長いパスの一覧は親の項目に重なるので、押さず指すだけにする。 */
async function showRecent(page) {
  await page.locator('.app-menubar-button').first().click()
  await page.locator('.app-menu-item', { hasText: accessStripped('app.menu.openRecent') }).hover()
  await sleep(SETTLE_MS)
}

async function recentLabels(page) {
  await showRecent(page)
  const labels = await page
    .locator('.app-menu-popup')
    .last()
    .locator('.app-menu-label')
    .allTextContents()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('.jse-main')?.focus())
  return labels
}

async function pickRecent(page, label) {
  await showRecent(page)
  await page.locator('.app-menu-popup').last().locator('.app-menu-item', { hasText: label }).click()
}

/** 画面が出した確認のボタンを控える。同じスレッドの 2 度目のダイアログは UI Automation で読めないことがある。 */
const recordAsks = (page) =>
  page.evaluate(() => {
    const original = window.fetch
    window.__askButtons = []
    window.fetch = (url, options) => {
      if (String(url).endsWith('/ask')) window.__askButtons.push(JSON.parse(options.body).request.buttons)
      return original(url, options)
    }
  })

const lastAskButtons = (page) => page.evaluate(() => window.__askButtons.at(-1) ?? [])

const invoke = (page, command, args) =>
  page.evaluate(([name, values]) => window.__TAURI_INTERNALS__.invoke(name, values), [command, args])

/** 開く、編集、保存、閉じる確認、外部変更。 */
async function saveAndClose({ report, app, page, file }) {
  report.check('起動引数の文書が開く', await waitTitle(app, titleOf(file)), info(app).TITLE)
  report.check('開いた文書が履歴の先頭に来る', (await until(() => readSettings(app)?.recentFiles?.[0] === file)))

  await editCell(page, DOCUMENT_CELL, '編集1')
  report.check('編集でタイトルに印が付く', await waitTitle(app, titleOf(file, true)), info(app).TITLE)
  report.check('編集だけではファイルが変わらない', fs.readFileSync(file, 'utf8') === CRLF_JSON)

  await page.keyboard.press('Control+S')
  report.check('Ctrl+S で印が消える', await waitTitle(app, titleOf(file)), info(app).TITLE)
  const saved = fs.readFileSync(file, 'utf8')
  report.check('Ctrl+S で書かれる', saved.includes('編集1') && !saved.includes(DOCUMENT_CELL))
  report.check('改行の書式を保つ', saved.includes('\r\n') && !/[^\r]\n/.test(saved))

  await editCell(page, '編集1', '編集2')
  osInput(app.child.pid, 'close')
  report.check('×で未保存の確認が出る', await waitDialog(app, say('app.dialog.unsavedTitle')))
  const unsavedButtons = await buttons(app)
  report.check(
    '未保存の確認は 3 択',
    unsavedButtons.join() === [say('app.dialog.save'), say('app.dialog.dontSave'), say('app.dialog.cancel')].join(),
    unsavedButtons.join()
  )
  await press(app, CANCEL_BUTTON)
  report.check('キャンセルで窓が残る', await waitTitle(app, titleOf(file, true)), info(app).TITLE)
  report.check('キャンセルでプロセスが残る', app.child.exitCode === null)
  report.check('キャンセルでファイルが変わらない', fs.readFileSync(file, 'utf8') === saved)

  // 前面になれないときは何も送らない。送れたときだけ判定する
  const altF4 = await until(() => {
    const sent = osInput(app.child.pid, 'send', '%{F4}')
    return sent.FOREGROUND === '1' ? sent : null
  })
  if (altF4) {
    report.check('Alt+F4 でも未保存の確認が出る', await waitDialog(app, say('app.dialog.unsavedTitle')))
    await press(app, CANCEL_BUTTON)
    await waitTitle(app, titleOf(file, true))
  } else {
    report.note('Alt+F4', '試験の窓が前面になれず、送らなかった')
  }

  await openMenuItem(page, 0, accessStripped('app.menu.exit'))
  report.check('File の終了でも未保存の確認が出る', await waitDialog(app, say('app.dialog.unsavedTitle')))
  await press(app, CANCEL_BUTTON)
  await waitTitle(app, titleOf(file, true))

  await page.keyboard.press('Control+S')
  await waitTitle(app, titleOf(file))
  const external = `${SAMPLE_JSON.trimEnd()}\n`
  fs.writeFileSync(file, external)
  await editCell(page, '編集2', '編集3')
  await page.keyboard.press('Control+S')
  report.check('外部変更の後の Ctrl+S で確認が出る', await waitDialog(app, say('app.dialog.externalTitle')))
  const externalButtons = await lastAskButtons(page)
  report.check(
    '外部変更の確認は 3 択',
    externalButtons.join() === [say('app.dialog.saveAs'), say('app.dialog.overwrite'), say('app.dialog.cancel')].join(),
    externalButtons.join()
  )
  await press(app, CANCEL_BUTTON)
  await waitTitle(app, titleOf(file, true))
  report.check('キャンセルなら外部の内容が残る', fs.readFileSync(file, 'utf8') === external)

  await page.keyboard.press('Control+S')
  await waitDialog(app, say('app.dialog.externalTitle'))
  await press(app, EXTERNAL_OVERWRITE)
  report.check('上書きを選ぶと印が消える', await waitTitle(app, titleOf(file)), info(app).TITLE)
  report.check('上書きを選ぶと編集が書かれる', fs.readFileSync(file, 'utf8').includes('編集3'))
}

/** 別のファイル、履歴、消えたファイル。 */
async function recentFiles({ report, app, page, file }) {
  const other = tempDocument(SAMPLE_JSON, 'other.json')
  const stranger = tempDocument(SAMPLE_JSON, 'stranger.json')
  try {
    await page.keyboard.press('Control+O')
    report.check('Ctrl+O でダイアログが出る', await until(() => info(app).CLASS === DIALOG_CLASS, OPEN_DIALOG_TIMEOUT_MS))
    report.check('ダイアログへパスを渡せた', await chooseFile(app, other))
    report.check('ダイアログで選んだファイルが開く', await waitTitle(app, titleOf(other)), info(app).TITLE)
    report.check(
      '別のファイルを開くと履歴の先頭に来る',
      await until(() => readSettings(app)?.recentFiles?.join() === [other, file].join()),
      readSettings(app)?.recentFiles?.join()
    )
    await sleep(SETTLE_MS)
    const listed = await recentLabels(page)
    report.check('メニューの履歴が新しい順', listed.slice(0, 2).join() === [other, file].join(), listed.join())

    fs.rmSync(other)
    await editCell(page, DOCUMENT_CELL, '編集4')
    await page.keyboard.press('Control+S')
    report.check('消えたファイルの Ctrl+S で確認が出る', await waitDialog(app, say('app.dialog.missingTitle')))
    const missingButtons = await lastAskButtons(page)
    report.check(
      '消えたファイルの確認は 3 択',
      missingButtons.join() === [say('app.dialog.saveNew'), say('app.dialog.saveAs'), say('app.dialog.cancel')].join(),
      missingButtons.join()
    )
    await press(app, CANCEL_BUTTON)
    report.check('キャンセルなら再作成しない', await waitTitle(app, titleOf(other, true)) && !fs.existsSync(other))

    await pickRecent(page, file)
    report.check('履歴の項目は未保存の確認を通る', await waitDialog(app, say('app.dialog.unsavedTitle')))
    await press(app, UNSAVED_DONT_SAVE)
    report.check('保存しないを選ぶと履歴の文書が開く', await waitTitle(app, titleOf(file)), info(app).TITLE)
    await sleep(SETTLE_MS)

    await pickRecent(page, other)
    const notice = await waitNotice(page, say('app.notice.recentMissing'))
    report.check('消えたファイルは理由が出る', notice === say('app.notice.recentMissing'), notice)
    report.check(
      '消えたファイルは履歴から外れる',
      await until(() => readSettings(app)?.recentFiles?.join() === file),
      readSettings(app)?.recentFiles?.join()
    )
    report.check('消えたファイルの後も文書は変わらない', info(app).TITLE === titleOf(file), info(app).TITLE)

    await invoke(page, 'open_recent', { path: stranger })
    await sleep(EDIT_SETTLE_MS)
    report.check('一覧に無いパスを画面から渡しても開かない', info(app).TITLE === titleOf(file), info(app).TITLE)
    const refused = await page
      .evaluate(async (path) => {
        const frame = await window.__TAURI_INTERNALS__.invoke('open_document', { path, accept: {} })
        return new TextDecoder().decode(frame)
      }, stranger)
      .catch(String)
    report.check('一覧に無いパスは読めない', refused.includes('Denied'), refused.slice(0, 80))

    await showRecent(page)
    await page.locator('.app-menu-popup').last().locator('.app-menu-item', { hasText: accessStripped('app.menu.recentClear') }).click()
    report.check(
      '一覧を消せる',
      await until(() => readSettings(app)?.recentFiles?.length === 0),
      JSON.stringify(readSettings(app)?.recentFiles)
    )
    await sleep(SETTLE_MS)
    const cleared = await recentLabels(page)
    report.check('消した後はメニューが空になる', cleared.includes(say('app.menu.recentEmpty')), cleared.join())
  } finally {
    fs.rmSync(path.dirname(other), { recursive: true, force: true })
    fs.rmSync(path.dirname(stranger), { recursive: true, force: true })
  }
}

/** 手で直した設定が起動で効き、知らないキーが残り、壊れた設定で起動する。 */
async function settings({ report, exe, out, home, file }) {
  const settingsPath = path.join(home, 'JsonGridder.settings.json')
  const placed = { x: 150, y: 160, width: 1300, height: 950, maximized: false }
  fs.writeFileSync(settingsPath, JSON.stringify({ mine: { kept: 1 }, theme: 'dark', window: placed, recentFiles: [file] }))

  let port = await freePort()
  let app = await launch({ exe, out, port, file, home })
  try {
    const { browser, page } = await connect(port)
    const window = await until(() => {
      const current = info(app)
      return current.TITLE === titleOf(file) ? current : null
    })
    const inner = await page.evaluate(() => ({
      scale: devicePixelRatio,
      width: Math.round(innerWidth * devicePixelRatio),
      theme: document.documentElement.dataset.theme
    }))
    // input.ps1 は DPI を意識しないプロセスなので、座標は論理ピクセルで返る
    const [x, y] = (window?.RECT ?? '').split(',').map((value) => Number(value) * inner.scale)
    report.check(
      '手で直した位置が起動で効く',
      Math.abs(x - placed.x) <= SCREEN_TOLERANCE_PX && Math.abs(y - placed.y) <= SCREEN_TOLERANCE_PX,
      `${x},${y}`
    )
    report.check('手で直した大きさが起動で効く', Math.abs(inner.width - placed.width) <= SCREEN_TOLERANCE_PX, inner.width)
    report.check('手で直したテーマが起動で効く', inner.theme === 'dark', inner.theme)
    await openMenuItem(page, 2, accessStripped('app.menu.light'))
    report.check('Light が設定へ保存される', await until(() => readSettings(app)?.theme === 'light'))
    const recent = await recentLabels(page)
    report.check('手で直した履歴がメニューに出る', recent.includes(file), recent.join())
    osInput(app.child.pid, 'close')
    report.check('未編集なら×で確認なしに閉じる', (await Promise.race([app.exited, sleep(WAIT_TIMEOUT_MS).then(() => 'timeout')])) === 0)
    const saved = readSettings(app)
    report.check('知らないキーが保存で残る', saved?.mine?.kept === 1, JSON.stringify(saved?.mine))
    report.check('閉じると窓の位置が書かれる', saved?.window?.x === placed.x, JSON.stringify(saved?.window))
    await browser.close().catch(() => {})
  } finally {
    await stop(app, { keepHome: true })
  }

  fs.writeFileSync(settingsPath, '{ broken')
  port = await freePort()
  app = await launch({ exe, out, port, home })
  try {
    const { browser, page } = await connect(port)
    const notice = await waitNotice(page, say('app.notice.settingsBroken'))
    report.check('壊れた設定で起動し知らせる', notice === say('app.notice.settingsBroken'), notice)
    report.check('壊れた設定は .broken で残る', fs.readFileSync(`${settingsPath}.broken`, 'utf8') === '{ broken')

    fs.writeFileSync(settingsPath, '{}')
    fs.chmodSync(settingsPath, 0o444)
    await openMenuItem(page, 2, accessStripped('app.menu.dark'))
    const denied = await waitNotice(page, say('app.notice.settingsUnwritable'))
    report.check('書けない設定で落ちず知らせる', denied === say('app.notice.settingsUnwritable'), denied)
    report.check('書けなくても動き続ける', app.child.exitCode === null)
    await browser.close().catch(() => {})
  } finally {
    // 途中で落ちて設定が無いときも、元の失敗を隠さない
    if (fs.existsSync(settingsPath)) fs.chmodSync(settingsPath, 0o666)
    await stop(app, { keepHome: true })
  }
}

const nestedJson = (depth) => `${'['.repeat(depth)}${']'.repeat(depth)}\n`

/** ツリーの表示のまま深い文書を開く。読めれば行が出て、スタックが尽きれば置き換えに失敗する。 */
async function measureDepth({ exe, out, depth }) {
  const port = await freePort()
  const deep = tempDocument(nestedJson(depth), `deep-${depth}.json`)
  const app = await launch({ exe, out, port, text: SAMPLE_JSON })
  const row = { depth }
  try {
    const { browser, page } = await connect(port)
    await waitForDocument(page)
    row.treeBeforeOpen = await switchMode(page, 'ツリー')
    await page.keyboard.press('Control+O')
    await until(() => info(app).CLASS === DIALOG_CLASS, OPEN_DIALOG_TIMEOUT_MS)
    await chooseFile(app, deep)
    row.opened = Boolean(await waitTitle(app, titleOf(deep)))
    row.modeAfterOpen = await activeMode(page)
    row.notice = await readNotice(page)
    row.replaceFailed = row.notice === say('app.notice.replaceFailed')
    // 開いた後に利用者がツリーへ切り替える場面
    row.treeAfterOpen = await switchMode(page, 'ツリー')
    await sleep(SETTLE_MS)
    row.noticeAfterTree = await readNotice(page)
    row.alive = await page.evaluate(() => true).catch(() => false)
    await browser.close().catch(() => {})
  } catch (error) {
    row.error = String(error).slice(0, 200)
  } finally {
    await stop(app)
    fs.rmSync(path.dirname(deep), { recursive: true, force: true })
  }
  return row
}

export async function run({ exe, out }, name = 'shell-through') {
  const report = createReport(name)
  const file = tempDocument(CRLF_JSON, 'first.json')
  const port = await freePort()
  const app = await launch({ exe, out, port, file })
  let home = app.home
  try {
    const { browser, page } = await connect(port)
    await recordAsks(page)
    await saveAndClose({ report, app, page, file })
    await recentFiles({ report, app, page, file })
    await browser.close().catch(() => {})
    await stop(app, { keepHome: true })
    await settings({ report, exe, out, home, file })

    const rows = []
    for (const depth of DEPTHS) rows.push(await measureDepth({ exe, out, depth }))
    fs.writeFileSync(path.join(out, 'shell-through-depth.json'), JSON.stringify(rows, null, 2))
    report.note('深さの実測', rows)
    report.check('深さの実測が走る', rows.every((row) => !row.error), rows.find((row) => row.error)?.error)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
    await stop(app, { keepHome: true }).catch(() => {})
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
  return report
}

await runCli(import.meta.url, run)
