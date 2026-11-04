// 状態の行。出す物と、意味の無い場面で出さない物（D12）を確かめる。
import { afterEach, describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import type { Encoding, TextFormat } from '../../../src/document/backend'
import type { DocumentStatus } from '../../../src/document/model'
import { setLanguage } from '../../../src/i18n'
import { createStatusRow, statusItems, type StatusSource } from '../../../src/shell/statusRow'

const FORMAT: TextFormat = { eol: 'lf', eolDominant: 'lf', indent: { kind: 'spaces', count: 2 }, finalNewline: true }

interface Shape {
  base?: { encoding: Encoding; bom: boolean; format: TextFormat } | null
  status?: Partial<DocumentStatus>
  mode?: Mode
  rows?: number
}

function source({ base = { encoding: 'utf8', bom: false, format: FORMAT }, status = {}, mode = Mode.tree, rows }: Shape): StatusSource {
  return {
    baseline: () => base,
    status: () => ({ unsaved: false, saveBlocked: false, path: base ? '/a.json' : null, ...status }),
    view: () => ({ mode, tableTarget: [] }),
    rows: () => rows
  }
}

const shown = (shape: Shape): Record<string, string> =>
  Object.fromEntries(statusItems(source(shape)).map(({ name, text }) => [name, text]))

afterEach(() => setLanguage('ja'))

describe('出す物', () => {
  it('開いたファイル: 文字コード、改行、保存済み', () => {
    expect(shown({})).toEqual({ encoding: 'UTF-8', eol: 'LF', save: '保存済み' })
  })

  it('BOM 付きは付記する', () => {
    expect(shown({ base: { encoding: 'utf8', bom: true, format: FORMAT } }).encoding).toBe('UTF-8（BOM 付き）')
  })

  it('改行の 4 つの形', () => {
    const eol = (value: TextFormat['eol']) => shown({ base: { encoding: 'shiftJis', bom: false, format: { ...FORMAT, eol: value } } }).eol
    expect([eol('crlf'), eol('lf'), eol('cr'), eol('mixed')]).toEqual(['CRLF', 'LF', 'CR', '改行が混在'])
  })

  it('表では今の対象の件数を、区切りを付けて出す', () => {
    expect(shown({ mode: Mode.table, rows: 1204 }).rows).toBe('1,204 件')
  })

  it('未保存、保存を止めている', () => {
    expect(shown({ status: { unsaved: true } }).save).toBe('未保存')
    expect(shown({ status: { unsaved: true, saveBlocked: true } }).save).toBe('保存を止めています')
  })

  it('英語', () => {
    setLanguage('en')
    expect(shown({ mode: Mode.table, rows: 3 })).toEqual({ encoding: 'UTF-8', eol: 'LF', rows: '3 rows', save: 'Saved' })
  })
})

describe('意味の無い表示を出さない（D12）', () => {
  it('ツリーとテキストでは件数を出さない（テキストでしか開けない文書を含む）', () => {
    expect(shown({ mode: Mode.tree, rows: 5 }).rows).toBeUndefined()
    expect(shown({ mode: Mode.text, rows: 5 }).rows).toBeUndefined()
  })

  it('表でも対象が配列でなければ件数を出さない', () => {
    expect(shown({ mode: Mode.table, rows: undefined }).rows).toBeUndefined()
  })

  it('1 行の文書は改行を出さない', () => {
    expect(shown({ base: { encoding: 'utf8', bom: false, format: { ...FORMAT, eol: 'none' } } }).eol).toBeUndefined()
  })

  it('無題の文書は文字コードと改行を出さず、未編集なら保存の状態も出さない', () => {
    expect(shown({ base: null })).toEqual({})
    expect(shown({ base: null, status: { unsaved: true } })).toEqual({ save: '未保存' })
  })
})

describe('行の部品', () => {
  it('refresh の後のタスクで描き、保存済みには印を付ける', async () => {
    const row = createStatusRow(source({ mode: Mode.table, rows: 2 }))
    row.refresh()
    expect(row.element.children).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const items = [...row.element.querySelectorAll<HTMLElement>('.app-status-item')]
    expect(items.map((item) => item.dataset.item)).toEqual(['encoding', 'eol', 'rows', 'save'])
    expect(items.map((item) => item.textContent)).toEqual(['UTF-8', 'LF', '2 件', '保存済み'])
    expect(items[3].classList.contains('is-saved')).toBe(true)
    expect(items[3].querySelector('svg')).not.toBeNull()
  })
})
