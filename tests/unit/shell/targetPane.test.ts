// 左ペイン「表にできる配列」（D7、D13）。並べる物、出す場面、意味の無い場面で出さない物（D12）を確かめる。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JSONPath } from 'immutable-json-patch'
import { Mode } from '$lib/types'
import { setLanguage } from '../../../src/i18n'
import { findTableTargets } from '../../../src/shell/tableTargets'
import { createTargetPane, MAX_TARGETS, paneShown, paneTargets, type TargetPaneOptions } from '../../../src/shell/targetPane'

afterEach(() => {
  setLanguage('ja')
  vi.useRealTimers()
})

describe('paneTargets（並べる物）', () => {
  it('根のオブジェクトは findTableTargets の順のまま、文書全体を足さない（D12）', () => {
    const json = { name: 'n', items: [{ a: 1 }, { a: 2 }], meta: { rows: [{ k: 1 }] }, tags: ['p', 'q', 'r'] }
    const { items, more } = paneTargets(json)
    expect(items).toEqual(findTableTargets(json))
    expect(items.map(({ path }) => path.join('.'))).toEqual(['items', 'meta.rows', 'tags'])
    expect(items.map(({ rows }) => rows)).toEqual([2, 1, 3])
    expect(more).toBe(0)
  })

  it('根が配列なら先頭に根（パスは空）を件数つきで置く', () => {
    expect(paneTargets([{ a: 1 }, { a: 2 }, { a: 3 }])).toEqual({ items: [{ path: [], rows: 3 }], more: 0 })
  })

  it('根が空の配列、値、候補の無いオブジェクトは項目が無い', () => {
    expect(paneTargets([]).items).toEqual([])
    expect(paneTargets(1).items).toEqual([])
    expect(paneTargets({ a: [], b: { c: 1 } }).items).toEqual([])
    expect(paneTargets(undefined).items).toEqual([])
  })

  it(`上限（${MAX_TARGETS}）を超えた分は数だけを返す`, () => {
    const json = Object.fromEntries(Array.from({ length: MAX_TARGETS + 2 }, (_, index) => [`k${index}`, [index]]))
    const { items, more } = paneTargets(json)
    expect(items).toHaveLength(MAX_TARGETS)
    expect(more).toBe(2)
  })

  it('根の配列も上限に数える', () => {
    const { items, more } = paneTargets([1, 2], 1)
    expect(items).toEqual([{ path: [], rows: 2 }])
    expect(more).toBe(0)
  })
})

describe('paneShown（出す場面）', () => {
  it('テキストの表示では出さない（不正な文書と undo で戻った文書。D12）', () => {
    expect(paneShown({ mode: Mode.text, hideInTree: false, count: 3 })).toBe(false)
  })

  it('ツリーでは既定で出し、Options の切り替えで出さない（D13）', () => {
    expect(paneShown({ mode: Mode.tree, hideInTree: false, count: 3 })).toBe(true)
    expect(paneShown({ mode: Mode.tree, hideInTree: true, count: 3 })).toBe(false)
  })

  it('表では Options の切り替えに関わらず出す', () => {
    expect(paneShown({ mode: Mode.table, hideInTree: true, count: 3 })).toBe(true)
  })

  it('項目が無ければ出さない（D12）', () => {
    expect(paneShown({ mode: Mode.table, hideInTree: false, count: 0 })).toBe(false)
    expect(paneShown({ mode: Mode.tree, hideInTree: false, count: 0 })).toBe(false)
  })
})

interface Shape {
  mode?: Mode
  target?: JSONPath
  json?: unknown
  hideInTree?: boolean
}

function mountPane(shape: Shape) {
  const state: Required<Shape> = { mode: Mode.tree, target: [], json: undefined, hideInTree: false, ...shape }
  const picks: JSONPath[] = []
  const documentReads = { count: 0 }
  const options: TargetPaneOptions = {
    mode: () => state.mode,
    tableTarget: () => state.target,
    document: () => {
      documentReads.count++
      return state.json
    },
    hideInTree: () => state.hideInTree,
    onPick: (path) => picks.push(path)
  }
  const pane = createTargetPane(options)
  document.body.appendChild(pane.element)
  const settle = async (): Promise<void> => {
    pane.refresh()
    await vi.runAllTimersAsync()
  }
  const items = () =>
    [...pane.element.querySelectorAll<HTMLButtonElement>('.app-target-pane-item')].map((button) => ({
      label: button.querySelector('.app-target-pane-path')?.textContent,
      count: button.querySelector('.app-target-pane-count')?.textContent,
      selected: button.classList.contains('is-selected') && button.getAttribute('aria-current') === 'true'
    }))
  return { pane, state, picks, documentReads, settle, items }
}

const DOC = { items: [{ a: 1 }, { a: 2 }], meta: { rows: [{ k: 1 }] }, logs: Array.from({ length: 1204 }, (_, i) => i) }

