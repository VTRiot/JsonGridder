import './statusRow.css'
import { faCircleCheck } from '@fortawesome/free-solid-svg-icons'
import { Mode } from '$lib/types'
import type { Encoding, TextFormat } from '../document/backend'
import type { DocumentStatus } from '../document/model'
import { currentLanguage, format, t } from '../i18n'
import { createIcon } from './icons'
import type { DocumentView } from './tableTargets'

const ENCODING_KEYS: Record<Encoding, string> = {
  utf8: 'app.encoding.utf8',
  utf16Le: 'app.encoding.utf16Le',
  utf16Be: 'app.encoding.utf16Be',
  shiftJis: 'app.encoding.shiftJis'
}

/** 改行の表示。`none`（1 行の文書）は出さない（D12）。 */
const EOL_KEYS: Partial<Record<TextFormat['eol'], string>> = {
  crlf: 'app.status.eol.crlf',
  lf: 'app.status.eol.lf',
  cr: 'app.status.eol.cr',
  mixed: 'app.status.eol.mixed'
}

export type StatusItemName = 'encoding' | 'eol' | 'rows' | 'save'

export interface StatusItem {
  name: StatusItemName
  text: string
  /** 保存済みの印を付ける。 */
  saved?: boolean
}

export interface StatusSource {
  /** 開いたファイルの基準。無題の文書は null。 */
  baseline(): { encoding: Encoding; bom: boolean; format: TextFormat } | null
  status(): DocumentStatus
  view(): DocumentView
  /** 表の今の対象の要素の数。表でない、または対象が配列でないときは undefined。 */
  rows(): number | undefined
}

/**
 * 状態の行に出す物。意味の無い物は出さない（D12）:
 * 無題の文書の文字コードと改行、1 行の文書の改行、表以外の行数、無題で未編集の保存の状態。
 */
export function statusItems(source: StatusSource): StatusItem[] {
  const items: StatusItem[] = []
  const base = source.baseline()
  const status = source.status()
  if (base !== null) {
    const encoding = t(ENCODING_KEYS[base.encoding])
    items.push({ name: 'encoding', text: base.bom ? format('app.status.encodingBom', { encoding }) : encoding })
    const eol = EOL_KEYS[base.format.eol]
    if (eol !== undefined) {
      items.push({ name: 'eol', text: t(eol) })
    }
  }
  if (source.view().mode === Mode.table) {
    const rows = source.rows()
    if (rows !== undefined) {
      items.push({ name: 'rows', text: format('app.status.rows', { count: rows.toLocaleString(currentLanguage()) }) })
    }
  }
  if (status.saveBlocked) {
    items.push({ name: 'save', text: t('app.status.saveBlocked') })
  } else if (status.unsaved) {
    items.push({ name: 'save', text: t('app.status.unsaved') })
  } else if (base !== null) {
    items.push({ name: 'save', text: t('app.status.saved'), saved: true })
  }
  return items
}

export interface StatusRow {
  element: HTMLElement
  /** 出す物を見直す。描画や onChange の中からも呼べる（読むのは後で、エディタの更新の外）。 */
  refresh(): void
}

/** 窓の下の状態の行（文字コード、改行、行数、保存の状態）。 */
export function createStatusRow(source: StatusSource): StatusRow {
  const element = document.createElement('div')
  element.className = 'app-status-row'
  element.setAttribute('role', 'status')
  let timer: ReturnType<typeof setTimeout> | undefined

  function render(): void {
    timer = undefined
    const shown = statusItems(source).map(({ name, text, saved }) => {
      const item = document.createElement('span')
      item.className = 'app-status-item'
      item.dataset.item = name
      if (saved) {
        item.classList.add('is-saved')
        item.append(createIcon(faCircleCheck))
      }
      item.append(text)
      return item
    })
    element.replaceChildren(...shown)
  }

  return {
    element,
    refresh() {
      clearTimeout(timer)
      timer = setTimeout(render, 0)
    }
  }
}
