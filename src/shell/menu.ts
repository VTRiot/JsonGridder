import './menu.css'
import type { MenuCommand, MenuEntry, MenuGroup } from './menuModel'
import { PETAL_CLASS } from './secretClicks'

const POPUP_EDGE_MARGIN_PX = 4

export interface MenuBarOptions {
  build(): MenuGroup[]
  onCommand(command: MenuCommand): void
  /** メニューが閉じて、エディタへ戻すとき。 */
  onDismiss(): void
}

export interface MenuBar {
  render(): void
  /** Alt 単独と F10。閉じていればメニューバーへ入り、入っていれば出る。 */
  toggleFocus(): void
  /** Alt+F など。当たるメニューがあれば開いて true。 */
  openByAccessKey(key: string): boolean
  destroy(): void
}

/** 項目の並びの DOM。メニューと表の対象の両方が使う。 */
export function createPopupElement(
  entries: MenuEntry[],
  onActivate: (entry: MenuEntry, element: HTMLElement) => void,
  onHover: (entry: MenuEntry, element: HTMLElement) => void = () => {}
): HTMLElement {
  const popup = document.createElement('div')
  popup.className = 'app-menu-popup'
  popup.setAttribute('role', 'menu')

  for (const entry of entries) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'app-menu-item'
    item.tabIndex = -1
    item.setAttribute('role', entry.role)
    item.setAttribute('aria-disabled', String(!entry.enabled))
    if (entry.role === 'menuitemradio' || entry.role === 'menuitemcheckbox') {
      item.setAttribute('aria-checked', String(entry.checked === true))
    }
    if (entry.children) {
      item.setAttribute('aria-haspopup', 'menu')
    }
    const label = document.createElement('span')
    label.className = 'app-menu-label'
    label.textContent = entry.label
    const trailing = document.createElement('span')
    trailing.className = 'app-menu-shortcut'
    trailing.textContent = entry.shortcut ?? (entry.children ? '▸' : '')
    item.append(label, trailing)
    item.addEventListener('click', () => onActivate(entry, item))
    item.addEventListener('pointerenter', () => onHover(entry, item))
    popup.appendChild(item)
  }
  return popup
}

/** 窓の中に収める。右端で左へ開き、高さは CSS の max-height で抑える。 */
export function placePopup(popup: HTMLElement, anchor: DOMRect, beside: boolean): void {
  popup.style.left = `${beside ? anchor.right : anchor.left}px`
  popup.style.top = `${beside ? anchor.top : anchor.bottom}px`
  const width = popup.getBoundingClientRect().width
  const left = beside && anchor.right + width > window.innerWidth ? anchor.left - width : popup.getBoundingClientRect().left
  popup.style.left = `${Math.max(POPUP_EDGE_MARGIN_PX, Math.min(left, window.innerWidth - width - POPUP_EDGE_MARGIN_PX))}px`
}

function enabledItems(popup: HTMLElement): HTMLElement[] {
  return [...popup.querySelectorAll<HTMLElement>('.app-menu-item[aria-disabled="false"]')]
}

/** 開いた項目の間でフォーカスを動かす。端で反対へ回る。 */
export function moveFocus(popup: HTMLElement, step: number): void {
  const items = enabledItems(popup)
  if (items.length === 0) {
    return
  }
  const index = items.indexOf(document.activeElement as HTMLElement)
  const next = index === -1 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length
  items[next].focus()
}

const SVG_NS = 'http://www.w3.org/2000/svg'
/** 桜の花びら 1 枚（上に切れ込み）。16px の枠。 */
const PETAL_PATH = 'M8 14.5C4 12 2.5 8 4 4.2C5 2.2 7 2 8 3.6C9 2 11 2.2 12 4.2C13.5 8 12 12 8 14.5Z'

/** 隠しコマンドの的。ラベルも tab の到達も無い飾り。押下でフォーカスを奪わない。 */
function createPetal(): HTMLElement {
  const petal = document.createElement('span')
  petal.className = PETAL_CLASS
  petal.setAttribute('aria-hidden', 'true')
  petal.addEventListener('mousedown', (event) => event.preventDefault())
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', PETAL_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  petal.appendChild(svg)
  return petal
}

