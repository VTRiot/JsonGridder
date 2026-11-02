import { describe, expect, it } from 'vitest'
import { strictParser, TextOnlyDocumentError } from '../../../src/editor/parser'
import ja from '../../../src/i18n/ja.json'

const BACKSLASH = String.fromCharCode(92)

describe('厳格パーサ', () => {
  it('数値の字面を保つ', () => {
    const text = '[1.0,0.10,1e400,-0,12345678901234567890]'
    expect(strictParser.stringify(strictParser.parse(text))).toBe(text)
  })

  it.each([
    ['__proto__', '{"__proto__":{"x":1}}'],
    ['constructor', '{"constructor":1}'],
    ['入れ子の __proto__', '[{"a":[{"__proto__":1}]}]'],
    ['入れ子の constructor', '{"a":{"b":{"constructor":{}}}}']
  ])('%s を拒否する', (_, text) => {
    expect(() => strictParser.parse(text)).toThrow(SyntaxError)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('拒否の文言は辞書から引く', () => {
    const [prefix] = ja['app.parser.reservedKey'].split('{{key}}')
    expect(() => strictParser.parse('{"constructor":1}')).toThrow(`${prefix}constructor`)
  })

  it('文字列の値にある同じ語は拒否しない', () => {
    expect(strictParser.parse('["__proto__","constructor"]')).toEqual(['__proto__', 'constructor'])
  })

  it('他の継承の名前は通す', () => {
    expect(() => strictParser.parse('{"toString":1,"valueOf":2}')).not.toThrow()
  })

  it('不正な JSON は例外になる', () => {
    expect(() => strictParser.parse('{"a":1,')).toThrow()
  })

  it.each([
    ['同値', '{"a":1,"a":1}'],
    ['別の値', '{"a":1,"a":2}'],
    ['別の字面', '{"a":1.0,"a":1}'],
    ['入れ子の同値', '{"a":{"x":1},"a":{"x":1}}'],
    ['配列の中', '[{"x":{"k":"v","k":"v"}}]'],
    ['離れた位置', '{"b":2,"c":[1,{"d":1}],"b":2}'],
    ['エスケープの違い', `{"a":1,"${BACKSLASH}u0061":1}`],
    ['空のキー', '{"":1,"":1}']
  ])('重複キー（%s）を辞書の文言で拒否する', (_, text) => {
    expect(() => strictParser.parse(text)).toThrow(ja['app.parser.duplicateKey'])
  })

  it.each([
    ['別のオブジェクトの同じキー', '[{"a":1},{"a":1}]'],
    ['親と子の同じキー', '{"a":{"a":1}}'],
    ['値の文字列のキーの形', '{"a":"\\"a\\":1","b":"a"}'],
    ['値と同じ名前', '{"a":"a"}']
  ])('%s は重複ではない', (_, text) => {
    expect(() => strictParser.parse(text)).not.toThrow()
  })

  it('テキストの表示に限る文書の拒否を型で見分ける', () => {
    expect(() => strictParser.parse('{"a":1,"a":1}')).toThrow(TextOnlyDocumentError)
    expect(() => strictParser.parse('{"constructor":1}')).toThrow(TextOnlyDocumentError)
    expect(() => strictParser.parse('{"a":1,')).not.toThrow(TextOnlyDocumentError)
  })

  const LARGE_ARRAY_LENGTH = 2_000_000 // 大文書の条件の要素数
  const LARGE_PARSE_TIMEOUT_MS = 60000 // 全部の試験を並べて回す負荷でも足りる長さ

  it(
    '要素数の多い配列でも落ちない',
    () => {
      const text = `[${'1,'.repeat(LARGE_ARRAY_LENGTH - 1)}1]`
      expect((strictParser.parse(text) as unknown[]).length).toBe(LARGE_ARRAY_LENGTH)
    },
    LARGE_PARSE_TIMEOUT_MS
  )

  it(
    '要素数の多い入れ子の配列でも落ちない',
    () => {
      const text = `{"rows":[${'{"a":1},'.repeat(LARGE_ARRAY_LENGTH - 1)}{"a":1}]}`
      const value = strictParser.parse(text) as { rows: unknown[] }
      expect(value.rows.length).toBe(LARGE_ARRAY_LENGTH)
    },
    LARGE_PARSE_TIMEOUT_MS
  )
})
