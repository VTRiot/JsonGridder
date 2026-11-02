<svelte:options immutable={true} />

<script lang="ts">
  import type {
    AbsolutePopupContext,
    AbsolutePopupOptions,
    AfterPatchCallback,
    Content,
    ContentErrors,
    ContextMenuItem,
    DocumentState,
    History,
    HistoryItem,
    JSONEditorContext,
    JSONEditorSelection,
    JSONParser,
    JSONPatchResult,
    JSONRepairModalProps,
    JSONSelection,
    OnBlur,
    OnChange,
    OnChangeMode,
    OnChangeTableTarget,
    TableTargetChange,
    TreeHistoryItem,
    OnError,
    OnFocus,
    OnJSONEditorModal,
    OnRedo,
    OnRenderContextMenuInternal,
    OnRenderMenuInternal,
    OnRenderValue,
    OnSelect,
    OnSortModal,
    OnTransformModal,
    OnUndo,
    ParseError,
    PastedJson,
    ScrollToOptions,
    SearchResultDetails,
    SearchResults,
    SortedColumn,
    TransformModalOptions,
    ValidationError,
    Validator,
    ValueNormalization
  } from '$lib/types'
  import { Mode, SortDirection, ValidationSeverity } from '$lib/types.js'
  import { t } from '$lib/i18n/index.js'
  import TableMenu from './menu/TableMenu.svelte'
  import {
    compileJSONPointer,
    isJSONArray,
    setIn,
    type JSONPatchDocument,
    type JSONPath
  } from 'immutable-json-patch'
  import { immutableJSONPatch } from '$lib/logic/jsonPatch.js'
  import {
    isTextContent,
    normalizeJsonParseError,
    parseAndRepair,
    parsePartialJson,
    repairPartialJson
  } from '../../../utils/jsonUtils.js'
  import {
    calculateAbsolutePosition,
    calculateVisibleSection,
    keepRowRendered,
    clearSortedColumnWhenAffectedByOperations,
    getCellValue,
    getColumns,
    groupValidationErrors,
    maintainColumnOrder,
    mergeValidationErrors,
    selectNextColumn,
    selectNextRow,
    selectPreviousColumn,
    selectPreviousRow,
    toTableCellPosition
  } from '$lib/logic/table.js'
  import { isEmpty, isEqual, uniqueId } from 'lodash-es'
  import {
    activeElementIsChildOf,
    createNormalizationFunctions,
    encodeDataPath,
    findParentWithNodeName,
    getDataPathFromTarget,
    getWindow,
    isChildOf
  } from '$lib/utils/domUtils.js'
  import { createDebug } from '$lib/utils/debug.js'
  import {
    createDocumentState,
    documentStatePatch,
    getEnforceString,
    getInRecursiveState,
    setInDocumentState,
    syncDocumentState
  } from '$lib/logic/documentState.js'
  import { isObjectOrArray, isUrl, stringConvert } from '$lib/utils/typeUtils.js'
  import InlineValue from './tag/InlineValue.svelte'
  import {
    canAddCellValue,
    createNestedValueOperations,
    extract,
    findRefusedKey,
    revertJSONPatchWithMoveOperations
  } from '$lib/logic/operations.js'
  import {
    createValueSelection,
    getFocusPath,
    getInDocument,
    isEditingSelection,
    isJSONSelection,
    isValueSelection,
    pathExistsInDocument,
    pathInSelection,
    pathStartsWith,
    removeEditModeFromSelection,
    selectionExistsInDocument
  } from '$lib/logic/selection.js'
  import ColumnHeader from './ColumnHeader.svelte'
  import { sortJson } from '$lib/logic/sort.js'
  import { keyComboFromEvent } from '$lib/utils/keyBindings.js'
  import { createFocusTracker } from '$lib/components/controls/createFocusTracker.js'
  import { flushSync, getContext, onDestroy, onMount, tick } from 'svelte'
  import Message from '../../controls/Message.svelte'
  import { faCheck, faCode, faWrench } from '@fortawesome/free-solid-svg-icons'
  import { measure } from '$lib/utils/timeUtils.js'
  import memoizeOne from 'memoize-one'
  import { validateJSON } from '$lib/logic/validation.js'
  import ValidationErrorsOverview from '../../controls/ValidationErrorsOverview.svelte'
  import {
    CONTEXT_MENU_HEIGHT,
    CONTEXT_MENU_WIDTH,
    SCROLL_DURATION,
    SEARCH_BOX_HEIGHT
  } from '$lib/constants.js'
  import { noop } from '$lib/utils/noop.js'
  import { createJump } from '$lib/assets/jump.js/src/jump.js'
  import ValidationErrorIcon from '../treemode/ValidationErrorIcon.svelte'
  import {
    onCopy,
    onCut,
    onDuplicateRow,
    onInsertAfterRow,
    onInsertBeforeRow,
    onInsertCharacter,
    onPaste,
    onRemove,
    onRemoveRow
  } from '$lib/logic/actions.js'
  import JSONRepairModal from '../../modals/JSONRepairModal.svelte'
  import { resizeObserver } from '$lib/actions/resizeObserver.js'
  import CopyPasteModal from '../../../components/modals/CopyPasteModal.svelte'
  import ContextMenuPointer from '../../../components/controls/contextmenu/ContextMenuPointer.svelte'
  import SearchBox from '../../controls/SearchBox.svelte'
  import TableModeWelcome from './TableModeWelcome.svelte'
  import JSONPreview from '../../controls/JSONPreview.svelte'
  import RefreshColumnHeader from './RefreshColumnHeader.svelte'
  import createTableContextMenuItems from './contextmenu/createTableContextMenuItems'
  import ContextMenu from '../../controls/contextmenu/ContextMenu.svelte'
  import { flattenSearchResults, toRecursiveSearchResults } from '$lib/logic/search.js'
  import JSONValue from '../treemode/JSONValue.svelte'
  import { isTreeHistoryItem } from 'svelte-jsoneditor'
  import { columnWidthKey, columnWidths, setColumnWidth, wrapLines } from './tableLayout.js'

  const debug = createDebug('jsoneditor:TableMode')
  const { openAbsolutePopup, closeAbsolutePopup } =
    getContext<AbsolutePopupContext>('absolute-popup')
  const jump = createJump()
  const sortModalId = uniqueId()
  const transformModalId = uniqueId()

  const isSSR = typeof window === 'undefined'
  debug('isSSR:', isSSR)

  export let readOnly: boolean
  export let allowExtract: boolean = true
  export let ariaLabel: string | undefined = undefined
  export let externalContent: Content
  export let externalSelection: JSONEditorSelection | undefined
  export let tableTarget: JSONPath = []
  export let onChangeTableTarget: OnChangeTableTarget | undefined = undefined
  export let history: History<HistoryItem>
  export let truncateTextSize: number
  export let mainMenuBar: boolean
  export let escapeControlCharacters: boolean
  export let escapeUnicodeCharacters: boolean
  export let flattenColumns: boolean
  export let parser: JSONParser
  export let parseMemoizeOne: JSONParser['parse']
  export let validator: Validator | undefined
  export let validationParser: JSONParser
  export let indentation: number | string
  export let onChange: OnChange
  export let onChangeMode: OnChangeMode
  export let onError: OnError
  export let onSelect: OnSelect
  export let onUndo: OnUndo
  export let onRedo: OnRedo
  export let onRenderValue: OnRenderValue
  export let onRenderMenu: OnRenderMenuInternal
  export let onRenderContextMenu: OnRenderContextMenuInternal
  export let onFocus: OnFocus
  export let onBlur: OnBlur
  export let onSortModal: OnSortModal
  export let onTransformModal: OnTransformModal
  export let onJSONEditorModal: OnJSONEditorModal

  let normalization: ValueNormalization
  $: normalization = createNormalizationFunctions({
    escapeControlCharacters,
    escapeUnicodeCharacters
  })

  let refJsonEditor: HTMLDivElement
  let refContents: HTMLDivElement | undefined
  let refHiddenInput: HTMLInputElement

  let jsonRepairModalProps: JSONRepairModalProps | undefined = undefined

  createFocusTracker({
    onMount,
    onDestroy,
    getWindow: () => getWindow(refJsonEditor),
    hasFocus: () => (modalOpen && document.hasFocus()) || activeElementIsChildOf(refJsonEditor),
    onFocus: () => {
      hasFocus = true
      if (onFocus) {
        onFocus()
      }
    },
    onBlur: () => {
      hasFocus = false
      if (onBlur) {
        onBlur()
      }
    }
  })

  // `documentJson` is the document. `json` is what the table shows: the document, or the array at
  // `target` in it. Selection and document state follow `json`, history and onChange the document.
  // Invariant: getIn(documentJson, target) === json.
  let documentJson: unknown | undefined
  let target: JSONPath = tableTarget
  let json: unknown | undefined
  let text: string | undefined
  let parseError: ParseError | undefined = undefined

  let pastedJson: PastedJson | undefined
  let pastedMultilineText: string | undefined

  let searchResultDetails: SearchResultDetails | undefined
  let searchResults: SearchResults | undefined
  let showSearch = false
  let showReplace = false

  $: applySearchBoxSpacing(showSearch)

  function applySearchBoxSpacing(showSearch: boolean) {
    if (!refContents) {
      return
    }

    const offset = showSearch ? SEARCH_BOX_HEIGHT : -SEARCH_BOX_HEIGHT
    refContents.scrollTo({
      top: (refContents.scrollTop += offset),
      left: refContents.scrollLeft
    })
  }

  function handleSearch(result: SearchResultDetails | undefined) {
    searchResultDetails = result
    searchResults = searchResultDetails
      ? toRecursiveSearchResults(json, searchResultDetails.items)
      : undefined
  }

  async function handleFocusSearch(path: JSONPath) {
    selection = undefined // navigation path of current selection would be confusing
    await scrollTo(path)
  }

  function handleCloseSearch() {
    showSearch = false
    showReplace = false
    focus()
  }

  $: applyExternalContent(externalContent)
  $: applyExternalSelection(externalSelection)

  let maxSampleCount = 10_000
  let columns: JSONPath[] = []
  $: columns = isJSONArray(json)
    ? maintainColumnOrder(getColumns(json, flattenColumns, maxSampleCount), columns)
    : []

  let containsValidArray: boolean
  $: containsValidArray = !!(json && !isEmpty(columns))
  $: showRefreshButton = Array.isArray(json) && json.length > maxSampleCount
  // the gutter column, the data columns and the refresh column: the spacer rows must span all of
  // them, else the search box background stops short of the last column
  $: tableColumnCount = 1 + columns.length + (showRefreshButton ? 1 : 0)

  // modalOpen is true when one of the modals is open.
  // This is used to track whether the editor still has focus
  let modalOpen = false

  let hasFocus = false
  let copyPasteModalOpen = false

  let itemHeightsCache: Record<number, number> = {}

  let viewPortHeight = 600
  let scrollTop = 0
  let defaultItemHeight = 18 // px

  $: visibleSection = calculateVisibleSection(
    scrollTop,
    viewPortHeight,
    json,
    itemHeightsCache, // warning: itemHeightsCache is mutated and is not responsive itself
    defaultItemHeight,
    showSearch ? SEARCH_BOX_HEIGHT : 0
  )

  // Scrolling does not end editing: the row that is being edited stays rendered.
  let editingRowIndex: number | undefined
  $: editingRowIndex = isEditingSelection(selection)
    ? toTableCellPosition(getFocusPath(selection), columns).rowIndex
    : undefined

  // JsonGridder: the row that scrollTo goes to stays rendered on the way, so it is measured and its
  // element can be jumped to even when the heights of the rows above it are only estimates.
  let scrollTargetRowIndex: number | undefined

  $: renderedRows = keepRowRendered(
    visibleSection,
    json,
    editingRowIndex ?? scrollTargetRowIndex,
    itemHeightsCache, // warning: itemHeightsCache is mutated and is not responsive itself
    defaultItemHeight
  )

  $: refreshScrollTop(json)

  // JsonGridder: wrapping and dragged widths change the row heights of rows that are not rendered,
  // so the measured heights are stale. Rendered rows are measured again by their resize observer.
  $: forgetRowHeights($wrapLines, $columnWidths)

  function forgetRowHeights(..._layout: unknown[]) {
    itemHeightsCache = {}
  }

  $: widthOf = (column: JSONPath): number | undefined =>
    $columnWidths[columnWidthKey(tableTarget, column)]

  /** Drag the right edge of a column header. The header button never sees the press, so no sort. */
  function handleColumnResizeStart(event: MouseEvent, column: JSONPath) {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const header = (event.currentTarget as HTMLElement).closest('th')
    if (!header) {
      return
    }
    stopColumnResize()
    const key = columnWidthKey(tableTarget, column)
    const startX = event.clientX
    const startWidth = header.getBoundingClientRect().width
    const move = (moveEvent: MouseEvent) => {
      // the button was released where no mouseup reached us (outside the window): the drag is over
      if ((moveEvent.buttons & 1) === 0) {
        stop()
        return
      }
      setColumnWidth(key, startWidth + moveEvent.clientX - startX)
    }
    const end = (endEvent: MouseEvent) => {
      endEvent.preventDefault()
      endEvent.stopPropagation()
      setColumnWidth(key, startWidth + endEvent.clientX - startX)
      stop()
    }
    const stop = () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', end, true)
      window.removeEventListener('blur', stop)
      stopColumnResize = noop
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', end, true)
    window.addEventListener('blur', stop)
    stopColumnResize = stop
  }

  /** Ends a column drag: on mouseup, a move without the button, leaving the window, or destroy. */
  let stopColumnResize: () => void = noop
  onDestroy(() => stopColumnResize())

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function refreshScrollTop(_json: unknown | undefined) {
    // When the contents go from lots of items and scrollable contents to only a few items and
    // no vertical scroll, the actual scrollTop changes to 0 but there is no on:scroll event
    // triggered, so the internal scrollTop variable is not up-to-date.
    // This is a workaround to update the scrollTop by triggering an on:scroll event
    if (refContents) {
      refContents.scrollTo({
        top: refContents.scrollTop,
        left: refContents.scrollLeft
      })
    }
  }

  function handleSelect(updatedSelection: JSONSelection | undefined) {
    selection = updatedSelection
  }

  function handleLeaveEdit(path: JSONPath) {
    if (isEditingSelection(selection) && isEqual(getFocusPath(selection), path)) {
      selection = removeEditModeFromSelection(selection)

      // The editable element had the keyboard. When nothing else took the focus, the table takes
      // it back, else every key that follows goes nowhere while the cell looks selected.
      tick().then(() => {
        if (!document.activeElement || document.activeElement === document.body) {
          focus()
        }
      })
    }
  }

  function emitOnSelect(updatedSelection: JSONSelection | undefined) {
    if (!isEqual(updatedSelection, externalSelection)) {
      debug('onSelect', updatedSelection)
      onSelect(updatedSelection)
    }
  }

  $: emitOnSelect(selection)

  // The cell that the user tried to edit but that cannot get a value.
  let refusedCell: JSONPath | undefined = undefined

  /**
   * All ways to start editing a value end up in the selection: Enter, a double click, typing a
   * character. The editable element is rendered after this, so it never opens for a cell that
   * cannot get a value and no input can get lost in it.
   */
  function refuseEditingCell(current: JSONSelection | undefined) {
    if (isEditingSelection(current) && !canAddCellValue(json, getFocusPath(current))) {
      selection = removeEditModeFromSelection(current)
      refusedCell = getFocusPath(current)
    } else if (!isValueSelection(current) || !isEqual(current.path, refusedCell)) {
      refusedCell = undefined
    }
  }

  $: refuseEditingCell(selection)

  function clearSelectionWhenNotExisting(json: unknown | undefined) {
    if (!selection || json === undefined) {
      return
    }

    if (selectionExistsInDocument(json, selection)) {
      return
    }

    debug('clearing selection: path does not exist anymore', selection)
    selection = undefined // TODO: try find the closest cell that still exists (similar to getInitialSelection)
  }

  let documentState: DocumentState | undefined =
    json !== undefined ? createDocumentState({ json }) : undefined
  let selection: JSONSelection | undefined = isJSONSelection(externalSelection)
    ? externalSelection
    : undefined
  let sortedColumn: SortedColumn | undefined
  let textIsRepaired = false

  onMount(() => {
    if (selection) {
      scrollIntoView(getFocusPath(selection))
    }
  })

  function onSortByHeader(newSortedColumn: SortedColumn) {
    if (readOnly) {
      return
    }

    debug('onSortByHeader', newSortedColumn)

    const rootPath: JSONPath = []
    const direction = newSortedColumn.sortDirection === SortDirection.desc ? -1 : 1
    const operations = sortJson(json, rootPath, newSortedColumn.path, direction)
    handlePatch(operations, (_, patchedState) => {
      return {
        state: patchedState,
        sortedColumn: newSortedColumn
      }
    })
  }

  let context: JSONEditorContext
  $: context = {
    mode: Mode.table,
    readOnly,
    truncateTextSize,
    parser,
    normalization,
    getJson: () => json,
    getDocumentState: () => documentState,
    findElement,
    findNextInside,
    focus,
    onError,
    onPatch: patchCell,
    onSelect: handleSelect,
    onLeaveEdit: handleLeaveEdit,
    onFind: openFind,
    onPasteJson: handlePasteJson,
    onRenderValue
  }

  /**
   * Write to a cell. A table shows columns for keys that not every row has, so the key and its
   * parent objects may have to be created first.
   */
  function patchCell(operations: JSONPatchDocument, afterPatch?: AfterPatchCallback) {
    return handlePatch(createNestedValueOperations(operations, json), afterPatch)
  }

  /**
   * True when the selection is a cell that has no value: there is nothing to cut or remove.
   */
  function isEmptyCellSelected() {
    return isValueSelection(selection) && !pathExistsInDocument(json, selection.path)
  }

  /**
   * True when the selection is a cell that cannot get a value. Shows the reason.
   */
  function refuseSelectedCell(): boolean {
    if (isValueSelection(selection) && !canAddCellValue(json, selection.path)) {
      refusedCell = selection.path
      return true
    }

    return false
  }

  function isValidTarget(document: unknown): boolean {
    return (
      isEmpty(target) ||
      (pathExistsInDocument(document, target) && isJSONArray(getInDocument(document, target)))
    )
  }

  /** This view stays correct on its own: the parent recreates it later, outside the update. */
  function moveTarget(path: JSONPath, reason: TableTargetChange) {
    target = path
    queueMicrotask(() => {
      if (refJsonEditor?.isConnected) {
        onChangeTableTarget?.(path, reason)
      }
    })
  }

  /** A target that stopped being an array falls back to the whole document. Nothing is written. */
  function showDocument(document: unknown) {
    documentJson = document
    if (!isValidTarget(document)) {
      moveTarget([], 'invalid')
    }
    json = isEmpty(target) ? document : getInDocument(document, target)
  }

  function placeInDocument(tableJson: unknown): unknown {
    return isEmpty(target) ? tableJson : setIn(documentJson, target, tableJson)
  }

  function toDocumentOperations(
    operations: JSONPatchDocument,
    path: JSONPath = target
  ): JSONPatchDocument {
    if (isEmpty(path)) {
      return operations
    }

    const pointer = compileJSONPointer(path)
    return operations.map((operation) =>
      'from' in operation
        ? { ...operation, path: pointer + operation.path, from: pointer + operation.from }
        : { ...operation, path: pointer + operation.path }
    ) as JSONPatchDocument
  }

  function toTableOperations(operations: JSONPatchDocument): JSONPatchDocument {
    if (isEmpty(target)) {
      return operations
    }

    const pointer = compileJSONPointer(target)
    const toTable = (path: string) => {
      if (path !== pointer && !path.startsWith(pointer + '/')) {
        throw new Error('Cannot apply patch: the path is outside the table target')
      }
      return path.slice(pointer.length)
    }
    return operations.map((operation) =>
      'from' in operation
        ? { ...operation, path: toTable(operation.path), from: toTable(operation.from) }
        : { ...operation, path: toTable(operation.path) }
    ) as JSONPatchDocument
  }

  function applyExternalContent(content: Content) {
    const isChanged = isTextContent(content)
      ? content.text !== text
      : !isEqual(documentJson, content.json)

    debug('update external content', { isChanged })

    if (!isChanged) {
      // no actual change, don't do anything
      return
    }

    const previousState = {
      json: documentJson,
      documentState,
      selection,
      sortedColumn,
      text,
      textIsRepaired
    }

    if (isTextContent(content)) {
      try {
        showDocument(parseMemoizeOne(content.text))
        documentState = syncDocumentState(json, documentState)
        text = content.text
        textIsRepaired = false
        parseError = undefined
      } catch (err) {
        // no valid JSON, will show empty document or invalid json.
        // Repairing is an explicit action in text mode: it can change the contents
        showDocument(undefined)
        documentState = undefined
        text = content.text
        textIsRepaired = false
        parseError =
          text !== ''
            ? normalizeJsonParseError(text, (err as Error).message || String(err))
            : undefined
      }
    } else {
      showDocument(content.json)
      documentState = syncDocumentState(json, documentState)
      text = undefined
      textIsRepaired = false
      parseError = undefined
    }

    // make sure the selection is valid
    clearSelectionWhenNotExisting(json)

    // reset the sorting order (we don't know...)
    sortedColumn = undefined

    addHistoryItem(previousState)
  }

  function applyExternalSelection(externalSelection: JSONEditorSelection | undefined) {
    if (isEqual(selection, externalSelection)) {
      return
    }

    debug('applyExternalSelection', { selection, externalSelection })

    // The prop can still hold a selection of a previous document or of another view
    if (isJSONSelection(externalSelection) && selectionExistsInDocument(json, externalSelection)) {
      selection = externalSelection
    }
  }

  interface PreviousState {
    json: unknown | undefined
    text: string | undefined
    documentState: DocumentState | undefined
    selection: JSONSelection | undefined
    textIsRepaired: boolean
    sortedColumn: SortedColumn | undefined
  }

  function addHistoryItem(previous: PreviousState) {
    if (previous.json === undefined && previous.text === undefined) {
      // initialization -> do not create a history item
      return
    }

    const canPatch = documentJson !== undefined && previous.json !== undefined

    history.add({
      type: 'tree',
      tableTarget: target,
      undo: {
        patch: canPatch ? [{ op: 'replace', path: '', value: previous.json }] : undefined,
        json: previous.json,
        text: previous.text,
        documentState: previous.documentState,
        textIsRepaired: previous.textIsRepaired,
        selection: removeEditModeFromSelection(previous.selection),
        sortedColumn: previous.sortedColumn
      },
      redo: {
        patch: canPatch ? [{ op: 'replace', path: '', value: documentJson }] : undefined,
        json: documentJson,
        text,
        documentState,
        textIsRepaired,
        selection: removeEditModeFromSelection(selection),
        sortedColumn
      }
    })
  }

  let validationErrors: ValidationError[] = []
  $: updateValidationErrors(json, validator, parser, validationParser)
  $: groupedValidationErrors = groupValidationErrors(validationErrors, columns)

  // because onChange returns the validation errors and there is also a separate listener,
  // we would execute validation twice. Memoizing the last result solves this.
  const memoizedValidate = memoizeOne(validateJSON)

  function updateValidationErrors(
    json: unknown,
    validator: Validator | undefined,
    parser: JSONParser,
    validationParser: JSONParser
  ) {
    measure(
      () => {
        let newValidationErrors: ValidationError[]
        try {
          newValidationErrors = memoizedValidate(json, validator, parser, validationParser)
        } catch (err) {
          newValidationErrors = [
            {
              path: [],
              message: $t('failedToValidate') + (err as Error).message,
              severity: ValidationSeverity.warning
            }
          ]
        }

        if (!isEqual(newValidationErrors, validationErrors)) {
          debug('validationErrors changed:', newValidationErrors)
          validationErrors = newValidationErrors
        }
      },
      (duration) => debug(`validationErrors updated in ${duration} ms`)
    )
  }

  /**
   * Apply the value that is being edited. Closing the editable element applies it, whether or not
   * the window has focus. Only call this from outside an update: it uses flushSync.
   */
  export function commitEdit() {
    if (isEditingSelection(selection)) {
      flushSync() // typing that has just started: the editable element holds the first character
      selection = removeEditModeFromSelection(selection)
      flushSync()
    }
  }

  export function validate(): ContentErrors | undefined {
    debug('validate')

    if (parseError) {
      return {
        parseError,
        isRepairable: false // not applicable, if repairable, we will not have a parseError
      }
    }

    // make sure the validation results are up-to-date
    // normally, they are only updated on the next tick after the json is changed
    updateValidationErrors(json, validator, parser, validationParser)
    return !isEmpty(validationErrors) ? { validationErrors } : undefined
  }

  /** Operations and result are in document coordinates. The operations stay inside the target. */
  export function patch(
    operations: JSONPatchDocument,
    afterPatch?: AfterPatchCallback
  ): JSONPatchResult {
    const previousJson = documentJson
    const previousTarget = target
    const result = patchTable(toTableOperations(operations), afterPatch)

    return {
      json: documentJson,
      previousJson,
      undo: toDocumentOperations(result.undo, previousTarget),
      redo: operations
    }
  }

  /** The operations and the result are in the coordinates of `json`, the history in the document. */
  function patchTable(
    operations: JSONPatchDocument,
    afterPatch?: AfterPatchCallback
  ): JSONPatchResult {
    debug('patch', operations, afterPatch)

    if (json === undefined) {
      throw new Error('Cannot apply patch: no JSON')
    }

    const previousJson = json
    const previousState: PreviousState = {
      json: undefined, // not needed: we use patch to reconstruct the json
      text,
      documentState,
      selection: removeEditModeFromSelection(selection),
      sortedColumn,
      textIsRepaired
    }

    // execute the patch operations
    const undo: JSONPatchDocument = revertJSONPatchWithMoveOperations(
      json,
      operations
    ) as JSONPatchDocument
    const patched = documentStatePatch(json, documentState, operations)

    // Clear the sorted column when needed. We need to do this before `afterPatch`,
    // else we clear any changed made in the callback. It is a bit odd that
    // afterPatch does not receive the actual previousDocumentState. Better ideas?
    const patchedSortedColumn = clearSortedColumnWhenAffectedByOperations(
      sortedColumn,
      operations,
      columns
    )

    const callback =
      typeof afterPatch === 'function'
        ? afterPatch(patched.json, patched.documentState, selection)
        : undefined

    json = callback?.json !== undefined ? callback.json : patched.json
    documentJson = placeInDocument(json)
    documentState = callback?.state !== undefined ? callback.state : patched.documentState
    selection = callback?.selection !== undefined ? callback.selection : selection
    sortedColumn =
      callback?.sortedColumn !== undefined ? callback.sortedColumn : patchedSortedColumn
    text = undefined
    textIsRepaired = false
    pastedJson = undefined
    pastedMultilineText = undefined
    parseError = undefined

    history.add({
      type: 'tree',
      tableTarget: target,
      undo: {
        patch: toDocumentOperations(undo),
        ...previousState
      },
      redo: {
        patch: toDocumentOperations(operations),
        json: undefined, // not needed: we use patch to reconstruct the json
        text: undefined,
        documentState,
        selection: removeEditModeFromSelection(selection),
        sortedColumn,
        textIsRepaired
      }
    })

    const result = {
      json,
      previousJson,
      undo,
      redo: operations
    }

    // a transformation can replace the array with something else
    if (!isValidTarget(documentJson)) {
      showDocument(documentJson)
      documentState = syncDocumentState(json, undefined)
    }

    return result
  }

  function handlePatch(
    operations: JSONPatchDocument,
    afterPatch?: AfterPatchCallback
  ): JSONPatchResult {
    debug('handlePatch', operations, afterPatch)

    const refused = findRefusedKey(operations, parser)
    if (refused) {
      onError(refused)

      return { json, previousJson: json, undo: [], redo: [] }
    }

    if (json !== undefined && immutableJSONPatch(json, operations) === json) {
      // Nothing changes: no history item and no onChange. The selection can still move on.
      const callback =
        typeof afterPatch === 'function' ? afterPatch(json, documentState, selection) : undefined
      selection = callback?.selection !== undefined ? callback.selection : selection

      return { json, previousJson: json, undo: [], redo: [] }
    }

    const previousContent = { json: documentJson, text }
    // a result in the coordinates of the array would be taken for the document
    const documentCoordinates = isEmpty(target)
    const patchResult = patchTable(operations, afterPatch)

    emitOnChange(previousContent, documentCoordinates ? patchResult : undefined)

    return patchResult
  }

  function emitOnChange(previousContent: Content, patchResult: JSONPatchResult | undefined) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (previousContent.json === undefined && previousContent?.text === undefined) {
      // initialization -> do not fire an onChange event
      return
    }

    // make sure we cannot send an invalid contents like having both
    // json and text defined, or having none defined
    if (onChange) {
      if (text !== undefined) {
        const content = { text, json: undefined }
        onChange(content, previousContent, {
          contentErrors: validate(),
          patchResult
        })
      } else if (documentJson !== undefined) {
        const content = { text: undefined, json: documentJson }
        onChange(content, previousContent, {
          contentErrors: validate(),
          patchResult
        })
      }
    }
  }

  function handlePasteJson(newPastedJson: PastedJson) {
    debug('pasted json as text', newPastedJson)

    pastedJson = newPastedJson
  }

  function handlePasteMultilineText(pastedText: string) {
    debug('pasted multiline text', { pastedText })

    pastedMultilineText = pastedText
  }

  function findNextInside(path: JSONPath): JSONSelection {
    const index = parseInt(path[0], 10)
    const nextPath = [String(index + 1), ...path.slice(1)]

    // the next row may not have this key, its cell can be selected all the same
    return pathExistsInDocument(json, nextPath.slice(0, 1))
      ? createValueSelection(nextPath)
      : createValueSelection(path)
  }

  export function focus() {
    debug('focus')
    // with just .focus(), sometimes the input doesn't react on onpaste events
    // in Chrome when having a large document open and then doing cut/paste.
    // Calling both .focus() and .select() did solve this issue.
    // the input is positioned outside of the editor, so revealing it would
    // scroll a scrollable ancestor away from the contents the user clicked
    if (refHiddenInput) {
      refHiddenInput.focus({ preventScroll: true })
      refHiddenInput.select()
    }
  }

  function handleWindowMouseDown(event: MouseEvent & { currentTarget: EventTarget & Window }) {
    const outsideEditor = !isChildOf(
      event.target as Element,
      (element) => element === refJsonEditor
    )
    if (outsideEditor) {
      if (isEditingSelection(selection)) {
        debug('click outside the editor, exit edit mode')
        selection = removeEditModeFromSelection(selection)

        if (hasFocus && refHiddenInput) {
          refHiddenInput.focus({ preventScroll: true })
          refHiddenInput.blur()
        }

        debug('blur (outside editor)')
        if (refHiddenInput) {
          refHiddenInput.blur()
        }
      }
    }
  }

  function handleScroll(event: Event) {
    scrollTop = (event.target as HTMLElement)['scrollTop']
  }

  function isOnScrollbar(event: MouseEvent): boolean {
    if (!refContents || event.target !== refContents) {
      return false
    }

    const { clientWidth, clientHeight, offsetWidth, offsetHeight } = refContents
    const { left, top } = refContents.getBoundingClientRect()
    return (
      (offsetWidth > clientWidth && event.clientX - left >= clientWidth) ||
      (offsetHeight > clientHeight && event.clientY - top >= clientHeight)
    )
  }

  function handleMouseDown(event: MouseEvent) {
    // only handle when the left or right mouse button is pressed, not the middle mouse button (scroll wheel)
    if (event.buttons !== 1 && event.buttons !== 2) {
      return
    }

    const target = event.target as HTMLElement
    if (isEditingSelection(selection) && isOnScrollbar(event)) {
      // scrolling does not end editing: the scrollbar works, the focus stays where it is
      event.preventDefault()
      return
    }

    if (!target.isContentEditable) {
      focus()
    }

    const path = getDataPathFromTarget(target)
    if (path) {
      // when clicking inside the current selection, editing a value, do nothing
      if (isEditingSelection(selection) && pathInSelection(json, selection, path)) {
        return
      }

      selection = createValueSelection(path)

      event.preventDefault()
    }
  }

  function createDefaultSelection(): JSONSelection | undefined {
    if (isJSONArray(json) && !isEmpty(json) && !isEmpty(columns)) {
      // Select the first row, first column
      const path = ['0', ...columns[0]]

      return createValueSelection(path)
    } else {
      return undefined
    }
  }

  function createDefaultSelectionWhenUndefined() {
    if (!selection) {
      selection = createDefaultSelection()
    }
  }

  export function acceptAutoRepair() {
    if (textIsRepaired && json !== undefined) {
      const previousContent = { json: documentJson, text }
      const previousState = {
        json: documentJson,
        documentState,
        selection,
        sortedColumn,
        text,
        textIsRepaired
      }

      // json stays as is
      text = undefined
      textIsRepaired = false

      clearSelectionWhenNotExisting(json)

      addHistoryItem(previousState)

      // we could work out a patchResult, or use patch(), but only when the previous and new
      // contents are both json and not text. We go for simplicity and consistency here and
      // do _not_ return a patchResult ever.
      const patchResult = undefined

      emitOnChange(previousContent, patchResult)
    }

    return { json: documentJson, text }
  }

  /**
   * Scroll the window vertically to the node with given path.
   * Expand the path when needed.
   */
  export function scrollTo(path: JSONPath, options: ScrollToOptions = {}): Promise<void> {
    // JsonGridder: wrapped rows have different heights, so the position of a row that is not
    // rendered is only an estimate. Render the target row first (it is measured on the next frame)
    // and jump to its element.
    if (findElement(path) || !isJSONArray(json)) {
      return scrollToAttempt(path, options, 1)
    }
    const { rowIndex } = toTableCellPosition(path, columns)
    scrollTargetRowIndex = rowIndex
    flushSync()
    return nextFrame()
      .then(() => scrollToAttempt(path, options, 1))
      .finally(() => {
        if (scrollTargetRowIndex === rowIndex) {
          scrollTargetRowIndex = undefined
        }
      })
  }

  function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  // JsonGridder: rows measured on the way move the rows below them. After a jump, once the resize
  // observers have measured the rendered rows, check the target; when it is not in view, scroll
  // straight to it. Only the rows around it are rendered then, so it moves less each time.
  const MAX_SCROLL_ATTEMPTS = 6

  function isInView(path: JSONPath): boolean {
    const elem = findElement(path)
    if (!elem || !refContents) {
      return false
    }
    const viewPortRect = refContents.getBoundingClientRect()
    const elemRect = elem.getBoundingClientRect()
    return elemRect.bottom > viewPortRect.top && elemRect.top < viewPortRect.bottom
  }

  function finishScroll(path: JSONPath, offset: number, attempt: number, resolve: () => void) {
    // ensure the element is rendered now that it is scrolled into view
    flushSync()
    requestAnimationFrame(() => {
      const elem = findElement(path)
      if (!isInView(path) && attempt < MAX_SCROLL_ATTEMPTS) {
        if (elem && refContents) {
          refContents.scrollTop +=
            elem.getBoundingClientRect().top - refContents.getBoundingClientRect().top + offset
          finishScroll(path, offset, attempt + 1, resolve)
        } else {
          scrollToAttempt(path, {}, attempt + 1).then(resolve)
        }
        return
      }
      // TODO: improve horizontal scrolling: animate and integrate with the vertical scrolling (jump)
      scrollToHorizontal(path)
      resolve()
    })
  }

  function scrollToAttempt(
    path: JSONPath,
    { scrollToWhenVisible = true }: ScrollToOptions,
    attempt: number
  ): Promise<void> {
    const searchBoxHeight = showSearch ? SEARCH_BOX_HEIGHT : 0
    const top = calculateAbsolutePosition(path, columns, itemHeightsCache, defaultItemHeight)
    const roughDistance = top - scrollTop + searchBoxHeight + defaultItemHeight
    const elem = findElement(path)

    debug('scrollTo', { path, top, scrollTop, elem })

    if (!refContents) {
      return Promise.resolve()
    }

    const viewPortRect = refContents.getBoundingClientRect()
    if (elem && !scrollToWhenVisible) {
      const elemRect = elem.getBoundingClientRect()
      if (elemRect.bottom > viewPortRect.top && elemRect.top < viewPortRect.bottom) {
        // element is fully or partially visible, don't scroll to it
        return Promise.resolve()
      }
    }

    const offset = -Math.max(searchBoxHeight + 2 * defaultItemHeight, viewPortRect.height / 4)

    if (elem) {
      return new Promise((resolve) => {
        jump(elem, {
          container: refContents,
          offset,
          duration: SCROLL_DURATION,
          callback: () => finishScroll(path, offset, attempt, resolve)
        })
      })
    } else {
      return new Promise((resolve) => {
        jump(roughDistance, {
          container: refContents,
          offset,
          duration: SCROLL_DURATION,
          callback: () => finishScroll(path, offset, attempt, resolve)
        })
      })
    }
  }

  function scrollToVertical(path: JSONPath) {
    if (!refContents) {
      return
    }

    const { rowIndex } = toTableCellPosition(path, columns)
    const top = calculateAbsolutePosition(path, columns, itemHeightsCache, defaultItemHeight)
    const bottom = top + (itemHeightsCache[rowIndex] || defaultItemHeight)

    const headerHeight = defaultItemHeight
    const viewPortRect = refContents.getBoundingClientRect()
    const viewPortTop = scrollTop
    const viewPortBottom = scrollTop + viewPortRect.height - headerHeight

    if (bottom > viewPortBottom) {
      const diff = bottom - viewPortBottom
      refContents.scrollTop += diff
    }

    if (top < viewPortTop) {
      const diff = viewPortTop - top
      refContents.scrollTop -= diff
    }
  }

  function scrollToHorizontal(path: JSONPath) {
    const elem = findElement(path)
    if (!elem || !refContents) {
      return
    }

    const viewPortRect = refContents.getBoundingClientRect()
    const elemRect = elem.getBoundingClientRect() // TODO: scroll to column instead of item (is always rendered)

    if (elemRect.right > viewPortRect.right) {
      const diff = elemRect.right - viewPortRect.right
      refContents.scrollLeft += diff
    }

    if (elemRect.left < viewPortRect.left) {
      const diff = viewPortRect.left - elemRect.left
      refContents.scrollLeft -= diff
    }
  }

  function scrollIntoView(path: JSONPath) {
    scrollToVertical(path)
    scrollToHorizontal(path)
  }

  /**
   * Only the rows in view are rendered, so a row that was scrolled away has no cell that can take
   * the input. Bring it back before editing starts. The scroll event comes too late for the next
   * key: the rendered rows follow from scrollTop, so that is updated here.
   */
  function revealSelectedRow() {
    if (!selection || !refContents) {
      return
    }

    const path = getFocusPath(selection)
    const { rowIndex } = toTableCellPosition(path, columns)
    if (rowIndex < visibleSection.startIndex || rowIndex >= visibleSection.endIndex) {
      scrollToVertical(path)
      scrollTop = refContents.scrollTop
    }
  }

  /**
   * Find the DOM element of a given path.
   * Note that the path can only be found when the node is expanded.
   */
  export function findElement(path: JSONPath): Element | undefined {
    const column = columns.find((c) => pathStartsWith(path.slice(1), c))

    const resolvedPath = column ? path.slice(0, 1).concat(column) : path

    return (
      refContents?.querySelector(`td[data-path="${encodeDataPath(resolvedPath)}"]`) ?? undefined
    )
  }

  function openContextMenu({
    anchor,
    left,
    top,
    width,
    height,
    offsetTop,
    offsetLeft,
    showTip
  }: AbsolutePopupOptions) {
    const defaultItems: ContextMenuItem[] = createTableContextMenuItems({
      json,
      documentState,
      selection,
      readOnly,

      onEditValue: handleEditValue,
      onEditRow: handleEditRow,
      onToggleEnforceString: handleToggleEnforceString,

      onCut: handleCut,
      onCopy: handleCopy,
      onPaste: handlePasteFromMenu,

      onRemove: handleRemove,
      onDuplicateRow: handleDuplicateRow,
      onInsertBeforeRow: handleInsertBeforeRow,
      onInsertAfterRow: handleInsertAfterRow,
      onRemoveRow: handleRemoveRow
    })

    const items = onRenderContextMenu(defaultItems) ?? defaultItems

    if (items === false) {
      return
    }

    const props = {
      tip: showTip ? $t('tipContextMenu') : undefined,
      items,
      onRequestClose: function () {
        closeAbsolutePopup(popupId)
        focus()
      }
    }

    const options = {
      left,
      top,
      offsetTop,
      offsetLeft,
      width,
      height,
      anchor,
      closeOnOuterClick: true,
      onClose: () => {
        modalOpen = false
        focus()
      }
    }

    modalOpen = true

    const popupId = openAbsolutePopup(ContextMenu, props, options)
  }

  function handleContextMenu(event: Event) {
    if (isEditingSelection(selection)) {
      return
    }

    if (event) {
      event.stopPropagation()
      event.preventDefault()
    }

    if (event && event.type === 'contextmenu' && event.target !== refHiddenInput) {
      // right mouse click to open context menu
      openContextMenu({
        left: (event as MouseEvent).clientX,
        top: (event as MouseEvent).clientY,
        width: CONTEXT_MENU_WIDTH,
        height: CONTEXT_MENU_HEIGHT,
        showTip: false
      })
    } else {
      // type === 'keydown' (from the quick key Ctrl+Q)
      // or target is hidden input -> context menu button on keyboard
      const anchor = refContents?.querySelector('.jse-table-cell.jse-selected-value')
      if (anchor) {
        openContextMenu({
          anchor,
          offsetTop: 2,
          width: CONTEXT_MENU_WIDTH,
          height: CONTEXT_MENU_HEIGHT,
          showTip: false
        })
      } else {
        // fallback on just displaying the TreeContextMenu top left
        const rect = refContents?.getBoundingClientRect()
        if (rect) {
          openContextMenu({
            top: rect.top + 2,
            left: rect.left + 2,
            width: CONTEXT_MENU_WIDTH,
            height: CONTEXT_MENU_HEIGHT,
            showTip: false
          })
        }
      }
    }
  }

  function handleContextMenuFromTableMenu(event: MouseEvent) {
    openContextMenu({
      anchor: findParentWithNodeName(event.target as HTMLElement, 'BUTTON'),
      offsetTop: 0,
      width: CONTEXT_MENU_WIDTH,
      height: CONTEXT_MENU_HEIGHT,
      showTip: true
    })
  }

  function handleEditValue() {
    if (readOnly || !selection) {
      return
    }

    const path = getFocusPath(selection)
    const value = getInDocument(json, path)
    if (isObjectOrArray(value)) {
      openJSONEditorModal(path)
    } else {
      selection = createValueSelection(path)
    }
  }

  function handleEditRow() {
    if (readOnly || !selection) {
      return
    }

    const path = getFocusPath(selection)
    const pathRow = path.slice(0, 1)
    openJSONEditorModal(pathRow)
  }

  function handleToggleEnforceString() {
    if (readOnly || !isValueSelection(selection)) {
      return
    }

    const path = selection.path
    const pointer = compileJSONPointer(path)
    const value = getInDocument(json, path)
    const enforceString = !getEnforceString(json, documentState, path)
    const updatedValue = enforceString ? String(value) : stringConvert(String(value), parser)

    debug('handleToggleEnforceString', { enforceString, value, updatedValue })

    handlePatch(
      [
        {
          op: 'replace',
          path: pointer,
          value: updatedValue
        }
      ],
      (_, patchedState) => {
        return {
          state: setInDocumentState(json, patchedState, path, { type: 'value', enforceString })
        }
      }
    )
  }

  async function handleParsePastedJson() {
    debug('apply pasted json', pastedJson)
    if (!pastedJson) {
      return
    }

    const { onPasteAsJson } = pastedJson
    onPasteAsJson()

    // TODO: get rid of the setTimeout here
    setTimeout(focus)
  }

  async function handlePasteFromMenu() {
    let clipboardText: string
    try {
      clipboardText = await navigator.clipboard.readText()
    } catch (err) {
      console.error(err)

      copyPasteModalOpen = true
      return
    }

    _paste(clipboardText)
  }

  async function handleParsePastedMultilineText() {
    debug('apply pasted multiline text', pastedMultilineText)
    if (!pastedMultilineText) {
      return
    }

    _paste(JSON.stringify(pastedMultilineText))

    // TODO: get rid of the setTimeout here
    setTimeout(focus)
  }

  function handleClearPastedJson() {
    debug('clear pasted json')
    pastedJson = undefined
    focus()
  }

  function handleClearPastedMultilineText() {
    debug('clear pasted multiline text')
    pastedMultilineText = undefined
    focus()
  }

  function handleRequestRepair() {
    onChangeMode(Mode.text)
  }

  function handleCut(indent: boolean) {
    if (isEmptyCellSelected()) {
      return
    }

    onCut({
      json,
      selection,
      indentation: indent ? indentation : undefined,
      readOnly,
      parser,
      onPatch: handlePatch
    }).catch(onError)
  }

  function handleCopy(indent = true) {
    if (json === undefined) {
      return
    }

    onCopy({
      json,
      selection,
      indentation: indent ? indentation : undefined,
      parser
    }).catch(onError)
  }

  function handleRemove() {
    if (isEmptyCellSelected()) {
      return
    }

    onRemove({
      json,
      text,
      selection,
      keepSelection: true,
      readOnly,
      onChange,
      onPatch: handlePatch
    })
  }

  function handleExtract(path: JSONPath) {
    if (readOnly || !allowExtract) {
      return
    }

    debug('extract', { path })

    const operations = extract(json, createValueSelection(path))

    handlePatch(operations)
  }

  function handleDuplicateRow() {
    onDuplicateRow({ json, selection, columns, readOnly, onPatch: handlePatch })
  }

  function handleInsertBeforeRow() {
    onInsertBeforeRow({ json, selection, columns, readOnly, onPatch: handlePatch })
  }

  function handleInsertAfterRow() {
    onInsertAfterRow({ json, selection, columns, readOnly, onPatch: handlePatch })
  }

  function handleRemoveRow() {
    onRemoveRow({ json, selection, columns, readOnly, onPatch: handlePatch })
  }

  function handleInsertCharacter(char: string) {
    if (!readOnly && refuseSelectedCell()) {
      return
    }

    revealSelectedRow()

    onInsertCharacter({
      char,
      selectInside: false,
      json,
      selection: selection,
      readOnly,
      parser,
      onPatch: patchCell,
      onReplaceJson: handleReplaceJson,
      onSelect: handleSelect
    }).catch(onError)
  }

  function handleKeyDown(event: KeyboardEvent) {
    const combo = keyComboFromEvent(event)
    debug('keydown', { combo, key: event.key })

    if (combo === 'Ctrl+X') {
      // cut formatted
      event.preventDefault()
      handleCut(true)
    }
    if (combo === 'Ctrl+Shift+X') {
      // cut compact
      event.preventDefault()
      handleCut(false)
    }
    if (combo === 'Ctrl+C') {
      // copy formatted
      event.preventDefault()
      handleCopy(true)
    }
    if (combo === 'Ctrl+Shift+C') {
      // copy compact
      event.preventDefault()
      handleCopy(false)
    }
    // Note: Ctrl+V (paste) is handled by the on:paste event

    if (combo === 'Ctrl+D') {
      event.preventDefault()
      handleDuplicateRow()
    }
    if (combo === 'Delete' || combo === 'Backspace') {
      event.preventDefault()
      handleRemove()
    }
    if (combo === 'Insert') {
      event.preventDefault()
      // TODO: implement insert
    }
    if (combo === 'Ctrl+A') {
      event.preventDefault()
      // selection = selectAll()
      // TODO: implement select all
    }

    if (combo === 'Ctrl+Q') {
      handleContextMenu(event)
    }

    if (combo === 'ArrowLeft') {
      event.preventDefault()

      createDefaultSelectionWhenUndefined()

      if (selection) {
        const newSelection = selectPreviousColumn(columns, selection)
        selection = newSelection
        scrollIntoView(getFocusPath(newSelection))
      }
    }

    if (combo === 'ArrowRight') {
      event.preventDefault()

      createDefaultSelectionWhenUndefined()

      if (selection) {
        const newSelection = selectNextColumn(columns, selection)
        selection = newSelection
        scrollIntoView(getFocusPath(newSelection))
      }
    }

    if (combo === 'ArrowUp') {
      event.preventDefault()

      createDefaultSelectionWhenUndefined()

      if (selection) {
        const newSelection = selectPreviousRow(columns, selection)
        selection = newSelection
        scrollIntoView(getFocusPath(newSelection))
      }
    }

    if (combo === 'ArrowDown') {
      event.preventDefault()

      createDefaultSelectionWhenUndefined()

      if (selection) {
        const newSelection = selectNextRow(json, columns, selection)
        selection = newSelection
        scrollIntoView(getFocusPath(newSelection))
      }
    }

    if (combo === 'Enter' && selection) {
      if (isValueSelection(selection)) {
        event.preventDefault()

        const path = selection.path
        const value = getInDocument(json, path)
        if (isObjectOrArray(value)) {
          // edit nested object/array
          openJSONEditorModal(path)
        } else {
          if (!readOnly) {
            // go to value edit mode
            revealSelectedRow()
            selection = { ...selection, edit: true }
          }
        }
      }
    }

    const normalizedCombo = combo.replace(/^Shift\+/, '') // replace 'Shift+A' with 'A'
    if (normalizedCombo.length === 1 && selection) {
      // a regular key like a, A, _, etc is entered.
      // Replace selected contents with a new value having this first character as text
      event.preventDefault()
      handleInsertCharacter(event.key)
      return
    }

    if (combo === 'Ctrl+Enter' && isValueSelection(selection)) {
      event.preventDefault()

      const value = getInDocument(json, selection.path)

      if (isUrl(value)) {
        // open url in new page
        window.open(String(value), '_blank')
      }
    }

    if (combo === 'Escape' && selection) {
      event.preventDefault()
      selection = undefined
    }

    if (combo === 'Ctrl+F') {
      event.preventDefault()
      openFind(false)
    }

    if (combo === 'Ctrl+H') {
      event.preventDefault()
      openFind(true)
    }

    if (combo === 'Ctrl+Z') {
      event.preventDefault()

      handleUndo()
    }

    if (combo === 'Ctrl+Shift+Z' || combo === 'Ctrl+Y') {
      event.preventDefault()

      handleRedo()
    }
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault()

    const clipboardText = event.clipboardData?.getData('text/plain')

    _paste(clipboardText)
  }

  function _paste(clipboardText: string | undefined) {
    if (clipboardText === undefined || (!readOnly && refuseSelectedCell())) {
      return
    }

    onPaste({
      clipboardText,
      json,
      selection,
      readOnly,
      parser,
      onPatch: patchCell,
      onChangeText: handleChangeText,
      onPasteMultilineText: handlePasteMultilineText,
      openRepairModal
    })
  }

  // TODO: this function is duplicated from TreeMode. See if we can reuse the code instead
  function handleReplaceJson(updatedJson: unknown, afterPatch?: AfterPatchCallback) {
    if (!isEmpty(target)) {
      // the value replaces the array that is shown, not the document
      handlePatch([{ op: 'replace', path: '', value: updatedJson }], afterPatch)
      return
    }

    const previousContent = { json: documentJson, text }
    const previousState = {
      json: documentJson,
      documentState,
      selection,
      sortedColumn,
      text,
      textIsRepaired
    }

    const updatedState = syncDocumentState(updatedJson, documentState)

    const callback =
      typeof afterPatch === 'function'
        ? afterPatch(updatedJson, updatedState, selection)
        : undefined

    json = callback?.json !== undefined ? callback.json : updatedJson
    documentJson = json
    documentState = callback?.state !== undefined ? callback.state : updatedState
    selection = callback?.selection !== undefined ? callback.selection : selection
    sortedColumn = undefined // we can't know whether the new json is still sorted or not
    text = undefined
    textIsRepaired = false
    parseError = undefined

    // make sure the selection is valid
    clearSelectionWhenNotExisting(json)

    addHistoryItem(previousState)

    // we could work out a patchResult, or use patch(), but only when the previous and new
    // contents are both json and not text. We go for simplicity and consistency here and
    // do _not_ return a patchResult ever.
    const patchResult = undefined

    emitOnChange(previousContent, patchResult)
  }

  // TODO: this function is duplicated from TreeMode. See if we can reuse the code instead
  function handleChangeText(updatedText: string, afterPatch?: AfterPatchCallback) {
    debug('handleChangeText')

    const previousContent = { json: documentJson, text }
    const previousState = {
      json: documentJson,
      documentState,
      selection,
      sortedColumn,
      text,
      textIsRepaired
    }

    // the text is the whole document
    if (!isEmpty(target)) {
      moveTarget([], 'invalid')
    }

    try {
      json = parseMemoizeOne(updatedText)
      documentState = syncDocumentState(json, documentState)
      text = undefined
      textIsRepaired = false
      parseError = undefined
    } catch (err) {
      // no valid JSON, will show empty document or invalid json
      json = undefined
      documentState = undefined
      text = updatedText
      textIsRepaired = false
      parseError =
        text !== ''
          ? normalizeJsonParseError(text, (err as Error).message || String(err))
          : undefined
    }

    if (typeof afterPatch === 'function') {
      const callback = afterPatch(json, documentState, selection)

      json = callback?.json !== undefined ? callback.json : json
      documentState = callback?.state !== undefined ? callback.state : documentState
      selection = callback?.selection !== undefined ? callback.selection : selection
    }

    documentJson = json

    // ensure the selection is valid
    clearSelectionWhenNotExisting(json)

    addHistoryItem(previousState)

    // no JSON patch actions available in text mode
    const patchResult = undefined

    emitOnChange(previousContent, patchResult)
  }

  function handleSelectValidationError(error: ValidationError) {
    debug('select validation error', error)

    selection = createValueSelection(error.path)

    scrollTo(error.path)
  }

  function openSortModal(rootPath: JSONPath) {
    if (readOnly || json === undefined) {
      return
    }

    modalOpen = true

    onSortModal({
      id: sortModalId,
      json,
      rootPath,
      onSort: ({ operations, itemPath, direction }) => {
        debug('onSort', operations, rootPath, itemPath, direction)

        handlePatch(operations, (_, patchedState) => {
          return {
            state: patchedState,
            sortedColumn: {
              path: itemPath,
              sortDirection: direction === -1 ? SortDirection.desc : SortDirection.asc
            }
          }
        })
      },
      onClose: () => {
        modalOpen = false
        setTimeout(focus)
      }
    })
  }

  /**
   * This method is exposed via JSONEditor.transform
   */
  export function openTransformModal(options: TransformModalOptions) {
    if (json === undefined) {
      return
    }

    const { id, onTransform, onClose } = options
    const rootPath = options.rootPath || []

    modalOpen = true

    onTransformModal({
      id: id || transformModalId,
      json,
      rootPath: rootPath || [],
      onTransform: (operations) => {
        if (onTransform) {
          onTransform({
            operations,
            json: json,
            transformedJson: immutableJSONPatch(json, operations)
          })
        } else {
          debug('onTransform', rootPath, operations)

          handlePatch(operations)
        }
      },
      onClose: () => {
        modalOpen = false
        setTimeout(focus)
        if (onClose) {
          onClose()
        }
      }
    })
  }

  function openJSONEditorModal(path: JSONPath) {
    debug('openJSONEditorModal', { path })

    modalOpen = true

    // open a popup where you can edit the nested object/array
    onJSONEditorModal({
      content: {
        json: getInDocument(json, path)
      },
      path,
      onPatch: handlePatch,
      onClose: () => {
        modalOpen = false
        setTimeout(focus)
      }
    })
  }

  function openRepairModal(text: string, onApply: (repairedText: string) => void) {
    jsonRepairModalProps = {
      text,
      onParse: (text) => parsePartialJson(text, (t) => parseAndRepair(t, parser)),
      onRepair: repairPartialJson,
      onApply,
      onClose: focus
    }
  }

  function handleSortAll() {
    const rootPath: JSONPath = []
    openSortModal(rootPath)
  }

  function handleTransformAll() {
    openTransformModal({
      rootPath: []
    })
  }

  function openFind(findAndReplace: boolean): void {
    debug('openFind', { findAndReplace })

    showSearch = false
    showReplace = false

    flushSync()

    // trick to make sure the focus goes to the search box
    showSearch = true
    showReplace = findAndReplace
  }

  /** History is in document coordinates. An edit of another array does not go back unseen. */
  function showHistoryDocument(
    item: TreeHistoryItem,
    step: { patch: JSONPatchDocument | undefined; json: unknown }
  ) {
    const document = step.patch ? immutableJSONPatch(documentJson, step.patch) : step.json

    if (item.tableTarget && !isEqual(item.tableTarget, target)) {
      moveTarget(item.tableTarget, 'history')
    }
    showDocument(document)
  }

  function handleUndo() {
    if (readOnly) {
      return
    }

    if (!history.canUndo) {
      return
    }

    const item = history.undo()
    if (!isTreeHistoryItem(item)) {
      onUndo(item)
      return
    }

    const previousContent = { json: documentJson, text }

    showHistoryDocument(item, item.undo)
    documentState = item.undo.documentState
    selection = item.undo.selection
    sortedColumn = item.undo.sortedColumn
    text = item.undo.text
    textIsRepaired = item.undo.textIsRepaired
    parseError = undefined

    debug('undo', { item, json })

    const patchResult =
      item.undo.patch && item.redo.patch
        ? {
            json: documentJson,
            previousJson: previousContent.json,
            redo: item.undo.patch,
            undo: item.redo.patch
          }
        : undefined

    emitOnChange(previousContent, patchResult)

    focus()
    if (selection) {
      scrollTo(getFocusPath(selection), { scrollToWhenVisible: false })
    }
  }

  function handleRedo() {
    if (readOnly) {
      return
    }

    if (!history.canRedo) {
      return
    }

    const item = history.redo()
    if (!isTreeHistoryItem(item)) {
      onRedo(item)
      return
    }

    const previousContent = { json: documentJson, text }

    showHistoryDocument(item, item.redo)
    documentState = item.redo.documentState
    selection = item.redo.selection
    sortedColumn = item.redo.sortedColumn
    text = item.redo.text
    textIsRepaired = item.redo.textIsRepaired
    parseError = undefined

    debug('redo', { item, json })

    const patchResult =
      item.undo.patch && item.redo.patch
        ? {
            json: documentJson,
            previousJson: previousContent.json,
            redo: item.redo.patch,
            undo: item.undo.patch
          }
        : undefined

    emitOnChange(previousContent, patchResult)

    focus()
    if (selection) {
      scrollTo(getFocusPath(selection), { scrollToWhenVisible: false })
    }
  }

  function handleResizeContents(element: Element) {
    viewPortHeight = element.getBoundingClientRect().height
  }

  function handleResizeRow(element: Element, rowIndex: number) {
    itemHeightsCache[rowIndex] = element.getBoundingClientRect().height
  }
