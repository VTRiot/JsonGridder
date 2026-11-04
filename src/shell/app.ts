import './theme.css'
import { getIn, isJSONArray, type JSONPath } from 'immutable-json-patch'
import { hasSelectionContents, isTextSelection } from '$lib/logic/selection'
import { isTextContent } from '$lib/utils/jsonUtils'
import { Mode, type JSONEditorSelection, type TableTargetChange } from '$lib/types'
import { resetColumnWidths, wrapLines as tableWrapLines } from '$lib/components/modes/tablemode/tableLayout'
import { createEditorPort } from '../document/editorPort'
import { DocumentModel } from '../document/model'
import { mountEditor, type EditorHandle } from '../editor/mount'
import {
  currentLanguage,
  editorLanguage,
  format,
  setLanguage,
  subscribeLanguage,
  t
} from '../i18n'
import { createCommandBar, mainMenuRenderer } from './commandBar'
import { installKeys } from './keys'
import { installEditSignal } from './editSignal'
import { createInvalidBanner } from './invalidBanner'
import { createLocationRow } from './locationRow'
import { createMenuBar } from './menu'
import { createSecretClickCounter, PETAL_CLASS, PETAL_SPIN_CLASS, PETAL_WOBBLE_CLASS } from './secretClicks'
import {
  buildMenus,
  isEditMenuCommand,
  type EditMenuCommand,
  type EditMenuState,
  type MenuCommand,
  type Theme
} from './menuModel'
import { createExternalFlow } from './externalFlow'
import { createOpenFlow } from './openFlow'
import type { DocumentReport, ShellEvent, ShellPorts } from './ports'
import { createSaveFlow, type SaveDestination, type SaveResult } from './saveFlow'
import { createStatusRow } from './statusRow'
import { viewAfterReload } from './tableTargets'
import { createTargetPane } from './targetPane'
import { installTextContextMenu, mainTextView, runTextAction, textActionEnabled } from './textContextMenu'
import { windowTitle } from './title'
import { applyColumn, applyResultMessage } from './translateApply'
import { collectColumn, collectValue, pathLabel } from './translateCollect'
import { availableTiers, createTranslateFlow, TARGET_LANGUAGES, type TranslateFlow } from './translateFlow'
import { createTranslateMenu, type TranslateMenu } from './translateMenu'
import { createTranslatePanel } from './translatePanel'
import { createTranslationSettings } from './translationSettings'
import { createMainModeMenu, createViewSwitch } from './viewSwitch'

const LANGUAGE_PREFIX = 'language:'
const THEME_PREFIX = 'theme:'
const RECENT_PREFIX = 'recent:'

export interface App {
  editor: EditorHandle
  model: DocumentModel
  open: ReturnType<typeof createOpenFlow>
  save(destination: SaveDestination): Promise<SaveResult>
  /** 翻訳が有効か（起動の値と、設定のダイアログで保存した値）。右クリックの項目を出す目安。 */
  translationEnabled(): boolean
}

function element(className: string): HTMLElement {
  const created = document.createElement('div')
  created.className = className
  return created
}

function currentJson(editor: EditorHandle): unknown {
  const content = editor.get()
  if (!isTextContent(content)) {
    return content.json
  }
  try {
    return editor.parse(content.text)
  } catch {
    return undefined // 読めない文書には表の対象が無い
  }
}

/** 表の今の対象の要素の数。表でない、または対象が配列でないときは undefined。 */
function tableRows(editor: EditorHandle): number | undefined {
  const { mode, tableTarget } = editor.view()
  if (mode !== Mode.table) {
    return undefined
  }
  const json = currentJson(editor)
  const rows = tableTarget.length > 0 && json !== undefined ? getIn(json, tableTarget) : json
  return isJSONArray(rows) ? rows.length : undefined
}

/** 今の文書のテキスト。テキストの表示でなければ undefined。 */
function currentText(editor: EditorHandle): string | undefined {
  const content = editor.get()
  return isTextContent(content) ? content.text : undefined
}

