// 殻の表示の切り替え（D2、D3、D4）。実物のエディタを jsdom で動かし、切り替えが上流のボタンと
// 同じ経路（門番）を通ることと、テキストでしか開けない文書で押せないことを確かめる。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Mode, type MenuItem } from '$lib/types'
import ja from '../../../src/i18n/ja.json'
import { createMainModeMenu, createViewSwitch, type ViewSwitch } from '../../../src/shell/viewSwitch'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from '../editor/harness'

const DUPLICATE = '{ "a": 1, "a": 1, "b": 2 }'
const VALID = '{"rows":[{"a":1}]}'
const SETTLE_MS = 30

beforeAll(installDomStubs)
afterEach(destroyAll)

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  flushSync()
}

interface Shell {
  view: Mounted
  viewSwitch: ViewSwitch
  request: ReturnType<typeof vi.fn>
  button(mode: Mode): HTMLElement
  shownMode(): string | null
}

/** app.ts と同じ配線。`probe` を差し替えると、押せるかの表示が古い場合を作れる。 */
function mountShell(text: string, mode: Mode, probe?: (target: Mode) => boolean | Promise<boolean>): Shell {
  const request = vi.fn((target: Mode) => modeMenu.request(target))
  let view: Mounted | undefined
  const viewSwitch = createViewSwitch({
    request,
    probe: probe ?? ((target) => (view as Mounted).editor.probeMode(target))
  })
  const modeMenu = createMainModeMenu((current) => viewSwitch.setMode(current))
  view = mountForTest({ text }, mode, {
    onRenderMenu: modeMenu.onRenderMenu,
    onChange: () => viewSwitch.recheck()
  })
  view.target.prepend(viewSwitch.element)
  return {
    view,
    viewSwitch,
    request,
    button: (target) => viewSwitch.element.querySelector(`[data-mode="${target}"]`) as HTMLElement,
    shownMode: () => {
      const target = view as Mounted
      if (target.target.querySelector('.jse-text-mode')) return Mode.text
      if (target.target.querySelector('.jse-tree-mode')) return Mode.tree
      if (target.target.querySelector('.jse-table-mode')) return Mode.table
      return null
    }
  }
}

function click(element: HTMLElement): void {
  element.click()
  flushSync()
}

describe('上流のボタンを外す', () => {
  it('主のエディタのメニューに Text/Tree/Table のボタンも、その後の区切りも無い', async () => {
    const shell = mountShell(VALID, Mode.tree)
    await settled()
    const menu = shell.view.target.querySelector('.jse-main .jse-menu') as HTMLElement
    expect(menu.querySelectorAll('.jse-group-button')).toHaveLength(0)
    expect(menu.firstElementChild?.classList.contains('jse-separator')).toBe(false)
    expect(menu.querySelector('.jse-expand-all')).not.toBeNull() // 他の項目は残る
  })

  it('モーダルの中のエディタのメニューには触らない', () => {
    const modeMenu = createMainModeMenu(() => {})
    const items: MenuItem[] = [{ type: 'button', className: 'jse-group-button', onClick: () => {} }]
    expect(modeMenu.onRenderMenu(items, { mode: Mode.text, modal: true, readOnly: false })).toBeUndefined()
  })

  it('既定の Tree が選ばれ、両方を押せる', async () => {
    const shell = mountShell(VALID, Mode.tree)
    await settled()
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.tree)
    expect(shell.button(Mode.tree).getAttribute('aria-checked')).toBe('true')
    expect(shell.button(Mode.table).getAttribute('aria-checked')).toBe('false')
    expect(shell.button(Mode.table).getAttribute('aria-disabled')).toBe('false')
    expect(shell.button(Mode.tree).textContent).toBe(ja['app.view.tree'])
    expect(shell.button(Mode.table).textContent).toBe(ja['app.view.table'])
  })

  it('Table を押すと表になり、Tree を押すとツリーへ戻る', async () => {
    const shell = mountShell(VALID, Mode.tree)
    await settled()
    click(shell.button(Mode.table))
    await settled()
    expect(shell.shownMode()).toBe(Mode.table)
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.table)
    click(shell.button(Mode.tree))
    await settled()
    expect(shell.shownMode()).toBe(Mode.tree)
  })
})

