import './viewSwitch.css'
import { faSitemap, faTable } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { Mode, type MenuButton, type MenuItem, type OnRenderMenu } from '$lib/types'
import { t } from '../i18n'
import { createIcon } from './icons'

/**
 * 上流が主のエディタのメニューの先頭に置く表示のボタンの並び（JSONEditorRoot の modeMenuItems）。
 * 印のクラスはどれも `jse-group-button`。
 */
const UPSTREAM_MODE_ORDER: readonly Mode[] = [Mode.text, Mode.tree, Mode.table]
const UPSTREAM_MODE_CLASS = 'jse-group-button'

/** 殻の切り替えに出す表示。Text は出さない（D3）。 */
const SWITCH_MODES: readonly { mode: Mode; labelKey: string; icon: IconDefinition }[] = [
  { mode: Mode.tree, labelKey: 'app.view.tree', icon: faSitemap },
  { mode: Mode.table, labelKey: 'app.view.table', icon: faTable }
]

export interface MainModeMenu {
  /** エディタの `onRenderMenu` に渡す。 */
  onRenderMenu: OnRenderMenu
  /** 上流の表示のボタンと同じ経路で切り替えを頼む。門番（modeGuard）を必ず通る。 */
  request(mode: Mode): void
}

function isUpstreamModeButton(item: MenuItem): item is MenuButton {
  return item.type === 'button' && (item.className ?? '').split(/\s+/).includes(UPSTREAM_MODE_CLASS)
}

/**
 * 主のエディタのメニューから、上流の Text/Tree/Table のボタンを外す（正規の設定 `onRenderMenu`）。
 * 外したボタンの押下の関数は覚えておき、殻の切り替えから呼ぶ。上流のボタンと同じく
 * `requestMode` から門番を通るので、テキストでしか開けない文書は Tree と Table へ入らない。
 *
 * `onRenderMenu` は Svelte の更新の中で呼ばれる。ここでは殻の DOM の書き換え（`onMode`）だけを行い、
 * エディタの API を呼ばない。
 */
export function createMainModeMenu(onMode: (mode: Mode) => void): MainModeMenu {
  const requests = new Map<Mode, MenuButton['onClick']>()

  return {
    onRenderMenu(items, { mode, modal }) {
      if (modal) {
        return undefined // 入れ子の値を開くモーダルの中のエディタは上流のまま（Text も残す）
      }
      const buttons = items.filter(isUpstreamModeButton)
      if (buttons.length !== UPSTREAM_MODE_ORDER.length) {
        return undefined // 上流の並びが想定と違う。外さずに残し、試験で気付く
      }
      buttons.forEach((button, index) => requests.set(UPSTREAM_MODE_ORDER[index], button.onClick))
      const rest = items.filter((item) => !buttons.includes(item as MenuButton))
      onMode(mode)
      return rest[0]?.type === 'separator' ? rest.slice(1) : rest
    },
    request(mode) {
      requests.get(mode)?.(new MouseEvent('click'))
    }
  }
}

export interface ViewSwitchOptions {
  /** 切り替えを頼む。門番を通る経路だけを渡す。 */
  request(mode: Mode): void
  /** 今の文書がその表示へ入れるか。門番と同じ検査で、知らせを出さない。 */
  probe(target: Mode): boolean | Promise<boolean>
  /**
   * テキストの表示で、今の文書が検査を通らない（テキストでしか開けない）かが決まった。
   * テキスト以外へ移ったときは `false`。描画の中からも呼ばれるので、受け手は殻の DOM だけを替える。
   */
  onTextOnlyChange?(textOnly: boolean): void
}

export interface ViewSwitch {
  element: HTMLElement
  /** 主のエディタの今の表示。描画の中から呼べる（DOM だけを替え、検査は後で走らせる）。 */
  setMode(mode: Mode): void
  /** 主のエディタの今の表示（`setMode` で受けた物。上流が描いたメニューの表示と同じ）。 */
  mode(): Mode
  /** 文書が変わった。テキストの表示なら、押せるかを見直す。 */
  recheck(): void
  /** 文言を辞書から引き直す。 */
  refresh(): void
}

/**
 * メニューの行の Tree と Table の切り替え（D2、D3、D4）。
 * テキストの表示（テキストでしか開けない文書、または undo で戻った文書）では、どちらも選ばない。
 * そのときは、文書が門番の検査を通るまで押せない。押せるかは表示の補助で、守りは門番が持つ。
 */
export function createViewSwitch(options: ViewSwitchOptions): ViewSwitch {
  const group = document.createElement('div')
  group.className = 'app-view-switch'
  group.setAttribute('role', 'group')

  const buttons = SWITCH_MODES.map(({ mode, labelKey, icon }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'app-view-switch-button'
    button.dataset.mode = mode
    button.setAttribute('role', 'menuitemradio')
    const label = document.createElement('span')
    label.className = 'app-view-switch-label'
    button.append(createIcon(icon), label)
    // 押下でフォーカスを奪わない。切り替えの後はエディタがフォーカスを持つ
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      if (enabled && mode !== current) {
        options.request(mode)
      }
    })
    group.appendChild(button)
    return { button, label, labelKey, mode }
  })

  let current: Mode = Mode.tree
  let enabled = true
  let checks = 0 // 古い検査の結果を捨てるための番号
  let timer: ReturnType<typeof setTimeout> | undefined

  function render(): void {
    group.dataset.mode = current
    for (const { button, mode } of buttons) {
      const selected = mode === current
      button.classList.toggle('is-selected', selected)
      button.setAttribute('aria-checked', String(selected))
      button.setAttribute('aria-disabled', String(!enabled))
    }
  }

  function applyCheck(id: number, allowed: boolean): void {
    if (id === checks && current === Mode.text) {
      enabled = allowed
      render()
      options.onTextOnlyChange?.(!allowed)
    }
  }

  function check(): void {
    timer = undefined
    const id = ++checks
    let verdict: boolean | Promise<boolean>
    try {
      // 門番はテキストから離れる先（ツリーか表）を区別しない。1 回の検査で両方を決める
      verdict = options.probe(Mode.tree)
    } catch {
      verdict = false
    }
    Promise.resolve(verdict).then(
      (allowed) => applyCheck(id, allowed),
      () => applyCheck(id, false)
    )
  }

  function schedule(): void {
    // 描画や onChange の中から呼ばれる。検査はエディタの API を使うので、その外で走らせる
    // 文書が変わったので、走っている検査（前の本文の結果）はここで捨てる
    checks++
    clearTimeout(timer)
    timer = setTimeout(check, 0)
  }

  function refresh(): void {
    group.setAttribute('aria-label', t('app.view.label'))
    for (const { label, labelKey } of buttons) {
      label.textContent = t(labelKey)
    }
  }

  refresh()
  render()

  return {
    element: group,
    setMode(mode) {
      if (mode === current) {
        return
      }
      current = mode
      checks++
      clearTimeout(timer)
      enabled = mode !== Mode.text // テキストの表示は検査が済むまで押せない
      if (mode === Mode.text) {
        schedule()
      } else {
        options.onTextOnlyChange?.(false)
      }
      render()
    },
    mode: () => current,
    recheck() {
      if (current === Mode.text) {
        schedule()
      }
    },
    refresh
  }
}
