import { invoke } from '@tauri-apps/api/core'

export type Encoding = 'utf8' | 'utf16Le' | 'utf16Be' | 'shiftJis'

export type Indent = { kind: 'spaces'; count: number } | { kind: 'tab' } | { kind: 'none' }

export type Newline = 'crlf' | 'lf' | 'cr'

export interface TextFormat {
  eol: Newline | 'mixed' | 'none'
  eolDominant: Newline
  indent: Indent
  finalNewline: boolean
}

export interface ScanResult {
  duplicateKey: boolean
  numericKeyReorder: boolean
  reservedKey: boolean
  depthExceeded: boolean
  syntaxOk: boolean
}

export type SizeClass = 'allModes' | 'noTextMode' | 'oversize'

export type RefuseReason =
  | 'tooLarge'
  | 'utf32'
  | 'undecodable'
  | 'textOnlyTooLarge'
  | 'changedWhileReading'

export type PathDenied = 'notGranted' | 'notAFile' | 'badName'

export interface OpenedReply {
  kind: 'Opened'
  revision: number
  path: string
  sha256: string
  encoding: Encoding
  bom: boolean
  format: TextFormat
  scan: ScanResult
  textOnly: boolean
  sizeClass: SizeClass
  roundTripOk: boolean
  text: string
}

export type OpenReply =
  | OpenedReply
  | { kind: 'NeedsSizeConfirm'; size: number }
  | { kind: 'NeedsEncodingConfirm'; encoding: Encoding }
  | { kind: 'Refused'; reason: RefuseReason; scan: ScanResult | null }
  | { kind: 'Denied'; reason: PathDenied }
  | { kind: 'Missing' }
  | { kind: 'Locked'; code: number }
  | { kind: 'Failed'; code: number }

export interface OpenAccept {
  size?: boolean
  encoding?: Encoding
}

export interface SaveConfirmations {
  blank?: boolean
  unparsable?: boolean
  roundTrip?: boolean
  overwriteExternal?: boolean
  recreateMissing?: boolean
}

export type ConfirmReason = 'blank' | 'unparsable' | 'roundTrip'

export interface SavedReply {
  kind: 'Saved'
  revision: number
  path: string
  sha256: string
  backupLeft: string | null
  /** 書いたテキストの書式。基準のバイト列を書いたときは無い。 */
  format: TextFormat | null
}

export type SaveReply =
  | SavedReply
  | { kind: 'Unchanged' }
  | { kind: 'NeedsConfirm'; reasons: ConfirmReason[] }
  | { kind: 'ExternalChange' }
  | { kind: 'Missing' }
  | { kind: 'Unrepresentable'; codePoint: number; offset: number }
  | { kind: 'StaleRevision' }
  | { kind: 'NoDocument' }
  | { kind: 'Denied'; reason: PathDenied }
  | { kind: 'ReadOnly' }
  /** ファイルの権限が書き込みを許さない。読み取り専用と同じく、別名保存へ導ける。 */
  | { kind: 'WriteDenied' }
  | { kind: 'Locked'; code: number }
  | { kind: 'FolderDenied'; code: number }
  | { kind: 'TargetAppeared' }
  | { kind: 'VerifyFailed' }
  | { kind: 'Failed'; code: number }
  | { kind: 'RecoveryNeeded'; originalAt: string }
  /** `reason` で止まり、退避名を消せなかった。元の名前の文書には触っていない。 */
  | { kind: 'BackupLeft'; reason: SaveReply; backupLeft: string }

export interface SaveRequest {
  revision: number
  path?: string
  /** 開いたときと別の文字コードで書く。表せない文字を UTF-8 で逃がすときに使う。 */
  encoding?: Encoding
  confirm?: SaveConfirmations
}

/** ファイルの読み書きの口。試験は状態を持つ偽物へ差し替える。 */
export interface FileBackend {
  open(path: string, accept: OpenAccept): Promise<OpenReply>
  /** 読み込んだ文書を受け取った合図。これで読み込み側の基準が入れ替わる。 */
  commitOpen(revision: number): Promise<boolean>
  save(request: SaveRequest, text: Uint8Array): Promise<SaveReply>
  /** 基準のバイト列で保存する。`path` が無ければ開いているパス。ディスクが基準と同じなら書かない。 */
  saveBaselineAs(
    revision: number,
    path: string | undefined,
    confirm?: SaveConfirmations
  ): Promise<SaveReply>
}

/** 開くときと同じ検査。編集中のテキストを渡す。 */
export interface JsonScanner {
  scan(text: string): Promise<ScanResult>
}

/** ファイルに結び付いていない文書の revision。 */
export const NO_DOCUMENT = 0

const LENGTH_BYTES = 4
const LITTLE_ENDIAN = true

/** `[メタの長さ u32 LE][メタの JSON][本文]`。本文を JSON に入れない。 */
export function packFrame(meta: unknown, body: Uint8Array): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const frame = new Uint8Array(LENGTH_BYTES + metaBytes.length + body.length)
  new DataView(frame.buffer).setUint32(0, metaBytes.length, LITTLE_ENDIAN)
  frame.set(metaBytes, LENGTH_BYTES)
  frame.set(body, LENGTH_BYTES + metaBytes.length)
  return frame
}

/** 枠を分ける。先頭の U+FEFF も本文の 1 文字なので、消さずに読む。 */
export function unpackFrame(frame: ArrayBuffer): { meta: unknown; text: string } {
  const metaLength = new DataView(frame).getUint32(0, LITTLE_ENDIAN)
  const metaEnd = LENGTH_BYTES + metaLength
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  return {
    meta: JSON.parse(decoder.decode(new Uint8Array(frame, LENGTH_BYTES, metaLength))),
    text: decoder.decode(new Uint8Array(frame, metaEnd))
  }
}

type Invoke = typeof invoke

export function createTauriBackend(call: Invoke = invoke): FileBackend & JsonScanner {
  return {
    async open(path, accept) {
      const frame = await call<ArrayBuffer>('open_document', { path, accept })
      const { meta, text } = unpackFrame(frame)
      const reply = meta as OpenReply
      return reply.kind === 'Opened' ? { ...reply, text } : reply
    },
    commitOpen: (revision) => call<boolean>('commit_open', { revision }),
    save: (request, text) => call<SaveReply>('save_document', packFrame(request, text)),
    saveBaselineAs: (revision, path, confirm) =>
      call<SaveReply>('save_baseline_as', { request: { revision, path, confirm } }),
    scan: (text) => call<ScanResult>('scan_text', new TextEncoder().encode(text))
  }
}