describe('テキストでしか開けない文書', () => {
  it('テキストでしか開けない文書では Tree と Table を押せない', async () => {
    const shell = mountShell(DUPLICATE, Mode.text)
    await settled()
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.text)
    for (const target of [Mode.tree, Mode.table]) {
      expect(shell.button(target).getAttribute('aria-disabled')).toBe('true')
      expect(shell.button(target).getAttribute('aria-checked')).toBe('false')
      click(shell.button(target))
    }
    await settled()
    expect(shell.request).not.toHaveBeenCalled()
    expect(shell.shownMode()).toBe(Mode.text)
    expect(shell.view.text()).toBe(DUPLICATE)
  })

  it('押せる状態でも切り替えは門番を通る', async () => {
    // 押せるかの表示が古い（検査を通ったと誤って出ている）場合を作る
    const shell = mountShell(DUPLICATE, Mode.text, () => true)
    await settled()
    expect(shell.button(Mode.table).getAttribute('aria-disabled')).toBe('false')
    click(shell.button(Mode.table))
    await settled()
    expect(shell.request).toHaveBeenCalledWith(Mode.table)
    expect(shell.shownMode()).toBe(Mode.text)
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.text)
    expect(shell.view.banner()).toBe(ja['app.parser.duplicateKey'])
    expect(shell.view.text()).toBe(DUPLICATE)
  })

  it('直して検査を通ると押せるようになり、押すとツリーへ移る', async () => {
    const shell = mountShell(DUPLICATE, Mode.text)
    await settled()
    shell.view.editor.set({ text: VALID })
    shell.viewSwitch.recheck()
    await settled()
    expect(shell.button(Mode.tree).getAttribute('aria-disabled')).toBe('false')
    click(shell.button(Mode.tree))
    await settled()
    expect(shell.shownMode()).toBe(Mode.tree)
    expect(shell.button(Mode.tree).getAttribute('aria-checked')).toBe('true')
  })
})

describe('undo でテキストへ戻った正しい文書', () => {
  it('どちらも選ばず、Tree と Table を押せる', async () => {
    const shell = mountShell(VALID, Mode.text)
    await settled()
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.text)
    for (const target of [Mode.tree, Mode.table]) {
      expect(shell.button(target).getAttribute('aria-checked')).toBe('false')
      expect(shell.button(target).getAttribute('aria-disabled')).toBe('false')
    }
  })

  it('テキストからツリーへ移り、undo でテキストへ戻すと、どちらも選ばず押せる', async () => {
    const shell = mountShell(VALID, Mode.text)
    await settled()
    click(shell.button(Mode.tree))
    await settled()
    expect(shell.shownMode()).toBe(Mode.tree)
    shell.view.clickUndo()
    await settled()
    expect(shell.shownMode()).toBe(Mode.text)
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.text)
    expect(shell.button(Mode.tree).getAttribute('aria-checked')).toBe('false')
    expect(shell.button(Mode.tree).getAttribute('aria-disabled')).toBe('false')
    expect(shell.button(Mode.table).getAttribute('aria-disabled')).toBe('false')
  })
})

