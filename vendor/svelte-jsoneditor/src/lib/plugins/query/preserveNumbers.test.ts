import { describe, expect, test } from 'vitest'
import { parse, stringify } from 'lossless-json'
import type { JSONParser } from '$lib/types.js'
import { jsonQueryLanguage } from './jsonQueryLanguage.js'
import { withLiteralNumbers } from './preserveNumbers.js'

const language = withLiteralNumbers(jsonQueryLanguage)
const parser = { parse, stringify } as unknown as JSONParser

function run(text: string, query: string): string {
  return String(stringify(language.executeQuery(parse(text), query, parser)))
}

const DOCUMENT =
  '[{"id":12345678901234567890,"p":1.50,"q":1.0,"r":1,"s":"x"},{"id":12345678901234567891,"p":0.10,"q":2.0,"r":2,"s":"y"}]'

describe('withLiteralNumbers', () => {
  test('should keep a language without a lossless parser as it is', () => {
    expect(language.executeQuery([{ a: 1 }], 'map(.a)', JSON)).toEqual([1])
  })

  test('should give the whole document back for an empty query', () => {
    expect(run(DOCUMENT, '')).toBe(DOCUMENT)
  })

  test('should keep the objects that come out of filter and sort', () => {
    expect(run(DOCUMENT, 'sort(.p)')).toBe(
      '[{"id":12345678901234567891,"p":0.10,"q":2.0,"r":2,"s":"y"},{"id":12345678901234567890,"p":1.50,"q":1.0,"r":1,"s":"x"}]'
    )
    expect(run(DOCUMENT, 'filter(.q > 1)')).toBe(
      '[{"id":12345678901234567891,"p":0.10,"q":2.0,"r":2,"s":"y"}]'
    )
  })

  test('should write numbers that were taken out of the objects as they were written', () => {
    expect(run(DOCUMENT, 'map(.p)')).toBe('[1.50,0.10]')
    expect(run(DOCUMENT, 'pick(.p, .q, .r)')).toBe(
      '[{"p":1.50,"q":1.0,"r":1},{"p":0.10,"q":2.0,"r":2}]'
    )
  })

  test('should keep numbers that a number cannot hold, also when they round to the same', () => {
    expect(run(DOCUMENT, 'map(.id)')).toBe('[12345678901234567890,12345678901234567891]')
    expect(run(DOCUMENT, 'map({a: .id, b: .p})')).toBe(
      '[{"a":12345678901234567890,"b":1.50},{"a":12345678901234567891,"b":0.10}]'
    )
  })

  test('should tell apart the same value under different keys', () => {
    expect(run('[{"a":1.0,"b":1}]', 'pick(.a, .b)')).toBe('[{"a":1.0,"b":1}]')
  })

  test('should run calculations in a document with 1.0', () => {
    expect(run('[{"q":1.0},{"q":2}]', 'map(.q * 2)')).toBe('[2,4]')
  })

  test('should refuse a value that is written in more than one way', () => {
    const text = '[{"q":1.0},{"q":1}]'
    expect(() => run(text, 'map(.q)')).toThrow()
    expect(run(text, 'sort(.q)')).toBe(text)
  })

  test('should refuse a calculation in a document with unsafe numbers', () => {
    expect(() => run(DOCUMENT, 'map(.p * 2)')).toThrow()
  })

  const UNSAFE =
    '[{"id":12345678901234567890,"n":1},{"id":12345678901234567891,"n":2},{"id":5,"n":3}]'

  test.each([
    'uniqBy(.id)',
    'keyBy(.id)',
    'groupBy(.id)',
    'map(.id) | uniq()',
    'map(string(.id))',
    'map(.id) | join(",")',
    'sort(.id)',
    'sort(.id, "desc")',
    'map(.id) | sort()',
    'filter(.id > 1)',
    'filter(.id < 1)',
    'filter(.id >= 1)',
    'filter(.id <= 1)',
    'filter(.id == 12345678901234567000)',
    'filter(.id != 5)',
    'filter(.id in [1, 2])',
    'filter(.id not in [1, 2])',
    'map(number(.id))',
    'map(abs(.id))',
    'map(round(.id))',
    'map(.id) | max()',
    'map(.id) | sum()'
  ])('should stop %s on numbers that cannot be held exactly', (query) => {
    expect(() => run(UNSAFE, query)).toThrow()
  })

  test.each([
    ['uniqBy(.d)', '[{"d":0.12345678901234567890},{"d":0.12345678901234567891}]'],
    ['uniqBy(.d)', '[{"d":1e400},{"d":2e400}]'],
    ['map(string(.d))', '[{"d":9007199254740993}]']
  ])('should stop %s on %s', (query, text) => {
    expect(() => run(text, query)).toThrow()
  })

  test('should give the reason from the dictionary', () => {
    expect(() => run(UNSAFE, 'uniqBy(.id)')).toThrow(/cannot be held exactly/)
  })

  test.each([
    ['map(.id)', '[12345678901234567890,12345678901234567891,5]'],
    ['filter(.n > 1) | map(.id)', '[12345678901234567891,5]'],
    ['sort(.n, "desc") | map(.n)', '[3,2,1]'],
    ['map({ x: .id })', '[{"x":12345678901234567890},{"x":12345678901234567891},{"x":5}]'],
    ['map(.id) | limit(1)', '[12345678901234567890]'],
    ['filter(.n == 1) | map(.id)', '[12345678901234567890]'],
    ['map(.id) | size()', '3']
  ])('should run %s where the unsafe numbers only pass through', (query, expected) => {
    expect(run(UNSAFE, query)).toBe(expected)
  })

  test('should keep working with numbers that are held exactly', () => {
    const text = '[{"a":3},{"a":1},{"a":3}]'
    expect(run(text, 'uniqBy(.a)')).toBe('[{"a":3},{"a":1}]')
    expect(run(text, 'map(string(.a))')).toBe('["3","1","3"]')
    expect(run(text, 'sort(.a) | map(.a)')).toBe('[1,3,3]')
    expect(run(text, 'filter(.a == 1)')).toBe('[{"a":1}]')
    expect(run(text, 'map(.a) | uniq()')).toBe('[3,1]')
  })

  test('should refuse a result that is not a number in JSON', () => {
    expect(() => run('[1.5]', 'map(1 / 0)')).toThrow()
  })
})

