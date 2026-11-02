import { isLosslessNumber, parse, stringify } from 'lossless-json'
import type { JSONParser } from '$lib/types'
import { t } from '../i18n'

const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor'])

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const COLON = 0x3a
const SPACE = 0x20
const TAB = 0x09
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d

/** 正しい JSON でも、表とツリーで内容を保てない文書。テキストの表示に限る。 */
export class TextOnlyDocumentError extends SyntaxError {}

/** オブジェクトの判定や原型に関わる名前。表とツリーで値が化ける。 */
function assertNoReservedKey(root: unknown): void {
  const pending = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || isLosslessNumber(value)) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        pending.push(item)
      }
      continue
    }
    for (const key of Object.keys(value)) {
      if (RESERVED_KEYS.has(key)) {
        throw new TextOnlyDocumentError(t('app.parser.reservedKey').replace('{{key}}', () => key))
      }
      pending.push((value as Record<string, unknown>)[key])
    }
  }
}

function endOfString(text: string, start: number): number {
  let position = start + 1
  while (position < text.length) {
    const code = text.charCodeAt(position)
    if (code === QUOTE) {
      return position
    }
    position += code === BACKSLASH ? 2 : 1
  }
  return -1
}

function nextToken(text: string, start: number): number {
  let position = start
  while (position < text.length) {
    const code = text.charCodeAt(position)
    if (code !== SPACE && code !== LINE_FEED && code !== CARRIAGE_RETURN && code !== TAB) {
      break
    }
    position++
  }
  return text.charCodeAt(position)
}

function keyOf(literal: string): string {
  if (!literal.includes('\\')) {
    return literal.slice(1, -1)
  }
  try {
    return JSON.parse(literal) as string
  } catch {
    return literal // 不正な文書。パーサが理由を出す
  }
}

/**
 * 重複キーは値が同じでも読むと片方が消えるので、読む前に字句で調べる。不正な文書の判定はパーサに任せる。
 * 再帰しない。深い文書でスタックを使い切らないためである。
 */
function assertNoDuplicateKey(text: string): void {
  // 開いている入れ子。オブジェクトはキーの集合、配列は undefined
  const open: Array<Set<string> | undefined> = []
  let position = 0
  while (position < text.length) {
    const code = text.charCodeAt(position)
    if (code === QUOTE) {
      const end = endOfString(text, position)
      if (end === -1) {
        return
      }
      const keys = open[open.length - 1]
      if (keys !== undefined && nextToken(text, end + 1) === COLON) {
        const key = keyOf(text.slice(position, end + 1))
        if (keys.has(key)) {
          throw new TextOnlyDocumentError(t('app.parser.duplicateKey'))
        }
        keys.add(key)
      }
      position = end + 1
      continue
    }
    if (code === OPEN_BRACE) {
      open.push(new Set())
    } else if (code === OPEN_BRACKET) {
      open.push(undefined)
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      open.pop()
    }
    position++
  }
}

/** 数値の字面を保ち、内容を保てないキーを拒否するパーサ。エディタの全経路が通る。 */
export const strictParser = {
  parse(text: string): unknown {
    assertNoDuplicateKey(text)
    const value = parse(text)
    assertNoReservedKey(value)
    return value
  },
  stringify
} as unknown as JSONParser
