// 試験が起動したプロセスの記録。pid は使い回されるので、起動した EXE の名前も残し、
// 後始末は今その pid で動いているプロセスの名前が記録と合うときだけ終わらせる。
import path from 'node:path'

/** 名前の無い古い行の扱い。製品の EXE だけを起動していた頃の記録である。 */
const DEFAULT_IMAGE = 'JsonGridder.exe'

export const formatPidRecord = (pid, exe) => `${pid}\t${path.win32.basename(exe)}\n`

export function parsePidRecords(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [pid, image] = line.trim().split('\t')
      return { pid, image: image ?? DEFAULT_IMAGE }
    })
}

/** `tasklist /FO CSV /NH` の出力の先頭の行から、その pid の名前を読む。無ければ null。 */
function runningImage(tasklistOutput, pid) {
  const match = /^"([^"]+)","(\d+)"/m.exec(tasklistOutput)
  return match && match[2] === pid ? match[1] : null
}

export function isRecordedProcess(record, tasklistOutput) {
  return runningImage(tasklistOutput, record.pid)?.toLowerCase() === record.image.toLowerCase()
}
