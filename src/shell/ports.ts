import { Channel, invoke } from '@tauri-apps/api/core'
import {
  createTauriBackend,
  type ExternalFiles,
  type FileBackend,
  type JsonDiagnoser,
  type JsonScanner
} from '../document/backend'
import type { Theme } from './menuModel'

export type DialogLevel = 'info' | 'warning' | 'error'

/** 確認のダイアログ。戻り値は押されたボタンの添字。Esc と×は `cancel` の添字になる。 */
export interface AskRequest {
  title: string
  body: string
  level: DialogLevel
  buttons: string[]
  default: number
  cancel: number
}

/** ボタンの下にチェックボックスを 1 つ添えた確認。`check` はその文言で、最初は外してある。 */
export interface CheckedAskRequest extends AskRequest {
  check: string
}

/** 押されたボタンの添字と、閉じたときにチェックボックスが入っていたか（押したボタンに関わらず）。 */
export interface CheckedAnswer {
  button: number
  checked: boolean
}

export type ShellEvent =
  | { kind: 'Open'; path: string; discardConfirmed: boolean }
  | { kind: 'Notice'; key: string }
  /** 閉じる確認で「保存」が選ばれた。`saveFinished` で答える。 */
  | { kind: 'SaveAndContinue'; id: number }

/** Rust が閉じる判断に使う印。`seq` の大きい物だけが採られる。 */
export interface DocumentReport {
  seq: number
  unsaved: boolean
  saveBlocked: boolean
  title: string
}

export interface Startup {
  version: string
  theme: Theme
  language: string
  recent: string[]
  splashCeremony: boolean
  splashCeremonyUnlocked: boolean
  wrapLines: boolean
  hideTargetsInTree: boolean
  /** 翻訳が有効か（設定ファイルの値）。通信の可否は Rust が仕事を始めるときに読み直して決める。 */
  translationEnabled: boolean
}

/**
 * 翻訳の設定。キーそのものは持たず、どの枠（無料枠用か有料用）にキーがあるかだけを持つ。一覧は Rust の定数が正。
 * 無料枠か有料かは設定に持たない（F5。翻訳のたびに右クリックで選ぶ）。
 */
export interface TranslationSettings {
  enabled: boolean
  service: string
  model: string
  /** 混雑のときに、その仕事の間だけ別のモデルへ切り替えるか（保存したモデルは替えない）。 */
  fallback: boolean
  /** 送る前に件数、文字数、サービスを出して確かめるか。古い Rust が値を返さなければ確かめる。 */
  confirm: boolean
  /** 結果の小窓に「訳は機械の推測」の注意書きを出すか。値が無ければ出す。 */
  machineNotice: boolean
  /** キーのある枠（`tiers` の順）。 */
  keyTiers: string[]
  /** F5 より前の、枠の決まっていないキーが残っているか。移すまで翻訳には使わない。 */
  hasLegacyKey: boolean
  services: string[]
  /** 枠の一覧（`free`、`paid`）。 */
  tiers: string[]
  /** 今のサービスのモデルの一覧。 */
  models: string[]
}

export type TranslationChoice = Pick<TranslationSettings, 'enabled' | 'service' | 'model' | 'fallback' | 'confirm' | 'machineNotice'>

/** 翻訳に送る 1 件。`id` は WebView が付けた番号（1 回の仕事の中で重ならない）。 */
export interface TranslateItem {
  id: number
  text: string
}

/** 1 件ずつの失敗の理由（Rust の `ItemFailure`）。 */
export type TranslateFailure = 'blocked' | 'malformed' | 'tooLong'

/** サービスが言った失敗の理由（Google の `error.status` と `error.message`）。キーは入らない。 */
export interface TranslateErrorDetail {
  status: string
  message: string
}

/**
 * Rust の仕事の知らせ（`JobEvent`）。`finished` は必ず 1 回で、`error` が null なら全部の組を送り終えた。
 * `model` は訳したモデル、`switched` は混雑などで残りの組を別のモデルで送ること。
 */
export type TranslateEvent =
  | { kind: 'translated'; job: number; model?: string; results: TranslateItem[] }
  | { kind: 'failed'; job: number; ids: number[]; reason: TranslateFailure }
  | { kind: 'waiting'; job: number; seconds: number; reason?: string; model?: string }
  | { kind: 'switched'; job: number; from: string; to: string; reason: string }
  | { kind: 'finished'; job: number; error: string | null; detail?: TranslateErrorDetail | null }

