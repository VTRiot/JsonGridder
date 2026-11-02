import { isLosslessNumber, parse, stringify } from 'lossless-json'
import type { Content } from '$lib/types'
import { isTextContent } from '$lib/utils/jsonUtils'
import type { Indent, Newline, TextFormat } from './backend'
import { normalizeNewlines } from './compare'

const NEWLINES: Record<Newline, string> = { crlf: '\r\n', lf: '\n', cr: '\r' }
/** `stringify` が受け付ける字下げの上限。`JSON.stringify` と同じ値で、上限を超える幅は切り詰める。 */
const STRINGIFY_MAX_INDENT = 10

export type Stringify = (value: unknown, replacer: null, space?: number | string) => string | undefined

/** 新しい文書の書式。ファイルに結び付いていない文書に使う。 */
export const DEFAULT_FORMAT: TextFormat = {
  eol: 'lf',
  eolDominant: 'lf',
  indent: { kind: 'spaces', count: 2 },
  finalNewline: true
}

export type Serialized =
  | { ok: true; text: string; eolNormalized: boolean }
  | { ok: false; reason: 'mismatch' | 'failed' }

function indentArgument(indent: Indent): number | string | undefined {
  switch (indent.kind) {
    case 'spaces':
      return indent.count
    case 'tab':
      return '\t'
    case 'none':
      return undefined
  }
}

/**
 * 字下げの幅を指定どおりにして書く。`stringify` はこの幅より広い字下げを文字列でも切り詰める。
 * JSON の出力の改行は行の区切りだけなので（文字列の中の改行はエスケープされる）、1 字で書いて
 * 行頭を広げる。行の区切りは `\n` だけを見る。U+2028 などは文字列の中に生のまま残る。
 */
function writeIndented(json: unknown, indent: Indent, write: Stringify): string | undefined {
  const space = indentArgument(indent)
  if (typeof space !== 'number' || space <= STRINGIFY_MAX_INDENT) {
    return write(json, null, space)
  }
  return write(json, null, 1)
    ?.split('\n')
    .map((line) => line.replace(/^ +/, (lead) => ' '.repeat(lead.length * space)))
    .join('\n')
}

/** 文書の書式で書く。テキストの表示へ移したときの字面と、保存の字面を同じにする。 */
export function writeDocument(json: unknown, format: TextFormat, write: Stringify): string | undefined {
  const body = writeIndented(json, format.indent, write)
  return body !== undefined && format.finalNewline ? `${body}\n` : body
}

function restoreNewlines(text: string, format: TextFormat): string {
  return normalizeNewlines(text).replaceAll('\n', NEWLINES[format.eolDominant])
}

const numberText = (value: unknown): string | null =>
  isLosslessNumber(value) || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : null

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `stringify` を通さない木の比較。キー順、配列、数値の字面を見る。 */
export function isSameTree(a: unknown, b: unknown): boolean {
  const numberA = numberText(a)
  if (numberA !== null) {
    return numberA === numberText(b)
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => isSameTree(item, b[index]))
    )
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b) || numberText(b) !== null) {
      return false
    }
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return (
      keysA.length === keysB.length &&
      keysA.every((key, index) => key === keysB[index] && isSameTree(a[key], b[key]))
    )
  }
  return a === b
}

function serializeJson(json: unknown, format: TextFormat, write: Stringify): Serialized {
  let text: string | undefined
  try {
    text = writeDocument(json, format, write)
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (text === undefined) {
    return { ok: false, reason: 'failed' }
  }

  try {
    if (!isSameTree(json, parse(text))) {
      return { ok: false, reason: 'mismatch' }
    }
  } catch {
    return { ok: false, reason: 'mismatch' }
  }

  return { ok: true, text: restoreNewlines(text, format), eolNormalized: format.eol === 'mixed' }
}

/**
 * 保存する最終のテキストを作る。
 * `{json}` は開いたときの書式で書き、もう一度パースして文書と一致しなければ止める。
 * `{text}` は手を入れず、改行だけを開いたときの形へ戻す。修復しない。
 */
export function serializeContent(
  content: Content,
  format: TextFormat,
  write: Stringify = stringify as Stringify
): Serialized {
  if (isTextContent(content)) {
    return {
      ok: true,
      text: restoreNewlines(content.text, format),
      eolNormalized: format.eol === 'mixed'
    }
  }
  if (content.json === undefined) {
    return { ok: true, text: '', eolNormalized: false }
  }
  return serializeJson(content.json, format, write)
}

/** 孤立したサロゲートは UTF-8 にすると置換される。黙って変えないよう、先に見つける。 */
export function isWellFormedText(text: string): boolean {
  return (text as unknown as { isWellFormed(): boolean }).isWellFormed()
}
