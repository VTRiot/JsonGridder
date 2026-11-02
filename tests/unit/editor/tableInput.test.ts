import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import ja from '../../../src/i18n/ja.json'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const REASON = ja['editor.cellCannotAddKey']

beforeAll(installDomStubs)
afterEach(destroyAll)

const table = (text: string): Mounted => mountForTest({ text }, Mode.table)

function pasteText(view: Mounted, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  ;(view.target.querySelector('.jse-hidden-input') as HTMLElement).dispatchEvent(event)
  flushSync()
}

const cellsThatCannotGetAKey: [string, string, string[]][] = [
  ['親が数値', '[{"a":{"b":1}},{"a":5}]', ['a', 'b']],
  ['親が文字列', '[{"a":{"b":1}},{"a":"s"}]', ['a', 'b']],
  ['親が配列', '[{"a":{"b":1}},{"a":[1]}]', ['a', 'b']],
  ['親が null', '[{"a":{"b":1}},{"a":null}]', ['a', 'b']],
  ['親が真偽値', '[{"a":{"b":1}},{"a":true}]', ['a', 'b']],
  ['行が数値', '[{"a":1},5]', ['a']],
  ['行が文字列', '[{"a":1},"s"]', ['a']],
  ['行が null', '[{"a":1},null]', ['a']],
  ['行が配列', '[{"a":1},[9]]', ['a']],
  ['行が数値で入れ子の列', '[{"a":{"b":1}},5]', ['a', 'b']]
]

describe('キーを足せないセル', () => {
  it.each(cellsThatCannotGetAKey)('%s: 打鍵は編集欄を開かず、理由を出す', (_, text, column) => {
    const view = table(text)
    view.select(1, ...column)
    view.press('7')
    expect(view.editors()).toBe(0)
    expect(view.notice()).toBe(REASON)
    view.press('Enter')
    expect(view.editors()).toBe(0)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it.each(cellsThatCannotGetAKey)('%s: Enter は編集欄を開かない', (_, text, column) => {
    const view = table(text)
    view.select(1, ...column)
    view.press('Enter')
    expect(view.editors()).toBe(0)
    expect(view.notice()).toBe(REASON)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it.each(cellsThatCannotGetAKey)('%s: 貼り付けは文書を変えず、理由を出す', (_, text, column) => {
    const view = table(text)
    view.select(1, ...column)
    pasteText(view, '7')
    expect(view.notice()).toBe(REASON)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it.each(cellsThatCannotGetAKey)('%s: { の打鍵は文書を変えず、理由を出す', (_, text, column) => {
    const view = table(text)
    view.select(1, ...column)
    view.press('{')
    expect(view.notice()).toBe(REASON)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it.each(cellsThatCannotGetAKey)('%s: 切り取りと Delete は何もしない', (_, text, column) => {
    const view = table(text)
    view.select(1, ...column)
    view.press('x', { ctrlKey: true })
    view.press('Delete')
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
    expect(view.banner()).toBeNull()
  })

  it('別のセルを選ぶと理由が消える', () => {
    const view = table('[{"a":{"b":1}},{"a":5}]')
    view.select(1, 'a', 'b')
    view.press('Enter')
    expect(view.notice()).toBe(REASON)
    view.select(0, 'a', 'b')
    expect(view.notice()).toBeNull()
  })

  it('別のセルの値を書き換えない', () => {
    const view = table('[{"a":{"b":1}},{"a":5}]')
    view.select(1, 'a')
    expect(view.target.querySelectorAll('.jse-selected-value').length).toBe(1)
    view.select(1, 'a', 'b')
    expect(view.target.querySelectorAll('.jse-selected-value').length).toBe(1)
  })
})

describe('欠けセル', () => {
  const MISSING = '[{"a":1,"b":2},{"a":3}]'
  const NO_PARENT = '[{"a":{"b":1}},{"c":1}]'

  it('無入力で Enter なら文書も onChange も変わらない', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('Enter')
    expect(view.editors()).toBe(1)
    view.press('Enter')
    expect(view.editors()).toBe(0)
    expect(view.text()).toBe(MISSING)
    expect(view.changes).toEqual([])
  })

  it('無入力で Tab なら文書も onChange も変わらない', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('Enter')
    view.press('Tab')
    expect(view.text()).toBe(MISSING)
    expect(view.changes).toEqual([])
  })

  it('親の欠けも無入力なら親を足さない', () => {
    const view = table(NO_PARENT)
    view.select(1, 'a', 'b')
    view.press('Enter')
    view.press('Enter')
    expect(view.text()).toBe(NO_PARENT)
    expect(view.changes).toEqual([])
  })

  it('打って Enter でキーが足され、undo で戻る', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('7')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"a":1,"b":2},{"a":3,"b":7}]')
    expect(view.changes.length).toBe(1)
    view.clickUndo()
    expect(view.text()).toBe(MISSING)
    view.clickRedo()
    expect(view.text()).toBe('[{"a":1,"b":2},{"a":3,"b":7}]')
  })

  it('打ち始めて消したら足さない', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('7')
    view.typeAndEnter('')
    expect(view.text()).toBe(MISSING)
    expect(view.changes).toEqual([])
  })

  it('親の欠けは親ごと足され、undo で戻る', () => {
    const view = table(NO_PARENT)
    view.select(1, 'a', 'b')
    view.press('7')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"a":{"b":1}},{"c":1,"a":{"b":7}}]')
    view.clickUndo()
    expect(view.text()).toBe(NO_PARENT)
  })

  it('Enter で列を縦に歩いても文書が変わらず、下の行へ進む', () => {
    const text = '[{"a":1,"b":2},{"a":3},{"a":4},{"a":5}]'
    const view = table(text)
    view.select(0, 'b')
    const walked = []
    for (let step = 0; step < 8; step++) {
      view.press('Enter')
      walked.push(view.target.querySelector('.jse-selected-value')?.closest('td')?.dataset.path)
    }
    expect(new Set(walked).size).toBeGreaterThan(1)
    expect(view.text()).toBe(text)
    expect(view.changes).toEqual([])
  })

  it('貼り付けはキーを足す', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    pasteText(view, '7')
    expect(view.text()).toBe('[{"a":1,"b":2},{"a":3,"b":7}]')
    view.clickUndo()
    expect(view.text()).toBe(MISSING)
  })

  it('切り取りと Delete は何もしない', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('x', { ctrlKey: true })
    view.press('Delete')
    expect(view.text()).toBe(MISSING)
    expect(view.changes).toEqual([])
    expect(view.banner()).toBeNull()
  })

  it('{ の打鍵も編集を始め、打つまでキーを足さない', () => {
    const view = table(MISSING)
    view.select(1, 'b')
    view.press('{')
    expect(view.target.querySelector('.jse-editable-div')?.textContent).toBe('{')
    expect(view.text()).toBe(MISSING)
  })
})

