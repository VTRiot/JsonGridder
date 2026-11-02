import {
  buildFunction,
  compile,
  type FunctionBuildersMap,
  jsonquery,
  type JSONQuery,
  parse,
  stringify
} from '@jsonquerylang/jsonquery'
import { isSafeNumber } from 'lossless-json'
import { tString } from '$lib/i18n/index.js'
import { parseString } from '$lib/utils/stringUtils.js'
import type { JSONParser, QueryGuard, QueryLanguage, QueryLanguageOptions } from '$lib/types.js'
import type { JSONPath } from 'immutable-json-patch'
import { isEqualParser } from '$lib/utils/jsonUtils'

const description = `
<p>
  Enter a <a href="https://jsonquerylang.org" target="_blank" 
  rel="noopener noreferrer">JSON Query</a> function to filter, sort, or transform the data.
  You can use functions like <code>get</code>, <code>filter</code>,
  <code>sort</code>, <code>pick</code>, <code>groupBy</code>, <code>uniq</code>, etcetera. 
  Example query: <code>filter(.age >= 18)</code>
</p>
`

export const jsonQueryLanguage: QueryLanguage = {
  id: 'jsonquery',
  name: 'JSONQuery',
  description,
  createQuery,
  executeQuery
}

function createQuery(_json: unknown, queryOptions: QueryLanguageOptions): string {
  const { filter, sort, projection } = queryOptions
  const queryFunctions: JSONQuery[] = []

  // A number that the language cannot hold keeps its digits in the text of the query. Running that
  // query gives the reason, where the rounded digits would run as if nothing happened.
  const keptDigits =
    filter?.value && NUMBER.test(filter.value) && !isSafeNumber(filter.value)
      ? filter.value
      : undefined

  if (filter && filter.path && filter.relation && filter.value) {
    queryFunctions.push([
      'filter',
      [
        getOperatorName(filter.relation),
        getter(filter.path),
        (keptDigits !== undefined ? KEPT_DIGITS : parseString(filter.value)) as JSONQuery
      ]
    ])
  }

  if (sort && sort.path && sort.direction) {
    queryFunctions.push(['sort', getter(sort.path), sort.direction === 'desc' ? 'desc' : 'asc'])
  }

  if (projection && projection.paths) {
    if (projection.paths.length > 1) {
      queryFunctions.push(['pick', ...projection.paths.map(getter)])
    } else {
      queryFunctions.push(['map', getter(projection.paths[0])])
    }
  }

  const query = stringify(['pipe', ...queryFunctions])

  return keptDigits !== undefined ? query.replace(JSON.stringify(KEPT_DIGITS), keptDigits) : query
}

function getter(path: JSONPath): ['get', ...path: JSONPath] {
  return ['get', ...path]
}

const COMPARED_OPERANDS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not in'])
const CALCULATIONS = new Set([
  'add',
  'subtract',
  'multiply',
  'divide',
  'mod',
  'pow',
  'sum',
  'prod',
  'average',
  'abs',
  'round',
  'number'
])
const CHECK_COMPARED = 'checkCompared$'
const CHECK_CALCULATED = 'checkCalculated$'

// The tokens of a query that matter here. Strings and names come first, so that the digits inside
// them are not read as numbers. The number is the pattern of the query parser.
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const QUERY_TOKENS = /"(?:[^"\\]|\\.)*"|[a-zA-Z_$][a-zA-Z\d_$]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}]/g
const RESERVED_KEY = '__proto__'
const KEPT_DIGITS = 'keptDigits$'

/**
 * The query parser reads numbers with JSON.parse and writes keys to a plain object, so a number
 * that cannot be held, the key __proto__ and a key written twice are gone before the query can be
 * looked at. A colon only comes after a key, outside of strings.
 */
