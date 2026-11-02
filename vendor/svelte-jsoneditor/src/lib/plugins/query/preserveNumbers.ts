import { isLosslessNumber, isSafeNumber, LosslessNumber } from 'lossless-json'
import { tString } from '$lib/i18n/index.js'
import type { JSONParser, QueryGuard, QueryLanguage } from '$lib/types.js'

const KEY_SEPARATOR = '\u0000'

/**
 * Stands in for a number that a plain number cannot hold exactly. It leads back to the original,
 * and it has no value of its own: anything that turns it into a primitive stops the query.
 */
class UnsafeNumber {
  [Symbol.toPrimitive](): never {
    throw new Error(tString('numberUnsafeInQuery'))
  }
}

function isLargeInteger(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value)
}

function refuseUnsafeNumbers(value: unknown): void {
  if (value instanceof UnsafeNumber) {
    throw new Error(tString('numberUnsafeInQuery'))
  }

  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(refuseUnsafeNumbers)
  }
}

function addLiteral(literals: Map<string, Set<string>>, id: string, literal: string) {
  const known = literals.get(id)
  if (known) {
    known.add(literal)
  } else {
    literals.set(id, new Set([literal]))
  }
}

const guard: QueryGuard = {
  checkCompared: refuseUnsafeNumbers,
  checkCalculated: (value) => {
    if (typeof value === 'number' && isLargeInteger(value)) {
      throw new Error(tString('numberResultUnsafe'))
    }
  },
  checkNumberLiteral: (literal) => {
    if (!isSafeNumber(literal)) {
      throw new Error(tString('numberLiteralUnsafe', { value: literal }))
    }
  }
}

/**
 * Run queries without touching how the numbers in the document are written, when the parser keeps
 * them as LosslessNumber. A query language works on plain numbers, so "1.50" and a long id would
 * lose their digits on the way through.
 *
 * On the way in, objects and arrays are remembered, so whatever comes out unchanged goes back as
 * the original. Numbers are remembered by value, and by key and value. Numbers that a plain number
 * cannot hold exactly are replaced with an UnsafeNumber, which leads back to the original. Such a
 * number can pass through a query, but nothing can look at its value.
 *
 * A query is refused, which shows as an error in the preview, when the result cannot be written
 * without guessing: the same value is written in more than one way, a number is calculated from a
 * document with numbers that cannot be held exactly, such a number is compared, sorted, used as
 * a key or turned into text, a calculation leaves the range of safe integers, or the query itself
 * holds such a number. A rounded value would drop rows and write other digits.
 */
export function withLiteralNumbers(language: QueryLanguage): QueryLanguage {
  function executeQuery(json: unknown, query: string, parser: JSONParser): unknown {
    const originals = new Map<object, unknown>()
    const literalsByValue = new Map<string, Set<string>>()
    const literalsByKey = new Map<string, Set<string>>()
    let hasUnsafeNumbers = false

    function toPlain(value: unknown, key?: string): unknown {
      if (isLosslessNumber(value)) {
        const number = Number(value.value)
        if (!isSafeNumber(value.value)) {
          hasUnsafeNumbers = true
          const unsafe = new UnsafeNumber()
          originals.set(unsafe, value)
          return unsafe
        }

        addLiteral(literalsByValue, String(number), value.value)
        if (key !== undefined) {
          addLiteral(literalsByKey, key + KEY_SEPARATOR + number, value.value)
        }
        return number
      }

      if (Array.isArray(value)) {
        const plain = value.map((item) => toPlain(item))
        originals.set(plain, value)
        return plain
      }

      if (typeof value === 'object' && value !== null) {
        const plain = Object.fromEntries(
          Object.entries(value).map(([childKey, child]) => [childKey, toPlain(child, childKey)])
        )
        originals.set(plain, value)
        return plain
      }

      return value
    }

    function fromPlainNumber(value: number, key?: string): LosslessNumber {
      const literals =
        (key !== undefined ? literalsByKey.get(key + KEY_SEPARATOR + value) : undefined) ??
        literalsByValue.get(String(value))

      if (literals === undefined) {
        if (hasUnsafeNumbers || !Number.isFinite(value)) {
          throw new Error(tString('numberComputedUnsafe'))
        }
        guard.checkCalculated(value)
        return new LosslessNumber(String(value))
      }

      if (literals.size > 1) {
        throw new Error(tString('numberLiteralAmbiguous', { value: [...literals].join(', ') }))
      }

      return new LosslessNumber([...literals][0])
    }

    function fromPlain(value: unknown, key?: string): unknown {
      if (typeof value === 'number') {
        return fromPlainNumber(value, key)
      }

      if (typeof value === 'object' && value !== null) {
        if (originals.has(value)) {
          return originals.get(value)
        }

        if (Array.isArray(value)) {
          return value.map((item) => fromPlain(item))
        }

        return Object.fromEntries(
          Object.entries(value).map(([childKey, child]) => [childKey, fromPlain(child, childKey)])
        )
      }

      return value
    }

    if (parser === JSON) {
      return language.executeQuery(json, query, parser)
    }

    return fromPlain(language.executeQuery(toPlain(json), query, JSON, guard))
  }

  return { ...language, executeQuery }
}
