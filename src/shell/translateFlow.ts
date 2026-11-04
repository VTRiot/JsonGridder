import { format, t } from '../i18n'
import type { AskRequest, CheckedAnswer, CheckedAskRequest, TranslateErrorDetail, TranslateEvent, TranslationPorts, TranslationSettings } from './ports'
import { summarize, toRequest, type SourceItem, type SourceSummary } from './translateCollect'
import type { ColumnEntry, ColumnSource } from './translateApply'
import type { TranslatePanel } from './translatePanel'
import { FREE_TIER, knownTiers, PAID_TIER, serviceLabel, tierLabel } from './translationSettings'

/**
 * 翻訳の流れ: 送る前の確かめ → Rust の仕事 → 結果の小窓。
 *
 * 文書に触らない（R1）。この流れはエディタも文書も持たず、集めた文字列と小窓だけを扱う。
 * 翻訳が無効なら Rust を一切呼ばない（R6。設定も読まない）。通信の可否は Rust が設定ファイルを
 * 読み直して決める（T2）。WebView は通信の手段を持たない。
 */

/** 確かめのボタン（送る、止めて翻訳）と取り消し。既定は取り消し（R11）。 */
const ACCEPT_BUTTON = 0
const CANCEL_BUTTON = 1

/** 翻訳先の言語（UI の言語）。正は Rust の `TARGETS`。一覧の外の言語では項目を出さない。 */
export const TARGET_LANGUAGES: readonly string[] = ['ja', 'en']

/** 仕事を始めないときの理由（Rust の `StartError`）から辞書のキーへ。 */
const START_ERROR_KEYS: Record<string, string> = {
  disabled: 'app.translate.error.disabled',
  noKey: 'app.translate.error.noKey',
  key: 'app.translate.error.storedKey',
  target: 'app.translate.error.target',
  settings: 'app.translate.error.settings',
  tier: 'app.translate.error.tier',
  busy: 'app.translate.error.busy',
  noItems: 'app.translate.error.noItems',
  blank: 'app.translate.error.blank',
  duplicateId: 'app.translate.error.duplicateId',
  tooMuch: 'app.translate.error.tooMuch',
  store: 'app.translate.error.store',
  thread: 'app.translate.error.thread'
}

/** 仕事が止まった理由（Rust の `ErrorKind`。`finished.error`）から辞書のキーへ。 */
const FINISH_ERROR_KEYS: Record<string, string> = {
  key: 'app.translate.error.key',
  permission: 'app.translate.error.permission',
  model: 'app.translate.error.model',
  quota: 'app.translate.error.quota',
  overloaded: 'app.translate.error.overloaded',
  service: 'app.translate.error.service',
  network: 'app.translate.error.network',
  malformed: 'app.translate.error.malformed',
  cancelled: 'app.translate.panel.cancelled'
}
const UNKNOWN_ERROR_KEY = 'app.translate.error.unknown'

/** 切り替えた先のモデルでも通らず、使えるモデルを全部試した（混雑か回数の上限）。 */
const ALL_MODELS_KEYS: Record<string, string> = {
  overloaded: 'app.translate.error.allOverloaded',
  quota: 'app.translate.error.allQuota'
}

/** 待つ理由ごとの文。知らない理由は総称の文。 */
const WAITING_KEYS: Record<string, string> = {
  overloaded: 'app.translate.panel.waitingOverloaded',
  quota: 'app.translate.panel.waitingQuota'
}
const WAITING_KEY = 'app.translate.panel.waiting'

/** 切り替えた理由ごとの文（使ったモデルの行と、切り替えの知らせ）。 */
const SWITCH_REASON_KEYS: Record<string, string> = {
  overloaded: 'app.translate.panel.modelReason.overloaded',
  quota: 'app.translate.panel.modelReason.quota'
}
const SWITCH_REASON_KEY = 'app.translate.panel.modelReason.other'

/** 名の全数（辞書と照らす試験が使う）。 */
export const ALL_MODELS_CODES = Object.keys(ALL_MODELS_KEYS)
export const WAITING_CODES = Object.keys(WAITING_KEYS)
export const SWITCH_REASON_CODES = Object.keys(SWITCH_REASON_KEYS)

function codeOf(reason: unknown): string {
  return typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : ''
}