function checkQueryText(query: string, guard: QueryGuard | undefined): void {
  const objects: Array<Set<string>> = []

  for (const match of query.matchAll(QUERY_TOKENS)) {
    const token = match[0]

    if (token === '{') {
      objects.push(new Set())
    } else if (token === '}') {
      objects.pop()
    } else {
      const isName = token.startsWith('"') || /^[a-zA-Z_$]/.test(token)
      if (!isName) {
        guard?.checkNumberLiteral(token)
      }

      if (query.slice(match.index + token.length).trimStart().startsWith(':')) {
        const key = token.startsWith('"') ? (JSON.parse(token) as string) : token
        if (key === RESERVED_KEY) {
          throw new Error(tString('queryKeyReserved', { key: RESERVED_KEY }))
        }

        const keys = objects[objects.length - 1]
        if (keys?.has(key)) {
          throw new Error(tString('queryKeySame', { key }))
        }
        keys?.add(key)
      }
    }
  }
}

/**
 * Compile the checks into a query: every value that the query compares or orders passes through
 * the function CHECK_COMPARED first, and every calculation through CHECK_CALCULATED. The query
 * language has no hook for this, and its comparisons look at typeof, so an object takes part in
 * them without ever being converted.
 */
function checkComparedValues(query: JSONQuery): JSONQuery {
  if (!Array.isArray(query)) {
    return query
  }

  const [name, ...args] = query
  const checked = (arg: JSONQuery): JSONQuery => [CHECK_COMPARED, checkComparedValues(arg)]

  if (typeof name === 'string' && COMPARED_OPERANDS.has(name)) {
    return [name, ...args.map(checked)]
  }

  if (typeof name === 'string' && CALCULATIONS.has(name)) {
    return [CHECK_CALCULATED, [name, ...args.map(checkComparedValues)]] as JSONQuery
  }

  if (name === 'sort') {
    const [getter = ['get'], ...rest] = args
    return [name, checked(getter), ...rest]
  }

  if (name === 'uniq') {
    return ['pipe', checked(['get']), query]
  }

  if (name === 'object' && typeof args[0] === 'object' && args[0] !== null) {
    const entries = Object.entries(args[0]).map(([key, value]) => [
      key,
      checkComparedValues(value as JSONQuery)
    ])
    return [name, Object.fromEntries(entries)]
  }

  return [name, ...args.map(checkComparedValues)] as JSONQuery
}

/**
 * An object made from values has keys that are not known beforehand. The built-in functions write
 * them to a plain object, where toString and constructor look like keys that are already there and
 * __proto__ is no key at all, so rows and values get lost. uniqBy also compiles when it runs, where
 * the functions of the query are not known anymore.
 */
function setKey(object: Record<string, unknown>, key: string, value: unknown): void {
  if (key === RESERVED_KEY) {
    Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
  } else {
    object[key] = value
  }
}

function toObject(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const object = {}
  for (const [key, value] of entries) {
    setKey(object, key, value)
  }
  return object
}

function textOfKey(key: unknown): string {
  if (typeof key === 'object' && key !== null) {
    throw new Error(tString('queryKeyNotText'))
  }
  return String(key)
}

function addUniqueKey(entries: Map<string, unknown>, key: string, value: unknown): void {
  if (entries.has(key)) {
    throw new Error(tString('queryKeySame', { key }))
  }
  entries.set(key, value)
}

type QueryFunction = (data: never) => unknown

