import { cloneDeepWith, first, initial, isEmpty, isEqual, last, times } from 'lodash-es'
import {
  compileJSONPointer,
  getIn,
  isJSONArray,
  isJSONObject,
  isJSONPatchAdd,
  isJSONPatchCopy,
  isJSONPatchMove,
  isJSONPatchRemove,
  isJSONPatchReplace,
  type JSONPatchAdd,
  type JSONPatchCopy,
  type JSONPatchDocument,
  type JSONPatchMove,
  type JSONPatchOperation,
  type JSONPath,
  parseJSONPointer,
} from 'immutable-json-patch'
import { revertJSONPatch } from './jsonPatch.js'
import { parseAndRepair, parseAndRepairOrUndefined, parsePartialJson } from '../utils/jsonUtils.js'
import { findUniqueName } from '../utils/stringUtils.js'
import { tString } from '../i18n/index.js'
import { isObject, isObjectOrArray } from '../utils/typeUtils.js'
import { getNextKeys } from './documentState.js'
import {
  createAfterSelection,
  createInsideSelection,
  createSelectionFromOperations,
  createValueSelection,
  getEndPath,
  getFocusPath,
  getParentPath,
  getSelectionPaths,
  getStartPath,
  isAfterSelection,
  isInsideSelection,
  isKeySelection,
  isMultiSelection,
  isValueSelection,
  getInDocument,
  pathExistsInDocument,
  pathStartsWith
} from './selection.js'
import type { ClipboardValues, DragInsideAction, JSONParser, JSONSelection } from '$lib/types'
import { int } from '../utils/numberUtils.js'

/**
 * Create a JSONPatch for an insert operation.
 *
 * This function needs the current data in order to be able to determine
 * a unique property name for the inserted node in case of duplicating
 * and object property
 */
// TODO: write tests
export function insertBefore(
  json: unknown,
  path: JSONPath,
  values: ClipboardValues
): JSONPatchDocument {
  const parentPath = initial(path)
  const parent = getIn(json, parentPath)

  if (isJSONArray(parent)) {
    // the path is parsed from a JSONPatch operation,
    // so array indices are a string which we have to parse into a number
    const offset = int(last(path) as string)
    return values.map((entry, index) => ({
      op: 'add',
      path: compileJSONPointer(parentPath.concat(String(offset + index))),
      value: entry.value
    }))
  } else if (isJSONObject(parent)) {
    // 'object'
    const afterKey = last(path)
    const keys = Object.keys(parent)
    const nextKeys = afterKey !== undefined ? getNextKeys(keys, afterKey, true) : []
    const takeName = createNameTaker(keys)

    return [
      // insert new values
      ...values.map((entry) => {
        const newProp = takeName(entry.key)
        return {
          op: 'add',
          path: compileJSONPointer(parentPath.concat(newProp)),
          value: entry.value
        } as JSONPatchAdd
      }),

      // move all lower down keys so the inserted key will maintain its position
      ...nextKeys.map((key) => moveDown(parentPath, key))
    ]
  } else {
    throw new Error('Cannot create insert operations: parent must be an Object or Array')
  }
}

/**
 * Create a JSONPatch for an append operation. The values will be appended
 * to the end of the array or object.
 *
 * This function needs the current data in order to be able to determine
 * a unique property name for the inserted node in case of duplicating
 * and object property
 */
export function append(json: unknown, path: JSONPath, values: ClipboardValues): JSONPatchDocument {
  const parent = getIn(json, path)

  if (Array.isArray(parent)) {
    const offset = parent.length
    return values.map((entry, index) => ({
      op: 'add',
      path: compileJSONPointer(path.concat(String(offset + index))),
      value: entry.value
    }))
  } else {
    // 'object'
    const takeName = createNameTaker(Object.keys(parent as Record<string, unknown>))
    return values.map((entry) => {
      const newProp = takeName(entry.key)
      return {
        op: 'add',
        path: compileJSONPointer(path.concat(newProp)),
        value: entry.value
      }
    })
  }
}

/**
 * Several values can go into one object at once. Each name that is handed out counts for the next
 * one, else two values can end up under the same name and only the last one stays.
 */
function createNameTaker(keys: string[]): (name: string) => string {
  const taken = keys.slice()

  return (name) => {
    const uniqueName = findUniqueName(name, taken)
    taken.push(uniqueName)
    return uniqueName
  }
}