/** 仕事を始めない理由を UI の言語の文へ。知らない名は総称の文。 */
export function startErrorText(reason: unknown): string {
  const code = codeOf(reason)
  return t(Object.hasOwn(START_ERROR_KEYS, code) ? START_ERROR_KEYS[code] : UNKNOWN_ERROR_KEY)
}

/**
 * 止まった理由を UI の言語の文へ。知らない名は総称の文。`model` は止まったときのモデル。
 * `triedAll` は切り替えた先でも同じ理由で通らず、使えるモデルを全部試したこと。
 */
export function finishErrorText(code: string, model = '', triedAll = false): string {
  if (triedAll && Object.hasOwn(ALL_MODELS_KEYS, code)) {
    return t(ALL_MODELS_KEYS[code])
  }
  return format(Object.hasOwn(FINISH_ERROR_KEYS, code) ? FINISH_ERROR_KEYS[code] : UNKNOWN_ERROR_KEY, { model })
}

/** 待つ理由の文。 */
export function waitingText(reason: string | undefined, model: string, seconds: string): string {
  const key = reason !== undefined && Object.hasOwn(WAITING_KEYS, reason) ? WAITING_KEYS[reason] : WAITING_KEY
  return format(key, { model, seconds })
}

function switchReasonText(reason: string, from: string): string {
  return format(Object.hasOwn(SWITCH_REASON_KEYS, reason) ? SWITCH_REASON_KEYS[reason] : SWITCH_REASON_KEY, { from })
}

/** サービスの言った理由の行（Google の状態の名と文）。どちらも無ければ null。文字として出す。 */
export function detailText(detail: TranslateErrorDetail | null | undefined): string | null {
  if (detail === null || detail === undefined) {
    return null
  }
  const status = typeof detail.status === 'string' ? detail.status : ''
  const message = typeof detail.message === 'string' ? detail.message : ''
  if (status === '' && message === '') {
    return null
  }
  const text = status === '' ? message : message === '' ? status : `${status}: ${message}`
  return format('app.translate.panel.detail', { text })
}

/** 切り替えの記録。 */
export interface ModelSwitch {
  from: string
  to: string
  reason: string
}

/**
 * 使ったモデルの行。訳したモデルを訳した順に並べ、切り替えた先のモデルには理由を添える。
 * 例: 「使ったモデル: gemini-3.5-flash-lite（gemini-3.1-flash-lite が混雑していたため）」
 */
export function modelsText(used: readonly string[], switches: readonly ModelSwitch[]): string {
  const names = used.map((model) => {
    const switched = switches.find((entry) => entry.to === model)
    return switched === undefined ? model : `${model}${switchReasonText(switched.reason, switched.from)}`
  })
  return format('app.translate.panel.models', { models: names.join(t('app.translate.panel.modelSeparator')) })
}

/** 小窓の「どの枠のキーで送ったか」の行。 */
const PANEL_TIER_KEYS: Record<string, string> = {
  [FREE_TIER]: 'app.translate.panel.tierFree',
  [PAID_TIER]: 'app.translate.panel.tierPaid'
}

/** 小窓の枠の行の文。知らない枠は null（行を出さない）。 */
export function panelTierText(tier: string): string | null {
  return Object.hasOwn(PANEL_TIER_KEYS, tier) ? t(PANEL_TIER_KEYS[tier]) : null
}

/** キーのある枠（画面が知っている枠だけ、Rust の一覧の順）。右クリックの項目はこの数だけ出す。 */
export function availableTiers(settings: Pick<TranslationSettings, 'tiers' | 'keyTiers'>): string[] {
  const saved = new Set(settings.keyTiers ?? [])
  return knownTiers(settings.tiers ?? []).filter((tier) => saved.has(tier))
}

/** 結果の小窓に注意書きを出すか。値が無い（古い Rust）か真偽でないときは出す。 */
export function machineNoticeShown(settings: Pick<TranslationSettings, 'machineNotice'>): boolean {
  return settings.machineNotice !== false
}

/** 送る前に確かめるか。値が無い（古い Rust）か真偽でないときは確かめる。 */
export function confirmationNeeded(settings: Pick<TranslationSettings, 'confirm'>): boolean {
  return settings.confirm !== false
}

/** 確かめの答えで、今後の確かめを切るか。「今後表示しない」を入れて「送る」を押したときだけ。 */
export function stopsAsking(answer: CheckedAnswer): boolean {
  return answer.button === ACCEPT_BUTTON && answer.checked === true
}

