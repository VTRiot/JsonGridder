/**
 * JSON Patch for this editor. This is immutableJSONPatch and revertJSONPatch of
 * immutable-json-patch 6.0.3 (ISC license, Copyright Jos de Jong), with one difference.
 *
 * The library reads a last key "-" as the end of an array whatever the parent is. With an object
 * as parent the path turns into [..., undefined], so the key "-" was out of reach and the value
 * ended up under the key "undefined". Here "-" only has that meaning when the parent is an array.
 */
import {
  compileJSONPointer,
  deleteIn,
  existsIn,
  getIn,
  insertAt,
  type JSONPatchDocument,
  type JSONPatchOperation,
  type JSONPath,
  parseFrom,
  parseJSONPointer,
  setIn
} from 'immutable-json-patch'
import { initial, isEqual, last } from 'lodash-es'

const END_OF_ARRAY = '-'

interface PatchOptions {
  before?: (
    document: unknown,
    operation: JSONPatchOperation
  ) => { document?: unknown; operation?: JSONPatchOperation } | undefined
}

interface RevertOptions {
  before?: (
    document: unknown,
    operation: JSONPatchOperation,
    revertOperations: JSONPatchOperation[]
  ) => { document?: unknown; revertOperations?: JSONPatchOperation[] } | undefined
}

/**
 * Resolve a JSON pointer against a document: a last "-" in an array becomes the index after the
 * last item. In all other cases "-" is an ordinary key.
 */
export function parsePath(document: unknown, pointer: string): JSONPath {
  const path = parseJSONPointer(pointer)
  if (last(path) !== END_OF_ARRAY) {
    return path
  }

  const parentPath = initial(path)
  const parent = getIn(document, parentPath)

  return Array.isArray(parent) ? parentPath.concat(String(parent.length)) : path
}

function isArrayItem(document: unknown, path: JSONPath): boolean {
  return path.length > 0 && Array.isArray(getIn(document, initial(path)))
}

function add(document: unknown, path: JSONPath, value: unknown): unknown {
  return isArrayItem(document, path) ? insertAt(document, path, value) : setIn(document, path, value)
}

function move(document: unknown, path: JSONPath, from: JSONPath): unknown {
  const value = getIn(document, from)
  return add(deleteIn(document, from), path, value)
}

function applyOperation(
  document: unknown,
  operation: JSONPatchOperation,
  path: JSONPath
): unknown {
  switch (operation.op) {
    case 'add':
      return add(document, path, operation.value)
    case 'remove':
      return deleteIn(document, path)
    case 'replace':
      return existsIn(document, path) ? setIn(document, path, operation.value) : document
    case 'copy':
      return add(document, path, getIn(document, parseFrom(operation.from)))
    case 'move':
      return move(document, path, parseFrom(operation.from))
    case 'test':
      if (operation.value === undefined) {
        throw new Error(`Test failed: no value provided (path: "${operation.path}")`)
      }
      if (!existsIn(document, path)) {
        throw new Error(`Test failed: path not found (path: "${operation.path}")`)
      }
      if (!isEqual(getIn(document, path), operation.value)) {
        throw new Error(`Test failed, value differs (path: "${operation.path}")`)
      }
      return document
    default:
      throw new Error(`Unknown JSONPatch operation ${JSON.stringify(operation)}`)
  }
}

/**
 * Apply a patch to a document. The document itself is not changed: unchanged parts are shared with
 * the result, and when nothing changes the same document is returned.
 */
export function immutableJSONPatch<T = unknown>(
  document: unknown,
  operations: JSONPatchDocument,
  options?: PatchOptions
): T {
  let updatedDocument = document

  for (const original of operations) {
    let operation = original
    const result = options?.before?.(updatedDocument, operation)
    if (result?.document !== undefined) {
      updatedDocument = result.document
    }
    if (result?.operation !== undefined) {
      operation = result.operation
    }

    const path = parsePath(updatedDocument, operation.path)
    updatedDocument = applyOperation(updatedDocument, operation, path)
  }

  return updatedDocument as T
}

function revertReplace(document: unknown, path: JSONPath): JSONPatchOperation[] {
  return existsIn(document, path)
    ? [{ op: 'replace', path: compileJSONPointer(path), value: getIn(document, path) }]
    : []
}

function revertRemove(document: unknown, path: JSONPath): JSONPatchOperation[] {
  return [{ op: 'add', path: compileJSONPointer(path), value: getIn(document, path) }]
}

function revertAdd(document: unknown, path: JSONPath): JSONPatchOperation[] {
  return isArrayItem(document, path) || !existsIn(document, path)
    ? [{ op: 'remove', path: compileJSONPointer(path) }]
    : revertReplace(document, path)
}

function revertMove(document: unknown, path: JSONPath, from: JSONPath): JSONPatchOperation[] {
  if (path.length < from.length && isEqual(from.slice(0, path.length), path)) {
    // replacing the parent with the child
    return [{ op: 'replace', path: compileJSONPointer(path), value: document }]
  }

  const moveBack: JSONPatchOperation = {
    op: 'move',
    from: compileJSONPointer(path),
    path: compileJSONPointer(from)
  }

  return !isArrayItem(document, path) && existsIn(document, path)
    ? [moveBack, ...revertRemove(document, path)] // the move replaces a value of an object
    : [moveBack]
}

function revertOperation(document: unknown, operation: JSONPatchOperation): JSONPatchOperation[] {
  const path = parsePath(document, operation.path)

  switch (operation.op) {
    case 'add':
    case 'copy':
      return revertAdd(document, path)
    case 'remove':
      return revertRemove(document, path)
    case 'replace':
      return revertReplace(document, path)
    case 'move':
      return revertMove(document, path, parseFrom(operation.from))
    case 'test':
      return []
    default:
      throw new Error(`Unknown JSONPatch operation ${JSON.stringify(operation)}`)
  }
}

/**
 * Create the operations that undo the given operations.
 */
export function revertJSONPatch(
  document: unknown,
  operations: JSONPatchDocument,
  options?: RevertOptions
): JSONPatchDocument {
  let allRevertOperations: JSONPatchOperation[] = []

  immutableJSONPatch(document, operations, {
    before(current, operation) {
      const revertOperations = revertOperation(current, operation)
      const result = options?.before?.(current, operation, revertOperations)
      allRevertOperations = (result?.revertOperations ?? revertOperations).concat(
        allRevertOperations
      )

      return result?.document !== undefined ? { document: result.document } : undefined
    }
  })

  return allRevertOperations
}
