import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'lossless-json'
import type { TextFormat } from '../../../src/document/backend'
import { isSameTree, isWellFormedText, serializeContent } from '../../../src/document/serialize'
import type { Stringify } from '../../../src/document/serialize'

const format = (overrides: Partial<TextFormat> = {}): TextFormat => ({
  eol: 'lf',
  eolDominant: 'lf',
  indent: { kind: 'spaces', count: 2 },
  finalNewline: false,
  ...overrides
})

function serialized(content: Parameters<typeof serializeContent>[0], fmt: TextFormat) {
  const result = serializeContent(content, fmt)
  if (!result.ok) throw new Error(result.reason)
  return result
}

const numberTokens = (text: string) => text.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g)

describe('直列化', () => {
  const numbers = '{"big":9007199254740993,"e":1e400,"z":-0,"one":1.0,"t":0.10,"s":"x"}'

  it('1 か所の編集で他の数値の字面が変わらない', () => {
    const json = parse(numbers) as Record<string, unknown>
    json.s = 'y'
    const { text } = serialized({ json }, format({ indent: { kind: 'none' } }))
    expect(numberTokens(text)).toEqual(numberTokens(numbers))
    expect(text).toBe('{"big":9007199254740993,"e":1e400,"z":-0,"one":1.0,"t":0.10,"s":"y"}')
  })

  it('インデントを開いたときの幅で書く', () => {
    const json = parse('{"a":[1]}')
    expect(serialized({ json }, format({ indent: { kind: 'spaces', count: 4 } })).text).toBe(
      '{\n    "a": [\n        1\n    ]\n}'
    )
    expect(serialized({ json }, format({ indent: { kind: 'tab' } })).text).toBe(
      '{\n\t"a": [\n\t\t1\n\t]\n}'
    )
    expect(serialized({ json }, format({ indent: { kind: 'none' } })).text).toBe('{"a":[1]}')
  })

  it.each([10, 11, 12, 16])('字下げ %i 字を保つ', (count) => {
    const unit = ' '.repeat(count)
    const json = parse('{"a":[1.0,{"b":"  x"}]}')
    expect(serialized({ json }, format({ indent: { kind: 'spaces', count } })).text).toBe(
      [
        '{',
        `${unit}"a": [`,
        `${unit}${unit}1.0,`,
        `${unit}${unit}{`,
        `${unit}${unit}${unit}"b": "  x"`,
        `${unit}${unit}}`,
        `${unit}]`,
        '}'
      ].join('\n')
    )
  })

  it('広い字下げでも文字列の中の空白に手を入れない', () => {
    const json = parse('{"a":"    x   y"}')
    expect(serialized({ json }, format({ indent: { kind: 'spaces', count: 11 } })).text).toBe(
      `{\n${' '.repeat(11)}"a": "    x   y"\n}`
    )
  })

  it('広い字下げは改行の形と末尾の改行を保つ', () => {
    const json = parse('[1]')
    expect(
      serialized(
        { json },
        format({ eol: 'crlf', eolDominant: 'crlf', finalNewline: true, indent: { kind: 'spaces', count: 12 } })
      ).text
    ).toBe(`[\r\n${' '.repeat(12)}1\r\n]\r\n`)
  })

  it('タブの字下げを保つ', () => {
    const json = parse('{"a":[1]}')
    expect(serialized({ json }, format({ indent: { kind: 'tab' } })).text).toBe(
      '{\n\t"a": [\n\t\t1\n\t]\n}'
    )
  })

  it('広い字下げでも直列化の結果を確かめる', () => {
    const broken: Stringify = () => '{"a":1}'
    expect(
      serializeContent({ json: parse('{"a":1,"b":2}') }, format({ indent: { kind: 'spaces', count: 11 } }), broken)
    ).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('改行を開いたときの形へ戻す', () => {
    const json = parse('[1]')
    expect(
      serialized({ json }, format({ eol: 'crlf', eolDominant: 'crlf', finalNewline: true })).text
    ).toBe('[\r\n  1\r\n]\r\n')
    expect(serialized({ json }, format({ eol: 'cr', eolDominant: 'cr' })).text).toBe('[\r  1\r]')
  })

  it('末尾の改行の有無を保つ', () => {
    const json = parse('[1]')
    expect(serialized({ json }, format({ finalNewline: true })).text.endsWith(']\n')).toBe(true)
    expect(serialized({ json }, format({ finalNewline: false })).text.endsWith(']')).toBe(true)
  })

  it('テキストは改行だけを戻し、ほかに手を入れない', () => {
    const text = '{"a":1, /* c */ "b":2}\n// tail\n'
    expect(serialized({ text }, format({ eol: 'crlf', eolDominant: 'crlf' })).text).toBe(
      '{"a":1, /* c */ "b":2}\r\n// tail\r\n'
    )
  })

  it('混在の改行は多い方へ揃え、結果に印を残す', () => {
    const result = serialized({ text: '[\n1\n]' }, format({ eol: 'mixed', eolDominant: 'crlf' }))
    expect(result.text).toBe('[\r\n1\r\n]')
    expect(result.eolNormalized).toBe(true)
    expect(serialized({ text: '[1]' }, format()).eolNormalized).toBe(false)
  })

  it('直列化がキーを落とすと止まる', () => {
    const broken: Stringify = () => '{"a":1}'
    expect(serializeContent({ json: parse('{"a":1,"b":2}') }, format(), broken)).toEqual({
      ok: false,
      reason: 'mismatch'
    })
  })

  it('直列化がキーの順を変えると止まる', () => {
    const broken: Stringify = () => '{"b":2,"a":1}'
    expect(serializeContent({ json: parse('{"a":1,"b":2}') }, format(), broken)).toEqual({
      ok: false,
      reason: 'mismatch'
    })
  })

  it('直列化が数値の字面を変えると止まる', () => {
    const broken: Stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === 'object' && v?.isLosslessNumber ? Number(v.value) : v))
    expect(serializeContent({ json: parse('[1.0]') }, format(), broken)).toEqual({
      ok: false,
      reason: 'mismatch'
    })
  })

  it('直列化の例外で止まる', () => {
    const broken: Stringify = () => {
      throw new Error('fault')
    }
    expect(serializeContent({ json: [] }, format(), broken)).toEqual({ ok: false, reason: 'failed' })
  })

  it('直列化の結果がパースできないと止まる', () => {
    const broken: Stringify = () => '{"a":'
    expect(serializeContent({ json: [] }, format(), broken).ok).toBe(false)
  })

  it('表の編集の後の内容の形でも書く', () => {
    const content = { json: parse('[1.0]'), text: undefined } as never
    expect(serialized(content, format({ indent: { kind: 'none' } })).text).toBe('[1.0]')
  })

  it('文書が無いときは空のテキスト', () => {
    expect(serialized({ json: undefined }, format()).text).toBe('')
  })

  it('木の比較は数値の字面を区別する', () => {
    expect(isSameTree(parse('1.0'), parse('1'))).toBe(false)
    expect(isSameTree(parse('[{"a":1.0}]'), parse('[{"a":1.0}]'))).toBe(true)
    expect(isSameTree(1, parse('1'))).toBe(true)
  })

  it('木の比較は __proto__ のキーも見る', () => {
    const left = parse('{"__proto__":{"x":1}}')
    expect(isSameTree(left, parse('{"__proto__":{"x":1}}'))).toBe(true)
    expect(isSameTree(left, parse('{"__proto__":{"x":2}}'))).toBe(false)
  })

  it('孤立したサロゲートを見つける', () => {
    expect(isWellFormedText('a😀')).toBe(true)
    expect(isWellFormedText('a\ud800')).toBe(false)
  })

  it('エスケープの孤立サロゲートはそのまま残る', () => {
    const text = stringify(parse('["\\ud800"]'))
    expect(text).toBeDefined()
    expect(serialized({ json: parse('["\\ud800"]') }, format({ indent: { kind: 'none' } })).ok).toBe(true)
  })
})
