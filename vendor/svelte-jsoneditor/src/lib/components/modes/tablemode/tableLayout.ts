// JsonGridder: the table layout that the application controls from outside the editor.
// Display only: none of this touches the document, the history or the selection.
import { writable } from 'svelte/store'
import type { JSONPath } from 'immutable-json-patch'

/** The narrowest a column can be dragged (px), so the resize handle and a few characters stay reachable. */
export const MIN_COLUMN_WIDTH = 48

/** Wrap long values inside the cell width ("wrap at window edge"). The last column fills the view. */
export const wrapLines = writable(false)

/** Column widths (px, the whole column) the user dragged. Kept until `resetColumnWidths`. */
export const columnWidths = writable<Record<string, number>>({})

export function resetColumnWidths(): void {
  columnWidths.set({})
}

/** The same column name under another table target is another column. */
export function columnWidthKey(tableTarget: JSONPath, column: JSONPath): string {
  return JSON.stringify([tableTarget, column])
}

export function setColumnWidth(key: string, width: number): void {
  const clamped = Math.max(MIN_COLUMN_WIDTH, Math.round(width))
  columnWidths.update((widths) => ({ ...widths, [key]: clamped }))
}