describe('テキストでしか開けないかの知らせ（警告の帯の判断）', () => {
  /** app.ts と同じ配線に、知らせの記録を足す。 */
  function mountWithReports(text: string, mode: Mode): { shell: Shell; reports: boolean[] } {
    const reports: boolean[] = []
    let view: Mounted | undefined
    const viewSwitch = createViewSwitch({
      request: (target) => modeMenu.request(target),
      probe: (target) => (view as Mounted).editor.probeMode(target),
      onTextOnlyChange: (textOnly) => reports.push(textOnly)
    })
    const modeMenu = createMainModeMenu((current) => viewSwitch.setMode(current))
    view = mountForTest({ text }, mode, { onRenderMenu: modeMenu.onRenderMenu, onChange: () => viewSwitch.recheck() })
    const shell: Shell = {
      view,
      viewSwitch,
      request: vi.fn(),
      button: (target) => viewSwitch.element.querySelector(`[data-mode="${target}"]`) as HTMLElement,
      shownMode: () => null
    }
    return { shell, reports }
  }

  it('検査を通らない文書は true、直すと false', async () => {
    const { shell, reports } = mountWithReports(DUPLICATE, Mode.text)
    await settled()
    expect(reports.at(-1)).toBe(true)
    shell.view.editor.set({ text: VALID })
    shell.viewSwitch.recheck()
    await settled()
    expect(reports.at(-1)).toBe(false)
  })

  it('正しい文書のテキストの表示（undo で戻った形）は false', async () => {
    const { reports } = mountWithReports(VALID, Mode.text)
    await settled()
    expect(reports).toEqual([false])
  })

  it('テキストから離れると false', async () => {
    const { shell, reports } = mountWithReports(VALID, Mode.text)
    await settled()
    click(shell.button(Mode.tree))
    await settled()
    expect(reports.at(-1)).toBe(false)
    expect(shell.viewSwitch.element.dataset.mode).toBe(Mode.tree)
  })

  it('検査が例外を投げたら true（押せない側に倒す）', async () => {
    const reports: boolean[] = []
    const viewSwitch = createViewSwitch({
      request: () => {},
      probe: () => Promise.reject(new Error('scan failed')),
      onTextOnlyChange: (textOnly) => reports.push(textOnly)
    })
    viewSwitch.setMode(Mode.text)
    await settled()
    expect(reports).toEqual([true])
  })
})

describe('検査の結果の順序', () => {
  it('表示が替わった後に届いた古い検査の結果を使わない', async () => {
    let resolve: (allowed: boolean) => void = () => {}
    const viewSwitch = createViewSwitch({
      request: () => {},
      probe: () => new Promise<boolean>((done) => (resolve = done))
    })
    viewSwitch.setMode(Mode.text)
    await settled()
    viewSwitch.setMode(Mode.tree)
    resolve(false)
    await settled()
    const table = viewSwitch.element.querySelector(`[data-mode="${Mode.table}"]`) as HTMLElement
    expect(table.getAttribute('aria-disabled')).toBe('false')
  })

  it('検査の途中で文書が変わったら、前の本文の結果を使わない', async () => {
    const pending: ((allowed: boolean) => void)[] = []
    const reports: boolean[] = []
    const viewSwitch = createViewSwitch({
      request: () => {},
      probe: () => new Promise<boolean>((done) => pending.push(done)),
      onTextOnlyChange: (textOnly) => reports.push(textOnly)
    })
    viewSwitch.setMode(Mode.text)
    await settled()
    expect(pending).toHaveLength(1)
    viewSwitch.recheck() // 打鍵。前の検査はまだ戻っていない
    pending[0](false) // 前の本文は不正だった
    await settled()
    expect(reports).toEqual([])
    pending[1](true) // 今の本文は正しい
    await settled()
    expect(reports).toEqual([false])
    const tree = viewSwitch.element.querySelector(`[data-mode="${Mode.tree}"]`) as HTMLElement
    expect(tree.getAttribute('aria-disabled')).toBe('false')
  })

  it('検査が例外を投げたら押せない', async () => {
    const viewSwitch = createViewSwitch({
      request: () => {},
      probe: () => {
        throw new Error('scan failed')
      }
    })
    viewSwitch.setMode(Mode.text)
    await settled()
    const tree = viewSwitch.element.querySelector(`[data-mode="${Mode.tree}"]`) as HTMLElement
    expect(tree.getAttribute('aria-disabled')).toBe('true')
  })
})
