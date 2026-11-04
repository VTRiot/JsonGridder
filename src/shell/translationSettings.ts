import './translationSettings.css'
import { t } from '../i18n'
import type { TranslationChoice, TranslationPorts, TranslationSettings } from './ports'

/**
 * 翻訳の設定のダイアログ（Options の「翻訳の設定…」）。
 *
 * キーは枠（無料枠用と有料用）ごとに 1 つ置く（F5）。無料枠か有料かは Google がキーのプロジェクトの
 * 課金で決めるので、アプリは選ばせず、翻訳のたびに右クリックでどちらのキーを使うかを選ばせる。
 * F5 より前のキー（枠の決まっていないキー）は黙って振り分けず、利用者が移す先を選ぶまで残す。
 *
 * キーの扱い（R7）: 入力欄は `type=password` で、押した直後（Rust の答えを待つ前）に空にする。
 * キーを画面へ書き戻す経路は無い（Rust はキーを返さず、どの枠にあるかだけを返す）。閉じると要素ごと捨てる。
 * 保存の答え（F1-b）: Rust は書いた直後に読み直して確かめ、確かめられなければ `notSaved` で拒む。
 * 画面は拒まれたら成功と言わず、UI の言語で理由を出す。
 * 通信はしない。設定ファイルと資格情報マネージャーを読み書きするだけ。
 */

/** Rust の誤りの短い名から辞書のキーへ。知らない名は `unknown`。キーの名は試験が全数を辞書と照らす。 */
const ERROR_KEYS: Record<string, string> = {
  empty: 'app.settings.translation.error.empty',
  tooLong: 'app.settings.translation.error.tooLong',
  badCharacter: 'app.settings.translation.error.badCharacter',
  store: 'app.settings.translation.error.store',
  notSaved: 'app.settings.translation.error.notSaved',
  settings: 'app.settings.translation.error.settings',
  noLegacy: 'app.settings.translation.error.noLegacy',
  occupied: 'app.settings.translation.error.occupied'
}
const UNKNOWN_ERROR_KEY = 'app.settings.translation.error.unknown'

/** 名の全数（辞書と照らす試験が使う）。 */
export const SETTINGS_ERROR_CODES = Object.keys(ERROR_KEYS)

/** サービスの表示の名。知らないサービスはその値のまま出す。 */
const SERVICE_KEYS: Record<string, string> = {
  gemini: 'app.settings.translation.service.gemini'
}

export const FREE_TIER = 'free'
export const PAID_TIER = 'paid'

/** 枠の短い表示の名（確かめの文に入る）。 */
const TIER_KEYS: Record<string, string> = {
  [FREE_TIER]: 'app.settings.translation.tierFree',
  [PAID_TIER]: 'app.settings.translation.tierPaid'
}

/** 枠ごとのキーの欄の見出し、注記、移すボタン。 */
const KEY_SLOT_KEYS: Record<string, { label: string; notice: string; move: string }> = {
  [FREE_TIER]: {
    label: 'app.settings.translation.keyFree',
    notice: 'app.settings.translation.freeTierNotice',
    move: 'app.settings.translation.legacyMoveFree'
  },
  [PAID_TIER]: {
    label: 'app.settings.translation.keyPaid',
    notice: 'app.settings.translation.paidTierNotice',
    move: 'app.settings.translation.legacyMovePaid'
  }
}

/** サービスの表示の名（送る前の確かめと同じ）。知らないサービスはその値のまま。 */
export function serviceLabel(value: string): string {
  return Object.hasOwn(SERVICE_KEYS, value) ? t(SERVICE_KEYS[value]) : value
}

/** 無料枠か有料かの表示の名。知らない値はその値のまま。 */
export function tierLabel(value: string): string {
  return Object.hasOwn(TIER_KEYS, value) ? t(TIER_KEYS[value]) : value
}

/** 知っている枠だけを、Rust の一覧の順に返す（画面が知らない枠には欄も項目も作らない）。 */
export function knownTiers(tiers: readonly string[]): string[] {
  return tiers.filter((tier) => Object.hasOwn(KEY_SLOT_KEYS, tier))
}

/** 拒まれた理由（command の誤りの文字列）を、UI の言語の文へ。 */
export function translationErrorText(reason: unknown): string {
  const code = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : ''
  return t(Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : UNKNOWN_ERROR_KEY)
}

