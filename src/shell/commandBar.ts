import './commandBar.css'
import { faSquareMinus, faSquarePlus } from '@fortawesome/free-regular-svg-icons'
import {
  faArrowDownWideShort,
  faFilter,
  faMagnifyingGlass,
  faRotateLeft,
  faRotateRight
} from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import type { MenuButton, MenuItem, OnRenderMenu } from '$lib/types'
import { t } from '../i18n'
import { createIcon } from './icons'

export type CommandName = 'undo' | 'redo' | 'search' | 'sort' | 'transform' | 'expandAll' | 'collapseAll'

interface CommandSpec {
  name: CommandName
  /** 上流のメニューの項目の印のクラス（TreeMenu、TableMenu、TextMenu）。 */
  className: string
  labelKey: string
  icon: IconDefinition
}

/** コマンドの行の並び。群の間に区切りを置く（見本の絵 A〜D の並び）。 */
const COMMAND_GROUPS: readonly (readonly CommandSpec[])[] = [
  [
    { name: 'undo', className: 'jse-undo', labelKey: 'app.command.undo', icon: faRotateLeft },
    { name: 'redo', className: 'jse-redo', labelKey: 'app.command.redo', icon: faRotateRight }
  ],
  [
    { name: 'search', className: 'jse-search', labelKey: 'app.command.search', icon: faMagnifyingGlass },
    { name: 'sort', className: 'jse-sort', labelKey: 'app.command.sort', icon: faArrowDownWideShort },
    { name: 'transform', className: 'jse-transform', labelKey: 'app.command.transform', icon: faFilter }
  ],
  [
    { name: 'expandAll', className: 'jse-expand-all', labelKey: 'app.command.expandAll', icon: faSquarePlus },
    { name: 'collapseAll', className: 'jse-collapse-all', labelKey: 'app.command.collapseAll', icon: faSquareMinus }
  ]
]

const COMMANDS: readonly CommandSpec[] = COMMAND_GROUPS.flat()

/**
 * テキストでしか開けない文書（不正な JSON など）では何もしない命令（D12）。上流の項目は押せる状態のままだが、
 * 押しても文書を変えずに理由を出すだけなので、殻では押せない見た目にする。元に戻す、やり直す、検索と置換は効く。
 */
const NOT_FOR_TEXT_ONLY: ReadonlySet<CommandName> = new Set<CommandName>(['sort', 'transform', 'expandAll', 'collapseAll'])

function hasClass(item: MenuItem, className: string): item is MenuButton {
  return item.type === 'button' && (item.className ?? '').split(/\s+/).includes(className)
}

/**
 * 上流のメニューの項目から、コマンドの行の 7 つの命令を拾う。表示に無い命令（表の展開と折りたたみ）は
 * 入らない。テキストの表示の整形、圧縮、修復と、右クリックの入口の項目は拾わない。
 */
export function pickCommands(items: readonly MenuItem[]): Map<CommandName, MenuButton> {
  const picked = new Map<CommandName, MenuButton>()
  for (const { name, className } of COMMANDS) {
    const found = items.find((item) => hasClass(item, className))
    if (found) {
      picked.set(name, found as MenuButton)
    }
  }
  return picked
}

/**
 * 主のエディタのメニュー（正規の設定 `onRenderMenu`）。上流の表示のボタンは殻の切り替え（`modeMenu`）へ、
 * 残りの命令はコマンドの行へ移し、上流の帯には空の並びを返す（帯は CSS で隠す）。
 * Svelte の更新の中で呼ばれるので、殻の DOM だけを替える。入れ子の値のモーダルと変換の画面のエディタは上流のまま。
 */
export function mainMenuRenderer(modeMenu: { onRenderMenu: OnRenderMenu }, bar: CommandBar): OnRenderMenu {
  return (items, context) => {
    const rest = modeMenu.onRenderMenu(items, context)
    if (context.modal) {
      return rest
    }
    bar.update(rest ?? items)
    return []
  }
}

