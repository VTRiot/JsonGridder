import { describe, expect, it } from 'vitest'
import { parse } from 'lossless-json'
import { createTauriBackend, packFrame, unpackFrame } from '../../../src/document/backend'
import golden from '../../fixtures/scan-golden.json'

const asFrame = (meta: unknown, text: string): ArrayBuffer => {
  const frame = packFrame(meta, new TextEncoder().encode(text))
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
}

describe('枠', () => {
  it('メタと本文を往復する', () => {
    expect(unpackFrame(asFrame({ kind: 'Opened', a: '表' }, '["😀"]'))).toEqual({
      meta: { kind: 'Opened', a: '表' },
      text: '["😀"]'
    })
  })

  it('本文の先頭の U+FEFF を消さない', () => {
    expect(unpackFrame(asFrame({}, '﻿[1]')).text).toBe('﻿[1]')
  })

  it('壊れた UTF-8 は例外になり、置換しない', () => {
    const meta = new TextEncoder().encode('{}')
    const frame = new Uint8Array(4 + meta.length + 1)
    new DataView(frame.buffer).setUint32(0, meta.length, true)
    frame.set(meta, 4)
    frame[4 + meta.length] = 0xff
    expect(() => unpackFrame(frame.buffer)).toThrow()
  })
})

describe('実物の呼び出しの形', () => {
  it('開く結果の本文を文書へ戻す', async () => {
    const backend = createTauriBackend((async (_cmd: string) =>
      asFrame({ kind: 'Opened', revision: 1 }, '[1]')) as never)
    expect(await backend.open('/a.json', {})).toMatchObject({ kind: 'Opened', text: '[1]' })
  })

  it('本文の無い結果はそのまま返す', async () => {
    const backend = createTauriBackend((async (_cmd: string) =>
      asFrame({ kind: 'Missing' }, '')) as never)
    expect(await backend.open('/a.json', {})).toEqual({ kind: 'Missing' })
  })

  it('保存は本文を枠で渡す', async () => {
    const calls: [string, unknown][] = []
    const backend = createTauriBackend((async (cmd: string, args: unknown) => {
      calls.push([cmd, args])
      return { kind: 'Unchanged' }
    }) as never)
    await backend.save({ revision: 3 }, new TextEncoder().encode('[1]'))
    const [cmd, frame] = calls[0]
    expect(cmd).toBe('save_document')
    const bytes = frame as Uint8Array
    const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    expect(unpackFrame(view as ArrayBuffer)).toEqual({ meta: { revision: 3 }, text: '[1]' })
  })

  it('帯の理由は本文の UTF-8 をそのまま渡して取る', async () => {
    const calls: [string, unknown][] = []
    const reason = { kind: 'syntax', at: { line: 1, column: 2 } }
    const backend = createTauriBackend((async (cmd: string, args: unknown) => {
      calls.push([cmd, args])
      return reason
    }) as never)
    expect(await backend.diagnose('[名')).toEqual(reason)
    expect(calls[0][0]).toBe('diagnose_text')
    expect(new TextDecoder().decode(calls[0][1] as Uint8Array)).toBe('[名')
  })
})

describe('検査の表の理由', () => {
  it('全行が diagnosis を持ち、理由があるのはテキストに限る文書だけ', () => {
    const rows = golden as {
      name: string
      result: { duplicateKey: boolean; reservedKey?: boolean; depthExceeded: boolean; syntaxOk: boolean }
      diagnosis?: unknown
    }[]
    for (const row of rows) {
      expect(Object.hasOwn(row, 'diagnosis'), row.name).toBe(true)
      const { duplicateKey, reservedKey = false, depthExceeded, syntaxOk } = row.result
      const textOnly = !syntaxOk || duplicateKey || reservedKey || depthExceeded
      expect(row.diagnosis !== null, row.name).toBe(textOnly)
    }
  })
})

describe('検査の表', () => {
  it('表の syntaxOk がパーサと一致する', () => {
    const rows = golden as {
      name: string
      input: string
      result: { syntaxOk: boolean }
      parserRejects?: boolean
    }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      if (row.parserRejects) {
        // 別の値の重複キーはパーサが断る。字句としては正しい
        expect(() => parse(row.input), row.name).toThrow()
        expect(row.result.syntaxOk, row.name).toBe(true)
        continue
      }
      let parsed = true
      try {
        parse(row.input)
      } catch {
        parsed = false
      }
      expect(parsed, row.name).toBe(row.result.syntaxOk)
    }
  })
})
