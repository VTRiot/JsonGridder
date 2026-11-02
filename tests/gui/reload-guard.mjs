// F5、Ctrl+R、既定の右クリックで、編集中の文書が消えないことを確かめる。
// 入力は必ず OS から送る。デバッグの口から送ったキーでは再読み込みが起きず、偽の合格になる。
// ページの中で keydown と contextmenu を数え、入力が届いたことも確かめる。
// 操作ごとに表示と目印の有無を trail に残し、--out に reload-guard の名前で書く。
import fs from 'node:fs'
import path from 'node:path'
import {
  MODES,
  SAMPLE_JSON,
  SELECTOR_TIMEOUT_MS,
  activeMode,
  clickMode,
  connect,
  createReport,
  freePort,
  launch,
  menuWindows,
  osInput,
  readDocument,
  runCli,
  sleep,
  stop,
  switchMode,
  waitForDocument
} from './lib.mjs'

const KEYS = [
  { label: 'F5', send: '{F5}', key: 'F5' },
  { label: 'Ctrl+R', send: '^r', key: 'r' },
  { label: 'Shift+F5', send: '+{F5}', key: 'F5' },
  { label: 'Ctrl+F5', send: '^{F5}', key: 'F5' },
  { label: 'Alt+Left', send: '%{LEFT}', key: 'ArrowLeft' }
]
const DOCUMENT_MARK = '777,'
const MARK_DIGITS = '777' // 表とツリーの表示には区切りの文字が出ない
const SETTLE_MS = 900
const EDIT_SETTLE_MS = 600 // テキストの変更がエディタへ渡るまで（上流の TEXT_MODE_ONCHANGE_DELAY より長く）
const RETRIES = 12
const RETRY_MS = 250

export async function install(page) {
  await page.waitForSelector('.jse-main', { timeout: SELECTOR_TIMEOUT_MS })
  await page.evaluate(() => {
    window.__alive = true
    window.__keys = []
    window.__menus = 0
    window.__menuHandledByPage = null
    window.addEventListener('keydown', (event) => window.__keys.push(event.key), true)
    window.addEventListener('contextmenu', () => window.__menus++, true)
    // 表とツリーはエディタが自分のメニューを出すので、既定のメニューの試験になるのはテキストの表示
    window.addEventListener('contextmenu', (event) => (window.__menuHandledByPage = event.defaultPrevented))
  })
}

async function editDocument(page) {
  await clickMode(page, 'テキスト')
  await page.click('.cm-content')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type(DOCUMENT_MARK)
  // 打った直後の切り替えは edit-then-switch.mjs が確かめる。ここでは 3 つの表示を確実に回す
  await sleep(EDIT_SETTLE_MS)
}

export async function isAlive(page) {
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await page.evaluate(() => window.__alive === true)
    } catch {
      await sleep(RETRY_MS) // 読み直しの途中
    }
  }
  return false
}

export async function run({ exe, out }, name = 'reload-guard') {
  const report = createReport(name)
  const port = await freePort()
  const app = await launch({ exe, out, port, text: SAMPLE_JSON, settings: { language: 'ja' } })
  const pid = app.child.pid
  const trail = []
  try {
    const { browser, page, navigations } = await connect(port)
    report.note('起動のナビゲーション', navigations)
    await waitForDocument(page)
    const mark = async (step) => {
      const { mode, doc, body } = await readDocument(page)
      trail.push({ step, mode, marked: (doc ?? body).includes(MARK_DIGITS) })
    }
    await install(page)
    await editDocument(page)
    const edited = await readDocument(page)
    report.check('試験の前に文書を編集できた', edited.doc?.includes(DOCUMENT_MARK), edited.doc?.slice(0, 20))
    await mark('編集の後')

    let reloads = 0
    const afterReload = async () => {
      reloads++
      await install(page)
    }

    for (const mode of MODES) {
      report.check(`${mode}: 表示が切り替わった`, await switchMode(page, mode), await activeMode(page))
      await sleep(SETTLE_MS)
      await mark(`${mode} へ切り替えた後`)
      osInput(pid, 'click') // WebView にキーボードのフォーカスを渡す

      for (const { label, send, key } of KEYS) {
        await page.evaluate(() => {
          window.__keys.length = 0
        })
        const sent = osInput(pid, 'send', send)
        await sleep(SETTLE_MS)
        const alive = await isAlive(page)
        if (alive) {
          const keys = await page.evaluate(() => [...window.__keys])
          report.check(`${mode}: ${label} が届いた`, keys.includes(key), `${keys.join(' ')} 前面=${sent.FOREGROUND}`)
        } else {
          await afterReload()
        }
        report.check(`${mode}: ${label} で再読み込みされない`, alive)
        await mark(`${mode}: ${label}`)
      }

      // 守りを外した対照は再読み込みで最初の表示へ戻る。測る表示を揃える
      if ((await activeMode(page)) !== mode) await switchMode(page, mode)
      const menusBefore = await page.evaluate(() => window.__menus)
      const clicked = osInput(pid, 'rightclick')
      await sleep(SETTLE_MS)
      const opened = menuWindows(clicked.OPENED)
      const alive = await isAlive(page)
      const menusAfter = alive ? await page.evaluate(() => window.__menus) : menusBefore + 1
      report.check(`${mode}: 右クリックが届いた`, menusAfter > menusBefore)
      report.check(`${mode}: 既定の右クリックのメニューが出ない`, opened.length === 0, opened.join(' | '))
      report.note(`${mode}: 右クリック`, {
        mode: alive ? await activeMode(page) : null,
        opened: clicked.OPENED,
        foreground: clicked.FOREGROUND,
        followUp: clicked.FOLLOWUP,
        handledByPage: alive ? await page.evaluate(() => window.__menuHandledByPage) : null
      })
      if (!alive) await afterReload()
      await mark(`${mode}: 右クリック`)
    }

    await switchMode(page, 'テキスト')
    await sleep(SETTLE_MS)
    await mark('最後')
    const final = await readDocument(page)
    const lost = trail.find((item) => !item.marked)?.step ?? 'なし'
    report.check(
      '編集した文書が残っている',
      reloads === 0 && final.mode === 'テキスト' && final.doc === edited.doc,
      `再読み込み ${reloads} 回 表示=${final.mode} 目印が消えた時点=${lost} DOM=${final.dom?.slice(0, 20)} 文書=${final.doc?.slice(0, 20)}`
    )
    await browser.close().catch(() => {})
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    fs.writeFileSync(path.join(out, `${name}-trail.json`), JSON.stringify(trail, null, 2))
    await stop(app)
  }
  return report
}

await runCli(import.meta.url, run)
