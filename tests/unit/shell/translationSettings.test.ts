// 翻訳の設定のダイアログ（Step10-002 T3、F5）。キーを画面に残さない（R7）、枠ごとのキーと地の文の注記（F5）、
// 以前のキーを黙って振り分けない（F5）、保存の読み直しで確かめられなかったときに成功と言わない（F1-b）を確かめる。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import en from '../../../src/i18n/en.json'
import ja from '../../../src/i18n/ja.json'
import { setLanguage } from '../../../src/i18n'
import type { TranslationChoice, TranslationPorts, TranslationSettings } from '../../../src/shell/ports'
import { createTranslationSettings, SETTINGS_ERROR_CODES, translationErrorText } from '../../../src/shell/translationSettings'

const SAMPLE_KEY = 'test-not-a-real-key-AbCdEf0123456789'
const ERROR_CODES = ['empty', 'tooLong', 'badCharacter', 'store', 'notSaved', 'settings', 'noLegacy', 'occupied']
const TIERS = ['free', 'paid']

function settings(fields: Partial<TranslationSettings> = {}): TranslationSettings {
  return {
    enabled: false,
    service: 'gemini',
    model: 'gemini-3.1-flash-lite',
    fallback: true,
    confirm: true,
    machineNotice: true,
    keyTiers: [],
    hasLegacyKey: false,
    services: ['gemini'],
    tiers: [...TIERS],
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
    ...fields
  }
}

/** 答えを試験が決める口。キーの保存は既定で「残る」、`lose` で「読み直すと無い」（Rust の notSaved）。 */
function fakePorts(initial: TranslationSettings) {
  const state = { ...initial, keyTiers: [...initial.keyTiers] }
  const calls = {
    saveKey: [] as { tier: string; key: string }[],
    clearKey: [] as string[],
    moveKey: [] as string[],
    saveSettings: [] as TranslationChoice[],
    settings: 0
  }
  let lose = false
  let hold: Promise<void> | null = null
  const setTier = (tier: string, present: boolean) => {
    const next = new Set(state.keyTiers)
    if (present) next.add(tier)
    else next.delete(tier)
    state.keyTiers = TIERS.filter((entry) => next.has(entry))
  }
  const ports: TranslationPorts = {
    settings() {
      calls.settings++
      return Promise.resolve({ ...state, keyTiers: [...state.keyTiers] })
    },
    saveSettings(choice) {
      calls.saveSettings.push(choice)
      Object.assign(state, choice)
      return Promise.resolve()
    },
    // 設定のダイアログは確かめと注意書きの値をダイアログの保存（saveSettings）で書く。この口は使わない
    saveConfirm: () => Promise.reject(new Error('the settings dialog saves confirm with saveSettings')),
    saveMachineNotice: () => Promise.reject(new Error('the settings dialog saves machineNotice with saveSettings')),
    async saveKey(tier, key) {
      calls.saveKey.push({ tier, key })
      if (hold) await hold
      if (lose) throw 'notSaved'
      if (key.trim() === '') throw 'empty'
      setTier(tier, true)
    },
    clearKey(tier) {
      calls.clearKey.push(tier)
      setTier(tier, false)
      return Promise.resolve()
    },
    moveKey(tier) {
      calls.moveKey.push(tier)
      if (!state.hasLegacyKey) return Promise.reject('noLegacy')
      if (state.keyTiers.includes(tier)) return Promise.reject('occupied')
      state.hasLegacyKey = false
      setTier(tier, true)
      return Promise.resolve()
    },
    // 設定のダイアログは翻訳の仕事を始めない（T4 の口。ここでは呼ばれたら落とす）
    start: () => Promise.reject(new Error('the settings dialog must not start a job')),
    cancel: () => Promise.reject(new Error('the settings dialog must not cancel a job'))
  }
  return {
    ports,
    calls,
    state,
    loseWrites: () => {
      lose = true
    },
    holdSaves: () => {
      let release = () => {}
      hold = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        hold = null
        release()
      }
    }
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  host.remove()
  setLanguage('ja')
})