export interface TranslationSettingsOptions {
  ports: TranslationPorts
  /** ダイアログを置く要素。 */
  host: HTMLElement
  /** 設定の保存が通った。 */
  onSaved(choice: TranslationChoice): void
  /** 閉じた（保存でも取り消しでも）。キーの有無が替わっていることがあるので、殻は読み直す。 */
  onClosed?(): void
}

export interface TranslationSettingsDialog {
  /** 設定を読み直してから出す。開いていれば何もしない。 */
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

let dialogCount = 0

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag)
  created.className = className
  if (text !== undefined) {
    created.textContent = text
  }
  return created
}

function labelled(text: string, control: HTMLElement, className = 'app-translation-field'): HTMLLabelElement {
  const label = create('label', className)
  label.append(create('span', 'app-translation-label', text), control)
  return label
}

function select(values: string[], selected: string, labelOf: (value: string) => string): HTMLSelectElement {
  const element = create('select', 'app-translation-select')
  for (const value of values) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = labelOf(value)
    option.selected = value === selected
    element.append(option)
  }
  return element
}

function checkbox(field: string, checked: boolean): HTMLInputElement {
  const input = create('input', 'app-translation-checkbox')
  input.type = 'checkbox'
  input.checked = checked
  input.dataset.field = field
  return input
}

function actionButton(action: string, text?: string): HTMLButtonElement {
  const button = create('button', 'app-translation-button', text)
  button.type = 'button'
  button.dataset.action = action
  return button
}

function showDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === 'function') {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
}

function hideDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close()
  }
  dialog.removeAttribute('open')
}

/** 枠ごとのキーの欄。 */
interface KeySlot {
  tier: string
  input: HTMLInputElement
  status: HTMLElement
  save: HTMLButtonElement
  remove: HTMLButtonElement
  /** 以前のキーをこの枠へ移すボタン。 */
  move: HTMLButtonElement
}

