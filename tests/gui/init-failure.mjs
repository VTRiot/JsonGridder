// JS が動かない起動で、見えないプロセスが残らないことを確かめる。
// 製品のコードを変えず、WebView2 の引数でスクリプトを止めて初期化の失敗を作る。
import fs from 'node:fs'
import path from 'node:path'
import { createReport, launch, osInput, productRoot, runCli, sleep, stop } from './lib.mjs'

const EXIT_INIT_FAILED = 3
const POLL_MS = 500
const DIALOG_TIMEOUT_MS = 30000 // 見張りの時間切れより長く取る
const EXIT_TIMEOUT_MS = 10000

export async function run({ exe, out }, name = 'init-failure') {
  const report = createReport(name)
  const dictionary = JSON.parse(fs.readFileSync(path.join(productRoot, 'src/i18n/en.json'), 'utf8'))
  const dialogTitle = dictionary['app.error.initFailedTitle']
  const app = await launch({ exe, out, browserArgs: '--blink-settings=scriptEnabled=false' })
  const exited = app.exited.then((code) => ({ code }))
  try {
    const deadline = Date.now() + DIALOG_TIMEOUT_MS
    let dialog = null
    let last = null
    while (!dialog && app.child.exitCode === null && Date.now() < deadline) {
      last = osInput(app.child.pid, 'info')
      // 見えない窓や別の窓をダイアログと取り違えないよう、題で見分ける
      if (last.VISIBLE === '1' && last.TITLE === dialogTitle) dialog = last
      else await sleep(POLL_MS)
    }
    const elapsed = Date.now() - app.startedAt
    report.check('初期化に失敗すると理由のダイアログが出る', dialog, `起動から ${elapsed} ms 窓=${last?.TITLE ?? 'なし'}`)

    if (dialog) report.note('閉じる入力', { foreground: osInput(app.child.pid, 'send', '{ENTER}').FOREGROUND })
    const result = await Promise.race([exited, sleep(EXIT_TIMEOUT_MS).then(() => null)])
    report.check('閉じるとプロセスが終わる', result !== null, result ? `終了コード ${result.code}` : '残っている')
    report.check('終了コードが初期化の失敗を示す', result?.code === EXIT_INIT_FAILED, result?.code)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(app)
  }
  return report
}

await runCli(import.meta.url, run)
