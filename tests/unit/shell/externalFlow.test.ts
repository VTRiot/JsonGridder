// 外の変更の見張りとテキストで開く（S5、D5）。文書モデル、開く処理、保存の 1 関数は本物を使い、
// 読み書きと外のアプリは状態を持つ偽物（試験の器と同じ fakeBackend）にする。
import { describe, expect, it } from 'vitest'
import type { Content } from '$lib/types'
import { isTextContent } from '$lib/utils/jsonUtils'
import type { EditorPort } from '../../../src/document/editorPort'
import { DocumentModel } from '../../../src/document/model'
import { setLanguage, t } from '../../../src/i18n'
import { createExternalFlow } from '../../../src/shell/externalFlow'
import { createOpenFlow } from '../../../src/shell/openFlow'
import type { AskRequest } from '../../../src/shell/ports'
import { createSaveFlow } from '../../../src/shell/saveFlow'
import { createFakeBackend } from '../../browser/fixture/fakeBackend'

const PATH = '/a.json'
const OPENED = '{"a":1}'
const OUTSIDE = '{"a":2}'
const RELOAD = 0
const KEEP = 1
const SAVE_AND_OPEN = 0
const OPEN_WITHOUT_SAVING = 1
const CANCEL = 2

setLanguage('ja')

/** 確定前の入力とモーダルを手で作るエディタ。 */
class FakeEditor implements EditorPort {
  content: Content = { text: '' }
  modal = false
  pending: Content | null = null
  textOnly: boolean[] = []

  constructor(private readonly onChange: () => void) {}

  commitPending(): void {
    if (this.pending) {
      this.content = this.pending
      this.pending = null
      this.onChange()
    }
  }

  current(): Content {
    return this.content
  }

  hasOpenModal(): boolean {
    return this.modal
  }

  applyFormat(): void {}

  replace(text: string, { textOnly }: { textOnly: boolean }): void {
    this.textOnly.push(textOnly)
    this.content = { text }
  }

  edit(text: string): void {
    this.content = { text }
    this.onChange()
  }

  text(): string {
    return isTextContent(this.content) ? this.content.text : JSON.stringify(this.content.json)
  }
}

interface Setup {
  answers?: number[]
  /** 確認の間に起きること（打鍵、保存など）。確認のたびに 1 つずつ。 */
  duringAsk?: (() => void | Promise<void>)[]
}

async function setup({ answers = [], duringAsk = [] }: Setup = {}) {
  const backend = createFakeBackend({ [PATH]: OPENED })
  let model: DocumentModel | undefined
  const editor = new FakeEditor(() => model?.noteEdit())
  const opened = new DocumentModel(backend, editor)
  model = opened
  const asks: AskRequest[] = []
  const notices: string[] = []
  const unsavedRequests: string[] = []
  const ask = async (request: AskRequest): Promise<number> => {
    asks.push(request)
    await duringAsk.shift()?.()
    return answers.shift() ?? request.cancel
  }
  const notify = (message: string) => notices.push(message)
  const open = createOpenFlow({
    model: opened,
    ask,
    notify,
    onOpened: () => {},
    onUnsaved: (path) => unsavedRequests.push(path),
    onMissing: () => {}
  })
  const save = createSaveFlow({
    model: opened,
    ask,
    pickSave: () => Promise.resolve(null),
    notify,
    hasOpenModal: () => editor.hasOpenModal()
  })
  const flows = { busy: false }
  // 読み直しの前に表示を覚えた回数と、読み直しの後に戻した時の文書（S6）
  const views = { captured: 0, restored: [] as string[] }
  const flow = createExternalFlow({
    captureView: () => {
      views.captured++
      return () => views.restored.push(editor.text())
    },
    model: opened,
    external: backend,
    ask,
    notify,
    hasOpenModal: () => editor.hasOpenModal(),
    flowBusy: () => flows.busy,
    open,
    save
  })
  expect((await open(PATH)).kind).toBe('Opened')
  return { backend, editor, model: opened, flow, flows, views, asks, notices, unsavedRequests, save }
}

