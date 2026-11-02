import { beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'lossless-json'
import type { Content } from '$lib/types'
import { NO_DOCUMENT } from '../../../src/document/backend'
import type { EditorPort } from '../../../src/document/editorPort'
import { DocumentModel } from '../../../src/document/model'
import { createFakeBackend, type FakeBackend } from '../../browser/fixture/fakeBackend'

/** 確定、モーダル、書き戻しの挙動を手で作るエディタ。 */
class FakeEditor implements EditorPort {
  content: Content = { text: '' }
  modal = false
  pending: Content | null = null
  commits = 0
  /** 置き換えのとき、確定できなかった入力が古い文書を書き戻す。 */
  writesBack: Content | null = null
  /** 置き換えのたびに書き戻す。 */
  alwaysWritesBack: Content | null = null
  /** 置き換えが例外になる。`holdsNew` は例外の前に中身が新しい文書へ替わっている形。 */
  replaceFailure: 'holdsNew' | 'keepsOld' | null = null
  /** 中身を読むと例外になる。 */
  unreadable = false
  replaces = 0
  textOnlyCalls: boolean[] = []

  constructor(private readonly onChange: () => void) {}

  commitPending(): void {
    this.commits++
    if (this.pending) {
      this.content = this.pending
      this.pending = null
      this.onChange()
    }
  }

  current(): Content {
    if (this.unreadable) {
      throw new Error('injected')
    }
    return this.content
  }

  hasOpenModal(): boolean {
    return this.modal
  }

  applyFormat(): void {}

  replace(text: string, { textOnly }: { textOnly: boolean }): void {
    this.replaces++
    this.textOnlyCalls.push(textOnly)
    if (this.replaceFailure) {
      if (this.replaceFailure === 'holdsNew') {
        this.content = { text }
      }
      throw new Error('injected')
    }
    if (this.alwaysWritesBack) {
      this.content = this.alwaysWritesBack
      return
    }
    if (this.writesBack) {
      this.content = this.writesBack
      this.writesBack = null
      this.onChange()
      return
    }
    this.content = { text }
  }

  /** 利用者の編集。 */
  edit(content: Content): void {
    this.content = content
    this.onChange()
  }
}

const OPENED = '{\n  "a": 1.0,\n  "b": 2\n}'

function setup(files: Record<string, string> = { '/a.json': OPENED }) {
  const backend = createFakeBackend(files)
  let model: DocumentModel | undefined
  const editor = new FakeEditor(() => model?.noteEdit())
  model = new DocumentModel(backend, editor)
  return { backend, editor, model }
}

async function opened(files?: Record<string, string>) {
  const context = setup(files)
  await context.model.open('/a.json')
  return context
}

function gated(backend: FakeBackend) {
  let release = () => {}
  backend.gate = new Promise((resolve) => {
    release = resolve
  })
  return () => {
    backend.gate = null
    release()
  }
}

describe('開く', () => {
  it('開いた直後の基準は開いた版で、未保存が無い', async () => {
    const { model, editor } = await opened()
    expect(model.baseline?.text).toBe(OPENED)
    expect(model.baseline?.path).toBe('/a.json')
    expect(model.dirty).toBe(false)
    expect(editor.content).toEqual({ text: OPENED })
  })

  it('モーダルがあれば開かない', async () => {
    const { model, editor, backend } = setup()
    editor.modal = true
    expect(await model.open('/a.json')).toEqual({ kind: 'Blocked', reason: 'modalOpen' })
    expect(editor.replaces).toBe(0)
    expect(backend.writes).toEqual([])
  })

  it('読み込みの間にモーダルが開いたら置き換えない', async () => {
    const { model, editor, backend } = setup()
    const release = gated(backend)
    const result = model.open('/a.json')
    await Promise.resolve()
    editor.modal = true
    release()
    expect(await result).toEqual({ kind: 'Blocked', reason: 'modalOpen' })
    expect(editor.replaces).toBe(0)
    expect(model.baseline).toBeNull()
  })

  it('未保存があれば読み込まずに決定を求める', async () => {
    const { model, editor } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.edit({ text: '[9]' })
    expect(await model.open('/b.json')).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(editor.content).toEqual({ text: '[9]' })
    expect(model.baseline?.path).toBe('/a.json')
  })

  it('確定前の入力も未保存として数える', async () => {
    const { model, editor, backend } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    const readsBefore = backend.reads
    editor.pending = { text: '[9]' }
    expect(await model.open('/b.json')).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(backend.reads).toBe(readsBefore)
    expect(editor.content).toEqual({ text: '[9]' })
  })

  it('捨てる決定は呼んだ時点の確定前の入力にも効く', async () => {
    const { model, editor } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.pending = { text: '[9]' }
    const result = await model.open('/b.json', { discardConfirmed: true })
    expect(result.kind).toBe('Opened')
    expect(editor.content).toEqual({ text: '[2]' })
  })

  it('捨てる決定があれば開く', async () => {
    const { model, editor } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.edit({ text: '[9]' })
    const result = await model.open('/b.json', { discardConfirmed: true })
    expect(result.kind).toBe('Opened')
    expect(editor.content).toEqual({ text: '[2]' })
    expect(model.dirty).toBe(false)
  })

  it('読み込みの間の入力を捨てない', async () => {
    const { model, editor, backend } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    const release = gated(backend)
    const result = model.open('/b.json')
    await Promise.resolve()
    editor.pending = { text: '[9]' }
    release()
    expect(await result).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(editor.content).toEqual({ text: '[9]' })
    expect(model.baseline?.path).toBe('/a.json')
  })

  it('捨てる決定の後の入力も捨てない', async () => {
    const { model, editor, backend } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.edit({ text: '[8]' })
    const release = gated(backend)
    const result = model.open('/b.json', { discardConfirmed: true })
    await Promise.resolve()
    editor.pending = { text: '[9]' }
    release()
    expect(await result).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(editor.content).toEqual({ text: '[9]' })
  })

  it('確定できなかった入力が文書を書き戻したら、基準を変えず未保存を残す', async () => {
    const { model, editor } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.writesBack = { text: '[9]' }
    expect(await model.open('/b.json')).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(model.baseline?.path).toBe('/a.json')
    expect(model.dirty).toBe(true)
    expect(editor.content).toEqual({ text: '[9]' })
  })

  it('捨てる決定があれば置き換えをやり直す', async () => {
    const { model, editor } = await opened({ '/a.json': OPENED, '/b.json': '[2]' })
    editor.writesBack = { text: '[9]' }
    const result = await model.open('/b.json', { discardConfirmed: true })
    expect(result.kind).toBe('Opened')
    expect(editor.replaces).toBe(3)
    expect(editor.content).toEqual({ text: '[2]' })
  })

  it('読み込めなければ文書に触らない', async () => {
    const { model, editor } = await opened()
    expect(await model.open('/none.json')).toEqual({ kind: 'Missing' })
    expect(editor.content).toEqual({ text: OPENED })
    expect(model.baseline?.path).toBe('/a.json')
  })

  it('確認を要する結果はそのまま返す', async () => {
    const { model, backend } = setup()
    backend.nextOpen = { reply: { kind: 'NeedsEncodingConfirm', encoding: 'shiftJis' } }
    expect(await model.open('/a.json')).toEqual({
      kind: 'NeedsEncodingConfirm',
      encoding: 'shiftJis'
    })
  })

  it('テキストに限る文書はその印を付けて置き換える', async () => {
    const { model, editor, backend } = setup({ '/a.json': '{"a":' })
    backend.nextOpen = { textOnly: true }
    await model.open('/a.json')
    expect(editor.textOnlyCalls).toEqual([true])
    expect(model.baseline?.textOnly).toBe(true)
  })

  it('往復しない文書の印が文書モデルに残る', async () => {
    const { model, backend } = setup()
    backend.nextOpen = { roundTripOk: false }
    await model.open('/a.json')
    expect(model.baseline?.roundTripOk).toBe(false)
  })

  it('保存の処理中は開かない', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[1]' })
    const release = gated(backend)
    const saving = model.save()
    expect(await model.open('/a.json')).toEqual({ kind: 'Blocked', reason: 'busy' })
    release()
    await saving
  })
})