async function openDialog(initial: TranslationSettings) {
  const fake = fakePorts(initial)
  const saved: TranslationChoice[] = []
  let closed = 0
  const dialog = createTranslationSettings({
    ports: fake.ports,
    host,
    onSaved: (choice) => saved.push(choice),
    onClosed: () => closed++
  })
  await dialog.open()
  const element = host.querySelector<HTMLDialogElement>('dialog.app-translation-dialog')
  expect(element).not.toBeNull()
  const $ = <T extends Element>(selector: string) => element?.querySelector<T>(selector) as T
  /** 枠の欄の中の要素。 */
  const slot = <T extends Element>(tier: string, selector: string) => $<T>(`.app-translation-key-block[data-tier="${tier}"] ${selector}`)
  return { ...fake, dialog, element: element as HTMLDialogElement, saved, $, slot, closed: () => closed }
}

/** 画面の要素とすべての入力欄の値に、キーもキーの一部も無い。 */
function expectNoKeyAnywhere(root: HTMLElement) {
  const probe = SAMPLE_KEY.slice(-12)
  expect(root.outerHTML).not.toContain(probe)
  expect(root.textContent ?? '').not.toContain(probe)
  for (const input of root.querySelectorAll('input')) {
    expect(input.value).not.toContain(probe)
    expect(input.defaultValue).not.toContain(probe)
  }
}

