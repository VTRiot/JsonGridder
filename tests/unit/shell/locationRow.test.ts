// 表の場所の行。表の選択を対象の後ろへつなぐこと、無いパスを出さないこと、
// 表のときだけ出すこと（D12）を確かめる。
import { afterEach, describe, expect, it } from 'vitest'
import type { JSONPath } from 'immutable-json-patch'
import { Mode, type JSONEditorSelection } from '$lib/types'
import ja from '../../../src/i18n/ja.json'
import { createLocationRow, tableLocation } from '../../../src/shell/locationRow'

const DOC = { users: [{ id: 1, address: { city: 'Tokyo' } }, { id: 2, address: { city: 'Osaka' } }] }
const value = (path: JSONPath): JSONEditorSelection => ({ type: 'value', path }) as JSONEditorSelection

describe('tableLocation', () => {
  it('表の選択は対象の中のパスなので、対象の後ろへつなぐ', () => {
    expect(tableLocation(DOC, ['users'], value(['1', 'address', 'city']))).toEqual(['users', '1', 'address', 'city'])
  })

  it('選択が無ければ対象だけ', () => {
    expect(tableLocation(DOC, ['users'], undefined)).toEqual(['users'])
  })

  it('複数の選択は動かした側（focus）', () => {
    const multi = { type: 'multi', anchorPath: ['0', 'id'], focusPath: ['1', 'id'] } as unknown as JSONEditorSelection
    expect(tableLocation(DOC, ['users'], multi)).toEqual(['users', '1', 'id'])
  })

  it('今の文書に無いパス（前の表示や前の対象の選択）は出さず、対象だけ', () => {
    expect(tableLocation(DOC, ['users'], value(['users', '0', 'id']))).toEqual(['users'])
    expect(tableLocation(DOC, ['users'], value(['5', 'id']))).toEqual(['users'])
    expect(tableLocation(undefined, ['users'], value(['0', 'id']))).toEqual(['users'])
  })

  it('テキストの選択は使わない', () => {
    const text = { type: 'text', ranges: [{ anchor: 0, head: 1 }], main: 0 } as unknown as JSONEditorSelection
    expect(tableLocation(DOC, ['users'], text)).toEqual(['users'])
  })
})

describe('createLocationRow', () => {
  let mode: Mode = Mode.table
  let target: JSONPath = ['users']
  let selection: JSONEditorSelection | undefined
  const make = () =>
    createLocationRow({ mode: () => mode, tableTarget: () => target, document: () => DOC, selection: () => selection })
  const rendered = () => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    mode = Mode.table
    target = ['users']
    selection = undefined
  })

  it('表では区切りの印でつないだ段を出す', async () => {
    const row = make()
    selection = value(['1', 'address', 'city'])
    row.refresh()
    await rendered()
    expect(row.element.hidden).toBe(false)
    expect([...row.element.querySelectorAll('.app-location-segment')].map((s) => s.textContent)).toEqual(['users', '1', 'address', 'city'])
    expect(row.element.querySelectorAll('.app-location-separator')).toHaveLength(3)
    expect(row.element.getAttribute('aria-label')).toBe(ja['app.location.label'])
  })

  it('根の配列で選択が無ければ「文書全体」', async () => {
    target = []
    const row = make()
    row.refresh()
    await rendered()
    expect(row.element.textContent).toBe(ja['app.target.whole'])
  })

  it.each([Mode.tree, Mode.text])('%s では出さない（ツリーは上流の場所の行、テキストは D12）', async (shown) => {
    mode = shown
    selection = value(['0', 'id'])
    const row = make()
    row.refresh()
    await rendered()
    expect(row.element.hidden).toBe(true)
    expect(row.element.childElementCount).toBe(0)
  })
})