function createFunctions(guard?: QueryGuard): FunctionBuildersMap {
  const keyOf = (query: JSONQuery) => {
    const getKey = compile(query)
    return (item: unknown) => {
      const key = getKey(item)
      guard?.checkCompared(key)
      return textOfKey(key)
    }
  }

  return {
    keyBy: (query: JSONQuery): QueryFunction => {
      const getKey = keyOf(query)
      return (items: unknown[]) => {
        const entries = new Map<string, unknown>()
        for (const item of items) {
          const key = getKey(item)
          if (!entries.has(key)) {
            entries.set(key, item)
          }
        }
        return toObject(entries)
      }
    },

    groupBy: (query: JSONQuery): QueryFunction => {
      const getKey = keyOf(query)
      return (items: unknown[]) => {
        const groups = new Map<string, unknown[]>()
        for (const item of items) {
          const key = getKey(item)
          const group = groups.get(key)
          if (group) {
            group.push(item)
          } else {
            groups.set(key, [item])
          }
        }
        return toObject(groups)
      }
    },

    uniqBy: (query: JSONQuery): QueryFunction => {
      const getValue = compile(query)
      return (items: unknown[]) => {
        const seen = new Set<string>()
        return items.filter((item) => {
          const value = getValue(item)
          guard?.checkCompared(value)
          // not a key of an object: 1 and "1", or two different objects, are different values
          const id = typeof value === 'number' ? String(value) : JSON.stringify(value)
          if (seen.has(id)) {
            return false
          }
          seen.add(id)
          return true
        })
      }
    },

    mapKeys: (query: JSONQuery): QueryFunction => {
      const getKey = keyOf(query)
      return (object: Record<string, unknown>) => {
        const entries = new Map<string, unknown>()
        for (const key of Object.keys(object)) {
          addUniqueKey(entries, getKey(key), object[key])
        }
        return toObject(entries)
      }
    },

    mapObject: (query: JSONQuery): QueryFunction => {
      const getEntry = compile(query)
      return (object: Record<string, unknown>) => {
        const entries = new Map<string, unknown>()
        for (const key of Object.keys(object)) {
          const entry = getEntry({ key, value: object[key] }) as { key: unknown; value: unknown }
          guard?.checkCompared(entry.key)
          addUniqueKey(entries, textOfKey(entry.key), entry.value)
        }
        return toObject(entries)
      }
    },

    mapValues: (query: JSONQuery): QueryFunction => {
      const getValue = compile(query)
      return (object: Record<string, unknown>) =>
        toObject(Object.keys(object).map((key) => [key, getValue(object[key])]))
    },

    pick: (...getters: JSONQuery[]): QueryFunction => {
      const columns = getters.map((getter) => {
        const path = (getter as string[]).slice(1)
        return [String(path[path.length - 1]), compile(['get', ...path])] as const
      })
      const keys = new Map<string, unknown>()
      columns.forEach(([key]) => addUniqueKey(keys, key, true))

      const pickFrom = (item: unknown) =>
        toObject(columns.map(([key, getValue]) => [key, getValue(item)]))

      return (data: unknown) => (Array.isArray(data) ? data.map(pickFrom) : pickFrom(data))
    }
  } as unknown as FunctionBuildersMap
}

function executeQuery(
  json: unknown,
  query: string,
  parser: JSONParser,
  guard?: QueryGuard
): unknown {
  function stringifyAndParse(json: unknown) {
    const text = parser.stringify(json)
    return text !== undefined ? JSON.parse(text) : undefined
  }

  const preprocessedJson = isEqualParser(parser, JSON) ? json : stringifyAndParse(json)

  if (query.trim() === '') {
    return preprocessedJson
  }

  const parsedQuery = parse(query)
  checkQueryText(query, guard)

  if (guard === undefined) {
    return jsonquery(preprocessedJson, parsedQuery, { functions: createFunctions() })
  }

  const passThrough = (check: (value: unknown) => void) =>
    buildFunction((value) => {
      check(value)
      return value
    })

  return jsonquery(preprocessedJson, checkComparedValues(parsedQuery), {
    functions: {
      ...createFunctions(guard),
      [CHECK_COMPARED]: passThrough(guard.checkCompared),
      [CHECK_CALCULATED]: passThrough(guard.checkCalculated)
    }
  })
}

function getOperatorName(operator: string): string {
  // a trick to get the name of the operator by parsing the operator in a temporary query
  return (parse(`1 ${operator} 1`) as [string, number, number])[0]
}