export interface CommandBarOptions {
  /** 入れ子の値のモーダルなどが開いている間は、主のエディタの命令を走らせない。 */
  hasOpenModal(): boolean
}

export interface CommandBar {
  element: HTMLElement
  /**
   * 主のエディタの上流のメニューの項目を受ける（`onRenderMenu` から）。Svelte の更新の中で呼ばれるので、
   * 殻の DOM の書き換えだけを行い、エディタの API を呼ばない。
   */
  update(items: readonly MenuItem[]): void
  /** 今の表示で押せるか（上流の項目の disabled のまま）。 */
  enabled(name: CommandName): boolean
  /** 上流の項目の押下の関数を呼ぶ。押せないとき、モーダルが開いているときは何もせず false。 */
  run(name: CommandName): boolean
  /** 文言を辞書から引き直す。 */
  refresh(): void
  /**
   * 今の文書がテキストでしか開けないか（切り替えの検査が決めた値）。真の間は並べ替え、絞り込みと変換、展開、
   * 折りたたみを押せない（D12）。描画の中から呼ばれるので、殻の DOM だけを替える。
   */
  setTextOnly(textOnly: boolean): void
}

/**
 * メニューの行の下のコマンドの行（元に戻す、やり直す ｜ 検索と置換、並べ替え、絞り込みと変換 ｜ 展開、折りたたみ）。
 * 動作と押せる状態は上流の項目のまま（正規の設定 `onRenderMenu` で受けた項目の `onClick` と `disabled`）。
 */
export function createCommandBar(options: CommandBarOptions): CommandBar {
  const element = document.createElement('div')
  element.className = 'app-command-bar'
  element.setAttribute('role', 'toolbar')

  let current = new Map<CommandName, MenuButton>()
  let textOnly = false

  const buttons = new Map<CommandName, { button: HTMLButtonElement; label: HTMLElement; labelKey: string }>()
  COMMAND_GROUPS.forEach((group, index) => {
    if (index > 0) {
      const separator = document.createElement('span')
      separator.className = 'app-command-separator'
      separator.setAttribute('role', 'separator')
      separator.setAttribute('aria-orientation', 'vertical')
      element.appendChild(separator)
    }
    for (const { name, labelKey, icon } of group) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'app-command-button'
      button.dataset.command = name
      const label = document.createElement('span')
      label.className = 'app-command-label'
      button.append(createIcon(icon), label)
      // 押下でフォーカスを奪わない。命令は今のエディタの選択に効く
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => void run(name))
      element.appendChild(button)
      buttons.set(name, { button, label, labelKey })
    }
  })

  function enabled(name: CommandName): boolean {
    const item = current.get(name)
    return item !== undefined && item.disabled !== true && !(textOnly && NOT_FOR_TEXT_ONLY.has(name))
  }

  function render(): void {
    for (const [name, { button, label }] of buttons) {
      button.setAttribute('aria-disabled', String(!enabled(name)))
      // 上流の title はキーの案内を含む。表示に無い命令は文言だけ
      button.title = current.get(name)?.title ?? label.textContent ?? ''
    }
  }

  function run(name: CommandName): boolean {
    const item = current.get(name)
    if (item === undefined || !enabled(name) || options.hasOpenModal()) {
      return false
    }
    item.onClick(new MouseEvent('click'))
    return true
  }

  function refresh(): void {
    element.setAttribute('aria-label', t('app.command.label'))
    for (const { label, labelKey } of buttons.values()) {
      label.textContent = t(labelKey)
    }
    render()
  }

  refresh()

  return {
    element,
    update(items) {
      current = pickCommands(items)
      render()
    },
    enabled,
    run,
    refresh,
    setTextOnly(next) {
      if (next !== textOnly) {
        textOnly = next
        render()
      }
    }
  }
}