describe('保存の判定', () => {
  it('未編集の保存は書かない', async () => {
    const { model, backend } = await opened()
    expect(await model.save()).toEqual({ kind: 'NoChange' })
    expect(backend.writes).toEqual([])
  })

  it('編集して元へ戻した状態は書かず、未保存を下ろす', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[9]' })
    expect(model.dirty).toBe(true)
    editor.edit({ text: OPENED })
    expect(model.dirty).toBe(true)
    expect(await model.save()).toEqual({ kind: 'NoChange' })
    expect(backend.writes).toEqual([])
    expect(model.dirty).toBe(false)
  })

  it('未編集でファイルが消えていたら、黙らず Missing を返し、認めると基準を書く', async () => {
    const { model, backend } = await opened()
    backend.files.delete('/a.json')
    expect(await model.save()).toEqual({ kind: 'Missing' })
    expect(backend.files.has('/a.json')).toBe(false)
    expect(await model.save({ recreateMissing: true })).toMatchObject({ kind: 'Saved' })
    expect(backend.files.get('/a.json')).toBe(OPENED)
  })

  it('未編集で同じパスへの別名保存も、消えたファイルと外部の変更を知らせる', async () => {
    const { model, backend } = await opened()
    const revision = model.revision
    backend.files.delete('/a.json')
    expect(await model.saveAs('/a.json', revision)).toEqual({ kind: 'Missing' })

    backend.files.set('/a.json', '[2]')
    expect(await model.saveAs('/a.json', revision)).toEqual({ kind: 'ExternalChange' })
    expect(backend.files.get('/a.json')).toBe('[2]')
    const confirm = { overwriteExternal: true }
    expect(await model.saveAs('/a.json', revision, { confirm })).toMatchObject({ kind: 'Saved' })
    expect(backend.files.get('/a.json')).toBe(OPENED)
  })

  it('未編集の Ctrl+S の確認を断っても、印を変えない', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[9]' })
    editor.edit({ text: OPENED })
    backend.files.delete('/a.json')
    expect(await model.save()).toEqual({ kind: 'Missing' })
    expect(model.dirty).toBe(true)
  })

  it('保存の実行中に確定前の入力があれば、合図が無くても印を残す', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[1]' })
    const release = gated(backend)
    const saving = model.save()
    await Promise.resolve()
    await Promise.resolve()
    editor.pending = { text: '[1]\n\n' }
    release()
    expect(await saving).toMatchObject({ kind: 'Saved' })
    expect(model.dirty).toBe(true)
    expect(backend.files.get('/a.json')).toBe('[1]')
  })

  it('未編集の保存の実行中の入力も残す', async () => {
    const { model, editor, backend } = await opened()
    const release = gated(backend)
    const saving = model.save()
    await Promise.resolve()
    editor.edit({ text: '[9]' })
    release()
    expect(await saving).toEqual({ kind: 'NoChange' })
    expect(model.dirty).toBe(true)
  })

  it('テキストで書式を変えて保存すると、次の表の保存はその書式で書く', async () => {
    const compact = '{"a":1,"b":2}'
    const { model, editor, backend } = setup({ '/a.json': compact })
    backend.nextOpen = {
      format: { eol: 'lf', eolDominant: 'lf', indent: { kind: 'none' }, finalNewline: false }
    }
    await model.open('/a.json')
    const pretty = '{\n  "a": 1,\n  "b": 2\n}\n'
    editor.edit({ text: pretty })
    await model.save()
    expect(model.baseline?.format.indent).toEqual({ kind: 'spaces', count: 2 })

    editor.edit({ json: parse('{"a":5,"b":2}') })
    await model.save()
    expect(backend.files.get('/a.json')).toBe('{\n  "a": 5,\n  "b": 2\n}\n')
  })

  it('表の保存の書式は基準のまま取り直さない', async () => {
    const { model, editor } = await opened()
    const before = model.baseline?.format
    editor.edit({ json: parse('[]') })
    await model.save()
    expect(model.baseline?.format).toEqual(before)
  })

  it('キーの入れ替えのみの編集は書く', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ json: parse('{"b":2,"a":1.0}') })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0].text).toContain('"b": 2,\n  "a": 1.0')
  })

  it('テキストの空白のみの編集は書く', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: `${OPENED} ` })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.writes[0].text).toBe(`${OPENED} `)
  })

  it('数値の字面のみの編集は書く', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ json: parse('{"a":1,"b":2}') })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.writes[0].text).toContain('"a": 1,')
  })

  it('未編集の別名保存は基準のバイト列を書く', async () => {
    const { model, backend } = await opened()
    expect((await model.saveAs('/b.json', model.revision)).kind).toBe('Saved')
    expect(backend.files.get('/b.json')).toBe(OPENED)
    expect(model.baseline?.path).toBe('/b.json')
    expect(model.dirty).toBe(false)
  })

  it('表せない文字の文書を別の文字コードで別名保存する', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[9]' })
    await model.saveAs('/b.json', model.revision, { encoding: 'utf8' })
    expect(backend.writes[0].encoding).toBe('utf8')
  })

  it('未編集でも文字コードを変える別名保存は書き直す', async () => {
    const { model, backend } = setup()
    backend.nextOpen = { encoding: 'shiftJis' }
    await model.open('/a.json')
    await model.saveAs('/b.json', model.revision, { encoding: 'utf8' })
    expect(backend.writes[0]).toMatchObject({ path: '/b.json', encoding: 'utf8' })
    expect(model.baseline?.encoding).toBe('utf8')
    expect(model.baseline?.bom).toBe(false)
  })

  it('確定前の入力を含めて保存する', async () => {
    const { model, editor, backend } = await opened()
    editor.pending = { text: '[9]' }
    await model.save()
    expect(backend.writes[0].text).toBe('[9]')
  })

  it('モーダルがあれば保存しない', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '[9]' })
    editor.modal = true
    expect(await model.save()).toEqual({ kind: 'Blocked', reason: 'modalOpen' })
    expect(backend.writes).toEqual([])
  })

  it('直列化の故障で止まり、書かない', async () => {
    const backend = createFakeBackend({ '/a.json': OPENED })
    let model: DocumentModel | undefined
    const editor = new FakeEditor(() => model?.noteEdit())
    model = new DocumentModel(backend, editor, { stringify: () => '{"a":1}' })
    await model.open('/a.json')
    editor.edit({ json: parse('{"a":1.0,"b":3}') })
    expect(await model.save()).toEqual({ kind: 'SerializationMismatch' })
    expect(backend.writes).toEqual([])
    expect(model.dirty).toBe(true)
  })

  it('孤立したサロゲートが残るテキストは書かない', async () => {
    const { model, editor, backend } = await opened()
    editor.edit({ text: '["\ud800"]' })
    expect(await model.save()).toEqual({ kind: 'UnpairedSurrogate' })
    expect(backend.writes).toEqual([])
  })

  it('結果が書かなかったことを示すなら基準を変えない', async () => {
    const { model, editor, backend } = await opened()
    const before = model.baseline
    editor.edit({ text: '[9]' })
    backend.nextSave = { kind: 'ExternalChange' }
    expect(await model.save()).toEqual({ kind: 'ExternalChange' })
    expect(model.baseline).toBe(before)
    expect(model.dirty).toBe(true)
  })

  it('保存先が無い文書は保存先を求める', async () => {
    const { model, editor } = setup()
    editor.edit({ text: '[1]' })
    expect(await model.save()).toEqual({ kind: 'NeedsPath' })
  })

  it('開いていない文書を別名で保存する', async () => {
    const { model, editor, backend } = setup()
    editor.edit({ text: '[1]' })
    expect((await model.saveAs('/new.json', model.revision)).kind).toBe('Saved')
    expect(backend.files.get('/new.json')).toBe('[1]')
    expect(model.baseline?.path).toBe('/new.json')
    expect(model.dirty).toBe(false)
  })

  it('混在の改行を揃えたことが結果に載る', async () => {
    const { model, editor, backend } = setup({ '/a.json': '[\r\n1\n]' })
    backend.nextOpen = { format: { eol: 'mixed', eolDominant: 'crlf', indent: { kind: 'none' }, finalNewline: false } }
    await model.open('/a.json')
    editor.edit({ text: '[\n2\n]' })
    expect(await model.save()).toMatchObject({ kind: 'Saved', eolNormalized: true })
    expect(backend.writes[0].text).toBe('[\r\n2\r\n]')
  })
})

