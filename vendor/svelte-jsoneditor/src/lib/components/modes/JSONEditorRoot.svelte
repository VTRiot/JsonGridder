<script lang="ts">
  import type {
    Content,
    ContentErrors,
    ContextMenuItem,
    EditCommand,
    HistoryItem,
    History,
    HistorySnapshot,
    JSONEditorSelection,
    JSONParser,
    JSONPatchResult,
    JSONPathParser,
    MenuItem,
    MenuSeparator,
    ModeGuard,
    OnBlur,
    OnChange,
    OnChangeMode,
    OnChangeTableTarget,
    OnClassName,
    OnError,
    OnExpand,
    OnFocus,
    OnJSONEditorModal,
    OnRenderContextMenu,
    OnRenderContextMenuInternal,
    OnRenderMenu,
    OnRenderMenuInternal,
    OnRenderValue,
    OnSelect,
    OnSortModal,
    OnTransformModal,
    TransformModalOptions,
    Validator,
    ModeHistoryItem
  } from '$lib/types'
  import { Mode } from '$lib/types.js'
  import TextMode from './textmode/TextMode.svelte'
  import TableMode from './tablemode/TableMode.svelte'
  import TreeMode from './treemode/TreeMode.svelte'
  import { compileJSONPointer, type JSONPatchDocument, type JSONPath } from 'immutable-json-patch'
  import { isMenuSpace, isModeHistoryItem } from '$lib/typeguards.js'
  import { cloneDeep } from 'lodash-es'
  import { createHistoryInstance } from '$lib/logic/history'
  import { createDebug } from '$lib/utils/debug'
  import { noop } from '$lib/utils/noop.js'
  import { t } from '$lib/i18n/index.js'
  import { onDestroy } from 'svelte'

  export let content: Content
  export let selection: JSONEditorSelection | undefined

  export let readOnly: boolean
  export let indentation: number | string
  export let tabSize: number
  export let truncateTextSize: number
  export let externalMode: Mode
  export let ariaLabel: string | undefined = undefined
  export let mainMenuBar: boolean
  export let navigationBar: boolean
  export let statusBar: boolean
  export let askToFormat: boolean
  export let escapeControlCharacters: boolean
  export let escapeUnicodeCharacters: boolean
  export let maxDocumentSizeTextMode: number
  export let modeGuard: ModeGuard | undefined = undefined
  export let allowExtract: boolean = true
  export let flattenColumns: boolean
  export let parser: JSONParser
  export let parseMemoizeOne: JSONParser['parse']
  export let validator: Validator | undefined
  export let validationParser: JSONParser
  export let pathParser: JSONPathParser
  export let insideModal: boolean

  export let onChange: OnChange
  export let onChangeMode: OnChangeMode
  export let tableTarget: JSONPath = []
  export let onChangeTableTarget: OnChangeTableTarget | undefined = undefined
  export let onSelect: OnSelect
  export let onRenderValue: OnRenderValue
  export let onClassName: OnClassName
  export let onRenderMenu: OnRenderMenu
  export let onRenderContextMenu: OnRenderContextMenu
  export let onError: OnError
  export let onFocus: OnFocus
  export let onBlur: OnBlur
  export let onSortModal: OnSortModal
  export let onTransformModal: OnTransformModal
  export let onJSONEditorModal: OnJSONEditorModal

  /** True while an asynchronous mode guard has not answered yet. */
  export let checkingMode = false

  let refTreeMode: TreeMode | undefined
  let refTableMode: TableMode | undefined
  let refTextMode: TextMode | undefined

  const debug = createDebug('jsoneditor:JSONEditorRoot')

  const historyInstance = createHistoryInstance<HistoryItem>({
    onChange: (updatedHistory) => (history = updatedHistory)
  })

  let history: History<HistoryItem> = historyInstance.get()

  let mode = externalMode

  // The most recent content. The content prop only follows after the next update.
  let latestContent = content
  $: latestContent = content

  const handleChangeContent: OnChange = (updatedContent, previousContent, status) => {
    latestContent = updatedContent
    onChange?.(updatedContent, previousContent, status)
  }

  let destroyed = false

  onDestroy(() => {
    destroyed = true
  })

  // Nothing can undo or redo during the check: a refused undo has to find the history unchanged.
  // This is evaluated in the markup: history also changes in the reactive statement that applies
  // the mode, which runs after a reactive statement on history would have.
  function viewHistory(
    history: History<HistoryItem>,
    checkingMode: boolean
  ): History<HistoryItem> {
    return checkingMode
      ? { ...history, canUndo: false, canRedo: false, undo: noUndo, redo: noUndo }
      : history
  }

  function noUndo() {
    return undefined
  }

  /**
   * The single place that decides on a mode change, for all routes: the mode buttons, the buttons
   * in messages, undo and redo, and setting the mode from outside. Text mode is the only mode that
   * can hold a document that cannot be shown as JSON, so only entering and leaving it is checked.
   *
   * Undo and redo have already stepped the history when they get here. onRefused steps it back
   * and onStep steps it again. While the answer is awaited the history stands before the step:
   * text typed meanwhile adds an item on top of a history that is complete. Stepped forward, the
   * add would drop the mode item and leave the items of another mode right below the text.
   */
  function checkMode(
    target: Mode,
    onAllowed: () => void,
    onRefused: () => void = noop,
    onStep: () => void = noop
  ) {
    const checked = modeGuard && target !== mode && (mode === Mode.text || target === Mode.text)
    if (!checked) {
      onAllowed()
      return
    }

    if (checkingMode) {
      onRefused()
      return
    }

    refTextMode?.flush()

    const checkedContent = latestContent
    const verdict = (modeGuard as ModeGuard)(target, checkedContent)
    if (typeof verdict === 'boolean') {
      ;(verdict ? onAllowed : onRefused)()
      return
    }

    onRefused()
    const checkedHistory = historyInstance.snapshot()

    function historyUnchanged() {
      const { reverseItems, index } = historyInstance.snapshot()
      return reverseItems === checkedHistory.reverseItems && index === checkedHistory.index
    }

    checkingMode = true
    verdict.then(
      (allowed) => {
        checkingMode = false
        if (destroyed) {
          return
        }

        refTextMode?.flush()
        if (allowed && latestContent === checkedContent && historyUnchanged()) {
          onStep()
          onAllowed()
        }
      },
      (err) => {
        checkingMode = false
        if (!destroyed) {
          onError(err)
        }
      }
    )
  }

  export function requestMode(target: Mode, apply: OnChangeMode = onChangeMode): void {
    checkMode(target, () => apply(target))
  }

  function handleRequestMode(target: Mode) {
    requestMode(target)
  }

  function applyExternalMode(externalMode: Mode) {
    if (externalMode === mode) {
      return
    }

    const item: ModeHistoryItem = {
      type: 'mode',
      undo: { mode, selection: undefined },
      redo: { mode: externalMode, selection: undefined }
    }

    if (mode === 'text' && refTextMode) {
      // flush pending changes before adding a new history item
      refTextMode.flush()
    }

    debug('add history item', item)
    history.add(item)

    mode = externalMode
  }

  // eslint-disable-next-line svelte/no-unused-svelte-ignore
  // svelte-ignore reactive_declaration_non_reactive_property
  $: applyExternalMode(externalMode)

  function handleUndo(item: HistoryItem | undefined) {
    if (isModeHistoryItem(item)) {
      checkMode(
        item.undo.mode,
        () => {
          mode = item.undo.mode // important to prevent a new history item from being created

          // find the selection of the previous history item (if any), and use that as initial selection
          const items = history.items()
          const index = items.findIndex((i) => i === item)
          const prevItem = index !== -1 ? items[index - 1] : undefined
          debug('handleUndo', { index, item, items, prevItem })
          if (prevItem) {
            selection = prevItem.redo.selection
          }

          onChangeMode(mode)
        },
        () => history.redo(),
        () => history.undo()
      )
    }
  }

  function handleRedo(item: HistoryItem | undefined) {
    if (isModeHistoryItem(item)) {
      checkMode(
        item.redo.mode,
        () => {
          // prevent a new history item from being created
          mode = item.redo.mode

          // find the selection of the next history item (if any), and use that as initial selection
          const items = history.items()
          const index = items.findIndex((i) => i === item)
          const nextItem = index !== -1 ? items[index + 1] : undefined
          debug('handleRedo', { index, item, items, nextItem })
          if (nextItem) {
            selection = nextItem.undo.selection
          }

          onChangeMode(mode)
        },
        () => history.undo(),
        () => history.redo()
      )
    }
  }

  let modeName: string
  $: modeName =
    mode === Mode.text ? $t('modeText') : mode === Mode.tree ? $t('modeTree') : $t('modeTable')

  let modeMenuItems: MenuItem[]
  $: modeMenuItems = [
    {
      type: 'button',
      text: $t('modeText'),
      title: `${$t('switchToTextMode')} ${$t('currentMode', { mode: modeName })}`,
      className: 'jse-group-button jse-first' + (mode === Mode.text ? ' jse-selected' : ''),
      onClick: () => handleRequestMode(Mode.text)
    },
    {
      type: 'button',
      text: $t('modeTree'),
      title: `${$t('switchToTreeMode')} ${$t('currentMode', { mode: modeName })}`,
      className: 'jse-group-button ' + (mode === Mode.tree ? ' jse-selected' : ''),
      onClick: () => handleRequestMode(Mode.tree)
    },
    {
      type: 'button',
      text: $t('modeTable'),
      title: `${$t('switchToTableMode')} ${$t('currentMode', { mode: modeName })}`,
      className: 'jse-group-button jse-last' + (mode === Mode.table ? ' jse-selected' : ''),
      onClick: () => handleRequestMode(Mode.table)
    }
  ]

  const separatorMenuItem: MenuSeparator = {
    type: 'separator'
  }

  let handleRenderMenu: OnRenderMenuInternal
  $: handleRenderMenu = (items: MenuItem[]) => {
    const updatedItems = isMenuSpace(items[0])
      ? modeMenuItems.concat(items) // menu is empty, readOnly mode
      : modeMenuItems.concat(separatorMenuItem, items)

    const updatedItemsOriginal = cloneDeep(updatedItems) // the user may change updatedItems in the callback

    return (
      onRenderMenu(updatedItems, { mode, modal: insideModal, readOnly }) || updatedItemsOriginal
    )
  }

  let handleRenderContextMenu: OnRenderContextMenuInternal
  $: handleRenderContextMenu = (items: ContextMenuItem[]) => {
    const itemsOriginal = cloneDeep(items) // the user may change items in the callback

    return (
      onRenderContextMenu(items, { mode, modal: insideModal, readOnly, selection }) ??
      (readOnly ? false : itemsOriginal)
    )
  }

  export function patch(operations: JSONPatchDocument): JSONPatchResult {
    if (refTreeMode) {
      // Note that tree mode has an optional afterPatch callback.
      // right now we don's support this in the public API.
      return refTreeMode.patch(operations)
    }

    if (refTableMode) {
      // Note that tree mode has an optional afterPatch callback.
      // right now we don's support this in the public API.
      return refTableMode.patch(operations)
    }

    if (refTextMode) {
      return refTextMode.patch(operations)
    }

    throw new Error(`Method patch is not available in mode "${mode}"`)
  }

  export function expand(path: JSONPath, callback?: OnExpand): void {
    if (refTreeMode) {
      return refTreeMode.expand(path, callback)
    } else if (refTextMode) {
      return refTextMode.expand(path, callback)
    } else {
      throw new Error(`Method expand is not available in mode "${mode}"`)
    }
  }

  export function collapse(path: JSONPath, recursive: boolean): void {
    if (refTreeMode) {
      return refTreeMode.collapse(path, recursive)
    } else if (refTextMode) {
      return refTextMode.collapse(path, recursive)
    } else {
      throw new Error(`Method collapse is not available in mode "${mode}"`)
    }
  }

  /**
   * Open the transform modal
   */
  export function transform(options: TransformModalOptions): void {
    if (refTextMode) {
      refTextMode.openTransformModal(options)
    } else if (refTreeMode) {
      refTreeMode.openTransformModal(options)
    } else if (refTableMode) {
      refTableMode.openTransformModal(options)
    } else {
      throw new Error(`Method transform is not available in mode "${mode}"`)
    }
  }

  /**
   * Validate the contents of the editor using the configured validator.
   * Returns a parse error or a list with validation warnings
   */
  export function validate(): ContentErrors | undefined {
    if (refTextMode) {
      return refTextMode.validate()
    } else if (refTreeMode) {
      return refTreeMode.validate()
    } else if (refTableMode) {
      return refTableMode.validate()
    } else {
      throw new Error(`Method validate is not available in mode "${mode}"`)
    }
  }

  /**
   * In tree mode, invalid JSON is automatically repaired when loaded. When the
   * repair was successful, the repaired contents are rendered but not yet
   * applied to the document itself until the user clicks "Ok" or starts editing
   * the data. Instead of accepting the repair, the user can also click
   * "Repair manually instead". Invoking `.acceptAutoRepair()` will
   * programmatically accept the repair. This will trigger an update,
   * and the method itself also returns the updated contents. In case of text
   * mode or when the editor is not in an "accept auto repair" status, nothing
   * will happen, and the contents will be returned as is.
   */
  export function acceptAutoRepair(): Content {
    if (refTreeMode) {
      return refTreeMode.acceptAutoRepair()
    } else {
      return content
    }
  }

  export function scrollTo(path: JSONPath): Promise<void> {
    if (refTreeMode) {
      return refTreeMode.scrollTo(path)
    } else if (refTableMode) {
      return refTableMode.scrollTo(path)
    } else {
      // TODO: implement scrollTo for text mode
      throw new Error(`Method scrollTo is not available in mode "${mode}"`)
    }
  }

  export function findElement(path: JSONPath): Element | undefined {
    if (refTreeMode) {
      return refTreeMode.findElement(path)
    } else if (refTableMode) {
      return refTableMode.findElement(path)
    } else {
      throw new Error(`Method findElement is not available in mode "${mode}"`)
    }
  }

  export function focus() {
    if (refTextMode) {
      refTextMode.focus()
    } else if (refTreeMode) {
      refTreeMode.focus()
    } else if (refTableMode) {
      refTableMode.focus()
    }
  }

  /**
   * Run an edit command from outside, with the same function as the context menu and the keyboard
   * shortcut of the current mode. Nothing runs while the mode guard has not answered: the mode can
   * still change, like undo and the mode buttons wait.
   */
  export function runEditCommand(command: EditCommand): boolean {
    if (checkingMode) {
      return false
    }
    if (refTreeMode) {
      return refTreeMode.runEditCommand(command)
    }
    if (refTableMode) {
      return refTableMode.runEditCommand(command)
    }
    if (refTextMode) {
      return refTextMode.runEditCommand(command)
    }
    return false
  }

  export async function refresh(): Promise<void> {
    if (refTextMode) {
      await refTextMode.refresh()
    } else {
      // nothing to do in tree or table mode (also: don't throw an exception or so,
      // that annoying having to reckon with that when using .refresh()).
    }
  }

  /**
   * テキストの表示の遅延中の入力をその場で確定する。ツリーと表には遅延が無いので何もしない。
   */
  export function flush(): void {
    refTextMode?.flush()
  }

  /**
   * Bring all input into the document: what was typed in text mode and the value that is being
   * edited in tree or table mode. Only call this from outside an update: the tree and table modes
   * use flushSync.
   */
  export function commitInput(): void {
    refTextMode?.flush()
    refTableMode?.commitEdit()
    refTreeMode?.commitEdit()
  }

  export function snapshotHistory(): HistorySnapshot<HistoryItem> {
    return historyInstance.snapshot()
  }

  export function restoreHistory(snapshot: HistorySnapshot<HistoryItem>): void {
    historyInstance.restore(snapshot)
  }

  export function clearHistory(): void {
    history.clear()
  }