describe('two_key_slots（F5）', () => {
  it('無料枠用と有料用の 2 つの欄があり、無料枠か有料かのラジオは無い', async () => {
    const { element, slot } = await openDialog(settings())
    const blocks = [...element.querySelectorAll<HTMLElement>('.app-translation-key-block')]
    expect(blocks.map((block) => block.dataset.tier)).toEqual(['free', 'paid'])
    expect(element.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(element.querySelector('[data-field="tier"]')).toBeNull()
    expect(slot('free', '.app-translation-label').textContent).toBe('無料枠用のキー（課金なしのプロジェクト）')
    expect(slot('paid', '.app-translation-label').textContent).toBe('有料用のキー（課金ありのプロジェクト）')
    for (const tier of TIERS) {
      const input = slot<HTMLInputElement>(tier, '.app-translation-key-input')
      expect(input.type).toBe('password')
      expect(input.value).toBe('')
      expect(input.autocomplete).toBe('off')
      expect(slot(tier, '.app-translation-key-status').textContent).toBe('未設定')
      expect(slot<HTMLButtonElement>(tier, '[data-action="deleteKey"]').hidden).toBe(true)
    }
  })

  it('無料枠の注記は無料枠の欄の地の文で、囲みの注記（入力欄に見える形）は使わない', async () => {
    const { element, slot } = await openDialog(settings())
    const free = slot<HTMLElement>('free', '[data-notice="free"]')
    expect(free.tagName).toBe('P')
    expect(free.className).toBe('app-translation-note')
    expect(free.textContent).toBe(ja['app.settings.translation.freeTierNotice'])
    expect(free.textContent).toContain('Google の製品の改善に使われ')
    expect(free.textContent).toContain('人が読むことがあります')
    expect(free.hidden).toBe(false)
    expect(slot('paid', '[data-notice="paid"]').textContent).toBe(ja['app.settings.translation.paidTierNotice'])
    expect(element.querySelector('.app-translation-notice')).toBeNull()
    expect(element.querySelector('[data-notice="region"]')).not.toBeNull()
  })

  it('有料用だけ保存済みなら、その欄だけ「保存済み」と入れ直しと削除', async () => {
    const { element, slot } = await openDialog(settings({ keyTiers: ['paid'] }))
    expect(slot('paid', '.app-translation-key-status').textContent).toBe('保存済み（Windows の資格情報マネージャー）')
    expect(slot('paid', '[data-action="saveKey"]').textContent).toBe('キーを入れ直す')
    expect(slot<HTMLButtonElement>('paid', '[data-action="deleteKey"]').hidden).toBe(false)
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
    expect(slot('free', '[data-action="saveKey"]').textContent).toBe('キーを保存')
    expectNoKeyAnywhere(element)
  })

  it('入れたキーは選んだ枠で Rust へ 1 回だけ渡り、画面のどこにも残らない', async () => {
    const { element, slot, calls } = await openDialog(settings())
    slot<HTMLInputElement>('paid', '.app-translation-key-input').value = SAMPLE_KEY
    slot<HTMLButtonElement>('paid', '[data-action="saveKey"]').click()
    await flush()
    expect(calls.saveKey).toEqual([{ tier: 'paid', key: SAMPLE_KEY }])
    expect(slot('paid', '.app-translation-key-status').textContent).toBe('保存済み（Windows の資格情報マネージャー）')
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
    expect(element.querySelector('.app-translation-message')?.textContent).toBe('キーを保存しました。')
    expectNoKeyAnywhere(element)
  })

  it('キーの欄で Enter を押すとその枠のキーを保存し、設定の保存とダイアログの閉じに流れない', async () => {
    const { slot, calls, dialog } = await openDialog(settings())
    const input = slot<HTMLInputElement>('free', '.app-translation-key-input')
    input.value = SAMPLE_KEY
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(calls.saveKey).toEqual([{ tier: 'free', key: SAMPLE_KEY }])
    expect(calls.saveSettings).toEqual([])
    expect(dialog.isOpen()).toBe(true)
  })

  it('削除は押した枠だけを消す', async () => {
    const { slot, calls, element } = await openDialog(settings({ keyTiers: ['free', 'paid'] }))
    slot<HTMLButtonElement>('free', '[data-action="deleteKey"]').click()
    await flush()
    expect(calls.clearKey).toEqual(['free'])
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
    expect(slot<HTMLButtonElement>('free', '[data-action="deleteKey"]').hidden).toBe(true)
    expect(slot('paid', '.app-translation-key-status').textContent).toBe('保存済み（Windows の資格情報マネージャー）')
    expect(element.querySelector('.app-translation-message')?.textContent).toBe('キーを削除しました。')
  })

  it('英語の UI では英語の見出しと注記', async () => {
    setLanguage('en')
    const { slot, $ } = await openDialog(settings())
    expect(slot('free', '.app-translation-label').textContent).toBe(en['app.settings.translation.keyFree'])
    expect(slot('paid', '.app-translation-label').textContent).toBe(en['app.settings.translation.keyPaid'])
    expect(slot('free', '[data-notice="free"]').textContent).toBe(en['app.settings.translation.freeTierNotice'])
    expect($('.app-translation-title').textContent).toBe('Translation Settings')
  })
})

describe('legacy_key_migration（F5）', () => {
  it('以前のキーがあると「以前のキー（どちらか選んで移す）」と移す 2 つのボタンを出し、開いただけでは移さない', async () => {
    const { $, calls, slot } = await openDialog(settings({ hasLegacyKey: true }))
    const legacy = $<HTMLElement>('[data-legacy]')
    expect(legacy.hidden).toBe(false)
    expect(legacy.textContent).toContain('以前のキー（どちらか選んで移す）')
    const buttons = [...legacy.querySelectorAll<HTMLButtonElement>('[data-action="moveKey"]')]
    expect(buttons.map((button) => [button.dataset.tier, button.textContent])).toEqual([
      ['free', '無料枠用へ移す'],
      ['paid', '有料用へ移す']
    ])
    expect(calls.moveKey).toEqual([])
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
  })

  it('有料用へ移すと有料の欄が保存済みになり、以前のキーの欄は消える', async () => {
    const { $, calls, slot } = await openDialog(settings({ hasLegacyKey: true }))
    $<HTMLButtonElement>('[data-legacy] [data-action="moveKey"][data-tier="paid"]').click()
    await flush()
    expect(calls.moveKey).toEqual(['paid'])
    expect($<HTMLElement>('[data-legacy]').hidden).toBe(true)
    expect(slot('paid', '.app-translation-key-status').textContent).toBe('保存済み（Windows の資格情報マネージャー）')
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
    expect($('.app-translation-message').textContent).toBe(ja['app.settings.translation.legacyMoved'])
  })

  it('移す先にキーがあればその移すボタンは押せず、Rust が断ったら理由を出して以前のキーを残す', async () => {
    const { $ } = await openDialog(settings({ hasLegacyKey: true, keyTiers: ['free'] }))
    expect($<HTMLButtonElement>('[data-legacy] [data-tier="free"]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-legacy] [data-tier="paid"]').disabled).toBe(false)

    host.replaceChildren()
    const fake = fakePorts(settings({ hasLegacyKey: true }))
    fake.ports.moveKey = () => Promise.reject('occupied')
    const dialog = createTranslationSettings({ ports: fake.ports, host, onSaved: () => {} })
    await dialog.open()
    host.querySelector<HTMLButtonElement>('[data-legacy] [data-tier="free"]')?.click()
    await flush()
    expect(host.querySelector('.app-translation-message')?.textContent).toBe(ja['app.settings.translation.error.occupied'])
    expect(host.querySelector<HTMLElement>('[data-legacy]')?.hidden).toBe(false)
  })

  it('以前のキーが無ければ移す欄は出ない', async () => {
    const { $ } = await openDialog(settings())
    expect($<HTMLElement>('[data-legacy]').hidden).toBe(true)
  })
})

describe('key_field_cleared_after_save', () => {
  it('押した直後（答えを待つ間）に入力欄が空になる', async () => {
    const { slot, holdSaves, calls } = await openDialog(settings())
    const release = holdSaves()
    const input = slot<HTMLInputElement>('free', '.app-translation-key-input')
    input.value = SAMPLE_KEY
    slot<HTMLButtonElement>('free', '[data-action="saveKey"]').click()
    expect(input.value).toBe('')
    // 答えを待つ間はどの欄も押せない（2 度送らない）
    expect(slot<HTMLButtonElement>('free', '[data-action="saveKey"]').disabled).toBe(true)
    expect(slot<HTMLButtonElement>('paid', '[data-action="saveKey"]').disabled).toBe(true)
    release()
    await flush()
    expect(input.value).toBe('')
    expect(calls.saveKey).toHaveLength(1)
  })

  it('拒まれた後も入力欄は空のまま', async () => {
    const { slot, loseWrites } = await openDialog(settings())
    loseWrites()
    const input = slot<HTMLInputElement>('paid', '.app-translation-key-input')
    input.value = SAMPLE_KEY
    slot<HTMLButtonElement>('paid', '[data-action="saveKey"]').click()
    await flush()
    expect(input.value).toBe('')
  })

  it('取り消しと Esc で閉じると、すべての入力欄ごと捨てる', async () => {
    const opened = await openDialog(settings())
    const inputs = TIERS.map((tier) => opened.slot<HTMLInputElement>(tier, '.app-translation-key-input'))
    for (const input of inputs) input.value = SAMPLE_KEY
    opened.$<HTMLButtonElement>('[data-action="cancel"]').click()
    for (const input of inputs) expect(input.value).toBe('')
    expect(host.querySelector('dialog')).toBeNull()
    expect(opened.calls.saveKey).toEqual([])
    expect(opened.closed()).toBe(1)

    await opened.dialog.open()
    const again = [...host.querySelectorAll<HTMLInputElement>('.app-translation-key-input')]
    expect(again).toHaveLength(2)
    for (const input of again) {
      expect(input.value).toBe('')
      input.value = SAMPLE_KEY
    }
    host.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }))
    for (const input of again) expect(input.value).toBe('')
    expect(host.querySelector('dialog')).toBeNull()
    expect(opened.dialog.isOpen()).toBe(false)
  })
})

