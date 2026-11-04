import type { JSONPath } from 'immutable-json-patch'
import { isValueSelection } from '$lib/logic/selection'
import { decodeDataPath } from '$lib/utils/domUtils'
import { Mode, type ContextMenuItem, type MenuButton, type RenderContextMenuContext } from '$lib/types'
import { t } from '../i18n'
import { createPopupElement, moveFocus, placePopup } from './menu'
import type { MenuEntry } from './menuModel'
import { collectValue } from './translateCollect'
import './translateMenu.css'

/**
 * 翻訳の右クリックの項目。
 *
 * - 表の列の見出し: 上流の見出しの `th` に足した `data-column-path`（vendor CHANGES 28）で列を知る。
 *   主のエディタの見出しの右クリックを捕捉の段階で受け、上流の右クリック（今の選択のメニュー）へ流さず、
 *   殻のメニュー（テキストの表示の右クリックと同じ部品）を出す。
 * - 表のセルとツリーの値: 上流の正規の設定 `onRenderContextMenu` で、上流の項目の後ろに足す。
 *   サブメニューは取り込んだエディタの項目の種類 `submenu`（vendor CHANGES 30）で出す。
 * - 行の右クリックは作らない。
 *
 * 翻訳が無効のとき（殻が持つ値）は、どの項目も出さず、上流の動作のまま。
 *
 * 項目は「日本語に翻訳」の 1 つで、キーのある枠をサブメニューに並べる（F6。「有料」「無料」の順。文字の色を
 * 枠ごとに替え、言葉も残す）。どの枠にもキーが無ければサブメニューの無い項目を 1 つ出し、押すとキーの設定へ
 * 案内する（流れが送らずに設定を開く）。
 */

/** サブメニューの並び（有料、無料）と、枠ごとの項目の名。知らない枠には項目を作らない。 */
const TIER_ORDER = ['paid', 'free'] as const
const TIER_ITEM_KEYS: Record<(typeof TIER_ORDER)[number], string> = {
  paid: 'app.translate.tierPaid',
  free: 'app.translate.tierFree'
}
const PARENT_ITEM_KEY = 'app.translate.toTarget'
/** 枠の色の class（translateMenu.css）。殻のメニューと上流のメニューで同じ物を使う。 */
const TIER_CLASS_PREFIX = 'app-translate-tier-'

/** サブメニューの 1 項目（名と、選んだ枠）。 */
export interface TranslateItemChoice {
  label: string
  tier: string
}

/** キーのある枠からサブメニューの項目を作る（有料、無料の順）。知らない枠は飛ばす。空ならキーの設定への案内。 */
export function translateChoices(tiers: readonly string[]): TranslateItemChoice[] {
  return TIER_ORDER.filter((tier) => tiers.includes(tier)).map((tier) => ({ label: t(TIER_ITEM_KEYS[tier]), tier }))
}

/** 親の項目の名（「日本語に翻訳」）。 */
export function translateParentLabel(): string {
  return t(PARENT_ITEM_KEY)
}

/** 列の見出しのセル（並べ替えのボタンを持つセルだけに属性がある）。 */
const COLUMN_HEADER = 'th[data-column-path]'
/** 主のエディタの根。入れ子の値のモーダルの中の表は含めない。 */
const MAIN_EDITOR = ':scope > .jse-main'
/** 1 点の大きさのアンカー。右クリックの位置から出す。 */
const ANCHOR_SIZE_PX = 0

export interface TranslateMenuOptions {
  /** 主のエディタを置いた要素。 */
  host: HTMLElement
  /** 翻訳の項目を出すか（殻の有効の値と、翻訳先の言語が一覧にあるか）。 */
  enabled(): boolean
  /** エディタのモーダルか殻のダイアログが開いている。 */
  hasOpenModal(): boolean
  mode(): Mode
  tableTarget(): JSONPath
  document(): unknown
  /** キーのある枠（殻が設定を読んだときの値）。 */
  tiers(): readonly string[]
  /** 列から訳す。`column` は表の対象の要素の中のパス。`tier` は選んだ枠（無ければキーの設定への案内）。 */
  onColumn(column: JSONPath, tier: string | undefined): void
  /** 1 つの値を訳す。`path` は文書の中のパス。 */
  onValue(path: JSONPath, tier: string | undefined): void
}

export interface TranslateMenu {
  /** 上流の `onRenderContextMenu` に渡す。 */
  renderContextMenu(items: ContextMenuItem[], context: RenderContextMenuContext): ContextMenuItem[]
  destroy(): void
}

