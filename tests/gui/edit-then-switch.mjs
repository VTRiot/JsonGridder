// テキストの表示で打った直後に表示を切り替えても、エディタが動き続けることを確かめる。
// 上流のテキストの表示は、変更を少し遅らせて渡す。この遅れの間に切り替える場面を作る。
import {
  DOCUMENT_CELL,
  SAMPLE_JSON,
  SELECTOR_TIMEOUT_MS,
  activeMode,
  clickMode,
  connect,
  createReport,
  freePort,
  launch,
  readDocument,
  runCli,
  sleep,
  stop,
  switchMode,
  waitForDocument
} from './lib.mjs'

const DOCUMENT_MARK = '777,'
const CELL_EDIT = 'edited'
const SETTLE_MS = 600

export async function run({ exe, out }, name = 'edit-then-switch') {
  const report = createReport(name)
  const port = await freePort()
  const app = await launch({ exe, out, port, text: SAMPLE_JSON, settings: { language: 'ja' } })
  try {
    const { browser, page } = await connect(port)
    await waitForDocument(page)
    await clickMode(page, 'テキスト')
    await page.click('.cm-content')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(DOCUMENT_MARK)
    const typedAt = Date.now()
    await clickMode(page, '表')
    report.note('打ち終わりからボタンを押し終わるまで（ms）', Date.now() - typedAt)
    await sleep(SETTLE_MS)
    report.check('打った直後の切り替えで表になる', (await activeMode(page)) === '表', await activeMode(page))
    report.check('打った文字が表に出る', (await readDocument(page)).body.includes('777'))

    await page.getByText(DOCUMENT_CELL, { exact: true }).dblclick({ timeout: SELECTOR_TIMEOUT_MS })
    await sleep(SETTLE_MS)
    await page.keyboard.press('Control+A')
    await page.keyboard.type(CELL_EDIT)
    await page.keyboard.press('Enter')
    await sleep(SETTLE_MS)
    report.check('続けて編集したセルが画面に出る', (await readDocument(page)).body.includes(CELL_EDIT))

    report.check('続けてツリーへ切り替わる', await switchMode(page, 'ツリー'), await activeMode(page))
    report.check('続けてテキストへ切り替わる', await switchMode(page, 'テキスト'), await activeMode(page))
    await sleep(SETTLE_MS)
    const final = await readDocument(page)
    report.check('両方の編集が文書に残る', final.doc?.includes(DOCUMENT_MARK) && final.doc?.includes(CELL_EDIT), final.doc?.slice(0, 60))
    await browser.close().catch(() => {})
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(app)
  }
  return report
}

await runCli(import.meta.url, run)
