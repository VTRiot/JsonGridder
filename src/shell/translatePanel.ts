import './translatePanel.css'
import { format, t } from '../i18n'
import type { TranslateFailure, TranslateItem } from './ports'

/**
 * 翻訳の結果の小窓（右）。原文と訳を並べて出し、コピーできる。
 *
 * 文書には触らない（R1）。小窓は殻の別の DOM で、エディタも文書も参照しない。
 * 文字は `textContent` だけで入れる（R9。訳と原文は外から来た文字列で、HTML として読まない）。
 * 閉じると結果は消える（保存しない）。
 */

export type RowStatus = 'pending' | 'done' | TranslateFailure

export interface PanelRowSource {
  label: string
  original: string
}

export interface PanelRow extends PanelRowSource {
  status: RowStatus
  translation: string
  /** 訳したモデル。分からなければ空。 */
  model: string
}

/** 詳しい行（サービスの文）の長さの上限（文字数）。Rust の `DETAIL_MAX_CHARS` と同じ。 */
export const DETAIL_MAX_CHARS = 300
const ELLIPSIS = '…'

/** 文字数（コードポイント）で切る。切ったら末尾に印を付ける。 */
export function clip(text: string, limit = DETAIL_MAX_CHARS): string {
  const chars = [...text]
  return chars.length <= limit ? text : chars.slice(0, Math.max(0, limit - 1)).join('') + ELLIPSIS
}

/** 状態の名から辞書のキーへ。 */
const STATUS_KEYS: Record<RowStatus, string> = {
  pending: 'app.translate.panel.status.pending',
  done: 'app.translate.panel.status.done',
  malformed: 'app.translate.panel.status.malformed',
  blocked: 'app.translate.panel.status.blocked',
  tooLong: 'app.translate.panel.status.tooLong'
}

/** 「続きを訳す」で送り直す状態。拒まれた物と長すぎる物は送り直しても同じなので含めない。 */
const RESUMABLE: ReadonlySet<RowStatus> = new Set<RowStatus>(['pending', 'malformed'])

/** 表計算に貼れるタブ区切りの 1 欄。タブ、改行、引用符を含むときは引用符で囲む（中の引用符は 2 つにする）。 */
export function tsvField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export interface TranslatePanelOptions {
  onCancel(): void
  onResume(): void
  onClose(): void
  /** 訳を新しい列として足す（列から訳したときだけ出るボタン）。 */
  onAddColumn(): void
  /** 注意書きの「今後表示しない」が押された。小窓はすでに注意書きを隠している。 */
  onHideMachineNotice(): void
  /** クリップボードへ書く。失敗は拒む。 */
  copy(text: string): Promise<void>
}

export interface TranslatePanel {
  element: HTMLElement
  /**
   * 新しい結果で開く。前の結果は捨てる。行はすべて未翻訳。`addColumn` は「訳を新しい列として足す」を
   * 出すか（列から訳したときだけ）。
   */
  open(source: () => string, rows: PanelRowSource[], options?: { addColumn?: boolean }): void
  close(): void
  isOpen(): boolean
  /** `model` はその組を訳したモデル（分からなければ省く）。 */
  setTranslated(results: readonly TranslateItem[], model?: string): void
  setFailed(ids: readonly number[], reason: TranslateFailure): void
  /** 続きを訳すで送り直す行を未翻訳に戻す。 */
  markPending(ids: readonly number[]): void
  /** 動いている間は取り消しのボタン、止まっていれば続きを訳すのボタン（未翻訳があるとき）。 */
  setRunning(running: boolean): void
  /** 進み具合の行の文。言語を替えたときに作り直せるよう、文を作る関数で渡す。 */
  setMessage(message: (() => string) | null, kind?: 'info' | 'error'): void
  /** 理由の文の下の詳しい行（サービスの言った文）。文字として出し、長さを切る。 */
  setDetail(detail: (() => string) | null): void
  /** 使ったモデルの行。 */
  setModels(models: (() => string) | null): void
  /** どの枠（無料枠用か有料用）のキーで送ったかの行。 */
  setTier(tier: (() => string) | null): void
  /** 「訳は機械の推測」の注意書きを出すか（設定の値）。 */
  setMachineNotice(shown: boolean): void
  /** 続きを訳すの対象の行の番号。 */
  resumableIds(): number[]
  rows(): readonly PanelRow[]
  /** 言語を替えたときに文言を引き直す。 */
  refresh(): void
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag)
  created.className = className
  return created
}

function button(className: string, action: string): HTMLButtonElement {
  const created = create('button', `app-translate-button ${className}`.trim())
  created.type = 'button'
  created.dataset.action = action
  return created
}