describe('保存の後の基準', () => {
  let context: Awaited<ReturnType<typeof opened>>

  beforeEach(async () => {
    context = await opened()
  })

  it('編集→保存→undo→保存で undo の内容が書かれる', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    await model.save()
    expect(model.dirty).toBe(false)
    editor.edit({ text: OPENED })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.writes.map((write) => write.text)).toEqual(['[9]', OPENED])
  })

  it('編集→保存→別名保存で新しいファイルが編集後の内容になり、次の保存は新しいパスへ行く', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    await model.save()
    await model.saveAs('/b.json', model.revision)
    expect(backend.files.get('/b.json')).toBe('[9]')
    expect(model.baseline?.path).toBe('/b.json')
    editor.edit({ text: '[10]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/b.json')).toBe('[10]')
    expect(backend.files.get('/a.json')).toBe('[9]')
  })

  it('保存の処理中の編集で未保存が残る', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    const release = gated(backend)
    const saving = model.save()
    await Promise.resolve()
    await Promise.resolve()
    editor.edit({ text: '[10]' })
    release()
    await saving
    expect(backend.writes[0].text).toBe('[9]')
    expect(model.baseline?.text).toBe('[9]')
    expect(model.dirty).toBe(true)
  })

  it('保存の処理中に打って元の内容へ戻しても未保存が残る', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    const release = gated(backend)
    const saving = model.save()
    await Promise.resolve()
    await Promise.resolve()
    editor.edit({ text: '[9]' })
    release()
    await saving
    expect(model.dirty).toBe(true)
  })

  it('開始の時点の内容を書く', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    const release = gated(backend)
    const saving = model.save()
    await Promise.resolve()
    await Promise.resolve()
    editor.content = { text: '[10]' }
    release()
    await saving
    expect(backend.writes[0].text).toBe('[9]')
  })

  it('保存が失敗すれば基準を変えず未保存を残す', async () => {
    const { model, editor, backend } = context
    const before = model.baseline
    editor.edit({ text: '[9]' })
    backend.nextSave = { kind: 'Failed', code: 1175 }
    await model.save()
    expect(model.baseline).toBe(before)
    expect(model.dirty).toBe(true)
  })

  it('同時に呼んでも順に処理する', async () => {
    const { model, editor, backend } = context
    editor.edit({ text: '[9]' })
    const results = await Promise.all([model.save(), model.save()])
    expect(results.map((result) => result.kind)).toEqual(['Saved', 'NoChange'])
    expect(backend.writes).toHaveLength(1)
  })

  it('保存の後は往復の印が立つ', async () => {
    const { model, editor } = context
    editor.edit({ text: '[9]' })
    await model.save()
    expect(model.baseline?.roundTripOk).toBe(true)
  })
})

