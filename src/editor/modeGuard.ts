import { isTextContent } from '$lib/utils/jsonUtils'
import { Mode, type Content, type JSONParser, type ModeGuard } from '$lib/types'
import type { JsonScanner } from '../document/backend'
import { t } from '../i18n'
import { TextOnlyDocumentError } from './parser'

/** これより大きい文書はテキストの表示に入れない。 */
export const TEXT_MODE_LIMIT_BYTES = 10 * 1024 * 1024

export interface ModeGuardOptions {
  parser: JSONParser
  /** パーサで検出できないものを見る検査。無いときはパーサの判定だけになる。 */
  scanner?: JsonScanner
  notify(message: string): void
}

/**
 * 表示の切り替えの門番。テキストの表示を離れるときは、開くときと同じ検査を通す。
 * 不正な JSON、重複キー、深さ超過の文書を表とツリーへ入れない。
 */
export function createModeGuard({ parser, scanner, notify }: ModeGuardOptions): ModeGuard {
  function refuse(key: string): false {
    notify(t(key))
    return false
  }

  function fitsTextMode(content: Content): boolean {
    const text = isTextContent(content) ? content.text : parser.stringify(content.json)
    const size = new TextEncoder().encode(text ?? '').length
    return size <= TEXT_MODE_LIMIT_BYTES || refuse('app.notice.tooLargeForText')
  }

  async function passesScan(text: string, scanner: JsonScanner): Promise<boolean> {
    try {
      const { syntaxOk, duplicateKey, depthExceeded } = await scanner.scan(text)
      if (!syntaxOk) {
        return refuse('app.notice.invalidJson')
      }
      if (duplicateKey) {
        return refuse('app.notice.duplicateKey')
      }
      return !depthExceeded || refuse('app.notice.depthExceeded')
    } catch {
      return refuse('app.notice.scanFailed')
    }
  }

  return (target, content) => {
    if (target === Mode.text) {
      return fitsTextMode(content)
    }
    if (!isTextContent(content)) {
      return true // パースを通った文書
    }
    if (content.text === '') {
      return true // 空の文書。起動直後の無題の文書で表示を切り替えられるように
    }
    try {
      parser.parse(content.text)
    } catch (err) {
      if (err instanceof TextOnlyDocumentError) {
        notify(err.message)
        return false
      }
      return refuse('app.notice.invalidJson')
    }
    return scanner === undefined || passesScan(content.text, scanner)
  }
}
