import type { MenuBar } from './menu'

export interface KeyActions {
  open(): void
  save(): void
  saveAs(): void
}

export interface KeysOptions {
  actions: KeyActions
  menu: MenuBar
  hasOpenModal(): boolean
}

/** キーの受け口は window の capture のここだけ。エディタの中の keydown は外へ出てこない。 */
export function installKeys({ actions, menu, hasOpenModal }: KeysOptions): () => void {
  // Alt を押して、ほかのキーを挟まず離したときだけメニューへ入る。Alt+Tab の誤爆を防ぐ
  let altArmed = false

  function shortcut(event: KeyboardEvent): (() => void) | undefined {
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return undefined
    }
    const key = event.key.toLowerCase()
    if (key === 'o' && !event.shiftKey) return actions.open
    if (key === 's') return event.shiftKey ? actions.saveAs : actions.save
    return undefined
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) {
      altArmed = false
      return
    }
    altArmed = event.key === 'Alt' && !event.repeat

    const action = shortcut(event)
    if (action) {
      event.preventDefault()
      event.stopPropagation()
      action()
      return
    }

    if (hasOpenModal()) {
      return
    }
    if (event.key === 'F10' && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      menu.toggleFocus()
    } else if (event.altKey && !event.ctrlKey && event.key.length === 1 && menu.openByAccessKey(event.key)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function handleKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Alt' && altArmed && !hasOpenModal()) {
      event.preventDefault()
      menu.toggleFocus()
    }
    altArmed = false
  }

  function disarm(): void {
    altArmed = false
  }

  window.addEventListener('keydown', handleKeyDown, true)
  window.addEventListener('keyup', handleKeyUp, true)
  window.addEventListener('blur', disarm)

  return () => {
    window.removeEventListener('keydown', handleKeyDown, true)
    window.removeEventListener('keyup', handleKeyUp, true)
    window.removeEventListener('blur', disarm)
  }
}
