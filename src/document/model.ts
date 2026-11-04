import type { Content } from '$lib/types'
import { isTextContent } from '$lib/utils/jsonUtils'
import {
  NO_DOCUMENT,
  type Encoding,
  type FileBackend,
  type OpenAccept,
  type OpenReply,
  type OpenedReply,
  type SaveConfirmations,
  type SaveReply,
  type SavedReply,
  type ScanResult,
  type SizeClass,
  type TextFormat
} from './backend'
import { isUnchanged } from './compare'
import type { EditorPort } from './editorPort'
import {
  DEFAULT_FORMAT,
  isWellFormedText,
  serializeContent,
  type Stringify
} from './serialize'

/** 最後に保存が成功した版（開いた直後は開いた版）。入れ替えるときは新しいオブジェクトにする。 */
export interface Baseline {
  text: string
  sha256: string
  path: string
  /** 基準のバイト列は保存側が持ち、これで指す。 */
  revision: number
  format: TextFormat
  encoding: Encoding
  bom: boolean
  scan: ScanResult
  textOnly: boolean
  sizeClass: SizeClass
  /** 開いたときの decode→encode が元のバイト列に戻ったか。 */
  roundTripOk: boolean
}

/** 殻へ渡す文書の状態。 */
export interface DocumentStatus {
  unsaved: boolean
  saveBlocked: boolean
  path: string | null
}

export type BlockReason = 'modalOpen' | 'busy'

/** `replaceFailed` はエディタの中身が基準の文書と確かめられない状態。次の開く処理の成功で解ける。 */
export type SaveBlockReason = BlockReason | 'replaceFailed'

export type OpenOutcome =
  | { kind: 'Opened'; baseline: Baseline }
  | { kind: 'Blocked'; reason: BlockReason }
  /** 未保存があるので読み込まない。利用者が決めたら `discardConfirmed` を付けて呼び直す。 */
  | { kind: 'NeedsUnsavedDecision' }
  /** 文書を置き換えられなかった。 */
  | { kind: 'ReplaceFailed' }
  | Exclude<OpenReply, OpenedReply>

export type SaveOutcome =
  | { kind: 'Saved'; eolNormalized: boolean; backupLeft: string | null }
  /** 基準と同じなので書かなかった。 */
  | { kind: 'NoChange' }
  | { kind: 'Blocked'; reason: SaveBlockReason }
  /** 保存先が決まっていない。 */
  | { kind: 'NeedsPath' }
  | { kind: 'SerializationMismatch' }
  | { kind: 'SerializationFailed' }
  /** 表せない文字。UTF-8 にできないサロゲートが残っている。 */
  | { kind: 'UnpairedSurrogate' }
  | Exclude<SaveReply, SavedReply | { kind: 'Unchanged' }>

export interface OpenOptions {
  discardConfirmed?: boolean
  accept?: OpenAccept
}

export interface SaveAsOptions {
  confirm?: SaveConfirmations
  /** 開いたときと別の文字コードで書く。BOM は付けない。 */
  encoding?: Encoding
}

export interface ModelOptions {
  /** 試験が直列化の故障を注入する口。 */
  stringify?: Stringify
}

/** 開いている文書の状態。画面の文言を持たず、結果は型で返す。 */
export class DocumentModel {
  private base: Baseline | null = null
  private unsaved = false
  private epoch = 0
  private replacing = false
  private running = 0
  /** 開く処理の間は保存を受けない。後ろに並ぶと、開いた後の文書を書くためである。 */
  private opening = false
  /** エディタの中身が基準の文書と確かめられないので、保存を止めている。 */
  private saveStopped = false
  private tail: Promise<unknown> = Promise.resolve()
  private listener: ((status: DocumentStatus) => void) | undefined
  private lastStatus = ''

  constructor(
    private readonly backend: FileBackend,
    private readonly editor: EditorPort,
    private readonly options: ModelOptions = {}
  ) {}

  get baseline(): Baseline | null {
    return this.base
  }

  get dirty(): boolean {
    return this.unsaved
  }

  /** 開く処理か保存の途中。外の変更の見張りはこの間は見送る。 */
  get busy(): boolean {
    return this.running > 0
  }

  /** 編集のたびに増える番号。確認の間に編集があったかを比べるのに使う。 */
  get editEpoch(): number {
    return this.epoch
  }

  /** 保存を止めている。別のファイルを開き直すまで解けない。 */
  get saveBlocked(): boolean {
    return this.saveStopped
  }

  get status(): DocumentStatus {
    return {
      unsaved: this.unsaved,
      saveBlocked: this.saveStopped,
      path: this.base?.path ?? null
    }
  }

  /** 状態が変わるたびに呼ぶ。`listener` の中からエディタの API を呼ばない。 */
  subscribe(listener: (status: DocumentStatus) => void): void {
    this.listener = listener
  }

  private publish(): void {
    const status = this.status
    const key = JSON.stringify(status)
    if (key !== this.lastStatus) {
      this.lastStatus = key
      this.listener?.(status)
    }
  }

