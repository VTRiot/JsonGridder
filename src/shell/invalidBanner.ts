import './invalidBanner.css'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { Diagnosis } from '../document/backend'
import { format, t } from '../i18n'
import { createIcon } from './icons'

/** 帯に出すキーの長さの上限（文字）。長いキーで帯が何行にも膨らまないための見た目の定数。 */
const KEY_PREVIEW_CHARS = 80
const ELLIPSIS = '…'

export interface InvalidBannerOptions {
  /** 理由と位置を取る。無いとき（Tauri の外）と失敗したときは、理由の種類を出さず総称の文言にする。 */
  diagnose?(text: string): Promise<Diagnosis | null>
}

export interface InvalidBanner {
  element: HTMLElement
  /**
   * テキストでしか開けない文書を出している。`text` の理由を取って帯に出す。
   * 帯の表示の判断は呼び手（門番と同じ検査）が持ち、帯は理由の文言だけを決める。
   */
  show(text: string | undefined): void
  /** 帯を消す。取りに行っている途中の理由は捨てる。 */
  hide(): void
  /** 文書が変わった。取りに行っている途中の理由（前の本文の物）は捨て、出ている帯は次の判断まで残す。 */
  invalidate(): void
  /** 文言を辞書から引き直す。 */
  refresh(): void
}

function keyPreview(key: string): string {
  const characters = [...key]
  return characters.length > KEY_PREVIEW_CHARS
    ? characters.slice(0, KEY_PREVIEW_CHARS).join('') + ELLIPSIS
    : key
}

/** 理由の文言。`null` は理由の種類が取れなかったとき。 */
export function reasonText(diagnosis: Diagnosis | null): string {
  if (diagnosis === null) {
    return t('app.invalid.unknown')
  }
  const at = { line: String(diagnosis.at.line), column: String(diagnosis.at.column) }
  switch (diagnosis.kind) {
    case 'syntax':
      return format('app.invalid.syntax', at)
    case 'duplicateKey':
      return format('app.invalid.duplicateKey', {
        ...at,
        key: keyPreview(diagnosis.key),
        firstLine: String(diagnosis.first.line),
        firstColumn: String(diagnosis.first.column)
      })
    case 'reservedKey':
      return format('app.invalid.reservedKey', { ...at, key: keyPreview(diagnosis.key) })
    case 'depthExceeded':
      return format('app.invalid.depthExceeded', { ...at, limit: String(diagnosis.limit) })
    default:
      return t('app.invalid.unknown') // Rust が新しい種類を返した。画面を壊さない
  }
}

/**
 * テキストでしか開けない文書の警告の帯（D6）。文書を書き換えない。
 * 上流のテキストの表示の解析エラーの帯（位置へ移動、修復）はエディタの中にそのまま残る。
 */
export function createInvalidBanner(options: InvalidBannerOptions): InvalidBanner {
  const element = document.createElement('div')
  element.className = 'app-invalid-banner'
  element.setAttribute('role', 'status')
  element.hidden = true
  const message = document.createElement('span')
  message.className = 'app-invalid-banner-text'
  element.append(createIcon(faTriangleExclamation), message)

  let requests = 0 // 古い理由を捨てるための番号
  let diagnosis: Diagnosis | null = null

  function render(): void {
    element.dataset.kind = diagnosis?.kind ?? 'unknown'
    message.textContent = format('app.invalid.message', { reason: reasonText(diagnosis) })
  }

  function apply(id: number, found: Diagnosis | null): void {
    if (id !== requests) {
      return
    }
    diagnosis = found
    render()
    element.hidden = false
  }

  function request(text: string | undefined): Promise<Diagnosis | null> {
    if (text === undefined || options.diagnose === undefined) {
      return Promise.resolve(null)
    }
    try {
      return options.diagnose(text)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return {
    element,
    show(text) {
      const id = ++requests
      // 出ている帯は、新しい理由が届くまで前の理由のまま（打鍵のたびに瞬かせない）
      request(text).then(
        (found) => apply(id, found ?? null),
        () => apply(id, null)
      )
    },
    hide() {
      requests++
      diagnosis = null
      element.hidden = true
    },
    invalidate() {
      requests++
    },
    refresh() {
      if (!element.hidden) {
        render()
      }
    }
  }
}