/** 名の全数（辞書と照らす試験が使う）。 */
export const START_ERROR_CODES = Object.keys(START_ERROR_KEYS)
export const FINISH_ERROR_CODES = Object.keys(FINISH_ERROR_KEYS)

export interface TranslateRequest {
  /** 小窓の見出しと確かめに出す、何を訳すか（列の名前か値の場所）。言語を替えても引き直せるよう関数で渡す。 */
  source(): string
  items: SourceItem[]
  /** 列から訳したときの出どころ。あるときだけ小窓に「訳を新しい列として足す」を出す（T5）。 */
  column?: ColumnSource
  /**
   * 右クリックで選んだ枠（`free` か `paid`）。そのキーだけで送る。無いのは、どの枠にもキーが無いと
   * 殻が見ていたときの項目で、送らずにキーの設定へ案内する（キーが置かれていれば選び直してもらう）。
   */
  tier?: string
}

/** 新しい列として足す材料。小窓の行の原文と訳（訳せなかった行は null）。 */
export interface ColumnResults {
  source: ColumnSource
  entries: ColumnEntry[]
  target: string
}

export interface TranslateFlowOptions {
  ports: TranslationPorts
  ask(request: AskRequest): Promise<number>
  /** 送る前の確かめ（「今後表示しない」のチェックボックスつき）。 */
  askChecked(request: CheckedAskRequest): Promise<CheckedAnswer>
  notify(message: string): void
  panel: TranslatePanel
  /** 殻が持つ有効の値（起動の値と、設定のダイアログで保存した値）。 */
  enabled(): boolean
  /** Rust の設定ファイルでは無効だった。殻の値を合わせる。 */
  onDisabled(): void
  /** キーが無い。設定のダイアログを開く。 */
  openSettings(): void
  /** 設定を読み直した（右クリックの項目を出すキーの有無を殻が覚え直す）。 */
  onSettings?(settings: TranslationSettings): void
  /** 翻訳先の言語（UI の言語）。一覧の外なら undefined。 */
  target(): string | undefined
}

export interface TranslateFlow {
  request(request: TranslateRequest): Promise<void>
  /** 小窓の未翻訳の行だけを送り直す。送る前の確かめをもう一度出す。 */
  resume(): Promise<void>
  /** 動いている仕事を取り消す。訳せた行は小窓に残る。 */
  cancel(): void
  /** 小窓の注意書きの「今後表示しない」。設定に保存する。保存できなければ知らせる。 */
  hideMachineNotice(): Promise<void>
  /** 文書が替わった。仕事を取り消し、小窓を閉じる。 */
  reset(): void
  running(): boolean
  /** 列から訳した結果。値から訳した、動いている、小窓が閉じているときは null。文書には触らない。 */
  columnResults(): ColumnResults | null
}

interface Run {
  job: number | null
  cancelRequested: boolean
  /** 今使っているモデル（最初は保存した設定の値）。 */
  model: string
  /** 訳したモデル（訳した順、重ならない）。 */
  used: string[]
  switches: ModelSwitch[]
}