</script>

<svelte:window on:mousedown={handleWindowMouseDown} />

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<div
  role="table"
  aria-label={ariaLabel}
  class="jse-table-mode"
  class:no-main-menu={!mainMenuBar}
  class:jse-wrap-lines={$wrapLines}
  on:mousedown={handleMouseDown}
  on:keydown={handleKeyDown}
  on:contextmenu={handleContextMenu}
  bind:this={refJsonEditor}
>
  {#if mainMenuBar}
    <TableMenu
      {containsValidArray}
      {readOnly}
      bind:showSearch
      {history}
      onSort={handleSortAll}
      onTransform={handleTransformAll}
      onUndo={handleUndo}
      onRedo={handleRedo}
      onContextMenu={handleContextMenuFromTableMenu}
      {onRenderMenu}
    />
  {/if}

  {#if !isSSR}
    <label class="jse-hidden-input-label">
      <!-- an off-screen input to capture paste and hold focus; it carries no
           content of its own, so hide it from assistive technologies -->
      <input
        type="text"
        readonly={true}
        tabindex="-1"
        aria-hidden="true"
        class="jse-hidden-input"
        bind:this={refHiddenInput}
        on:paste={handlePaste}
      />
    </label>
    {#if containsValidArray}
      <div class="jse-search-box-container">
        <SearchBox
          {json}
          {documentState}
          {parser}
          {showSearch}
          {showReplace}
          {readOnly}
          {columns}
          onSearch={handleSearch}
          onFocus={handleFocusSearch}
          onPatch={handlePatch}
          onClose={handleCloseSearch}
          onUndo={handleUndo}
          onRedo={handleRedo}
        />
      </div>
      <div
        class="jse-contents"
        bind:this={refContents}
        use:resizeObserver={handleResizeContents}
        on:scroll={handleScroll}
      >
        <table class="jse-table-main">
          <tbody>
            <tr class="jse-table-row jse-table-row-header">
              <th class="jse-table-cell jse-table-cell-header">
                {#if !isEmpty(groupedValidationErrors?.root)}
                  {@const validationError = mergeValidationErrors(
                    [],
                    groupedValidationErrors?.root
                  )}
                  {#if validationError}
                    <div class="jse-table-root-error">
                      <ValidationErrorIcon {validationError} onExpand={noop} />
                    </div>
                  {/if}
                {/if}
              </th>
              {#each columns as column}
                {@const width = widthOf(column)}
                <th
                  class="jse-table-cell jse-table-cell-header"
                  class:jse-column-sized={width !== undefined}
                  style:--jse-column-width={width !== undefined ? width + 'px' : undefined}
                >
                  <ColumnHeader path={column} {sortedColumn} {readOnly} onSort={onSortByHeader} />
                  <!-- svelte-ignore a11y-no-static-element-interactions -->
                  <div
                    class="jse-column-resizer"
                    aria-hidden="true"
                    on:mousedown={(event) => handleColumnResizeStart(event, column)}
                  ></div>
                </th>
              {/each}
              {#if showRefreshButton}
                <th class="jse-table-cell jse-table-cell-header">
                  <RefreshColumnHeader
                    count={Array.isArray(json) ? json.length : 0}
                    {maxSampleCount}
                    {readOnly}
                    onRefresh={() => (maxSampleCount = Infinity)}
                  />
                </th>
              {/if}
            </tr>
            <tr
              class="jse-table-invisible-start-section"
              class:jse-search-box-background={showSearch}
            >
              <td style:height={renderedRows.startHeight + 'px'} colspan={tableColumnCount}></td>
            </tr>
            {#each renderedRows.rows as { rowIndex, item, spacerBefore } (rowIndex)}
              {#if spacerBefore > 0}
                <tr class="jse-table-invisible-start-section">
                  <td style:height={spacerBefore + 'px'} colspan={tableColumnCount}></td>
                </tr>
              {/if}
              {@const validationErrorsByRow = groupedValidationErrors.rows[rowIndex]}
              {@const validationError = mergeValidationErrors(
                [String(rowIndex)],
                validationErrorsByRow?.row
              )}
              {@const searchResultByRow = getInRecursiveState(json, searchResults, [
                String(rowIndex)
              ])}
              <tr class="jse-table-row">
                {#key rowIndex}
                  <th
                    class="jse-table-cell jse-table-cell-gutter"
                    use:resizeObserver={(element) => handleResizeRow(element, rowIndex)}
                  >
                    {rowIndex}
                    {#if validationError}
                      <ValidationErrorIcon {validationError} onExpand={noop} />
                    {/if}
                  </th>
                {/key}
                {#each columns as column, columnIndex}
                  {@const path = [String(rowIndex)].concat(column)}
                  {@const value = getCellValue(item, column)}
                  {@const isSelected =
                    isValueSelection(selection) &&
                    (isEqual(selection.path, path) ||
                      (isObjectOrArray(value) && pathStartsWith(selection.path, path)))}
                  {@const validationErrorsByColumn = validationErrorsByRow?.columns[columnIndex]}
                  {@const validationError = mergeValidationErrors(path, validationErrorsByColumn)}
                  {@const width = widthOf(column)}
                  <td
                    class="jse-table-cell"
                    class:jse-column-sized={width !== undefined}
                    style:--jse-column-width={width !== undefined ? width + 'px' : undefined}
                    data-path={encodeDataPath(path)}
                  >
                    <div class="jse-value-outer" class:jse-selected-value={isSelected}>
                      {#if isObjectOrArray(value)}
                        {@const searchResultsByCell = flattenSearchResults(
                          getInRecursiveState(item, searchResultByRow, column)
                        )}

                        {@const containsActiveSearchResult = searchResultsByCell
                          ? searchResultsByCell.some((item) => item.active)
                          : false}

                        <InlineValue
                          {path}
                          {value}
                          {parser}
                          {isSelected}
                          containsSearchResult={!isEmpty(searchResultsByCell)}
                          {containsActiveSearchResult}
                          onEdit={openJSONEditorModal}
                        />{:else}
                        {@const searchResultItemsByCell = getInRecursiveState(
                          json,
                          searchResults,
                          path
                        )?.searchResults}

                        <JSONValue
                          {path}
                          value={value !== undefined ? value : ''}
                          enforceString={getEnforceString(json, documentState, path)}
                          selection={isSelected ? selection : undefined}
                          searchResultItems={searchResultItemsByCell}
                          {context}
                        />{/if}{#if !readOnly && isSelected && !isEditingSelection(selection)}
                        <div class="jse-context-menu-anchor">
                          <ContextMenuPointer selected={true} onContextMenu={openContextMenu} />
                        </div>
                      {/if}
                    </div>
                    {#if validationError}
                      <ValidationErrorIcon {validationError} onExpand={noop} />
                    {/if}
                  </td>
                {/each}
                {#if showRefreshButton}
                  <td class="jse-table-cell"></td>
                {/if}
              </tr>
            {/each}

            <tr class="jse-table-invisible-end-section">
              <td style:height={renderedRows.endHeight + 'px'} colspan={tableColumnCount}></td>
            </tr>
          </tbody>
        </table>
      </div>

      {#if refusedCell}
        <div class="jse-cell-notice">
          <Message type="info" message={$t('cellCannotAddKey')} />
        </div>
      {/if}

      {#if pastedJson}
        <Message
          type="info"
          message={$t('YouPastedAJsonMessage', {
            content: Array.isArray(pastedJson.contents) ? $t('typeArray') : $t('typeObject')
          })}
          actions={[
            {
              icon: faWrench,
              text: $t('pasteAsJson'),
              title: $t('pastTextAsJson'),
              // We use mousedown here instead of click: this message pops up
              // whilst the user is editing a value. When clicking this button,
              // the actual value is applied and the event is not propagated
              // and an onClick on this button never happens.
              onMouseDown: handleParsePastedJson
            },
            {
              text: $t('leaveAsIs'),
              title: $t('keepAsSingleValue'),
              onClick: handleClearPastedJson
            }
          ]}
        />
      {/if}

      {#if pastedMultilineText}
        <Message
          type="info"
          message={$t('multilineTextPastedMessage')}
          actions={[
            {
              icon: faWrench,
              text: $t('pasteAsStringInstead'),
              title: $t('pastSingleString'),
              onClick: handleParsePastedMultilineText
            },
            {
              text: $t('leaveAsIs'),
              title: $t('keepThePastedArray'),
              onClick: handleClearPastedMultilineText
            }
          ]}
        />
      {/if}

      {#if textIsRepaired}
        <Message
          type="success"
          message={$t('textRepairedSuccessMessage')}
          actions={!readOnly
            ? [
                {
                  icon: faCheck,
                  text: $t('Ok'),
                  title: $t('acceptRepairedDocument'),
                  onClick: acceptAutoRepair
                },
                {
                  icon: faCode,
                  text: $t('repairManually'),
                  title: $t('leaveTheDocUnchanged'),
                  onClick: handleRequestRepair
                }
              ]
            : []}
          onClose={focus}
        />
      {/if}

      <ValidationErrorsOverview {validationErrors} selectError={handleSelectValidationError} />
    {:else if parseError && text !== undefined && text !== ''}
      <Message
        type="error"
        message={$t('invalidJsonNotRepairable')}
        actions={!readOnly
          ? [
              {
                icon: faCode,
                text: $t('repairManually'),
                title: $t('manuallyRepairWithCodeModeText'),
                onClick: handleRequestRepair
              }
            ]
          : []}
      />
      <JSONPreview {text} {json} {indentation} {parser} />
    {:else}
      <TableModeWelcome
        {text}
        {json}
        {readOnly}
        {allowExtract}
        {parser}
        openJSONEditorModal={onChangeTableTarget && isEmpty(target)
          ? (path) => moveTarget(path, 'welcome')
          : openJSONEditorModal}
        extractPath={handleExtract}
        {onChangeMode}
        onClick={() => {
          // FIXME: this is a workaround for the editor not putting the focus on refHiddenInput
          //  when clicking in the welcome screen so you cannot paste a document from clipboard.
          focus()
        }}
      />
    {/if}
  {:else}
    <div class="jse-contents jse-contents-loading">
      <div class="jse-loading-space"></div>
      <div class="jse-loading">{$t('loading')}...</div>
    </div>
  {/if}
</div>

{#if copyPasteModalOpen}
  <CopyPasteModal onClose={() => (copyPasteModalOpen = false)} />
{/if}

{#if jsonRepairModalProps}
  <JSONRepairModal
    {...jsonRepairModalProps}
    onClose={() => {
      jsonRepairModalProps?.onClose()
      jsonRepairModalProps = undefined
    }}
  />
{/if}

<style src="./TableMode.scss"></style>
