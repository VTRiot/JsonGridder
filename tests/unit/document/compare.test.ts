import { describe, expect, it } from 'vitest'
import { parse } from 'lossless-json'
import { isUnchanged } from '../../../src/document/compare'

describe('基準との比較', () => {
  const baseline = { text: '{\r\n  "a": 1.0,\r\n  "b": 2\r\n}\r\n' }

  it('テキストは改行を揃えて同じなら未編集', () => {
    expect(isUnchanged({ text: baseline.text.replaceAll('\r\n', '\n') }, baseline)).toBe(true)
    expect(isUnchanged({ text: baseline.text }, baseline)).toBe(true)
  })

  it('CR だけの改行も揃える', () => {
    expect(isUnchanged({ text: '[\n1\n]' }, { text: '[\r1\r]' })).toBe(true)
  })

  it('空白だけの編集は未編集にならない', () => {
    expect(isUnchanged({ text: baseline.text.replace('  "a"', '   "a"') }, baseline)).toBe(false)
  })

  it('テキストの整形だけの編集は未編集にならない', () => {
    expect(isUnchanged({ text: '{"a":1.0,"b":2}' }, baseline)).toBe(false)
  })

  it('テキストでキーを入れ替えると未編集にならない', () => {
    expect(isUnchanged({ text: '{"b":2,"a":1.0}' }, { text: '{"a":1.0,"b":2}' })).toBe(false)
  })

  it('文書の木が基準と同じなら未編集', () => {
    expect(isUnchanged({ json: parse(baseline.text) }, baseline)).toBe(true)
  })

  it('キーの入れ替えだけの文書は未編集にならない', () => {
    expect(isUnchanged({ json: parse('{"b":2,"a":1.0}') }, baseline)).toBe(false)
  })

  it('数値の字面だけの変更は未編集にならない', () => {
    expect(isUnchanged({ json: parse('{"a":1,"b":2}') }, baseline)).toBe(false)
  })

  it('編集して元へ戻した文書は未編集', () => {
    const edited = parse(baseline.text) as Record<string, unknown>
    const original = edited.b
    edited.b = parse('3')
    expect(isUnchanged({ json: edited }, baseline)).toBe(false)
    edited.b = original
    expect(isUnchanged({ json: edited }, baseline)).toBe(true)
  })

  it('表の編集の後の内容の形でも比べる', () => {
    const json = parse(baseline.text)
    expect(isUnchanged({ json, text: undefined } as never, baseline)).toBe(true)
    expect(isUnchanged({ json: [], text: undefined } as never, baseline)).toBe(false)
  })

  it('文書が無いときは未編集にならない', () => {
    expect(isUnchanged({ json: undefined }, baseline)).toBe(false)
  })

  it('基準がパースできないときは未編集にならない', () => {
    expect(isUnchanged({ json: [] }, { text: '{"a":' })).toBe(false)
  })

  it('基準が別のオブジェクトになれば計算し直す', () => {
    const content = { json: parse('[1]') }
    expect(isUnchanged(content, { text: '[1]' })).toBe(true)
    expect(isUnchanged(content, { text: '[2]' })).toBe(false)
  })
})