export function createMenuBar(host: HTMLElement, options: MenuBarOptions): MenuBar {
  const bar = document.createElement('div')
  bar.className = 'app-menubar'
  bar.setAttribute('role', 'menubar')
  host.appendChild(bar)

  let openGroup = -1
  let popup: HTMLElement | undefined
  let subPopup: HTMLElement | undefined
  let subOwner: HTMLElement | undefined

  function buttons(): HTMLElement[] {
    return [...bar.querySelectorAll<HTMLElement>('.app-menubar-button')]
  }

  function closeSub(): void {
    subPopup?.remove()
    subPopup = undefined
    subOwner?.removeAttribute('aria-expanded')
    subOwner = undefined
  }

  function closePopup(): void {
    closeSub()
    popup?.remove()
    popup = undefined
    openGroup = -1
    for (const button of buttons()) {
      button.removeAttribute('aria-expanded')
    }
  }

  function dismiss(): void {
    closePopup()
    options.onDismiss()
  }

  function activate(entry: MenuEntry, element: HTMLElement): void {
    if (!entry.enabled) {
      return
    }
    if (entry.children) {
      openSub(entry, element, true)
      return
    }
    closePopup()
    options.onDismiss()
    if (entry.command) {
      options.onCommand(entry.command)
    }
  }

  function openSub(entry: MenuEntry, owner: HTMLElement, focus: boolean): void {
    closeSub()
    subOwner = owner
    owner.setAttribute('aria-expanded', 'true')
    subPopup = createPopupElement(entry.children as MenuEntry[], activate)
    bar.appendChild(subPopup)
    placePopup(subPopup, owner.getBoundingClientRect(), true)
    if (focus) {
      moveFocus(subPopup, 1)
    }
  }

  function hover(entry: MenuEntry, element: HTMLElement): void {
    if (element === subOwner) {
      return
    }
    closeSub()
    if (entry.children && entry.enabled) {
      openSub(entry, element, false)
    }
  }

  function openPopup(index: number, focusFirst: boolean): void {
    closePopup()
    const group = options.build()[index]
    const button = buttons()[index]
    openGroup = index
    button.setAttribute('aria-expanded', 'true')
    popup = createPopupElement(group.entries, activate, hover)
    bar.appendChild(popup)
    placePopup(popup, button.getBoundingClientRect(), false)
    if (focusFirst) {
      moveFocus(popup, 1)
    } else {
      button.focus()
    }
  }

  function moveGroup(step: number): void {
    const count = buttons().length
    const current = openGroup !== -1 ? openGroup : buttons().indexOf(document.activeElement as HTMLElement)
    const next = (current + step + count) % count
    if (popup) {
      openPopup(next, true)
    } else {
      buttons()[next].focus()
    }
  }

  function entryOfFocus(activePopup: HTMLElement): HTMLElement | undefined {
    const active = document.activeElement as HTMLElement
    return activePopup.contains(active) ? active : undefined
  }

  function pressFocused(): void {
    ;(document.activeElement as HTMLElement).click()
  }

  function handleKey(event: KeyboardEvent): void {
    const inSub = subPopup?.contains(document.activeElement) === true
    const active = inSub ? subPopup : popup
    switch (event.key) {
      case 'Escape':
        if (inSub) {
          const owner = subOwner
          closeSub()
          owner?.focus()
        } else {
          dismiss()
        }
        break
      case 'ArrowDown':
        if (active) {
          moveFocus(active, 1)
        } else if (buttons().includes(document.activeElement as HTMLElement)) {
          openPopup(buttons().indexOf(document.activeElement as HTMLElement), true)
        }
        break
      case 'ArrowUp':
        if (active) {
          moveFocus(active, -1)
        }
        break
      case 'ArrowRight': {
        const item = active && entryOfFocus(active)
        if (!inSub && item?.getAttribute('aria-haspopup') === 'menu') {
          item.click()
        } else {
          closeSub()
          moveGroup(1)
        }
        break
      }
      case 'ArrowLeft':
        if (inSub) {
          const owner = subOwner
          closeSub()
          owner?.focus()
        } else {
          moveGroup(-1)
        }
        break
      case 'Enter':
      case ' ':
        pressFocused()
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function handleOutsidePointer(event: PointerEvent): void {
    if (openGroup !== -1 && !bar.contains(event.target as Node)) {
      closePopup()
    }
  }

  bar.addEventListener('keydown', handleKey)
  window.addEventListener('pointerdown', handleOutsidePointer, true)

  function render(): void {
    closePopup()
    bar.replaceChildren()
    options.build().forEach((group, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'app-menubar-button'
      button.tabIndex = -1
      button.textContent = group.label
      button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-haspopup', 'menu')
      button.addEventListener('click', () => {
        if (openGroup === index) {
          dismiss()
        } else {
          openPopup(index, false)
        }
      })
      button.addEventListener('pointerenter', () => {
        if (openGroup !== -1 && openGroup !== index) {
          openPopup(index, false)
        }
      })
      bar.appendChild(button)
    })
    bar.appendChild(createPetal())
  }

  render()

  return {
    render,
    toggleFocus() {
      if (openGroup !== -1 || bar.contains(document.activeElement)) {
        dismiss()
      } else {
        buttons()[0]?.focus()
      }
    },
    openByAccessKey(key) {
      const index = options.build().findIndex((group) => group.accessKey === key.toUpperCase())
      if (index === -1) {
        return false
      }
      openPopup(index, true)
      return true
    },
    destroy() {
      window.removeEventListener('pointerdown', handleOutsidePointer, true)
      bar.remove()
    }
  }
}
