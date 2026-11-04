import {
  compileJSONPointer,
  getIn,
  isJSONArray,
  isJSONObject,
  type JSONPatchAdd,
  type JSONPath
} from 'immutable-json-patch'
import { Mode } from '$lib/types'
import { format, t } from '../i18n'
import type { AskRequest } from './ports'

/**
 * 訳を新しい列として足す（JSON に書く翻訳の唯一の経路）。
 *
 * 操作は JSON Patch の `add` だけで、エディタの公開の `patch` を 1 回だけ呼ぶ（履歴 1 件。元に戻す 1 回で
 * 全部戻る。R4）。`replace` と `remove` は作らない。足す名前は表の対象の全行で空いている物（R2、I16、I17）。
 * 行ごとに、文書の今の値が送った時の原文と同じことを確かめ、違う行には足さない（R3）。
 */

/** 列から訳したときの出どころ。`column` は表の対象の要素の中のパス（見出しの `data-column-path`）。 */
export interface ColumnSource {
  tableTarget: JSONPath
  column: JSONPath
}

/** 足す候補の 1 行。`path` は送った値の文書の中のパス、`translation` は訳せなかった行で null。 */
export interface ColumnEntry {
  path: JSONPath
  original: string
  translation: string | null
}

/** 足さなかった行の理由。 */
export type SkipReason = 'notTranslated' | 'changed' | 'notObject'

export interface ColumnPlan {
  /** 足す列の名前（キー）。 */
  key: string
  /** 足す列の、要素の中のパス（元の列と同じ親）。 */
  newColumn: JSONPath
  operations: JSONPatchAdd[]
  skipped: Record<SkipReason, number>
}

/** 名前の重なりを避ける番号の始まり。`_ja` の次は `_ja_2`。 */
const FIRST_SUFFIX_NUMBER = 2

function parentOf(path: JSONPath): JSONPath {
  return path.slice(0, -1)
}

/**
 * 足す列の名前。元のキー名に `_{翻訳先}` を付ける。表の対象のどれかの行（の親のオブジェクト）に同じ名前が
 * あれば `_{翻訳先}_2`、`_3` … と、全行で空いている名前にする。
 */
export function newColumnKey(rows: readonly unknown[], column: JSONPath, target: string): string {
  const parentPath = parentOf(column)
  const base = `${column[column.length - 1]}_${target}`
  const taken = (key: string): boolean =>
    rows.some((row) => {
      if (!isJSONObject(row)) {
        return false
      }
      const parent = parentPath.length === 0 ? row : getIn(row, parentPath)
      return isJSONObject(parent) && Object.hasOwn(parent, key)
    })
  if (!taken(base)) {
    return base
  }
  let number = FIRST_SUFFIX_NUMBER
  while (taken(`${base}_${number}`)) {
    number++
  }
  return `${base}_${number}`
}

/**
 * 足す操作を作る（純関数。文書は読むだけ）。訳の無い行、今の値が原文と違う行、親がオブジェクトでない行は
 * 足さず、理由ごとに数える。足す名前は今の文書の全行で空いている。
 */
export function planColumn(
  document: unknown,
  source: ColumnSource,
  entries: readonly ColumnEntry[],
  target: string
): ColumnPlan {
  const skipped: Record<SkipReason, number> = { notTranslated: 0, changed: 0, notObject: 0 }
  const rowsValue = source.tableTarget.length > 0 && document !== undefined ? getIn(document, source.tableTarget) : document
  const rows = isJSONArray(rowsValue) ? rowsValue : []
  const key = newColumnKey(rows, source.column, target)
  const newColumn = [...parentOf(source.column), key]
  const operations: JSONPatchAdd[] = []
  for (const entry of entries) {
    if (entry.translation === null) {
      skipped.notTranslated++
      continue
    }
    const current = document === undefined ? undefined : getIn(document, entry.path)
    if (current !== entry.original) {
      skipped.changed++
      continue
    }
    const parent = getIn(document, parentOf(entry.path))
    if (!isJSONObject(parent) || Object.hasOwn(parent, key)) {
      skipped.notObject++
      continue
    }
    operations.push({ op: 'add', path: compileJSONPointer([...parentOf(entry.path), key]), value: entry.translation })
  }
  return { key, newColumn, operations, skipped }
}

export function skippedCount(plan: ColumnPlan): number {
  return plan.skipped.notTranslated + plan.skipped.changed + plan.skipped.notObject
}

/** 確かめのボタン（足す）と取り消し。既定は取り消し。 */
const ACCEPT_BUTTON = 0
const CANCEL_BUTTON = 1

