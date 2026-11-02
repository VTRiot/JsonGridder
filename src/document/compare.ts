import { parse, stringify } from 'lossless-json'
import type { Content } from '$lib/types'
import { isTextContent } from '$lib/utils/jsonUtils'

/** 比べる相手。保存が成功するたびに別のオブジェクトへ入れ替える。 */
export interface ComparedBaseline {
  text: string
}

/** CodeMirror の文書は改行が LF になるので、揃えてから比べる。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 基準ごとに 1 回だけ計算する。100 MB のパースを保存のたびに繰り返さない。 */
const canonicalTexts = new WeakMap<ComparedBaseline, string | null>()

function canonicalOf(baseline: ComparedBaseline): string | null {
  let canonical = canonicalTexts.get(baseline)
  if (canonical === undefined) {
    canonical = stringifyOrNull(() => parse(baseline.text))
    canonicalTexts.set(baseline, canonical)
  }
  return canonical
}

function stringifyOrNull(value: () => unknown): string | null {
  try {
    return stringify(value()) ?? null
  } catch {
    return null
  }
}

/**
 * 今の内容が基準と同じか。迷ったら「違う」に倒す。余分な確認は安全側である。
 * `{text}` はパースせず文字単位で比べる。空白だけの編集も編集である。
 * `{json}` はキー順と数値の字面を区別する。キー順を無視する比較を使わない。
 */
export function isUnchanged(content: Content, baseline: ComparedBaseline): boolean {
  // エディタの内容は表の編集の後 `{ json, text: undefined }` の形になるので、キーの有無で分けない
  if (isTextContent(content)) {
    return normalizeNewlines(content.text) === normalizeNewlines(baseline.text)
  }
  if (content.json === undefined) {
    return false
  }
  const canonical = canonicalOf(baseline)
  return canonical !== null && stringifyOrNull(() => content.json) === canonical
}
