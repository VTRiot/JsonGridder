import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode, SelectionType } from '$lib/types'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const DOC = '[{"a":1,"b":"x"},{"a":2}]'
const TREE_DOC = '{"a":1,"b":"x"}'
const NEW = '{"replaced":true}'
const EDITED = 'ZZ'

beforeAll(installDomStubs)
afterEach(destroyAll)

/** 遅延中の入力。同じタスクの中で書く。 */
function typeNow(view: Mounted, inserted: string, from = 1): void {
  const content = view.target.querySelector('.cm-content') as unknown as {
    cmTile: { root: { view: { dispatch(spec: unknown): void } } }
  }
  content.cmTile.root.view.dispatch({ changes: { from, insert: inserted } })
}

/** セルの編集を始めて、確定しないまま止める。 */
function startCellEdit(view: Mounted): void {
  if (view.modeLabel() === '表') {
    view.select(0, 'b')
  } else {
    view.editor.select({ type: SelectionType.value, path: ['b'] })
  }
  view.press('Enter')
  ;(view.target.querySelector('.jse-editable-div') as HTMLElement).textContent = EDITED
}

function withoutWindowFocus(run: () => void): void {
  const original = document.hasFocus
  document.hasFocus = () => false
  try {
    run()
  } finally {
    document.hasFocus = original
  }
}

describe('確定の公開の手段', () => {
  it('遅延中のテキストを確定する', () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    expect(view.changes.length).toBe(0)
    view.editor.commitPendingInput()
    expect(view.text()).toBe(`[777,${DOC.slice(1)}`)
    expect(view.changes.length).toBe(1)
  })

  it.each([
    ['表', Mode.table, DOC, '[{"a":1,"b":"ZZ"},{"a":2}]'],
    ['ツリー', Mode.tree, TREE_DOC, '{"a":1,"b":"ZZ"}']
  ] as const)('%s の編集中のセルを、窓のフォーカスが無くても確定する', (_, mode, text, expected) => {
    const view = mountForTest({ text }, mode)
    startCellEdit(view)
    withoutWindowFocus(() => view.editor.commitPendingInput())
    expect(view.text()).toBe(expected)
    expect(view.changes.length).toBe(1)
    expect(view.editors()).toBe(0)
  })

  it('確定するものが無ければ onChange を出さない', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    view.editor.commitPendingInput()
    expect(view.changes.length).toBe(0)
  })
})

describe('文書の置き換え', () => {
  it('遅延中の set は新しい文書を残し、入力は onChange で 1 回渡す', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    view.editor.set({ text: NEW })
    expect(view.text()).toBe(NEW)
    expect(view.changes.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve))
    expect(view.text()).toBe(NEW)
    expect(view.changes.length).toBe(1)
  })

  it('遅延中の updateProps の content も入力を渡す', () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    view.editor.updateProps({ content: { text: NEW } })
    expect(view.text()).toBe(NEW)
    expect(view.changes.length).toBe(1)
  })

  it.each([
    ['表', Mode.table, DOC],
    ['ツリー', Mode.tree, TREE_DOC]
  ] as const)('%s のセルの編集中の set は新しい文書を残す', (_, mode, text) => {
    const view = mountForTest({ text }, mode)
    startCellEdit(view)
    view.editor.set({ text: NEW })
    expect(view.text()).toBe(NEW)
    expect(view.changes.length).toBe(1)
    expect(view.editors()).toBe(0)
  })

  it('セルの編集中の updateProps の content に編集が書き込まれない', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    startCellEdit(view)
    const replacement = '[{"a":1,"b":"y"}]'
    view.editor.updateProps({ content: { text: replacement } })
    view.editor.updateProps({ mode: Mode.tree })
    view.editor.updateProps({ mode: Mode.table })
    expect(view.text()).toBe(replacement)
  })

  it('patch は確定の直後でも画面と文書に残り、undo は 1 回で戻る', () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    view.editor.commitPendingInput()
    view.editor.patch([{ op: 'replace', path: '/0', value: 888 }])
    expect(view.text()).toContain('888')
    expect(view.target.querySelector('.cm-content')?.textContent).toContain('888')
    view.clickUndo()
    view.editor.commitPendingInput()
    expect(view.text()).toContain('777')
    expect(view.text()).not.toContain('888')
  })

  it('遅延中の patch は打った文字を残す', () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    view.editor.patch([{ op: 'replace', path: '/0', value: 888 }])
    expect(view.text()).toContain('888')
    expect(view.text()).toContain('"b"') // 打った要素が 0 番になるので、元の行は残る
    expect(view.changes.length).toBe(1)
  })

  it.each([
    ['テキスト', Mode.text, '[{"a":1}]'],
    ['表', Mode.table, '[{"a":1}]'],
    ['ツリー', Mode.tree, '[{"a":1}]']
  ] as const)('%s の patch は予約のキーを作らない', (_, mode, text) => {
    const view = mountForTest({ text }, mode)
    for (const operation of [
      { op: 'add', path: '/0/__proto__', value: {} },
      { op: 'move', from: '/0/a', path: '/0/constructor' },
      { op: 'replace', path: '/0/a', value: JSON.parse('{"__proto__":{"x":1}}') }
    ] as const) {
      expect(() => view.editor.patch([operation])).toThrow()
    }
    expect(view.text()).toBe(text)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('表の patch が次の更新で消えない', () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    view.editor.patch([{ op: 'replace', path: '/0/a', value: 999 }])
    view.editor.updateProps({ mode: Mode.tree })
    view.editor.updateProps({ mode: Mode.table })
    expect(view.text()).toContain('999')
  })
})

