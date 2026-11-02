import { isJSONArray, isJSONObject, type JSONPath } from 'immutable-json-patch'
import { Mode } from '$lib/types'
import type { SizeClass } from '../document/backend'

/** オブジェクトの行を探す範囲。行を全部歩くと大きな文書で止まる。 */
const SAMPLED_ROWS = 100

export interface TableTarget {
  path: JSONPath
  rows: number
}

export interface DocumentView {
  mode: Mode
  tableTarget: JSONPath
}

function hasObjectRow(rows: unknown[]): boolean {
  return rows.slice(0, SAMPLED_ROWS).some(isJSONObject)
}

/**
 * ルートからオブジェクトのキーだけをたどって届く、長さ 1 以上の配列。配列の中へは入らない。
 * 順位は、先頭の行にオブジェクトがある配列、行の多い順、パスの浅い順、文書の順。
 */
export function findTableTargets(json: unknown): TableTarget[] {
  const found: (TableTarget & { objectRows: boolean })[] = []
  const pending: { value: unknown; path: JSONPath }[] = [{ value: json, path: [] }]

  while (pending.length > 0) {
    const { value, path } = pending.pop() as { value: unknown; path: JSONPath }
    if (isJSONArray(value)) {
      if (path.length > 0 && value.length > 0) {
        found.push({ path, rows: value.length, objectRows: hasObjectRow(value) })
      }
    } else if (isJSONObject(value)) {
      const keys = Object.keys(value)
      for (let index = keys.length - 1; index >= 0; index--) {
        pending.push({ value: value[keys[index]], path: [...path, keys[index]] })
      }
    }
  }

  return found
    .sort(
      (a, b) =>
        Number(b.objectRows) - Number(a.objectRows) ||
        b.rows - a.rows ||
        a.path.length - b.path.length
    )
    .map(({ path, rows }) => ({ path, rows }))
}

/** 文書を開くときの表示。上から順に最初に当たる物。 */
export function chooseView(
  text: string,
  { textOnly, sizeClass }: { textOnly: boolean; sizeClass: SizeClass },
  parse: (text: string) => unknown
): DocumentView {
  const textOr = sizeClass === 'allModes' ? Mode.text : Mode.tree
  if (textOnly) {
    return { mode: textOr, tableTarget: [] }
  }

  let json: unknown
  try {
    json = parse(text)
  } catch {
    return { mode: textOr, tableTarget: [] }
  }

  if (isJSONArray(json)) {
    return { mode: Mode.table, tableTarget: [] }
  }
  const [first] = findTableTargets(json)
  return first ? { mode: Mode.table, tableTarget: first.path } : { mode: Mode.tree, tableTarget: [] }
}
