import './locationRow.css'
import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import type { JSONPath } from 'immutable-json-patch'
import { getFocusPath, isTextSelection, pathExistsInDocument } from '$lib/logic/selection'
import { Mode, type JSONEditorSelection } from '$lib/types'
import { t } from '../i18n'
import { createIcon } from './icons'

/**
 * 表の場所の行に出すパス。表の選択は表の対象の中のパスなので、対象の後ろへつなぐ。
 * 選択が無い、テキストの選択、または今の文書に無いパス（前の表示や前の対象の選択）なら、対象だけを出す。
 */
export function tableLocation(
  document: unknown,
  tableTarget: JSONPath,
  selection: JSONEditorSelection | undefined
): JSONPath {
  if (selection === undefined || isTextSelection(selection)) {
    return tableTarget
  }
  const path = [...tableTarget, ...getFocusPath(selection)]
  return document !== undefined && pathExistsInDocument(document, path) ? path : tableTarget
}

export interface LocationSource {
  /** 主のエディタの今の表示（切り替えが受けた物）。 */
  mode(): Mode
  tableTarget(): JSONPath
  /** 今の文書。テキストの表示で読めない文書は undefined。 */
  document(): unknown
  /** 主のエディタが最後に知らせた選択。 */
  selection(): JSONEditorSelection | undefined
}

export interface LocationRow {
  element: HTMLElement
  /** 出す物を見直す。描画や onSelect の中からも呼べる（読むのは後で、エディタの更新の外）。 */
  refresh(): void
}

/**
 * 表の場所の行（`users > 3 > address > city`）。読むだけで、押しても何もしない。
 * 表のときだけ出す。ツリーは上流の場所の行（navigationBar）がエディタの中に出る。テキストの表示
 * （テキストでしか開けない文書を含む）では出さない（D12）。
 */
export function createLocationRow(source: LocationSource): LocationRow {
  const element = document.createElement('nav')
  element.className = 'app-location-row'
  element.hidden = true
  let timer: ReturnType<typeof setTimeout> | undefined

  function segment(text: string): HTMLElement {
    const item = document.createElement('span')
    item.className = 'app-location-segment'
    item.textContent = text
    return item
  }

  function render(): void {
    timer = undefined
    element.setAttribute('aria-label', t('app.location.label'))
    if (source.mode() !== Mode.table) {
      element.hidden = true
      element.replaceChildren()
      delete element.dataset.path
      return
    }
    const path = tableLocation(source.document(), source.tableTarget(), source.selection())
    const parts: Node[] = []
    if (path.length === 0) {
      parts.push(segment(t('app.target.whole')))
    }
    path.forEach((key, index) => {
      if (index > 0) {
        const separator = createIcon(faChevronRight)
        separator.classList.add('app-location-separator')
        parts.push(separator)
      }
      parts.push(segment(String(key)))
    })
    element.replaceChildren(...parts)
    element.dataset.path = JSON.stringify(path)
    element.hidden = false
  }

  return {
    element,
    refresh() {
      clearTimeout(timer)
      timer = setTimeout(render, 0)
    }
  }
}
