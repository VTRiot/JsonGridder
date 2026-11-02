// 起動画面が出て閉じ、主画面が出ることを実 EXE で確かめる。OS の入力は送らない。
// 窓の一覧を、題名とクラスと大きさで見るだけ。直接の起動では出て、文書を引数にした起動では出ない。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { SAMPLE_JSON, SETTINGS_FILE, createReport, freePort, launch, osInput, productRoot, runCli, sleep, stop } from './lib.mjs'

const SPLASH_WIDTH = 690 // src-tauri/src/splash.rs の SPLASH_WIDTH / SPLASH_HEIGHT と同じ値にする
const SPLASH_HEIGHT = 442
const SPLASH_MS = 4000 // 窓の確認は 1 回に 1 秒近くかかるので、最低表示時間を長めにして取りこぼさない
const MAIN_VISIBLE_TIMEOUT_MS = 30000
const POLL_MS = 200
const TEMP_HOME_PREFIX = 'jgv-exe-'

function homeWithSettings(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_HOME_PREFIX))
  fs.writeFileSync(path.join(home, SETTINGS_FILE), JSON.stringify(settings))
  return home
}

// 設定のテーマごとに、起動画面の中身（html の data-theme、面の色、文字の色、見えているロゴ、ロゴの読み込み）が期待どおりか
const THEME_CASES = [
  ['light', { theme: 'light', ground: 'rgb(247, 245, 251)', text: 'rgb(94, 83, 120)', logo: 'logo-light', loaded: true }],
  ['dark', { theme: 'dark', ground: 'rgb(24, 21, 40)', text: 'rgb(141, 134, 173)', logo: 'logo-dark', loaded: true }]
]
const PROBE_TIMEOUT_MS = 20000
const PROBE_POLL_MS = 250

/** 起動画面の WebView を DevTools の口から見つけて、中身を読む。見つからなければ null。 */
async function probeSplash(port) {
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  let browser
  let lastError = ''
  let seenUrls = []
  while (Date.now() < deadline) {
    try {
      // 接続した直後は対象の一覧が空のことがあるので、つないだまま一覧を何度も見る
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (!page.url().includes('splash.html')) continue
          const info = await page.evaluate(() => {
            const shown = [...document.querySelectorAll('.logo')].filter((img) => getComputedStyle(img).display !== 'none')
            return {
              theme: document.documentElement.dataset.theme,
              ground: getComputedStyle(document.querySelector('.card')).backgroundColor,
              text: getComputedStyle(document.getElementById('opening')).color,
              logo: shown.map((img) => img.className.replace('logo ', '')).join(),
              loaded: shown.length === 1 && shown[0].complete && shown[0].naturalWidth > 0
            }
          })
          if (info.theme) {
            await browser.close().catch(() => {})
            return info
          }
        }
      }
    } catch (error) {
      // 起動画面がまだ無い、または口がまだ開いていない
      lastError = String(error).slice(0, 160)
    }
    seenUrls = browser ? browser.contexts().flatMap((context) => context.pages().map((page) => page.url())) : []
    await sleep(PROBE_POLL_MS)
  }
  await browser?.close().catch(() => {})
  console.log(`probe 失敗: ${lastError} / ${JSON.stringify(seenUrls)}`)
  return null
}

/** 本体の窓が見えるまで、起動画面の有無を記録しながら待つ。 */
async function watch(app, title, { untilMain }) {
  const seen = { splash: null, splashBeforeMain: false, mainAt: null, splashAfterMain: false }
  const deadline = Date.now() + untilMain
  while (seen.mainAt === null && Date.now() < deadline) {
    const splash = osInput(app.child.pid, 'splash')
    const info = osInput(app.child.pid, 'info')
    const mainVisible = info.VISIBLE === '1' && info.TITLE?.includes(title)
    if (splash.SPLASH === '1') {
      seen.splash ??= { class: splash.SPLASH_CLASS, size: splash.SPLASH_SIZE, atMs: Date.now() - app.startedAt }
      if (!mainVisible) seen.splashBeforeMain = true
    }
    if (mainVisible) {
      seen.mainAt = Date.now() - app.startedAt
      seen.splashAfterMain = osInput(app.child.pid, 'splash').SPLASH === '1'
    } else {
      await sleep(POLL_MS)
    }
  }
  return seen
}

