import './targetBar.css'
import { isEqual } from 'lodash-es'
import { getIn, isJSONArray, isJSONObject, type JSONPath } from 'immutable-json-patch'
import { Mode } from '$lib/types'
import { stringifyJSONPath } from '$lib/utils/pathUtils'
import { format, t } from '../i18n'
import { createPopupElement, moveFocus, placePopup } from './menu'
import type { MenuEntry } from './menuModel'
import { findTableTargets, type DocumentView } from './tableTargets'

/** 候補の上限。上流の案内の画面と同じ。 */
const MAX_TARGETS = 99

export interface TargetBarOptions {
  view(): DocumentView
  /** 今の文書。読めないときは undefined。 */
  document(): unknown
  onPick(path: JSONPath): void
  onDismiss(): void
}

export interface TargetBar {
  refresh(): void
  destroy(): void
}

function pathLabel(path: JSONPath): string {
  return path.length === 0 ? t('app.target.whole') : stringifyJSONPath(path)
}

/** 表の表示のときだけ、エディタの上に今の対象を出す。候補は開くたびに今の文書から作る。 */
export function createTargetBar(host: HTMLElement, options: TargetBarOptions): TargetBar {
  const bar = document.createElement('div')
  bar.className = 'app-targetbar'
  bar.hidden = true
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'app-targetbar-button'
  button.setAttribute('aria-haspopup', 'menu')
  bar.appendChild(button)
  host.appendChild(bar)

  let popup: HTMLElement | undefined

  function close(): void {
    popup?.remove()
    popup = undefined
    button.removeAttribute('aria-expanded')
  }

  function entries(json: unknown, current: JSONPath): (MenuEntry & { path: JSONPath })[] {
    const toEntry = (path: JSONPath, label: string) => ({
      path,
      label,
      role: 'menuitemradio' as const,
      enabled: true,
      checked: isEqual(path, current)
    })
    return [
      ...findTableTargets(json)
        .slice(0, MAX_TARGETS)
        .map(({ path, rows }) =>
          toEntry(path, format('app.target.item', { path: pathLabel(path), count: String(rows) }))
        ),
      toEntry([], t('app.target.whole'))
    ]
  }

  function open(): void {
    close()
    const items = entries(options.document(), options.view().tableTarget)
    popup = createPopupElement(items, (entry) => {
      close()
      options.onPick((entry as (typeof items)[number]).path)
    })
    popup.setAttribute('aria-label', t('app.target.choose'))
    popup.addEventListener('keydown', handleKey)
    bar.appendChild(popup)
    placePopup(popup, button.getBoundingClientRect(), false)
    button.setAttribute('aria-expanded', 'true')
    moveFocus(popup, 1)
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      moveFocus(popup as HTMLElement, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Escape') {
      close()
      options.onDismiss()
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function handleOutsidePointer(event: PointerEvent): void {
    if (popup && !bar.contains(event.target as Node)) {
      close()
    }
  }

  button.addEventListener('click', () => (popup ? close() : open()))
  window.addEventListener('pointerdown', handleOutsidePointer, true)

  return {
    refresh() {
      const { mode, tableTarget } = options.view()
      const json = mode === Mode.table ? options.document() : undefined
      const shown =
        tableTarget.length > 0
          ? mode === Mode.table
          : isJSONObject(json) && findTableTargets(json).length > 0
      bar.hidden = !shown
      if (!shown) {
        close()
        return
      }
      const rows = tableTarget.length > 0 ? getIn(json, tableTarget) : json
      button.textContent = `${format('app.target.label', {
        path: pathLabel(tableTarget),
        count: String(isJSONArray(rows) ? rows.length : 0)
      })} ▾`
      button.title = t('app.target.choose')
    },
    destroy() {
      window.removeEventListener('pointerdown', handleOutsidePointer, true)
      bar.remove()
    }
  }
}
