// 単体の EXE として配って使えることを、実 EXE で確かめる。
// 一時フォルダへ EXE を写して起動し、窓が出るのを確かめて閉じる。OS の入力は送らない（窓の問い合わせだけ）。
//   1 日本語を含むパス、管理者権限なしで起動できる
//   2 設定が EXE の隣にでき、フォルダごと移すと付いてくる
//   3 読み取り専用のフォルダでも落ちず、保存できないことを知らせる
//   4 起動の前後で .json の既定と HKCU の関連付けが変わらない
//   5 引数のパス（日本語を含む）で文書が開く
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SAMPLE_JSON,
  SETTINGS_FILE,
  connect,
  createReport,
  freePort,
  launch,
  osInput,
  productRoot,
  runCli,
  sleep,
  stop,
  waitForDocument
} from './lib.mjs'

const POLL_MS = 250
const VISIBLE_TIMEOUT_MS = 15000
const SETTINGS_TIMEOUT_MS = 10000
const NOTICE_TIMEOUT_MS = 10000
const RM_RETRIES = 10
const RM_RETRY_DELAY_MS = 300
// lib.mjs の cleanup.mjs が拾う接頭辞に揃える
const EXE_DIR_PREFIX = 'jgv-exe-'
const DOC_DIR_PREFIX = 'jgv-doc-'
const JAPANESE_EXE_DIR = '日本語 の フォルダ'
const JAPANESE_DOC_DIR = '文書 の 置き場'
const JAPANESE_DOC_NAME = '顧客 山田.json'
const HIGH_INTEGRITY_SID = 'S-1-16-12288'
const EVERYONE_SID = '*S-1-1-0'
const DENY_WRITE = `${EVERYONE_SID}:(WD,AD)`
// 設定が無ければ英語で出る。日本語へ替えて、設定が書かれ、移した先でも効くことを見る
const UI_CHANGE = { language: 'ja' }
const UI_LABELS_EN = 'text,tree,table'
const UI_LABELS_JA = 'テキスト,ツリー,表'
const USER_CHOICE_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.json\UserChoice`
const CLASSES_KEY = String.raw`HKCU\Software\Classes\.json`

const dictionaryOf = (code) =>
  JSON.parse(fs.readFileSync(path.join(productRoot, `src/i18n/${code}.json`), 'utf8'))

const removeTree = (folder) =>
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS })

/** reg query の出力。キーが無ければ 'absent'。値の差を見るので出力そのものを比べる。 */
function registrySnapshot() {
  const read = (key) => {
    const result = spawnSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? result.stdout : 'absent'
  }
  return { userChoice: read(USER_CHOICE_KEY), classes: read(CLASSES_KEY) }
}

function isElevated() {
  const result = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true })
  return (result.stdout ?? '').includes(HIGH_INTEGRITY_SID) && /Mandatory Label\\High/.test(result.stdout)
}

/** 見えない窓を本体と取り違えないよう、題で見分ける。 */
async function waitVisible(app, title) {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = osInput(app.child.pid, 'info')
    if (info.VISIBLE === '1' && info.TITLE?.includes(title)) return true
    await sleep(POLL_MS)
  }
  return false
}

const modeLabels = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.jse-group-button')].map((button) => button.textContent.trim().toLowerCase()).join()
  )

const changeLanguage = (page) =>
  page.evaluate((change) => window.__TAURI_INTERNALS__.invoke('set_language', change), UI_CHANGE)

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await sleep(POLL_MS)
  }
  return false
}

const readSettings = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 日本語を含むフォルダの中の EXE。launch が EXE を写す。 */
const makeHome = (name) => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), EXE_DIR_PREFIX)), name)
  fs.mkdirSync(home)
  return home
}

async function japanesePathAndSettings({ exe, out }, report, title) {
  const titleJa = title
  const docRoot = fs.mkdtempSync(path.join(os.tmpdir(), DOC_DIR_PREFIX))
  const docFolder = path.join(docRoot, JAPANESE_DOC_DIR)
  fs.mkdirSync(docFolder)
  const document = path.join(docFolder, JAPANESE_DOC_NAME)
  fs.writeFileSync(document, SAMPLE_JSON)
  const home = makeHome(JAPANESE_EXE_DIR)
  const moved = makeHome('移した先')
  const port = await freePort()
  let app = null
  let browser = null
  try {
    const before = registrySnapshot()
    report.note('起動前の .json の関連付け', {
      userChoice: before.userChoice === 'absent' ? 'absent' : `${before.userChoice.length} 文字`,
      classes: before.classes === 'absent' ? 'absent' : `${before.classes.length} 文字`
    })
    report.check('管理者権限なしで起動する（試験の実行者が昇格していない）', !isElevated(), 'whoami /groups')

    app = await launch({ exe, out, port, file: document, home })
    report.check('EXE が日本語を含むパスにある', /[^\x00-\x7f]/.test(app.home), path.basename(app.home))
    const connected = await connect(port)
    browser = connected.browser
    const { page } = connected
    report.check('日本語を含むパスの EXE が起動し、窓が見える', await waitVisible(app, titleJa), `起動から ${Date.now() - app.startedAt} ms`)
    await waitForDocument(page)
    report.check('引数の日本語パスの文書が表に開く', true, path.basename(document))
    report.check('設定が無いので最初は英語で出る', (await modeLabels(page)) === UI_LABELS_EN, await modeLabels(page))

    const during = registrySnapshot()
    report.check('起動中も .json の既定が変わらない', during.userChoice === before.userChoice, '')

    await changeLanguage(page)
    const written = await waitFor(() => readSettings(app.settingsPath)?.language === UI_CHANGE.language, SETTINGS_TIMEOUT_MS)
    report.check('設定ファイルが EXE の隣にできる', written, path.join(path.basename(app.home), SETTINGS_FILE))
    report.note('EXE の隣にあるもの', fs.readdirSync(app.home).sort())
    await browser.close().catch(() => {})
    browser = null
    await stop(app, { keepHome: true })

    const after = registrySnapshot()
    report.check('終了後も .json の既定（UserChoice）が変わらない', after.userChoice === before.userChoice, '')
    report.check('HKCU\\Software\\Classes\\.json に何も書かれない', after.classes === before.classes, '')

    // EXE と設定を別のフォルダへ移す（コピー）。移した先で、設定が付いてくる
    // fs.cpSync は日本語のパスで Node ごと落ちるので、1 ファイルずつ写す
    for (const entry of fs.readdirSync(app.home, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(app.home, entry.name), path.join(moved, entry.name))
    }
    const movedPort = await freePort()
    const second = await launch({ exe, out, port: movedPort, home: moved })
    let secondBrowser = null
    try {
      const reached = await connect(movedPort)
      secondBrowser = reached.browser
      const labels = await modeLabels(reached.page)
      report.check('別のフォルダへ移すと設定が付いてくる', labels === UI_LABELS_JA, labels)
      await secondBrowser.close().catch(() => {})
      secondBrowser = null
    } finally {
      if (secondBrowser) await secondBrowser.close().catch(() => {})
      await stop(second)
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (app) await stop(app).catch(() => {})
    for (const folder of [path.dirname(home), path.dirname(moved), docRoot]) removeTree(folder)
  }
}

async function readOnlyFolder({ exe, out }, report, title) {
  const home = makeHome('読み取り専用')
  fs.copyFileSync(exe, path.join(home, path.basename(exe)))
  const port = await freePort()
  const notice = dictionaryOf('ja')['app.notice.settingsUnwritable']
  let app = null
  let browser = null
  try {
    const denied = spawnSync('icacls', [home, '/deny', DENY_WRITE], { encoding: 'utf8', windowsHide: true })
    report.check('フォルダを読み取り専用にできた', denied.status === 0, (denied.stdout ?? '').split(/\r?\n/)[0])
    app = await launch({ exe, out, port, home })
    const connected = await connect(port)
    browser = connected.browser
    const { page } = connected
    report.check('読み取り専用のフォルダからでも窓が出る', await waitVisible(app, title), `起動から ${Date.now() - app.startedAt} ms`)
    await changeLanguage(page).catch(() => {})
    const told = await page
      .waitForFunction((text) => document.body.innerText.includes(text), notice, { timeout: NOTICE_TIMEOUT_MS })
      .then(() => true, () => false)
    report.check('保存できないことを知らせる', told, notice.slice(0, 20))
    report.check('設定ファイルは作られない', !fs.existsSync(path.join(home, SETTINGS_FILE)), '')
    report.check('まだ動いている', app.child.exitCode === null, `exitCode=${app.child.exitCode}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (app) await stop(app, { keepHome: true }).catch(() => {})
    spawnSync('icacls', [home, '/reset', '/T', '/Q'], { windowsHide: true })
    removeTree(path.dirname(home))
  }
}

export async function run({ exe, out }, name = 'portable') {
  const report = createReport(name)
  const title = dictionaryOf('ja')['app.title']
  try {
    await japanesePathAndSettings({ exe, out }, report, title)
    await readOnlyFolder({ exe, out }, report, title)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  }
  return report
}

await runCli(import.meta.url, run)
