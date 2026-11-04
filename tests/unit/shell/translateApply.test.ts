// 訳を新しい列として足す（Step10-002 T5）。add だけ（R2）、行ごとに原文と今の値を比べる（R3）、
// 1 回の patch（R4）、拒まれたキーは理由を出す（R5）、編集の後始末（未保存の印）を確かめる。
// 元に戻す 1 回で全部戻ることと、戻すと未保存の印が消えることは、実物のエディタでブラウザの試験が確かめる。
import { afterEach, describe, expect, it } from 'vitest'
import { immutableJSONPatch, type JSONPatchAdd, type JSONPath } from 'immutable-json-patch'
import { Mode } from '$lib/types'
import { setLanguage } from '../../../src/i18n'
import type { AskRequest, TranslateEvent, TranslateItem, TranslationPorts } from '../../../src/shell/ports'
import {
  applyColumn,
  applyResultMessage,
  newColumnKey,
  planColumn,
  type ApplyColumnOptions,
  type ColumnEntry,
  type ColumnSource
} from '../../../src/shell/translateApply'
import { collectColumn, collectValue } from '../../../src/shell/translateCollect'
import { createTranslateFlow } from '../../../src/shell/translateFlow'
import { createTranslatePanel } from '../../../src/shell/translatePanel'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const SUBJECT: ColumnSource = { tableTarget: ['mails'], column: ['subject'] }

/** 列の全行を、訳を付けた候補にする（`missing` の行は訳せなかった扱い）。 */
function entriesOf(document: unknown, source: ColumnSource, missing: number[] = []): ColumnEntry[] {
  return collectColumn(document, source.tableTarget, source.column).map((item, index) => ({
    path: item.path,
    original: item.text,
    translation: missing.includes(index) ? null : `訳:${item.text}`
  }))
}

function mails() {
  return deepFreeze({
    mails: [
      { subject: 'Hello', from: { name: 'Ann' } },
      { subject: 'Re: Hello', from: { name: 'Bob' } },
      { subject: 'Bye', from: 'not an object' }
    ],
    note: 'keep'
  })
}

/** エディタの偽物。patch は immutable-json-patch で文書へ当て、呼ばれた回数と操作を全部数える。 */
function fakeEditor(initial: unknown, fields: Partial<ApplyColumnOptions> = {}) {
  let document = initial
  const calls = { patch: [] as JSONPatchAdd[][], afterEdit: 0, commits: 0, targets: [] as JSONPath[], asks: [] as AskRequest[], order: [] as string[] }
  const answers: number[] = []
  let target: JSONPath = ['mails']
  const options: ApplyColumnOptions = {
    ask: (request) => {
      calls.asks.push(request)
      return Promise.resolve(answers.shift() ?? 0)
    },
    hasOpenModal: () => false,
    mode: () => Mode.table,
    tableTarget: () => target,
    setTableTarget: (path) => {
      calls.order.push('target')
      calls.targets.push(path)
      target = path
    },
    commitPendingInput: () => {
      calls.order.push('commit')
      calls.commits++
    },
    document: () => {
      calls.order.push('read')
      return document
    },
    patch: (operations) => {
      calls.order.push('patch')
      calls.patch.push(operations)
      document = immutableJSONPatch(document, operations)
    },
    afterEdit: () => {
      calls.order.push('afterEdit')
      calls.afterEdit++
    },
    ...fields
  }
  return { options, calls, answers, document: () => document }
}

afterEach(() => {
  document.body.replaceChildren()
  setLanguage('ja')
})

describe('列の名前', () => {
  it('元のキー名に _翻訳先 を付け、どれかの行にあれば _2、_3 … と全行で空いている名前にする', () => {
    expect(newColumnKey([{ subject: 'a' }], ['subject'], 'ja')).toBe('subject_ja')
    expect(newColumnKey([{ subject: 'a' }, { subject: 'b', subject_ja: 'x' }], ['subject'], 'ja')).toBe('subject_ja_2')
    expect(newColumnKey([{ subject_ja: 1 }, { subject_ja_2: null }, 7, ['subject_ja_3']], ['subject'], 'ja')).toBe('subject_ja_3')
    expect(newColumnKey([{ subject: 'a' }], ['subject'], 'en')).toBe('subject_en')
    // 入れ子の列は同じ親の中で数える
    expect(newColumnKey([{ from: { name: 'a', name_ja: 'x' }, name_ja: 'top' }], ['from', 'name'], 'ja')).toBe('name_ja_2')
    expect(newColumnKey([{ from: 'x', name_ja: 'top' }], ['from', 'name'], 'ja')).toBe('name_ja')
  })
})

