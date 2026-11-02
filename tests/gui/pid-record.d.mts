export interface PidRecord {
  pid: string
  image: string
}

export function formatPidRecord(pid: number | string, exe: string): string
export function parsePidRecords(text: string): PidRecord[]
export function isRecordedProcess(record: PidRecord, tasklistOutput: string): boolean