describe('keys made from values', () => {
  const WORDS = ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']
  const rows = (key: string) => JSON.stringify(WORDS.concat('a').map((word) => ({ [key]: word })))

  test('uniqBy should keep rows with a value that is also an inherited name', () => {
    expect(JSON.parse(run(rows('name'), 'uniqBy(.name)'))).toHaveLength(WORDS.length + 1)
    expect(run('[{"name":"toString","n":1},{"name":"a","n":2}]', 'uniqBy(.name)')).toBe(
      '[{"name":"toString","n":1},{"name":"a","n":2}]'
    )
  })

  test('uniqBy should still drop real duplicates and keep the first', () => {
    expect(run('[{"a":"x","n":1},{"a":"x","n":2}]', 'uniqBy(.a)')).toBe('[{"a":"x","n":1}]')
  })

  test('uniqBy should keep the order of the rows', () => {
    expect(run('[{"a":3},{"a":1},{"a":2}]', 'uniqBy(.a)')).toBe('[{"a":3},{"a":1},{"a":2}]')
  })

  test('uniqBy should not treat different values as the same', () => {
    expect(run('[{"a":1},{"a":"1"}]', 'uniqBy(.a)')).toBe('[{"a":1},{"a":"1"}]')
    expect(run('[{"a":null},{"a":"null"}]', 'uniqBy(.a)')).toBe('[{"a":null},{"a":"null"}]')
    expect(run('[{"a":{"b":1}},{"a":{"b":2}}]', 'uniqBy(.a)')).toBe('[{"a":{"b":1}},{"a":{"b":2}}]')
    expect(run('[{"a":[1]},{"a":[2]}]', 'uniqBy(.a)')).toBe('[{"a":[1]},{"a":[2]}]')
  })

  test('uniqBy should work with a comparison in the argument', () => {
    expect(run('[{"a":1},{"a":2},{"a":3}]', 'uniqBy(.a > 1)')).toBe('[{"a":1},{"a":2}]')
  })

  test('uniqBy should stop on numbers that cannot be held exactly', () => {
    const text = '[{"a":12345678901234567890},{"a":12345678901234567891}]'
    expect(() => run(text, 'uniqBy(.a)')).toThrow('cannot be held')
    expect(() => run(text, 'uniqBy(.a > 1)')).toThrow('cannot be held')
    expect(() => run('[{"a":{"b":12345678901234567890}}]', 'uniqBy(.a)')).toThrow('cannot be held')
  })

  test('should not show internal names', () => {
    for (const query of ['uniqBy(.a > 1)', 'keyBy(string(.a > 1))', 'groupBy(string(.a > 1))']) {
      expect(() => run('[{"a":1},{"a":2}]', query)).not.toThrow()
    }
  })

  test('keyBy should keep rows with a value that is also an inherited name', () => {
    expect(run('[{"name":"toString","n":1},{"name":"a","n":2}]', 'keyBy(.name)')).toBe(
      '{"toString":{"name":"toString","n":1},"a":{"name":"a","n":2}}'
    )
  })

  test('keyBy should write the key __proto__ as a key', () => {
    expect(run('[{"name":"__proto__","n":1},{"name":"a","n":2}]', 'keyBy(.name)')).toBe(
      '{"__proto__":{"name":"__proto__","n":1},"a":{"name":"a","n":2}}'
    )
    expect(({} as Record<string, unknown>).n).toBeUndefined()
  })

  test('keyBy should keep the first row of real duplicates', () => {
    expect(run('[{"a":"x","n":1},{"a":"x","n":2}]', 'keyBy(.a)')).toBe('{"x":{"a":"x","n":1}}')
  })

  test('groupBy should group by a value that is also an inherited name', () => {
    expect(run(rows('w'), 'groupBy(.w) | keys()')).toBe(
      JSON.stringify(WORDS.concat('a'))
    )
    expect(run('[{"w":"constructor"},{"w":"valueOf"},{"w":"valueOf"}]', 'groupBy(.w)')).toBe(
      '{"constructor":[{"w":"constructor"}],"valueOf":[{"w":"valueOf"},{"w":"valueOf"}]}'
    )
    expect(run('[{"w":"__proto__","n":1}]', 'groupBy(.w)')).toBe(
      '{"__proto__":[{"w":"__proto__","n":1}]}'
    )
  })

  test.each(['keyBy(.a)', 'groupBy(.a)'])(
    '%s should stop when an object or array is the key',
    (query) => {
      expect(() => run('[{"a":{"b":1}},{"a":{"b":2}}]', query)).toThrow('is not a key')
      expect(() => run('[{"a":[1]},{"a":[2]}]', query)).toThrow('is not a key')
    }
  )

  test('mapObject should write the key __proto__ as a key', () => {
    expect(run('{"a":"__proto__","c":"d"}', 'mapObject({key: .value, value: .key})')).toBe(
      '{"__proto__":"a","d":"c"}'
    )
  })

  test('mapKeys should write the key __proto__ as a key', () => {
    expect(run('{"a":{"x":1}}', 'mapKeys("__proto__")')).toBe('{"__proto__":{"x":1}}')
  })

  test.each([
    ['{"ab":1,"ac":2}', 'mapKeys(substring(get(), 0, 1))'],
    ['{"a":"x","b":"x"}', 'mapObject({key: .value, value: .key})'],
    ['{"a":{"x":1},"b":{"x":2}}', 'mapKeys("same")']
  ])('should stop when two keys of %s end up the same', (text, query) => {
    expect(() => run(text, query)).toThrow('same key')
  })

  test.each([
    'map({a: .x, a: .y})',
    'map({a: .x, "a": .y})',
    'map({"\\u0061": .x, a: .y})',
    'map({b: {a: .x, a: .y}})',
    'map({1: .x, 1: .y})'
  ])('%s should stop instead of dropping one of the values', (query) => {
    expect(() => run('[{"x":1,"y":2}]', query)).toThrow('same key')
  })

  test.each([
    ['map({a: {a: .x}, b: .y})', '[{"a":{"a":1},"b":2}]'],
    ['map({p: "a: b", q: "a: b"})', '[{"p":"a: b","q":"a: b"}]'],
    ['map({a: .x}) | map({a: .a})', '[{"a":1}]'],
    ['map({a: {b: .x}, c: {b: .y}})', '[{"a":{"b":1},"c":{"b":2}}]']
  ])('%s should run', (query, expected) => {
    expect(run('[{"x":1,"y":2}]', query)).toBe(expected)
  })

  test.each(['keyBy(.id)', 'groupBy(.id)', 'uniqBy(.id)'])(
    '%s should name the number as the reason',
    (query) => {
      expect(() => run('[{"id":12345678901234567890}]', query)).toThrow('cannot be held')
    }
  )

  test('pick should stop when two columns end up with the same key', () => {
    expect(() => run('[{"a":{"x":1},"b":{"x":2}}]', 'pick(.a.x, .b.x)')).toThrow('same key')
  })

  test('mapValues should keep the key __proto__', () => {
    expect(run('{"__proto__":1,"a":2}', 'mapValues(get())')).toBe('{"__proto__":1,"a":2}')
  })

  test.each(['map({__proto__: .n})', 'map({"__proto__": .n})', 'map({__proto__: 1})'])(
    '%s should stop instead of dropping the key',
    (query) => {
      expect(() => run('[{"n":7}]', query)).toThrow('__proto__')
    }
  )

  test('should run a query that only mentions __proto__ as a value', () => {
    expect(run('[{"k":"__proto__"},{"k":"a"}]', 'filter(.k == "__proto__")')).toBe(
      '[{"k":"__proto__"}]'
    )
    expect(run('[{"k":"a"}]', 'map({x: "__proto__: 1"})')).toBe('[{"x":"__proto__: 1"}]')
  })
})

