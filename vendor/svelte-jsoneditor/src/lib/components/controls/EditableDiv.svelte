<svelte:options immutable={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { addNewLineSuffix, removeNewLineSuffix, setCursorToEnd } from '$lib/utils/domUtils.js'
  import { keyComboFromEvent } from '$lib/utils/keyBindings.js'
  import { createDebug } from '$lib/utils/debug.js'
  import { noop } from 'lodash-es'
  import type { OnFind, OnPaste } from '$lib/types'
  import { UpdateSelectionAfterChange } from '$lib/types'
  import { classnames } from '$lib/utils/cssUtils.js'

  const debug = createDebug('jsoneditor:EditableDiv')

  export let value: string
  export let initialValue: string | undefined
  export let shortText = false
  export let label: string
  export let onChange: (newValue: string, updateSelection: UpdateSelectionAfterChange) => void
  export let onUnchanged: (updateSelection: UpdateSelectionAfterChange) => void
  export let onCancel: () => void
  export let onLeave: () => void
  export let onFind: OnFind
  export let onPaste: OnPaste = noop
  export let onValueClass: (value: string) => string = () => ''

  let domValue: HTMLDivElement | undefined
  let valueClass: string
  $: valueClass = onValueClass(value)
  let closed = false

  // The text as read back from the DOM right after opening. The DOM can normalize whitespace and
  // line breaks, so comparing with this tells whether anything was typed, whatever the value is.
  let openedValue: string | undefined

  onMount(() => {
    debug('onMount', { value, initialValue })
    setDomValue(initialValue !== undefined ? initialValue : value)
    openedValue = initialValue === undefined ? getDomValue() : undefined

    // focus
    if (domValue) {
      setCursorToEnd(domValue)
    }
  })

  onDestroy(() => {
    const newValue = getDomValue()

    debug('onDestroy', { closed, value, newValue })

    if (!closed && domValue && newValue !== value && newValue !== openedValue) {
      onChange(newValue, UpdateSelectionAfterChange.no)
    }
  })

  function getDomValue(): string {
    if (!domValue) {
      return ''
    }
    return removeNewLineSuffix(domValue.innerText)
  }

  function setDomValue(updatedValue: string) {
    if (!domValue) {
      return
    }
    // Not innerText: that turns every carriage return into a line break. A text node holds the
    // value character for character, and innerText reads it back the same.
    domValue.textContent = addNewLineSuffix(updatedValue)
  }

  function handleValueInput() {
    const newValue = getDomValue()

    if (newValue === '') {
      // immediately update to clean up any left over <br/>
      setDomValue('')
    }

    // update class
    valueClass = onValueClass(newValue)
  }

  function handleCancel() {
    // cancel changes (needed to prevent triggering a change onDestroy)
    closed = true

    onCancel()
  }

  function handleValueKeyDown(event: KeyboardEvent) {
    event.stopPropagation()

    const combo = keyComboFromEvent(event)

    if (combo === 'Escape') {
      event.preventDefault()

      handleCancel()
    }

    if (combo === 'Enter' || combo === 'Tab') {
      // apply changes
      event.preventDefault()

      closed = true

      const newValue = getDomValue()
      if (newValue === openedValue || newValue === value) {
        onUnchanged(UpdateSelectionAfterChange.nextInside)
      } else {
        onChange(newValue, UpdateSelectionAfterChange.nextInside)
      }
    }

    if (combo === 'Ctrl+F') {
      event.preventDefault()
      onFind(false)
    }

    if (combo === 'Ctrl+H') {
      event.preventDefault()
      onFind(true)
    }
  }

  function handleValuePaste(event: ClipboardEvent) {
    event.stopPropagation()

    if (!onPaste || !event.clipboardData) {
      return
    }

    const clipboardText = event.clipboardData.getData('text/plain')
    onPaste(clipboardText)
  }

  function handleBlur() {
    const hasFocus = document.hasFocus()
    const newValue = getDomValue()

    debug('handleBlur', { hasFocus, closed, value, newValue })

    // we only want to close the editable div when the focus did go to another
    // element on the same page, but not when the user switches to another
    // application or browser tab to copy/paste something whilst still editing
    // the value, hence the check for document.hasFocus()
    if (document.hasFocus() && !closed) {
      closed = true
      if (newValue !== value && newValue !== openedValue) {
        onChange(newValue, UpdateSelectionAfterChange.self)
      } else {
        // Note that we do not fire an onCancel here: a blur action
        // is caused by the user clicking somewhere else. If we apply
        // onCancel now, we would override the selection that the user
        // wants by clicking somewhere else in the editor (since `blur`
        // is occurring *after* `mousedown`). onLeave only ends the editing.
        onLeave()
      }
    }
  }
</script>

<div
  role="textbox"
  aria-label={label}
  tabindex="0"
  class={classnames('jse-editable-div', valueClass, { 'jse-short-text': shortText })}
  contenteditable="true"
  spellcheck="false"
  on:input={handleValueInput}
  on:keydown={handleValueKeyDown}
  on:paste={handleValuePaste}
  on:blur={handleBlur}
  bind:this={domValue}
></div>

<style src="./EditableDiv.scss"></style>
