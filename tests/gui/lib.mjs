// 実 EXE を動かす試験の共通部品。窓を出すので、人が操作していない時間に回す。
// 製品のコードに口は無い。WebView2 の環境変数でデバッグポートを開ける。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { formatPidRecord, parsePidRecords } from './pid-record.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const productRoot = path.resolve(here, '../..')
const inputScript = path.join(here, 'input.ps1')
const webviewScript = path.join(here, 'webview-procs.ps1')
const defaultExe = path.join(productRoot, 'src-tauri/target/release/JsonGridder.exe')

const CONNECT_TIMEOUT_MS = 30000
const POLL_INTERVAL_MS = 250
const INPUT_TIMEOUT_MS = 45000
const STOP_TIMEOUT_MS = 10000
const RM_ATTEMPTS = 3
const RM_RETRIES = 10
const RM_RETRY_DELAY_MS = 300 // WebView2 がファイルを離すまで待つ
const MODE_SWITCH_TIMEOUT_MS = 2000
const MENU_MIN_HEIGHT_PX = 60 // メニューは項目が複数並ぶ。1 行のヒントの窓より必ず高い
const PRODUCT_URL = /tauri\.localhost/
const SPLASH_URL = /splash\.html/
const DOCUMENT_FILE = 'doc.json'
const EXE_PREFIX = 'jgv-exe-'
const DOCUMENT_PREFIX = 'jgv-doc-'
const WEBVIEW_PREFIX = 'jgv-webview-'
export const SELECTOR_TIMEOUT_MS = 15000
export const SETTINGS_FILE = 'JsonGridder.settings.json'
export const TEMP_PREFIXES = [EXE_PREFIX, DOCUMENT_PREFIX, WEBVIEW_PREFIX]
/** 試験の文書の目印。表のセルに出る。 */
export const DOCUMENT_CELL = '山田'
export const SAMPLE_JSON = `${JSON.stringify(
  [
    { id: 1, name: DOCUMENT_CELL, city: '東京', note: 'セルを選んで日本語を入力できます' },
    { id: 2, name: '佐藤', city: '大阪', note: '' },
    { id: 3, name: '鈴木', city: '名古屋' },
    { id: 4, name: 'Tanaka', city: 'Fukuoka', note: 'ascii' }
  ],
  null,
  2
)}\n`

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseOptions(argv = process.argv.slice(2)) {
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    check: argv.includes('--check'),
    exe: path.resolve(value('--exe') ?? defaultExe),
    out: value('--out'),
    mutants: value('--mutants')
  }
}

function pidFile(out) {
  return path.join(out, 'pids.txt')
}

/** 消せなかった一時フォルダの記録。cleanup.mjs が後で消す。 */
export function leftoverFile(out) {
  return path.join(out, 'leftovers.txt')
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 試験の文書を一時フォルダに置き、パスを返す。 */
export function tempDocument(text = SAMPLE_JSON, name = DOCUMENT_FILE) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), DOCUMENT_PREFIX)), name)
  fs.writeFileSync(file, text)
  return file
}

/**
 * 設定は EXE の隣に書かれるので、EXE を一時フォルダへ写して動かす。確認用の EXE の設定を汚さない。
 * `home` を渡すと前の起動の設定を引き継ぐ。`file` か `text` を渡すと、起動引数でその文書を開く。
 * `settings` を渡すと、設定ファイルがまだ無いときに限り、起動の前に EXE の隣へ書く（例: 日本語の画面で試す）。
 */
export async function launch({ exe, out, browserArgs = '', port, file, text, home, settings }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), WEBVIEW_PREFIX))
  const args = [port ? `--remote-debugging-port=${port}` : '', browserArgs].filter(Boolean).join(' ')
  const exeHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), EXE_PREFIX))
  const settingsFile = path.join(exeHome, SETTINGS_FILE)
  if (settings && !fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify(settings))
  const copied = path.join(exeHome, path.basename(exe))
  if (!fs.existsSync(copied)) fs.copyFileSync(exe, copied)
  const document = text === undefined ? file : tempDocument(text)
  const child = spawn(copied, document ? [document] : [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: userData,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args
    },
    stdio: 'ignore',
    windowsHide: true
  })
  fs.appendFileSync(pidFile(out), formatPidRecord(child.pid, exe))
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve('spawn-error'))
  })
  return {
    child,
    exited,
    startedAt: Date.now(),
    userData,
    out,
    home: exeHome,
    file: document,
    ownsDocument: text !== undefined,
    settingsPath: path.join(exeHome, SETTINGS_FILE)
  }
}

