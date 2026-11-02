<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { tString } from '$lib/i18n/index.js'

  export let color: string
  export let onChange: (newColor: string) => void
  export let showOnTop: boolean

  let ref: HTMLElement | undefined
  let destroyColorPicker = () => {}

  onMount(async () => {
    // Dynamically import VanillaPicker, because it requires `document` to be defined,
    // and that is not supported server side
    const VanillaPicker = (await import('vanilla-picker'))?.default

    const colorPicker = new VanillaPicker({
      parent: ref,
      color,
      popup: showOnTop ? 'top' : 'bottom',
      template: `<div class="picker_wrapper" tabindex="-1"><div class="picker_arrow"></div><div class="picker_hue picker_slider"><div class="picker_selector"></div></div><div class="picker_sl"><div class="picker_selector"></div></div><div class="picker_alpha picker_slider"><div class="picker_selector"></div></div><div class="picker_editor"><input aria-label="${tString('colorPickerInputLabel')}"/></div><div class="picker_sample"></div><div class="picker_done"><button>${tString('Ok')}</button></div><div class="picker_cancel"><button>${tString('cancel')}</button></div></div>`,
      onDone: function (color) {
        const alpha = color.rgba[3]
        const hex =
          alpha === 1
            ? color.hex.substring(0, 7) // return #RRGGBB
            : color.hex // return #RRGGBBAA
        onChange(hex)
      }
    })

    colorPicker.show()

    destroyColorPicker = () => {
      colorPicker.destroy()
    }
  })

  onDestroy(() => {
    destroyColorPicker()
  })
</script>

<div class="jse-color-picker-popup" bind:this={ref}></div>

<style src="./ColorPickerPopup.scss"></style>