/**
 * 翻訳の設定とキー（Rust の command）。誤りは短い名（`empty`、`notSaved` など）の文字列で拒まれる。
 * キーを返す口は無い。
 */
export interface TranslationPorts {
  /** 設定ファイルと資格情報マネージャーを読み直す。 */
  settings(): Promise<TranslationSettings>
  saveSettings(choice: TranslationChoice): Promise<void>
  /** 送る前に確かめるかだけを保存する（確かめの「今後表示しない」）。ほかの設定には触らない。 */
  saveConfirm(confirm: boolean): Promise<void>
  /** 小窓の注意書きを出すかだけを保存する（小窓の「今後表示しない」）。ほかの設定には触らない。 */
  saveMachineNotice(shown: boolean): Promise<void>
  /** 選んだ枠のキーを保存する。書いた直後に Rust が読み直して確かめ、確かめられなければ `notSaved` で拒まれる。 */
  saveKey(tier: string, key: string): Promise<void>
  clearKey(tier: string): Promise<void>
  /**
   * F5 より前のキーを選んだ枠へ移す（書いて読み直してから元を消す）。移す先にキーがあれば `occupied`、
   * 元が無ければ `noLegacy` で拒まれる。
   */
  moveKey(tier: string): Promise<void>
  /**
   * 翻訳の仕事を始める。戻りは仕事の番号。知らせは `onEvent` に届く（戻りより先に届くことがある）。
   * `tier` は右クリックで選んだ枠で、Rust はその枠のキーだけを読む。
   * Rust は設定ファイルを読み直して有効か、キーがあるかを確かめ、外れは短い名（`disabled` など）で拒む。
   */
  start(items: TranslateItem[], target: string, tier: string, onEvent: (event: TranslateEvent) => void): Promise<number>
  /** 番号の合う仕事を取り消す。取り消せたら true（`finished` の `cancelled` がすぐ届く）。 */
  cancel(job: number): Promise<boolean>
}

export interface ShellPorts {
  backend: FileBackend
  /** 開くときと同じ検査。Tauri の外には無い。 */
  scanner?: JsonScanner
  /** 警告の帯に出す理由と位置。Tauri の外には無い（帯は理由の種類を出さず、総称の文言にする）。 */
  diagnoser?: JsonDiagnoser
  /** 外のアプリとの間（外の変更の見張り、テキストで開く。D5）。Tauri の外には無い（項目は押せない）。 */
  external?: ExternalFiles
  /** 翻訳の設定とキー。Tauri の外には無い（Options の項目は押せない）。 */
  translation?: TranslationPorts
  getStartup(): Promise<Startup>
  subscribe(onEvent: (event: ShellEvent) => void): Promise<void>
  /** 窓を出す合図。起動時に開くファイルはこの後に届く。 */
  ready(): Promise<void>
  /** 選ばれたファイルは `Open` で届く。 */
  pickOpen(): Promise<void>
  /** 保存先を選ぶ。取り消しは `null`。 */
  pickSave(suggested: string | null): Promise<string | null>
  ask(request: AskRequest): Promise<number>
  /** `ask` にチェックボックスを添えた物。Esc と×は `cancel` の添字になる。 */
  askChecked(request: CheckedAskRequest): Promise<CheckedAnswer>
  /** 印とタイトルを渡す。打鍵のたびに呼ぶので、待たない。 */
  setDocumentState(report: DocumentReport): void
  saveFinished(id: number, ok: boolean, report: DocumentReport): void
  /** 開く途中で未保存を見つけた。Rust が確認し、結果は `Open` で届く。 */
  requestOpen(path: string, report: DocumentReport): void
  /** 設定ファイルを読み直した一覧。 */
  recentList(): Promise<string[]>
  /** 許可は Rust が一覧と比べて決める。開くなら `Open` で届く。 */
  openRecent(path: string): Promise<void>
  forgetRecent(path: string): Promise<void>
  clearRecent(): Promise<void>
  setTheme(theme: Theme): Promise<void>
  setLanguage(language: string): Promise<void>
  /** 起動セレモニーの旗を保存する。`unlock` は Options に項目を出す印も保存する。 */
  setSplashCeremony(enabled: boolean, unlock: boolean): Promise<void>
  /** 右端で折り返すかを保存する。 */
  setWrapLines(wrap: boolean): Promise<void>
  /** ツリー表示のときは左ペインを出さないかを保存する。 */
  setHideTargetsInTree(hide: boolean): Promise<void>
  exit(): void
}

