import { describe, expect, test } from 'vitest'
import { immutableJSONPatch, parsePath, revertJSONPatch } from './jsonPatch.js'

describe('jsonPatch', () => {
  test('should read "-" as the end of an array', () => {
    expect(immutableJSONPatch([1], [{ op: 'add', path: '/-', value: 2 }])).toEqual([1, 2])
    expect(parsePath([1, 2], '/-')).toEqual(['2'])
  })

  test('should read "-" as a plain key of an object', () => {
    expect(parsePath({ a: 1 }, '/-')).toEqual(['-'])
    expect(parsePath({ a: { b: 1 } }, '/a/-')).toEqual(['a', '-'])
    expect(immutableJSONPatch({ a: 1 }, [{ op: 'add', path: '/-', value: 2 }])).toEqual({
      a: 1,
      '-': 2
    })
    expect(immutableJSONPatch({ '-': 1 }, [{ op: 'replace', path: '/-', value: 2 }])).toEqual({
      '-': 2
    })
    expect(immutableJSONPatch({ '-': 1, b: 2 }, [{ op: 'remove', path: '/-' }])).toEqual({ b: 2 })
  })

  test('should keep the key order when moving "-" in place', () => {
    const moved = immutableJSONPatch({ '-': 1, b: 2 }, [{ op: 'move', from: '/-', path: '/-' }])
    expect(Object.keys(moved as object)).toEqual(['b', '-'])
  })

  test('should revert operations on the key "-"', () => {
    const document = { '-': 1 }
    const operations = [{ op: 'replace' as const, path: '/-', value: 2 }]
    const revert = revertJSONPatch(document, operations)
    expect(revert).toEqual([{ op: 'replace', path: '/-', value: 1 }])
    expect(immutableJSONPatch(immutableJSONPatch(document, operations), revert)).toEqual(document)

    const added = [{ op: 'add' as const, path: '/-', value: 2 }]
    expect(revertJSONPatch({ a: 1 }, added)).toEqual([{ op: 'remove', path: '/-' }])
  })

  test('should revert appending to an array', () => {
    const revert = revertJSONPatch([1], [{ op: 'add', path: '/-', value: 2 }])
    expect(revert).toEqual([{ op: 'remove', path: '/1' }])
  })
})