/**
 * Rename an object key
 * Not applicable to arrays
 */
export function rename(
  parentPath: JSONPath,
  keys: string[],
  oldKey: string,
  newKey: string
): JSONPatchDocument {
  const filteredKeys = keys.filter((key) => key !== oldKey)
  const newKeyUnique = findUniqueName(newKey, filteredKeys)
  const nextKeys = getNextKeys(keys, oldKey, false)

  return [
    // rename a key
    {
      op: 'move',
      from: compileJSONPointer(parentPath.concat(oldKey)),
      path: compileJSONPointer(parentPath.concat(newKeyUnique))
    },

    // move all lower down keys so the renamed key will maintain it's position
    ...nextKeys.map((key) => moveDown(parentPath, key))
  ]
}

/**
 * Create a JSONPatch for an insert operation.
 *
 * This function needs the current data in order to be able to determine
 * a unique property name for the inserted node in case of duplicating
 * and object property
 */
export function replace(
  json: unknown,
  paths: JSONPath[],
  values: ClipboardValues
): JSONPatchDocument {
  const firstPath = first(paths)
  const parentPath = initial(firstPath)
  const parent = getIn(json, parentPath)

  if (isJSONArray(parent)) {
    const firstPath = first(paths)
    const offset = firstPath ? int(last(firstPath) as string) : 0

    return [
      // remove operations
      ...removeAll(paths),

      // insert operations
      ...values.map((entry, index) => {
        const operation: JSONPatchOperation = {
          op: 'add',
          path: compileJSONPointer(parentPath.concat(String(index + offset))),
          value: entry.value
        }

        return operation
      })
    ]
  } else if (isJSONObject(parent)) {
    // parent is Object
    // if we're going to replace an existing object with key "a" with a new
    // key "a", we must not create a new unique name "a (copy)".
    const lastPath = last(paths)
    const parentPath = initial(lastPath)
    const beforeKey = last(lastPath)
    const keys: string[] = Object.keys(parent)
    const nextKeys = beforeKey !== undefined ? getNextKeys(keys, beforeKey, false) : []
    const removeKeys = new Set(paths.map((path) => last(path)))
    const takeName = createNameTaker(keys.filter((key) => !removeKeys.has(key)))

    return [
      // remove operations
      ...removeAll(paths),

      // insert operations
      ...values.map((entry) => {
        const newProp = takeName(entry.key)
        return {
          op: 'add',
          path: compileJSONPointer(parentPath.concat(newProp)),
          value: entry.value
        } as JSONPatchAdd
      }),

      // move down operations
      // move all lower down keys so the renamed key will maintain its position
      ...nextKeys.map((key) => moveDown(parentPath, key))
    ]
  } else {
    throw new Error('Cannot create replace operations: parent must be an Object or Array')
  }
}

/**
 * Create a JSONPatch for a duplicate action.
 *
 * This function needs the current data in order to be able to determine
 * a unique property name for the duplicated node in case of duplicating
 * and object property
 */
export function duplicate(json: unknown, paths: JSONPath[]): JSONPatchDocument {
  // FIXME: here we assume paths is sorted correctly, that's a dangerous assumption
  const lastPath = last(paths)

  if (isEmpty(lastPath)) {
    throw new Error('Cannot duplicate root object')
  }

  const parentPath = initial(lastPath)
  const beforeKey = last(lastPath)
  const parent = getIn(json, parentPath)

  if (isJSONArray(parent)) {
    const lastPath = last(paths)
    const offset = lastPath ? int(last(lastPath) as string) + 1 : 0

    return [
      // copy operations
      ...paths.map((path, index) => {
        const operation: JSONPatchOperation = {
          op: 'copy',
          from: compileJSONPointer(path),
          path: compileJSONPointer(parentPath.concat(String(index + offset)))
        }

        return operation
      })
    ]
  } else if (isJSONObject(parent)) {
    // 'object'
    const keys = Object.keys(parent)
    const nextKeys = beforeKey !== undefined ? getNextKeys(keys, beforeKey, false) : []
    const takeName = createNameTaker(keys)

    return [
      // copy operations
      ...paths.map((path) => {
        const prop = last(path) as string
        const newProp = takeName(prop)

        return {
          op: 'copy',
          from: compileJSONPointer(path),
          path: compileJSONPointer(parentPath.concat(newProp))
        } as JSONPatchCopy
      }),

      // move down operations
      // move all lower down keys so the renamed key will maintain it's position
      ...nextKeys.map((key) => moveDown(parentPath, key))
    ]
  } else {
    throw new Error('Cannot create duplicate operations: parent must be an Object or Array')
  }
}