describe('読み直しの後の表示', () => {
  it('読み直しが済んだ後に 1 回だけ前の表示を戻す（新しい文書が入った後）', async () => {
    const { backend, flow, views } = await setup()
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    expect(views.captured).toBe(1)
    expect(views.restored).toEqual([OUTSIDE])
  })

  it('聞いてから読み直すときも、読み直しの後に戻す', async () => {
    const { backend, editor, flow, views } = await setup({ answers: [RELOAD] })
    editor.edit('{"a":"mine"}')
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    expect(views.restored).toEqual([OUTSIDE])
  })

  it('読み直さなかったとき（残す、外の変更が無い、読めない）は戻さない', async () => {
    const { backend, editor, flow, views } = await setup({ answers: [KEEP] })
    await flow.check()
    editor.edit('{"a":"mine"}')
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    expect(views.restored).toEqual([])
  })

  it('読み込みの間の打鍵で開く処理が止まったときは戻さない（文書は替わっていない）', async () => {
    const context = await setup({ answers: [KEEP] })
    context.backend.files.set(PATH, OUTSIDE)
    let release = () => {}
    context.backend.gate = new Promise((resolve) => {
      release = resolve
    })
    const reads = context.backend.reads
    const checking = context.flow.check()
    while (context.backend.reads === reads) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    context.editor.edit('{"a":"typed while reading"}')
    context.backend.gate = null
    release()
    await checking
    expect(context.views.restored).toEqual([])
  })
})