describe('key_save_failure_is_reported（F1-b）', () => {
  it('読み直しで確かめられない（notSaved）と、成功と言わず UI の言語で理由を出す', async () => {
    const { $, slot, loseWrites, element } = await openDialog(settings())
    loseWrites()
    slot<HTMLInputElement>('free', '.app-translation-key-input').value = SAMPLE_KEY
    slot<HTMLButtonElement>('free', '[data-action="saveKey"]').click()
    await flush()
    const message = $<HTMLElement>('.app-translation-message')
    expect(message.dataset.kind).toBe('error')
    expect(message.textContent).toBe(ja['app.settings.translation.error.notSaved'])
    expect(message.textContent).not.toContain(ja['app.settings.translation.keyStored'])
    expect(slot('free', '.app-translation-key-status').textContent).toBe('未設定')
    expectNoKeyAnywhere(element)
  })

  it('英語の UI では英語で出す', async () => {
    setLanguage('en')
    const { $, slot, loseWrites } = await openDialog(settings({ keyTiers: ['free'] }))
    loseWrites()
    slot<HTMLInputElement>('free', '.app-translation-key-input').value = SAMPLE_KEY
    slot<HTMLButtonElement>('free', '[data-action="saveKey"]').click()
    await flush()
    expect($('.app-translation-message').textContent).toBe(en['app.settings.translation.error.notSaved'])
    // 前のキーは残っている（Rust は違う値を消さない）。表示は読み直した有無のまま
    expect(slot('free', '.app-translation-key-status').textContent).toBe('Saved (Windows Credential Manager)')
  })

  it('Rust の誤りの名はすべて辞書の文になり、知らない名は総称の文になる', () => {
    expect(SETTINGS_ERROR_CODES).toEqual(ERROR_CODES)
    for (const code of ERROR_CODES) {
      const key = `app.settings.translation.error.${code}`
      expect(Object.hasOwn(ja, key), key).toBe(true)
      expect(Object.hasOwn(en, key), key).toBe(true)
      expect(translationErrorText(code)).toBe((ja as Record<string, string>)[key])
      expect(translationErrorText(new Error(code))).toBe((ja as Record<string, string>)[key])
    }
    expect(translationErrorText('credential manager error 5')).toBe(ja['app.settings.translation.error.unknown'])
    expect(translationErrorText(undefined)).toBe(ja['app.settings.translation.error.unknown'])
    expect(translationErrorText('__proto__')).toBe(ja['app.settings.translation.error.unknown'])
  })
})

