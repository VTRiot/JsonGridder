import { getIn, isJSONArray, isJSONObject, type JSONPath } from 'immutable-json-patch'
import type { TranslateItem } from './ports'

/**
 * 翻訳に送る値を文書から集める（純関数。文書を読むだけで、書き換えない）。
 *
 * 送るのは空白だけでない文字列だけ。数、真偽値、null、空の文字列、オブジェクト、配列は送らない。
 * Rust も集め方を信じず、空の文字列を拒み、件数と文字数に上限を置く（T2）。
 */

/** 送る 1 件。`path` は文書の中のパス（表の対象の前に付けた物）。`label` は小窓に出す場所。 */
export interface SourceItem {
  path: JSONPath
  label: string
  text: string
}

/** 送る前の確かめに出す数。文字数は重複を除いた後の Unicode のコードポイントで数える（Rust と同じ数え方）。 */
export interface SourceSummary {
  total: number
  unique: number
  chars: number
}

/** パスを小窓に出す形（場所の行と同じ並び）。 */
const PATH_SEPARATOR = ' > '

export function isTranslatable(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function pathLabel(path: JSONPath): string {
  return path.join(PATH_SEPARATOR)
}

/**
 * 表の列の全行の値。`tableTarget` は表の対象の配列、`column` は要素の中のパス（見出しの `data-column-path`）。
 * 要素がオブジェクトでない行、列の値が送れない行は飛ばす。`label` は行の番号（表の行番号と同じ 0 始まり）。
 */
export function collectColumn(document: unknown, tableTarget: JSONPath, column: JSONPath): SourceItem[] {
  const rows = tableTarget.length > 0 && document !== undefined ? getIn(document, tableTarget) : document
  if (!isJSONArray(rows) || column.length === 0) {
    return []
  }
  const items: SourceItem[] = []
  rows.forEach((row, index) => {
    if (!isJSONObject(row)) {
      return
    }
    const value = getIn(row, column)
    if (isTranslatable(value)) {
      items.push({ path: [...tableTarget, String(index), ...column], label: String(index), text: value })
    }
  })
  return items
}

/** 1 つの値（表のセルかツリーの値）。送れない値なら空。 */
export function collectValue(document: unknown, path: JSONPath): SourceItem[] {
  if (document === undefined) {
    return []
  }
  const value = path.length === 0 ? document : getIn(document, path)
  return isTranslatable(value) ? [{ path, label: pathLabel(path), text: value }] : []
}

export function summarize(items: readonly { text: string }[]): SourceSummary {
  const unique = new Set(items.map((item) => item.text))
  let chars = 0
  for (const text of unique) {
    chars += [...text].length
  }
  return { total: items.length, unique: unique.size, chars }
}

/** Rust へ渡す形。`id` は小窓の行の番号。同じ文字列は Rust が 1 回だけ送り、全部の番号へ配る。 */
export function toRequest(items: readonly { text: string }[], ids?: readonly number[]): TranslateItem[] {
  return items.map((item, index) => ({ id: ids?.[index] ?? index, text: item.text }))
}
