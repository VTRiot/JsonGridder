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
  | 'hideTargetsInTree'
  | 'translationSettings'
  | EditMenuCommand
  | `recent:${string}`

/** Edit メニューの命令。`openInTextEditor` は Windows の既定のテキストエディタで開く（D5）。 */
export const EDIT_MENU_COMMANDS = ['undo', 'redo', 'cut', 'copy', 'paste', 'findReplace', 'openInTextEditor'] as const
export type EditMenuCommand = (typeof EDIT_MENU_COMMANDS)[number]

export function isEditMenuCommand(command: MenuCommand): command is EditMenuCommand {
  return (EDIT_MENU_COMMANDS as readonly string[]).includes(command)
}

/** Edit メニューの項目を押せるか。メニューを開くときの今の状態。 */
export type EditMenuState = Record<EditMenuCommand, boolean>

export interface MenuState {
  language: string
  theme: Theme
  recent: string[]
  splashCeremony: boolean
  /** 隠しコマンドが成功済みのとき、Options に起動セレモニーの項目を出す。 */
  splashCeremonyUnlocked: boolean
  /** 右端で折り返す。表示だけの設定。 */
  wrapLines: boolean
  /** ツリー表示のときは左ペインを出さない（D13）。表示だけの設定。 */
  hideTargetsInTree: boolean
  /** 翻訳の設定の項目を押せるか（Tauri の外には設定の口が無い）。 */
  translationSettings: boolean
  /** Edit メニューの項目を押せるか。 */
  edit: EditMenuState
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
  /** 項目の前に区切りの線を引く。 */
  separatorBefore?: boolean
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
  wrapLines,
  hideTargetsInTree,
  translationSettings,
  edit
}: MenuState): MenuGroup[] {
  const editEntry = (key: string, command: EditMenuCommand, shortcut?: string, separatorBefore = false): MenuEntry =>
    entry(key, {
      command,
      enabled: edit[command],
      ...(shortcut !== undefined ? { shortcut } : {}),
      ...(separatorBefore ? { separatorBefore } : {})
    })
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
      // キーの案内は今の表示の右クリックとキーと同じ（上流のキーの扱い）
      ...splitAccessKey(t('app.menu.edit')),
      entries: [
        editEntry('app.menu.undo', 'undo', 'Ctrl+Z'),
        editEntry('app.menu.redo', 'redo', 'Ctrl+Shift+Z'),
        editEntry('app.menu.cut', 'cut', 'Ctrl+X', true),
        editEntry('app.menu.copy', 'copy', 'Ctrl+C'),
        editEntry('app.menu.paste', 'paste', 'Ctrl+V'),
        editEntry('app.menu.findReplace', 'findReplace', 'Ctrl+H', true),
        // キーは割り当てない（上流にも殻にも無い命令）
        editEntry('app.menu.openInTextEditor', 'openInTextEditor', undefined, true)
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
        entry('app.menu.hideTargetsInTree', {
          command: 'hideTargetsInTree',
          role: 'menuitemcheckbox',
          checked: hideTargetsInTree
        }),
        ...(splashCeremonyUnlocked
          ? [entry('app.menu.splashCeremony', { command: 'splashCeremony', role: 'menuitemcheckbox', checked: splashCeremony })]
          : []),
        // 翻訳の設定のダイアログを開く。通信はしない（設定とキーを読み書きするだけ）
        entry('app.menu.translationSettings', {
          command: 'translationSettings',
          enabled: translationSettings,
          separatorBefore: true
        })
      ]
    },
    {
      ...splitAccessKey(t('app.menu.help')),
      entries: [entry('app.menu.about', { command: 'about' })]
    }
  ]
}