describe('外の変更の見張り', () => {
  it('ディスクが基準と同じなら何もしない', async () => {
    const { backend, flow, asks, notices } = await setup()
    const reads = backend.reads
    await flow.check()
    expect(backend.reads).toBe(reads)
    expect(asks).toEqual([])
    expect(notices).toEqual([])
  })

  it('未保存が無ければ読み直す（聞かない）', async () => {
    const { backend, editor, model, flow, asks, notices } = await setup()
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    expect(editor.text()).toBe(OUTSIDE)
    expect(model.baseline?.text).toBe(OUTSIDE)
    expect(model.dirty).toBe(false)
    expect(asks).toEqual([])
    expect(notices).toEqual([t('app.notice.externalReloaded')])
  })

  it('未保存があれば聞き、残すを選ぶと文書も印も変えない', async () => {
    const { backend, editor, model, flow, asks } = await setup({ answers: [KEEP] })
    editor.edit('{"a":"mine"}')
    backend.files.set(PATH, OUTSIDE)
    const revision = model.revision
    await flow.check()
    expect(asks.map(({ title }) => title)).toEqual([t('app.dialog.reloadTitle')])
    expect(asks[0].default).toBe(KEEP)
    expect(asks[0].cancel).toBe(KEEP)
    expect(editor.text()).toBe('{"a":"mine"}')
    expect(model.dirty).toBe(true)
    expect(model.revision).toBe(revision)
  })

  it('未保存があり、読み直すを選ぶと外の版へ替わる', async () => {
    const { backend, editor, model, flow } = await setup({ answers: [RELOAD] })
    editor.edit('{"a":"mine"}')
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    expect(editor.text()).toBe(OUTSIDE)
    expect(model.dirty).toBe(false)
  })

  it('聞いている間に打った入力を失わない（読み直さず、次の見張りでもう一度聞く）', async () => {
    let editor: FakeEditor | undefined
    const context = await setup({
      answers: [RELOAD, KEEP],
      duringAsk: [() => editor?.edit('{"a":"typed while asking"}')]
    })
    editor = context.editor
    context.editor.edit('{"a":"mine"}')
    context.backend.files.set(PATH, OUTSIDE)
    await context.flow.check()
    expect(context.editor.text()).toBe('{"a":"typed while asking"}')
    expect(context.model.dirty).toBe(true)
    await context.flow.check()
    expect(context.asks).toHaveLength(2)
  })

  it('未保存が無くても、読み込みの間の打鍵は開く処理が止め、聞く流れへ移る', async () => {
    const context = await setup({ answers: [KEEP] })
    context.backend.files.set(PATH, OUTSIDE)
    let release = () => {}
    context.backend.gate = new Promise((resolve) => {
      release = resolve
    })
    const reads = context.backend.reads
    const checking = context.flow.check()
    // 読み込みが始まる（偽物の読み込みが止まる）まで待ってから打つ
    while (context.backend.reads === reads) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    context.editor.edit('{"a":"typed while reading"}')
    context.backend.gate = null
    release()
    await checking
    expect(context.editor.text()).toBe('{"a":"typed while reading"}')
    expect(context.model.dirty).toBe(true)
    // Rust の別のファイルを開く確認ではなく、外の変更の確認を出す
    expect(context.unsavedRequests).toEqual([])
    expect(context.asks.map(({ title }) => title)).toEqual([t('app.dialog.reloadTitle')])
  })

  it('同じ外の変更で 2 度聞かない。別の変更なら聞く', async () => {
    const { backend, editor, flow, asks } = await setup({ answers: [KEEP, KEEP] })
    editor.edit('{"a":"mine"}')
    backend.files.set(PATH, OUTSIDE)
    await flow.check()
    await flow.check()
    expect(asks).toHaveLength(1)
    backend.files.set(PATH, '{"a":3}')
    await flow.check()
    expect(asks).toHaveLength(2)
  })

  it('自分の保存の直後を外の変更と見なさない', async () => {
    const { editor, model, flow, asks, notices, save } = await setup()
    editor.edit('{"a":"saved"}')
    expect(await save('current')).toBe('saved')
    await flow.check()
    expect(asks).toEqual([])
    expect(notices).toEqual([])
    expect(editor.text()).toBe('{"a":"saved"}')
    expect(model.dirty).toBe(false)
  })

  it('モーダルが開いている間は読み直さない（閉じた後の見張りで読み直す）', async () => {
    const { backend, editor, flow } = await setup()
    backend.files.set(PATH, OUTSIDE)
    editor.modal = true
    const checks = backend.diskChecks
    await flow.check()
    expect(backend.diskChecks).toBe(checks)
    expect(editor.text()).toBe(OPENED)
    editor.modal = false
    await flow.check()
    expect(editor.text()).toBe(OUTSIDE)
  })

  it('開く処理か保存の確認の途中は見ない（終わった後の見張りで見る）', async () => {
    const { backend, editor, flow, flows } = await setup()
    backend.files.set(PATH, OUTSIDE)
    flows.busy = true
    const checks = backend.diskChecks
    await flow.check()
    expect(backend.diskChecks).toBe(checks)
    expect(editor.text()).toBe(OPENED)
    flows.busy = false
    await flow.check()
    expect(editor.text()).toBe(OUTSIDE)
  })

  it('読み直せなかった変更（確認で取り消した等）は、窓に戻るたびに繰り返さない', async () => {
    const { backend, editor, flow, asks } = await setup({ answers: [1] })
    backend.files.set(PATH, OUTSIDE)
    // 読み直しで文字コードの確認が出て、利用者が取り消す
    const open = backend.open.bind(backend)
    let confirms = 0
    backend.open = (path, accept) => {
      if (accept.encoding === undefined) {
        confirms++
        return Promise.resolve({ kind: 'NeedsEncodingConfirm', encoding: 'shiftJis' })
      }
      return open(path, accept)
    }
    await flow.check()
    await flow.check()
    expect(confirms).toBe(1)
    expect(asks).toHaveLength(1)
    expect(editor.text()).toBe(OPENED)
    // 別の変更ならもう一度試す
    backend.files.set(PATH, '{"a":3}')
    await flow.check()
    expect(confirms).toBe(2)
  })

  it('見ている間に保存があれば、その結果では読み直さない', async () => {
    const { backend, editor, flow, asks, notices, save } = await setup({ answers: [RELOAD] })
    backend.files.set(PATH, OUTSIDE)
    const diskStatus = backend.diskStatus.bind(backend)
    let readsAfterSave = -1
    backend.diskStatus = async (revision) => {
      const status = await diskStatus(revision)
      // 答え（古い版の Changed）が届く前に、利用者が編集して保存した（基準の版が替わる）
      editor.edit('{"a":"mine"}')
      await save('current')
      readsAfterSave = backend.reads
      return status
    }
    await flow.check()
    expect(editor.text()).toBe('{"a":"mine"}')
    expect(backend.reads).toBe(readsAfterSave) // 古い答えで読み直さない
    expect(asks).toEqual([])
    expect(notices).toEqual([])
  })

  it('読み直しで不正になった文書はテキストで開く（D6 の流れ）', async () => {
    const { backend, editor, model, flow } = await setup()
    backend.files.set(PATH, '{"a":')
    backend.nextOpen = { textOnly: true }
    await flow.check()
    expect(editor.text()).toBe('{"a":')
    expect(editor.textOnly.at(-1)).toBe(true)
    expect(model.baseline?.textOnly).toBe(true)
  })

  it('ファイルが消えたら読み直さず、1 回だけ知らせる', async () => {
    const { backend, editor, flow, notices } = await setup()
    backend.files.delete(PATH)
    await flow.check()
    await flow.check()
    expect(editor.text()).toBe(OPENED)
    expect(notices).toEqual([t('app.notice.externalMissing')])
  })
})

