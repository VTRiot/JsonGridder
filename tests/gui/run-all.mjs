// 実 EXE の試験をまとめて回す。--mutants を渡すと、対策を外して作った EXE でも回し、
// 試験が失敗を検出できることを確かめる。結果は --out の summary.json に書く。
import fs from 'node:fs'
import path from 'node:path'
import { leftoverFile, parseOptions, runCli } from './lib.mjs'
import { run as editThenSwitch } from './edit-then-switch.mjs'
import { run as initFailure } from './init-failure.mjs'
import { run as menuControl } from './menu-control.mjs'
import { run as reloadGuard } from './reload-guard.mjs'
import { run as shellThrough } from './shell-through.mjs'
import { run as smoke } from './smoke.mjs'
import { run as splash } from './splash.mjs'

const summarize = (report) => ({ name: report.name, passed: report.passed, checks: report.checks, notes: report.notes })

const failedLabels = (report) => report.checks.filter((item) => !item.passed).map((item) => item.label)

async function runMutants(mutants, out) {
  const exe = (name) => path.join(mutants, `${name}.exe`)
  const reports = {}
  const expectations = []

  // 2 層とも外すと、試験が落ちなければならない（入力が届いていることの対照でもある）
  const none = await reloadGuard({ exe: exe('none'), out }, 'mutant-none')
  reports.none = none
  const noneFailed = failedLabels(none)
  expectations.push({
    label: '2 層を外すと再読み込みを検出する',
    passed: noneFailed.some((label) => label.includes('再読み込みされない'))
  })
  // メニューは、開いた窓と、メニューから再読み込みが起きたことの 2 つで見る。どちらの信号かを残す
  const noneMenu = await menuControl({ exe: exe('none'), out }, 'mutant-none-menu')
  reports.noneMenu = noneMenu
  const noneMenuFailed = failedLabels(noneMenu)
  // どの信号で検出したかを detail に残す。信号はどれも、この EXE のプロセスの木の窓か再読み込みに限る
  const menuSignals = {
    windowInRightClickRound: noneFailed.some((label) => label.includes('既定の右クリックのメニューが出ない')),
    windowInMenuControl: noneMenuFailed.includes('既定の右クリックのメニューが出ない'),
    reloadFromMenu: noneMenuFailed.includes('メニューの操作で再読み込みされない')
  }
  expectations.push({
    label: '2 層を外すと既定の右クリックのメニューを検出する',
    passed: Object.values(menuSignals).some(Boolean),
    detail: JSON.stringify(menuSignals)
  })

  // 各層の守備範囲を記録する。ここは合否に入れない
  reports.keysOnly = await reloadGuard({ exe: exe('keys-only'), out }, 'mutant-keys-only')
  reports.navOnly = await reloadGuard({ exe: exe('nav-only'), out }, 'mutant-nav-only')
  reports.navOnlyMenu = await menuControl({ exe: exe('nav-only'), out }, 'mutant-nav-only-menu')

  // 対策を外した EXE が今のフロントエンドで作られていることの確かめ
  const noneSwitch = await editThenSwitch({ exe: exe('none'), out }, 'mutant-none-switch')
  const navOnlySwitch = await editThenSwitch({ exe: exe('nav-only'), out }, 'mutant-nav-only-switch')
  reports.noneSwitch = noneSwitch
  reports.navOnlySwitch = navOnlySwitch
  expectations.push({
    label: '対策を外した EXE は今のフロントエンドで動く',
    passed: noneSwitch.passed && navOnlySwitch.passed
  })

  const noWatchdog = await initFailure({ exe: exe('no-watchdog'), out }, 'mutant-no-watchdog')
  reports.noWatchdog = noWatchdog
  expectations.push({
    label: '見張りを外すと見えないプロセスを検出する',
    passed: failedLabels(noWatchdog).some((label) => label.includes('ダイアログが出る'))
  })

  return { reports, expectations }
}

async function runAll(options) {
  const { exe, out, mutants } = parseOptions()
  const product = [
    await smoke({ exe, out }),
    await reloadGuard({ exe, out }),
    await menuControl({ exe, out }),
    await editThenSwitch({ exe, out }),
    await initFailure({ exe, out }),
    await shellThrough({ exe, out }),
    await splash({ exe, out })
  ]
  const summary = { exe, startedAt: options.startedAt, product: product.map(summarize) }

  let mutantsPassed = true
  if (mutants) {
    const { reports, expectations } = await runMutants(mutants, out)
    summary.mutants = Object.values(reports).map(summarize)
    summary.expectations = expectations
    mutantsPassed = expectations.every((item) => item.passed)
    for (const item of expectations) {
      console.log(`${item.passed ? 'PASS' : 'FAIL'} [mutants] ${item.label}${item.detail ? ` : ${item.detail}` : ''}`)
    }
  }

  const leftovers = leftoverFile(out)
  summary.leftovers = fs.existsSync(leftovers) ? fs.readFileSync(leftovers, 'utf8').split(/\r?\n/).filter(Boolean) : []
  summary.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  return { passed: product.every((report) => report.passed) && mutantsPassed }
}

await runCli(import.meta.url, (options) => runAll({ ...options, startedAt: new Date().toISOString() }))