describe('置き換えの失敗の後', () => {
  const FILES = { '/a.json': OPENED, '/b.json': '[2]', '/x.json': 'old' }
  const STOPPED = { kind: 'Blocked', reason: 'replaceFailed' }

  async function failed(failure: 'holdsNew' | 'keepsOld' = 'holdsNew') {
    const context = await opened(FILES)
    context.editor.replaceFailure = failure
    expect(await context.model.open('/b.json')).toEqual({ kind: 'ReplaceFailed' })
    context.editor.replaceFailure = null
    return context
  }

  function expectNothingWritten({ backend }: { backend: FakeBackend }) {
    expect(backend.writes).toEqual([])
    expect(backend.files.get('/a.json')).toBe(OPENED)
    expect(backend.files.get('/x.json')).toBe('old')
  }

  it('新しい文書を持ったまま例外になったら、保存も別名保存も書かない', async () => {
    const context = await failed()
    const { model, editor } = context
    expect(editor.content).toEqual({ text: '[2]' })
    expect(await model.save()).toEqual(STOPPED)
    expect(await model.saveAs('/x.json', model.revision)).toEqual(STOPPED)
    expectNothingWritten(context)
    expect(model.baseline?.path).toBe('/a.json')
    expect(model.dirty).toBe(true)
  })

  it('中身が基準のままと確かめられれば、保存は止めない', async () => {
    const { model, editor, backend } = await failed('keepsOld')
    editor.edit({ text: '[9]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/a.json')).toBe('[9]')
  })

  it('中身が読めないときは止める', async () => {
    const context = await opened(FILES)
    const { model, editor } = context
    editor.replaceFailure = 'keepsOld'
    editor.unreadable = true
    expect(await model.open('/b.json')).toEqual({ kind: 'ReplaceFailed' })
    editor.replaceFailure = null
    editor.unreadable = false
    expect(await model.save()).toEqual(STOPPED)
    expectNothingWritten(context)
  })

  it('比べる基準が無いときは止める', async () => {
    const context = setup(FILES)
    const { model, editor } = context
    editor.replaceFailure = 'keepsOld'
    expect(await model.open('/b.json')).toEqual({ kind: 'ReplaceFailed' })
    editor.replaceFailure = null
    expect(await model.saveAs('/x.json', model.revision)).toEqual(STOPPED)
    expectNothingWritten(context)
  })

  it('捨てる決定の置き換えが例外でなくても、基準と違う中身なら止める', async () => {
    const context = await opened(FILES)
    const { model, editor } = context
    editor.edit({ text: '[9]' })
    editor.alwaysWritesBack = { text: '[8]' }
    expect(await model.open('/b.json', { discardConfirmed: true })).toEqual({ kind: 'ReplaceFailed' })
    expect(await model.save()).toEqual(STOPPED)
    expectNothingWritten(context)
  })

  it('読み込み側の基準が受け取れなかったら止める', async () => {
    const context = await opened(FILES)
    const { model, backend } = context
    backend.commitOpen = async () => false
    expect(await model.open('/b.json')).toEqual({ kind: 'ReplaceFailed' })
    expect(await model.save()).toEqual(STOPPED)
    expectNothingWritten(context)
  })

  it('次の開く処理が成功するまで解除しない', async () => {
    const context = await failed()
    const { model, editor, backend } = context
    expect(await model.open('/a.json')).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(await model.save()).toEqual(STOPPED)
    expect(await model.open('/none.json', { discardConfirmed: true })).toEqual({ kind: 'Missing' })
    expect(await model.save()).toEqual(STOPPED)
    backend.nextOpen = { reply: { kind: 'Locked', code: 32 } }
    expect((await model.open('/a.json', { discardConfirmed: true })).kind).toBe('Locked')
    backend.nextOpen = {}
    expect(await model.save()).toEqual(STOPPED)
    editor.replaceFailure = 'holdsNew'
    expect(await model.open('/b.json', { discardConfirmed: true })).toEqual({ kind: 'ReplaceFailed' })
    editor.replaceFailure = null
    expect(await model.save()).toEqual(STOPPED)
    expectNothingWritten(context)
  })

  it('別のファイルを開けて、開いた文書は保存できる', async () => {
    const { model, editor, backend } = await failed()
    const again = await model.open('/x.json', { discardConfirmed: true })
    expect(again.kind).toBe('Opened')
    expect(model.dirty).toBe(false)
    expect(await model.save()).toEqual({ kind: 'NoChange' })
    editor.edit({ text: '[3]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/x.json')).toBe('[3]')
    expect(backend.files.get('/a.json')).toBe(OPENED)
  })

  it('失敗の前の版の文書も開き直して保存できる', async () => {
    const { model, editor, backend } = await failed()
    expect((await model.open('/a.json', { discardConfirmed: true })).kind).toBe('Opened')
    editor.edit({ text: '[4]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/a.json')).toBe('[4]')
  })
})

