// 打った文字、見えている値、文書が一致すること。実キーの確かめは tests/browser にある。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mode, SelectionType, type Content } from '$lib/types'
import { isTextContent } from '$lib/utils/jsonUtils'
import { stringify } from 'lossless-json'
import ja from '../../../src/i18n/ja.json'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const REASON = ja['editor.cellCannotAddKey']

beforeAll(() => {
  installDomStubs()
  ;(navigator as unknown as Record<string, unknown>).clipboard = {
    writeText: vi.fn(async () => {}),
    readText: vi.fn(async () => '')
  }
})
afterEach(destroyAll)

const table = (text: string): Mounted => mountForTest({ text }, Mode.table)
const tree = (text: string): Mounted => mountForTest({ text }, Mode.tree)
const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve))
  flushSync()
}

function pasteText(view: Mounted, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  ;(view.target.querySelector('.jse-hidden-input') as HTMLElement).dispatchEvent(event)
  flushSync()
}

const down = (element: Element): void => {
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
  flushSync()
}

function openEditorWithFocus(view: Mounted, row: number, column: string): HTMLElement {
  view.select(row, column)
  view.press('Enter')
  const editor = view.target.querySelector('.jse-editable-div') as HTMLElement
  editor.focus()
  return editor
}

const lastText = (changes: Content[]): string => {
  const last = changes[changes.length - 1]
  return isTextContent(last) ? last.text : String(stringify(last.json))
}

const TYPED = ['C:\\new', 'C:\\temp', 'C:\\temp\\report', 'a\\\\b', '\\n', 'a\\nb', '\\"q\\"']

describe('打った文字は打ったとおりに入る', () => {
  it.each(TYPED)('表のセル: %s', (typed) => {
    const view = table('[{"p":"old"}]')
    view.select(0, 'p')
    view.press('Enter')
    view.typeAndEnter(typed)
    expect(JSON.parse(view.text())[0].p).toBe(typed)
    expect(view.cell(0, 'p').textContent?.trim()).toBe(typed)
  })

  it.each(TYPED)('ツリーの値: %s', (typed) => {
    const view = tree('{"p":"old"}')
    view.editor.select({ type: SelectionType.value, path: ['p'] })
    view.press('Enter')
    view.typeAndEnter(typed)
    expect(JSON.parse(view.text()).p).toBe(typed)
  })

  it.each(TYPED)('ツリーのキー: %s', (typed) => {
    const view = tree('{"p":"old"}')
    view.editor.select({ type: SelectionType.key, path: ['p'] })
    view.press('Enter')
    view.typeAndEnter(typed)
    expect(Object.keys(JSON.parse(view.text()))).toEqual([typed])
  })

  it('バックスラッシュの値はそのまま見える', () => {
    const view = table(String.raw`[{"p":"C:\\Users\\x"}]`)
    expect(view.cell(0, 'p').textContent?.trim()).toBe('C:\\Users\\x')
  })

  it('開いた編集欄に元の値がそのまま入る', () => {
    const view = table(String.raw`[{"p":"C:\\new"}]`)
    view.select(0, 'p')
    view.press('Enter')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('C:\\new')
  })

  it.each(['a\r\nb', 'a\rb', 'x\r', '\r', 'a\nb', 'x\n', 'a\tb', 'a\u0001b'])(
    '制御文字の値 %j は編集欄に元の文字のまま入る',
    (value) => {
      const text = JSON.stringify([{ s: value }])
      const view = table(text)
      view.select(0, 's')
      view.press('Enter')
      const editor = view.target.querySelector('.jse-editable-div') as HTMLElement
      expect(editor.firstChild?.nodeType).toBe(Node.TEXT_NODE)
      expect((editor.textContent as string).replace(/\n$/, '').startsWith(value)).toBe(true)
      view.press('Enter')
      expect(view.text()).toBe(text)
      expect(view.changes).toEqual([])
    }
  )
})

