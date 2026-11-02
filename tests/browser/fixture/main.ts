// 試験専用の入口。製品の入口には試験の口を置かない。
import { flushSync, mount } from 'svelte'
import { parse, stringify } from 'lossless-json'
import { JsonEditor } from '$lib/index-vanilla'
import type { JSONPatchDocument } from 'immutable-json-patch'
import { renderValue } from '$lib/plugins/value/renderValue'
import { encodeDataPath } from '$lib/utils/domUtils'
import { isTextContent } from '$lib/utils/jsonUtils'
import {
  Mode,
  type Content,
  type JSONEditorPropsOptional,
  type JSONParser,
  type RenderValueProps
} from '$lib/types'
import type { FileBackend, JsonScanner, ScanResult } from '../../../src/document/backend'
import { createEditorPort } from '../../../src/document/editorPort'
import { DocumentModel, type OpenOptions } from '../../../src/document/model'
import { mountEditor } from '../../../src/editor/mount'
import {
  editorLanguage,
  registerDictionary,
  setLanguage,
  toEditorLanguage,
  type Dictionary
} from '../../../src/i18n'
import ja from '../../../src/i18n/ja.json'
import { startApp } from '../../../src/shell/app'
import type { AskRequest, DocumentReport, ShellEvent, ShellPorts } from '../../../src/shell/ports'
import type { SaveDestination } from '../../../src/shell/saveFlow'
import golden from '../../fixtures/scan-golden.json'
import { createFakeBackend, type FakeBackend } from './fakeBackend'
import { goldenScanner } from './goldenScanner'

const SCAN_OK: ScanResult = {
  duplicateKey: false,
  numericKeyReorder: false,
  reservedKey: false,
  depthExceeded: false,
  syntaxOk: true
}
const goldenRows = new Set((golden as { input: string }[]).map(({ input }) => input))

const target = document.getElementById('app') as HTMLElement
const params = new URLSearchParams(location.search)
const nestedContent = {
  json: [
    { n: [{ m: [1, 2], o: 'keep' }], k: 1 },
    { n: [{ m: [3] }], k: 2 }
  ]
}
const initialContent = params.has('nested') ? nestedContent : { json: [{ a: 1, b: 'x' }, { a: 2 }] }

interface DirectEditor {
  get(): Content
  set(content: Content): void
  updateProps(props: JSONEditorPropsOptional): void
}

/** テキストの表示の CodeMirror へ、同じタスクの中で書き込む。遅延の時間と競争しないため。 */
function typeNow(text: string): void {
  typeAt(text, 1)
}

function typeAt(text: string, from: number, to = from): void {
  const content = document.querySelector('.cm-content') as unknown as {
    cmTile: { root: { view: { dispatch(spec: unknown): void } } }
  }
  content.cmTile.root.view.dispatch({ changes: { from, to, insert: text } })
}

function mountDictionaryFixture(): void {
  const editor = mountEditor(target, {
    content: initialContent,
    mode: Mode.table,
    language: editorLanguage()
  })

  function applyDictionary(change: (dictionary: Dictionary) => void): void {
    const dictionary: Dictionary = { ...ja }
    change(dictionary)
    editor.updateProps({ language: toEditorLanguage(dictionary, 'ja') })
  }

  ;(window as unknown as { fixture: unknown }).fixture = { applyDictionary }
}

/** 文書と onChange を外から読むための入口。mountEditor の返す口には get が無い。 */
function mountDirectFixture(): void {
  const changes: string[] = []
  const editor = mount(JsonEditor, {
    target,
    props: {
      content: initialContent,
      mode: Mode.table,
      readOnly: params.has('readonly'),
      onChange: (content: Content) => changes.push(JSON.stringify(content))
    }
  }) as unknown as DirectEditor
  flushSync()

  ;(window as unknown as { fixture: unknown }).fixture = {
    changes,
    typeNow,
    text: () => JSON.stringify(editor.get()),
    setMode: (mode: Mode) => editor.updateProps({ mode }),
    replaceContent: (content: Content) => editor.set(content)
  }
}

