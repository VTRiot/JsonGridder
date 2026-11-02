import './theme.css'
import type { JSONPath } from 'immutable-json-patch'
import { isTextContent } from '$lib/utils/jsonUtils'
import { Mode, type TableTargetChange } from '$lib/types'
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
import { installKeys } from './keys'
import { installEditSignal } from './editSignal'
import { createMenuBar } from './menu'
import { createSecretClickCounter, PETAL_CLASS, PETAL_SPIN_CLASS, PETAL_WOBBLE_CLASS } from './secretClicks'
import { buildMenus, type MenuCommand, type Theme } from './menuModel'
import { createOpenFlow } from './openFlow'
import type { DocumentReport, ShellEvent, ShellPorts } from './ports'
import { createSaveFlow, type SaveDestination, type SaveResult } from './saveFlow'
import { createTargetBar } from './targetBar'
import { installTextContextMenu } from './textContextMenu'
import { windowTitle } from './title'

const LANGUAGE_PREFIX = 'language:'
const THEME_PREFIX = 'theme:'
const RECENT_PREFIX = 'recent:'

export interface App {
  editor: EditorHandle
  model: DocumentModel
  open: ReturnType<typeof createOpenFlow>
  save(destination: SaveDestination): Promise<SaveResult>
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
  const targetHost = element('app-target-host')
  const editorHost = element('app-editor')
  root.append(menuHost, targetHost, editorHost)

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
  }

  const targetBar = createTargetBar(targetHost, {
    view: () => editor.view(),
    document: () => currentJson(editor),
    onPick: (path: JSONPath) => {
      if (!editorPort.hasOpenModal()) {
        editor.setTableTarget(path)
        targetBar.refresh()
        editor.focus()
      }
    },
    onDismiss: () => editor.focus()
  })

  const handleViewChange = (reason?: TableTargetChange): void => {
    if (reason === 'invalid') {
      editor.notify(t('app.notice.targetInvalid'))
    }
    targetBar.refresh()
    if (reason === 'history' || reason === 'welcome') {
      editor.focus()
    }
  }

  const editor = mountEditor(
    editorHost,
    {
      content: { text: '' },
      mode: Mode.table,
      language: editorLanguage(),
      ariaLabel: t('app.editor.ariaLabel'),
      onChange: () => {
        model?.noteEdit()
        targetBar.refresh()
      }
    },
    { scanner: ports.scanner, onViewChange: handleViewChange }
  )
  const editorPort = createEditorPort(editor, editorHost)
  const opened = new DocumentModel(ports.backend, editorPort)
  model = opened
  opened.subscribe(publishState)
  installEditSignal(editorHost, () => opened.noteEdit())
  installTextContextMenu(editorHost)

  const open = createOpenFlow({
    model: opened,
    ask: ports.ask,
    notify: editor.notify,
    onOpened: () => {
      // 列の幅は開いている文書の間だけ保つ
      resetColumnWidths()
      targetBar.refresh()
      void refreshRecent()
    },
    onUnsaved: (path) => ports.requestOpen(path, report()),
    onMissing: (path) => void ports.forgetRecent(path).then(refreshRecent)
  })

  const save = createSaveFlow({
    model: opened,
    ask: ports.ask,
    pickSave: ports.pickSave,
    notify: editor.notify,
    hasOpenModal: () => editorPort.hasOpenModal()
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

  function runCommand(command: MenuCommand): void {
    if (command === 'open') {
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
    }
  }

  const menu = createMenuBar(menuHost, {
    build: () =>
      buildMenus({ language: currentLanguage(), theme, recent, splashCeremony, splashCeremonyUnlocked, wrapLines }),
    onCommand: runCommand,
    onDismiss: () => editor.focus()
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
    hasOpenModal: () => editorPort.hasOpenModal()
  })

  subscribeLanguage(() => {
    applyDocumentAttributes()
    editor.updateProps({ language: editorLanguage(), ariaLabel: t('app.editor.ariaLabel') })
    menu.render()
    targetBar.refresh()
    publishState()
  })

  // 別の EXE が足した分を、戻ってきたときに読み直す
  window.addEventListener('focus', () => void refreshRecent())

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

  return { editor, model: opened, open, save }
}