describe('numbers that a query makes', () => {
  test.each([
    ['[{"a":9007199254740991}]', 'map(.a + 2)'],
    ['[{"a":9007199254740991}]', 'map(.a * 3)'],
    ['[{"a":123456789012}]', 'map(.a * 12345678)'],
    ['[{"a":9007199254740991},{"a":2}]', 'map(.a) | sum()'],
    ['[{"id":9007199254740991,"keep":"x"}]', 'map({id: .id, next: .id + 2, keep: .keep})'],
    ['[{"a":9007199254740991}]', 'map(.a + 2 - 2)'],
    ['[{"a":9007199254740991}]', 'map((.a * 3) / 3)'],
    ['[{"a":"9007199254740993"}]', 'map(number(.a))'],
    ['[{"a":2}]', 'map(.a ^ 60)']
  ])('%s %s should stop instead of writing a rounded number', (text, query) => {
    expect(() => run(text, query)).toThrow('too large')
  })

  test('should give the reason when the result was calculated', () => {
    expect(() => run('[{"a":9007199254740991}]', 'map(.a + 2)')).toThrow('calculated')
  })

  test.each([
    ['[{"a":5}]', 'map(.a * 2)', '[10]'],
    ['[{"a":9007199254740990}]', 'map(.a + 1)', '[9007199254740991]'],
    ['[{"a":0.5}]', 'map(.a + 0.25)', '[0.75]'],
    ['[{"a":1.5}]', 'map(.a * 2)', '[3]'],
    ['[{"a":1},{"a":2}]', 'map(.a) | sum()', '3'],
    ['[{"a":1e300}]', 'map(.a)', '[1e300]'],
    ['[{"a":9007199254740991}]', 'map(.a)', '[9007199254740991]']
  ])('%s %s should still run', (text, query, expected) => {
    expect(run(text, query)).toBe(expected)
  })

  test('should keep a large integer that only passes through', () => {
    expect(run('[{"a":9007199254740992}]', 'map(.a)')).toBe('[9007199254740992]')
  })

  test('should not calculate with an integer that the digits only seem to hold', () => {
    expect(() => run('[{"a":1000000000000000000000}]', 'map(.a + 1)')).toThrow('cannot be held')
    expect(run('[{"a":1000000000000000000000}]', 'map(.a)')).toBe('[1000000000000000000000]')
  })

  test('should not compare or calculate with a large integer', () => {
    expect(() => run('[{"a":9007199254740992}]', 'filter(.a > 1)')).toThrow('cannot be held')
    expect(() => run('[{"a":9007199254740992}]', 'map(.a + 1)')).toThrow('cannot be held')
  })
})