export function createTauriPorts(): ShellPorts {
  const backend = createTauriBackend()
  return {
    backend,
    scanner: backend,
    diagnoser: backend,
    external: backend,
    translation: {
      settings: () => invoke<TranslationSettings>('translation_settings'),
      saveSettings: (choice) => invoke('set_translation_settings', { ...choice }),
      saveConfirm: (confirm) => invoke('set_translation_confirm', { confirm }),
      saveMachineNotice: (shown) => invoke('set_translation_machine_notice', { shown }),
      saveKey: (tier, key) => invoke('set_translation_key', { tier, key }),
      clearKey: (tier) => invoke('clear_translation_key', { tier }),
      moveKey: (tier) => invoke('move_translation_key', { tier }),
      start(items, target, tier, onEvent) {
        const channel = new Channel<TranslateEvent>()
        channel.onmessage = onEvent
        return invoke<number>('translate_start', { items, target, tier, channel })
      },
      cancel: (job) => invoke<boolean>('translate_cancel', { job })
    },
    getStartup: () => invoke<Startup>('get_startup'),
    subscribe(onEvent) {
      const channel = new Channel<ShellEvent>()
      channel.onmessage = onEvent
      return invoke('shell_subscribe', { channel })
    },
    ready: () => invoke('app_ready'),
    pickOpen: () => invoke('pick_open'),
    pickSave: (suggested) => invoke<string | null>('pick_save', { suggested }),
    ask: (request) => invoke<number>('ask', { request }),
    askChecked: (request) => invoke<CheckedAnswer>('ask_checked', { request }),
    setDocumentState(report) {
      void invoke('set_document_state', { report })
    },
    saveFinished(id, ok, report) {
      void invoke('save_finished', { id, ok, report })
    },
    requestOpen(path, report) {
      void invoke('request_open', { path, report })
    },
    recentList: () => invoke<string[]>('recent_list'),
    openRecent: (path) => invoke('open_recent', { path }),
    forgetRecent: (path) => invoke('forget_recent', { path }),
    clearRecent: () => invoke('clear_recent'),
    setTheme: (theme) => invoke('set_theme', { theme }),
    setLanguage: (language) => invoke('set_language', { language }),
    setSplashCeremony: (enabled, unlock) => invoke('set_splash_ceremony', { enabled, unlock }),
    setWrapLines: (wrap) => invoke('set_wrap_lines', { wrap }),
    setHideTargetsInTree: (hide) => invoke('set_hide_targets_in_tree', { hide }),
    exit() {
      void invoke('exit_app')
    }
  }
}

const NO_FILE_ACCESS = 'file access needs the desktop shell'

/** Tauri の外（開発サーバ、配布物の表示の試験）で殻を立てる。ファイルには触れない。 */
export function createDetachedPorts(): ShellPorts {
  return {
    backend: {
      open: () => Promise.reject(new Error(NO_FILE_ACCESS)),
      commitOpen: () => Promise.reject(new Error(NO_FILE_ACCESS)),
      save: () => Promise.reject(new Error(NO_FILE_ACCESS)),
      saveBaselineAs: () => Promise.reject(new Error(NO_FILE_ACCESS))
    },
    getStartup: () => Promise.resolve({ version: '', theme: 'light', language: 'en', recent: [], splashCeremony: false, splashCeremonyUnlocked: false, wrapLines: false, hideTargetsInTree: false, translationEnabled: false }),
    subscribe: () => Promise.resolve(),
    ready: () => Promise.resolve(),
    pickOpen: () => Promise.resolve(),
    pickSave: () => Promise.resolve(null),
    ask: (request) => Promise.resolve(request.cancel),
    askChecked: (request) => Promise.resolve({ button: request.cancel, checked: false }),
    setDocumentState: () => {},
    saveFinished: () => {},
    requestOpen: () => {},
    recentList: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(),
    forgetRecent: () => Promise.resolve(),
    clearRecent: () => Promise.resolve(),
    setTheme: () => Promise.resolve(),
    setLanguage: () => Promise.resolve(),
    setSplashCeremony: () => Promise.resolve(),
    setWrapLines: () => Promise.resolve(),
    setHideTargetsInTree: () => Promise.resolve(),
    exit: () => {}
  }
}