/**
 * Create a JSONPatch for an extract action.
 */
// TODO: write unit tests
export function extract(json: unknown, selection: JSONSelection): JSONPatchDocument {
  if (isValueSelection(selection)) {
    return [
      {
        op: 'move',
        from: compileJSONPointer(selection.path),
        path: ''
      }
    ]
  }

  if (isMultiSelection(selection)) {
    const parentPath = initial(selection.focusPath)
    const parent = getIn(json, parentPath)

    if (isJSONArray(parent)) {
      const value = getSelectionPaths(json, selection).map((path) => {
        const index = int(last(path) as string)
        return parent[index]
      })

      return [
        {
          op: 'replace',
          path: '',
          value
        }
      ]
    } else if (isJSONObject(parent)) {
      // object
      const value: Record<string, unknown> = {}
      getSelectionPaths(json, selection).forEach((path) => {
        const key = String(last(path))
        value[key] = parent[key]
      })

      return [
        {
          op: 'replace',
          path: '',
          value
        }
      ]
    }
  } else {
    throw new Error('Cannot create extract operations: parent must be an Object or Array')
  }

  // this should never happen
  throw new Error('Cannot extract: unsupported type of selection ' + JSON.stringify(selection))
}

function parseOrText(text: string, parser: JSONParser): unknown {
  try {
    return parser.parse(text)
  } catch {
    return text
  }
}

function isBlank(text: string): boolean {
  return text.trim() === ''
}

/**
 * Replace the whole document with pasted text. A pasted document can be incomplete, so it is
 * repaired, as far as that works. White space holds no document: it does not replace anything.
 */
function insertDocument(clipboardText: string, parser: JSONParser): JSONPatchDocument {
  if (isBlank(clipboardText)) {
    return []
  }

  try {
    const value = parsePartialJson(clipboardText, (text) => parseAndRepair(text, parser))
    return [{ op: 'replace', path: '', value }]
  } catch {
    // parsing failed -> just paste the raw text as value
    return [{ op: 'replace', path: '', value: clipboardText }]
  }
}

// TODO: write unit tests
export function insert(
  json: unknown,
  selection: JSONSelection | undefined,
  clipboardText: string,
  parser: JSONParser
): JSONPatchDocument {
  if (isKeySelection(selection)) {
    // rename key
    const clipboard = parseOrText(clipboardText, parser)
    const parentPath = initial(selection.path)
    const parent = getIn(json, parentPath)
    const keys = Object.keys(parent as Record<string, unknown>)
    const oldKey = last(selection.path) as string
    const newKey = typeof clipboard === 'string' ? clipboard : clipboardText

    return rename(parentPath, keys, oldKey, newKey)
  }

  if (
    isValueSelection(selection) ||
    (isMultiSelection(selection) && isEmpty(selection.focusPath)) // root selected
  ) {
    const path = getFocusPath(selection)

    if (isEmpty(path)) {
      return insertDocument(clipboardText, parser)
    }

    // A single value: valid JSON is a value, everything else is text as it was pasted. Repairing
    // it here would turn a sentence with a comma into an array.
    return [
      { op: 'replace', path: compileJSONPointer(path), value: parseOrText(clipboardText, parser) }
    ]
  }

  if (isMultiSelection(selection)) {
    const newValues = clipboardToValues(clipboardText, parser)

    return replace(json, getSelectionPaths(json, selection), newValues)
  }

  if (isAfterSelection(selection)) {
    const newValues = clipboardToValues(clipboardText, parser)
    const path = selection.path
    const parentPath = initial(path)
    const parent = getIn(json, parentPath)

    if (isJSONArray(parent)) {
      const index = int(last(path) as string)
      const nextItemPath = parentPath.concat(String(index + 1))

      return insertBefore(json, nextItemPath, newValues)
    } else if (isJSONObject(parent)) {
      // value is an Object
      const key = String(last(path))
      const keys: string[] = Object.keys(parent)
      if (isEmpty(keys) || last(keys) === key) {
        return append(json, parentPath, newValues)
      } else {
        const index = keys.indexOf(key)
        const nextKey = keys[index + 1]
        const nextKeyPath = parentPath.concat(nextKey)

        return insertBefore(json, nextKeyPath, newValues)
      }
    } else {
      throw new Error('Cannot create insert operations: parent must be an Object or Array')
    }
  }

  if (isInsideSelection(selection)) {
    const newValues = clipboardToValues(clipboardText, parser)
    const path = selection.path
    const value = getIn(json, path)

    if (isJSONArray(value)) {
      const firstItemPath = path.concat('0')
      return insertBefore(json, firstItemPath, newValues)
    } else if (isJSONObject(value)) {
      // value is an Object
      const keys = Object.keys(value)
      if (isEmpty(keys)) {
        return append(json, path, newValues)
      } else {
        const firstKey = first(keys) as string
        const firstKeyPath = path.concat(firstKey)

        return insertBefore(json, firstKeyPath, newValues)
      }
    } else {
      throw new Error('Cannot create insert operations: parent must be an Object or Array')
    }
  }

  // this should never happen
  throw new Error('Cannot insert: unsupported type of selection ' + JSON.stringify(selection))
}