describe('another query language', () => {
  test('should refuse a result that left the safe range in a language without checks', () => {
    const other = withLiteralNumbers({ ...jsonQueryLanguage, executeQuery: () => [2 ** 60] })
    expect(() => other.executeQuery(parse('[1]'), '', parser)).toThrow('too large')
  })
})

describe('numbers written in the query', () => {
  test.each([
    ['[{"a":1}]', 'map({id: 12345678901234567890})'],
    ['[{"a":1}]', 'map({r: 0.1000000000000000055})'],
    ['[{"x":0.1,"k":"a"},{"x":0.2,"k":"b"}]', 'filter(.x != 0.1000000000000000055)'],
    ['[{"a":1}]', 'map({id: 9007199254740993})'],
    ['[{"a":1}]', 'map({id: -9007199254740993})'],
    ['[{"a":0.10}]', 'map({r: 0.1000000000000000055})']
  ])('%s %s should stop', (text, query) => {
    expect(() => run(text, query)).toThrow('written in the query')
  })

  test('should name the number that cannot be held', () => {
    expect(() => run('[{"a":1}]', 'map({id: 12345678901234567890})')).toThrow('12345678901234567890')
  })

  test.each([
    ['[{"a":"12345678901234567890"}]', 'filter(.a == "12345678901234567890")'],
    ['[{"a":1}]', 'map({"12345678901234567890": .a})'],
    ['[{"a12345678901234567890":1}]', 'map(.a12345678901234567890)'],
    ['[{"a":1.5}]', 'filter(.a == 1.50)'],
    ['[{"a":1}]', 'map(.a + 1e3)']
  ])('%s %s should run', (text, query) => {
    expect(() => run(text, query)).not.toThrow()
  })
})

describe('the query that the wizard writes', () => {
  test('should keep the digits of a long number', () => {
    const query = jsonQueryLanguage.createQuery([], {
      filter: { path: ['x'], relation: '==', value: '12345678901234567890' }
    })
    expect(query).toContain('12345678901234567890')
  })

  test('should still write a normal number and text', () => {
    expect(
      jsonQueryLanguage.createQuery([], { filter: { path: ['x'], relation: '>', value: '12' } })
    ).toContain('> 12')
    expect(
      jsonQueryLanguage.createQuery([], { filter: { path: ['x'], relation: '==', value: 'abc' } })
    ).toContain('"abc"')
  })
})
