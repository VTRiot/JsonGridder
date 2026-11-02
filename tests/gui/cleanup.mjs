// 試験が途中で打ち切られたときの後始末。試験が記録した pid のうち、
// 今も記録の EXE が動いているものだけを終わらせ、消せなかった一時フォルダを消す。
// 窓を出さず、すぐ終わる。何度走らせても同じ結果になる。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { TEMP_PREFIXES, leftoverFile, parseOptions } from './lib.mjs'
import { isRecordedProcess, parsePidRecords } from './pid-record.mjs'

const { out } = parseOptions()
const file = out ? path.join(out, 'pids.txt') : ''
if (file && fs.existsSync(file)) {
  for (const record of parsePidRecords(fs.readFileSync(file, 'utf8'))) {
    const found = spawnSync('tasklist', ['/FI', `PID eq ${record.pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (isRecordedProcess(record, found.stdout ?? '')) {
      spawnSync('taskkill', ['/PID', record.pid, '/T', '/F'], { windowsHide: true })
    }
  }
  fs.rmSync(file, { force: true })
}

const leftovers = out ? leftoverFile(out) : ''
if (leftovers && fs.existsSync(leftovers)) {
  const kept = []
  for (const dir of new Set(fs.readFileSync(leftovers, 'utf8').split(/\r?\n/).filter(Boolean))) {
    if (!TEMP_PREFIXES.some((prefix) => path.basename(dir).startsWith(prefix))) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      kept.push(dir) // 次の後始末でもう一度試す
    }
  }
  if (kept.length > 0) fs.writeFileSync(leftovers, kept.map((dir) => `${dir}\n`).join(''))
  else fs.rmSync(leftovers, { force: true })
}