export function moveInsideParent(
  json: unknown,
  selection: JSONSelection | undefined,
  dragInsideAction: DragInsideAction
): JSONPatchDocument {
  if (!selection) {
    return []
  }

  const beforePath = 'beforePath' in dragInsideAction ? dragInsideAction['beforePath'] : undefined
  const append = 'append' in dragInsideAction ? dragInsideAction['append'] : undefined

  const parentPath = initial(getFocusPath(selection))
  const parent = getIn(json, parentPath)

  if (
    !append &&
    !(beforePath && pathStartsWith(beforePath, parentPath) && beforePath.length > parentPath.length)
  ) {
    return []
  }

  const startPath = getStartPath(json, selection)
  const endPath = getEndPath(json, selection)
  const startKey = last(startPath) as string
  const endKey = last(endPath) as string
  const toKey: string | undefined = beforePath ? beforePath[parentPath.length] : undefined

  if (isJSONObject(parent)) {
    const keys = Object.keys(parent)
    const startIndex = keys.indexOf(startKey)
    const endIndex = keys.indexOf(endKey)
    const toIndex = append ? keys.length : toKey !== undefined ? keys.indexOf(toKey) : -1

    if (startIndex !== -1 && endIndex !== -1 && toIndex !== -1) {
      if (toIndex > startIndex) {
        // moving down
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        return [...keys.slice(startIndex, endIndex + 1), ...keys.slice(toIndex, keys.length)].map(
          (key) => moveDown(parentPath, key)
        )
      } else {
        // moving up
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        return [...keys.slice(toIndex, startIndex), ...keys.slice(endIndex + 1, keys.length)].map(
          (key) => moveDown(parentPath, key)
        )
      }
    }
  } else if (isJSONArray(parent)) {
    // array
    const startIndex = int(startKey)
    const endIndex = int(endKey)
    const toIndex = toKey !== undefined ? int(toKey) : parent.length
    const count = endIndex - startIndex + 1

    if (toIndex < startIndex) {
      // move up
      return times(count, (offset) => {
        return {
          op: 'move',
          from: compileJSONPointer(parentPath.concat(String(startIndex + offset))),
          path: compileJSONPointer(parentPath.concat(String(toIndex + offset)))
        }
      })
    } else {
      // move down
      return times(count, () => {
        return {
          op: 'move',
          from: compileJSONPointer(parentPath.concat(String(startIndex))),
          path: compileJSONPointer(parentPath.concat(String(toIndex)))
        }
      })
    }
  } else {
    throw new Error('Cannot create move operations: parent must be an Object or Array')
  }

  return []
}

export function createNewValue(
  json: unknown | undefined,
  selection: JSONSelection | undefined,
  valueType: 'object' | 'array' | 'structure' | 'value'
): unknown {
  if (valueType === 'object') {
    return {}
  }

  if (valueType === 'array') {
    return []
  }

  if (valueType === 'structure' && json !== undefined) {
    const parentPath = selection ? getParentPath(selection) : []
    const parent = getIn(json, parentPath)

    if (Array.isArray(parent) && !isEmpty(parent)) {
      const jsonExample = first(parent)
      if (isObjectOrArray(jsonExample)) {
        return cloneDeepWith(jsonExample, (value) => {
          return Array.isArray(value)
            ? []
            : isObject(value)
              ? undefined // leave object as is, will recurse into it
              : ''
        })
      } else {
        // just a primitive value
        return ''
      }
    }
  }

  // type === value,
  // or type === structure but the parent is no array or an array containing
  // primitive values (and no objects having any structure).
  return ''
}