</script>

{#if mode === Mode.text || String(mode) === 'code'}
  <TextMode
    bind:this={refTextMode}
    externalContent={content}
    externalSelection={selection}
    {ariaLabel}
    history={viewHistory(history, checkingMode)}
    {readOnly}
    {indentation}
    {tabSize}
    {mainMenuBar}
    {statusBar}
    {askToFormat}
    {escapeUnicodeCharacters}
    maxDocumentSize={maxDocumentSizeTextMode}
    {parser}
    {validator}
    {validationParser}
    onChange={handleChangeContent}
    onChangeMode={handleRequestMode}
    {onSelect}
    onUndo={handleUndo}
    onRedo={handleRedo}
    {onError}
    {onFocus}
    {onBlur}
    onRenderMenu={handleRenderMenu}
    {onSortModal}
    {onTransformModal}
  />
{:else if mode === Mode.table}
  <!-- a new target starts with no selection, scroll position, row heights or sort order -->
  {#key compileJSONPointer(tableTarget)}
  <TableMode
    bind:this={refTableMode}
    externalContent={content}
    {tableTarget}
    {onChangeTableTarget}
    externalSelection={selection}
    {ariaLabel}
    history={viewHistory(history, checkingMode)}
    {readOnly}
    {allowExtract}
    {truncateTextSize}
    {mainMenuBar}
    {escapeControlCharacters}
    {escapeUnicodeCharacters}
    {flattenColumns}
    {parser}
    {parseMemoizeOne}
    {validator}
    {validationParser}
    {indentation}
    {onError}
    onChange={handleChangeContent}
    onChangeMode={handleRequestMode}
    {onSelect}
    onUndo={handleUndo}
    onRedo={handleRedo}
    {onRenderValue}
    {onFocus}
    {onBlur}
    onRenderMenu={handleRenderMenu}
    onRenderContextMenu={handleRenderContextMenu}
    {onSortModal}
    {onTransformModal}
    {onJSONEditorModal}
  />
  {/key}
{:else}
  <!-- mode === Mode.tree -->
  <TreeMode
    bind:this={refTreeMode}
    externalContent={content}
    externalSelection={selection}
    {ariaLabel}
    history={viewHistory(history, checkingMode)}
    {readOnly}
    {allowExtract}
    {indentation}
    {truncateTextSize}
    {mainMenuBar}
    {navigationBar}
    {escapeControlCharacters}
    {escapeUnicodeCharacters}
    {parser}
    {parseMemoizeOne}
    {validator}
    {validationParser}
    {pathParser}
    {onError}
    onChange={handleChangeContent}
    onChangeMode={handleRequestMode}
    {onSelect}
    onUndo={handleUndo}
    onRedo={handleRedo}
    {onRenderValue}
    {onClassName}
    {onFocus}
    {onBlur}
    onRenderMenu={handleRenderMenu}
    onRenderContextMenu={handleRenderContextMenu}
    {onSortModal}
    {onTransformModal}
    {onJSONEditorModal}
  />
{/if}