/** 実物のエディタと文書モデルをつなぎ、読み書きだけを偽物にする入口。 */
function mountDocumentFixture(): void {
  const backend = createFakeBackend({
    '/first.json': '[{"a":1.0,"b":"x"},{"a":2,"b":"y"}]',
    '/second.json': '{"other":[1,2,3]}',
    '/nested.json': JSON.stringify(nestedContent.json),
    '/crlf.json': '[\r\n  1.0,\r\n  "x"\r\n]\r\n',
    '/broken.json': '{"a":1, /* c */ "b":'
  })
  let model: DocumentModel | undefined
  const changes: string[] = []
  const editor = mountEditor(target, {
    content: { text: '' },
    mode: Mode.table,
    parser: { parse, stringify } as JSONParser,
    onChange: (content: Content) => {
      changes.push(isTextContent(content) ? content.text : String(stringify(content.json)))
      model?.noteEdit()
    }
  })
  const opened = new DocumentModel(backend, createEditorPort(editor, target))
  model = opened
  const text = (): string => {
    const content = editor.get()
    return isTextContent(content) ? content.text : String(stringify(content.json))
  }

  ;(window as unknown as { fixture: unknown }).fixture = {
    changes,
    typeNow,
    text,
    open: (path: string, options: OpenOptions) => opened.open(path, options),
    save: () => opened.save(),
    saveAs: (path: string) => opened.saveAs(path, opened.revision),
    markTextOnly: () => {
      backend.nextOpen = { textOnly: true }
    },
    state: () => ({
      dirty: opened.dirty,
      path: opened.baseline?.path ?? null,
      writes: backend.writes.length,
      written: backend.writes.at(-1)?.text ?? null
    }),
    selectDeep: () => editor.select({ type: 'value', path: ['1', 'b'] } as never),
    dropWindowFocus: () => {
      document.hasFocus = () => false
    }
  }
}