/** 起動の順序と部品の配線。文書の読み込みは窓を出した後に行う。 */
export async function startApp(ports: ShellPorts, root: HTMLElement): Promise<App> {
  const startup = await ports.getStartup()
  setLanguage(startup.language)

  let persistLanguage: Promise<void> = Promise.resolve()
  let theme: Theme = startup.theme
  let recent = startup.recent
  let splashCeremony = startup.splashCeremony
  let splashCeremonyUnlocked = startup.splashCeremonyUnlocked
  let wrapLines = startup.wrapLines
  let persistWrapLines: Promise<void> = Promise.resolve()
  tableWrapLines.set(wrapLines)
  let hideTargetsInTree = startup.hideTargetsInTree
  let persistHideTargets: Promise<void> = Promise.resolve()
  let translationEnabled = startup.translationEnabled
  const refreshRecent = async (): Promise<void> => {
    recent = await ports.recentList()
  }
  const applyDocumentAttributes = (): void => {
    document.documentElement.lang = currentLanguage()
    document.documentElement.dataset.theme = theme
  }
  applyDocumentAttributes()

  root.classList.add('app-shell')
  const menuHost = element('app-menu-host')
  // 本体の行: 左ペイン（表にできる配列、D7）｜ エディタの列（表の場所の行 ｜ エディタ）
  const body = element('app-body')
  const editorColumn = element('app-editor-column')
  const editorHost = element('app-editor')
  // コマンドの行。項目は主のエディタの上流のメニューから受ける（正規の設定 onRenderMenu）
  const commandBar = createCommandBar({ hasOpenModal: () => editorPort.hasOpenModal() })
  // 主のエディタが最後に知らせた選択（正規の設定 onSelect）。表の場所の行と Edit メニューが読む
  let lastSelection: JSONEditorSelection | undefined
  const locationRow = createLocationRow({
    mode: () => viewSwitch.mode(),
    tableTarget: () => editor.view().tableTarget,
    document: () => currentJson(editor),
    selection: () => lastSelection
  })
  // テキストでしか開けない文書の帯（D6）。表示の判断は切り替えの検査（門番と同じ検査）が持つ
  const { diagnoser } = ports
  const banner = createInvalidBanner({ diagnose: diagnoser && ((text) => diagnoser.diagnose(text)) })
  // 状態の行。読むのは refresh の後のタスクなので、下の editor と model をここで参照してよい
  const statusRow = createStatusRow({
    baseline: () => model?.baseline ?? null,
    status: () => model?.status ?? { unsaved: false, saveBlocked: false, path: null },
    view: () => editor.view(),
    rows: () => tableRows(editor)
  })
  root.append(menuHost, commandBar.element, banner.element, body, statusRow.element)

  let model: DocumentModel | undefined
  let seq = 0
  const report = (): DocumentReport => {
    const status = model?.status
    const unsaved = status?.unsaved ?? false
    return {
      seq: ++seq,
      unsaved,
      saveBlocked: status?.saveBlocked ?? false,
      title: windowTitle(status?.path ?? null, unsaved)
    }
  }
  const publishState = (): void => {
    const state = report()
    document.title = state.title
    ports.setDocumentState(state)
    statusRow.refresh()
  }

  // 表示の切り替えはメニューの行に置く。上流の Text/Tree/Table のボタンは主のエディタから外し、
  // 殻のボタンは上流のボタンと同じ経路（門番を通る）で頼む
  const viewSwitch = createViewSwitch({
    request: (mode) => {
      if (!editorPort.hasOpenModal()) {
        modeMenu.request(mode)
      }
    },
    probe: (mode) => editor.probeMode(mode),
    onTextOnlyChange: (textOnly) => {
      // テキスト以外へ移ったとき（描画の中）は帯を消すだけ。決まったとき（検査の後）は今の本文の理由を取る
      if (textOnly) {
        banner.show(currentText(editor))
      } else {
        banner.hide()
      }
      // テキストでしか開けない文書では、効かない命令（並べ替え、変換、展開、折りたたみ）を押せない見た目にする（D12）
      commandBar.setTextOnly(textOnly)
    }
  })
  // 左ペイン（D7、D13）。表示は切り替えが受けた主のエディタの表示を見る。押すと、表では対象を替え、
  // ツリーでは対象を入れてから切り替えと同じ経路（門番を通る）で表へ移る
  const targetPane = createTargetPane({
    mode: () => viewSwitch.mode(),
    tableTarget: () => editor.view().tableTarget,
    document: () => currentJson(editor),
    hideInTree: () => hideTargetsInTree,
    onPick: (path: JSONPath) => {
      if (editorPort.hasOpenModal()) {
        return
      }
      const mode = viewSwitch.mode()
      if (mode === Mode.table) {
        editor.setTableTarget(path)
        targetPane.refresh()
        statusRow.refresh() // 件数は今の対象の要素の数
        locationRow.refresh()
        editor.focus()
      } else if (mode === Mode.tree) {
        showTableAt(path)
      }
    }
  })
  /**
   * ツリーから表の対象を入れて表へ移る。左ペインの押下と、外の変更の読み直しの後に表を戻すときが通る。
   * 表へは切り替えのボタンと同じ経路（上流の表示のボタンの押下、門番を通る）で移る。
   */
  function showTableAt(path: JSONPath): void {
    // 確定前の入力は setTableTarget が先に文書へ入れる。表へ移った後の見直しは handleViewChange が行う
    editor.setTableTarget(path)
    modeMenu.request(Mode.table)
    targetPane.refresh()
    statusRow.refresh()
    locationRow.refresh()
  }
  editorColumn.append(locationRow.element, editorHost)
  // 翻訳の結果の小窓（右）。文書に触らない別の DOM（R1）
  let translateFlow: TranslateFlow | undefined
  let translateMenu: TranslateMenu | undefined
  const translatePanel = createTranslatePanel({
    onCancel: () => translateFlow?.cancel(),
    onResume: () => void translateFlow?.resume(),
    onClose: () => {
      translateFlow?.reset()
      editor.focus()
    },
    onAddColumn: () => void addTranslationColumn(),
    onHideMachineNotice: () => void translateFlow?.hideMachineNotice(),
    copy: (text) => navigator.clipboard.writeText(text)
  })
  body.append(targetPane.element, editorColumn, translatePanel.element)

  const modeMenu = createMainModeMenu((mode) => {
    viewSwitch.setMode(mode)
    targetPane.refresh() // 描画の中から呼ばれる。ペインは後のタスクで読む
    locationRow.refresh()
  })
  // 上流の表示のボタンは殻の切り替えへ、残りの命令はコマンドの行へ（主のエディタだけ）
  const renderMenu = mainMenuRenderer(modeMenu, commandBar)
  /** 文書か表示が変わった。前の本文の検査と理由を捨て、テキストの表示なら検査し直す。 */
  const recheckDocument = (): void => {
    banner.invalidate()
    viewSwitch.recheck()
  }

  /** 文書が編集された。上流の onChange と、onChange を呼ばない公開の patch（訳の列を足す）の後に通る。 */
  const afterEdit = (): void => {
    model?.noteEdit()
    recheckDocument()
    targetPane.refresh()
    statusRow.refresh()
    locationRow.refresh()
  }

  const handleViewChange = (reason?: TableTargetChange): void => {
    if (reason === 'invalid') {
      editor.notify(t('app.notice.targetInvalid'))
    }
    recheckDocument()
    targetPane.refresh()
    statusRow.refresh()
    locationRow.refresh()
    if (reason === 'history' || reason === 'welcome') {
      editor.focus()
    }
  }

  const editor = mountEditor(
    editorHost,
    {
      content: { text: '' },
      mode: Mode.tree,
      language: editorLanguage(),
      ariaLabel: t('app.editor.ariaLabel'),
      onRenderMenu: renderMenu,
      // 表のセルとツリーの値の右クリックに翻訳の項目を足す（正規の設定）。無効なら上流の項目のまま
      onRenderContextMenu: (items, context) => translateMenu?.renderContextMenu(items, context) ?? items,
      onSelect: (selection) => {
        // 更新の中から呼ばれる。行は後のタスクで読む
        lastSelection = selection
        locationRow.refresh()
      },
      onChange: () => afterEdit()
    },
    { scanner: ports.scanner, onViewChange: handleViewChange }
  )
  const editorPort = createEditorPort(editor, editorHost)
  const opened = new DocumentModel(ports.backend, editorPort)
  model = opened
  opened.subscribe(publishState)
  installEditSignal(editorHost, () => opened.noteEdit())
  installTextContextMenu(editorHost)

  // 開く処理と保存の 1 関数が確認を含めて途中の数。外の変更の見張りはこの間は見送る（D5）
  let flowsInFlight = 0
  const tracked = <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      flowsInFlight++
      return run(...args).finally(() => {
        flowsInFlight--
      })
    }

  const open = tracked(createOpenFlow({
    model: opened,
    ask: ports.ask,
    notify: editor.notify,
    onOpened: () => {
      // 列の幅は開いている文書の間だけ保つ
      resetColumnWidths()
      // 前の文書の訳は出さない（仕事は取り消す）
      translateFlow?.reset()
      recheckDocument()
      lastSelection = undefined // 前の文書の選択を場所の行と Edit メニューに使わない
      targetPane.refresh()
      statusRow.refresh()
      locationRow.refresh()
      void refreshRecent()
    },
    onUnsaved: (path) => ports.requestOpen(path, report()),
    onMissing: (path) => void ports.forgetRecent(path).then(refreshRecent)
  }))

  const saveFlow = createSaveFlow({
    model: opened,
    ask: ports.ask,
    pickSave: ports.pickSave,
    notify: editor.notify,
    hasOpenModal: () => editorPort.hasOpenModal()
  })
  // 保存は印が変わらなくても基準（文字コード、改行）を替えることがある。状態の行を見直す
  const save = tracked(
    (destination: SaveDestination): Promise<SaveResult> => saveFlow(destination).finally(() => statusRow.refresh())
  )

  // 外の変更の見張りとテキストで開く（D5）。Tauri の外（試験の器の一部、開発サーバ）には口が無い
  const { external } = ports
  const externalFlow =
    external &&
    createExternalFlow({
      model: opened,
      external,
      ask: ports.ask,
      notify: editor.notify,
      hasOpenModal: () => editorPort.hasOpenModal(),
      flowBusy: () => flowsInFlight > 0,
      open,
      save,
      captureView: () => {
        const before = editor.view()
        return () => {
          const kept = viewAfterReload(before, editor.view(), {
            json: currentJson(editor),
            textOnly: opened.baseline?.textOnly ?? true
          })
          if (kept === undefined || editorPort.hasOpenModal()) {
            return // テキストでしか開けない、または前の対象が無い。開く処理が選んだ表示（ツリーかテキスト）のまま
          }
          if (kept.mode === Mode.table) {
            showTableAt(kept.tableTarget)
          } else {
            editor.setTableTarget(kept.tableTarget)
            targetPane.refresh()
            statusRow.refresh()
            locationRow.refresh()
          }
        }
      }
    })

  async function saveAndContinue(id: number): Promise<void> {
    const result = await save('current')
    ports.saveFinished(id, result === 'saved' || result === 'noChange', report())
  }

  function about(): void {
    void ports.ask({
      title: t('app.dialog.aboutTitle'),
      body: format('app.dialog.aboutBody', { version: startup.version }),
      level: 'info',
      buttons: [t('app.dialog.ok')],
      default: 0,
      cancel: 0
    })
  }

  // 翻訳の設定のダイアログ。Tauri の外（設定の口が無い）では Options の項目を押せない
  const { translation } = ports
  /**
   * キーのある枠（右クリックの項目の数を決める）。翻訳が有効のときだけ読む（無効なら Rust を呼ばない）。
   * 起動のとき、設定のダイアログを閉じたとき、翻訳の流れが設定を読み直したときに覚え直す。
   */
  let translationKeyTiers: string[] = []
  const refreshTranslationKeys = (): void => {
    if (!translation || !translationEnabled) {
      return
    }
    translation.settings().then(
      (settings) => {
        translationKeyTiers = availableTiers(settings)
      },
      () => {
        // 読めなければ前の値のまま。押したときに流れが読み直し、理由を出す
      }
    )
  }
  const translationSettings =
    translation &&
    createTranslationSettings({
      ports: translation,
      host: root,
      onSaved: (choice) => {
        translationEnabled = choice.enabled
      },
      onClosed: () => {
        refreshTranslationKeys()
        editor.focus()
      }
    })
  refreshTranslationKeys()
  /** 殻の持つダイアログか、エディタのモーダルが開いている。キーの入口とメニューの入口を止める。 */
  const anyModalOpen = (): boolean => editorPort.hasOpenModal() || translationSettings?.isOpen() === true

  // 翻訳の右クリックと流れ。Tauri の外（翻訳の口が無い）では項目を出さない
  const translateTarget = (): string | undefined => {
    const language = currentLanguage()
    return TARGET_LANGUAGES.includes(language) ? language : undefined
  }
  if (translation) {
    const flow = createTranslateFlow({
      ports: translation,
      ask: ports.ask,
      askChecked: ports.askChecked,
      notify: editor.notify,
      panel: translatePanel,
      enabled: () => translationEnabled,
      onDisabled: () => {
        translationEnabled = false
      },
      openSettings: () => void translationSettings?.open(),
      onSettings: (settings) => {
        translationKeyTiers = availableTiers(settings)
      },
      target: translateTarget
    })
    translateFlow = flow
    translateMenu = createTranslateMenu({
      host: editorHost,
      enabled: () => translationEnabled && translateTarget() !== undefined,
      hasOpenModal: anyModalOpen,
      mode: () => viewSwitch.mode(),
      tableTarget: () => editor.view().tableTarget,
      document: () => currentJson(editor),
      tiers: () => translationKeyTiers,
      onColumn: (column, tier) => {
        const tableTarget = editor.view().tableTarget
        const label = pathLabel(column)
        void flow.request({
          source: () => format('app.translate.panel.sourceColumn', { column: label }),
          items: collectColumn(currentJson(editor), tableTarget, column),
          column: { tableTarget, column },
          tier
        })
      },
      onValue: (path, tier) => {
        const label = path.length === 0 ? t('app.target.whole') : pathLabel(path)
        void flow.request({
          source: () => format('app.translate.panel.sourceValue', { path: label }),
          items: collectValue(currentJson(editor), path),
          tier
        })
      }
    })
  }

  /**
   * 訳を新しい列として足す（T5）。`add` だけを 1 回の patch で入れ（元に戻す 1 回で戻る）、行ごとに今の値が
   * 原文と同じことを確かめる。結果は小窓の進み具合の行に出す。
   */
  async function addTranslationColumn(): Promise<void> {
    const results = translateFlow?.columnResults()
    if (!results) {
      return
    }
    const result = await applyColumn(
      {
        ask: ports.ask,
        hasOpenModal: anyModalOpen,
        mode: () => viewSwitch.mode(),
        tableTarget: () => editor.view().tableTarget,
        setTableTarget: (path) => {
          editor.setTableTarget(path)
          targetPane.refresh()
          statusRow.refresh()
          locationRow.refresh()
        },
        commitPendingInput: () => editor.commitPendingInput(),
        document: () => currentJson(editor),
        patch: (operations) => void editor.patch(operations),
        afterEdit
      },
      results.source,
      results.entries,
      results.target
    )
    const message = applyResultMessage(result)
    if (message !== null && translatePanel.isOpen()) {
      translatePanel.setMessage(message.text, message.kind)
    }
    if (result.kind === 'added') {
      editor.focus() // 元に戻す（Ctrl+Z）がすぐ効くように
    }
  }

  function pickOpen(): void {
    if (editorPort.hasOpenModal()) {
      editor.notify(t('app.notice.openBlockedModal'))
    } else {
      void ports.pickOpen()
    }
  }

  function openRecent(path: string): void {
    if (editorPort.hasOpenModal()) {
      editor.notify(t('app.notice.openBlockedModal'))
    } else {
      void ports.openRecent(path).then(refreshRecent)
    }
  }

  /** 旗を替えて保存する。隠しコマンドの成功で解禁済みになる（`unlock`）。 */
  function setSplashCeremony(enabled: boolean, unlock = false): void {
    splashCeremony = enabled
    splashCeremonyUnlocked = splashCeremonyUnlocked || unlock
    void ports.setSplashCeremony(enabled, unlock)
  }

  /**
   * Edit メニューの項目を押せるか。元に戻すとやり直すはコマンドの行（上流の項目）と同じ。切り取りとコピーは
   * 中身のある選択、貼り付けは選択があるとき。テキストの表示は右クリックのメニューと同じ判定。
   */
  function editMenuState(): EditMenuState {
    if (editorPort.hasOpenModal()) {
      return {
        undo: false,
        redo: false,
        cut: false,
        copy: false,
        paste: false,
        findReplace: false,
        openInTextEditor: false
      }
    }
    const textView = viewSwitch.mode() === Mode.text ? mainTextView(editorHost) : null
    const selection = lastSelection !== undefined && !isTextSelection(lastSelection) ? lastSelection : undefined
    const structured = viewSwitch.mode() !== Mode.text
    return {
      undo: commandBar.enabled('undo'),
      redo: commandBar.enabled('redo'),
      cut: textView ? textActionEnabled(textView, 'cut') : structured && hasSelectionContents(selection),
      copy: textView ? textActionEnabled(textView, 'copy') : structured && hasSelectionContents(selection),
      paste: textView ? textActionEnabled(textView, 'paste') : structured && selection !== undefined,
      findReplace: textView !== null || structured,
      // 無題の文書にはディスクの版が無い
      openInTextEditor: externalFlow !== undefined && opened.baseline !== null
    }
  }

  /**
   * Edit メニューの命令。元に戻すとやり直すはコマンドの行と同じ上流の項目、切り取り、コピー、貼り付けは
   * テキストの表示なら右クリックのメニューと同じ CodeMirror の操作、ツリーと表はエディタの公開の関数
   * （右クリックとキーと同じ関数。門番の答えを待つ間は走らない）。
   */
  function runEdit(command: EditMenuCommand): void {
    if (editorPort.hasOpenModal()) {
      return
    }
    if (command === 'undo' || command === 'redo') {
      commandBar.run(command)
      return
    }
    if (command === 'openInTextEditor') {
      void externalFlow?.openInTextEditor()
      return
    }
    const textView = viewSwitch.mode() === Mode.text ? mainTextView(editorHost) : null
    if (textView && command !== 'findReplace') {
      void runTextAction(textView, command)
      return
    }
    editor.runEditCommand(command)
  }

  function runCommand(command: MenuCommand): void {
    if (isEditMenuCommand(command)) {
      runEdit(command)
    } else if (command === 'open') {
      pickOpen()
    } else if (command.startsWith(RECENT_PREFIX)) {
      openRecent(command.slice(RECENT_PREFIX.length))
    } else if (command === 'clearRecent') {
      void ports.clearRecent().then(refreshRecent)
    } else if (command === 'save') {
      void save('current')
    } else if (command === 'saveAs') {
      void save('choosePath')
    } else if (command === 'exit') {
      ports.exit()
    } else if (command === 'about') {
      about()
    } else if (command.startsWith(LANGUAGE_PREFIX)) {
      const language = command.slice(LANGUAGE_PREFIX.length)
      setLanguage(language)
      // 保存と Rust の文言は、選んだ順に 1 つずつ。連続して替えても最後の選択が残る
      persistLanguage = persistLanguage.then(() => ports.setLanguage(language)).catch(() => {})
    } else if (command.startsWith(THEME_PREFIX)) {
      theme = command.slice(THEME_PREFIX.length) as Theme
      applyDocumentAttributes()
      void ports.setTheme(theme)
    } else if (command === 'splashCeremony') {
      setSplashCeremony(!splashCeremony)
    } else if (command === 'wrapLines') {
      // 表示だけを替える。文書、未保存の印、履歴には触らない
      wrapLines = !wrapLines
      tableWrapLines.set(wrapLines)
      // 保存は選んだ順に 1 つずつ。続けて切り替えても最後の選択が残る
      const wrap = wrapLines
      persistWrapLines = persistWrapLines.then(() => ports.setWrapLines(wrap)).catch(() => {})
    } else if (command === 'hideTargetsInTree') {
      // 表示だけを替える（D13）。文書、未保存の印、履歴、表の対象には触らない
      hideTargetsInTree = !hideTargetsInTree
      targetPane.refresh()
      // 保存は選んだ順に 1 つずつ。続けて切り替えても最後の選択が残る
      const hide = hideTargetsInTree
      persistHideTargets = persistHideTargets.then(() => ports.setHideTargetsInTree(hide)).catch(() => {})
    } else if (command === 'translationSettings') {
      if (!editorPort.hasOpenModal()) {
        void translationSettings?.open()
      }
    }
  }

  const menu = createMenuBar(menuHost, {
    build: () =>
      buildMenus({
        language: currentLanguage(),
        theme,
        recent,
        splashCeremony,
        splashCeremonyUnlocked,
        wrapLines,
        hideTargetsInTree,
        translationSettings: translationSettings !== undefined,
        edit: editMenuState()
      }),
    onCommand: runCommand,
    onDismiss: () => editor.focus(),
    trailing: viewSwitch.element
  })

  // 隠しコマンド: メニューバー右端の花びらだけを続けて押すと、起動セレモニーの旗を反転する
  const secretClick = createSecretClickCounter()
  const playPetal = (petal: HTMLElement, className: string): void => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    petal.classList.remove(PETAL_WOBBLE_CLASS, PETAL_SPIN_CLASS)
    void petal.offsetWidth // 連打でも動きを頭から掛け直す
    petal.classList.add(className)
    petal.addEventListener('animationend', () => petal.classList.remove(className), { once: true })
  }
  menuHost.addEventListener('click', (event) => {
    const petal = (event.target as HTMLElement).closest<HTMLElement>(`.${PETAL_CLASS}`)
    if (!petal) {
      return
    }
    if (secretClick(Date.now())) {
      setSplashCeremony(!splashCeremony, true)
      editor.notify(t(splashCeremony ? 'app.notice.splashCeremonyOn' : 'app.notice.splashCeremonyOff'))
      playPetal(petal, PETAL_SPIN_CLASS)
    } else {
      playPetal(petal, PETAL_WOBBLE_CLASS)
    }
  })

  installKeys({
    actions: {
      open: pickOpen,
      save: () => void save('current'),
      saveAs: () => void save('choosePath')
    },
    menu,
    hasOpenModal: anyModalOpen
  })

  subscribeLanguage(() => {
    applyDocumentAttributes()
    editor.updateProps({ language: editorLanguage(), ariaLabel: t('app.editor.ariaLabel') })
    viewSwitch.refresh()
    commandBar.refresh()
    banner.refresh()
    menu.render()
    targetPane.refresh()
    locationRow.refresh()
    translatePanel.refresh()
    publishState()
  })

  // 別の EXE が足した分を、戻ってきたときに読み直す。開いているファイルの外の変更も見る（D5）
  window.addEventListener('focus', () => {
    void refreshRecent()
    void externalFlow?.check()
  })

  publishState()
  await ports.subscribe((event: ShellEvent) => {
    if (event.kind === 'Open') {
      void open(event.path, { discardConfirmed: event.discardConfirmed })
    } else if (event.kind === 'SaveAndContinue') {
      void saveAndContinue(event.id)
    } else {
      editor.notify(t(event.key))
    }
  })
  await ports.ready()

  return { editor, model: opened, open, save, translationEnabled: () => translationEnabled }
}