  /** 別名保存の保存先を選ぶ前に取り、`saveAs` へ渡す版。 */
  get revision(): number {
    return this.base?.revision ?? NO_DOCUMENT
  }

  /**
   * 編集の印を立てる。`onChange` と入力の合図はこれだけを呼ぶ。
   * ここでエディタの API を呼ばない。更新の最中に呼ぶと入れ子になり、画面が止まる。
   */
  noteEdit(): void {
    if (this.replacing) {
      return
    }
    this.unsaved = true
    this.epoch++
    this.publish()
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.running++
    const run = this.tail.then(job)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run.finally(() => {
      this.running--
      this.publish()
    })
  }

  open(path: string, options: OpenOptions = {}): Promise<OpenOutcome> {
    if (this.running > 0) {
      return Promise.resolve({ kind: 'Blocked', reason: 'busy' })
    }
    this.opening = true
    return this.enqueue(() => this.openNow(path, options)).finally(() => {
      this.opening = false
    })
  }

  save(confirm: SaveConfirmations = {}): Promise<SaveOutcome> {
    return this.startSave({ confirm })
  }

  /**
   * `revision` は保存先を選ぶ前に取った `this.revision`。選ぶ間に文書が替わっていれば、
   * 利用者が選んだのと別の文書を書かないように止める。
   */
  saveAs(path: string, revision: number, options: SaveAsOptions = {}): Promise<SaveOutcome> {
    return this.startSave({ path, chosenFrom: revision, ...options })
  }

  private startSave(target: SaveTarget): Promise<SaveOutcome> {
    if (this.opening) {
      return Promise.resolve({ kind: 'Blocked', reason: 'busy' })
    }
    return this.enqueue(() => this.saveNow(target))
  }

  private async openNow(path: string, options: OpenOptions): Promise<OpenOutcome> {
    const { editor } = this
    if (editor.hasOpenModal()) {
      return { kind: 'Blocked', reason: 'modalOpen' }
    }
    editor.commitPending()
    if (this.unsaved && !options.discardConfirmed) {
      return { kind: 'NeedsUnsavedDecision' }
    }
    const decisionEpoch = this.epoch

    const reply = await this.backend.open(path, options.accept ?? {})
    if (reply.kind !== 'Opened') {
      return reply
    }

    // ここから await を挟まない。読み込みの間の入力を取りこぼさないため
    if (editor.hasOpenModal()) {
      return { kind: 'Blocked', reason: 'modalOpen' }
    }
    editor.commitPending()
    if (this.epoch !== decisionEpoch && !this.matchesBaseline()) {
      return { kind: 'NeedsUnsavedDecision' }
    }
    const placed = this.placeDocument(reply, options.discardConfirmed === true)
    if (placed.kind !== 'Opened') {
      editor.applyFormat(this.base?.format)
      return placed
    }

    // 読み込み側の基準が替わるまでは、画面と読み込み側で文書が食い違う
    this.saveStopped = true
    const committed = await this.backend.commitOpen(reply.revision)
    if (!committed) {
      return { kind: 'ReplaceFailed' }
    }
    this.saveStopped = false
    return placed
  }

  private matchesBaseline(): boolean {
    return this.base !== null && isUnchanged(this.editor.current(), this.base)
  }

  /** 中身が基準の文書のままと確かめられないときは止める。止めたら、開く処理の成功まで解かない。 */
  private replaceFailed(): OpenOutcome {
    this.markUnsaved()
    let keptBaseline = false
    try {
      keptBaseline = this.matchesBaseline()
    } catch {
      // 読めない中身は確かめられない
    }
    this.saveStopped ||= !keptBaseline
    return { kind: 'ReplaceFailed' }
  }

  /** エディタの文書を替え、渡した内容が残ったことを確かめてから基準を替える。 */
  private placeDocument(reply: OpenedReply, discardConfirmed: boolean): OpenOutcome {
    const { editor } = this
    const { text, textOnly, sizeClass } = reply
    let held: boolean
    this.replacing = true
    try {
      editor.applyFormat(reply.format)
      editor.replace(text, { textOnly, sizeClass })
      held = this.holds(text)
      if (!held && discardConfirmed) {
        editor.replace(text, { textOnly, sizeClass })
        held = this.holds(text)
      }
    } catch {
      return this.replaceFailed()
    } finally {
      this.replacing = false
    }

    if (!held) {
      if (discardConfirmed) {
        return this.replaceFailed()
      }
      // 確定できなかった入力が古い文書を書き戻した。入力はエディタに残っている
      this.markUnsaved()
      return { kind: 'NeedsUnsavedDecision' }
    }

    this.base = {
      text,
      sha256: reply.sha256,
      path: reply.path,
      revision: reply.revision,
      format: reply.format,
      encoding: reply.encoding,
      bom: reply.bom,
      scan: reply.scan,
      textOnly,
      sizeClass: reply.sizeClass,
      roundTripOk: reply.roundTripOk
    }
    this.unsaved = false
    return { kind: 'Opened', baseline: this.base }
  }

