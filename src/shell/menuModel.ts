import { t } from '../i18n'

export type Theme = 'light' | 'dark'

export const LANGUAGES = ['ja', 'en'] as const

export type MenuCommand =
  | 'open'
  | 'save'
  | 'saveAs'
  | 'exit'
  | 'about'
  | 'clearRecent'
  | 'language:ja'
  | 'language:en'
  | 'theme:dark'
  | 'theme:light'
  | 'splashCeremony'
  | 'wrapLines'
  | `recent:${string}`

export interface MenuState {
  language: string
  theme: Theme
  recent: string[]
  splashCeremony: boolean
  /** 隠しコマンドが成功済みのとき、Options に起動セレモニーの項目を出す。 */
  splashCeremonyUnlocked: boolean
  /** 右端で折り返す。表示だけの設定。 */
  wrapLines: boolean
}

export interface MenuEntry {
  /** 実行できない入口は `undefined`。 */
  command?: MenuCommand
  label: string
  accessKey?: string
  role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  enabled: boolean
  checked?: boolean
  shortcut?: string
  children?: MenuEntry[]
}

export interface MenuGroup {
  label: string
  accessKey?: string
  entries: MenuEntry[]
}

const ACCESS_MARK = /&(.)/

/** `ファイル(&F)` を、表示の文字とアクセスキーへ分ける。 */
export function splitAccessKey(label: string): { label: string; accessKey?: string } {
  const match = ACCESS_MARK.exec(label)
  return match
    ? { label: label.replace(ACCESS_MARK, '$1'), accessKey: match[1].toUpperCase() }
    : { label }
}

function entry(key: string, fields: Partial<MenuEntry> = {}): MenuEntry {
  return { ...splitAccessKey(t(key)), role: 'menuitem', enabled: true, ...fields }
}

function radio(key: string, command: MenuCommand, checked: boolean): MenuEntry {
  return entry(key, { command, role: 'menuitemradio', checked })
}

/** 項目はパスそのもの。パスの `&` をアクセスキーとして読まない。 */
function recentEntries(recent: string[]): MenuEntry[] {
  const files: MenuEntry[] = recent.map((path) => ({
    command: `recent:${path}`,
    label: path,
    role: 'menuitem',
    enabled: true
  }))
  const empty = recent.length === 0
  return [
    ...(empty ? [entry('app.menu.recentEmpty', { enabled: false })] : files),
    entry('app.menu.recentClear', { command: 'clearRecent', enabled: !empty })
  ]
}

export function buildMenus({
  language,
  theme,
  recent,
  splashCeremony,
  splashCeremonyUnlocked,
  wrapLines
}: MenuState): MenuGroup[] {
  return [
    {
      ...splitAccessKey(t('app.menu.file')),
      entries: [
        entry('app.menu.open', { command: 'open', shortcut: 'Ctrl+O' }),
        entry('app.menu.openRecent', { children: recentEntries(recent) }),
        entry('app.menu.save', { command: 'save', shortcut: 'Ctrl+S' }),
        entry('app.menu.saveAs', { command: 'saveAs', shortcut: 'Ctrl+Shift+S' }),
        entry('app.menu.exit', { command: 'exit' })
      ]
    },
    {
      ...splitAccessKey(t('app.menu.options')),
      entries: [
        entry('app.menu.language', {
          children: LANGUAGES.map((code) =>
            radio(`app.menu.language.${code}`, `language:${code}`, language === code)
          )
        }),
        radio('app.menu.dark', 'theme:dark', theme === 'dark'),
        radio('app.menu.light', 'theme:light', theme === 'light'),
        entry('app.menu.wrapLines', { command: 'wrapLines', role: 'menuitemcheckbox', checked: wrapLines }),
        ...(splashCeremonyUnlocked
          ? [entry('app.menu.splashCeremony', { command: 'splashCeremony', role: 'menuitemcheckbox', checked: splashCeremony })]
          : [])
      ]
    },
    {
      ...splitAccessKey(t('app.menu.help')),
      entries: [entry('app.menu.about', { command: 'about' })]
    }
  ]
}
