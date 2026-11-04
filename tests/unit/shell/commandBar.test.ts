// コマンドの行（S4）。実物のエディタを jsdom で動かし、上流の項目の動作と押せる状態をそのまま使うこと、
// 上流の帯を空にすること、モーダルの中のエディタには触らないことを確かめる。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode, type MenuItem } from '$lib/types'
import en from '../../../src/i18n/en.json'
import ja from '../../../src/i18n/ja.json'
import { setLanguage } from '../../../src/i18n'
import { createCommandBar, mainMenuRenderer, pickCommands, type CommandBar } from '../../../src/shell/commandBar'
import { createMainModeMenu, createViewSwitch, type ViewSwitch } from '../../../src/shell/viewSwitch'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from '../editor/harness'

const DOC = '{"rows":[{"a":1},{"a":2}]}'
const ORDER = ['undo', 'redo', 'search', 'sort', 'transform', 'expandAll', 'collapseAll']

beforeAll(installDomStubs)
afterEach(destroyAll)

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync()
}

interface Shell {
  view: Mounted
  bar: CommandBar
  modal: { open: boolean }
  button(name: string): HTMLButtonElement
}

/** app.ts と同じ配線（切り替え、コマンドの行、上流の帯を空にする）。 */
function mountShell(mode: Mode, { text = DOC, gate = { passes: true } } = {}): Shell & { viewSwitch: ViewSwitch } {
  const modal = { open: false }
  const bar = createCommandBar({ hasOpenModal: () => modal.open })
  const viewSwitch = createViewSwitch({
    request: (target) => modeMenu.request(target),
    probe: () => gate.passes,
    // app.ts と同じ配線（D12）
    onTextOnlyChange: (textOnly) => bar.setTextOnly(textOnly)
  })
  const modeMenu = createMainModeMenu((current) => viewSwitch.setMode(current))
  const view = mountForTest({ text }, mode, {
    tableTarget: ['rows'],
    onRenderMenu: mainMenuRenderer(modeMenu, bar)
  })
  view.target.prepend(bar.element)
  return {
    view,
    bar,
    viewSwitch,
    modal,
    button: (name) => bar.element.querySelector(`[data-command="${name}"]`) as HTMLButtonElement
  }
}

const disabled = (shell: Shell, name: string) => shell.button(name).getAttribute('aria-disabled') === 'true'

describe('pickCommands', () => {
  it('7 つの命令だけを印のクラスで拾い、整形、圧縮、右クリックの入口は拾わない', () => {
    const button = (className: string): MenuItem => ({ type: 'button', className, onClick: () => {} })
    const items: MenuItem[] = [
      button('jse-format'),
      button('jse-compact'),
      button('jse-contextmenu'),
      button('jse-sort'),
      { type: 'separator' },
      button('jse-undo'),
      button('jse-search')
    ]
    expect([...pickCommands(items).keys()]).toEqual(['undo', 'search', 'sort'])
  })
})