export function createTranslateMenu(options: TranslateMenuOptions): TranslateMenu {
  let popup: HTMLElement | undefined
  let subPopup: HTMLElement | undefined
  let subOwner: HTMLElement | undefined

  function closeSub(focusOwner: boolean): void {
    subPopup?.remove()
    subPopup = undefined
    subOwner?.setAttribute('aria-expanded', 'false')
    if (focusOwner) {
      subOwner?.focus()
    }
    subOwner = undefined
  }

  function close(): void {
    closeSub(false)
    popup?.remove()
    popup = undefined
  }

  function headerColumn(target: EventTarget | null): JSONPath | undefined {
    if (!(target instanceof Element)) {
      return undefined
    }
    const header = target.closest<HTMLElement>(COLUMN_HEADER)
    const main = options.host.querySelector(MAIN_EDITOR)
    const encoded = header?.dataset.columnPath
    if (!header || !main?.contains(header) || encoded === undefined) {
      return undefined
    }
    try {
      return decodeDataPath(encoded)
    } catch {
      return undefined
    }
  }

  /** サブメニューを親の項目の横に開く。開いていれば、求めに応じてフォーカスだけ移す。 */
  function openSub(owner: HTMLElement, choices: TranslateItemChoice[], column: JSONPath, focus: boolean): void {
    if (!subPopup) {
      const entries = new Map<MenuEntry, TranslateItemChoice>(
        choices.map((choice) => [{ label: choice.label, role: 'menuitem', enabled: true }, choice])
      )
      const shown = createPopupElement([...entries.keys()], (entry) => {
        const tier = entries.get(entry)?.tier
        close()
        options.onColumn(column, tier)
      })
      shown.classList.add('app-translate-submenu')
      shown.querySelectorAll<HTMLElement>('.app-menu-item').forEach((item, index) => {
        const tier = choices[index].tier
        item.dataset.tier = tier
        item.classList.add(`${TIER_CLASS_PREFIX}${tier}`)
      })
      shown.addEventListener('keydown', (key) => {
        if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
          moveFocus(shown, key.key === 'ArrowDown' ? 1 : -1)
        } else if (key.key === 'ArrowLeft' || key.key === 'Escape') {
          closeSub(true)
        } else if (key.key !== 'ArrowRight') {
          return
        }
        key.preventDefault()
        key.stopPropagation()
      })
      document.body.appendChild(shown)
      subPopup = shown
      subOwner = owner
      owner.setAttribute('aria-expanded', 'true')
      placePopup(shown, owner.getBoundingClientRect(), true)
    }
    if (focus) {
      moveFocus(subPopup, 1)
    }
  }

  function handleContextMenu(event: MouseEvent): void {
    if (!options.enabled() || options.hasOpenModal() || options.mode() !== Mode.table) {
      return // 上流の動作のまま
    }
    const column = headerColumn(event.target)
    if (column === undefined || column.length === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    close()
    const choices = translateChoices(options.tiers())
    const parent: MenuEntry = {
      label: translateParentLabel(),
      role: 'menuitem',
      enabled: true,
      ...(choices.length > 0 ? { children: [] } : {})
    }
    const shown = createPopupElement(
      [parent],
      (_entry, element) => {
        if (choices.length > 0) {
          openSub(element, choices, column, true)
        } else {
          close()
          options.onColumn(column, undefined) // キーの設定への案内
        }
      },
      (_entry, element) => {
        if (choices.length > 0) {
          openSub(element, choices, column, false)
        }
      }
    )
    shown.classList.add('app-translate-context-menu')
    const parentItem = shown.querySelector<HTMLElement>('.app-menu-item')
    if (parentItem && choices.length > 0) {
      parentItem.setAttribute('aria-expanded', 'false')
    }
    shown.addEventListener('keydown', (key) => {
      if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
        moveFocus(shown, key.key === 'ArrowDown' ? 1 : -1)
      } else if ((key.key === 'ArrowRight' || key.key === 'Enter') && parentItem && choices.length > 0) {
        openSub(parentItem, choices, column, true)
      } else if (key.key === 'Escape') {
        close()
      } else {
        return
      }
      key.preventDefault()
      key.stopPropagation()
    })
    document.body.appendChild(shown)
    popup = shown
    placePopup(shown, new DOMRect(event.clientX, event.clientY, ANCHOR_SIZE_PX, ANCHOR_SIZE_PX), false)
    moveFocus(shown, 1)
  }

  function handleOutsidePointer(event: PointerEvent): void {
    const target = event.target as Node
    if (popup && !popup.contains(target) && !subPopup?.contains(target)) {
      close()
    }
  }

  // 捕捉の段階で受ける（上流の表の右クリックより先）
  options.host.addEventListener('contextmenu', handleContextMenu, true)
  window.addEventListener('pointerdown', handleOutsidePointer, true)
  window.addEventListener('blur', close)

  return {
    renderContextMenu(items, context) {
      if (!options.enabled() || context.modal || context.mode === Mode.text) {
        return items
      }
      const selection = context.selection
      if (selection === undefined || !isValueSelection(selection)) {
        return items
      }
      // 表の選択は表の対象の中のパス。ツリーは文書の中のパス
      const path = context.mode === Mode.table ? [...options.tableTarget(), ...selection.path] : selection.path
      // 送れる値（空白だけでない文字列）のときだけ足す
      if (collectValue(options.document(), path).length === 0) {
        return items
      }
      const choices = translateChoices(options.tiers())
      const item: ContextMenuItem =
        choices.length > 0
          ? {
              type: 'submenu',
              text: translateParentLabel(),
              className: 'app-translate-context-item',
              items: choices.map(
                (choice): MenuButton => ({
                  type: 'button',
                  text: choice.label,
                  className: `app-translate-context-tier ${TIER_CLASS_PREFIX}${choice.tier}`,
                  onClick: () => options.onValue(path, choice.tier)
                })
              )
            }
          : {
              type: 'button',
              text: translateParentLabel(),
              className: `app-translate-context-item ${TIER_CLASS_PREFIX}none`,
              onClick: () => options.onValue(path, undefined) // キーの設定への案内
            }
      return [...items, { type: 'separator' }, item]
    },
    destroy() {
      close()
      options.host.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('pointerdown', handleOutsidePointer, true)
      window.removeEventListener('blur', close)
    }
  }
}
