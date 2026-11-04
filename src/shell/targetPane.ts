import './targetPane.css'
import { faTable } from '@fortawesome/free-solid-svg-icons'
import { isEqual } from 'lodash-es'
import { isJSONArray, type JSONPath } from 'immutable-json-patch'
import { Mode } from '$lib/types'
import { stringifyJSONPath } from '$lib/utils/pathUtils'
import { currentLanguage, format, t } from '../i18n'
import { createIcon } from './icons'
import { findTableTargets, type TableTarget } from './tableTargets'

/** 項目の上限。上流の案内の画面と同じ（旧 targetBar の MAX_TARGETS を引き継ぐ）。 */
export const MAX_TARGETS = 99

export interface PaneTargets {
  /** 出す項目。根が配列なら先頭に根（パスは空）。 */
  items: TableTarget[]
  /** 上限を超えて出さない項目の数。 */
  more: number
}

/**
 * 左ペインに並べる表にできる配列（D7）。根が空でない配列なら先頭に根を置き、続けて `findTableTargets` の順。
 * 根がオブジェクトのときの「文書全体」は出さない（表にできる配列ではない。D12）。
 */
export function paneTargets(json: unknown, limit = MAX_TARGETS): PaneTargets {
  const all: TableTarget[] = [
    ...(isJSONArray(json) && json.length > 0 ? [{ path: [], rows: json.length }] : []),
    ...findTableTargets(json)
  ]
  const items = all.slice(0, limit)
  return { items, more: all.length - items.length }
}

/**
 * 左ペインを出すか。テキストの表示（テキストでしか開けない文書、undo で戻った文書）では出さない（D12）。
 * ツリーでは Options の「ツリー表示のときは左ペインを出さない」に従う（D13）。項目が無ければ出さない（D12）。
 */
export function paneShown({ mode, hideInTree, count }: { mode: Mode; hideInTree: boolean; count: number }): boolean {
  if (mode === Mode.text || count === 0) {
    return false
  }
  return mode === Mode.table || !hideInTree
}

export function pathLabel(path: JSONPath): string {
  return path.length === 0 ? t('app.target.whole') : stringifyJSONPath(path)
}

export interface TargetPaneSource {
  /** 主のエディタの今の表示。 */
  mode(): Mode
  tableTarget(): JSONPath
  /** 今の文書。テキストの表示では呼ばない。読めないときは undefined。 */
  document(): unknown
  /** Options の「ツリー表示のときは左ペインを出さない」。 */
  hideInTree(): boolean
}

export interface TargetPaneOptions extends TargetPaneSource {
  /** 項目が押された。表なら対象を替え、ツリーならその配列を表で開く（呼び手が決める）。 */
  onPick(path: JSONPath): void
}

export interface TargetPane {
  element: HTMLElement
  /** 出す物を見直す。描画や onChange の中からも呼べる（読むのは後のタスクで、エディタの更新の外）。 */
  refresh(): void
}

/** 左ペイン「表にできる配列」（D7、D13）。旧 targetBar（表の対象のドロップダウン）を置き換える。 */
export function createTargetPane(options: TargetPaneOptions): TargetPane {
  const element = document.createElement('nav')
  element.className = 'app-target-pane'
  element.hidden = true
  const title = document.createElement('div')
  title.className = 'app-target-pane-title'
  const list = document.createElement('ul')
  list.className = 'app-target-pane-list'
  element.append(title, list)

  let timer: ReturnType<typeof setTimeout> | undefined
  // 文書は不変で扱う。同じ文書なら候補を作り直さない
  let lastDocument: unknown = undefined
  let lastTargets: PaneTargets = { items: [], more: 0 }
  let drawn = ''

  function targetsOf(json: unknown): PaneTargets {
    if (json !== lastDocument) {
      lastDocument = json
      lastTargets = paneTargets(json)
    }
    return lastTargets
  }

  function itemElement({ path, rows }: TableTarget, selected: boolean): HTMLElement {
    const label = pathLabel(path)
    const count = rows.toLocaleString(currentLanguage())
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'app-target-pane-item'
    button.classList.toggle('is-selected', selected)
    if (selected) {
      button.setAttribute('aria-current', 'true')
    }
    button.dataset.label = label
    button.title = format('app.target.item', { path: label, count })
    const name = document.createElement('span')
    name.className = 'app-target-pane-path'
    name.textContent = label
    const badge = document.createElement('span')
    badge.className = 'app-target-pane-count'
    badge.textContent = count
    button.append(createIcon(faTable), name, badge)
    // 押下でフォーカスを奪わない。選んだ後はエディタがフォーカスを持つ
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => options.onPick(path))
    const row = document.createElement('li')
    row.appendChild(button)
    return row
  }

  function render(): void {
    timer = undefined
    const mode = options.mode()
    // テキストの表示では文書を読まない（読めない文書を読みに行かない）
    const targets = mode === Mode.text ? { items: [], more: 0 } : targetsOf(options.document())
    const shown = paneShown({ mode, hideInTree: options.hideInTree(), count: targets.items.length })
    element.hidden = !shown
    if (!shown) {
      return
    }
    const current = options.tableTarget()
    const selected = targets.items.findIndex(({ path }) => isEqual(path, current))
    // 同じ中身なら描き直さない（キーボードのフォーカスを保つ）
    const signature = JSON.stringify([currentLanguage(), targets, selected])
    if (signature === drawn) {
      return
    }
    drawn = signature
    title.textContent = t('app.targets.title')
    element.setAttribute('aria-label', t('app.targets.title'))
    const rows = targets.items.map((target, index) => itemElement(target, index === selected))
    if (targets.more > 0) {
      const more = document.createElement('li')
      more.className = 'app-target-pane-more'
      more.textContent = format('app.targets.more', { count: targets.more.toLocaleString(currentLanguage()) })
      rows.push(more)
    }
    list.replaceChildren(...rows)
  }

  return {
    element,
    refresh() {
      clearTimeout(timer)
      timer = setTimeout(render, 0)
    }
  }
}