export function createTranslationSettings({ ports, host, onSaved, onClosed }: TranslationSettingsOptions): TranslationSettingsDialog {
  let current: { dialog: HTMLDialogElement; keyInputs: HTMLInputElement[] } | null = null
  let opening = false

  function close(): void {
    if (current === null) {
      return
    }
    const { dialog, keyInputs } = current
    current = null
    // 閉じるときにも入力欄を空にする（取り消しで閉じた入力を残さない）
    for (const input of keyInputs) {
      input.value = ''
    }
    hideDialog(dialog)
    dialog.remove()
    onClosed?.()
  }

  function build(settings: TranslationSettings | null, loadError: unknown): void {
    const id = ++dialogCount
    const dialog = create('dialog', 'app-translation-dialog')
    dialog.setAttribute('aria-labelledby', `app-translation-title-${id}`)
    const title = create('h2', 'app-translation-title', t('app.settings.translation.title'))
    title.id = `app-translation-title-${id}`
    const form = create('form', 'app-translation-form')
    form.method = 'dialog'
    const message = create('p', 'app-translation-message')
    message.setAttribute('role', 'status')
    message.setAttribute('aria-live', 'polite')
    message.hidden = true
    const say = (text: string, kind: 'info' | 'error'): void => {
      message.textContent = text
      message.dataset.kind = kind
      message.hidden = false
    }

    const actions = create('div', 'app-translation-actions')
    const cancel = actionButton('cancel', t('app.settings.translation.cancel'))
    cancel.addEventListener('click', close)

    if (settings === null) {
      say(translationErrorText(loadError), 'error')
      actions.append(cancel)
      form.append(message, actions)
      dialog.append(title, form)
      finish(dialog, [])
      return
    }

    let keyTiers = new Set(settings.keyTiers ?? [])
    let hasLegacyKey = settings.hasLegacyKey === true
    let busy = false

    const enable = checkbox('enabled', settings.enabled)
    const enableRow = labelled(t('app.settings.translation.enable'), enable, 'app-translation-field app-translation-check')
    const enableHint = create('p', 'app-translation-hint', t('app.settings.translation.enableHint'))

    const service = select(settings.services, settings.service, serviceLabel)
    service.dataset.field = 'service'

    // 枠ごとのキーの欄。注記は入力欄に見えない地の文で出す（F5。囲みの注記が入力欄に見えた）
    const slots: KeySlot[] = knownTiers(settings.tiers).map((tier) => {
      const names = KEY_SLOT_KEYS[tier]
      const input = create('input', 'app-translation-key-input')
      input.type = 'password'
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = t('app.settings.translation.keyPlaceholder')
      input.setAttribute('aria-label', t(names.label))
      input.dataset.tier = tier
      const status = create('span', 'app-translation-key-status')
      const save = actionButton('saveKey')
      const remove = actionButton('deleteKey', t('app.settings.translation.keyDelete'))
      const move = actionButton('moveKey', t(names.move))
      for (const button of [save, remove, move]) {
        button.dataset.tier = tier
      }
      return { tier, input, status, save, remove, move }
    })
    const keyBlocks = slots.map((slot) => {
      // 枠ごとの層（F7）。無料枠は緑、有料は金の面と縁
      const block = create('div', 'app-translation-field app-translation-key-block app-translation-card')
      block.dataset.tier = slot.tier
      block.dataset.card = slot.tier
      const head = create('div', 'app-translation-key-head')
      head.append(create('span', 'app-translation-label', t(KEY_SLOT_KEYS[slot.tier].label)), slot.status)
      const row = create('div', 'app-translation-key-row')
      row.append(slot.input, slot.save, slot.remove)
      const notice = create('p', 'app-translation-note', t(KEY_SLOT_KEYS[slot.tier].notice))
      notice.dataset.notice = slot.tier
      block.append(head, row, notice)
      return block
    })
    const regionNotice = create('p', 'app-translation-hint', t('app.settings.translation.regionNotice'))
    regionNotice.dataset.notice = 'region'
    const needsKey = create('p', 'app-translation-hint', t('app.settings.translation.needsKey'))
    needsKey.dataset.notice = 'needsKey'

    // F5 より前のキー。どちらかへ移すか、そのまま残す（黙って振り分けない）
    const legacyBlock = create('div', 'app-translation-field app-translation-legacy app-translation-card')
    legacyBlock.dataset.legacy = ''
    legacyBlock.dataset.card = 'legacy'
    const legacyButtons = create('div', 'app-translation-key-row')
    legacyButtons.append(...slots.map((slot) => slot.move))
    legacyBlock.append(
      create('span', 'app-translation-label', t('app.settings.translation.legacyKey')),
      create('p', 'app-translation-hint', t('app.settings.translation.legacyHint')),
      legacyButtons
    )

    const model = select(settings.models, settings.model, (value) => value)
    model.dataset.field = 'model'

    // 混雑のときの切り替え。古い Rust が値を返さなければ既定の入
    const fallback = checkbox('fallback', settings.fallback !== false)
    const fallbackRow = labelled(t('app.settings.translation.fallback'), fallback, 'app-translation-field app-translation-check')
    const fallbackHint = create('p', 'app-translation-hint', t('app.settings.translation.fallbackHint'))
    fallbackHint.dataset.notice = 'fallback'

    // 送る前の確かめ（F4）。確かめの「今後表示しない」で切った後、ここで戻せる。古い Rust が値を返さなければ入
    const confirmBefore = checkbox('confirm', settings.confirm !== false)
    const confirmRow = labelled(t('app.settings.translation.confirm'), confirmBefore, 'app-translation-field app-translation-check')
    const confirmHint = create('p', 'app-translation-hint', t('app.settings.translation.confirmHint'))
    confirmHint.dataset.notice = 'confirm'

    // 小窓の注意書き（F5）。小窓の「今後表示しない」で切った後、ここで戻せる。値が無ければ入
    const machineNotice = checkbox('machineNotice', settings.machineNotice !== false)
    const machineRow = labelled(t('app.settings.translation.machineNotice'), machineNotice, 'app-translation-field app-translation-check')
    const machineHint = create('p', 'app-translation-hint', t('app.settings.translation.machineNoticeHint'))
    machineHint.dataset.notice = 'machineNotice'

    const save = create('button', 'app-translation-button app-translation-primary', t('app.settings.translation.save'))
    save.type = 'submit'
    save.dataset.action = 'save'

    /** 選んでいる値と、キーの有無に合わせて出し分ける。 */
    const update = (): void => {
      for (const slot of slots) {
        const has = keyTiers.has(slot.tier)
        slot.status.textContent = t(has ? 'app.settings.translation.keySaved' : 'app.settings.translation.keyNone')
        slot.status.dataset.saved = String(has)
        slot.save.textContent = t(has ? 'app.settings.translation.keyReplace' : 'app.settings.translation.keySave')
        slot.remove.hidden = !has
        // 移す先が埋まっていれば押せない（Rust も上書きを拒む）
        slot.move.disabled = busy || has
      }
      legacyBlock.hidden = !hasLegacyKey
      needsKey.hidden = !(enable.checked && keyTiers.size === 0)
      for (const button of [...slots.flatMap((slot) => [slot.save, slot.remove]), save]) {
        button.disabled = busy
      }
    }
    enable.addEventListener('change', update)

    /** キーの有無だけを読み直す。選びかけの値は替えない。 */
    const refreshKeys = async (): Promise<void> => {
      try {
        const fresh = await ports.settings()
        keyTiers = new Set(fresh.keyTiers ?? [])
        hasLegacyKey = fresh.hasLegacyKey === true
      } catch {
        // 読めなければ前の表示のまま（誤りはすでに出している）
      }
    }

    const run = (action: () => Promise<void>, done: string): void => {
      if (busy) {
        return
      }
      busy = true
      update()
      void (async () => {
        try {
          await action()
          await refreshKeys()
          say(t(done), 'info')
        } catch (reason) {
          await refreshKeys()
          say(translationErrorText(reason), 'error')
        } finally {
          busy = false
          if (current?.dialog === dialog) {
            update()
          }
        }
      })()
    }

    for (const slot of slots) {
      slot.save.addEventListener('click', () => {
        if (busy) {
          return
        }
        // 送る前に入力欄から取り出して空にする。答えを待つ間も、拒まれた後も、画面にキーを残さない
        const key = slot.input.value
        slot.input.value = ''
        run(() => ports.saveKey(slot.tier, key), 'app.settings.translation.keyStored')
      })
      // キーの欄の Enter はその欄のキーの保存（フォームの保存へ流すと、入れたキーが黙って捨てられる）
      slot.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          slot.save.click()
        }
      })
      slot.remove.addEventListener('click', () => run(() => ports.clearKey(slot.tier), 'app.settings.translation.keyDeleted'))
      slot.move.addEventListener('click', () => run(() => ports.moveKey(slot.tier), 'app.settings.translation.legacyMoved'))
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (busy) {
        return
      }
      const choice: TranslationChoice = {
        enabled: enable.checked,
        service: service.value,
        model: model.value,
        fallback: fallback.checked,
        confirm: confirmBefore.checked,
        machineNotice: machineNotice.checked
      }
      busy = true
      update()
      void (async () => {
        try {
          await ports.saveSettings(choice)
        } catch (reason) {
          say(translationErrorText(reason), 'error')
          busy = false
          if (current?.dialog === dialog) {
            update()
          }
          return
        }
        busy = false
        onSaved(choice)
        close()
      })()
    })

    // まとまりの層（F7）。要素の並び（キーの順）は変えず、まとまりごとに包むだけ
    const general = create('div', 'app-translation-group')
    general.dataset.card = 'general'
    general.append(enableRow, enableHint, labelled(t('app.settings.translation.service'), service))
    const options = create('div', 'app-translation-card')
    options.dataset.card = 'options'
    options.append(
      labelled(t('app.settings.translation.model'), model),
      fallbackRow,
      fallbackHint,
      confirmRow,
      confirmHint,
      machineRow,
      machineHint
    )

    actions.append(save, cancel)
    form.append(general, ...keyBlocks, needsKey, regionNotice, legacyBlock, options, message, actions)
    dialog.append(title, form)
    update()
    finish(
      dialog,
      slots.map((slot) => slot.input)
    )
  }

  function finish(dialog: HTMLDialogElement, keyInputs: HTMLInputElement[]): void {
    // Esc は取り消しと同じ（入力欄を空にして要素ごと捨てる）
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      close()
    })
    host.append(dialog)
    current = { dialog, keyInputs }
    showDialog(dialog)
  }

  return {
    async open() {
      if (current !== null || opening) {
        return
      }
      opening = true
      try {
        build(await ports.settings(), undefined)
      } catch (reason) {
        build(null, reason)
      } finally {
        opening = false
      }
    },
    close,
    isOpen: () => current !== null
  }
}
