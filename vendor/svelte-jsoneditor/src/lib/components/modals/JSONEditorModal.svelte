<svelte:options immutable={true} />

<script lang="ts">
  import { flushSync, onMount } from 'svelte'
  import Header from './Header.svelte'
  import type { JSONPatchDocument, JSONPath } from 'immutable-json-patch'
  import { compileJSONPointer, isJSONArray } from 'immutable-json-patch'
  import { immutableJSONPatch } from '$lib/logic/jsonPatch.js'
  import { createDebug } from '$lib/utils/debug.js'
  import type {
    Content,
    HistoryItem,
    HistorySnapshot,
    JSONEditorModalCallback,
    JSONEditorSelection,
    JSONParser,
    JSONPathParser,
    ModeGuard,
    OnClassName,
    OnPatch,
    OnRenderContextMenu,
    OnRenderMenu,
    OnRenderValue,
    OnSortModal,
    OnTransformModal,
    Validator
  } from '$lib/types'
  import { Mode } from '$lib/types.js'
  import JSONEditorRoot from '../modes/JSONEditorRoot.svelte'
  import { noop } from '$lib/utils/noop.js'
  import { stringifyJSONPath } from '$lib/utils/pathUtils.js'
  import { t } from '$lib/i18n/index.js'
  import { initial, isEmpty, last } from 'lodash-es'
  import { isJSONContent, toJSONContent } from '$lib/utils/jsonUtils.js'
  import Icon from 'svelte-awesome'
  import { faCaretLeft } from '@fortawesome/free-solid-svg-icons'
  import memoizeOne from 'memoize-one'
  import { getFocusPath, isJSONSelection } from '$lib/logic/selection.js'
  import Modal from './Modal.svelte'
  import AbsolutePopup from './popup/AbsolutePopup.svelte'

  const debug = createDebug('jsoneditor:JSONEditorModal')

  export let content: Content // the nested document
  export let path: JSONPath
  export let onPatch: OnPatch

  export let readOnly: boolean
  export let indentation: number | string
  export let tabSize: number
  export let truncateTextSize: number
  export let mainMenuBar: boolean
  export let navigationBar: boolean
  export let statusBar: boolean
  export let askToFormat: boolean
  export let escapeControlCharacters: boolean
  export let escapeUnicodeCharacters: boolean
  export let maxDocumentSizeTextMode: number
  export let modeGuard: ModeGuard | undefined
  export let allowExtract: boolean
  export let flattenColumns: boolean
  export let parser: JSONParser
  export let validator: Validator | undefined
  export let validationParser: JSONParser
  export let pathParser: JSONPathParser

  export let onRenderValue: OnRenderValue
  export let onClassName: OnClassName
  export let onRenderMenu: OnRenderMenu
  export let onRenderContextMenu: OnRenderContextMenu

  export let onSortModal: OnSortModal
  export let onTransformModal: OnTransformModal

  export let onClose: () => void

  interface ModalState {
    mode: Mode
    content: Content
    selection: JSONEditorSelection | undefined
    relativePath: JSONPath
    // The history of the level below. All levels share one JSONEditorRoot, and each level holds a
    // different document, so that the items of one level cannot be applied on another level.
    parentHistory?: HistorySnapshot<HistoryItem>
  }

  let refEditor: JSONEditorRoot
  let fullscreen: boolean

  // All levels share one JSONEditorRoot. A mode guard that is still answering belongs to this
  // level, its answer has to find this level and its history.
  let checkingMode = false

  const rootState: ModalState = {
    mode: determineMode(content),
    content,
    selection: undefined,
    relativePath: path
  }
  let stack: ModalState[] = [rootState]

  $: currentState = last(stack) || rootState
  $: absolutePath = stack.flatMap((state) => state.relativePath)
  $: pathDescription = !isEmpty(absolutePath) ? stringifyJSONPath(absolutePath) : '(document root)'

  // not relevant in this Modal setting, but well
  $: parseMemoizeOne = memoizeOne(parser.parse)

  let error: string | undefined = undefined

  onMount(() => {
    refEditor?.focus()
  })

  function determineMode(content: Content): Mode {
    return isJSONContent(content) && isJSONArray(content.json) ? Mode.table : Mode.tree
  }

  function scrollToSelection() {
    const selection: JSONEditorSelection | undefined = last(stack)?.selection
    if (isJSONSelection(selection)) {
      refEditor.scrollTo(getFocusPath(selection))
    }
  }

  /**
   * 段を下ろす前に必ず呼ぶ。遅延中の入力を、打たれた段へ確定する。
   * stack を変えた後に確定すると、onChange は下ろした後の親の段へ子の文書を書く。
   * 親の表示はツリーか表なので、stack の変更でテキストの表示が壊れ、その時の確定が親を置き換える。
   * 確定の後に読むのは last(stack)。currentState は次の更新まで古い値のまま。
   * ここで flushSync を足さない。TextMode の flush は更新の最中にも呼ばれる。
   */
  function flushPendingInput() {
    refEditor?.flush()
  }

  /**
   * Show the level below with the history it had. Passing the document of a level to
   * JSONEditorRoot looks like a change of the document, the history must not keep that.
   */
  function returnToParent() {
    const { parentHistory } = last(stack) as ModalState

    stack = initial(stack)
    flushSync()

    if (parentHistory) {
      refEditor?.restoreHistory(parentHistory)
    }
  }

  function handleApply() {
    debug('handleApply')

    if (readOnly || checkingMode) {
      return
    }

    try {
      error = undefined

      flushPendingInput()

      const { relativePath: path, content } = last(stack) || rootState
      const operations: JSONPatchDocument = [
        {
          op: 'replace',
          path: compileJSONPointer(path),
          value: toJSONContent(content, parser).json // this can throw an error
        }
      ]

      if (stack.length > 1) {
        const parentContent = stack[stack.length - 2].content
        const parentJson = toJSONContent(parentContent, parser).json
        const updatedParentContent = {
          json: immutableJSONPatch(parentJson, operations)
        }

        // after successfully updated, remove from the stack and apply the change to the parent
        const parentState = stack[stack.length - 2] || rootState
        const updatedParentState: ModalState = { ...parentState, content: updatedParentContent }

        // first go back to the parent as it was: the update below is one change in its history
        returnToParent()
        stack = [...initial(stack), updatedParentState]
        flushSync()
        scrollToSelection()
      } else {
        onPatch(operations)

        onClose()
      }
    } catch (err) {
      error = String(err)
    }
  }

  function handleClose() {
    debug('handleClose')

    if (checkingMode) {
      return
    }

    flushPendingInput()

    if (stack.length > 1) {
      // remove the last item from the stack
      returnToParent()
      refEditor?.focus()
      scrollToSelection()

      // clear any error from the just closed state
      error = undefined
    } else {
      // this is the first modal, the root state, close the modal
      onClose()
    }
  }

  function handleChange(updatedContent: Content) {
    debug('handleChange', updatedContent)
    updateState((state) => ({ ...state, content: updatedContent }))
  }

  function handleChangeSelection(newSelection: JSONEditorSelection | undefined) {
    debug('handleChangeSelection', newSelection)
    updateState((state) => ({ ...state, selection: newSelection }))
  }

  function handleChangeMode(newMode: Mode) {
    debug('handleChangeMode', newMode)
    updateState((state) => ({ ...state, mode: newMode }))
  }

  function updateState(callback: (state: ModalState) => ModalState) {
    const state = last(stack) as ModalState
    const updatedState = callback(state)
    stack = [...initial(stack), updatedState]
  }

  function handleError(newError: Error) {
    error = newError.toString()
    console.error(newError)
  }

  function handleJSONEditorModal({ content, path }: JSONEditorModalCallback) {
    debug('handleJSONEditorModal', { content, path })

    const nestedModalState = {
      mode: determineMode(content),
      content,
      selection: undefined,
      relativePath: path,
      parentHistory: refEditor?.snapshotHistory()
    }
    stack = [...stack, nestedModalState]

    flushSync()
    refEditor?.clearHistory()
    refEditor?.focus()
  }

  function focus(element: HTMLElement) {
    element.focus()
  }