export async function run({ exe, out }, name = 'splash') {
  const report = createReport(name)
  const dictionary = JSON.parse(fs.readFileSync(path.join(productRoot, 'src/i18n/en.json'), 'utf8'))
  const title = dictionary['app.title']

  // 直接の起動（引数なし）。設定のテーマに合わせた地の色で出る（ライトは藤、ダークは夜桜）。大きさは 690 x 442 の比
  for (const [theme, expected] of THEME_CASES) {
  const port = await freePort()
  const direct = await launch({ exe, out, port, home: homeWithSettings({ splashMs: SPLASH_MS, theme }) })
  try {
    const probing = probeSplash(port)
    const seen = await watch(direct, title, { untilMain: MAIN_VISIBLE_TIMEOUT_MS })
    const page = await probing
    report.note('直接の起動', seen)
    report.check('直接の起動で起動画面が出る', seen.splash !== null, seen.splash ? `${seen.splash.atMs} ms` : 'なし')
    report.check('起動画面の間は主画面が見えない', seen.splashBeforeMain)
    report.check('主画面が出る', seen.mainAt !== null, seen.mainAt === null ? 'なし' : `${seen.mainAt} ms`)
    report.check(
      '起動画面は最低表示時間より前に閉じない',
      seen.mainAt !== null && seen.mainAt >= SPLASH_MS,
      `主画面 ${seen.mainAt} ms / 最低 ${SPLASH_MS} ms`
    )
    report.check('主画面が出たときに起動画面は閉じている', seen.mainAt !== null && !seen.splashAfterMain)
    report.check(
      '起動画面は枠なしの別窓で、題名とクラスで見分けられる',
      !!seen.splash && /^\d+x\d+$/.test(seen.splash.size ?? '') && !!seen.splash.class,
      JSON.stringify(seen.splash)
    )
    const [width, height] = (seen.splash?.size ?? '0x1').split('x').map(Number)
    report.check(
      `${theme}: 起動画面の窓の縦横比が 690 x 442（余白を詰めた幅）`,
      Math.abs(width / height - SPLASH_WIDTH / SPLASH_HEIGHT) < 0.02,
      `${seen.splash?.size} 比 ${(width / height).toFixed(3)} / 期待 ${(SPLASH_WIDTH / SPLASH_HEIGHT).toFixed(3)}`
    )
    report.note(`${theme} の起動画面の中身`, page)
    report.check(
      `${theme}: 起動画面が設定のテーマの地・文字・ロゴで出る`,
      !!page && JSON.stringify(page) === JSON.stringify(expected),
      JSON.stringify(page)
    )
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(direct)
  }
  }

  // 文書を引数にした起動（関連付けで開く）。起動画面は出ない
  const withDocument = await launch({ exe, out, text: SAMPLE_JSON, home: homeWithSettings({ splashMs: SPLASH_MS }) })
  try {
    const seen = await watch(withDocument, title, { untilMain: MAIN_VISIBLE_TIMEOUT_MS })
    report.note('文書を引数にした起動', seen)
    report.check('文書を引数にした起動では起動画面が出ない', seen.splash === null && seen.mainAt !== null)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(withDocument)
  }

  // 同じ設定のフォルダで 2 回起動する。splashCeremony が無い 1 回目は出て旗を false にし、2 回目は出ない
  const onceHome = homeWithSettings({ splashMs: SPLASH_MS })
  const first = await launch({ exe, out, home: onceHome })
  try {
    const seen = await watch(first, title, { untilMain: MAIN_VISIBLE_TIMEOUT_MS })
    report.note('初回の起動', seen)
    report.check('初回の起動（splashCeremony 無し）で起動画面が出る', seen.splash !== null && seen.mainAt !== null)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(first, { keepHome: true })
  }
  const saved = JSON.parse(fs.readFileSync(path.join(onceHome, SETTINGS_FILE), 'utf8'))
  report.check('出した起動の後、設定の splashCeremony が false になっている', saved.splashCeremony === false, JSON.stringify(saved))
  const second = await launch({ exe, out, home: onceHome })
  try {
    const seen = await watch(second, title, { untilMain: MAIN_VISIBLE_TIMEOUT_MS })
    report.note('2 回目の起動', seen)
    report.check('2 回目の起動では起動画面が出ない', seen.splash === null && seen.mainAt !== null)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(second)
  }

  // splashMs が 0 なら出さない
  const off = await launch({ exe, out, home: homeWithSettings({ splashMs: 0 }) })
  try {
    const seen = await watch(off, title, { untilMain: MAIN_VISIBLE_TIMEOUT_MS })
    report.note('splashMs 0', seen)
    report.check('splashMs が 0 なら起動画面が出ない', seen.splash === null && seen.mainAt !== null)
  } catch (error) {
    report.check('試験が最後まで走る', false, String(error).slice(0, 300))
  } finally {
    await stop(off)
  }
  return report
}

await runCli(import.meta.url, run)
