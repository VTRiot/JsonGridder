// 門番の答えを待つ間の履歴と、切り替えの後の undo の表示。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const MODAL = '.jse-jsoneditor-modal'
const DOC = '[{"n":[5,{"m":[3]}]}]'
const DEBOUNCE_MS = 350 // テキストの遅延より長い
const TEXT = 0
const TABLE = 2

beforeAll(installDomStubs)
afterEach(destroyAll)

const settled = async (ms = 0): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

const inModal = <T extends HTMLElement>(view: Mounted, selector: string) =>
  view.target.querySelector<T>(`${MODAL} ${selector}`)

const button = (view: Mounted, selector: string) =>
  (inModal<HTMLButtonElement>(view, selector) ??
    view.target.querySelector<HTMLButtonElement>(selector)) as HTMLButtonElement

const click = (view: Mounted, selector: string) => {
  button(view, selector).click()
  flushSync()
}

function pressInModal(view: Mounted, key: string): void {
  const active =
    inModal(view, '.jse-editable-div') ?? (inModal(view, '.jse-hidden-input') as HTMLElement)
  active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  flushSync()
}

function cellWith(view: Mounted, text: string): HTMLElement {
  return [...view.target.querySelectorAll<HTMLElement>(`${MODAL} td`)].find((cell) =>
    cell.textContent?.includes(text)
  ) as HTMLElement
}

const down = (element: HTMLElement): void => {
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
  flushSync()
}

function modeInModal(view: Mounted, index: number): void {
  ;(view.target.querySelector(MODAL) as HTMLElement)
    .querySelectorAll<HTMLElement>('.jse-group-button')
    [index].click()
  flushSync()
}

function replaceAll(root: Element, text: string): void {
  const content = root.querySelector('.cm-content') as unknown as {
    cmTile: {
      root: { view: { state: { doc: { length: number } }; dispatch(spec: unknown): void } }
    }
  }
  const editor = content.cmTile.root.view
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
}

/** 2 段目のテキストで打鍵を戻した後の状態。次の undo は表示の項目で、門番を待つ。 */
async function level2WithModeItem(view: Mounted, undoFirstLevel: boolean): Promise<void> {
  view.select(0, 'n')
  view.press('Enter')
  await settled()
  down(cellWith(view, '5'))
  pressInModal(view, 'Delete')
  await settled()
  if (undoFirstLevel) {
    click(view, '.jse-undo')
    await settled()
  }
  down(cellWith(view, '3'))
  pressInModal(view, 'Enter')
  await settled()
  modeInModal(view, TEXT)
  await settled()
  replaceAll(view.target.querySelector(MODAL) as Element, '[1,2,3]')
  await settled(DEBOUNCE_MS)
}

describe('モーダルの段と門番の待ち', () => {
  it('待っている間は戻るも Apply も押せず、Esc も効かない', async () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    await level2WithModeItem(view, true)
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    view.scanner.hold()
    click(view, '.jse-undo')
    await settled()
    expect(button(view, '.jse-actions .jse-secondary').disabled).toBe(true)
    expect(button(view, '.jse-actions .jse-primary').disabled).toBe(true)
    const header = inModal(view, '.jse-actions') as HTMLElement
    header.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    flushSync()
    expect(inModal<HTMLInputElement>(view, '.jse-path')?.value).toContain('m')
    view.scanner.release()
    await settled()
    expect(button(view, '.jse-actions .jse-secondary').disabled).toBe(false)
    expect(button(view, '.jse-actions .jse-primary').disabled).toBe(false)
  })

  it('答えの後に戻って親を undo しても、足していない行が増えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    await level2WithModeItem(view, true)
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    view.scanner.hold()
    click(view, '.jse-undo')
    await settled()
    click(view, '.jse-actions .jse-secondary') // 押せない
    view.scanner.release()
    await settled()
    click(view, '.jse-actions .jse-secondary')
    await settled()
    expect(button(view, '.jse-undo').disabled).toBe(true)
    expect(button(view, '.jse-redo').disabled).toBe(false)
    click(view, '.jse-actions .jse-primary')
    await settled()
    expect(view.text()).toBe(DOC)
  })

  it('redo の待ちの間でも行が消えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    await level2WithModeItem(view, false)
    modeInModal(view, TABLE)
    await settled(DEBOUNCE_MS)
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    view.scanner.hold()
    click(view, '.jse-redo')
    await settled()
    click(view, '.jse-actions .jse-secondary') // 押せない
    view.scanner.release()
    await settled()
    click(view, '.jse-actions .jse-secondary')
    await settled()
    click(view, '.jse-actions .jse-primary')
    await settled()
    expect(view.text()).toBe('[{"n":[{"m":[3]}]}]')
  })
})