describe('設定の保存', () => {
  const base = { enabled: false, service: 'gemini', model: 'gemini-3.1-flash-lite', fallback: true, confirm: true, machineNotice: true }

  it('選んだ値を 1 回で保存して閉じ、殻へ知らせる。無料枠か有料かは保存しない', async () => {
    const { $, calls, saved, dialog } = await openDialog(settings())
    const enable = $<HTMLInputElement>('[data-field="enabled"]')
    enable.checked = true
    enable.dispatchEvent(new Event('change'))
    // キーが無いまま有効にすると、キーが要ると出す
    expect($<HTMLElement>('[data-notice="needsKey"]').hidden).toBe(false)
    const model = $<HTMLSelectElement>('[data-field="model"]')
    model.value = 'gemini-3.6-flash'
    $<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    const choice = { ...base, enabled: true, model: 'gemini-3.6-flash' }
    expect(calls.saveSettings).toEqual([choice])
    expect(saved).toEqual([choice])
    expect(Object.hasOwn(calls.saveSettings[0], 'tier')).toBe(false)
    expect(dialog.isOpen()).toBe(false)
  })

  it('どちらかの枠にキーがあれば「キーが要る」は出ない', async () => {
    const { $ } = await openDialog(settings({ enabled: true, keyTiers: ['paid'] }))
    expect($<HTMLElement>('[data-notice="needsKey"]').hidden).toBe(true)
  })

  it('混雑のときの切り替えは保存した値で出し（既定は入）、切ると false で保存する', async () => {
    const { $, calls, saved, element } = await openDialog(settings())
    const fallback = $<HTMLInputElement>('[data-field="fallback"]')
    expect(fallback.type).toBe('checkbox')
    expect(fallback.checked).toBe(true)
    expect(element.textContent).toContain(ja['app.settings.translation.fallback'])
    expect($('[data-notice="fallback"]').textContent).toBe(ja['app.settings.translation.fallbackHint'])
    fallback.checked = false
    $<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    const choice = { ...base, fallback: false }
    expect(calls.saveSettings).toEqual([choice])
    expect(saved).toEqual([choice])

    // 切った値を読み直すと切ったまま。英語の UI は英語
    host.replaceChildren()
    setLanguage('en')
    const reopened = await openDialog(settings({ fallback: false }))
    expect(reopened.$<HTMLInputElement>('[data-field="fallback"]').checked).toBe(false)
    expect(reopened.element.textContent).toContain(en['app.settings.translation.fallback'])
  })

  it('送る前の確かめは保存した値で出し（既定は入）、切った後に入れ直すと true で保存する（F4）', async () => {
    const { $, calls, saved, element } = await openDialog(settings({ confirm: false }))
    const confirm = $<HTMLInputElement>('[data-field="confirm"]')
    expect(confirm.type).toBe('checkbox')
    expect(confirm.checked).toBe(false)
    expect(element.textContent).toContain(ja['app.settings.translation.confirm'])
    expect($('[data-notice="confirm"]').textContent).toBe(ja['app.settings.translation.confirmHint'])
    confirm.checked = true
    $<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    expect(calls.saveSettings).toEqual([base])
    expect(saved).toEqual([base])

    // 入の設定から外して保存すると false
    host.replaceChildren()
    const turnOff = await openDialog(settings())
    turnOff.$<HTMLInputElement>('[data-field="confirm"]').checked = false
    turnOff.$<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    expect(turnOff.calls.saveSettings.map((entry) => entry.confirm)).toEqual([false])

    // 値が無い（古い Rust）ときも入
    host.replaceChildren()
    const { confirm: _omitted, ...old } = settings()
    const legacy = await openDialog(old as TranslationSettings)
    expect(legacy.$<HTMLInputElement>('[data-field="confirm"]').checked).toBe(true)
  })

  it('小窓の注意書き（F5）は保存した値で出し（既定は入）、切った後に入れ直すと true で保存する', async () => {
    const { $, calls, saved, element } = await openDialog(settings({ machineNotice: false }))
    const notice = $<HTMLInputElement>('[data-field="machineNotice"]')
    expect(notice.type).toBe('checkbox')
    expect(notice.checked).toBe(false)
    expect(element.textContent).toContain('結果の小窓に注意書きを出す')
    expect($('[data-notice="machineNotice"]').textContent).toBe(ja['app.settings.translation.machineNoticeHint'])
    notice.checked = true
    $<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    expect(calls.saveSettings).toEqual([base])
    expect(saved).toEqual([base])

    host.replaceChildren()
    const turnOff = await openDialog(settings())
    expect(turnOff.$<HTMLInputElement>('[data-field="machineNotice"]').checked).toBe(true)
    turnOff.$<HTMLInputElement>('[data-field="machineNotice"]').checked = false
    turnOff.$<HTMLButtonElement>('[data-action="save"]').click()
    await flush()
    expect(turnOff.calls.saveSettings.map((entry) => entry.machineNotice)).toEqual([false])

    // 値が無い（古い Rust）ときは入。英語の UI は英語
    host.replaceChildren()
    setLanguage('en')
    const { machineNotice: _omitted, ...old } = settings()
    const legacy = await openDialog(old as TranslationSettings)
    expect(legacy.$<HTMLInputElement>('[data-field="machineNotice"]').checked).toBe(true)
    expect(legacy.element.textContent).toContain(en['app.settings.translation.machineNotice'])
  })

  it('取り消しでは保存しない', async () => {
    const { $, calls, saved } = await openDialog(settings())
    $<HTMLInputElement>('[data-field="enabled"]').checked = true
    $<HTMLButtonElement>('[data-action="cancel"]').click()
    expect(calls.saveSettings).toEqual([])
    expect(saved).toEqual([])
  })

  it('拒まれたら閉じずに理由を出す', async () => {
    const fake = fakePorts(settings())
    fake.ports.saveSettings = () => Promise.reject('settings')
    const saved: TranslationChoice[] = []
    const dialog = createTranslationSettings({ ports: fake.ports, host, onSaved: (choice) => saved.push(choice) })
    await dialog.open()
    host.querySelector<HTMLButtonElement>('[data-action="save"]')?.click()
    await flush()
    expect(dialog.isOpen()).toBe(true)
    expect(saved).toEqual([])
    expect(host.querySelector('.app-translation-message')?.textContent).toBe(ja['app.settings.translation.error.settings'])
  })

  it('設定を読めなければ、理由と取り消しだけを出す', async () => {
    const fake = fakePorts(settings())
    fake.ports.settings = () => Promise.reject('store')
    const dialog = createTranslationSettings({ ports: fake.ports, host, onSaved: () => {} })
    await dialog.open()
    expect(host.querySelector('.app-translation-message')?.textContent).toBe(ja['app.settings.translation.error.store'])
    expect(host.querySelector('[data-action="save"]')).toBeNull()
    expect(host.querySelector('.app-translation-key-input')).toBeNull()
  })

  it('2 回続けて開いても 1 つだけ出す', async () => {
    const fake = fakePorts(settings())
    const dialog = createTranslationSettings({ ports: fake.ports, host, onSaved: () => {} })
    await Promise.all([dialog.open(), dialog.open()])
    expect(host.querySelectorAll('dialog')).toHaveLength(1)
  })
})