describe('配列の要素のセル', () => {
  const STRING_ITEMS = '[{"a":{"0":"x"}},{"a":["y","z"]}]'
  const ROW_ARRAY = '[{"0":"x"},["y","z"]]'
  const DEEP = '[{"a":{"b":{"0":1.0}}},{"a":{"b":[7,8]}}]'

  it.each([
    [STRING_ITEMS, ['a', '0'], 'y'],
    [ROW_ARRAY, ['0'], 'y'],
    [DEEP, ['a', 'b', '0'], '7']
  ])('%s: 値が見える', (text, column, shown) => {
    const view = table(text)
    expect(view.cell(1, ...column).textContent?.trim()).toBe(shown)
  })

  it('開いた編集欄に値が入り、理由が出ず、入力が入る', () => {
    const view = table(STRING_ITEMS)
    view.select(1, 'a', '0')
    view.press('Enter')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('y')
    expect(view.notice()).toBeNull()
    view.typeAndEnter('w')
    expect(view.text()).toBe('[{"a":{"0":"x"}},{"a":["w","z"]}]')
  })

  it('打鍵で編集に入れる', () => {
    const view = table(STRING_ITEMS)
    view.select(1, 'a', '0')
    view.press('w')
    expect(view.editors()).toBe(1)
    expect(view.notice()).toBeNull()
  })

  it('配列の範囲の外のセルは値が無く、足せない', () => {
    const text = '[{"a":{"3":1}},{"a":[5]}]'
    const view = table(text)
    expect(view.cell(1, 'a', '3').textContent?.trim()).toBe('')
    view.select(1, 'a', '3')
    view.press('Delete')
    view.press('x', { ctrlKey: true })
    view.press('Enter')
    expect(view.editors()).toBe(0)
    expect(view.notice()).toBe(REASON)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it('文字列の中の添字は値ではない', () => {
    const text = '[{"0":1},"abc"]'
    const view = table(text)
    expect(view.cell(1, '0').textContent?.trim()).toBe('')
    view.select(1, '0')
    view.press('Delete')
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it('オブジェクトの要素のセルは開ける', () => {
    const view = table('[{"a":{"0":1}},{"a":[{"k":9}]}]')
    expect(view.cell(1, 'a', '0').textContent).toContain('{"k":9}')
  })
})

describe('キー名 -', () => {
  function rename(text: string, from: string, to: string): Mounted {
    const view = tree(text)
    view.editor.select({ type: SelectionType.key, path: [from] })
    view.press('Enter')
    view.typeAndEnter(to)
    return view
  }

  it('改名で隣の - が残る', () => {
    const view = rename('{"a":1.0,"-":2,"b":3}', 'a', 'z')
    expect(view.text()).toBe('{"z":1.0,"-":2,"b":3}')
    view.clickUndo()
    expect(view.text()).toBe('{"a":1.0,"-":2,"b":3}')
    view.clickRedo()
    expect(view.text()).toBe('{"z":1.0,"-":2,"b":3}')
  })

  it('- への改名', () => {
    const view = rename('{"a":1.0,"b":2}', 'b', '-')
    expect(view.text()).toBe('{"a":1.0,"-":2}')
    view.clickUndo()
    expect(view.text()).toBe('{"a":1.0,"b":2}')
  })

  it('複製で隣の - が残る', () => {
    const view = tree('{"a":1.0,"-":2,"b":3}')
    view.editor.select({
      type: SelectionType.multi,
      anchorPath: ['a'],
      focusPath: ['a']
    })
    view.press('d', { ctrlKey: true })
    expect(view.text()).toBe('{"a":1.0,"a (copy)":1.0,"-":2,"b":3}')
  })

  it('既存の - のセルへの入力', () => {
    const view = table('[{"-":1.0,"b":2}]')
    view.select(0, '-')
    view.press('Enter')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"-":7,"b":2}]')
    expect(view.changes.length).toBe(1)
    view.clickUndo()
    expect(view.text()).toBe('[{"-":1.0,"b":2}]')
  })

  it('欠けセルへの入力と貼り付けは - のキーを足す', () => {
    const view = table('[{"-":1.0},{"b":2}]')
    view.select(1, '-')
    view.press('Enter')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"-":1.0},{"b":2,"-":7}]')
    view.clickUndo()
    expect(view.text()).toBe('[{"-":1.0},{"b":2}]')
    view.clickRedo()
    expect(view.text()).toBe('[{"-":1.0},{"b":2,"-":7}]')

    const pasted = table('[{"-":1.0},{"b":2}]')
    pasted.select(1, '-')
    pasteText(pasted, '9')
    expect(pasted.text()).toBe('[{"-":1.0},{"b":2,"-":9}]')
  })

  it('親の欠けと、親のキーが - の列', () => {
    const view = table('[{"a":{"-":1.0}},{"b":2}]')
    view.select(1, 'a', '-')
    view.press('Enter')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"a":{"-":1.0}},{"b":2,"a":{"-":7}}]')

    const parent = table('[{"-":{"x":1.0}},{"z":2}]')
    parent.select(1, '-', 'x')
    parent.press('Enter')
    parent.typeAndEnter('7')
    expect(parent.text()).toBe('[{"-":{"x":1.0}},{"z":2,"-":{"x":7}}]')
    expect(parent.banner()).toBeNull()
  })

  it('Delete で - のキーが消える', () => {
    const view = table('[{"-":1.0,"b":2}]')
    view.select(0, '-')
    view.press('Delete')
    expect(view.text()).toBe('[{"b":2}]')
    view.clickUndo()
    expect(view.text()).toBe('[{"-":1.0,"b":2}]')
  })
})

