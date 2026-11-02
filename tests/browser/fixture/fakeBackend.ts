// 状態を持つ偽の読み書き。実物の基準の入れ替えと revision の扱いを同じ形で持つ。
import { parse } from 'lossless-json'
import type {
  Encoding,
  FileBackend,
  OpenAccept,
  OpenReply,
  SaveConfirmations,
  SaveReply,
  SaveRequest,
  ScanResult,
  SizeClass,
  TextFormat
} from '../../../src/document/backend'
import { NO_DOCUMENT } from '../../../src/document/backend'

const FORMAT: TextFormat = {
  eol: 'lf',
  eolDominant: 'lf',
  indent: { kind: 'spaces', count: 2 },
  finalNewline: false
}

function scanOf(text: string): ScanResult {
  let syntaxOk = true
  try {
    parse(text)
  } catch {
    syntaxOk = false
  }
  return { duplicateKey: false, numericKeyReorder: false, reservedKey: false, depthExceeded: false, syntaxOk }
}

/** 実物の `detect_format` と同じ答えを、試験が使う文書の範囲で返す。 */
function formatOf(text: string): TextFormat {
  const lead = /\n( +|\t)/.exec(text)?.[1]
  const indent: TextFormat['indent'] =
    lead === undefined
      ? { kind: 'none' }
      : lead === '\t'
        ? { kind: 'tab' }
        : { kind: 'spaces', count: lead.length }
  const eol = text.includes('\r\n') ? 'crlf' : 'lf'
  return { eol, eolDominant: eol, indent, finalNewline: /\n$/.test(text) }
}

export interface FakeBackend extends FileBackend {
  files: Map<string, string>
  writes: { path: string; text: string; encoding?: Encoding }[]
  /** 読み込みの回数。 */
  reads: number
  /** `save` が呼ばれた回数。止めた保存が始まったことを待つ。 */
  saveStarts: number
  /** 次の open に渡す追加の項目。 */
  nextOpen: {
    format?: TextFormat
    roundTripOk?: boolean
    textOnly?: boolean
    encoding?: Encoding
    reply?: OpenReply
    sizeClass?: SizeClass
    scan?: Partial<ScanResult>
  }
  /** 次の save に返す結果。 */
  nextSave: SaveReply | null
  /** 設定すると、open と save の完了を止める。 */
  gate: Promise<void> | null
}

export function createFakeBackend(files: Record<string, string> = {}): FakeBackend {
  let revision = NO_DOCUMENT
  let counter = NO_DOCUMENT
  let path: string | null = null
  let baseline = ''
  let pending: { revision: number; path: string; text: string } | null = null

  const backend: FakeBackend = {
    files: new Map(Object.entries(files)),
    writes: [],
    reads: 0,
    saveStarts: 0,
    nextOpen: {},
    nextSave: null,
    gate: null,

    async open(target: string, _accept: OpenAccept): Promise<OpenReply> {
      backend.reads++
      if (backend.gate) await backend.gate
      if (backend.nextOpen.reply) return backend.nextOpen.reply
      const text = backend.files.get(target)
      if (text === undefined) return { kind: 'Missing' }
      counter++
      pending = { revision: counter, path: target, text }
      const {
        format = FORMAT,
        roundTripOk = true,
        textOnly = false,
        encoding = 'utf8',
        sizeClass = 'allModes',
        scan = {}
      } = backend.nextOpen
      return {
        kind: 'Opened',
        revision: counter,
        path: target,
        sha256: `sha-${counter}`,
        encoding,
        bom: false,
        format,
        scan: { ...scanOf(text), ...scan },
        textOnly,
        sizeClass,
        roundTripOk,
        text
      }
    },

    async commitOpen(target: number): Promise<boolean> {
      if (pending?.revision !== target) return false
      revision = pending.revision
      path = pending.path
      baseline = pending.text
      pending = null
      return true
    },

    async save(request: SaveRequest, bytes: Uint8Array): Promise<SaveReply> {
      backend.saveStarts++
      if (backend.gate) await backend.gate
      if (backend.nextSave) {
        const reply = backend.nextSave
        backend.nextSave = null
        return reply
      }
      if (request.revision !== revision) return { kind: 'StaleRevision' }
      const target = request.path ?? path
      if (target === null) return { kind: 'NoDocument' }
      const text = new TextDecoder().decode(bytes)
      backend.files.set(target, text)
      backend.writes.push({ path: target, text, encoding: request.encoding })
      counter++
      revision = counter
      path = target
      baseline = text
      return {
        kind: 'Saved',
        revision,
        path: target,
        sha256: `sha-${revision}`,
        backupLeft: null,
        format: formatOf(text)
      }
    },

    async saveBaselineAs(
      target: number,
      newPath: string | undefined,
      confirm: SaveConfirmations = {}
    ): Promise<SaveReply> {
      if (backend.gate) await backend.gate
      if (target !== revision || path === null) return { kind: 'StaleRevision' }
      const destination = newPath ?? path
      if (destination === path) {
        const disk = backend.files.get(path)
        if (disk === baseline) return { kind: 'Unchanged' }
        if (disk === undefined && !confirm.recreateMissing) return { kind: 'Missing' }
        if (disk !== undefined && !confirm.overwriteExternal) return { kind: 'ExternalChange' }
      }
      backend.files.set(destination, baseline)
      backend.writes.push({ path: destination, text: baseline })
      counter++
      revision = counter
      path = destination
      return { kind: 'Saved', revision, path: destination, sha256: `sha-${revision}`, backupLeft: null, format: null }
    }
  }
  return backend
}
