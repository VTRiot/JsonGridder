// JsonGridder: the table header in two rows (step10_001 S6). A nested column (`address.city`) shows its
// first key in the top row, grouped with its neighbours of the same first key, and the rest of the
// path in the bottom row. A column that is not nested spans both rows. The columns, their order and
// the paths that sorting and widths use are not changed: only the header cells are laid out.
import type { JSONPath } from 'immutable-json-patch'
import { stringifyJSONPath } from '$lib/utils/pathUtils.js'

/** A header cell of one column: sorting and the width drag act on `column` (the whole path). */
export interface HeaderColumnCell {
  kind: 'column'
  column: JSONPath
  /** The index of the column in `columns`. */
  columnIndex: number
  /** The shown name. Undefined: the column header shows the whole path, as before. */
  label: string | undefined
}

/** A top cell over the nested columns that share a first key. Clicking it does nothing. */
export interface HeaderGroupCell {
  kind: 'group'
  key: string
  label: string
  colspan: number
}

export interface HeaderRows {
  /** 1 when no column is nested (the header is as before), else 2. */
  rowCount: 1 | 2
  /** The top row: columns that span all rows, and groups. */
  top: (HeaderColumnCell | HeaderGroupCell)[]
  /** The bottom row: the nested columns. Empty when `rowCount` is 1. */
  bottom: HeaderColumnCell[]
}

/** The length of a path from which a column is nested: a parent key and a child key. */
const NESTED_PATH_LENGTH = 2

function isNested(column: JSONPath): boolean {
  return column.length >= NESTED_PATH_LENGTH
}

/**
 * Lay out the header of the table in at most 2 rows.
 * - A path of length 0 or 1 is 1 cell that spans all rows.
 * - A longer path: the top row has its first key, and neighbouring columns with the same first key
 *   share 1 top cell (colspan). The bottom row has the rest of the path, joined with dots when the
 *   path is 3 or more keys deep (`geo.lat`). The header keeps 2 rows, so its height is constant.
 * - The same first key apart from its group (another column between) starts a new group.
 */
export function headerRows(columns: JSONPath[]): HeaderRows {
  if (!columns.some(isNested)) {
    return {
      rowCount: 1,
      top: columns.map((column, columnIndex) => ({ kind: 'column', column, columnIndex, label: undefined })),
      bottom: []
    }
  }

  const top: (HeaderColumnCell | HeaderGroupCell)[] = []
  const bottom: HeaderColumnCell[] = []
  let group: HeaderGroupCell | undefined

  columns.forEach((column, columnIndex) => {
    if (!isNested(column)) {
      group = undefined
      top.push({ kind: 'column', column, columnIndex, label: undefined })
      return
    }

    const [key, ...rest] = column
    if (group !== undefined && group.key === key) {
      group.colspan++
    } else {
      group = { kind: 'group', key, label: stringifyJSONPath([key]), colspan: 1 }
      top.push(group)
    }
    bottom.push({ kind: 'column', column, columnIndex, label: stringifyJSONPath(rest) })
  })

  return { rowCount: 2, top, bottom }
}
