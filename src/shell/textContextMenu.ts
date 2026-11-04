import { selectAll } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { t } from '../i18n'
import { createPopupElement, moveFocus, placePopup } from './menu'
import type { MenuEntry } from './menuModel'

/** テキストの表示の本文。検索ボックスや CodeMirror のパネルの入力欄は含めない。 */
const TEXT_CONTENT = '.cm-content'
const EDITOR_ROOT = '.cm-editor'
/** 1 点の大きさのアンカー。右クリックの位置から出す。 */
const ANCHOR_SIZE_PX = 0

export type TextAction = 'cut' | 'copy' | 'paste' | 'selectAll'
type Action = TextAction

interface ActionEntry extends MenuEntry {
  action: Action
}

/** 主のエディタのテキストの表示の CodeMirror。入れ子の値のモーダルの中の物は含めない。 */
export function mainTextView(host: HTMLElement): EditorView | null {
  const root = host.querySelector<HTMLElement>(`:scope > .jse-main ${EDITOR_ROOT}`)
  return root ? EditorView.findFromDOM(root) : null
}

/** 右クリックのメニューと同じ判定で、その操作を押せるか。 */
export function textActionEnabled(view: EditorView, action: TextAction): boolean {
  return entriesFor(view).find((entry) => entry.action === action)?.enabled ?? false
}

/** 右クリックのメニューと同じ操作（Edit メニューから使う）。 */
export function runTextAction(view: EditorView, action: TextAction): Promise<void> {
  return run(view, action)
}

function selectedText(view: EditorView): string {
  const { state } = view
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak)
}

function entriesFor(view: EditorView): ActionEntry[] {
  const hasSelection = view.state.selection.ranges.some((range) => !range.empty)
  const editable = !view.state.readOnly
  const make = (action: Action, label: string, shortcut: string, enabled: boolean): ActionEntry => ({
    action,
    label,
    shortcut,
    role: 'menuitem',
    enabled
  })
  return [
    make('cut', t('editor.cut'), 'Ctrl+X', hasSelection && editable),
    make('copy', t('editor.copy'), 'Ctrl+C', hasSelection),
    make('paste', t('editor.paste'), 'Ctrl+V', editable),
    make('selectAll', t('app.context.selectAll'), 'Ctrl+A', true)
  ]
}

async function run(view: EditorView, action: Action): Promise<void> {
  if (action === 'selectAll') {
    selectAll(view)
    return
  }
  if (action === 'paste') {
    // 権限の確認は WebView 側で通してある。読めないときは何もしない
    const asked = view.state.doc
    const text = await navigator.clipboard.readText().catch(() => undefined)
    // 待つ間に文書が替わったとき（別のファイルを開いた、打鍵した）は、古い選択へ貼らない
    if (text !== undefined && view.state.doc === asked) {
      view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true, userEvent: 'input.paste' })
    }
    return
  }
  const text = selectedText(view)
  if (text === '') {
    return
  }
  await navigator.clipboard.writeText(text).catch(() => undefined)
  if (action === 'cut') {
    view.dispatch({ ...view.state.replaceSelection(''), scrollIntoView: true, userEvent: 'delete.cut' })
  }
}

/** テキストの表示の右クリックのメニュー。既定の右クリックを止めてあるので自前で出す。 */
export function installTextContextMenu(host: HTMLElement): () => void {
  let popup: HTMLElement | undefined

  function close(): void {
    popup?.remove()
    popup = undefined
  }

  function handleContextMenu(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof Element) || target.closest(TEXT_CONTENT) === null) {
      return
    }
    const root = target.closest<HTMLElement>(EDITOR_ROOT)
    const view = root ? EditorView.findFromDOM(root) : null
    if (!view) {
      return
    }
    event.preventDefault()
    close()
    const shown = createPopupElement(entriesFor(view), (entry) => {
      close()
      view.focus()
      void run(view, (entry as ActionEntry).action)
    })
    shown.setAttribute('role', 'menu')
    shown.classList.add('app-text-context-menu')
    shown.addEventListener('keydown', (key) => {
      if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
        moveFocus(shown, key.key === 'ArrowDown' ? 1 : -1)
      } else if (key.key === 'Escape') {
        close()
        view.focus()
      } else {
        return
      }
      key.preventDefault()
      key.stopPropagation()
    })
    document.body.appendChild(shown)
    popup = shown
    placePopup(
      shown,
      new DOMRect(event.clientX, event.clientY, ANCHOR_SIZE_PX, ANCHOR_SIZE_PX),
      false
    )
    moveFocus(shown, 1)
  }

  function handleOutsidePointer(event: PointerEvent): void {
    if (popup && !popup.contains(event.target as Node)) {
      close()
    }
  }

  host.addEventListener('contextmenu', handleContextMenu)
  window.addEventListener('pointerdown', handleOutsidePointer, true)
  window.addEventListener('blur', close)
  return () => {
    close()
    host.removeEventListener('contextmenu', handleContextMenu)
    window.removeEventListener('pointerdown', handleOutsidePointer, true)
    window.removeEventListener('blur', close)
  }
}
