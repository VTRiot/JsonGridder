import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const MODAL = '.jse-jsoneditor-modal'
const DOC = '[{"n":[{"m":[1,2],"o":"keep"}],"k":1}]'

beforeAll(installDomStubs)
afterEach(destroyAll)

const inModal = <T extends HTMLElement>(view: Mounted, selector: string) =>
  view.target.querySelector<T>(`${MODAL} ${selector}`)

const path = (view: Mounted) => inModal<HTMLInputElement>(view, '.jse-path')?.value

function pressInModal(view: Mounted, key: string): void {
  const active =
    inModal(view, '.jse-editable-div') ?? (inModal(view, '.jse-hidden-input') as HTMLElement)
  active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  flushSync()
}

function selectFirstInModal(view: Mounted, selector: string): void {
  const element = inModal(view, selector) as HTMLElement
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
  flushSync()
}

function openLevel1(view: Mounted): void {
  view.select(0, 'n')
  view.press('Enter')
}

function openLevel2(view: Mounted): void {
  openLevel1(view)
  selectFirstInModal(view, 'td[data-path]')
  pressInModal(view, 'Enter')
}

function editFirstCell(view: Mounted, value: string): void {
  selectFirstInModal(view, 'td[data-path]')
  pressInModal(view, 'Enter')
  ;(inModal(view, '.jse-editable-div') as HTMLElement).textContent = value
  pressInModal(view, 'Enter')
}

const click = (view: Mounted, selector: string) => {
  ;(inModal(view, selector) as HTMLElement).click()
  flushSync()
}

const back = (view: Mounted) => click(view, '.jse-actions .jse-secondary')
const apply = (view: Mounted) => click(view, '.jse-actions .jse-primary')
const canUndo = (view: Mounted) => !inModal<HTMLButtonElement>(view, '.jse-undo')?.disabled
const canRedo = (view: Mounted) => !inModal<HTMLButtonElement>(view, '.jse-redo')?.disabled

function applyAll(view: Mounted): void {
  while (view.target.querySelector(MODAL)) {
    apply(view)
  }
}

describe('入れ子のモーダルの履歴', () => {
  it('2 段目を捨てて戻ると undo は押せず、親が残る', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    openLevel2(view)
    expect(path(view)).toContain('m')
    editFirstCell(view, '55')
    back(view)
    expect(canUndo(view)).toBe(false)
    applyAll(view)
    expect(view.text()).toBe(DOC)
  })

  it('編集なしで 2 段目を開くと undo は押せない', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    openLevel2(view)
    expect(canUndo(view)).toBe(false)
    applyAll(view)
    expect(view.text()).toBe(DOC)
  })

  it('2 段目の Apply は親の 1 つの編集になり、undo と redo が効く', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    openLevel2(view)
    editFirstCell(view, '55')
    apply(view)
    expect(canUndo(view)).toBe(true)
    click(view, '.jse-undo')
    expect(inModal(view, '.jse-modal-inline-editor')?.textContent).not.toContain('55')
    click(view, '.jse-redo')
    expect(inModal(view, '.jse-modal-inline-editor')?.textContent).toContain('55')
    applyAll(view)
    expect(view.text()).toBe('[{"n":[{"m":[55,2],"o":"keep"}],"k":1}]')
  })

  it('1 段目の編集の undo が 2 段目を越えて残る', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    openLevel1(view)
    const keep = [...view.target.querySelectorAll<HTMLElement>(`${MODAL} td`)].find((cell) =>
      cell.textContent?.includes('keep')
    ) as HTMLElement
    keep.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    flushSync()
    pressInModal(view, 'Enter')
    ;(inModal(view, '.jse-editable-div') as HTMLElement).textContent = 'K'
    pressInModal(view, 'Enter')

    selectFirstInModal(view, 'td[data-path]')
    pressInModal(view, 'Enter')
    expect(path(view)).toContain('m')
    expect(canUndo(view)).toBe(false)
    back(view)

    expect(canUndo(view)).toBe(true)
    click(view, '.jse-undo')
    expect(inModal(view, '.jse-modal-inline-editor')?.textContent).toContain('keep')
    expect(canUndo(view)).toBe(false)
    expect(canRedo(view)).toBe(true)
    applyAll(view)
    expect(view.text()).toBe(DOC)
  })
})
