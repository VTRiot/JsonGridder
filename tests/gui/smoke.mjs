// 実 EXE で 3 つの表示が日本語で出て、CSP の違反が無いことを確かめる。
import fs from 'node:fs'
import path from 'node:path'
import {
  MODES,
  SAMPLE_JSON,
  SELECTOR_TIMEOUT_MS,
  clickMode,
  connect,
  createReport,
  freePort,
  launch,
  osInput,
  productLoadCount,
  productRoot,
  runCli,
  sleep,
  stop,
  waitForDocument
} from './lib.mjs'

const MODE_SELECTORS = { 表: '.jse-table-mode', ツリー: '.jse-tree-mode', テキスト: '.cm-editor' }
const SETTLE_MS = 500
const VISIBLE_TIMEOUT_MS = 15000

export async function run({ exe, out }) {
  const report = createReport('smoke')
  const port = await freePort()
  const app = await launch({ exe, out, port, text: SAMPLE_JSON })
  try {
    const { browser, page, navigations } = await connect(port)
    report.note('起動のナビゲーション', navigations)
    await waitForDocument(page)
    report.check('起動で製品のページの読み込みは 1 回', productLoadCount(navigations) === 1, productLoadCount(navigations))
    const session = await page.context().newCDPSession(page)
    const logs = []
    session.on('Log.entryAdded', (event) => logs.push(event.entry))
    await session.send('Log.enable') // 製品のページが読み込まれてからの記録は、接続前の分もここで届く
    await page.evaluate(() => {
      window.__csp = []
      document.addEventListener('securitypolicyviolation', (event) => {
        window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`)
      })
    })

    // 見えない窓を本体と取り違えないよう、題で見分ける
    const dictionary = JSON.parse(fs.readFileSync(path.join(productRoot, 'src/i18n/en.json'), 'utf8'))
    let visible = false
    const deadline = Date.now() + VISIBLE_TIMEOUT_MS
    while (!visible && Date.now() < deadline) {
      const info = osInput(app.child.pid, 'info')
      visible = info.VISIBLE === '1' && info.TITLE?.includes(dictionary['app.title'])
      if (!visible) await sleep(SETTLE_MS)
    }
    report.check('窓が見える', visible, `起動から ${Date.now() - app.startedAt} ms`)

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.jse-group-button')].map((button) => button.textContent.trim())
    )
    report.check('3 つの表示の名前が日本語', labels.join() === 'テキスト,ツリー,表', labels.join())

    for (const mode of MODES) {
      await clickMode(page, mode)
      await page.waitForSelector(MODE_SELECTORS[mode], { timeout: SELECTOR_TIMEOUT_MS })
      await sleep(SETTLE_MS)
      report.check(`${mode} が表示される`, true)
      await page.screenshot({ path: path.join(out, `smoke-${MODE_SELECTORS[mode].replace(/\W/g, '')}.png`) })
    }

    const display = await page.evaluate(() => getComputedStyle(document.querySelector('.jse-main')).display)
    report.check('スタイルが効く', display === 'flex', display)
    report.check('接続先は製品のページ', /tauri\.localhost/.test(page.url()), page.url())

    const events = await page.evaluate(() => window.__csp)
    const security = logs.filter((entry) => entry.source === 'security').map((entry) => entry.text)
    report.check('CSP の違反が 0 件', events.length + security.length === 0, [...events, ...security].slice(0, 3).join(' / '))
    await browser.close().catch(() => {})
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(app)
  }
  return report
}

await runCli(import.meta.url, run)