</script>

<Modal onClose={handleClose} className="jse-jsoneditor-modal" {fullscreen}>
  <div class="jse-modal-wrapper">
    <AbsolutePopup>
      <Header
        title="{$t('editNestedContent')}{stack.length > 1 ? ` (${stack.length})` : ''}"
        fullScreenButton={true}
        bind:fullscreen
        onClose={handleClose}
      />

      <div class="jse-modal-contents">
        <div class="jse-label">
          <div class="jse-label-inner">{$t('path')}</div>
        </div>
        <input
          class="jse-path"
          type="text"
          readonly
          title={$t('selectedPath')}
          value={pathDescription}
        />

        <div class="jse-label">
          <div class="jse-label-inner">{$t('contents')}</div>
        </div>

        <div class="jse-modal-inline-editor">
          <JSONEditorRoot
            bind:this={refEditor}
            bind:checkingMode
            externalMode={currentState.mode}
            content={currentState.content}
            selection={currentState.selection}
            {readOnly}
            {indentation}
            {tabSize}
            {truncateTextSize}
            {statusBar}
            {askToFormat}
            {mainMenuBar}
            {navigationBar}
            {escapeControlCharacters}
            {escapeUnicodeCharacters}
            {maxDocumentSizeTextMode}
            {modeGuard}
            {allowExtract}
            {flattenColumns}
            {parser}
            {parseMemoizeOne}
            {validator}
            {validationParser}
            {pathParser}
            insideModal={true}
            onError={handleError}
            onChange={handleChange}
            onChangeMode={handleChangeMode}
            onSelect={handleChangeSelection}
            {onRenderValue}
            {onClassName}
            onFocus={noop}
            onBlur={noop}
            {onRenderMenu}
            {onRenderContextMenu}
            {onSortModal}
            {onTransformModal}
            onJSONEditorModal={handleJSONEditorModal}
          />
        </div>

        <div class="jse-actions">
          {#if error}
            <div class="jse-error">
              {error}
            </div>
          {/if}

          {#if stack.length > 1}
            <button
              type="button"
              class="jse-secondary"
              disabled={checkingMode}
              on:click={handleClose}
            >
              <Icon data={faCaretLeft} />
              {$t('back')}
            </button>
          {/if}
          {#if !readOnly}
            <button
              type="button"
              class="jse-primary"
              disabled={checkingMode}
              on:click={handleApply}
              use:focus
            >
              {$t('apply')}
            </button>
          {:else}
            <button type="button" class="jse-primary" on:click={handleClose}> {$t('close')} </button>
          {/if}
        </div>
      </div>
    </AbsolutePopup>
  </div>
</Modal>

<style src="./JSONEditorModal.scss"></style>