describe('layers（F7）', () => {
  /** 操作できる要素の並び（Tab の順）。どの要素かは data の印で名指す。 */
  const tabOrder = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>('input, select, button')].map((node) => {
      if (node.dataset.field) {
        return node.dataset.field
      }
      const tier = node.dataset.tier ? `:${node.dataset.tier}` : ''
      return node.dataset.action ? `${node.dataset.action}${tier}` : `key${tier}`
    })

  it('まとまりごとに層を分ける: 一般は地のまま、無料枠・有料・以前のキー・モデルと動きはそれぞれのカード', async () => {
    const { element } = await openDialog(settings({ hasLegacyKey: true }))
    const cards = [...element.querySelectorAll<HTMLElement>('[data-card]')].map((node) => [node.dataset.card, node.classList.contains('app-translation-card')])
    expect(cards).toEqual([
      ['general', false],
      ['free', true],
      ['paid', true],
      ['legacy', true],
      ['options', true]
    ])
    const options = element.querySelector<HTMLElement>('[data-card="options"]') as HTMLElement
    for (const selector of [
      '[data-field="model"]',
      '[data-field="fallback"]',
      '[data-field="confirm"]',
      '[data-field="machineNotice"]',
      '[data-notice="fallback"]',
      '[data-notice="confirm"]',
      '[data-notice="machineNotice"]'
    ]) {
      expect(options.querySelector(selector)).not.toBeNull()
    }
    const general = element.querySelector<HTMLElement>('[data-card="general"]') as HTMLElement
    expect(general.querySelector('[data-field="enabled"]')).not.toBeNull()
    expect(general.querySelector('[data-field="service"]')).not.toBeNull()
    // 地の文の注記はカードの中に入れない
    for (const notice of ['region', 'needsKey']) {
      expect(element.querySelector(`[data-notice="${notice}"]`)?.closest('[data-card]')).toBeNull()
    }
  })

  it('キーの順（操作できる要素の並び）は F6 までと同じ', async () => {
    const { element } = await openDialog(settings({ hasLegacyKey: true }))
    expect(tabOrder(element)).toEqual([
      'enabled',
      'service',
      'key:free',
      'saveKey:free',
      'deleteKey:free',
      'key:paid',
      'saveKey:paid',
      'deleteKey:paid',
      'moveKey:free',
      'moveKey:paid',
      'model',
      'fallback',
      'confirm',
      'machineNotice',
      'save',
      'cancel'
    ])
  })
})
