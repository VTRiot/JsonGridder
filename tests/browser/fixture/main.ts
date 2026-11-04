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
import type {
  AskRequest,
  DocumentReport,
  ShellEvent,
  ShellPorts,
  TranslateEvent,
  TranslateItem,
  TranslationChoice,
  TranslationSettings
} from '../../../src/shell/ports'
import type { SaveDestination } from '../../../src/shell/saveFlow'
import golden from '../../fixtures/scan-golden.json'
import { createFakeBackend, type FakeBackend } from './fakeBackend'
import { goldenDiagnoser, goldenScanner } from './goldenScanner'

const SCAN_OK: ScanResult = {
  duplicateKey: false,
  numericKeyReorder: false,
  reservedKey: false,
  depthExceeded: false,
  syntaxOk: true
}
const goldenRows = new Set((golden as { input: string }[]).map(({ input }) => input))
const goldenInput = (name: string): string => {
  const row = (golden as { name: string; input: string }[]).find((candidate) => candidate.name === name)
  if (row === undefined) {
    throw new Error(`no golden row: ${name}`)
  }
  return row.input
}
/** 表にある入力は表の結果、無い入力は検査を通る。殻の試験で Rust の検査の代わりに使う。 */
const tableScanner: JsonScanner = {
  scan: (text) => (goldenRows.has(text) ? goldenScanner.scan(text) : Promise.resolve(SCAN_OK))
}

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
    // 翻訳（T4）。件名の重複、送らない値（数、null、空、空白だけ）、入れ子の列、HTML に見える文字列、オブジェクトでない行
    '/mail.json':
      '{"mails":[{"subject":"Hello","from":{"name":"Ann"},"size":1.50},{"subject":"Re: Hello","from":{"name":"Bob"},"size":2},{"subject":"Hello","from":{"name":""},"size":null},{"subject":"","from":{"name":"   "}},{"subject":"<img src=x onerror=alert(1)>","from":{"name":"Eve"}},7],"note":"keep 1.0"}',
    // テキストでしか開けない文書（警告の帯）。本文は検査の表の行と同じ
    '/duplicate.json': goldenInput('複数行の重複キー（LF）'),
    '/reserved.json': goldenInput('2 行目の予約のキー'),
    '/deep.json': goldenInput('上限を超える深さ'),
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
  const hideTargetsCalls: boolean[] = []
  let answer = 0
  let answers: number[] = []
  let pickedPath: string | null = null
  let picksForSave = 0
  let picks = 0
  let exits = 0
  let releaseSave = () => {}
  let emit: (event: ShellEvent) => void = () => {}
  // 翻訳の設定とキーの偽物。キーの値は持たず、渡された回数とどの枠にあるかだけを持つ（Rust と同じくキーを返さない）。
  // key=saved は無料枠用だけ、key=paid は有料用だけ、key=both は両方。legacy=1 は F5 より前のキーが残っている
  const keyParam = params.get('key')
  const initialKeyTiers = keyParam === 'saved' ? ['free'] : keyParam === 'paid' ? ['paid'] : keyParam === 'both' ? ['free', 'paid'] : []
  const translationState: TranslationSettings = {
    enabled: params.get('translation') === 'on',
    service: 'gemini',
    model: 'gemini-3.1-flash-lite',
    fallback: true,
    confirm: params.get('confirm') !== 'off',
    machineNotice: params.get('machine') !== 'off',
    keyTiers: initialKeyTiers,
    hasLegacyKey: params.get('legacy') === '1',
    services: ['gemini'],
    tiers: ['free', 'paid'],
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash']
  }
  const TIER_ORDER = ['free', 'paid']
  const setKeyTier = (tier: string, present: boolean): void => {
    const next = new Set(translationState.keyTiers)
    if (present) next.add(tier)
    else next.delete(tier)
    translationState.keyTiers = TIER_ORDER.filter((entry) => next.has(entry))
  }
  const translationCalls = {
    keyLengths: [] as number[],
    keyTiersSaved: [] as string[],
    clears: [] as string[],
    moves: [] as string[],
    saves: [] as TranslationChoice[],
    confirmSaves: [] as boolean[],
    machineNoticeSaves: [] as boolean[]
  }
  // 確かめのチェックボックス（「今後表示しない」）を閉じるときに入れておくか
  let checkAnswer = false
  let loseKeyWrites = false
  // 翻訳の仕事の偽物（Rust の translate_start と translate_cancel の代わり。通信はしない）。
  // auto: 全件に「訳:」を付けて返してから終わる。hold: 試験が知らせを送る
  const translateCalls = { starts: [] as { items: TranslateItem[]; target: string; tier: string }[], cancels: [] as number[] }
  let translateMode: 'auto' | 'hold' = 'auto'
  let translateRejectNext: string | null = null
  let translateJob = 0
  let translateListener: { job: number; emit: (event: TranslateEvent) => void; done: boolean } | null = null
  const ports: ShellPorts = {
    backend: confirming,
    scanner: tableScanner,
    diagnoser: goldenDiagnoser,
    external: backend,
    translation: {
      settings: () => Promise.resolve({ ...translationState, keyTiers: [...translationState.keyTiers] }),
      saveSettings(choice) {
        translationCalls.saves.push(choice)
        Object.assign(translationState, choice)
        return Promise.resolve()
      },
      saveConfirm(confirm) {
        translationCalls.confirmSaves.push(confirm)
        translationState.confirm = confirm
        return Promise.resolve()
      },
      saveMachineNotice(shown) {
        translationCalls.machineNoticeSaves.push(shown)
        translationState.machineNotice = shown
        return Promise.resolve()
      },
      saveKey(tier, key) {
        translationCalls.keyLengths.push(key.length)
        translationCalls.keyTiersSaved.push(tier)
        if (loseKeyWrites) {
          return Promise.reject('notSaved')
        }
        setKeyTier(tier, true)
        return Promise.resolve()
      },
      clearKey(tier) {
        translationCalls.clears.push(tier)
        setKeyTier(tier, false)
        return Promise.resolve()
      },
      moveKey(tier) {
        translationCalls.moves.push(tier)
        if (!translationState.hasLegacyKey) {
          return Promise.reject('noLegacy')
        }
        if (translationState.keyTiers.includes(tier)) {
          return Promise.reject('occupied')
        }
        translationState.hasLegacyKey = false
        setKeyTier(tier, true)
        return Promise.resolve()
      },
      start(items, target, tier, onEvent) {
        translateCalls.starts.push({ items: items.map((item) => ({ ...item })), target, tier })
        if (translateRejectNext !== null) {
          const code = translateRejectNext
          translateRejectNext = null
          return Promise.reject(code)
        }
        const job = ++translateJob
        const listener = { job, emit: onEvent, done: false }
        translateListener = listener
        if (translateMode === 'auto') {
          setTimeout(() => {
            if (listener.done) return
            onEvent({ kind: 'translated', job, results: items.map(({ id, text }) => ({ id, text: `訳:${text}` })) })
            listener.done = true
            onEvent({ kind: 'finished', job, error: null })
          }, 0)
        }
        return Promise.resolve(job)
      },
      cancel(job) {
        translateCalls.cancels.push(job)
        const listener = translateListener
        if (listener === null || listener.job !== job || listener.done) {
          return Promise.resolve(false)
        }
        // Rust と同じく、取り消すとすぐ「取り消し」で終わりを知らせ、それ以降の知らせは捨てる
        listener.done = true
        listener.emit({ kind: 'finished', job, error: 'cancelled' })
        return Promise.resolve(true)
      }
    },
    getStartup: () =>
      Promise.resolve({
        version: '0.2.0',
        theme: startupTheme,
        language: startupLanguage,
        recent: [],
        splashCeremony: params.get('ceremony') === 'on',
        splashCeremonyUnlocked: params.get('unlocked') === '1',
        wrapLines: params.get('wrap') === 'on',
        hideTargetsInTree: params.get('hideTargets') === 'on',
        translationEnabled: translationState.enabled
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
    askChecked(request) {
      asks.push(request)
      return Promise.resolve({ button: answers.shift() ?? answer, checked: checkAnswer })
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
    setHideTargetsInTree(hide) {
      hideTargetsCalls.push(hide)
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
    // 外の変更とテキストで開く（D5）。窓に戻った合図は focus の事件で送る
    focusWindow: () => window.dispatchEvent(new Event('focus')),
    diskChecks: () => backend.diskChecks,
    launches: () => [...backend.launches],
    nextLaunch: (reply: FakeBackend['nextLaunch']) => {
      backend.nextLaunch = reply
    },
    setPickedPath: (path: string | null) => {
      pickedPath = path
    },
    setAnswers: (values: number[]) => {
      answers = values
    },
    loseKeyWrites: (lose: boolean) => {
      loseKeyWrites = lose
    },
    translation: () => ({
      enabledInShell: app.translationEnabled(),
      keyTiers: [...translationState.keyTiers],
      hasLegacyKey: translationState.hasLegacyKey,
      ...translationCalls,
      ...translateCalls,
      settingsEnabled: translationState.enabled,
      settingsConfirm: translationState.confirm,
      settingsMachineNotice: translationState.machineNotice
    }),
    setCheckAnswer: (checked: boolean) => {
      checkAnswer = checked
    },
    setTranslationState: (fields: Partial<TranslationSettings>) => Object.assign(translationState, fields),
    holdTranslate: (hold: boolean) => {
      translateMode = hold ? 'hold' : 'auto'
    },
    rejectNextTranslate: (code: string) => {
      translateRejectNext = code
    },
    /** 待たせた仕事へ知らせを送る（`job` は今の仕事の番号に替える）。終わった後は送らない（Rust と同じ）。 */
    emitTranslate: (event: TranslateEvent) => {
      const listener = translateListener
      if (listener === null || listener.done) return false
      if (event.kind === 'finished') listener.done = true
      listener.emit({ ...event, job: listener.job })
      return true
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
      hideTargetsCalls,
      picksForSave,
      titles: reports.map(({ title }) => title),
      picks,
      exits
    })
  }
}

/**
 * 製品の既定のままのエディタ。検査だけを表と入力の判定に差し替える。
 * 言語だけは試験の器で ja に固定する。試験は日本語のボタン名と辞書の文言で探すので、
 * 製品の既定（英語）に左右されないようにする。
 */
function mountProductFixture(): void {
  setLanguage(params.get('lang') ?? 'ja')
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