describe('足す操作', () => {
  it('add_column_never_overwrites: 操作は add だけで、既にある名前は使わず、他のキーは 1 つも変わらない', () => {
    const doc = deepFreeze({ mails: [{ subject: 'Hello', subject_ja: '既存' }, { subject: 'Re: Hello' }] })
    const plan = planColumn(doc, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(plan.key).toBe('subject_ja_2')
    expect(plan.operations).toEqual([
      { op: 'add', path: '/mails/0/subject_ja_2', value: '訳:Hello' },
      { op: 'add', path: '/mails/1/subject_ja_2', value: '訳:Re: Hello' }
    ])
    expect(plan.operations.every((operation) => operation.op === 'add')).toBe(true)
    const after = immutableJSONPatch(doc, plan.operations) as typeof doc
    expect(after.mails[0]).toEqual({ subject: 'Hello', subject_ja: '既存', subject_ja_2: '訳:Hello' })
    expect(after.mails[1]).toEqual({ subject: 'Re: Hello', subject_ja_2: '訳:Re: Hello' })
  })

  it('add_column_skips_changed_rows: 送った後に値が変わった行、消えた行には足さない', () => {
    const sent = mails()
    const entries = entriesOf(sent, SUBJECT)
    // 翻訳の間に 1 行目を書き換え、3 行目を消した
    const now = deepFreeze({ mails: [{ subject: 'Hello', from: { name: 'Ann' } }, { subject: 'edited', from: { name: 'Bob' } }], note: 'keep' })
    const plan = planColumn(now, SUBJECT, entries, 'ja')
    expect(plan.operations).toEqual([{ op: 'add', path: '/mails/0/subject_ja', value: '訳:Hello' }])
    expect(plan.skipped).toEqual({ notTranslated: 0, changed: 2, notObject: 0 })
  })

  it('add_column_skips_non_object_rows: 親がオブジェクトでない行（配列、数に替わった行）には足さない', () => {
    const doc = deepFreeze({ rows: [{ tags: ['red'] }, { tags: { 0: 'blue' } }] })
    const source: ColumnSource = { tableTarget: ['rows'], column: ['tags', '0'] }
    const entries: ColumnEntry[] = [
      { path: ['rows', '0', 'tags', '0'], original: 'red', translation: '赤' },
      { path: ['rows', '1', 'tags', '0'], original: 'blue', translation: '青' }
    ]
    const plan = planColumn(doc, source, entries, 'ja')
    expect(plan.operations).toEqual([{ op: 'add', path: '/rows/1/tags/0_ja', value: '青' }])
    expect(plan.skipped.notObject).toBe(1)
    // 行そのものが数に替わった
    const replaced = deepFreeze({ mails: [7, { subject: 'Re: Hello' }] })
    const plan2 = planColumn(replaced, SUBJECT, entriesOf(mails(), SUBJECT).slice(0, 2), 'ja')
    expect(plan2.operations).toEqual([{ op: 'add', path: '/mails/1/subject_ja', value: '訳:Re: Hello' }])
  })

  it('nested_column_adds_beside_source: 列 from.name は from の中に name_ja を足す', () => {
    const doc = mails()
    const source: ColumnSource = { tableTarget: ['mails'], column: ['from', 'name'] }
    const plan = planColumn(doc, source, entriesOf(doc, source), 'ja')
    expect(plan.newColumn).toEqual(['from', 'name_ja'])
    expect(plan.operations).toEqual([
      { op: 'add', path: '/mails/0/from/name_ja', value: '訳:Ann' },
      { op: 'add', path: '/mails/1/from/name_ja', value: '訳:Bob' }
    ])
  })

  it('訳せなかった行には足さず、数える。文書の根が表の対象でも足せる', () => {
    const doc = deepFreeze([{ t: 'a' }, { t: 'b' }])
    const source: ColumnSource = { tableTarget: [], column: ['t'] }
    const plan = planColumn(doc, source, entriesOf(doc, source, [1]), 'en')
    expect(plan.operations).toEqual([{ op: 'add', path: '/0/t_en', value: '訳:a' }])
    expect(plan.skipped.notTranslated).toBe(1)
  })
})

describe('足す流れ', () => {
  it('add_column_is_one_undo: patch を 1 回だけ、全行の add をまとめて呼ぶ', async () => {
    const doc = mails()
    const fake = fakeEditor(doc)
    const result = await applyColumn(fake.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(result).toEqual({ kind: 'added', key: 'subject_ja', count: 3, skipped: 0 })
    expect(fake.calls.patch).toHaveLength(1)
    expect(fake.calls.patch[0]).toHaveLength(3)
    expect(fake.calls.asks).toHaveLength(0)
  })

  it('add_marks_unsaved: patch の後に編集の後始末（未保存の印）を 1 回呼ぶ。確定前の入力は値を比べる前に入れる', async () => {
    const doc = mails()
    const fake = fakeEditor(doc)
    await applyColumn(fake.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(fake.calls.afterEdit).toBe(1)
    expect(fake.calls.order).toEqual(['commit', 'read', 'patch', 'afterEdit'])
  })

  it('add_column_refused_key_is_reported: パーサが拒むと足さず、理由を出し、後始末も呼ばない', async () => {
    const doc = mails()
    const fake = fakeEditor(doc, {
      patch: () => {
        throw new Error('予約されたキー "__proto__" は使えません')
      }
    })
    const result = await applyColumn(fake.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(result).toEqual({ kind: 'refused', message: '予約されたキー "__proto__" は使えません' })
    expect(fake.calls.afterEdit).toBe(0)
    expect(fake.document()).toBe(doc)
    const message = applyResultMessage(result)
    expect(message?.kind).toBe('error')
    expect(message?.text()).toBe('列を足せませんでした: 予約されたキー "__proto__" は使えません')
  })

  it('訳の無い行があれば確かめる（既定は取り消し）。断れば何もしない、承ければ訳せた行にだけ足す', async () => {
    const doc = mails()
    const declined = fakeEditor(doc)
    declined.answers.push(1)
    expect(await applyColumn(declined.options, SUBJECT, entriesOf(doc, SUBJECT, [1]), 'ja')).toEqual({ kind: 'declined' })
    expect(declined.calls.patch).toHaveLength(0)
    expect(declined.calls.commits).toBe(0)
    const ask = declined.calls.asks[0]
    expect(ask.body).toContain('3 行のうち 2 行')
    expect(ask.default).toBe(1)
    expect(ask.cancel).toBe(1)
    expect(ask.buttons[ask.default]).toBe('キャンセル')

    const accepted = fakeEditor(doc)
    accepted.answers.push(0)
    const result = await applyColumn(accepted.options, SUBJECT, entriesOf(doc, SUBJECT, [1]), 'ja')
    expect(result).toEqual({ kind: 'added', key: 'subject_ja', count: 2, skipped: 1 })
    expect(applyResultMessage(result)?.text()).toBe(
      '列 subject_ja を 2 行に足しました。元に戻すで戻せます。 1 行には足しませんでした（訳が無い、値が変わった、またはオブジェクトでない）。'
    )
  })

  it('テキストの表示とモーダルの間は足さない。確かめの間に替わっても足さない', async () => {
    const doc = mails()
    const text = fakeEditor(doc, { mode: () => Mode.text })
    expect(await applyColumn(text.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')).toEqual({ kind: 'textMode' })
    const modal = fakeEditor(doc, { hasOpenModal: () => true })
    expect(await applyColumn(modal.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')).toEqual({ kind: 'modal' })
    let mode = Mode.table
    const switched = fakeEditor(doc, {
      mode: () => mode,
      ask: () => {
        mode = Mode.text
        return Promise.resolve(0)
      }
    })
    expect(await applyColumn(switched.options, SUBJECT, entriesOf(doc, SUBJECT, [0]), 'ja')).toEqual({ kind: 'textMode' })
    for (const fake of [text, modal, switched]) {
      expect(fake.calls.patch).toHaveLength(0)
      expect(fake.calls.commits).toBe(0)
    }
  })

  it('表の対象が替わっていれば、出どころの表へ戻してから足す。ツリーでは替えない', async () => {
    const doc = mails()
    const table = fakeEditor(doc)
    table.options.setTableTarget(['other'])
    table.calls.order.length = 0
    await applyColumn(table.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(table.calls.targets.at(-1)).toEqual(['mails'])
    expect(table.calls.order).toEqual(['commit', 'read', 'target', 'patch', 'afterEdit'])
    const tree = fakeEditor(doc, { mode: () => Mode.tree, tableTarget: () => ['other'] })
    await applyColumn(tree.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(tree.calls.targets).toEqual([])
    expect(tree.calls.patch).toHaveLength(1)
  })

  it('足せる行が無ければ patch を呼ばない', async () => {
    const doc = mails()
    const fake = fakeEditor(deepFreeze({ mails: [] }))
    const result = await applyColumn(fake.options, SUBJECT, entriesOf(doc, SUBJECT), 'ja')
    expect(result).toEqual({ kind: 'none' })
    expect(fake.calls.patch).toHaveLength(0)
    expect(fake.calls.afterEdit).toBe(0)
  })
})

describe('小窓のボタンと流れ', () => {
  function setup() {
    let listener: ((event: TranslateEvent) => void) | null = null
    const starts: TranslateItem[][] = []
    const ports: TranslationPorts = {
      settings: () =>
        Promise.resolve({
          enabled: true,
          service: 'gemini',
          model: 'gemini-3.1-flash-lite',
          fallback: true,
          confirm: true,
          machineNotice: true,
          keyTiers: ['paid'],
          hasLegacyKey: false,
          services: ['gemini'],
          tiers: ['free', 'paid'],
          models: ['gemini-3.1-flash-lite']
        }),
      saveSettings: () => Promise.resolve(),
      saveConfirm: () => Promise.resolve(),
      saveMachineNotice: () => Promise.resolve(),
      saveKey: () => Promise.resolve(),
      clearKey: () => Promise.resolve(),
      moveKey: () => Promise.resolve(),
      start(items, _target, _tier, onEvent) {
        starts.push(items)
        listener = onEvent
        return Promise.resolve(starts.length)
      },
      cancel: () => Promise.resolve(true)
    }
    let adds = 0
    const panel = createTranslatePanel({
      onCancel: () => flow.cancel(),
      onResume: () => void flow.resume(),
      onClose: () => flow.reset(),
      onAddColumn: () => adds++,
      onHideMachineNotice: () => {},
      copy: () => Promise.resolve()
    })
    document.body.append(panel.element)
    const flow = createTranslateFlow({
      ports,
      ask: () => Promise.resolve(0),
      askChecked: () => Promise.resolve({ button: 0, checked: false }),
      notify: () => {},
      panel,
      enabled: () => true,
      onDisabled: () => {},
      openSettings: () => {},
      target: () => 'ja'
    })
    const button = () => panel.element.querySelector<HTMLButtonElement>('[data-action="addColumn"]')!
    return { flow, panel, button, adds: () => adds, emit: (event: TranslateEvent) => listener?.(event) }
  }

  it('列から訳したときだけ出し、動いている間と訳が 0 件の間は押せない。結果は行ごとの原文と訳', async () => {
    const doc = mails()
    const s = setup()
    await s.flow.request({ source: () => '列 subject', items: collectColumn(doc, ['mails'], ['subject']), column: SUBJECT, tier: 'paid' })
    await flush()
    expect(s.button().hidden).toBe(false)
    expect(s.button().disabled).toBe(true)
    expect(s.button().textContent).toBe('訳を新しい列として足す')
    expect(s.flow.columnResults()).toBeNull() // 動いている間は足さない
    s.emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }] })
    s.emit({ kind: 'finished', job: 1, error: null })
    expect(s.button().disabled).toBe(false)
    expect(s.flow.columnResults()).toEqual({
      source: SUBJECT,
      target: 'ja',
      entries: [
        { path: ['mails', '0', 'subject'], original: 'Hello', translation: 'こんにちは' },
        { path: ['mails', '1', 'subject'], original: 'Re: Hello', translation: null },
        { path: ['mails', '2', 'subject'], original: 'Bye', translation: null }
      ]
    })
    s.button().click()
    expect(s.adds()).toBe(1)
    // 文書は変わらない（流れと小窓は文書を持たない）
    expect(doc.mails[0]).toEqual({ subject: 'Hello', from: { name: 'Ann' } })
  })

  it('値から訳したときは出さず、結果も返さない。閉じると無くなる', async () => {
    const doc = mails()
    const s = setup()
    await s.flow.request({ source: () => '値 mails > 0 > subject', items: collectValue(doc, ['mails', '0', 'subject']), tier: 'paid' })
    await flush()
    s.emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }] })
    s.emit({ kind: 'finished', job: 1, error: null })
    expect(s.button().hidden).toBe(true)
    expect(s.flow.columnResults()).toBeNull()

    await s.flow.request({ source: () => '列 subject', items: collectColumn(doc, ['mails'], ['subject']), column: SUBJECT, tier: 'paid' })
    await flush()
    s.emit({ kind: 'finished', job: 2, error: null })
    expect(s.flow.columnResults()).not.toBeNull()
    s.flow.reset()
    expect(s.flow.columnResults()).toBeNull()
    expect(s.button().hidden).toBe(true)
  })
})