export function createTranslateFlow(options: TranslateFlowOptions): TranslateFlow {
  const { ports, panel } = options
  let active: Run | null = null
  /** 小窓の行の元（行の番号は添字）。続きを訳すで使う。 */
  let rows: SourceItem[] = []
  let source: () => string = () => ''
  let column: ColumnSource | undefined
  let target = ''
  /** 小窓の行を送った枠。続きを訳すも同じ枠で送る。 */
  let tier = ''

  function cancelRun(run: Run): void {
    run.cancelRequested = true
    if (run.job !== null) {
      void ports.cancel(run.job).catch(() => false)
    }
  }

  /** 動いている仕事があれば、止めるかを聞く。止めると答えたら取り消して true。 */
  async function stopRunningIfAsked(): Promise<boolean> {
    if (active === null) {
      return true
    }
    const answer = await options.ask({
      title: t('app.dialog.translateBusyTitle'),
      body: t('app.dialog.translateBusyBody'),
      level: 'warning',
      buttons: [t('app.dialog.translateStop'), t('app.dialog.cancel')],
      default: CANCEL_BUTTON,
      cancel: CANCEL_BUTTON
    })
    if (answer !== ACCEPT_BUTTON) {
      return false
    }
    if (active !== null) {
      const old = active
      active = null // 古い仕事の知らせは捨てる
      cancelRun(old)
      panel.setRunning(false)
      panel.setMessage(() => finishErrorText('cancelled'))
    }
    return true
  }

  /**
   * 設定を読み直し、有効で、選んだ枠にキーがあるときだけ返す。通信はしない（設定ファイルと資格情報マネージャーを
   * 読むだけ）。枠が無い（どの枠にもキーが無いと殻が見ていた項目）ときは送らない: キーがまだ無ければ設定へ案内し、
   * 置かれていれば右クリックで選び直してもらう（黙ってどちらかの枠で送らない）。
   */
  async function readSettings(chosen: string | undefined): Promise<TranslationSettings | null> {
    let settings: TranslationSettings
    try {
      settings = await ports.settings()
    } catch (reason) {
      options.notify(startErrorText(reason))
      return null
    }
    options.onSettings?.(settings)
    if (!settings.enabled) {
      options.onDisabled()
      options.notify(startErrorText('disabled'))
      return null
    }
    const available = availableTiers(settings)
    if (chosen === undefined && available.length > 0) {
      options.notify(t('app.translate.chooseTier'))
      return null
    }
    if (chosen === undefined || !available.includes(chosen)) {
      options.notify(startErrorText('noKey'))
      options.openSettings()
      return null
    }
    return settings
  }

  /**
   * 送る前の確かめ。設定で切ってあれば出さずに送る（F4）。出したときは「今後表示しない」を添え、
   * 入れて「送る」を押したときだけ切る設定を保存する。取り消し、Esc、×、外したままでは設定を替えない。
   * 保存できなくても今回は送る（押したのは「送る」）。保存できなかったことは知らせる。
   */
  async function confirm(settings: TranslationSettings, chosen: string, summary: SourceSummary): Promise<boolean> {
    if (!confirmationNeeded(settings)) {
      return true
    }
    const free = chosen === FREE_TIER
    const body = [
      format('app.dialog.translateBody', {
        source: source(),
        count: String(summary.total),
        unique: String(summary.unique),
        chars: String(summary.chars),
        service: serviceLabel(settings.service),
        model: settings.model,
        tier: tierLabel(chosen)
      }),
      ...(free ? [t('app.dialog.translateFreeTierWarning')] : []),
      t('app.translate.machineNotice')
    ]
    const answer = await options.askChecked({
      title: t('app.dialog.translateTitle'),
      body: body.join('\n\n'),
      level: free ? 'warning' : 'info',
      buttons: [t('app.dialog.translateSend'), t('app.dialog.cancel')],
      default: CANCEL_BUTTON,
      cancel: CANCEL_BUTTON,
      check: t('app.dialog.translateDontAskAgain')
    })
    const accepted = answer.button === ACCEPT_BUTTON
    if (stopsAsking(answer)) {
      try {
        await ports.saveConfirm(false)
      } catch {
        options.notify(t('app.translate.confirmNotSaved'))
      }
    }
    return accepted
  }

  function handle(run: Run, event: TranslateEvent): void {
    if (active !== run) {
      return // 取り消した仕事、または替わった仕事の知らせ
    }
    if (event.kind === 'translated') {
      const model = typeof event.model === 'string' ? event.model : ''
      panel.setTranslated(event.results, model)
      if (model !== '' && !run.used.includes(model)) {
        run.used.push(model)
        const used = [...run.used]
        const switches = [...run.switches]
        panel.setModels(() => modelsText(used, switches))
      }
    } else if (event.kind === 'failed') {
      panel.setFailed(event.ids, event.reason)
    } else if (event.kind === 'waiting') {
      const seconds = String(event.seconds)
      const model = event.model ?? run.model
      const reason = event.reason
      panel.setMessage(() => waitingText(reason, model, seconds))
    } else if (event.kind === 'switched') {
      const entry: ModelSwitch = { from: event.from, to: event.to, reason: event.reason }
      run.switches.push(entry)
      run.model = event.to
      panel.setMessage(() => format('app.translate.panel.switched', { to: entry.to, reason: switchReasonText(entry.reason, entry.from) }))
    } else {
      active = null
      panel.setRunning(false)
      const error = event.error
      const detail = detailText(event.detail)
      panel.setDetail(detail === null ? null : () => detailText(event.detail) ?? '')
      if (error === null) {
        const blocked = panel.rows().some((row) => row.status === 'blocked')
        const key = blocked
          ? 'app.translate.panel.finishedBlocked'
          : panel.resumableIds().length > 0
            ? 'app.translate.panel.finishedPartly'
            : 'app.translate.panel.finished'
        panel.setMessage(() => t(key))
      } else if (error === 'cancelled') {
        panel.setMessage(() => finishErrorText(error))
      } else {
        const model = run.model
        // Rust は切り替えが有効で次のモデルが残っていれば止まらない。切り替えた後に混雑か上限で止まったなら全部を試した
        const triedAll = run.switches.length > 0
        panel.setMessage(() => finishErrorText(error, model, triedAll), 'error')
      }
    }
  }

  function launch(ids: number[], model: string): void {
    const run: Run = { job: null, cancelRequested: false, model, used: [], switches: [] }
    active = run
    panel.setRunning(true)
    panel.setMessage(() => t('app.translate.panel.running'))
    panel.setDetail(null)
    panel.setModels(null)
    const items = toRequest(ids.map((id) => rows[id]), ids)
    ports.start(items, target, tier, (event) => handle(run, event)).then(
      (job) => {
        run.job = job
        if (run.cancelRequested) {
          void ports.cancel(job).catch(() => false)
        }
      },
      (reason: unknown) => {
        if (active !== run) {
          return
        }
        active = null
        panel.setRunning(false)
        panel.setMessage(() => startErrorText(reason), 'error')
        if (codeOf(reason) === 'disabled') {
          options.onDisabled()
        }
      }
    )
  }

  return {
    async request(request) {
      // 無効なら Rust を一切呼ばない（設定も読まない）
      if (!options.enabled()) {
        return
      }
      const language = options.target()
      if (language === undefined) {
        return
      }
      if (request.items.length === 0) {
        options.notify(t('app.translate.nothing'))
        return
      }
      if (!(await stopRunningIfAsked())) {
        return
      }
      const settings = await readSettings(request.tier)
      if (settings === null || request.tier === undefined) {
        return
      }
      const chosen = request.tier
      const previousSource = source
      source = request.source
      if (!(await confirm(settings, chosen, summarize(request.items)))) {
        source = previousSource
        return
      }
      rows = request.items
      column = request.column
      target = language
      tier = chosen
      panel.open(
        request.source,
        rows.map((item) => ({ label: item.label, original: item.text })),
        { addColumn: column !== undefined }
      )
      panel.setTier(panelTierText(chosen) === null ? null : () => panelTierText(chosen) ?? '')
      panel.setMachineNotice(machineNoticeShown(settings))
      launch(
        rows.map((_, index) => index),
        settings.model
      )
    },
    async resume() {
      if (active !== null || !panel.isOpen() || !options.enabled()) {
        return
      }
      const ids = panel.resumableIds()
      if (ids.length === 0) {
        return
      }
      // 続きは小窓の行を送ったのと同じ枠で送る
      const chosen = tier
      const settings = await readSettings(chosen)
      if (settings === null || !(await confirm(settings, chosen, summarize(ids.map((id) => rows[id]))))) {
        return
      }
      if (active !== null || !panel.isOpen()) {
        return // 確かめの間に別の仕事が始まった、または小窓が閉じた
      }
      panel.markPending(ids)
      launch(ids, settings.model)
    },
    cancel() {
      if (active !== null) {
        cancelRun(active)
      }
    },
    async hideMachineNotice() {
      panel.setMachineNotice(false)
      try {
        await ports.saveMachineNotice(false)
      } catch {
        options.notify(t('app.translate.machineNoticeNotSaved'))
      }
    },
    reset() {
      if (active !== null) {
        const old = active
        active = null
        cancelRun(old)
      }
      rows = []
      column = undefined
      tier = ''
      panel.close()
    },
    running: () => active !== null,
    columnResults() {
      if (column === undefined || active !== null || !panel.isOpen()) {
        return null
      }
      const shown = panel.rows()
      return {
        source: column,
        entries: rows.map((item, index) => ({
          path: item.path,
          original: item.text,
          translation: shown[index]?.status === 'done' ? shown[index].translation : null
        })),
        target
      }
    }
  }
}