describe('継承の名前の読み', () => {
  it('Enforce string は値の無いセルで押せず、文書を変えない', async () => {
    const text = '[{"toString":"x","a":1},{"a":3}]'
    const view = table(text)
    view.select(1, 'toString')
    await settled()
    const pointer = view.target.querySelector('.jse-context-menu-pointer') as HTMLElement
    down(pointer)
    pointer.click()
    await settled()
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent?.trim() === ja['editor.enforceString']
    ) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    button.click()
    await settled()
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it('値の無いセルのコピーは関数の文字列を出さない', async () => {
    const view = table('[{"toString":1},{"a":2}]')
    view.select(1, 'toString')
    view.press('c', { ctrlKey: true })
    await settled()
    const write = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>
    expect(write.mock.calls.flat().join()).not.toContain('native code')
  })

  it('Enter は継承の値をオブジェクトと見なさない', () => {
    const view = table('[{"toString":1},{"a":2}]')
    view.select(1, 'toString')
    view.press('Enter')
    expect(view.editors()).toBe(1)
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('')
  })
})

describe('離れたら編集欄は閉じる', () => {
  const DOC = '[{"a":"x"},{"a":"y"}]'

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true) // jsdom の既定は false
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['メニューの余白', '.jse-menu'],
    ['表の余白', '.jse-contents']
  ])('%s を押すと閉じる', (_, selector) => {
    const view = table(DOC)
    openEditorWithFocus(view, 0, 'a')
    down(view.target.querySelector(selector) as Element)
    expect(view.editors()).toBe(0)
    expect(view.text()).toBe(DOC)
    expect(view.changes).toEqual([])
  })

  it('別のセルを押すとそのセルが選ばれる', () => {
    const view = table(DOC)
    openEditorWithFocus(view, 0, 'a')
    view.select(1, 'a')
    expect(view.editors()).toBe(0)
    expect(view.cell(1, 'a').querySelector('.jse-selected-value')).not.toBeNull()
  })

  it('打ってから離れると値が入る', () => {
    const view = table(DOC)
    const editor = openEditorWithFocus(view, 0, 'a')
    editor.textContent = 'TYPED'
    down(view.target.querySelector('.jse-menu') as Element)
    expect(view.editors()).toBe(0)
    expect(view.text()).toBe('[{"a":"TYPED"},{"a":"y"}]')
  })

  it('ツリーの値とキーも閉じる', () => {
    const view = tree('{"a":"x","b":"y"}')
    view.editor.select({ type: SelectionType.value, path: ['a'] })
    view.press('Enter')
    ;(view.target.querySelector('.jse-editable-div') as HTMLElement).focus()
    down(view.target.querySelector('.jse-menu') as Element)
    expect(view.editors()).toBe(0)

    view.editor.select({ type: SelectionType.key, path: ['a'] })
    view.press('Enter')
    ;(view.target.querySelector('.jse-editable-div') as HTMLElement).focus()
    down(view.target.querySelector('.jse-menu') as Element)
    expect(view.editors()).toBe(0)
    expect(view.changes).toEqual([])
  })

  it('窓のフォーカスが移っただけなら開いたまま', () => {
    const view = table(DOC)
    const editor = openEditorWithFocus(view, 0, 'a')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    editor.blur()
    flushSync()
    expect(view.editors()).toBe(1)
  })

  it('並べ替えの後に古いパスへ書かない', () => {
    const view = table('[{"a":"z","id":1},{"a":"b","id":2},{"a":"m","id":3}]')
    openEditorWithFocus(view, 0, 'a')
    const header = view.target.querySelector('.jse-column-header') as HTMLElement
    down(header)
    header.click()
    flushSync()
    expect(view.editors()).toBe(0)
    expect(view.text()).toBe('[{"a":"b","id":2},{"a":"m","id":3},{"a":"z","id":1}]')
  })
})