/** 実物の殻。Rust の呼び出しだけを偽物にする。 */
async function mountShellFixture(): Promise<void> {
  const files: Record<string, string> = {
    '/first.json': '[{"a":1.0,"b":"x"},{"a":2,"b":"y"}]',
    '/second.json': '{"other":[1,2,3]}',
    '/object.json': '{"name":"n","items":[{"a":1}],"few":[1]}',
    '/plain.json': '{"a":1,"b":{"c":2}}',
    '/empty-array.json': '{"a":[]}',
    '/broken.json': '{"a":1, /* c */ "b":',
    '/sjis.json': '[1]',
    '/big.json': '[2]',
    '/i19.json':
      '{"version": 1.0, "big": 9007199254740993, "items": [{"id": 1, "name": "x", "price": 1.50}, {"id": 2, "name": "y", "price": 2.0}], "meta": {"rows": [{"k": "v"}], "note": "keep"}, "tags": ["p", "q"], "zero": 0.10}',
    '/slash.json': '{"a/b~c":{"rows":[{"v":"v1"}]},"keep":1.0}',
    '/delete.json': '{"keep":1.0,"items":[{"a":1}]}',
    '/crlf.json': '[\r\n  1.0,\r\n  "x"\r\n]\r\n',
    '/crlf-object.json':
      '{\r\n  "meta": {"v": 1.0, "big": 9007199254740993},\r\n  "items": [{"a": 1}]\r\n}',
    '/japanese.json': '[{"名前":"日本語の値"}]',
    '/cells.json': '[{"a":{"c":1}},{"a":3}]',
    'C:\\docs\\日本語 😀.json': '[1]'
  }
  const backend = createFakeBackend(files)
  const confirming: FileBackend = {
    ...backend,
    open(path, accept) {
      if (path === '/sjis.json' && accept.encoding === undefined) {
        return Promise.resolve({ kind: 'NeedsEncodingConfirm', encoding: 'shiftJis' })
      }
      if (path === '/big.json' && accept.size !== true) {
        return Promise.resolve({ kind: 'NeedsSizeConfirm', size: 200 * 1024 * 1024 })
      }
      const reply = backend.open(path, accept)
      backend.nextOpen = {}
      return reply
    }
  }

  const asks: AskRequest[] = []
  const reports: DocumentReport[] = []
  const finished: { id: number; ok: boolean; report: DocumentReport }[] = []
  const openRequests: string[] = []
  const themeCalls: string[] = []
  const startupTheme = params.get('theme') === 'dark' ? 'dark' : 'light'
  const startupLanguage = params.get('lang') ?? 'ja'
  const languageCalls: string[] = []
  const ceremonyCalls: { enabled: boolean; unlock: boolean }[] = []
  const wrapCalls: boolean[] = []
  let answer = 0
  let answers: number[] = []
  let pickedPath: string | null = null
  let picksForSave = 0
  let picks = 0
  let exits = 0
  let releaseSave = () => {}
  let emit: (event: ShellEvent) => void = () => {}
  const ports: ShellPorts = {
    backend: confirming,
    scanner: { scan: () => Promise.resolve(SCAN_OK) },
    getStartup: () =>
      Promise.resolve({
        version: '0.1.0',
        theme: startupTheme,
        language: startupLanguage,
        recent: [],
        splashCeremony: params.get('ceremony') === 'on',
        splashCeremonyUnlocked: params.get('unlocked') === '1',
        wrapLines: params.get('wrap') === 'on'
      }),
    subscribe(onEvent) {
      emit = onEvent
      return Promise.resolve()
    },
    ready: () => Promise.resolve(),
    pickOpen() {
      picks++
      return Promise.resolve()
    },
    pickSave() {
      picksForSave++
      return Promise.resolve(pickedPath)
    },
    ask(request) {
      asks.push(request)
      return Promise.resolve(answers.shift() ?? answer)
    },
    setDocumentState: (report) => reports.push(report),
    saveFinished: (id, ok, report) => finished.push({ id, ok, report }),
    requestOpen: (path) => openRequests.push(path),
    recentList: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(),
    forgetRecent: () => Promise.resolve(),
    clearRecent: () => Promise.resolve(),
    setTheme(theme) {
      themeCalls.push(theme)
      return Promise.resolve()
    },
    setLanguage(language) {
      languageCalls.push(language)
      return Promise.resolve()
    },
    setSplashCeremony(enabled, unlock) {
      ceremonyCalls.push({ enabled, unlock })
      return Promise.resolve()
    },
    setWrapLines(wrap) {
      wrapCalls.push(wrap)
      return Promise.resolve()
    },
    exit() {
      exits++
    }
  }
  const app = await startApp(ports, target)

  ;(window as unknown as { fixture: unknown }).fixture = {
    typeAt,
    // 言語を足す仕組みの試験用。ダミーの辞書は製品のファイルに無く、ここで足す
    registerDictionary,
    setLanguage,
    emit: (event: ShellEvent) => emit(event),
    open: (path: string, options: OpenOptions) => app.open(path, options),
    save: () => app.model.save(),
    flow: (destination: SaveDestination) => app.save(destination),
    addFile: (path: string, text: string) => backend.files.set(path, text),
    removeFile: (path: string) => backend.files.delete(path),
    file: (path: string) => backend.files.get(path) ?? null,
    nextSave: (reply: FakeBackend['nextSave']) => {
      backend.nextSave = reply
    },
    holdSave: () => {
      backend.gate = new Promise((resolve) => {
        releaseSave = resolve
      })
    },
    releaseSave: () => {
      backend.gate = null
      releaseSave()
    },
    saveStarts: () => backend.saveStarts,
    setPickedPath: (path: string | null) => {
      pickedPath = path
    },
    setAnswers: (values: number[]) => {
      answers = values
    },
    setTarget: (path: string[]) => app.editor.setTableTarget(path),
    setMode: (mode: Mode) => app.editor.updateProps({ mode }),
    patch: (operations: JSONPatchDocument) => app.editor.patch(operations),
    setAnswer: (value: number) => {
      answer = value
    },
    nextOpen: (value: FakeBackend['nextOpen']) => {
      backend.nextOpen = value
    },
    text: () => {
      const content = app.editor.get()
      return isTextContent(content) ? content.text : String(stringify(content.json))
    },
    state: () => ({
      ...app.editor.view(),
      mode: app.editor.view().mode,
      target: app.editor.view().tableTarget,
      dirty: app.model.dirty,
      path: app.model.baseline?.path ?? null,
      writes: backend.writes.length,
      written: backend.writes.at(-1)?.text ?? null,
      asks,
      reports,
      finished,
      openRequests,
      themeCalls,
      languageCalls,
      ceremonyCalls,
      wrapCalls,
      picksForSave,
      titles: reports.map(({ title }) => title),
      picks,
      exits
    })
  }
}

