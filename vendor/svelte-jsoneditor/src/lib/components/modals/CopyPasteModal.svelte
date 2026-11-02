<svelte:options immutable={true} />

<script lang="ts">
  import { isMacDevice } from '$lib/utils/navigatorUtils.js'
  import Header from './Header.svelte'
  import Modal from './Modal.svelte'
  import { t } from '$lib/i18n/index.js'

  export let onClose: () => void

  const ctrl = isMacDevice() ? '⌘' : 'Ctrl'
</script>

<Modal {onClose} className="jse-copy-paste">
  <Header title={$t('copyingAndPasting')} {onClose} />

  <div class="jse-modal-contents">
    <div>{$t('clipboardPermissionDisabled')}</div>

    <div class="jse-shortcuts">
      <div class="jse-shortcut">
        <div class="jse-key">
          {ctrl}+C
        </div>
        {$t('forCopy')}
      </div>
      <div class="jse-shortcut">
        <div class="jse-key">
          {ctrl}+X
        </div>
        {$t('forCut')}
      </div>
      <div class="jse-shortcut">
        <div class="jse-key">
          {ctrl}+V
        </div>
        {$t('forPaste')}
      </div>
    </div>

    <div class="jse-actions">
      <button type="button" class="jse-primary" on:click={onClose}> {$t('close')} </button>
    </div>
  </div>
</Modal>

<style src="./CopyPasteModal.scss"></style>