describe('テキストで開く', () => {
  it('未保存が無ければ聞かずに基準のファイルを開く', async () => {
    const { backend, flow, asks } = await setup()
    await flow.openInTextEditor()
    expect(asks).toEqual([])
    expect(backend.launches).toEqual([PATH])
  })

  it('未保存があれば先に聞き、保存して開くは保存してから開く', async () => {
    const { backend, editor, model, flow, asks } = await setup({ answers: [SAVE_AND_OPEN] })
    editor.edit('{"a":"mine"}')
    await flow.openInTextEditor()
    expect(asks.map(({ title }) => title)).toEqual([t('app.dialog.textEditorTitle')])
    expect(backend.files.get(PATH)).toBe('{"a":"mine"}')
    expect(model.dirty).toBe(false)
    expect(backend.launches).toEqual([PATH])
  })

  it('保存せずに開くは保存しない', async () => {
    const { backend, editor, model, flow } = await setup({ answers: [OPEN_WITHOUT_SAVING] })
    editor.edit('{"a":"mine"}')
    await flow.openInTextEditor()
    expect(backend.writes).toEqual([])
    expect(model.dirty).toBe(true)
    expect(backend.launches).toEqual([PATH])
  })

  it('やめるを選ぶと開かない', async () => {
    const { backend, editor, flow } = await setup({ answers: [CANCEL] })
    editor.edit('{"a":"mine"}')
    await flow.openInTextEditor()
    expect(backend.launches).toEqual([])
  })

  it('保存に失敗したら開かない', async () => {
    const { backend, editor, flow } = await setup({ answers: [SAVE_AND_OPEN] })
    editor.edit('{"a":"mine"}')
    backend.nextSave = { kind: 'Failed', code: 5 }
    await flow.openInTextEditor()
    expect(backend.launches).toEqual([])
  })

  it('関連付けが自分の EXE なら知らせる', async () => {
    const { backend, flow, notices } = await setup()
    backend.nextLaunch = { kind: 'SelfAssociated' }
    await flow.openInTextEditor()
    expect(notices).toEqual([t('app.notice.textEditorSelf')])
  })

  it('モーダルが開いている間は何もしない', async () => {
    const { backend, editor, flow, asks } = await setup()
    editor.modal = true
    await flow.openInTextEditor()
    expect(asks).toEqual([])
    expect(backend.launches).toEqual([])
  })
})