/**
 * Create a JSONPatch for a remove operation
 */
export function remove(path: JSONPath): JSONPatchDocument {
  return [
    {
      op: 'remove',
      path: compileJSONPointer(path)
    }
  ]
}

/**
 * Create a JSONPatch for a multiple remove operation
 */
export function removeAll(paths: JSONPath[]): JSONPatchDocument {
  return paths
    .map((path) => {
      const operation: JSONPatchOperation = {
        op: 'remove',
        path: compileJSONPointer(path)
      }

      return operation
    })
    .reverse() // reverse is needed for arrays: delete the last index first
}

// helper function to move a key down in an object,
// so another key can get positioned before the moved down keys
function moveDown(parentPath: JSONPath, key: string): JSONPatchOperation {
  return {
    op: 'move',
    from: compileJSONPointer(parentPath.concat(key)),
    path: compileJSONPointer(parentPath.concat(key))
  }
}

export function clipboardToValues(clipboardText: string, parser: JSONParser): ClipboardValues {
  if (isBlank(clipboardText)) {
    return [{ key: tString('newItem'), value: clipboardText }]
  }

  const textIsObject = /^\s*{/.test(clipboardText)
  const textIsArray = /^\s*\[/.test(clipboardText)

  const clipboardOriginal = parseAndRepairOrUndefined(clipboardText, parser)
  const clipboardRepaired =
    clipboardOriginal !== undefined
      ? clipboardOriginal
      : parsePartialJson(clipboardText, (text) => parseAndRepair(text, parser))

  if (
    (textIsObject && isObject(clipboardRepaired)) ||
    (textIsArray && Array.isArray(clipboardRepaired))
  ) {
    return [{ key: tString('newItem'), value: clipboardRepaired }]
  }

  if (Array.isArray(clipboardRepaired)) {
    return clipboardRepaired.map((value, index) => {
      return { key: tString('newItem') + ' ' + index, value }
    })
  }

  if (isObject(clipboardRepaired)) {
    return Object.keys(clipboardRepaired).map((key) => {
      return { key, value: clipboardRepaired[key] }
    })
  }

  // regular value
  return [{ key: tString('newItem'), value: clipboardRepaired }]
}

// TODO: write unit tests
export function createRemoveOperations(
  json: unknown,
  selection: JSONSelection
): { newSelection: JSONSelection | undefined; operations: JSONPatchDocument } {
  if (isKeySelection(selection)) {
    // FIXME: DOESN'T work yet
    const parentPath = initial(selection.path)
    const parent = getIn(json, parentPath)
    const keys = Object.keys(parent as Record<string, unknown>)
    const oldKey = last(selection.path) as string
    const newKey = ''

    const operations = rename(parentPath, keys, oldKey, newKey)
    const newSelection = createSelectionFromOperations(json, operations)

    return { operations, newSelection }
  }

  if (isValueSelection(selection)) {
    const operations: JSONPatchDocument = [
      {
        op: 'replace',
        path: compileJSONPointer(selection.path),
        value: ''
      }
    ]

    return { operations, newSelection: selection }
  }

  if (isMultiSelection(selection)) {
    const paths = getSelectionPaths(json, selection)
    const operations = removeAll(paths)
    const lastPath = last(paths)

    if (isEmpty(lastPath)) {
      // there is no parent, this is the root document
      const operations: JSONPatchDocument = [{ op: 'replace', path: '', value: '' }]

      const newSelection = createValueSelection([])

      return { operations, newSelection }
    }

    const parentPath = initial(lastPath)
    const parent = getIn(json, parentPath)

    if (isJSONArray(parent)) {
      const firstPath = first(paths)
      const index = int(last(firstPath) as string)
      const newSelection =
        index === 0
          ? createInsideSelection(parentPath)
          : createAfterSelection(parentPath.concat(String(index - 1)))

      return { operations, newSelection }
    } else if (isJSONObject(parent)) {
      // parent is object
      const keys = Object.keys(parent)
      const firstPath = first(paths)
      const key = last(firstPath) as string
      const index = keys.indexOf(key)
      const previousKey = keys[index - 1]
      const newSelection =
        index === 0
          ? createInsideSelection(parentPath)
          : createAfterSelection(parentPath.concat(previousKey))

      return { operations, newSelection }
    } else {
      throw new Error('Cannot create remove operations: parent must be an Object or Array')
    }
  }

  // this should never happen
  throw new Error('Cannot remove: unsupported type of selection ' + JSON.stringify(selection))
}

export function revertJSONPatchWithMoveOperations(
  json: unknown,
  operations: JSONPatchDocument
): JSONPatchDocument {
  // first, we merge series of move operations inside an object. These move operations are used
  // to ensure a specific ordering of the keys in the object. Reverting those move events one by
  // one would explode the amount of move operations in the revert operations and contain mostly
  // duplicates.
  const filteredOperations = _filterRedundantMoveOperations(json, operations)

  return revertJSONPatch(json, filteredOperations, {
    before: (json, operation, revertOperations) => {
      if (isJSONPatchRemove(operation)) {
        // we must restore the key order when reverting removing of an object key
        const path = parseJSONPointer(operation.path)
        return {
          revertOperations: [...revertOperations, ...createRevertMoveOperations(json, path)]
        }
      }

      if (
        isJSONPatchAdd(operation) &&
        revertOperations.some(isJSONPatchReplace) &&
        !pathExistsInDocument(json, parseJSONPointer(operation.path))
      ) {
        // the key only looked present because of an inherited name like "toString"
        return { revertOperations: [{ op: 'remove', path: operation.path }] }
      }

      if (isJSONPatchMove(operation)) {
        const from = parseJSONPointer(operation.from)
        return {
          revertOperations:
            operation.from === operation.path
              ? [operation, ...createRevertMoveOperations(json, from)] // move in-place (just for re-ordering object keys)
              : [...revertOperations, ...createRevertMoveOperations(json, from)]
        }
      }

      return { document: json }
    }
  })
}

/**
 * Filter move operations which are redundant when creating the reverse patch operations.
 *
 * This is a preprocessing step for creating the revert patch operations. For example, having
 * json {b:2, a:1, c:3} and the following move operations (this will reorder the keys):
 *
 *     [
 *       { op: 'move', from: '/a', path: '/a' },
 *       { op: 'move', from: '/b', path: '/b' },
 *       { op: 'move', from: '/c', path: '/c' }
 *     ]
 *
 * This function will return only moving of b, since that is the first of all the moved keys:
 *
 *     [
 *       { op: 'move', from: '/b', path: '/b' }
 *     ]
 *
 * So, when creating the reverse operations, this single operation is enough to create the needed
 * move operations for all lower down keys to restore the original order of the keys.
 */
function _filterRedundantMoveOperations(
  json: unknown,
  operations: JSONPatchOperation[]
): JSONPatchOperation[] {
  // check whether this is a set of move operations (cheap check)
  if (isEmpty(operations) || !operations.every(isJSONPatchMove)) {
    return operations
  }

  // parse the JSON pointers once and split them in parent paths and keys
  const processedOps: ProcessedOperation[] = []
  for (const operation of operations) {
    const from = splitParentKey(parseJSONPointer(operation.from))
    const path = splitParentKey(parseJSONPointer(operation.path))
    if (!from || !path) {
      return operations
    }
    processedOps.push({ from, path, operation })
  }

  // check whether the first movement is inside an object (and not an array)
  const parentPath = processedOps[0].path.parent
  const parent = getIn(json, parentPath)
  if (!isJSONObject(parent)) {
    return operations
  }

  // check whether all movements are within the same parent object
  if (!processedOps.every((op) => _equalParentPath(op, parentPath))) {
    return operations
  }

  const firstKey = _findKeyWithLowestKeyIndex(processedOps, parent)
  const getOperation = (op: ProcessedOperation) => op.operation

  if (firstKey === undefined) {
    // no key changes place
    return processedOps.filter((op) => op.operation.from !== op.operation.path).map(getOperation)
  }

  // only return the operation moving the firstKey back, and all rename operations
  const renameOps = processedOps.filter((op) => op.operation.from !== op.operation.path)
  return renameOps.some((op) => op.path.key === firstKey)
    ? renameOps.map(getOperation) // no need to add the firstKey move operation
    : [moveDown(parentPath, firstKey), ...renameOps.map(getOperation)]
}

interface ParentKey {
  parent: string[]
  key: string
}

interface ProcessedOperation {
  from: ParentKey
  path: ParentKey
  operation: JSONPatchMove
}

function splitParentKey(path: JSONPath): ParentKey | undefined {
  return path.length > 0 ? { parent: initial(path), key: last(path) as string } : undefined
}

/**
 * Test whether a move operation has a specific parent path for both `from` and `path`
 */
function _equalParentPath(
  operation: ProcessedOperation,
  parentPath: JSONPath | undefined
): boolean {
  return isEqual(operation.from.parent, parentPath) && isEqual(operation.path.parent, parentPath)
}

function _findKeyWithLowestKeyIndex(
  processedOps: ProcessedOperation[],
  parent: Record<string, unknown>
): string | undefined {
  const keys = Object.keys(parent)
  const movedKeys = keys.slice()

  // first execute all move operations on the list with keys
  // here we assume all move operations have the same parent and are keys in an object
  for (const op of processedOps) {
    const index = movedKeys.indexOf(op.from.key)
    if (index !== -1) {
      movedKeys.splice(index, 1)
      movedKeys.push(op.path.key)
    }
  }

  // find the first changed key
  let i = 0
  while (i < keys.length && keys[i] === movedKeys[i]) {
    i++
  }

  return movedKeys[i]
}

function createRevertMoveOperations(json: unknown, path: JSONPath): JSONPatchOperation[] {
  const parentPath = initial(path)
  const afterKey = last(path) as string
  const parent = getIn(json, parentPath)
  if (isJSONObject(parent)) {
    const keys = Object.keys(parent)
    const nextKeys = getNextKeys(keys, afterKey, false)

    // move all lower down keys so the inserted key will maintain its position
    return nextKeys.map((key) => moveDown(parentPath, key))
  }

  return []
}

/**
 * The parser decides which keys a document can hold: a parser can refuse keys that the editor
 * cannot show or that change the behavior of the objects holding them. Operations that create keys
 * have to follow the same rule, else a key is created that the document could not be opened with.
 * Returns the reason why the parser refuses, or undefined when all keys are accepted.
 */
export function findRefusedKey(
  operations: JSONPatchDocument,
  parser: JSONParser
): Error | undefined {
  try {
    for (const operation of operations) {
      if (isJSONPatchAdd(operation) || isJSONPatchMove(operation) || isJSONPatchCopy(operation)) {
        const key = last(parseJSONPointer(operation.path))
        if (key !== undefined) {
          parser.parse(`{${JSON.stringify(key)}:0}`)
        }
      }

      if (
        (isJSONPatchAdd(operation) || isJSONPatchReplace(operation)) &&
        isObjectOrArray(operation.value)
      ) {
        parser.parse(parser.stringify(operation.value) as string)
      }
    }
  } catch (err) {
    return err as Error
  }

  return undefined
}

/**
 * Test whether a value can be written to a table cell: the cell holds a value, or its key can be
 * added. A key cannot be added when the row or a parent is not an object, since that would
 * require overwriting the existing value. Missing parents get created.
 */
export function canAddCellValue(json: unknown, path: JSONPath): boolean {
  if (pathExistsInDocument(json, path)) {
    return true
  }

  let parentPath = initial(path)
  while (parentPath.length > 0 && !pathExistsInDocument(json, parentPath)) {
    parentPath = initial(parentPath)
  }

  return parentPath.length === 0 || isObject(getInDocument(json, parentPath))
}

/**
 * Turn replacing the value of a table cell into operations that also work when the key does not
 * exist yet: the key and its missing parents are added.
 * A cell that cannot get a key yields no operations.
 */
export function createNestedValueOperations(operations: JSONPatchOperation[], json: unknown) {
  return operations.flatMap((operation) => {
    if (isJSONPatchReplace(operation)) {
      const path = parseJSONPointer(operation.path)
      if (path.length > 0 && !pathExistsInDocument(json, path)) {
        if (!canAddCellValue(json, path)) {
          return []
        }

        const extendedOperations: JSONPatchOperation[] = [{ ...operation, op: 'add' }]

        let parentPath = initial(path)
        while (parentPath.length > 0 && !pathExistsInDocument(json, parentPath)) {
          extendedOperations.unshift({
            op: 'add',
            path: compileJSONPointer(parentPath),
            value: {}
          })

          parentPath = initial(parentPath)
        }

        return extendedOperations
      }
    }

    return operation
  })
}