/** その起動の一時フォルダを使っている WebView2 のプロセスの一覧。 */
function webviewProcesses(userData) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', webviewScript, '-Folder', path.basename(userData)],
    { encoding: 'utf8', timeout: INPUT_TIMEOUT_MS, windowsHide: true }
  )
  return (result.stdout ?? '').split(/\s+/).filter(Boolean)
}

/** EXE が終わっても WebView2 のプロセスは少し残る。終わるのを待ち、残れば終わらせる。 */
async function waitForWebviewExit(userData) {
  const deadline = Date.now() + STOP_TIMEOUT_MS
  let running = webviewProcesses(userData)
  while (running.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    running = webviewProcesses(userData)
  }
  for (const pid of running) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true })
  }
  return running
}

async function removeFolder(folder) {
  let failure = null
  for (let attempt = 0; attempt < RM_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS })
      return null
    } catch (error) {
      failure = error
      await sleep(STOP_TIMEOUT_MS / RM_ATTEMPTS)
    }
  }
  return failure
}

/** プロセスの木ごと終わらせ、終わりを待ち、その起動の痕跡を消す。消せなくても試験は止めない。 */
export async function stop(app, { keepHome = false } = {}) {
  const { child, exited, userData, out, home, file, ownsDocument } = app
  if (child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    await Promise.race([exited, sleep(STOP_TIMEOUT_MS)])
  }
  const forced = await waitForWebviewExit(userData)
  if (forced.length > 0) console.log(`WARN [stop] 待っても残った WebView2 を終わらせた : ${forced.join(' ')}`)
  const folders = [userData, ...(keepHome ? [] : [home]), ...(ownsDocument ? [path.dirname(file)] : [])]
  for (const folder of folders) {
    const failure = await removeFolder(folder)
    if (failure) {
      const holders = webviewProcesses(userData)
      console.log(`WARN [stop] 一時フォルダを消せない : ${folder} ${failure.code} 残るプロセス=${holders.join(' ') || 'なし'}`)
      fs.appendFileSync(leftoverFile(out), `${folder}\n`)
    }
  }
  const remaining = parsePidRecords(fs.readFileSync(pidFile(out), 'utf8')).filter(
    (record) => record.pid !== String(child.pid)
  )
  fs.writeFileSync(pidFile(out), remaining.map((record) => formatPidRecord(record.pid, record.image)).join(''))
}

async function findPage(port) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      while (Date.now() < deadline) {
        // 直接の起動では、起動画面の窓も同じデバッグの口に見える（閉じると対象が消える）。
        // 本体の窓だけを取る。起動画面の方は、製品のページに移る前の空のページと見分けられないので、
        // 製品のページに移ったものだけを本体とする
        const page = browser
          .contexts()[0]
          ?.pages()
          .find((candidate) => PRODUCT_URL.test(candidate.url()) && !SPLASH_URL.test(candidate.url()))
        if (page) return { browser, page }
        await sleep(POLL_INTERVAL_MS)
      }
    } catch {
      await sleep(POLL_INTERVAL_MS)
    }
  }
  throw new Error('could not reach the debug port')
}

/** 接続の時点から、メインのフレームのナビゲーションを記録する。 */
function watchNavigations(page) {
  const startedAt = Date.now()
  const events = [{ ms: 0, event: 'connected', url: page.url() }]
  const record = (event) => events.push({ ms: Date.now() - startedAt, ...event })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) record({ event: 'framenavigated', url: frame.url() })
  })
  return { events, record }
}

async function navigationHistory(page) {
  const session = await page.context().newCDPSession(page)
  const { entries } = await session.send('Page.getNavigationHistory')
  await session.detach()
  return entries.map((entry) => entry.url)
}

/**
 * デバッグの口には、製品のページへ移る前の空のページが先に見える。
 * そのページで evaluate すると、移った時点で文脈が壊れる。製品の画面ができるまで待ってから返す。
 */
