<script lang="ts">
  import { t } from '$lib/i18n/index.js'
  interface Props {
    readOnly: boolean
    onCreateArray: () => void
    onCreateObject: () => void
    onClick: () => void
  }

  const { readOnly, onCreateArray, onCreateObject, onClick }: Props = $props()

  function handleCreateObject(event: MouseEvent) {
    event.stopPropagation()
    onCreateObject()
  }

  function handleCreateArray(event: MouseEvent) {
    event.stopPropagation()
    onCreateArray()
  }
</script>

<div class="jse-welcome" onclick={() => onClick()} role="none">
  <div class="jse-space jse-before"></div>
  <div class="jse-contents">
    <div class="jse-welcome-title">{$t('emptyDocumentTitle')}</div>
    {#if !readOnly}
      <div class="jse-welcome-info">
        {$t('welcomePasteBefore')} <b>Ctrl+V</b>{$t('welcomePasteAfter')}
      </div>
      <button title={$t('createObjectTitle')} onclick={handleCreateObject}
        >{$t('createObject')}</button
      >
      <button title={$t('createArrayTitle')} onclick={handleCreateArray}
        >{$t('createArray')}</button
      >
    {/if}
  </div>
  <div class="jse-space jse-after"></div>
</div>

<style src="./Welcome.scss"></style>