describe('画面の外の選択への打鍵', () => {
  const rows = (): string => JSON.stringify(Array.from({ length: 200 }, (_, a) => ({ a })))

  function scrollAway(view: Mounted): void {
    const contents = view.target.querySelector('.jse-contents') as HTMLElement
    contents.scrollTop = 2000
    contents.dispatchEvent(new Event('scroll'))
    flushSync()
  }

  it('打鍵で対象のセルへ戻り、編集欄が開く', () => {
    const view = table(rows())
    view.select(5, 'a')
    scrollAway(view)
    expect(view.cell(5, 'a')).toBeNull()
    view.press('a')
    expect(view.cell(5, 'a')).not.toBeNull()
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('a')
  })

  it('Enter も対象のセルへ戻る', () => {
    const view = table(rows())
    view.select(5, 'a')
    scrollAway(view)
    view.press('Enter')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('5')
  })

  it('確定で打った文字が文書へ入る', () => {
    const view = table(rows())
    view.select(5, 'a')
    scrollAway(view)
    ;(view.target.querySelector('.jse-hidden-input') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    )
    view.editor.commitPendingInput()
    expect(JSON.parse(view.text())[5].a).toBe('a')
    expect(lastText(view.changes)).toContain('"a":"a"')
  })
})

describe('[ と { も普通の文字として編集を始める', () => {
  const pressKey = (view: Mounted, key: string): void => {
    ;(view.target.querySelector('.jse-hidden-input') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    )
    flushSync()
  }

  it.each(['[', '{'])('表のセルへ %s を打つと編集欄が開き、値は変わらない', (char) => {
    const view = table('[{"s":"keep me"},{"s":"other"}]')
    view.select(0, 's')
    pressKey(view, char)
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe(char)
    expect(view.text()).toBe('[{"s":"keep me"},{"s":"other"}]')
  })

  it.each(['1', 'true', 'null'])('表の %s のセルも同じ', (literal) => {
    const text = `[{"s":${literal}}]`
    const view = table(text)
    view.select(0, 's')
    pressKey(view, '[')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('[')
    expect(view.text()).toBe(text)
  })

  it('欠けセルでもキーが足されない', () => {
    const view = table('[{"s":"a","t":1},{"s":"b"}]')
    view.select(1, 't')
    pressKey(view, '[')
    expect(view.text()).toBe('[{"s":"a","t":1},{"s":"b"}]')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('[')
  })

  it.each(['[', '{'])('表の配列のセルへ %s を打っても値が替わらない', (char) => {
    const text = '[{"s":[1,2]}]'
    const view = table(text)
    view.select(0, 's')
    pressKey(view, char)
    expect(view.text()).toBe(text)
  })

  it.each(['[', '{'])('ツリーの値へ %s を打つと編集欄が開く', (char) => {
    const text = '{"s":"keep me"}'
    const view = tree(text)
    view.editor.select({ type: SelectionType.value, path: ['s'] })
    flushSync()
    pressKey(view, char)
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe(char)
    expect(view.text()).toBe(text)
  })

  it('ツリーのオブジェクトの値へ [ を打っても値が替わらない', () => {
    const text = '{"s":{"a":1}}'
    const view = tree(text)
    view.editor.select({ type: SelectionType.value, path: ['s'] })
    flushSync()
    pressKey(view, '[')
    expect(view.text()).toBe(text)
  })

  it('ツリーのキーの後ろの [ は構造の挿入のまま', async () => {
    const view = tree('{"s":1}')
    view.editor.select({ type: SelectionType.after, path: ['s'] })
    flushSync()
    pressKey(view, '[')
    await settled()
    expect(view.text()).toContain('[')
  })
})

