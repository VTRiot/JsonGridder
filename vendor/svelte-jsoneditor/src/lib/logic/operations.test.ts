import { test, describe, expect } from 'vitest'
import assert from 'assert'
import {
  append,
  clipboardToValues,
  duplicate,
  insertBefore,
  replace,
  canAddCellValue,
  createNestedValueOperations,
  findRefusedKey,
  createNewValue,
  insert,
  moveInsideParent,
  rename,
  revertJSONPatchWithMoveOperations
} from './operations.js'
import { createMultiSelection, createValueSelection } from './selection.js'
import { createDocumentState, documentStatePatch } from './documentState.js'
import type { JSONPatchOperation } from 'immutable-json-patch'
import { immutableJSONPatch } from 'immutable-json-patch'

describe('operations', () => {
  describe('createNewValue', () => {
    test('should create a value of type "value"', () => {
      assert.strictEqual(createNewValue({}, undefined, 'value'), '')
    })

    test('should create a value of type "object"', () => {
      assert.deepStrictEqual(createNewValue({}, undefined, 'object'), {})
    })

    test('should create a value of type "array"', () => {
      assert.deepStrictEqual(createNewValue({}, undefined, 'array'), [])
    })

    test('should create a simple value via type "structure"', () => {
      const json = [1, 2, 3]
      const path = ['0']
      const selection = createMultiSelection(path, path)

      assert.deepStrictEqual(createNewValue(json, selection, 'structure'), '')
    })

    test('should create a nested object via type "structure"', () => {
      const json = [
        {
          a: 2,
          b: {
            c: 3
          },
          d: [1, 2, 3]
        }
      ]
      const path = ['0']
      const selection = createMultiSelection(path, path)

      assert.deepStrictEqual(createNewValue(json, selection, 'structure'), {
        a: '',
        b: {
          c: ''
        },
        d: []
      })
    })
  })

  test('should turn clipboard text into an array with key/value pairs', () => {
    assert.deepStrictEqual(clipboardToValues('42', JSON), [{ key: 'New item', value: 42 }])

    assert.deepStrictEqual(clipboardToValues('Hello world', JSON), [
      { key: 'New item', value: 'Hello world' }
    ])

    assert.deepStrictEqual(clipboardToValues('"Hello world"', JSON), [
      { key: 'New item', value: 'Hello world' }
    ])

    assert.deepStrictEqual(clipboardToValues('[1,2,3]', JSON), [
      { key: 'New item', value: [1, 2, 3] }
    ])

    assert.deepStrictEqual(clipboardToValues('{"a": 2, "b": 3}', JSON), [
      { key: 'New item', value: { a: 2, b: 3 } }
    ])

    // partial array
    assert.deepStrictEqual(clipboardToValues('1, 2, 3,', JSON), [
      { key: 'New item 0', value: 1 },
      { key: 'New item 1', value: 2 },
      { key: 'New item 2', value: 3 }
    ])
    assert.deepStrictEqual(clipboardToValues('1,\n2,\n3,\n', JSON), [
      { key: 'New item 0', value: 1 },
      { key: 'New item 1', value: 2 },
      { key: 'New item 2', value: 3 }
    ])
    assert.deepStrictEqual(clipboardToValues('1,\n2,\n3\n', JSON), [
      { key: 'New item 0', value: 1 },
      { key: 'New item 1', value: 2 },
      { key: 'New item 2', value: 3 }
    ])
    assert.deepStrictEqual(clipboardToValues('{"id":1},{"id":2},{"id":3}', JSON), [
      { key: 'New item 0', value: { id: 1 } },
      { key: 'New item 1', value: { id: 2 } },
      { key: 'New item 2', value: { id: 3 } }
    ])

    // partial object
    assert.deepStrictEqual(clipboardToValues('"a": 2,\n"b": 3,\n', JSON), [
      { key: 'a', value: 2 },
      { key: 'b', value: 3 }
    ])
    assert.deepStrictEqual(clipboardToValues('"a": 2,\n"b": 3\n', JSON), [
      { key: 'a', value: 2 },
      { key: 'b', value: 3 }
    ])
  })

  describe('moveInsideParent', () => {
    test('should move a selection up inside an array', () => {
      const json = { array: [0, 1, 2, 3, 4, 5] }
      const documentState = createDocumentState({ json, expand: () => true })
      const selection = createMultiSelection(['array', '3'], ['array', '4'])
      const path = ['array', '1']
      const operations = moveInsideParent(json, selection, {
        beforePath: path,
        offset: 0
      })
      assert.deepStrictEqual(operations, [
        { op: 'move', from: '/array/3', path: '/array/1' },
        { op: 'move', from: '/array/4', path: '/array/2' }
      ])

      const updatedJson = documentStatePatch(json, documentState, operations).json
      assert.deepStrictEqual(updatedJson, { array: [0, 3, 4, 1, 2, 5] })
    })

    test('should move a selection down inside an array', () => {
      const json = { array: [0, 1, 2, 3, 4, 5] }
      const documentState = createDocumentState({ json, expand: () => true })
      const selection = createMultiSelection(['array', '1'], ['array', '2'])
      const path = ['array', '4']
      const operations = moveInsideParent(json, selection, {
        beforePath: path,
        offset: 0
      })
      assert.deepStrictEqual(operations, [
        { op: 'move', from: '/array/1', path: '/array/4' },
        { op: 'move', from: '/array/1', path: '/array/4' }
      ])

      const updatedJson = documentStatePatch(json, documentState, operations).json
      assert.deepStrictEqual(updatedJson, { array: [0, 3, 4, 1, 2, 5] })
    })

    test('should move a selection up inside an object', () => {
      const json = { object: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' } }
      const documentState = createDocumentState({ json, expand: () => true })
      const selection = createMultiSelection(['object', 'c'], ['object', 'd'])
      const path = ['object', 'b']
      const operations = moveInsideParent(json, selection, {
        beforePath: path,
        offset: 0
      })
      assert.deepStrictEqual(operations, [
        { op: 'move', from: '/object/b', path: '/object/b' },
        { op: 'move', from: '/object/e', path: '/object/e' }
      ])

      const { json: updatedJson, documentState: updatedDocumentState } = documentStatePatch(
        json,
        documentState,
        operations
      )
      assert.deepStrictEqual(updatedJson, { object: { a: 'a', c: 'c', d: 'd', b: 'b', e: 'e' } })
      assert.deepStrictEqual(updatedDocumentState, documentState)
      assert.deepStrictEqual(Object.keys(updatedJson.object), ['a', 'c', 'd', 'b', 'e'])
    })

    test('should move a selection down inside an object', () => {
      const json = { object: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' } }
      const documentState = createDocumentState({ json, expand: () => true })
      const selection = createMultiSelection(['object', 'b'], ['object', 'c'])
      const path = ['object', 'e']
      const operations = moveInsideParent(json, selection, {
        beforePath: path,
        offset: 0
      })
      assert.deepStrictEqual(operations, [
        { op: 'move', from: '/object/b', path: '/object/b' },
        { op: 'move', from: '/object/c', path: '/object/c' },
        { op: 'move', from: '/object/e', path: '/object/e' }
      ])

      const { json: updatedJson, documentState: updatedDocumentState } = documentStatePatch(
        json,
        documentState,
        operations
      )
      assert.deepStrictEqual(updatedJson, { object: { a: 'a', d: 'd', b: 'b', c: 'c', e: 'e' } })
      assert.deepStrictEqual(updatedDocumentState, documentState)
      assert.deepStrictEqual(Object.keys(updatedJson.object), ['a', 'd', 'b', 'c', 'e'])
    })

    // TODO: test append, moving to bottom of an array
    // TODO: test append, moving to bottom of an object
    // TODO: test moving up from the bottom of an array
    // TODO: test moving up from the bottom of an object
  })

  describe('revertJSONPatchWithMoveOperations', () => {
    test('should restore key order when reverting a remove operation ', () => {
      const json = {
        a: 2,
        b: 3,
        c: 4
      }
      assert.deepStrictEqual(Object.keys(json), ['a', 'b', 'c'])

      const operations: JSONPatchOperation[] = [{ op: 'remove', path: '/b' }]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(updatedJson, { a: 2, c: 4 })
      assert.deepStrictEqual(Object.keys(updatedJson), ['a', 'c'])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'add', path: '/b', value: 3 },
        { op: 'move', from: '/c', path: '/c' }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['a', 'b', 'c'])
    })

    test('should restore key order when reverting a move operation ', () => {
      const json = {
        a: 2,
        b: 3,
        c: 4,
        nested: {}
      }
      assert.deepStrictEqual(Object.keys(json), ['a', 'b', 'c', 'nested'])

      const operations: JSONPatchOperation[] = [{ op: 'move', from: '/b', path: '/nested/b' }]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(updatedJson, { a: 2, c: 4, nested: { b: 3 } })
      assert.deepStrictEqual(Object.keys(updatedJson), ['a', 'c', 'nested'])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'move', from: '/nested/b', path: '/b' },
        { op: 'move', from: '/c', path: '/c' },
        { op: 'move', from: '/nested', path: '/nested' }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['a', 'b', 'c', 'nested'])
    })

    test('should restore key order when sorting all keys of an object ', () => {
      const json = {
        b: 2,
        a: 1,
        c: 3
      }
      assert.deepStrictEqual(Object.keys(json), ['b', 'a', 'c'])

      const operations: JSONPatchOperation[] = [
        { op: 'move', from: '/a', path: '/a' },
        { op: 'move', from: '/b', path: '/b' },
        { op: 'move', from: '/c', path: '/c' }
      ]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(Object.keys(updatedJson as Record<string, number>), ['a', 'b', 'c'])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'move', from: '/a', path: '/a' },
        { op: 'move', from: '/c', path: '/c' }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['b', 'a', 'c'])
    })

    test('should remove redundant move operations when renaming a key and maintaining order (1)', () => {
      const json = {
        a: 1,
        b: 2,
        c: 3
      }

      const operations: JSONPatchOperation[] = [{ op: 'move', from: '/b', path: '/b_renamed' }]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(Object.keys(updatedJson as Record<string, number>), [
        'a',
        'c',
        'b_renamed'
      ])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'move', from: '/b_renamed', path: '/b' },
        { op: 'move', from: '/c', path: '/c' },
        { op: 'move', from: '/c', path: '/c' } // TODO: would be neat to remove the duplicate
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['a', 'b', 'c'])
    })

    test('should remove redundant move operations when renaming a key and maintaining order (2)', () => {
      const json = {
        a: 1,
        b: 2,
        c: 3
      }

      const operations: JSONPatchOperation[] = [
        { op: 'move', from: '/b', path: '/b_renamed' },
        { op: 'move', from: '/c', path: '/c' }
      ]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(Object.keys(updatedJson as Record<string, number>), [
        'a',
        'b_renamed',
        'c'
      ])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'move', from: '/b_renamed', path: '/b' },
        { op: 'move', from: '/c', path: '/c' }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['a', 'b', 'c'])
    })

    test('should remove redundant move operations when renaming a key and maintaining order (3)', () => {
      const json = {
        a: 1,
        b: 2,
        c: 3
      }

      const operations: JSONPatchOperation[] = [
        { op: 'move', from: '/c', path: '/c_renamed' },
        { op: 'move', from: '/a', path: '/a' } // we move `a` to the end (different operation)
      ]
      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(Object.keys(updatedJson as Record<string, number>), [
        'b',
        'c_renamed',
        'a'
      ])

      // Note: there are optimizations possible in the following revert operations,
      //  but this is a made up example, not a real world example, quite an edge case.
      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'move', from: '/c_renamed', path: '/c' },
        { op: 'move', from: '/b', path: '/b' },
        { op: 'move', from: '/b', path: '/b' }, // TODO: would be neath to remove the duplicate
        { op: 'move', from: '/c', path: '/c' }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
      assert.deepStrictEqual(Object.keys(revertedJson), ['a', 'b', 'c'])
    })

    test('should perform well when creating the revert patch of renaming a key in a large object', () => {
      console.time('revert large patch')
      const count = 100
      const json: Record<string, number> = {}
      for (let i = 0; i < count; i++) {
        json['item ' + i] = i
      }

      const operations = rename([], Object.keys(json), 'item 0', 'item 0 (renamed)')
      expect(operations.length).toEqual(count)
      const updatedJson = immutableJSONPatch(json, operations)

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      expect(revertOperations.length).toEqual(count)
      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      expect(revertedJson).toEqual(json)
      console.timeEnd('revert large patch')
    }, /* timeout */ 200)

    test('should restore correctly revert multiple remove operations in an array', () => {
      const json = [0, 1, 2, 3, 4]

      const operations: JSONPatchOperation[] = [
        { op: 'remove', path: '/4' },
        { op: 'remove', path: '/3' },
        { op: 'remove', path: '/2' }
      ]

      const updatedJson = immutableJSONPatch(json, operations)
      assert.deepStrictEqual(updatedJson, [0, 1])

      const revertOperations = revertJSONPatchWithMoveOperations(json, operations)
      assert.deepStrictEqual(revertOperations, [
        { op: 'add', path: '/2', value: 2 },
        { op: 'add', path: '/3', value: 3 },
        { op: 'add', path: '/4', value: 4 }
      ])

      const revertedJson = immutableJSONPatch(updatedJson, revertOperations)
      assert.deepStrictEqual(revertedJson, json)
    })
  })

  describe('createNestedValueOperations', () => {
    test('should create parent object operation of a nest value when missing', () => {
      const json = {}

      const operations: JSONPatchOperation[] = [{ op: 'replace', path: '/nested/value', value: 42 }]
      const updatedOperations = createNestedValueOperations(operations, json)

      assert.deepStrictEqual(updatedOperations, [
        { op: 'add', path: '/nested', value: {} },
        { op: 'add', path: '/nested/value', value: 42 }
      ])
    })

    test('should create parent object operation of a nest value in an array when missing', () => {
      const json = [{}, {}, {}]

      const operations: JSONPatchOperation[] = [
        { op: 'replace', path: '/2/nested/value', value: 42 }
      ]
      const updatedOperations = createNestedValueOperations(operations, json)

      assert.deepStrictEqual(updatedOperations, [
        { op: 'add', path: '/2/nested', value: {} },
        { op: 'add', path: '/2/nested/value', value: 42 }
      ])
    })

    test('should create parent object operation of a deep nest value when missing', () => {
      const json = {}

      const operations: JSONPatchOperation[] = [
        { op: 'replace', path: '/deep/nested/value', value: 42 }
      ]
      const updatedOperations = createNestedValueOperations(operations, json)

      assert.deepStrictEqual(updatedOperations, [
        { op: 'add', path: '/deep', value: {} },
        { op: 'add', path: '/deep/nested', value: {} },
        { op: 'add', path: '/deep/nested/value', value: 42 }
      ])
    })

    test('should not create parent objects when already existing', () => {
      const json = { deep: { nested: {} } }

      const operations: JSONPatchOperation[] = [
        { op: 'replace', path: '/deep/nested/value', value: 42 }
      ]
      const updatedOperations = createNestedValueOperations(operations, json)

      assert.deepStrictEqual(updatedOperations, [
        { op: 'add', path: '/deep/nested/value', value: 42 }
      ])
    })

    test('should keep replacing a key that exists', () => {
      const operations: JSONPatchOperation[] = [{ op: 'replace', path: '/0/a', value: 2 }]

      assert.deepStrictEqual(createNestedValueOperations(operations, [{ a: 1 }]), operations)
    })

    test('should add a key that only exists as an inherited name', () => {
      const operations: JSONPatchOperation[] = [{ op: 'replace', path: '/0/toString', value: 2 }]

      assert.deepStrictEqual(createNestedValueOperations(operations, [{ a: 1 }]), [
        { op: 'add', path: '/0/toString', value: 2 }
      ])
    })

    test('should add an empty string like any other value', () => {
      const replaceKey: JSONPatchOperation[] = [{ op: 'replace', path: '/0/b', value: '' }]

      assert.deepStrictEqual(createNestedValueOperations(replaceKey, [{ a: 1 }]), [
        { op: 'add', path: '/0/b', value: '' }
      ])
    })

    test('should leave an existing item of an array as it is', () => {
      const operations: JSONPatchOperation[] = [{ op: 'replace', path: '/1/a/0', value: 7 }]

      assert.deepStrictEqual(
        createNestedValueOperations(operations, [{ a: { 0: 1 } }, { a: [5] }]),
        operations
      )
    })

    test('should not create operations when a key cannot be added', () => {
      const operations: JSONPatchOperation[] = [{ op: 'replace', path: '/1/a/b', value: 7 }]

      for (const parent of [5, 's', [1], null, true]) {
        assert.deepStrictEqual(
          createNestedValueOperations(operations, [{ a: { b: 1 } }, { a: parent }]),
          []
        )
      }
      for (const row of [5, 's', [1], null]) {
        assert.deepStrictEqual(createNestedValueOperations(operations, [{ a: { b: 1 } }, row]), [])
      }
    })
  })

  describe('canAddCellValue', () => {
    test('should accept a cell that holds a value', () => {
      assert.strictEqual(canAddCellValue([{ a: 1 }], ['0', 'a']), true)
      assert.strictEqual(canAddCellValue([{ a: [5] }], ['0', 'a', '0']), true)
      assert.strictEqual(canAddCellValue([[5]], ['0', '0']), true)
    })

    test('should accept a missing key of an object and missing parents', () => {
      assert.strictEqual(canAddCellValue([{ a: 1 }], ['0', 'b']), true)
      assert.strictEqual(canAddCellValue([{ a: 1 }], ['0', 'b', 'c']), true)
      assert.strictEqual(canAddCellValue([{ a: 1 }], ['0', 'toString']), true)
    })

    test('should refuse a cell inside something else than an object', () => {
      assert.strictEqual(canAddCellValue([{ a: 1 }], ['0', 'a', 'b']), false)
      assert.strictEqual(canAddCellValue([{ a: [5] }], ['0', 'a', '3']), false)
      assert.strictEqual(canAddCellValue([{ a: [5] }], ['0', 'a', 'b']), false)
      assert.strictEqual(canAddCellValue([5], ['0', 'a']), false)
      assert.strictEqual(canAddCellValue(['abc'], ['0', '0']), false)
    })
  })

  describe('findRefusedKey', () => {
    const parser = {
      parse(text: string) {
        if (text.includes('"constructor"')) {
          throw new SyntaxError('refused')
        }
        return JSON.parse(text)
      },
      stringify: JSON.stringify
    }

    test('should look at the keys at the top of a value', () => {
      const value = JSON.parse('{"constructor":1}')

      assert.ok(findRefusedKey([{ op: 'replace', path: '', value }], parser))
      assert.ok(findRefusedKey([{ op: 'add', path: '/a', value }], parser))
    })

    test('should look inside a value', () => {
      const value = JSON.parse('{"x":[{"constructor":1}]}')

      assert.ok(findRefusedKey([{ op: 'replace', path: '/a', value }], parser))
    })

    test('should accept other values', () => {
      assert.strictEqual(
        findRefusedKey([{ op: 'replace', path: '', value: { a: 1 } }], parser),
        undefined
      )
    })
  })

  describe('insert into a selected value', () => {
    const selection = createValueSelection(['a'])
    const json = { a: 1 }

    function pasted(text: string) {
      return insert(json, selection, text, JSON)
    }

    test('should parse valid JSON', () => {
      assert.deepStrictEqual(pasted('[1,2]'), [{ op: 'replace', path: '/a', value: [1, 2] }])
      assert.deepStrictEqual(pasted('""'), [{ op: 'replace', path: '/a', value: '' }])
    })

    test('should keep everything else as text', () => {
      for (const text of ['hello, world', '1,2', '[1,2', '{a:1}', ' ', '\n', 'a: 1']) {
        assert.deepStrictEqual(pasted(text), [{ op: 'replace', path: '/a', value: text }])
      }
    })

    test('should not replace the document with white space', () => {
      assert.deepStrictEqual(insert(json, createValueSelection([]), '  ', JSON), [])
    })
  })

  describe('clipboardToValues', () => {
    test('should keep white space as text', () => {
      assert.deepStrictEqual(clipboardToValues(' ', JSON), [{ key: 'New item', value: ' ' }])
    })
  })

  describe('revertJSONPatchWithMoveOperations with inherited names', () => {
    test('should remove a key with the name of an inherited property', () => {
      const operations: JSONPatchOperation[] = [{ op: 'add', path: '/0/toString', value: 7 }]

      assert.deepStrictEqual(revertJSONPatchWithMoveOperations([{ a: 1 }], operations), [
        { op: 'remove', path: '/0/toString' }
      ])
    })
  })

  describe('findRefusedKey', () => {
    const parser = {
      parse: (text: string) =>
        JSON.parse(text, (key, value) => {
          if (key === 'refused') {
            throw new SyntaxError('refused key')
          }
          return value
        }),
      stringify: JSON.stringify
    }

    test('should accept operations that create allowed keys', () => {
      const operations: JSONPatchOperation[] = [
        { op: 'add', path: '/a', value: { b: 1 } },
        { op: 'move', from: '/a', path: '/c' },
        { op: 'replace', path: '/c', value: 2 },
        { op: 'remove', path: '/c' }
      ]

      assert.strictEqual(findRefusedKey(operations, parser), undefined)
    })

    test('should refuse a key that the parser refuses', () => {
      for (const operation of [
        { op: 'add', path: '/refused', value: 1 },
        { op: 'move', from: '/a', path: '/refused' },
        { op: 'copy', from: '/a', path: '/x/refused' }
      ] as JSONPatchOperation[]) {
        assert.strictEqual(findRefusedKey([operation], parser)?.message, 'refused key')
      }
    })

    test('should refuse a key inside a value', () => {
      const operations: JSONPatchOperation[] = [
        { op: 'replace', path: '/a', value: [{ refused: 1 }] }
      ]

      assert.strictEqual(findRefusedKey(operations, parser)?.message, 'refused key')
    })
  })

  describe('canAddCellValue', () => {
    test('should accept a cell with a value, a missing key, and a missing parent', () => {
      const json = [{ a: { b: 1 } }, { c: 1 }]

      assert.strictEqual(canAddCellValue(json, ['0', 'a', 'b']), true)
      assert.strictEqual(canAddCellValue(json, ['1', 'd']), true)
      assert.strictEqual(canAddCellValue(json, ['1', 'a', 'b']), true)
    })

    test('should refuse a cell below a value that is not an object', () => {
      assert.strictEqual(canAddCellValue([{ a: 5 }], ['0', 'a', 'b']), false)
      assert.strictEqual(canAddCellValue([{ a: [1] }], ['0', 'a', 'b']), false)
      assert.strictEqual(canAddCellValue([{ a: null }], ['0', 'a', 'b']), false)
      assert.strictEqual(canAddCellValue([5], ['0', 'a']), false)
      assert.strictEqual(canAddCellValue([[1]], ['0', 'a']), false)
    })
  })

  describe('undo of moving keys in a nested object', () => {
    test.each([
      [{ q: 0, n: { z: 1, y: 2, x: 3 } }, ['n', 'z'], ['n', 'x']],
      [{ q: 0, n: { z: 1, y: 2, x: 3 } }, ['n', 'x'], ['n', 'z']],
      [{ b: 0, n: { b: 1, c: 2, d: 3 } }, ['n', 'b'], ['n', 'd']],
      [{ y: 0, n: { z: 1, y: 2, x: 3 } }, ['n', 'y'], ['n', 'z']],
      [[{ z: 1, y: 2, x: 3 }], ['0', 'z'], ['0', 'x']],
      [{ root: { '/': 3, '': [] }, '~': 1 }, ['root', ''], ['root', '/']],
      [{ z: 1, y: 2, x: 3 }, ['z'], ['x']]
    ])('should restore the order of the keys of %j', (json, from, beforePath) => {
      const operations = moveInsideParent(json, createMultiSelection(from, from), {
        beforePath,
        indexOffset: 0
      })
      const undo = revertJSONPatchWithMoveOperations(json, operations)
      const patched = documentStatePatch(json, createDocumentState({ json }), operations)
      const undone = documentStatePatch(patched.json, patched.documentState, undo)
      assert.strictEqual(JSON.stringify(undone.json), JSON.stringify(json))
    })
  })

  describe('undo of moves that change nothing', () => {
    test('should not make a move for a key that does not exist', () => {
      const json = { a: 1, b: 2 }
      const operations = [
        { op: 'move' as const, from: '/a', path: '/a' },
        { op: 'move' as const, from: '/b', path: '/b' }
      ]
      assert.deepStrictEqual(revertJSONPatchWithMoveOperations(json, operations), [])
    })
  })

  describe('several values under one object', () => {
    const count = (json: unknown) => Object.keys(json as object).length

    test('insert should not write two values to the same name', () => {
      const json = { a: 1 }
      const values = [
        { key: 'a', value: 2 },
        { key: 'a (copy)', value: 3 }
      ]
      const patched = immutableJSONPatch(json, insertBefore(json, ['a'], values))
      assert.strictEqual(count(patched), 3)
    })

    test('append should not write two values to the same name', () => {
      const json = { a: 1 }
      const values = [
        { key: 'a', value: 2 },
        { key: 'a (copy)', value: 3 }
      ]
      const patched = immutableJSONPatch(json, append(json, [], values))
      assert.strictEqual(count(patched), 3)
    })

    test('replace should not write two values to the same name', () => {
      const json = { a: 1, b: 2 }
      const values = [
        { key: 'b', value: 3 },
        { key: 'b (copy)', value: 4 }
      ]
      const patched = immutableJSONPatch(json, replace(json, [['a']], values))
      assert.strictEqual(count(patched), 3)
    })

    test('duplicate should not write two values to the same name', () => {
      const json = { a: 1, 'a (copy)': 2 }
      const patched = immutableJSONPatch(json, duplicate(json, [['a'], ['a (copy)']]))
      assert.strictEqual(count(patched), 4)
    })
  })

  // TODO: write tests for all operations
})