export async function connect(port) {
  const { browser, page } = await findPage(port)
  const { events, record } = watchNavigations(page)
  await page.evaluate(() => location.href).then(
    (url) => record({ event: 'evaluate', url }),
    (error) => record({ event: 'evaluate-failed', error: String(error).slice(0, 120) })
  )
  await page.waitForSelector('.jse-main', { timeout: SELECTOR_TIMEOUT_MS })
  record({ event: 'ready', url: page.url() })
  const history = await navigationHistory(page)
  const loads = await page.evaluate(() => performance.getEntriesByType('navigation').map((entry) => entry.type))
  return { browser, page, navigations: { events, history, loads } }
}

/** 起動引数の文書が表に出るまで待つ。 */
export const waitForDocument = (page) =>
  page.waitForFunction(
    (cell) => document.querySelector('.jse-main')?.innerText.includes(cell),
    DOCUMENT_CELL,
    { timeout: SELECTOR_TIMEOUT_MS }
  )

/** 製品のページを読み込んだ回数。2 回以上なら起動で再読み込みが起きている。 */
export const productLoadCount = ({ events, history }) =>
  Math.max(
    history.filter((url) => PRODUCT_URL.test(url)).length,
    events.filter((item) => item.event === 'framenavigated' && PRODUCT_URL.test(item.url)).length
  )

/** input.ps1 を呼び、KEY=VALUE の行を連想配列で返す。 */
export function osInput(pid, action, keys = '') {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inputScript, '-TargetPid', String(pid), '-Action', action, '-Keys', keys],
    { encoding: 'utf8', timeout: INPUT_TIMEOUT_MS, windowsHide: true }
  )
  const fields = {}
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1)
  }
  if (result.stderr) fields.STDERR = result.stderr.slice(0, 300)
  return fields
}

/** 右クリックで開いた窓のうち、メニューの大きさの物。小さな窓（ヒントの表示）は数えない。 */
export const menuWindows = (opened) =>
  (opened ?? '')
    .split('|')
    .filter(Boolean)
    .filter((item) => Number(item.split('x').pop()) >= MENU_MIN_HEIGHT_PX)

export function createReport(name) {
  const checks = []
  const notes = []
  return {
    name,
    checks,
    notes,
    check(label, passed, detail = '') {
      checks.push({ label, passed: !!passed, detail: String(detail) })
      console.log(`${passed ? 'PASS' : 'FAIL'} [${name}] ${label}${detail ? ` : ${detail}` : ''}`)
    },
    /** 合否に入れない記録。 */
    note(label, value) {
      notes.push({ label, value })
      console.log(`NOTE [${name}] ${label} : ${JSON.stringify(value)}`)
    },
    get passed() {
      return checks.length > 0 && checks.every((item) => item.passed)
    }
  }
}

export function clickMode(page, label) {
  return page.click(`.jse-group-button:has-text("${label}")`, { timeout: SELECTOR_TIMEOUT_MS })
}

export const activeMode = (page) =>
  page.evaluate(() => document.querySelector('.jse-group-button.jse-selected')?.textContent.trim() ?? '')

/** 表示のボタンを押し、その表示へ切り替わったかを返す。押せただけでは切り替わったと言えない。 */
export async function switchMode(page, label) {
  await clickMode(page, label)
  const deadline = Date.now() + MODE_SWITCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await activeMode(page)) === label) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * 今の表示と文書を読む。doc は CodeMirror の文書そのもの。画面に出ていない行は
 * DOM に無いので、テキストの表示の文書は DOM でなくこちらで判定する。
 */
export const readDocument = (page) =>
  page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    return {
      mode: document.querySelector('.jse-group-button.jse-selected')?.textContent.trim() ?? '',
      dom: content?.textContent ?? null,
      doc: content?.cmTile?.root?.view?.state.doc.toString() ?? null,
      body: document.querySelector('.jse-main')?.innerText ?? ''
    }
  })

export const MODES = ['表', 'ツリー', 'テキスト']

/** 試験の入口。--check は机を使わず、部品の有無だけを見る。 */
export async function runCli(moduleUrl, run) {
  if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href !== moduleUrl) return
  const options = parseOptions()
  if (options.check) {
    console.log(`exe ${fs.existsSync(options.exe)} input ${fs.existsSync(inputScript)}`)
    return
  }
  if (!options.out) {
    console.error('--out <dir> is required')
    process.exit(2)
  }
  fs.mkdirSync(options.out, { recursive: true })
  const report = await run(options)
  process.exit(report.passed ? 0 : 1)
}
