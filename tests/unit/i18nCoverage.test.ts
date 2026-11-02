// 利用者に見える文字列の全数検査。辞書のキーの一致、使うキーの有無、直書きの文字列の洗い出し。
import { describe, expect, test } from 'vitest'
import en from '../../src/i18n/en.json'
import ja from '../../src/i18n/ja.json'
import { english } from '../../vendor/svelte-jsoneditor/src/lib/i18n/locales/english'
import { EXCLUSIONS } from './i18nExclusions'

/** 全部の原文。.bak は拾わない。 */
const sources = import.meta.glob(
  [
    '../../src/**/*.ts',
    '../../src-tauri/src/**/*.rs',
    '../../vendor/svelte-jsoneditor/src/lib/**/*.{svelte,ts}'
  ],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

const SRC = '../../src/'
const RUST = '../../src-tauri/src/'
const VENDOR_LIB = '../../vendor/svelte-jsoneditor/src/lib/'
const IGNORED_FILE = /.test.ts$|.d.ts$/
const JAPANESE = /[぀-ヿ一-鿿]/

function walk(prefix: string, accept: (file: string) => boolean): string[] {
  return Object.keys(sources).filter((file) => file.startsWith(prefix) && accept(file) && !IGNORED_FILE.test(file))
}

const read = (file: string): string => sources[file]
const rel = (file: string): string => file.replace('../../', '')

describe('辞書のキー', () => {
  test('en と ja のキーが一致する', () => {
    const enKeys = Object.keys(en).sort()
    const jaKeys = Object.keys(ja).sort()
    expect(jaKeys.filter((key) => !(key in en)), 'en に無い').toEqual([])
    expect(enKeys.filter((key) => !(key in ja)), 'ja に無い').toEqual([])
  })

  test('値はすべて空でない文字列で、{{名前}} の組が両言語で同じ', () => {
    const names = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(en)) {
      const enValue = (en as Record<string, string>)[key]
      const jaValue = (ja as Record<string, string>)[key]
      expect(typeof enValue, key).toBe('string')
      expect(enValue, key).not.toBe('')
      expect(jaValue, key).not.toBe('')
      expect(names(jaValue), key).toEqual(names(enValue))
    }
  })

  test('editor.* は上流の英語のキーを漏れなく持ち、上流の英語と同じ値を en に持つ', () => {
    for (const [key, value] of Object.entries(english.values)) {
      expect((en as Record<string, string>)[`editor.${key}`], key).toBe(value)
    }
    const upstream = new Set(Object.keys(english.values))
    const extra = Object.keys(en)
      .filter((key) => key.startsWith('editor.'))
      .filter((key) => !upstream.has(key.slice('editor.'.length)))
    expect(extra).toEqual([])
  })
})

describe('使うキー', () => {
  test('アプリの TypeScript と Rust が引くキーはすべて辞書にある', () => {
    const files = [
      ...walk(SRC, (file) => file.endsWith('.ts')),
      ...walk(RUST, (file) => file.endsWith('.rs'))
    ]
    const used = new Set<string>()
    for (const file of files) {
      for (const match of read(file).matchAll(/["'`]((?:app|editor)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)["'`]/g)) {
        used.add(match[1])
      }
    }
    const missing = [...used].filter((key) => !(key in en))
    expect(missing).toEqual([])
    console.log(`i18n: アプリが引くキー ${used.size} 件、辞書 ${Object.keys(en).length} 件`)
  })

  test('取り込んだエディタが引くキーはすべて上流の英語にある', () => {
    const files = walk(VENDOR_LIB, (file) => /\.(svelte|ts)$/.test(file))
    const used = new Set<string>()
    for (const file of files) {
      for (const match of read(file).matchAll(/(?:\$t|tString)\(\s*'([A-Za-z]+)'/g)) {
        used.add(match[1])
      }
    }
    const missing = [...used].filter((key) => !Object.hasOwn(english.values, key))
    expect(missing).toEqual([])
    console.log(`i18n: エディタが引くキー ${used.size} 件`)
  })
})

/** Svelte の本文と title、aria-label、placeholder、alt の直書きの英語を集める。 */
function literalsInSvelte(source: string): string[] {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ')
  const text = source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
  const found: string[] = []
  let depth = 0
  let buffer = ''
  let inTag = false
  for (const c of text) {
    if (c === '{') {
      depth++
    }
    if (depth === 0) {
      if (c === '<') {
        if (/[A-Za-z]{2,}/.test(buffer) && !inTag) {
          found.push(buffer.trim().replace(/\s+/g, ' '))
        }
        buffer = ''
        inTag = true
      } else if (c === '>' && inTag) {
        inTag = false
        buffer = ''
      } else if (!inTag) {
        buffer += c
      }
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
  for (const match of text.matchAll(/\b(?:title|aria-label|placeholder|alt)="([^"{}]*[A-Za-z]{2,}[^"{}]*)"/g)) {
    found.push(match[1])
  }
  for (const match of text.matchAll(/\b(?:title|aria-label|placeholder|alt)=\{\s*["']([^"']*[A-Za-z]{2,}[^"']*)["']\s*\}/g)) {
    found.push(match[1])
  }
  return found
}

describe('直書きの文字列', () => {
  test('取り込んだエディタの画面に、除外表に無い英語の直書きが無い', () => {
    const files = walk(VENDOR_LIB, (file) => file.endsWith('.svelte'))
    const unexplained: string[] = []
    const used = new Set<string>()
    let total = 0
    for (const file of files) {
      for (const literal of literalsInSvelte(read(file))) {
        total++
        const entry = EXCLUSIONS.find((e) => e.text === literal && rel(file).endsWith(e.file))
        if (entry) {
          used.add(`${entry.file} :: ${entry.text}`)
        } else {
          unexplained.push(`${rel(file)} :: ${literal}`)
        }
      }
    }
    expect(unexplained).toEqual([])
    const stale = EXCLUSIONS.filter((e) => e.kind === 'svelte' && !used.has(`${e.file} :: ${e.text}`))
    expect(stale.map((e) => `${e.file} :: ${e.text}`), '除外表に残っているが該当の無い行').toEqual([])
    console.log(`i18n: 直書き候補 ${total} 件、除外表で説明 ${used.size} 件、未説明 0 件`)
  })

  test('除外表のすべての行に理由がある', () => {
    for (const entry of EXCLUSIONS) {
      expect(entry.reason.trim().length, `${entry.file} :: ${entry.text}`).toBeGreaterThan(8)
    }
  })

  test('アプリの TypeScript に日本語の文字列の直書きが無い', () => {
    const files = walk(SRC, (file) => file.endsWith('.ts') && !file.includes('/i18n/'))
    const offenders: string[] = []
    for (const file of files) {
      read(file)
        .split(/\r?\n/)
        .forEach((line, index) => {
          const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim()
          if (!code.startsWith('*') && JAPANESE.test(code)) {
            offenders.push(`${rel(file)}:${index + 1}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })

  test('Rust の製品コードに日本語の文字列の直書きが無い', () => {
    const files = walk(RUST, (file) => file.endsWith('.rs') && !file.endsWith('real_file_tests.rs'))
    const offenders: string[] = []
    for (const file of files) {
      const source = read(file)
      const productCode = source.split(/\r?\n#\[cfg\(test\)\]/)[0]
      productCode.split(/\r?\n/).forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '')
        if (JAPANESE.test(code)) {
          offenders.push(`${rel(file)}:${index + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