describe('遅延中の操作', () => {
  const click = (view: Mounted, selector: string) => {
    ;(view.target.querySelector(selector) as HTMLElement).click()
    flushSync()
  }

  it('整形が打った文字を残す', () => {
    const view = mountForTest({ text: '{"b":1,"a":2}' }, Mode.text)
    typeNow(view, '"z":0,')
    click(view, '.jse-format')
    expect(view.text()).toContain('"z"')
  })

  it('圧縮が打った文字を残す', () => {
    const view = mountForTest({ text: '{\n  "b": 1\n}' }, Mode.text)
    typeNow(view, '"z":0,')
    click(view, '.jse-compact')
    expect(view.text()).toContain('"z"')
  })

  it('並べ替えが打った文字を読む', () => {
    const view = mountForTest({ text: '{"b":1,"a":2}' }, Mode.text)
    typeNow(view, '"z":0,')
    click(view, '.jse-sort')
    click(view, '.jse-sort-modal .jse-primary')
    expect(view.text()).toContain('"z"')
  })

  it('変換が打った文字を読む', () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    typeNow(view, '777,')
    click(view, '.jse-transform')
    click(view, '.jse-transform-modal .jse-primary')
    expect(view.text()).toContain('777')
  })
})

describe('開いたままのモーダル', () => {
  const NESTED = '[{"n":[1,2]}]'

  it.each([
    ['set', (view: Mounted) => view.editor.set({ text: NEW })],
    ['updateProps', (view: Mounted) => view.editor.updateProps({ content: { text: NEW } })]
  ] as const)('%s でセルのモーダルが閉じる', (_, replace) => {
    const view = mountForTest({ text: NESTED }, Mode.table)
    view.select(0, 'n')
    view.press('Enter')
    expect(view.target.querySelector('.jse-jsoneditor-modal')).not.toBeNull()
    replace(view)
    expect(view.target.querySelector('.jse-jsoneditor-modal')).toBeNull()
    expect(view.text()).toBe(NEW)
  })

  it.each([
    ['.jse-sort', '.jse-sort-modal'],
    ['.jse-transform', '.jse-transform-modal']
  ])('set で %s のモーダルが閉じる', (button, modal) => {
    const view = mountForTest({ text: DOC }, Mode.text)
    ;(view.target.querySelector(button) as HTMLElement).click()
    flushSync()
    expect(view.target.querySelector(modal)).not.toBeNull()
    view.editor.set({ text: NEW })
    expect(view.target.querySelector(modal)).toBeNull()
    expect(view.text()).toBe(NEW)
  })
})