describe('待っている間に打つ', () => {
  async function typedDuringRedoCheck(typed: string): Promise<Mounted> {
    const view = mountForTest({ text: '[{"a":1}]' }, Mode.text)
    replaceAll(view.target, '[{"a":2}]')
    view.editor.commitPendingInput()
    await settled()
    clickMode(view, '表')
    await settled()
    click(view, '.jse-undo')
    await settled()
    view.scanner.hold()
    click(view, '.jse-redo')
    replaceAll(view.target, typed)
    view.scanner.release()
    await settled()
    return view
  }

  function clickMode(view: Mounted, label: string): void {
    const element = [...view.target.querySelectorAll<HTMLElement>('.jse-group-button')].find(
      (item) => item.textContent?.trim() === label
    ) as HTMLElement
    element.click()
    flushSync()
  }

  it.each([
    ['長さが違う打鍵', '[{"a":3,"bb":4}]'],
    ['長さが同じ打鍵', '[{"b":7}]']
  ])('%s: 打鍵の項目を undo で戻せ、例外が出ない', async (_, typed) => {
    const view = await typedDuringRedoCheck(typed)
    const errors: string[] = []
    const onError = (event: ErrorEvent) => errors.push(event.message)
    window.addEventListener('error', onError)

    expect(view.text()).toBe(typed)
    expect(button(view, '.jse-redo').disabled).toBe(true)
    const seen: string[] = []
    while (!button(view, '.jse-undo').disabled) {
      click(view, '.jse-undo')
      await settled(DEBOUNCE_MS)
      seen.push(view.text())
    }
    window.removeEventListener('error', onError)
    expect(errors).toEqual([])
    expect(seen).toContain('[{"a":2}]')
    expect(seen[seen.length - 1]).toBe('[{"a":1}]')
    expect(new Set(seen).size).toBeLessThanOrEqual(2)
  })

  it('打鍵の後の文書が過去に無かった形にならない', async () => {
    const view = await typedDuringRedoCheck('[{"b":7}]')
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    expect(view.text()).toBe('[{"a":2}]')
    expect(view.modeLabel()).toBe('テキスト')
  })
})