export interface ApplyColumnOptions {
  ask(request: AskRequest): Promise<number>
  /** エディタのモーダルか殻のダイアログが開いている。 */
  hasOpenModal(): boolean
  /** 主のエディタの今の表示。 */
  mode(): Mode
  /** 主のエディタの今の表の対象。 */
  tableTarget(): JSONPath
  /** 表の対象を替える（表の表示のとき、出どころの表へ戻す）。 */
  setTableTarget(path: JSONPath): void
  /** 確定前の入力を文書へ入れる。今の値と原文を比べる前に呼ぶ。 */
  commitPendingInput(): void
  /** 今の文書。読めなければ undefined。 */
  document(): unknown
  /** エディタの公開の `patch`。パーサが拒むキーを作る操作なら投げる。 */
  patch(operations: JSONPatchAdd[]): void
  /** 編集の後の始末（未保存の印、左ペイン、状態の行、場所の行）。上流の公開の `patch` は onChange を呼ばない。 */
  afterEdit(): void
}

export type ApplyResult =
  | { kind: 'added'; key: string; count: number; skipped: number }
  | { kind: 'none' }
  | { kind: 'refused'; message: string }
  | { kind: 'textMode' }
  | { kind: 'modal' }
  | { kind: 'declined' }

function samePath(a: JSONPath, b: JSONPath): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * 訳を新しい列として足す。訳の無い行があれば、訳せた行にだけ足すと確かめる（既定は取り消し）。
 * テキストの表示（書式が書き直される）とモーダルが開いている間は足さない。
 */
export async function applyColumn(
  options: ApplyColumnOptions,
  source: ColumnSource,
  entries: readonly ColumnEntry[],
  target: string
): Promise<ApplyResult> {
  const blocked = (): ApplyResult | null =>
    options.hasOpenModal() ? { kind: 'modal' } : options.mode() === Mode.text ? { kind: 'textMode' } : null
  const before = blocked()
  if (before !== null) {
    return before
  }
  const done = entries.filter((entry) => entry.translation !== null).length
  if (done === 0) {
    return { kind: 'none' }
  }
  if (done < entries.length) {
    const answer = await options.ask({
      title: t('app.dialog.translateAddPartialTitle'),
      body: format('app.dialog.translateAddPartialBody', { done: String(done), total: String(entries.length) }),
      level: 'info',
      buttons: [t('app.dialog.translateAdd'), t('app.dialog.cancel')],
      default: CANCEL_BUTTON,
      cancel: CANCEL_BUTTON
    })
    if (answer !== ACCEPT_BUTTON) {
      return { kind: 'declined' }
    }
    const after = blocked() // 確かめの間に表示が替わった、またはモーダルが開いた
    if (after !== null) {
      return after
    }
  }
  options.commitPendingInput()
  const plan = planColumn(options.document(), source, entries, target)
  if (plan.operations.length === 0) {
    return { kind: 'none' }
  }
  // 表の公開の patch は今の表の対象の中の操作だけを受ける。出どころの表へ戻してから足す
  if (options.mode() === Mode.table && !samePath(options.tableTarget(), source.tableTarget)) {
    options.setTableTarget(source.tableTarget)
  }
  try {
    options.patch(plan.operations)
  } catch (reason) {
    return { kind: 'refused', message: reason instanceof Error ? reason.message : String(reason) }
  }
  options.afterEdit()
  return { kind: 'added', key: plan.key, count: plan.operations.length, skipped: skippedCount(plan) }
}

/** 結果を小窓の文へ。言語を替えても引き直せるよう関数で返す。足さなかったときは null（何も出さない）。 */
export function applyResultMessage(result: ApplyResult): { text: () => string; kind: 'info' | 'error' } | null {
  switch (result.kind) {
    case 'added': {
      const column = result.key
      const count = String(result.count)
      const skipped = String(result.skipped)
      return {
        text: () =>
          [
            format('app.translate.panel.added', { column, count }),
            ...(result.skipped > 0 ? [format('app.translate.panel.addSkipped', { count: skipped })] : [])
          ].join(' '),
        kind: 'info'
      }
    }
    case 'none':
      return { text: () => t('app.translate.panel.addNone'), kind: 'error' }
    case 'refused': {
      const message = result.message
      return { text: () => format('app.translate.panel.addRefused', { message }), kind: 'error' }
    }
    case 'textMode':
      return { text: () => t('app.translate.panel.addTextMode'), kind: 'error' }
    case 'modal':
      return { text: () => t('app.translate.panel.addModal'), kind: 'error' }
    case 'declined':
      return null
  }
}
