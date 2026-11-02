// 実物のエディタを jsdom で動かす。DOM の配置を見ない確かめに使う。実キーと実 Chromium の確かめは
// tests/browser にある。
import { flushSync } from 'svelte'
import { stringify } from 'lossless-json'
import { encodeDataPath } from '$lib/utils/domUtils'
import { isTextContent } from '$lib/utils/jsonUtils'
import { Mode, type Content, type JSONEditorPropsOptional } from '$lib/types'
import type { JSONPath } from 'immutable-json-patch'
import type { JsonScanner, ScanResult } from '../../../src/document/backend'
import { mountEditor, type EditorHandle } from '../../../src/editor/mount'
import { editorLanguage } from '../../../src/i18n'

const SCAN_OK: ScanResult = {
  duplicateKey: false,
  numericKeyReorder: false,
  reservedKey: false,
  depthExceeded: false,
  syntaxOk: true
}

/** jsdom に無い口。エディタの描画が呼ぶ。 */
export function installDomStubs(): void {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  })) as unknown as typeof window.matchMedia
  const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  const noRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
  Range.prototype.getClientRects = noRects as unknown as typeof Range.prototype.getClientRects
  Range.prototype.getBoundingClientRect =
    noRect as unknown as typeof Range.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value
    }
  })
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
  Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo
}

/** 結果を止められる検査。 */
export interface HeldScanner extends JsonScanner {
  results: Map<string, ScanResult>
  hold(): void
  release(): void
}

export function createScanner(): HeldScanner {
  const results = new Map<string, ScanResult>()
  let gate: Promise<void> | null = null
  let open: () => void = () => {}
  return {
    results,
    hold() {
      gate = new Promise((resolve) => {
        open = resolve
      })
    },
    release() {
      gate = null
      open()
    },
    async scan(text) {
      if (gate) await gate
      return results.get(text) ?? SCAN_OK
    }
  }
}

export interface Mounted {
  target: HTMLElement
  editor: EditorHandle
  scanner: HeldScanner
  /** `onChange` の回数。 */
  changes: Content[]
  text(): string
  modeLabel(): string
  /** 表のセル。 */
  cell(row: number, ...column: JSONPath): HTMLElement
  /** セルを押して選ぶ。 */
  select(row: number, ...column: JSONPath): void
  press(key: string, modifiers?: KeyboardEventInit): void
  /** 編集欄の中身を替えて確定する。 */
  typeAndEnter(value: string): void
  editors(): number
  notice(): string | null
  banner(): string | null
  clickUndo(): void
  clickRedo(): void
  destroy(): Promise<void>
}

const mounted: Mounted[] = []

export function mountForTest(
  content: Content,
  mode: Mode,
  props: JSONEditorPropsOptional = {}
): Mounted {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const changes: Content[] = []
  const scanner = createScanner()
  const editor = mountEditor(
    target,
    {
      content,
      mode,
      language: editorLanguage(),
      onChange: (updated) => changes.push(updated),
      ...props
    },
    { scanner }
  )
  const contents = () => target.querySelector('.jse-main') as HTMLElement
  const active = () =>
    (target.querySelector('.jse-editable-div') ??
      target.querySelector('.jse-hidden-input')) as HTMLElement

  const result: Mounted = {
    target,
    editor,
    scanner,
    changes,
    text() {
      const current = editor.get()
      return isTextContent(current) ? current.text : String(stringify(current.json))
    },
    modeLabel: () =>
      contents().querySelector('.jse-group-button.jse-selected')?.textContent?.trim() ?? '',
    cell(row, ...column) {
      const path = [String(row), ...column]
      return target.querySelector(`td[data-path="${encodeDataPath(path)}"]`) as HTMLElement
    },
    select(row, ...column) {
      const cell = result.cell(row, ...column)
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
      flushSync()
    },
    press(key, modifiers = {}) {
      active().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
      )
      flushSync()
    },
    typeAndEnter(value) {
      ;(target.querySelector('.jse-editable-div') as HTMLElement).textContent = value
      result.press('Enter')
    },
    editors: () => target.querySelectorAll('.jse-editable-div').length,
    notice: () => target.querySelector('.jse-cell-notice')?.textContent?.trim() ?? null,
    banner() {
      const element = target.querySelector('.app-notice') as HTMLElement
      return element.hidden ? null : element.textContent
    },
    clickUndo() {
      ;(target.querySelector('.jse-undo') as HTMLElement).click()
      flushSync()
    },
    clickRedo() {
      ;(target.querySelector('.jse-redo') as HTMLElement).click()
      flushSync()
    },
    async destroy() {
      await editor.destroy()
      target.remove()
    }
  }
  mounted.push(result)
  return result
}

export async function destroyAll(): Promise<void> {
  for (const item of mounted.splice(0)) {
    await item.destroy()
  }
}