describe('undo の待ちの間に打つ', () => {
  const FIRST = '[{"a":1},{"a":2},{"a":3}]'

  function clickMode(view: Mounted, label: string): void {
    const element = [...view.target.querySelectorAll<HTMLElement>('.jse-group-button')].find(
      (item) => item.textContent?.trim() === label
    ) as HTMLElement
    element.click()
    flushSync()
  }

  /** 表の削除、テキストへ戻る、打つ、戻す。次の undo は表示の項目で、門番を待つ。 */
  async function typedDuringUndoCheck(view: Mounted, before: string, typed: string): Promise<void> {
    clickMode(view, '表')
    await settled()
    view.editor.patch([{ op: 'remove', path: '/0' }])
    await settled()
    clickMode(view, 'テキスト')
    await settled()
    replaceAll(view.target, before)
    view.editor.commitPendingInput()
    await settled()
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    view.scanner.hold()
    click(view, '.jse-undo')
    replaceAll(view.target, typed)
    view.scanner.release()
    await settled(DEBOUNCE_MS)
  }

  const documents = (view: Mounted): string => {
    try {
      return JSON.stringify(JSON.parse(view.text()))
    } catch {
      return view.text()
    }
  }

  it('打鍵が残り、表の項目と表示の項目が履歴に残る', async () => {
    const view = mountForTest({ text: FIRST }, Mode.text)
    await typedDuringUndoCheck(view, '[{"a":2},{"a":3}] ', '["typed"]')
    expect(view.text()).toBe('["typed"]')
    expect(view.modeLabel()).toBe('テキスト')

    const seen: string[] = []
    while (!button(view, '.jse-undo').disabled) {
      click(view, '.jse-undo')
      await settled(DEBOUNCE_MS)
      seen.push(documents(view))
    }
    expect(view.banner()).toBeFalsy()
    expect(seen[seen.length - 1]).toBe(JSON.stringify(JSON.parse(FIRST)))
  })

  it('redo が削除を二重に当てない', async () => {
    const view = mountForTest({ text: FIRST }, Mode.text)
    await typedDuringUndoCheck(view, '[{"a":2},{"a":3}] ', '[{"a":2},{"a":3}]  ')
    const allowed = new Set([FIRST, '[{"a":2},{"a":3}]'].map((text) => JSON.stringify(JSON.parse(text))))

    while (!button(view, '.jse-undo').disabled) {
      click(view, '.jse-undo')
      await settled(DEBOUNCE_MS)
      expect(allowed).toContain(documents(view))
    }
    while (!button(view, '.jse-redo').disabled) {
      click(view, '.jse-redo')
      await settled(DEBOUNCE_MS)
      expect(allowed).toContain(documents(view))
    }
    expect(view.banner()).toBeFalsy()
  })

  it('答えを待つ間は履歴が動かず、許されたら 1 回だけ進む', async () => {
    const view = mountForTest({ text: FIRST }, Mode.text)
    clickMode(view, '表')
    await settled()
    clickMode(view, 'テキスト')
    await settled()
    replaceAll(view.target, FIRST + ' ')
    view.editor.commitPendingInput()
    await settled()
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    view.scanner.hold()
    click(view, '.jse-undo')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    view.scanner.release()
    await settled()
    expect(view.modeLabel()).toBe('表')
    expect(button(view, '.jse-redo').disabled).toBe(false)
    click(view, '.jse-redo')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
  })

  it('打鍵で拒否された redo は履歴に残らず、undo が空振りしない', async () => {
    const view = mountForTest({ text: '[{"a":1}]' }, Mode.text)
    replaceAll(view.target, '[{"a":2}]')
    view.editor.commitPendingInput()
    await settled()
    clickMode(view, '表')
    await settled()
    click(view, '.jse-undo')
    await settled()
    view.scanner.hold()
    click(view, '.jse-redo')
    replaceAll(view.target, '[{"b":7}]')
    view.scanner.release()
    await settled()
    expect(button(view, '.jse-redo').disabled).toBe(true)

    const before = view.text()
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    expect(view.text()).not.toBe(before)
  })
})

describe('切り替えの後の undo の表示', () => {
  const buttons = (view: Mounted) => ({
    undo: !button(view, '.jse-undo').disabled,
    redo: !button(view, '.jse-redo').disabled
  })

  function clickMode(view: Mounted, label: string): void {
    const element = [...view.target.querySelectorAll<HTMLElement>('.jse-group-button')].find(
      (item) => item.textContent?.trim() === label
    ) as HTMLElement
    element.click()
    flushSync()
  }

  it.each(['表', 'ツリー'])('編集を全部 undo してから %s へ切り替える', async (label) => {
    const view = mountForTest({ text: '[{"a":1}]' }, Mode.text)
    replaceAll(view.target, '[{"a":2}]')
    view.editor.commitPendingInput()
    await settled()
    click(view, '.jse-undo')
    await settled(DEBOUNCE_MS)
    clickMode(view, label)
    await settled()
    expect(view.modeLabel()).toBe(label)
    expect(buttons(view)).toEqual({ undo: true, redo: false })
    click(view, '.jse-undo')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(buttons(view).redo).toBe(true)
  })

  it.each(['表', 'ツリー'])('開いたまま %s へ切り替える', async (label) => {
    const view = mountForTest({ text: '[{"a":1}]' }, Mode.text)
    clickMode(view, label)
    await settled()
    expect(buttons(view)).toEqual({ undo: true, redo: false })
    click(view, '.jse-undo')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
  })
})
