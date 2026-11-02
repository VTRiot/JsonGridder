import { describe, expect, it } from 'vitest'
import { formatPidRecord, isRecordedProcess, parsePidRecords } from '../gui/pid-record.mjs'

const tasklist = (image: string, pid: string) =>
  `"${image}","${pid}","Console","1","12,345 K"\r\n`

describe('試験の後始末の判定', () => {
  it('起動した EXE の名前を残す', () => {
    const line = formatPidRecord(1234, 'C:\\work\\mutants\\none.exe')
    expect(parsePidRecords(line)).toEqual([{ pid: '1234', image: 'none.exe' }])
  })

  it('対策を外した EXE も終わらせる対象になる', () => {
    const [record] = parsePidRecords(formatPidRecord(1234, 'C:\\work\\none.exe'))
    expect(isRecordedProcess(record, tasklist('none.exe', '1234'))).toBe(true)
  })

  it('名前の大文字小文字は問わない', () => {
    const [record] = parsePidRecords(formatPidRecord(1, 'JsonGridder.exe'))
    expect(isRecordedProcess(record, tasklist('jsongridder.exe', '1'))).toBe(true)
  })

  it('同じ pid で別のプロセスが動いていれば終わらせない', () => {
    const [record] = parsePidRecords(formatPidRecord(1234, 'none.exe'))
    expect(isRecordedProcess(record, tasklist('notepad.exe', '1234'))).toBe(false)
  })

  it('プロセスが無ければ終わらせない', () => {
    const [record] = parsePidRecords(formatPidRecord(1234, 'none.exe'))
    expect(isRecordedProcess(record, 'INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false)
  })

  it('pid だけの古い行は製品の EXE として扱う', () => {
    const [record] = parsePidRecords('1234\n')
    expect(record.image).toBe('JsonGridder.exe')
    expect(isRecordedProcess(record, tasklist('JsonGridder.exe', '1234'))).toBe(true)
    expect(isRecordedProcess(record, tasklist('none.exe', '1234'))).toBe(false)
  })
})
