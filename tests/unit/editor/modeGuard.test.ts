import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode, SelectionType } from '$lib/types'
import ja from '../../../src/i18n/ja.json'
import { TEXT_MODE_LIMIT_BYTES } from '../../../src/editor/modeGuard'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const DOC = '[{"a":1}]'
const INVALID = '{"a":1,'
const DUPLICATE = '{"a":1,"a":1}'

beforeAll(installDomStubs)
afterEach(destroyAll)

function clickMode(view: Mounted, label: string): void {
  const button = [...view.target.querySelectorAll<HTMLElement>('.jse-group-button')].find(
    (element) => element.textContent?.trim() === label
  ) as HTMLElement
  button.click()
  flushSync()
}

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve))
  flushSync()
}

function replaceAll(view: Mounted, text: string): void {
  const content = view.target.querySelector('.cm-content') as unknown as {
    cmTile: { root: { view: { state: { doc: { length: number } }; dispatch(spec: unknown): void } } }
  }
  const editor = content.cmTile.root.view
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
}

describe('表示の切り替えの門番', () => {
  it('不正な JSON は表にもツリーにも入らず、理由が出る', async () => {
    const view = mountForTest({ text: INVALID }, Mode.text)
    for (const label of ['表', 'ツリー']) {
      clickMode(view, label)
      await settled()
      expect(view.modeLabel()).toBe('テキスト')
      expect(view.banner()).toBe(ja['app.notice.invalidJson'])
    }
    expect(view.target.querySelector('.jse-table-mode')).toBeNull()
    expect(view.target.querySelector('.jse-tree-mode')).toBeNull()
    expect(view.text()).toBe(INVALID)
    expect(view.changes).toEqual([])
  })

  it('テキストで打って不正になった文書も入らない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    replaceAll(view, INVALID)
    clickMode(view, '表')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe(INVALID)
  })

  it('検査で重複キーが立った文書は入らない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    view.scanner.results.set(DOC, {
      duplicateKey: true,
      numericKeyReorder: false,
      reservedKey: false,
      depthExceeded: false,
      syntaxOk: true
    })
    clickMode(view, '表')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.banner()).toBe(ja['app.notice.duplicateKey'])
    expect(view.text()).toBe(DOC)
  })

  it('検査で深さ超過が立った文書は入らない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    view.scanner.results.set(DOC, {
      duplicateKey: false,
      numericKeyReorder: false,
      reservedKey: false,
      depthExceeded: true,
      syntaxOk: true
    })
    clickMode(view, 'ツリー')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.banner()).toBe(ja['app.notice.depthExceeded'])
  })

  it('予約のキーの文書は入らない', async () => {
    const text = '[{"__proto__":{"x":1},"a":1}]'
    const view = mountForTest({ text }, Mode.text)
    clickMode(view, '表')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe(text)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('検査の失敗では切り替えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    view.scanner.scan = () => Promise.reject(new Error('injected'))
    clickMode(view, '表')
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.banner()).toBe(ja['app.notice.scanFailed'])
  })

  it('正しい文書は通り、続けて編集できる', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    clickMode(view, '表')
    await settled()
    expect(view.modeLabel()).toBe('表')
    expect(view.banner()).toBeNull()
  })

  it('updateProps の mode も通る', async () => {
    const view = mountForTest({ text: INVALID }, Mode.text)
    view.editor.updateProps({ mode: Mode.table })
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe(INVALID)
  })

  it('修復の呼び出しが無く、表で開いても文書は変わらない', () => {
    const text = '[{"a":1'
    const view = mountForTest({ text }, Mode.table)
    expect(view.text()).toBe(text)
    expect(view.target.querySelector('.jse-table-main')).toBeNull()
  })

  it('大きな文書はテキストの表示へ入らない', () => {
    const big = `["${'x'.repeat(TEXT_MODE_LIMIT_BYTES)}"]`
    const view = mountForTest({ text: big }, Mode.table)
    clickMode(view, 'テキスト')
    expect(view.modeLabel()).toBe('表')
    expect(view.banner()).toBe(ja['app.notice.tooLargeForText'])
    expect(view.text()).toBe(big)
  })
})