/** 製品の既定のままのエディタ。検査だけを表と入力の判定に差し替える。 */
function mountProductFixture(): void {
  const prototypeBefore = prototypeNames()
  const changes: string[] = []
  const alerts: string[] = []
  const scanOverrides = new Map<string, ScanResult>()
  let inputs = 0
  let failRendering = false
  let openScanGate: () => void = () => {}
  let scanGate: Promise<void> | null = null

  window.alert = (message) => {
    alerts.push(String(message))
  }
  document.addEventListener('input', () => inputs++, true)

  const scanner: JsonScanner = {
    async scan(text) {
      if (scanGate) await scanGate
      const known = scanOverrides.get(text)
      return known ?? (goldenRows.has(text) ? goldenScanner.scan(text) : SCAN_OK)
    }
  }
  const editor = mountEditor(
    target,
    {
      content: { text: params.get('text') ?? '' },
      mode: (params.get('mode') as Mode | null) ?? Mode.table,
      language: editorLanguage(),
      onChange: (content: Content) => {
        changes.push(JSON.stringify(content))
      },
      onRenderValue: (props: RenderValueProps) => {
        if (failRendering) {
          throw new Error('injected')
        }
        return renderValue(props)
      },
      ...(params.has('limit') ? { maxDocumentSizeTextMode: Number(params.get('limit')) } : {})
    },
    { scanner }
  )

  ;(window as unknown as { fixture: unknown }).fixture = {
    changes,
    alerts,
    typeNow,
    typeAt: (text: string, from: number) => typeAt(text, from),
    inputs: () => inputs,
    text: () => {
      const content = editor.get()
      return isTextContent(content) ? content.text : String(stringify(content.json))
    },
    mode: () => document.querySelector('.jse-group-button.jse-selected')?.textContent?.trim(),
    set: (content: Content) => editor.set(content),
    setMode: (mode: Mode) => editor.updateProps({ mode }),
    setContent: (content: Content) => editor.updateProps({ content }),
    commit: () => editor.commitPendingInput(),
    patch: (operations: JSONPatchDocument) => editor.patch(operations),
    cellSelector: (path: string[]) => `td[data-path="${encodeDataPath(path)}"]`,
    prototypeChanges: () => {
      const after = prototypeNames()
      return after.filter((name) => !prototypeBefore.includes(name))
    },
    markScan: (text: string, result: ScanResult) => scanOverrides.set(text, result),
    holdScan: () => {
      scanGate = new Promise((resolve) => {
        openScanGate = resolve
      })
    },
    releaseScan: () => {
      scanGate = null
      openScanGate()
    },
    failRendering: (failing: boolean) => {
      failRendering = failing
    }
  }
}

function prototypeNames(): string[] {
  return [
    ...Object.getOwnPropertyNames(Object.prototype),
    ...Object.getOwnPropertySymbols(Object.prototype).map(String)
  ]
}

if (params.has('shell')) {
  void mountShellFixture()
} else if (params.has('product')) {
  mountProductFixture()
} else if (params.has('document')) {
  mountDocumentFixture()
} else if (params.has('direct')) {
  mountDirectFixture()
} else {
  mountDictionaryFixture()
}