describe('開く処理の間の保存', () => {
  const FILES = { '/a.json': '{"doc":"A"}', '/b.json': '{"doc":"B"}', '/x.json': 'old' }
  const BUSY = { kind: 'Blocked', reason: 'busy' }

  it('別名保存は止まり、別の文書を保存先へ書かない', async () => {
    const { model, backend } = await opened(FILES)
    const release = gated(backend)
    const opening = model.open('/b.json')
    const saving = model.saveAs('/x.json', model.revision)
    release()
    expect((await opening).kind).toBe('Opened')
    expect(await saving).toEqual(BUSY)
    expect(backend.files.get('/x.json')).toBe('old')
    expect(backend.writes).toEqual([])
    expect(model.baseline?.path).toBe('/b.json')
  })

  it('止まった別名保存は保存先を変えず、次の編集は開いた文書へ入る', async () => {
    const { model, editor, backend } = await opened(FILES)
    const release = gated(backend)
    const opening = model.open('/b.json')
    const saving = model.saveAs('/x.json', model.revision)
    release()
    await opening
    await saving
    editor.edit({ text: '{"doc":"B-edited"}' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/b.json')).toBe('{"doc":"B-edited"}')
    expect(backend.files.get('/x.json')).toBe('old')
  })

  it('上書きの保存も止まる', async () => {
    const { model, backend } = await opened(FILES)
    const release = gated(backend)
    const opening = model.open('/b.json')
    const saving = model.save()
    release()
    await opening
    expect(await saving).toEqual(BUSY)
    expect(backend.writes).toEqual([])
  })

  it('捨てる決定の開く処理の間も止まる', async () => {
    const { model, editor, backend } = await opened(FILES)
    editor.edit({ text: '{"doc":"A-edited"}' })
    const release = gated(backend)
    const opening = model.open('/b.json', { discardConfirmed: true })
    const saving = model.saveAs('/x.json', model.revision)
    release()
    await opening
    expect(await saving).toEqual(BUSY)
    expect(backend.files.get('/x.json')).toBe('old')
  })

  it('読み込みの間に入力があっても止まり、入力は残る', async () => {
    const { model, editor, backend } = await opened(FILES)
    const release = gated(backend)
    const opening = model.open('/b.json')
    await Promise.resolve()
    await Promise.resolve()
    editor.edit({ text: '{"doc":"A-edited"}' })
    const saving = model.saveAs('/x.json', model.revision)
    release()
    expect(await opening).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect(await saving).toEqual(BUSY)
    expect(editor.content).toEqual({ text: '{"doc":"A-edited"}' })
    expect((await model.saveAs('/x.json', model.revision)).kind).toBe('Saved')
    expect(backend.files.get('/x.json')).toBe('{"doc":"A-edited"}')
  })

  it('開く処理が終われば保存できる', async () => {
    const { model, editor, backend } = await opened(FILES)
    await model.open('/b.json')
    editor.edit({ text: '[1]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/b.json')).toBe('[1]')
  })

  it('開く処理が失敗で終わっても、次の保存は止めない', async () => {
    const { model, editor, backend } = await opened(FILES)
    expect(await model.open('/none.json')).toEqual({ kind: 'Missing' })
    editor.edit({ text: '[1]' })
    expect((await model.save()).kind).toBe('Saved')
    expect(backend.files.get('/a.json')).toBe('[1]')
  })

  it('読み込みが例外でも、次の保存は止めない', async () => {
    const { model, editor, backend } = await opened(FILES)
    const read = backend.open
    backend.open = async () => {
      throw new Error('injected')
    }
    await expect(model.open('/b.json')).rejects.toThrow('injected')
    backend.open = read
    editor.edit({ text: '[1]' })
    expect((await model.save()).kind).toBe('Saved')
  })

  it('保存の連続は順に処理する', async () => {
    const { model, editor, backend } = await opened(FILES)
    editor.edit({ text: '[1]' })
    const first = model.save()
    const second = model.saveAs('/x.json', model.revision)
    expect((await first).kind).toBe('Saved')
    // 1 つ目の保存で版が進むので、ダイアログの前に取った版では止まる
    expect(await second).toEqual({ kind: 'StaleRevision' })
    expect(backend.writes).toHaveLength(1)
  })
})

describe('保存先を選ぶ間に文書が替わった別名保存', () => {
  const FILES = { '/a.json': '{"doc":"A"}', '/b.json': '{"doc":"B"}', '/x.json': 'old' }

  it('選ぶ前の版と違えば書かない', async () => {
    const { model, backend } = await opened(FILES)
    const chosenFrom = model.revision
    await model.open('/b.json')
    expect(await model.saveAs('/x.json', chosenFrom)).toEqual({ kind: 'StaleRevision' })
    expect(backend.files.get('/x.json')).toBe('old')
    expect(backend.writes).toEqual([])
    expect(model.baseline?.path).toBe('/b.json')
  })

  it('編集があっても、版が違えば書かない', async () => {
    const { model, editor, backend } = await opened(FILES)
    const chosenFrom = model.revision
    await model.open('/b.json')
    editor.edit({ text: '[1]' })
    expect(await model.saveAs('/x.json', chosenFrom)).toEqual({ kind: 'StaleRevision' })
    expect(backend.writes).toEqual([])
  })

  it('版が同じなら書く', async () => {
    const { model, editor, backend } = await opened(FILES)
    const chosenFrom = model.revision
    editor.edit({ text: '[1]' })
    expect((await model.saveAs('/x.json', chosenFrom)).kind).toBe('Saved')
    expect(backend.files.get('/x.json')).toBe('[1]')
  })

  it('文書が無いときの版は決まった値である', () => {
    const { model } = setup(FILES)
    expect(model.revision).toBe(NO_DOCUMENT)
  })
})
