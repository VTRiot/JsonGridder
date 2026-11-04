// テキストでしか開けない文書の警告の帯（D6）。理由の文言、古い理由を捨てること、取れないときの総称を確かめる。
import { afterEach, describe, expect, it } from 'vitest'
import type { Diagnosis } from '../../../src/document/backend'
import { setLanguage } from '../../../src/i18n'
import { createInvalidBanner, reasonText } from '../../../src/shell/invalidBanner'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const PREFIX = 'この .json は不正です。不正の理由: '

afterEach(() => setLanguage('ja'))

describe('理由の文言', () => {
  it('構文の誤りは行と列', () => {
    expect(reasonText({ kind: 'syntax', at: { line: 12, column: 5 } })).toBe('12 行 5 列で JSON の書き方が正しくありません。')
  })

  it('重複したキーはキー名と 2 つの位置', () => {
    const diagnosis: Diagnosis = { kind: 'duplicateKey', key: 'id', at: { line: 8, column: 5 }, first: { line: 3, column: 5 } }
    expect(reasonText(diagnosis)).toBe('キー「id」が 2 か所にあります（3 行 5 列と 8 行 5 列）。')
  })

  it('予約の名前はキー名と位置', () => {
    expect(reasonText({ kind: 'reservedKey', key: '__proto__', at: { line: 1, column: 2 } })).toBe(
      'キー「__proto__」は表とツリーで扱えない名前です（1 行 2 列）。'
    )
  })

  it('深さ超過は上限と位置（上限は Rust から受けた数）', () => {
    expect(reasonText({ kind: 'depthExceeded', at: { line: 1, column: 1001 }, limit: 1000 })).toBe(
      '入れ子が 1000 段を超えています（1 行 1001 列）。'
    )
  })

  it('取れないときと知らない種類は総称', () => {
    expect(reasonText(null)).toBe('表とツリーで内容を保てない文書です。')
    expect(reasonText({ kind: 'future', at: { line: 1, column: 1 } } as unknown as Diagnosis)).toBe(
      '表とツリーで内容を保てない文書です。'
    )
  })

  it('長いキーは切り詰め、置き換えの印を値の中で解かない', () => {
    const key = `{{line}}${'k'.repeat(200)}`
    const text = reasonText({ kind: 'reservedKey', key, at: { line: 1, column: 2 } })
    expect(text).toContain('{{line}}')
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(key.length)
  })
})

describe('帯', () => {
  it('理由が届いてから出し、隠すと消える', async () => {
    let resolve: (value: Diagnosis | null) => void = () => {}
    const banner = createInvalidBanner({ diagnose: () => new Promise((done) => (resolve = done)) })
    banner.show('{"a":1,"a":2}')
    expect(banner.element.hidden).toBe(true)
    resolve({ kind: 'syntax', at: { line: 1, column: 1 } })
    await settle()
    expect(banner.element.hidden).toBe(false)
    expect(banner.element.dataset.kind).toBe('syntax')
    expect(banner.element.textContent).toBe(`${PREFIX}1 行 1 列で JSON の書き方が正しくありません。`)
    banner.hide()
    expect(banner.element.hidden).toBe(true)
  })

  it('隠した後に届いた古い理由で出さない', async () => {
    let resolve: (value: Diagnosis | null) => void = () => {}
    const banner = createInvalidBanner({ diagnose: () => new Promise((done) => (resolve = done)) })
    banner.show('x')
    banner.hide()
    resolve({ kind: 'syntax', at: { line: 1, column: 1 } })
    await settle()
    expect(banner.element.hidden).toBe(true)
  })

  it('後の理由が先に届いたら、先の理由で上書きしない', async () => {
    const pending: ((value: Diagnosis | null) => void)[] = []
    const banner = createInvalidBanner({ diagnose: () => new Promise((done) => pending.push(done)) })
    banner.show('first')
    banner.show('second')
    pending[1]({ kind: 'reservedKey', key: 'constructor', at: { line: 2, column: 2 } })
    await settle()
    pending[0]({ kind: 'syntax', at: { line: 9, column: 9 } })
    await settle()
    expect(banner.element.dataset.kind).toBe('reservedKey')
  })

  it('文書が変わったら、取りに行っている途中の前の本文の理由を使わない', async () => {
    const pending: ((value: Diagnosis | null) => void)[] = []
    const banner = createInvalidBanner({ diagnose: () => new Promise((done) => pending.push(done)) })
    banner.show('first')
    pending[0]({ kind: 'syntax', at: { line: 1, column: 1 } })
    await settle()
    expect(banner.element.dataset.kind).toBe('syntax')
    banner.show('second')
    banner.invalidate() // 打鍵。second の理由はもう古い
    pending[1]({ kind: 'reservedKey', key: 'constructor', at: { line: 2, column: 2 } })
    await settle()
    expect(banner.element.dataset.kind).toBe('syntax') // 出ていた帯は次の判断まで残る
    expect(banner.element.hidden).toBe(false)
  })

  it('理由を取れない（口が無い、失敗、例外）ときも帯は出し、総称の文言にする', async () => {
    const cases = [
      createInvalidBanner({}),
      createInvalidBanner({ diagnose: () => Promise.reject(new Error('ipc')) }),
      createInvalidBanner({
        diagnose: () => {
          throw new Error('sync')
        }
      })
    ]
    for (const banner of cases) {
      banner.show('x')
      await settle()
      expect(banner.element.hidden).toBe(false)
      expect(banner.element.dataset.kind).toBe('unknown')
      expect(banner.element.textContent).toBe(`${PREFIX}表とツリーで内容を保てない文書です。`)
    }
  })

  it('本文が無い（テキストでない）ときは理由を取りに行かない', async () => {
    let calls = 0
    const banner = createInvalidBanner({
      diagnose: async () => {
        calls++
        return null
      }
    })
    banner.show(undefined)
    await settle()
    expect(calls).toBe(0)
    expect(banner.element.dataset.kind).toBe('unknown')
  })

  it('言語を替えて引き直す', async () => {
    const banner = createInvalidBanner({ diagnose: async () => ({ kind: 'syntax', at: { line: 3, column: 4 } }) })
    banner.show('x')
    await settle()
    setLanguage('en')
    banner.refresh()
    expect(banner.element.textContent).toBe('This .json is invalid. Reason: JSON syntax error at line 3, column 4.')
  })
})