describe('編集欄を離れた後の打鍵', () => {
  const hidden = (view: Mounted) => view.target.querySelector('.jse-hidden-input')

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true) // jsdom の既定は false
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('表: フォーカスの行き先が無ければ表へ戻る', async () => {
    const view = table('[{"a":"x"},{"a":"y"}]')
    const editable = openEditorWithFocus(view, 0, 'a')
    editable.blur()
    flushSync()
    await settled()
    expect(view.target.querySelector('.jse-editable-div')).toBeNull()
    expect(document.activeElement).toBe(hidden(view))
  })

  it('表: 別の入力へ移ったフォーカスは奪わない', async () => {
    const view = table('[{"a":"x"},{"a":"y"}]')
    const other = document.createElement('input')
    document.body.append(other)
    const editable = openEditorWithFocus(view, 0, 'a')
    expect(editable).toBeTruthy()
    other.focus()
    flushSync()
    await settled()
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('ツリー: フォーカスの行き先が無ければツリーへ戻る', async () => {
    const view = tree('{"a":"x"}')
    view.editor.select({ type: SelectionType.value, path: ['a'], edit: true } as never)
    flushSync()
    const editable = view.target.querySelector('.jse-editable-div') as HTMLElement
    editable.focus()
    editable.blur()
    flushSync()
    await settled()
    expect(view.target.querySelector('.jse-editable-div')).toBeNull()
    expect(document.activeElement).toBe(hidden(view))
  })
})

describe('貼り付け', () => {
  const DOC = '[{"a":"old","b":2},{"a":"o2"}]'

  it.each([
    ['hello, world', 'hello, world'],
    ['a: 1, b: 2', 'a: 1, b: 2'],
    ['1,2', '1,2'],
    ['"x', '"x'],
    ['[1,2', '[1,2'],
    ['{a:1}', '{a:1}'],
    ['hello,', 'hello,'],
    ['hello\nworld', 'hello\nworld'],
    [' ', ' '],
    ['\n', '\n'],
    ['\t', '\t'],
    ['   ', '   ']
  ])('%j は文字列のまま入る', (pasted, expected) => {
    const view = table(DOC)
    view.select(0, 'a')
    pasteText(view, pasted)
    expect(JSON.parse(view.text())[0].a).toBe(expected)
    expect(view.changes.length).toBe(1)
  })

  it.each([
    ['1.50', '1.50'],
    ['"quoted"', '"quoted"'],
    ['null', 'null'],
    ['{"k":1}', '{"k":1}'],
    ['[1,2]', '[1,2]']
  ])('正しい JSON の %s は値になる', (pasted, expected) => {
    const view = table(DOC)
    view.select(0, 'a')
    pasteText(view, pasted)
    expect(view.text()).toBe(`[{"a":${expected},"b":2},{"a":"o2"}]`)
  })

  it('空のクリップボードは何もしない', () => {
    const view = table(DOC)
    view.select(0, 'a')
    pasteText(view, '')
    expect(view.text()).toBe(DOC)
    expect(view.changes).toEqual([])
  })

  it('空白だけを選択なしで貼っても文書を替えない', () => {
    const view = table(DOC)
    pasteText(view, '  ')
    expect(view.text()).toBe(DOC)
    expect(view.changes).toEqual([])
  })

  it('ツリーの値も同じ', () => {
    const view = tree('{"a":1,"b":2}')
    view.editor.select({ type: SelectionType.value, path: ['b'] })
    pasteText(view, 'hello, world')
    expect(view.text()).toBe('{"a":1,"b":"hello, world"}')
    view.editor.select({ type: SelectionType.value, path: ['a'] })
    pasteText(view, ' ')
    expect(view.text()).toBe('{"a":" ","b":"hello, world"}')
  })

  it('欠けセルへの "" はキーを足す', () => {
    const view = table('[{"a":1,"b":2},{"a":3}]')
    view.select(1, 'b')
    pasteText(view, '""')
    expect(view.text()).toBe('[{"a":1,"b":2},{"a":3,"b":""}]')
    expect(view.changes.length).toBe(1)
  })

  it('親の欠けへの "" も足す', () => {
    const view = table('[{"a":{"b":1}},{"c":1}]')
    view.select(1, 'a', 'b')
    pasteText(view, '""')
    expect(view.text()).toBe('[{"a":{"b":1}},{"c":1,"a":{"b":""}}]')
  })

  it('打ってから消した欠けセルにキーを足さない', () => {
    const text = '[{"a":1,"b":2},{"a":3}]'
    const view = table(text)
    view.select(1, 'b')
    view.press('7')
    view.typeAndEnter('')
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })
})