describe('コマンドの行', () => {
  it('7 つの命令を見本の絵の順に、群の間に区切りを置いて出す', async () => {
    const shell = mountShell(Mode.tree)
    await settled()
    const children = [...shell.bar.element.children].map((child) =>
      child.classList.contains('app-command-separator') ? '|' : (child as HTMLElement).dataset.command
    )
    expect(children).toEqual(['undo', 'redo', '|', 'search', 'sort', 'transform', '|', 'expandAll', 'collapseAll'])
    expect(shell.bar.element.getAttribute('role')).toBe('toolbar')
  })

  it('主のエディタの上流の帯は空（表示のボタンも命令も無い）', async () => {
    const shell = mountShell(Mode.tree)
    await settled()
    const menu = shell.view.target.querySelector('.jse-main .jse-menu') as HTMLElement
    expect(menu.querySelectorAll('button')).toHaveLength(0)
  })

  it('入れ子の値のモーダルの中のエディタの帯には触らない', () => {
    const bar = createCommandBar({ hasOpenModal: () => false })
    const render = mainMenuRenderer(createMainModeMenu(() => {}), bar)
    const items: MenuItem[] = [{ type: 'button', className: 'jse-undo', onClick: () => {} }]
    expect(render(items, { mode: Mode.tree, modal: true, readOnly: false })).toBeUndefined()
    expect(bar.enabled('undo')).toBe(false) // 主のコマンドの行は変えない
  })

  it('文言は辞書から引き、title は上流の項目（キーの案内つき）', async () => {
    const shell = mountShell(Mode.tree)
    await settled()
    expect(shell.button('search').textContent).toBe(ja['app.command.search'])
    expect(shell.button('undo').title).toContain('Ctrl+Z')
    setLanguage('en')
    shell.bar.refresh()
    expect(shell.button('transform').textContent).toBe(en['app.command.transform'])
    expect(shell.bar.element.getAttribute('aria-label')).toBe(en['app.command.label'])
    setLanguage('ja')
    shell.bar.refresh()
  })

  it('表の展開と折りたたみは上流に無いので押せない（位置は動かさない）', async () => {
    const shell = mountShell(Mode.table)
    await settled()
    expect(disabled(shell, 'expandAll')).toBe(true)
    expect(disabled(shell, 'collapseAll')).toBe(true)
    expect(disabled(shell, 'sort')).toBe(false)
    expect(shell.bar.run('expandAll')).toBe(false)
  })

  it('元に戻すとやり直すは上流と同じ状態で、押すと上流と同じ動作', async () => {
    const shell = mountShell(Mode.table)
    await settled()
    expect(disabled(shell, 'undo')).toBe(true)
    expect(shell.bar.run('undo')).toBe(false)
    const before = shell.view.text()
    shell.view.select(0, 'a')
    shell.view.press('Enter')
    shell.view.typeAndEnter('9')
    await settled()
    const edited = shell.view.text()
    expect(edited).not.toBe(before)
    expect(disabled(shell, 'undo')).toBe(false)
    expect(disabled(shell, 'redo')).toBe(true)

    shell.button('undo').click()
    await settled()
    expect(shell.view.text()).toBe(before)
    expect(disabled(shell, 'redo')).toBe(false)
    shell.button('redo').click()
    await settled()
    expect(shell.view.text()).toBe(edited)
  })

  it('モーダルが開いている間は押しても走らない', async () => {
    const shell = mountShell(Mode.table)
    await settled()
    shell.view.select(0, 'a')
    shell.view.press('Enter')
    shell.view.typeAndEnter('9')
    await settled()
    const edited = shell.view.text()
    shell.modal.open = true
    expect(shell.bar.run('undo')).toBe(false)
    shell.button('undo').click()
    await settled()
    expect(shell.view.text()).toBe(edited)
  })

  it('テキストでしか開けない文書では並べ替え、変換、展開、折りたたみを押せない（D12）。元に戻す、やり直す、検索は今のまま', async () => {
    const gate = { passes: false }
    const shell = mountShell(Mode.text, { text: '{"a":1,"a":2}', gate })
    await settled()
    await settled()
    for (const name of ['sort', 'transform', 'expandAll', 'collapseAll']) {
      expect(disabled(shell, name), name).toBe(true)
      expect(shell.bar.enabled(name as never), name).toBe(false)
      expect(shell.bar.run(name as never), name).toBe(false)
    }
    expect(disabled(shell, 'search')).toBe(false)

    // 直して検査を通ると押せる
    gate.passes = true
    shell.viewSwitch.recheck()
    await settled()
    await settled()
    expect(disabled(shell, 'sort')).toBe(false)
    expect(disabled(shell, 'expandAll')).toBe(false)
  })

  it('正しい文書のテキストの表示（undo で戻った形）では押せるまま', async () => {
    const shell = mountShell(Mode.text)
    await settled()
    await settled()
    expect(disabled(shell, 'sort')).toBe(false)
    expect(disabled(shell, 'transform')).toBe(false)
  })

  it('並びの名前は計画の 7 つ', () => {
    const bar = createCommandBar({ hasOpenModal: () => false })
    expect([...bar.element.querySelectorAll<HTMLElement>('[data-command]')].map((b) => b.dataset.command)).toEqual(ORDER)
  })
})