  private holds(text: string): boolean {
    const content = this.editor.current()
    return isTextContent(content) && content.text === text
  }

  private markUnsaved(): void {
    this.unsaved = true
    this.epoch++
    this.publish()
  }

  private async saveNow(target: SaveTarget): Promise<SaveOutcome> {
    const { editor, base } = this
    const { path, chosenFrom } = target
    if (this.saveStopped) {
      return { kind: 'Blocked', reason: 'replaceFailed' }
    }
    if (chosenFrom !== undefined && chosenFrom !== this.revision) {
      return { kind: 'StaleRevision' }
    }
    if (editor.hasOpenModal()) {
      return { kind: 'Blocked', reason: 'modalOpen' }
    }
    editor.commitPending()
    if (base === null && path === undefined) {
      return { kind: 'NeedsPath' }
    }
    const content = editor.current()
    const startEpoch = this.epoch

    const converting = target.encoding !== undefined && target.encoding !== base?.encoding
    if (base !== null && !converting && isUnchanged(content, base)) {
      return this.finishBaselineCopy(base, target, startEpoch)
    }
    return this.write(content, target, converting, startEpoch)
  }

  /**
   * 未編集の保存。「基準と同じ」は「ディスクが基準と同じ」を意味しないので、読み書きの側に任せる。
   * 開いているパスでディスクが基準と同じなら書かず、別のパスなら基準のバイト列をそのまま書く。
   */
  private async finishBaselineCopy(
    base: Baseline,
    { path, confirm }: SaveTarget,
    startEpoch: number
  ): Promise<SaveOutcome> {
    const reply = await this.backend.saveBaselineAs(base.revision, path, confirm)
    if (reply.kind === 'Saved') {
      this.replaceBaseline({ ...base, ...savedFields(reply) }, startEpoch)
      return { kind: 'Saved', eolNormalized: false, backupLeft: reply.backupLeft }
    }
    return settledReply(reply, () => this.settle(startEpoch))
  }

  private async write(
    content: Content,
    target: SaveTarget,
    converting: boolean,
    startEpoch: number
  ): Promise<SaveOutcome> {
    const { base } = this
    const format = base?.format ?? DEFAULT_FORMAT
    const serialized = serializeContent(content, format, this.options.stringify)
    if (!serialized.ok) {
      return {
        kind: serialized.reason === 'mismatch' ? 'SerializationMismatch' : 'SerializationFailed'
      }
    }
    const { text, eolNormalized } = serialized
    if (!isWellFormedText(text)) {
      return { kind: 'UnpairedSurrogate' }
    }

    const bytes = new TextEncoder().encode(text)
    const { path, encoding, confirm } = target
    const reply = await this.backend.save(
      { revision: base?.revision ?? NO_DOCUMENT, path, encoding, confirm },
      bytes
    )
    if (reply.kind === 'Saved') {
      // 字面を利用者が決めた保存は、次の表の保存がその書式で書くよう取り直す
      const format = isTextContent(content) && text !== base?.text ? reply.format : null
      const next: Baseline = {
        ...(base ?? newDocumentFields()),
        ...savedFields(reply),
        ...(converting && encoding !== undefined ? { encoding, bom: false } : {}),
        ...(format !== null ? { format } : {}),
        text,
        roundTripOk: true
      }
      this.replaceBaseline(next, startEpoch)
      return { kind: 'Saved', eolNormalized, backupLeft: reply.backupLeft }
    }
    return settledReply(reply, () => this.settle(startEpoch))
  }

  private replaceBaseline(next: Baseline, startEpoch: number): void {
    this.base = next
    this.editor.applyFormat(next.format)
    this.settle(startEpoch)
  }

  /**
   * 保存の完了時に未保存を決める。無条件に消さない。保存の間の編集を残すためである。
   * 確定前の入力は `current()` に写らないので、合図が無ければ確定してから比べる。
   * 合図があれば確定しない。保存の完了が打っている途中のセルを閉じないためである。
   */
  private settle(startEpoch: number): void {
    if (this.epoch === startEpoch) {
      this.editor.commitPending()
    }
    this.unsaved = this.epoch !== startEpoch || !this.matchesBaseline()
  }
}

interface SaveTarget extends SaveAsOptions {
  path?: string
  /** 別名保存の保存先を選ぶ前の版。 */
  chosenFrom?: number
}

const savedFields = ({ revision, path, sha256 }: SavedReply) => ({ revision, path, sha256 })

function settledReply(reply: Exclude<SaveReply, SavedReply>, settle: () => void): SaveOutcome {
  if (reply.kind === 'Unchanged') {
    settle()
    return { kind: 'NoChange' }
  }
  return reply
}

function newDocumentFields(): Omit<Baseline, 'revision' | 'path' | 'sha256' | 'text'> {
  return {
    format: DEFAULT_FORMAT,
    encoding: 'utf8',
    bom: false,
    scan: { duplicateKey: false, numericKeyReorder: false, reservedKey: false, depthExceeded: false, syntaxOk: true },
    textOnly: false,
    sizeClass: 'allModes',
    roundTripOk: true
  }
}
