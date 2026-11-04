<script lang="ts">
  import type { AbsolutePopupOptions, PopupEntry } from '$lib/types.js'
  import { onMount } from 'svelte'
  import { isChildOf } from '$lib/utils/domUtils.js'
  import { keyComboFromEvent } from '$lib/utils/keyBindings.js'

  export let popup: PopupEntry
  export let closeAbsolutePopup: (popupId: number) => void

  let refRootPopup: HTMLDivElement
  let refHiddenInput: HTMLInputElement

  onMount(focus)

  function closeWhenOutside(event: Event) {
    if (
      popup.options &&
      popup.options.closeOnOuterClick &&
      !isChildOf(event.target as HTMLElement, (e) => e === refRootPopup)
    ) {
      closeAbsolutePopup(popup.id)
    }
  }

  function handleWindowMouseDown(event: Event) {
    closeWhenOutside(event)
  }

  function handleMouseDownInside(event: Event) {
    event.stopPropagation()
  }

  /** An open submenu of the context menu closes itself on Escape (and keeps the menu open). */
  function isInSubmenu(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-jse-submenu]') !== null
  }

  function handleKeyDown(event: KeyboardEvent) {
    const combo = keyComboFromEvent(event)
    if (combo === 'Escape' && !isInSubmenu(event.target)) {
      event.preventDefault()
      event.stopPropagation()
      closeAbsolutePopup(popup.id)
    }
  }

  function handleScrollWheel(event: Event) {
    closeWhenOutside(event)
  }

  /**
   * The area the popup can be seen in: the window, narrowed to the element holding the editor. The
   * application can place the editor in a box smaller than the window that hides its overflow.
   */
  function visibleArea(refRootPopup: HTMLDivElement) {
    const holder = refRootPopup.parentElement?.getBoundingClientRect()
    return {
      left: Math.max(0, holder?.left ?? 0),
      top: Math.max(0, holder?.top ?? 0),
      right: Math.min(window.innerWidth, holder?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, holder?.bottom ?? window.innerHeight)
    }
  }

  function calculateStyle(refRootPopup: HTMLDivElement, options: AbsolutePopupOptions) {
    const area = visibleArea(refRootPopup)

    function calculatePosition() {
      if (options.anchor) {
        const { anchor, width = 0, height = 0, offsetTop = 0, offsetLeft = 0, position } = options
        const { left, top, bottom, right } = anchor.getBoundingClientRect()

        const positionAbove =
          position === 'top' || (top + height > area.bottom && top - area.top > height)
        const positionLeft =
          position === 'left' || (left + width > area.right && left - area.left > width)

        return {
          left: positionLeft ? right - offsetLeft : left + offsetLeft,
          top: positionAbove ? top - offsetTop : bottom + offsetTop,
          positionAbove,
          positionLeft
        }
      } else if (typeof options.left === 'number' && typeof options.top === 'number') {
        const { left, top, width = 0, height = 0 } = options

        const positionAbove = top + height > area.bottom && top - area.top > height
        const positionLeft = left + width > area.right && left - area.left > width

        return {
          left,
          top,
          positionAbove,
          positionLeft
        }
      } else {
        throw new Error('Invalid config: pass either "left" and "top", or pass "anchor"')
      }
    }

    const rootRect = refRootPopup.getBoundingClientRect()
    const position = calculatePosition()
    const { positionAbove, positionLeft } = position
    // Fits on neither side: move it into the area, as far as the area is large enough
    const { width = 0, height = 0 } = options
    const top =
      !positionAbove && position.top + height > area.bottom
        ? Math.max(area.top, area.bottom - height)
        : position.top
    const left =
      !positionLeft && position.left + width > area.right
        ? Math.max(area.left, area.right - width)
        : position.left

    const verticalStyling = positionAbove
      ? `bottom: ${rootRect.top - top}px;`
      : `top: ${top - rootRect.top}px;`

    const horizontalStyling = positionLeft
      ? `right: ${rootRect.left - left}px;`
      : `left: ${left - rootRect.left}px;`

    return verticalStyling + horizontalStyling
  }

  function focus() {
    if (refHiddenInput) {
      refHiddenInput.focus({ preventScroll: true })
    }
  }
</script>

<svelte:window
  on:mousedown|capture={handleWindowMouseDown}
  on:keydown|capture={handleKeyDown}
  on:wheel|capture={handleScrollWheel}
/>

<div
  role="none"
  bind:this={refRootPopup}
  class="jse-absolute-popup"
  on:mousedown={handleMouseDownInside}
  on:keydown={handleKeyDown}
>
  {#if refRootPopup}
    <div class="jse-absolute-popup-content" style={calculateStyle(refRootPopup, popup.options)}>
      <input
        type="text"
        readonly
        tabindex="-1"
        class="jse-hidden-input"
        bind:this={refHiddenInput}
      />
      <svelte:component this={popup.component} {...popup.props} />
    </div>
  {/if}
</div>

<style src="./AbsolutePopupEntry.scss"></style>
