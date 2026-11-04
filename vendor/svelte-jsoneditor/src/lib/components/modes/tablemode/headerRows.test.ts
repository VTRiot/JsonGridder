import { describe, expect, test } from 'vitest'
import { headerRows, type HeaderColumnCell } from './headerRows.js'

const columnsOf = (cells: { kind: string }[]) =>
  cells.filter((cell): cell is HeaderColumnCell => cell.kind === 'column').map((cell) => cell.column)

describe('headerRows', () => {
  test('no nested column: 1 row as before, the header shows the whole path', () => {
    expect(headerRows([['id'], ['name']])).toEqual({
      rowCount: 1,
      top: [
        { kind: 'column', column: ['id'], columnIndex: 0, label: undefined },
        { kind: 'column', column: ['name'], columnIndex: 1, label: undefined }
      ],
      bottom: []
    })
    expect(headerRows([[]]).rowCount).toBe(1) // an array of values has the column []
    expect(headerRows([]).rowCount).toBe(1)
  })

  test('nested columns: the parent key on top, grouped; the child key below', () => {
    const rows = headerRows([['id'], ['address', 'city'], ['address', 'zip'], ['name']])
    expect(rows.rowCount).toBe(2)
    expect(rows.top).toEqual([
      { kind: 'column', column: ['id'], columnIndex: 0, label: undefined },
      { kind: 'group', key: 'address', label: 'address', colspan: 2 },
      { kind: 'column', column: ['name'], columnIndex: 3, label: undefined }
    ])
    expect(rows.bottom).toEqual([
      { kind: 'column', column: ['address', 'city'], columnIndex: 1, label: 'city' },
      { kind: 'column', column: ['address', 'zip'], columnIndex: 2, label: 'zip' }
    ])
  })

  test('3 or more keys deep: still 2 rows, the rest of the path joined with dots', () => {
    const rows = headerRows([['address', 'geo', 'lat'], ['address', 'geo', 'lng'], ['address', 'city']])
    expect(rows.rowCount).toBe(2)
    expect(rows.top).toEqual([{ kind: 'group', key: 'address', label: 'address', colspan: 3 }])
    expect(rows.bottom.map((cell) => cell.label)).toEqual(['geo.lat', 'geo.lng', 'city'])
  })

  test('the same first key apart from its group starts a new group', () => {
    const rows = headerRows([['a', 'x'], ['b'], ['a', 'y']])
    expect(rows.top.map((cell) => (cell.kind === 'group' ? `${cell.key}*${cell.colspan}` : cell.column.join('.')))).toEqual([
      'a*1',
      'b',
      'a*1'
    ])
  })

  test('keys that need quoting are shown as the column header shows them', () => {
    const rows = headerRows([['a.b', 'c'], ['items', '0']])
    expect(rows.top.map((cell) => (cell.kind === 'group' ? cell.label : ''))).toEqual(['["a.b"]', 'items'])
    expect(rows.bottom.map((cell) => cell.label)).toEqual(['c', '[0]'])
  })

  test('every column appears exactly once, in the same order and with its whole path (sorting and widths)', () => {
    const columns = [['id'], ['address', 'city'], ['tags'], ['address', 'zip'], ['geo', 'a', 'b'], ['name']]
    const rows = headerRows(columns)
    const cells = [...rows.top, ...rows.bottom].filter((cell): cell is HeaderColumnCell => cell.kind === 'column')
    const byIndex = [...cells].sort((a, b) => a.columnIndex - b.columnIndex)
    expect(byIndex.map((cell) => cell.column)).toEqual(columns)
    expect(byIndex.map((cell) => cell.columnIndex)).toEqual(columns.map((_, index) => index))
    expect(columnsOf(rows.bottom)).toEqual([['address', 'city'], ['address', 'zip'], ['geo', 'a', 'b']])
    // the top row covers every column once: spanning cells count 1, groups count their colspan
    const covered = rows.top.reduce((sum, cell) => sum + (cell.kind === 'group' ? cell.colspan : 1), 0)
    expect(covered).toBe(columns.length)
  })
})