describe('継承の名前のキー', () => {
  const TEXT = '[{"toString":"x","valueOf":2,"hasOwnProperty":3,"a":1},{"a":2}]'

  it('列が出て、欠けセルが空に見える', () => {
    const view = table(TEXT)
    const heads = [...view.target.querySelectorAll('th.jse-table-cell-header')].map((head) =>
      head.textContent?.trim()
    )
    expect(heads.join()).toContain('toString')
    expect(heads.join()).toContain('valueOf')
    expect(heads.join()).toContain('hasOwnProperty')
    expect(view.cell(1, 'toString').textContent?.trim()).toBe('')
  })

  it('欠けセルへの入力でキーが足され、undo で消える', () => {
    const view = table(TEXT)
    view.select(1, 'toString')
    view.press('7')
    view.typeAndEnter('7')
    expect(view.text()).toBe('[{"toString":"x","valueOf":2,"hasOwnProperty":3,"a":1},{"a":2,"toString":7}]')
    view.clickUndo()
    expect(view.text()).toBe(TEXT)
    view.clickRedo()
    expect(view.text()).toBe('[{"toString":"x","valueOf":2,"hasOwnProperty":3,"a":1},{"a":2,"toString":7}]')
  })

  it('値の無いセルの Delete は onChange を出さない', () => {
    const view = table(TEXT)
    view.select(1, 'valueOf')
    view.press('Delete')
    expect(view.text()).toBe(TEXT)
    expect(view.changes).toEqual([])
  })

  it('欠けセルを開いて閉じても変わらない', () => {
    const view = table(TEXT)
    view.select(1, 'valueOf')
    view.press('Enter')
    view.press('Enter')
    expect(view.text()).toBe(TEXT)
    expect(view.changes).toEqual([])
  })

  it('3 つの表示を回しても文書が変わらない', () => {
    const view = table(TEXT)
    for (const label of ['ツリー', 'テキスト', '表']) {
      ;[...view.target.querySelectorAll<HTMLElement>('.jse-group-button')]
        .find((button) => button.textContent?.trim() === label)
        ?.click()
      flushSync()
    }
    expect(view.text()).toBe(TEXT)
  })
})