export function createTranslatePanel(options: TranslatePanelOptions): TranslatePanel {
  const element = create('aside', 'app-translate-panel')
  element.hidden = true
  const resizer = create('div', 'app-translate-resizer')
  resizer.setAttribute('aria-hidden', 'true')
  const inner = create('div', 'app-translate-inner')
  const head = create('div', 'app-translate-head')
  const title = create('h2', 'app-translate-title')
  const close = button('', 'close')
  head.append(title, close)
  const source = create('p', 'app-translate-source')
  const tierLine = create('p', 'app-translate-tier')
  tierLine.hidden = true
  const machine = create('div', 'app-translate-machine')
  machine.dataset.notice = 'machine'
  const machineText = create('span', 'app-translate-machine-text')
  const hideMachine = button('app-translate-machine-hide', 'hideMachineNotice')
  machine.append(machineText, hideMachine)
  const progress = create('div', 'app-translate-progress')
  const count = create('span', 'app-translate-count')
  const cancel = button('', 'cancel')
  progress.append(count, cancel)
  const message = create('p', 'app-translate-message')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const detail = create('p', 'app-translate-detail')
  const models = create('p', 'app-translate-models')
  const list = create('ol', 'app-translate-rows')
  const actions = create('div', 'app-translate-actions')
  const copyAll = button('', 'copyAll')
  const copyPairs = button('', 'copyPairs')
  const resume = button('app-translate-primary', 'resume')
  const addColumn = button('', 'addColumn')
  const copied = create('span', 'app-translate-copied')
  copied.setAttribute('role', 'status')
  actions.append(copyAll, copyPairs, addColumn, resume, copied)
  inner.append(head, source, tierLine, machine, progress, message, detail, models, list, actions)
  element.append(resizer, inner)

  let sourceText: () => string = () => ''
  let tierText: (() => string) | null = null
  let machineShown = true
  let rows: PanelRow[] = []
  let rowElements: HTMLLIElement[] = []
  let running = false
  let messageText: (() => string) | null = null
  let detailText: (() => string) | null = null
  let modelsText: (() => string) | null = null
  let copiedKey: string | null = null
  let canAddColumn = false

  function renderRow(index: number): void {
    const row = rows[index]
    const item = rowElements[index]
    item.dataset.status = row.status
    const status = item.querySelector<HTMLElement>('.app-translate-status')
    const translation = item.querySelector<HTMLElement>('.app-translate-translation')
    const copyOne = item.querySelector<HTMLButtonElement>('[data-action="copyOne"]')
    const model = item.querySelector<HTMLElement>('.app-translate-model')
    if (status) status.textContent = t(STATUS_KEYS[row.status])
    if (model) {
      // 2 つ以上のモデルで訳したときだけ、行ごとにどのモデルの訳かを出す
      model.textContent = row.model
      model.hidden = row.status !== 'done' || row.model === '' || !mixedModels()
    }
    if (translation) {
      translation.textContent = row.translation
      translation.hidden = row.status !== 'done'
    }
    if (copyOne) {
      copyOne.textContent = t('app.translate.panel.copyOne')
      copyOne.hidden = row.status !== 'done'
    }
  }

  function renderSummary(): void {
    const done = rows.filter((row) => row.status === 'done').length
    count.textContent = format('app.translate.panel.progress', { done: String(done), total: String(rows.length) })
    cancel.hidden = !running
    resume.hidden = running || !rows.some((row) => RESUMABLE.has(row.status))
    copyAll.disabled = done === 0
    copyPairs.disabled = done === 0
    addColumn.hidden = !canAddColumn
    addColumn.disabled = running || done === 0
    message.textContent = messageText?.() ?? ''
    message.hidden = messageText === null
    detail.textContent = clip(detailText?.() ?? '')
    detail.hidden = detailText === null
    models.textContent = modelsText?.() ?? ''
    models.hidden = modelsText === null
    tierLine.textContent = tierText?.() ?? ''
    tierLine.hidden = tierText === null
    machine.hidden = !machineShown
  }

  function mixedModels(): boolean {
    return new Set(rows.flatMap((row) => (row.status === 'done' && row.model !== '' ? [row.model] : []))).size > 1
  }

  function renderStatic(): void {
    element.setAttribute('aria-label', t('app.translate.panel.title'))
    title.textContent = t('app.translate.panel.title')
    close.textContent = t('app.translate.panel.close')
    machineText.textContent = t('app.translate.machineNotice')
    hideMachine.textContent = t('app.translate.machineNoticeHide')
    cancel.textContent = t('app.translate.panel.cancel')
    copyAll.textContent = t('app.translate.panel.copyAll')
    copyPairs.textContent = t('app.translate.panel.copyPairs')
    resume.textContent = t('app.translate.panel.resume')
    addColumn.textContent = t('app.translate.panel.addColumn')
    source.textContent = sourceText()
    copied.textContent = copiedKey === null ? '' : t(copiedKey)
    for (const item of rowElements) {
      const labels = item.querySelectorAll<HTMLElement>('[data-caption]')
      for (const label of labels) {
        label.textContent = t(label.dataset.caption ?? '')
      }
    }
  }

  function buildRow(row: PanelRow, index: number): HTMLLIElement {
    const item = create('li', 'app-translate-row')
    item.dataset.id = String(index)
    const rowHead = create('div', 'app-translate-row-head')
    const place = create('span', 'app-translate-place')
    place.textContent = row.label
    const status = create('span', 'app-translate-status')
    const model = create('span', 'app-translate-model')
    model.hidden = true
    const copyOne = button('app-translate-copy-one', 'copyOne')
    copyOne.addEventListener('click', () => void copyText(rows[index].translation))
    rowHead.append(place, model, status, copyOne)
    const originalCaption = create('span', 'app-translate-caption')
    originalCaption.dataset.caption = 'app.translate.panel.original'
    const original = create('div', 'app-translate-original')
    original.textContent = row.original
    const translationCaption = create('span', 'app-translate-caption')
    translationCaption.dataset.caption = 'app.translate.panel.translation'
    const translation = create('div', 'app-translate-translation')
    item.append(rowHead, originalCaption, original, translationCaption, translation)
    return item
  }

  async function copyText(text: string): Promise<void> {
    try {
      await options.copy(text)
      copiedKey = 'app.translate.panel.copied'
    } catch {
      copiedKey = 'app.translate.panel.copyFailed'
    }
    copied.textContent = t(copiedKey)
    copied.dataset.kind = copiedKey === 'app.translate.panel.copied' ? 'info' : 'error'
  }

  close.addEventListener('click', () => options.onClose())
  cancel.addEventListener('click', () => options.onCancel())
  resume.addEventListener('click', () => options.onResume())
  addColumn.addEventListener('click', () => options.onAddColumn())
  // 押したらすぐ隠す（保存は殻が行い、保存できなければ殻が知らせる）
  hideMachine.addEventListener('click', () => {
    machineShown = false
    renderSummary()
    options.onHideMachineNotice()
  })
  // 訳の並び（改行区切り）。訳の無い行は空の行にして、行の並びを原文と揃える
  copyAll.addEventListener('click', () => void copyText(rows.map((row) => (row.status === 'done' ? row.translation : '')).join('\n')))
  // 原文と訳（タブ区切り、1 行 1 件）。表計算に貼れる形
  copyPairs.addEventListener('click', () =>
    void copyText(
      rows.map((row) => `${tsvField(row.original)}\t${tsvField(row.status === 'done' ? row.translation : '')}`).join('\n')
    )
  )

  // 幅は境目のつまみで変える（表示だけの値で保存しない）。上限と下限は CSS の min-width と max-width
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = element.getBoundingClientRect().width
    resizer.setPointerCapture?.(event.pointerId)
    const move = (next: PointerEvent): void => {
      element.style.width = `${startWidth - (next.clientX - startX)}px`
    }
    const stop = (): void => {
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', stop)
      resizer.removeEventListener('pointercancel', stop)
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', stop)
    resizer.addEventListener('pointercancel', stop)
  })

  const panel: TranslatePanel = {
    element,
    open(sourceName, sources, openOptions = {}) {
      sourceText = sourceName
      canAddColumn = openOptions.addColumn === true
      rows = sources.map((row) => ({ ...row, status: 'pending', translation: '', model: '' }))
      rowElements = rows.map(buildRow)
      list.replaceChildren(...rowElements)
      running = false
      messageText = null
      detailText = null
      modelsText = null
      tierText = null
      copiedKey = null
      element.hidden = false
      renderStatic()
      rows.forEach((_, index) => renderRow(index))
      renderSummary()
    },
    close() {
      element.hidden = true
      rows = []
      rowElements = []
      list.replaceChildren()
      running = false
      messageText = null
      detailText = null
      modelsText = null
      tierText = null
      copiedKey = null
      canAddColumn = false
      addColumn.hidden = true
    },
    isOpen: () => !element.hidden,
    setTranslated(results, model = '') {
      const wasMixed = mixedModels()
      for (const { id, text } of results) {
        const row = rows[id]
        if (row !== undefined) {
          row.status = 'done'
          row.translation = text
          row.model = model
          renderRow(id)
        }
      }
      if (mixedModels() !== wasMixed) {
        rows.forEach((_, index) => renderRow(index))
      }
      renderSummary()
    },
    setFailed(ids, reason) {
      for (const id of ids) {
        const row = rows[id]
        if (row !== undefined && row.status !== 'done') {
          row.status = reason
          renderRow(id)
        }
      }
      renderSummary()
    },
    markPending(ids) {
      for (const id of ids) {
        const row = rows[id]
        if (row !== undefined && row.status !== 'done') {
          row.status = 'pending'
          renderRow(id)
        }
      }
      renderSummary()
    },
    setRunning(next) {
      running = next
      renderSummary()
    },
    setMessage(next, kind = 'info') {
      messageText = next
      message.dataset.kind = kind
      renderSummary()
    },
    setDetail(next) {
      detailText = next
      renderSummary()
    },
    setModels(next) {
      modelsText = next
      renderSummary()
    },
    setTier(next) {
      tierText = next
      renderSummary()
    },
    setMachineNotice(shown) {
      machineShown = shown
      renderSummary()
    },
    resumableIds: () => rows.flatMap((row, index) => (RESUMABLE.has(row.status) ? [index] : [])),
    rows: () => rows,
    refresh() {
      if (element.hidden) {
        return
      }
      renderStatic()
      rows.forEach((_, index) => renderRow(index))
      renderSummary()
    }
  }
  return panel
}
