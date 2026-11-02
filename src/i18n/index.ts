import type { Language, Locale } from '$lib/types'
import en from './en.json'
import ja from './ja.json'

export type Dictionary = Record<string, unknown>

const EDITOR_PREFIX = 'editor.'
const PHRASE_PREFIX = 'cm.'
/** 基準の言語。キーの欠けはここへ落ちる。 */
export const BASE_LANGUAGE = 'en'
/** 起動の直後、設定を読む前の言語。設定が無いときの既定と同じ英語。 */
const INITIAL_LANGUAGE = BASE_LANGUAGE
const defaultDictionary: Dictionary = en

/** 登録した辞書。無い言語は基準の言語へ落ちる。 */
const dictionaries: Record<string, Dictionary> = { [BASE_LANGUAGE]: en, ja }

/** 辞書を足す。言語を足すときはこの 1 回だけでよい（試験でも使う）。 */
export function registerDictionary(code: string, dictionary: Dictionary): void {
  dictionaries[code] = dictionary
}

export function unregisterDictionary(code: string): void {
  if (code !== BASE_LANGUAGE && code !== 'ja') {
    delete dictionaries[code]
  }
}

let language = INITIAL_LANGUAGE
const listeners = new Set<() => void>()

function currentDictionary(): Dictionary {
  return Object.hasOwn(dictionaries, language) ? dictionaries[language] : defaultDictionary
}

export function currentLanguage(): string {
  return language
}

/** 言語を替え、文言を持つ画面へ知らせる。 */
export function setLanguage(code: string): void {
  language = code
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function lookup(dictionary: Dictionary, key: string): string | undefined {
  if (!Object.hasOwn(dictionary, key)) {
    return undefined
  }
  const value = dictionary[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** アプリの文言を引く。現在の言語、既定の言語、キー名の順に探す。 */
export function translate(
  key: string,
  dictionary: Dictionary,
  fallback: Dictionary = defaultDictionary
): string {
  return lookup(dictionary, key) ?? lookup(fallback, key) ?? key
}

export function t(key: string): string {
  return translate(key, currentDictionary())
}

/** `{{name}}` を一度だけ置き換える。値の中の `{{` は置き換えない。 */
export function format(key: string, values: Record<string, string>): string {
  return t(key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name] : whole
  )
}

/**
 * 辞書の editor.* をエディタの language へ変える。無いキーはエディタが上流の英語、
 * キー名の順に補うので、ここでは埋めない。
 */
export function toEditorLanguage(dictionary: Dictionary, langCode: string): Language {
  const entries = Object.keys(dictionary)
    .filter((key) => key.startsWith(EDITOR_PREFIX))
    .map((key) => [key.slice(EDITOR_PREFIX.length), lookup(dictionary, key)] as const)
    .filter(([, value]) => value !== undefined)

  const phrases = Object.keys(dictionary)
    .filter((key) => key.startsWith(PHRASE_PREFIX))
    .map((key) => [key.slice(PHRASE_PREFIX.length), lookup(dictionary, key)] as const)
    .filter(([, value]) => value !== undefined)

  return {
    langCode,
    values: Object.fromEntries(entries) as unknown as Locale,
    ...(phrases.length > 0 ? { phrases: Object.fromEntries(phrases) as Record<string, string> } : {})
  }
}

export function editorLanguage(): Language {
  return toEditorLanguage(currentDictionary(), language)
}