describe('キーの改名', () => {
  it.each(['__proto__', 'constructor'])('%s への改名は適用せず、理由を出す', (key) => {
    const text = '{"a":1,"b":2}'
    const view = mountForTest({ text }, Mode.tree)
    view.editor.select({ type: SelectionType.key, path: ['a'] })
    view.press('Enter')
    view.typeAndEnter(key)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
    expect(view.banner()).toContain(key)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('他の名前への改名は適用する', () => {
    const view = mountForTest({ text: '{"a":1,"b":2}' }, Mode.tree)
    view.editor.select({ type: SelectionType.key, path: ['a'] })
    view.press('Enter')
    view.typeAndEnter('c')
    expect(view.text()).toBe('{"c":1,"b":2}')
    expect(view.changes.length).toBe(1)
  })
})

describe('待っている間', () => {
  it('打鍵で内容が変わったら切り替えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    view.scanner.hold()
    clickMode(view, '表')
    replaceAll(view, '[{"a":2}]')
    view.scanner.release()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe('[{"a":2}]')
  })

  it('別の切り替えと undo を受けない', async () => {
    const view = mountForTest({ text: DOC }, Mode.table)
    clickMode(view, 'テキスト')
    await settled()
    replaceAll(view, '[{"a":2}]')
    view.editor.commitPendingInput()
    await settled()

    view.scanner.hold()
    clickMode(view, '表')
    await settled()
    expect((view.target.querySelector('.jse-undo') as HTMLButtonElement).disabled).toBe(true)
    clickMode(view, 'ツリー')
    view.scanner.release()
    await settled()
    expect(view.modeLabel()).toBe('表')
  })

  it('待っている間に set したら、新しい文書の表示を替えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    view.scanner.hold()
    clickMode(view, '表')
    view.editor.set({ text: '{bad' })
    view.scanner.release()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe('{bad')
  })
})

describe('undo と redo の経路', () => {
  async function tableThenInvalidText(): Promise<Mounted> {
    const view = mountForTest({ text: DOC }, Mode.table)
    clickMode(view, 'テキスト')
    await settled()
    return view
  }

  it('表示の項目の undo は、文書が正しければ通り、redo も通る', async () => {
    const view = await tableThenInvalidText()
    view.clickUndo()
    await settled()
    expect(view.modeLabel()).toBe('表')
    view.clickRedo()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
  })

  it('検査が拒否した undo は表示も履歴も変えない', async () => {
    const view = await tableThenInvalidText()
    view.scanner.results.set(view.text(), {
      duplicateKey: true,
      numericKeyReorder: false,
      reservedKey: false,
      depthExceeded: false,
      syntaxOk: true
    })
    view.clickUndo()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect((view.target.querySelector('.jse-undo') as HTMLButtonElement).disabled).toBe(false)
    expect((view.target.querySelector('.jse-redo') as HTMLButtonElement).disabled).toBe(true)
    view.scanner.results.clear()
    view.clickUndo()
    await settled()
    expect(view.modeLabel()).toBe('表')
  })

  it('不正なテキストのままの undo は打鍵を戻してから表示を戻す', async () => {
    const view = await tableThenInvalidText()
    replaceAll(view, INVALID)
    view.editor.commitPendingInput()
    await settled()
    view.clickUndo()
    view.editor.commitPendingInput()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).not.toBe(INVALID)
    view.clickUndo()
    await settled()
    expect(view.modeLabel()).toBe('表')
  })
})

describe('大文書の警告', () => {
  const BIG = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ index })))
  const SMALL_LIMIT = 100

  const warned = (text: string) =>
    mountForTest({ text }, Mode.text, { maxDocumentSizeTextMode: SMALL_LIMIT })

  const button = (view: Mounted, label: string) =>
    [...view.target.querySelectorAll<HTMLElement>('.jse-message button')].find((element) =>
      element.textContent?.includes(label)
    )

  it('Cancel が無く、文書が空にならない', () => {
    const view = warned(BIG)
    expect(view.target.querySelectorAll('.jse-message button').length).toBe(2)
    expect(view.text()).toBe(BIG)
  })

  it('Open anyway の後の undo は押せず、文書が空にならない', async () => {
    const view = warned(BIG)
    button(view, ja['editor.openAnyWay'])?.click()
    flushSync()
    await settled()
    expect(view.text()).toBe(BIG)
    expect((view.target.querySelector('.jse-undo') as HTMLButtonElement).disabled).toBe(true)
  })

  it('不正な大文書は Open in tree mode で門番に止まる', async () => {
    const text = BIG.slice(0, -1)
    const view = warned(text)
    button(view, ja['editor.openTreeMode'])?.click()
    flushSync()
    await settled()
    expect(view.modeLabel()).toBe('テキスト')
    expect(view.text()).toBe(text)
  })

  it('有効な大文書は Open in tree mode で開ける', async () => {
    const view = warned(BIG)
    button(view, ja['editor.openTreeMode'])?.click()
    flushSync()
    await settled()
    expect(view.modeLabel()).toBe('ツリー')
    expect(view.text()).toBe(BIG)
  })
})

describe('Extract', () => {
  it('表の案内に出ない', () => {
    const view = mountForTest({ text: '{"items":[{"a":1}],"keep":true}' }, Mode.table)
    expect(view.target.textContent).not.toContain(ja['editor.Extract'])
    expect(view.target.querySelector('.jse-nested-array-action')).not.toBeNull()
  })
})