describe('createTargetPane（描画）', () => {
  it('件数つきで縦に並べ、今の表の対象に印を付ける。数は桁区切り', async () => {
    vi.useFakeTimers()
    const { pane, settle, items } = mountPane({ json: DOC, target: ['meta', 'rows'] })
    await settle()
    expect(pane.element.hidden).toBe(false)
    expect(pane.element.querySelector('.app-target-pane-title')?.textContent).toBe('表にできる配列')
    expect(pane.element.getAttribute('aria-label')).toBe('表にできる配列')
    expect(items()).toEqual([
      { label: 'items', count: '2', selected: false },
      { label: 'meta.rows', count: '1', selected: true },
      { label: 'logs', count: '1,204', selected: false }
    ])
    pane.element.remove()
  })

  it('押すとその配列のパスを渡す', async () => {
    vi.useFakeTimers()
    const { pane, settle, picks } = mountPane({ json: DOC })
    await settle()
    pane.element.querySelectorAll<HTMLButtonElement>('.app-target-pane-item')[1].click()
    expect(picks).toEqual([['meta', 'rows']])
    pane.element.remove()
  })

  it('根の配列は「文書全体」', async () => {
    vi.useFakeTimers()
    const { pane, settle, items } = mountPane({ json: [{ a: 1 }, { a: 2 }], mode: Mode.table })
    await settle()
    expect(items()).toEqual([{ label: '文書全体', count: '2', selected: true }])
    pane.element.remove()
  })

  it('上限を超えた分は押せない「ほか N 件」の行', async () => {
    vi.useFakeTimers()
    const json = Object.fromEntries(Array.from({ length: MAX_TARGETS + 3 }, (_, index) => [`k${index}`, [index]]))
    const { pane, settle } = mountPane({ json })
    await settle()
    expect(pane.element.querySelectorAll('.app-target-pane-item')).toHaveLength(MAX_TARGETS)
    const more = pane.element.querySelector('.app-target-pane-more')
    expect(more?.textContent).toBe('ほか 3 件')
    expect(more?.querySelector('button')).toBeNull()
    pane.element.remove()
  })

  it('テキストの表示では隠し、文書を読まない（D12）', async () => {
    vi.useFakeTimers()
    const { pane, settle, state, documentReads } = mountPane({ json: DOC, mode: Mode.text })
    await settle()
    expect(pane.element.hidden).toBe(true)
    expect(documentReads.count).toBe(0)
    state.mode = Mode.tree
    await settle()
    expect(pane.element.hidden).toBe(false)
    pane.element.remove()
  })

  it('ツリーで Options の切り替えが入っていれば隠し、表では出す（D13）', async () => {
    vi.useFakeTimers()
    const { pane, settle, state } = mountPane({ json: DOC, hideInTree: true })
    await settle()
    expect(pane.element.hidden).toBe(true)
    state.mode = Mode.table
    await settle()
    expect(pane.element.hidden).toBe(false)
    state.mode = Mode.tree
    state.hideInTree = false
    await settle()
    expect(pane.element.hidden).toBe(false)
    pane.element.remove()
  })

  it('候補の無い文書では隠す（D12）', async () => {
    vi.useFakeTimers()
    const { pane, settle } = mountPane({ json: { a: 1 }, mode: Mode.table })
    await settle()
    expect(pane.element.hidden).toBe(true)
    pane.element.remove()
  })

  it('refresh の後のタスクで読む（描画の中から呼べる）。続けて呼んでも 1 回だけ読む', async () => {
    vi.useFakeTimers()
    const { pane, documentReads } = mountPane({ json: DOC })
    pane.refresh()
    pane.refresh()
    expect(documentReads.count).toBe(0)
    await vi.runAllTimersAsync()
    expect(documentReads.count).toBe(1)
    pane.element.remove()
  })

  it('文書と対象が替わると描き直し、同じなら描き直さない', async () => {
    vi.useFakeTimers()
    const { pane, settle, state, items } = mountPane({ json: DOC, target: ['items'] })
    await settle()
    const first = pane.element.querySelector('.app-target-pane-item')
    await settle()
    expect(pane.element.querySelector('.app-target-pane-item')).toBe(first)
    state.target = ['logs']
    await settle()
    expect(items().map(({ selected }) => selected)).toEqual([false, false, true])
    state.json = { ...DOC, extra: [1, 2, 3] }
    await settle()
    expect(items().map(({ label }) => label)).toEqual(['items', 'meta.rows', 'logs', 'extra'])
    pane.element.remove()
  })

  it('言語を替えると文言を引き直す', async () => {
    vi.useFakeTimers()
    const { pane, settle } = mountPane({ json: [1, 2] })
    await settle()
    setLanguage('en')
    await settle()
    expect(pane.element.querySelector('.app-target-pane-title')?.textContent).toBe('Table Targets')
    expect(pane.element.querySelector('.app-target-pane-path')?.textContent).toBe('Whole document')
    expect(pane.element.querySelector<HTMLButtonElement>('.app-target-pane-item')?.title).toBe('Whole document (2 items)')
    pane.element.remove()
  })
})
