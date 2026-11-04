<script lang="ts">
  import { tick } from 'svelte'
  import Icon from 'svelte-awesome'
  import { faCaretRight } from '@fortawesome/free-solid-svg-icons'
  import type { MenuSubmenu } from '$lib/types'
  import { classnames } from '$lib/utils/cssUtils.js'
  import { keyComboFromEvent } from '$lib/utils/keyBindings.js'

  export let item: MenuSubmenu
  export let onRequestClose: () => void

  let open = false
  let openLeft = false
  let openUp = false
  let refWrapper: HTMLDivElement
  let refTrigger: HTMLButtonElement
  let refItems: HTMLDivElement | undefined

  function itemButtons(): HTMLButtonElement[] {
    return refItems ? Array.from(refItems.querySelectorAll('button:not([disabled])')) : []
  }

  /**
   * The area the submenu can be seen in: the window, narrowed to the element holding the editor
   * (the same area AbsolutePopupEntry places the context menu in).
   */
  function visibleArea() {
    const holder = refWrapper.closest('.jse-absolute-popup')?.parentElement?.getBoundingClientRect()
    return {
      left: Math.max(0, holder?.left ?? 0),
      top: Math.max(0, holder?.top ?? 0),
      right: Math.min(window.innerWidth, holder?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, holder?.bottom ?? window.innerHeight)
    }
  }

  /** Open to the right and down, unless it does not fit there and fits on the other side. */
  function place() {
    if (!refItems) {
      return
    }
    const area = visibleArea()
    const trigger = refTrigger.getBoundingClientRect()
    const items = refItems.getBoundingClientRect()
    openLeft = trigger.right + items.width > area.right && trigger.left - items.width >= area.left
    openUp = trigger.top + items.height > area.bottom && trigger.bottom - items.height >= area.top
  }

  async function openSubmenu(focusFirst: boolean) {
    if (!open) {
      openLeft = false
      openUp = false
      open = true
      await tick()
      place()
    }
    if (focusFirst) {
      itemButtons()[0]?.focus()
    }
  }

  function closeSubmenu(focusTrigger: boolean) {
    open = false
    if (focusTrigger) {
      refTrigger?.focus()
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent) {
    const combo = keyComboFromEvent(event)
    if (combo === 'ArrowRight' || combo === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      openSubmenu(true)
    }
  }

  function handleItemsKeyDown(event: KeyboardEvent) {
    const combo = keyComboFromEvent(event)
    if (combo === 'ArrowDown' || combo === 'ArrowUp') {
      const buttons = itemButtons()
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      const step = combo === 'ArrowDown' ? 1 : -1
      buttons[(index + step + buttons.length) % buttons.length]?.focus()
    } else if (combo === 'ArrowLeft' || combo === 'Escape') {
      closeSubmenu(true)
    } else if (combo !== 'ArrowRight') {
      return
    }
    // handled here: not by the context menu's arrow navigation, nor by the popup's Escape
    event.preventDefault()
    event.stopPropagation()
  }

  function handleMouseLeave() {
    if (open) {
      closeSubmenu(refItems?.contains(document.activeElement) === true)
    }
  }

  function handleFocusOut(event: FocusEvent) {
    if (open && !refWrapper.contains(event.relatedTarget as Node | null)) {
      closeSubmenu(false)
    }
  }
</script>

<div
  role="none"
  class="jse-context-submenu"
  bind:this={refWrapper}
  on:mouseenter={() => openSubmenu(false)}
  on:mouseleave={handleMouseLeave}
  on:focusout={handleFocusOut}
>
  <button
    type="button"
    class={classnames('jse-context-menu-button', 'jse-context-submenu-trigger', item.className)}
    title={item.title}
    aria-haspopup="menu"
    aria-expanded={open}
    bind:this={refTrigger}
    on:click={() => openSubmenu(true)}
    on:keydown={handleTriggerKeyDown}
  >
    <span class="jse-context-submenu-text">{item.text}</span>
    <Icon data={faCaretRight} />
  </button>
  {#if open}
    <div
      role="menu"
      tabindex="-1"
      class="jse-context-submenu-items"
      class:jse-open-left={openLeft}
      class:jse-open-up={openUp}
      data-jse-submenu="true"
      bind:this={refItems}
      on:keydown={handleItemsKeyDown}
    >
      {#each item.items as subItem}
        <button
          type="button"
          role="menuitem"
          class={classnames('jse-context-menu-button', subItem.className)}
          title={subItem.title}
          disabled={subItem.disabled || false}
          on:click={(event) => {
            onRequestClose()
            subItem.onClick(event)
          }}
        >
          {#if subItem.icon}
            <Icon data={subItem.icon} />
          {/if}
          {#if subItem.text}
            {subItem.text}
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style src="./ContextMenuSubmenu.scss"></style>
