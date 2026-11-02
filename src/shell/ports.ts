import { Channel, invoke } from '@tauri-apps/api/core'
import { createTauriBackend, type FileBackend, type JsonScanner } from '../document/backend'
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
}

export interface ShellPorts {
  backend: FileBackend
  /** 開くときと同じ検査。Tauri の外には無い。 */
  scanner?: JsonScanner
  getStartup(): Promise<Startup>
  subscribe(onEvent: (event: ShellEvent) => void): Promise<void>
  /** 窓を出す合図。起動時に開くファイルはこの後に届く。 */
  ready(): Promise<void>
  /** 選ばれたファイルは `Open` で届く。 */
  pickOpen(): Promise<void>
  /** 保存先を選ぶ。取り消しは `null`。 */
  pickSave(suggested: string | null): Promise<string | null>
  ask(request: AskRequest): Promise<number>
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
  exit(): void
}

export function createTauriPorts(): ShellPorts {
  const backend = createTauriBackend()
  return {
    backend,
    scanner: backend,
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
    getStartup: () => Promise.resolve({ version: '', theme: 'light', language: 'en', recent: [], splashCeremony: false, splashCeremonyUnlocked: false, wrapLines: false }),
    subscribe: () => Promise.resolve(),
    ready: () => Promise.resolve(),
    pickOpen: () => Promise.resolve(),
    pickSave: () => Promise.resolve(null),
    ask: (request) => Promise.resolve(request.cancel),
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
    exit: () => {}
  }
}
