// 既定の右クリックのメニューから再読み込みを選ぶ操作を、実物で確かめる。
// テキストの表示はエディタが右クリックを扱わないので、既定のメニューが出るならここで出る。
// 守りを外した EXE ではメニューが開いて再読み込みが起きる。製品ではメニューが開かず、キーは本文へ入る。
import {
  SAMPLE_JSON,
  connect,
  createReport,
  freePort,
  launch,
  menuWindows,
  osInput,
  runCli,
  sleep,
  stop,
  switchMode,
  waitForDocument
} from './lib.mjs'
import { install, isAlive } from './reload-guard.mjs'

const RELOAD_ACCESS_KEY = 'r' // 既定のメニューの「再読み込み」のアクセスキー
const SETTLE_MS = 900

export async function run({ exe, out }, name = 'menu-control') {
  const report = createReport(name)
  const port = await freePort()
  const app = await launch({ exe, out, port, text: SAMPLE_JSON, settings: { language: 'ja' } })
  try {
    const { browser, page } = await connect(port)
    await waitForDocument(page)
    await install(page)
    report.check('テキストへ切り替わる', await switchMode(page, 'テキスト'))
    const clicked = osInput(app.child.pid, 'rightclick', RELOAD_ACCESS_KEY)
    await sleep(SETTLE_MS)
    const opened = menuWindows(clicked.OPENED)
    report.note('右クリックの結果', { foreground: clicked.FOREGROUND, followUp: clicked.FOLLOWUP, opened: clicked.OPENED })
    // 前面になれないと何も送らずに終わる。送っていないのにメニューなしと読まない
    report.check(
      '右クリックと続くキーを送れた',
      clicked.FOREGROUND === '1' && clicked.FOLLOWUP === '1',
      `前面=${clicked.FOREGROUND} 続くキー=${clicked.FOLLOWUP}`
    )
    report.check('既定の右クリックのメニューが出ない', opened.length === 0, opened.join(' | '))
    report.check('メニューの操作で再読み込みされない', await isAlive(page))
    await browser.close().catch(() => {})
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(app)
  }
  return report
}

await runCli(import.meta.url, run)
