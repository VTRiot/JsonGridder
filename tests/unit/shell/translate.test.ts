// 翻訳の右クリックと小窓（Step10-002 T4）。値の集め方、無効なら何も呼ばない（R6）、文書に触らない（R1）、
// 小窓は文字として出す（R9）、取り消しても訳せた行は残る（R12）、送る前の確かめ（R11、機械の推測の注記）、
// 翻訳のたびに選ぶ枠（F5。無料枠と有料のキー）と、小窓の注意書きの「今後表示しない」（F5）を確かめる。
import { afterEach, describe, expect, it } from 'vitest'
import { Mode, type ContextMenuItem, type MenuSubmenu, type RenderContextMenuContext } from '$lib/types'
import en from '../../../src/i18n/en.json'
import ja from '../../../src/i18n/ja.json'
import { format, setLanguage } from '../../../src/i18n'
import type { AskRequest, TranslateEvent, TranslateItem, TranslationPorts, TranslationSettings } from '../../../src/shell/ports'
import { collectColumn, collectValue, summarize, toRequest } from '../../../src/shell/translateCollect'
import {
  ALL_MODELS_CODES,
  availableTiers,
  confirmationNeeded,
  createTranslateFlow,
  detailText,
  FINISH_ERROR_CODES,
  finishErrorText,
  machineNoticeShown,
  modelsText,
  panelTierText,
  SWITCH_REASON_CODES,
  WAITING_CODES,
  waitingText,
  START_ERROR_CODES,
  startErrorText,
  stopsAsking,
  TARGET_LANGUAGES
} from '../../../src/shell/translateFlow'
import { createTranslateMenu, translateChoices } from '../../../src/shell/translateMenu'
import { clip, createTranslatePanel, DETAIL_MAX_CHARS, tsvField } from '../../../src/shell/translatePanel'
import modRs from '../../../src-tauri/src/translate/mod.rs?raw'
import batchRs from '../../../src-tauri/src/translate/batch.rs?raw'
import serviceRs from '../../../src-tauri/src/translate/service.rs?raw'
import storeRs from '../../../src-tauri/src/settings/store.rs?raw'

const MAILS = {
  mails: [
    { subject: 'Hello', from: { name: 'Ann' }, size: 1.5 },
    { subject: 'Re: Hello', from: { name: 'Bob' }, size: 2 },
    { subject: 'Hello', from: { name: '' }, size: null },
    { subject: '', from: { name: '   ' } },
    { subject: true, from: { name: 'Eve' } },
    7,
    ['x'],
    { subject: { nested: 'no' } }
  ],
  note: 'keep'
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function settings(fields: Partial<TranslationSettings> = {}): TranslationSettings {
  return {
    enabled: true,
    service: 'gemini',
    model: 'gemini-3.1-flash-lite',
    fallback: true,
    confirm: true,
    machineNotice: true,
    keyTiers: ['free', 'paid'],
    hasLegacyKey: false,
    services: ['gemini'],
    tiers: ['free', 'paid'],
    models: ['gemini-3.1-flash-lite'],
    ...fields
  }
}

/** Rust の command の偽物。呼ばれた回数を全部数える。知らせは試験が `emit` で送る。 */
function fakePorts(initial: TranslationSettings = settings()) {
  const state = { ...initial }
  const calls = {
    settings: 0,
    start: [] as { items: TranslateItem[]; target: string; tier: string }[],
    cancel: [] as number[],
    other: 0,
    confirms: [] as boolean[],
    machineNotices: [] as boolean[]
  }
  let listener: ((event: TranslateEvent) => void) | null = null
  let reject: string | null = null
  let rejectConfirm = false
  let rejectMachineNotice = false
  const ports: TranslationPorts = {
    settings() {
      calls.settings++
      return Promise.resolve({ ...state })
    },
    saveSettings() {
      calls.other++
      return Promise.resolve()
    },
    saveConfirm(confirm) {
      calls.confirms.push(confirm)
      if (rejectConfirm) return Promise.reject('store')
      state.confirm = confirm
      return Promise.resolve()
    },
    saveMachineNotice(shown) {
      calls.machineNotices.push(shown)
      if (rejectMachineNotice) return Promise.reject('store')
      state.machineNotice = shown
      return Promise.resolve()
    },
    saveKey() {
      calls.other++
      return Promise.resolve()
    },
    clearKey() {
      calls.other++
      return Promise.resolve()
    },
    moveKey() {
      calls.other++
      return Promise.resolve()
    },
    start(items, target, tier, onEvent) {
      calls.start.push({ items, target, tier })
      if (reject !== null) return Promise.reject(reject)
      listener = onEvent
      return Promise.resolve(calls.start.length)
    },
    cancel(job) {
      calls.cancel.push(job)
      listener?.({ kind: 'finished', job, error: 'cancelled' })
      listener = null
      return Promise.resolve(true)
    }
  }
  return {
    ports,
    calls,
    state,
    emit: (event: TranslateEvent) => listener?.(event),
    rejectStart: (code: string) => {
      reject = code
    },
    rejectConfirm: () => {
      rejectConfirm = true
    },
    rejectMachineNotice: () => {
      rejectMachineNotice = true
    }
  }
}

function setup(options: { enabled?: boolean; settings?: TranslationSettings; answers?: number[]; checks?: boolean[] } = {}) {
  const fake = fakePorts(options.settings)
  const asks: AskRequest[] = []
  /** 確かめに添えたチェックボックスの文言（チェックボックスつきの確認だけ）。 */
  const checkLabels: string[] = []
  const answers = [...(options.answers ?? [])]
  const checks = [...(options.checks ?? [])]
  const notices: string[] = []
  const copies: string[] = []
  const events = { disabled: 0, settingsOpened: 0, settingsRead: [] as string[][] }
  let enabled = options.enabled ?? true
  const panel = createTranslatePanel({
    onCancel: () => flow.cancel(),
    onResume: () => void flow.resume(),
    onClose: () => flow.reset(),
    onAddColumn: () => {},
    onHideMachineNotice: () => void flow.hideMachineNotice(),
    copy: (text) => {
      copies.push(text)
      return Promise.resolve()
    }
  })
  document.body.append(panel.element)
  const flow = createTranslateFlow({
    ports: fake.ports,
    ask: (request) => {
      asks.push(request)
      return Promise.resolve(answers.shift() ?? 0)
    },
    askChecked: ({ check, ...request }) => {
      asks.push(request)
      checkLabels.push(check)
      return Promise.resolve({ button: answers.shift() ?? 0, checked: checks.shift() ?? false })
    },
    notify: (message) => notices.push(message),
    panel,
    enabled: () => enabled,
    onDisabled: () => {
      events.disabled++
      enabled = false
    },
    openSettings: () => events.settingsOpened++,
    onSettings: (read) => events.settingsRead.push(availableTiers(read)),
    target: () => 'ja'
  })
  return { ...fake, asks, checkLabels, notices, copies, events, panel, flow, setEnabled: (next: boolean) => (enabled = next) }
}

const columnRequest = (document: unknown = MAILS, tier: string | undefined = 'free') => ({
  source: () => '列 subject',
  items: collectColumn(document, ['mails'], ['subject']),
  tier
})

afterEach(() => {
  document.body.replaceChildren()
  setLanguage('ja')
})

describe('値の集め方', () => {
  it('collect_skips_non_strings: 数、真偽値、null、空、空白だけ、オブジェクト、配列は送らない', () => {
    const doc = { a: 1, b: true, c: null, d: '', e: '  \n', f: { g: 'x' }, h: ['y'], i: 'ok' }
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'h']) {
      expect(collectValue(doc, [key]), key).toEqual([])
    }
    expect(collectValue(doc, ['i'])).toEqual([{ path: ['i'], label: 'i', text: 'ok' }])
    expect(collectValue(doc, ['missing'])).toEqual([])
    expect(collectValue(undefined, ['i'])).toEqual([])
  })

  it('collect_column_reads_all_rows: 表の対象の全行のその列を、行の番号と文書のパスつきで集める', () => {
    const items = collectColumn(MAILS, ['mails'], ['subject'])
    expect(items).toEqual([
      { path: ['mails', '0', 'subject'], label: '0', text: 'Hello' },
      { path: ['mails', '1', 'subject'], label: '1', text: 'Re: Hello' },
      { path: ['mails', '2', 'subject'], label: '2', text: 'Hello' }
    ])
    // 入れ子の列（2 段の見出しの下の段）。空と空白だけの名前は送らない
    expect(collectColumn(MAILS, ['mails'], ['from', 'name']).map((item) => [item.label, item.text])).toEqual([
      ['0', 'Ann'],
      ['1', 'Bob'],
      ['4', 'Eve']
    ])
    // 根が配列の文書（表の対象が空のパス）
    expect(collectColumn([{ s: 'a' }, { s: 'b' }], [], ['s']).map((item) => item.path)).toEqual([
      ['0', 's'],
      ['1', 's']
    ])
    // 対象が配列でない、列が空
    expect(collectColumn(MAILS, ['note'], ['subject'])).toEqual([])
    expect(collectColumn(MAILS, ['mails'], [])).toEqual([])
  })

  it('collect_dedupes: 重複を除いた件数と、コードポイントで数えた文字数', () => {
    const summary = summarize(collectColumn(MAILS, ['mails'], ['subject']))
    expect(summary).toEqual({ total: 3, unique: 2, chars: 'Hello'.length + 'Re: Hello'.length })
    // 😀 は UTF-16 で 2 単位、コードポイントで 1
    expect(summarize([{ text: '😀a' }, { text: '😀a' }])).toEqual({ total: 2, unique: 1, chars: 2 })
    // Rust へは全行を番号つきで渡し、重複は Rust が 1 回だけ送って全部の番号へ配る
    expect(toRequest([{ text: 'x' }, { text: 'x' }])).toEqual([
      { id: 0, text: 'x' },
      { id: 1, text: 'x' }
    ])
    expect(toRequest([{ text: 'y' }], [5])).toEqual([{ id: 5, text: 'y' }])
  })
})

describe('menu_hidden_when_disabled', () => {
  const upstream: ContextMenuItem[] = [{ type: 'button', text: 'Copy', onClick: () => {} }]
  const context = (fields: Partial<RenderContextMenuContext>): RenderContextMenuContext => ({
    mode: Mode.tree,
    modal: false,
    readOnly: false,
    selection: { type: 'value', path: ['note'] } as RenderContextMenuContext['selection'],
    ...fields
  })

  function menu(enabled: boolean, mode = Mode.tree, tableTarget: string[] = [], tiers: string[] = ['free', 'paid']) {
    const host = document.createElement('div')
    const main = document.createElement('div')
    main.className = 'jse-main'
    const th = document.createElement('th')
    th.dataset.columnPath = encodeURIComponent('/subject')
    main.append(th)
    host.append(main)
    document.body.append(host)
    const picked: { column: string[][]; value: string[][]; tiers: (string | undefined)[] } = { column: [], value: [], tiers: [] }
    const created = createTranslateMenu({
      host,
      enabled: () => enabled,
      hasOpenModal: () => false,
      mode: () => mode,
      tableTarget: () => tableTarget,
      document: () => MAILS,
      tiers: () => tiers,
      onColumn: (column, tier) => {
        picked.column.push(column)
        picked.tiers.push(tier)
      },
      onValue: (path, tier) => {
        picked.value.push(path)
        picked.tiers.push(tier)
      }
    })
    return { created, th, picked }
  }

  it('無効のとき、セルとツリーの右クリックは上流の項目のまま', () => {
    const { created } = menu(false)
    expect(created.renderContextMenu(upstream, context({}))).toBe(upstream)
    expect(created.renderContextMenu(upstream, context({ mode: Mode.table, selection: { type: 'value', path: ['0', 'subject'] } as never }))).toBe(upstream)
  })

  it('無効のとき、見出しの右クリックは止めず（上流のまま）、殻のメニューも出さない', () => {
    const { th, picked } = menu(false, Mode.table, ['mails'])
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    th.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('.app-translate-context-menu')).toBeNull()
    expect(picked.column).toEqual([])
  })

  /** 見出しの右クリックで出た殻のメニューの親の項目（「日本語に翻訳」）。 */
  const parentItem = () => document.querySelector<HTMLButtonElement>('.app-translate-context-menu .app-menu-item')
  /** 開いたサブメニューの項目の [枠, 名]。 */
  const subItems = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.app-translate-submenu .app-menu-item')].map((item) => [
      item.dataset.tier,
      item.querySelector('.app-menu-label')?.textContent,
      item.classList.contains(`app-translate-tier-${item.dataset.tier}`)
    ])
  const key = (target: Element, name: string) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  it('有効のとき、見出しの右クリックで殻のメニューに「日本語に翻訳」を 1 つ出し、サブメニューの有料・無料の押した枠でその列を訳す', () => {
    const { th, picked } = menu(true, Mode.table, ['mails'])
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    th.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const items = [...document.querySelectorAll<HTMLButtonElement>('.app-translate-context-menu .app-menu-item')]
    expect(items.map((item) => item.querySelector('.app-menu-label')?.textContent)).toEqual(['日本語に翻訳'])
    expect(items[0].getAttribute('aria-haspopup')).toBe('menu')
    expect(items[0].getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.app-translate-submenu')).toBeNull()
    items[0].click()
    expect(items[0].getAttribute('aria-expanded')).toBe('true')
    expect(subItems()).toEqual([
      ['paid', '有料', true],
      ['free', '無料', true]
    ])
    // 押すとサブメニューの先頭へフォーカス
    expect(document.activeElement?.textContent).toContain('有料')
    document.querySelector<HTMLButtonElement>('.app-translate-submenu .app-menu-item[data-tier="paid"]')?.click()
    expect(picked.column).toEqual([['subject']])
    expect(picked.tiers).toEqual(['paid'])
    expect(document.querySelector('.app-translate-context-menu')).toBeNull()
    expect(document.querySelector('.app-translate-submenu')).toBeNull()
  })

  it('キー: → と Enter でサブメニューを開いて先頭へ、↓↑ で動き、← と Esc でサブメニューだけ閉じて親へ戻る', () => {
    const { th, picked } = menu(true, Mode.table, ['mails'])
    th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const parent = parentItem() as HTMLButtonElement
    expect(document.activeElement).toBe(parent)
    expect(key(parent, 'ArrowRight').defaultPrevented).toBe(true)
    const sub = () => document.querySelector<HTMLElement>('.app-translate-submenu')
    expect(sub()).not.toBeNull()
    expect((document.activeElement as HTMLElement).dataset.tier).toBe('paid')
    key(document.activeElement as Element, 'ArrowDown')
    expect((document.activeElement as HTMLElement).dataset.tier).toBe('free')
    key(document.activeElement as Element, 'ArrowDown') // 端で反対へ回る
    expect((document.activeElement as HTMLElement).dataset.tier).toBe('paid')
    key(document.activeElement as Element, 'ArrowUp')
    expect((document.activeElement as HTMLElement).dataset.tier).toBe('free')
    key(document.activeElement as Element, 'ArrowLeft')
    expect(sub()).toBeNull()
    expect(document.activeElement).toBe(parent)
    expect(parent.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.app-translate-context-menu')).not.toBeNull()
    // Enter でも開き、Esc はサブメニューだけ閉じる。もう一度の Esc でメニューごと閉じる
    key(parent, 'Enter')
    expect((document.activeElement as HTMLElement).dataset.tier).toBe('paid')
    key(document.activeElement as Element, 'Escape')
    expect(sub()).toBeNull()
    expect(document.activeElement).toBe(parent)
    expect(document.querySelector('.app-translate-context-menu')).not.toBeNull()
    key(parent, 'Escape')
    expect(document.querySelector('.app-translate-context-menu')).toBeNull()
    expect(picked.column).toEqual([])
  })

  it('見出しのサブメニューはキーのある枠だけ。1 つでもサブメニュー。どの枠にも無ければサブメニューの無い項目（押すとキーの設定へ）', () => {
    for (const [tiers, expected] of [
      [['free', 'paid'], [['paid', '有料', true], ['free', '無料', true]]],
      [['free'], [['free', '無料', true]]],
      [['paid'], [['paid', '有料', true]]]
    ] as [string[], [string, string, boolean][]][]) {
      const { th, picked } = menu(true, Mode.table, ['mails'], tiers)
      th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      // 1 つだけでもサブメニューの親（印と aria-haspopup）
      expect(parentItem()?.getAttribute('aria-haspopup'), tiers.join()).toBe('menu')
      expect(parentItem()?.querySelector('.app-menu-shortcut')?.textContent, tiers.join()).toBe('▸')
      parentItem()?.click()
      expect(subItems(), tiers.join()).toEqual(expected)
      document.querySelector<HTMLButtonElement>('.app-translate-submenu .app-menu-item')?.click()
      expect(picked.tiers).toEqual([expected[0][0]])
      document.body.replaceChildren()
    }
    const { th, picked } = menu(true, Mode.table, ['mails'], [])
    th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const only = parentItem() as HTMLButtonElement
    expect(only.querySelector('.app-menu-label')?.textContent).toBe('日本語に翻訳')
    expect(only.hasAttribute('aria-haspopup')).toBe(false)
    only.click()
    expect(document.querySelector('.app-translate-submenu')).toBeNull()
    expect(picked.column).toEqual([['subject']])
    expect(picked.tiers).toEqual([undefined])
  })

  it('見出しのメニューの外を押すと、メニューもサブメニューも閉じる。サブメニューの中の押下では閉じない', () => {
    menu(true, Mode.table, ['mails']).th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    parentItem()?.click()
    const sub = document.querySelector('.app-translate-submenu') as HTMLElement
    sub.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.app-translate-submenu')).not.toBeNull()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.querySelector('.app-translate-context-menu')).toBeNull()
    expect(document.querySelector('.app-translate-submenu')).toBeNull()
  })

  it('有効のとき、送れる値にだけ「日本語に翻訳」のサブメニューを足す（表のパスは対象の後ろへつなぐ）。モーダルとテキストには足さない', () => {
    const { created, picked } = menu(true, Mode.table, ['mails'])
    const added = created.renderContextMenu(upstream, context({ mode: Mode.table, selection: { type: 'value', path: ['1', 'subject'] } as never }))
    expect(added.slice(0, 1)).toEqual(upstream)
    expect(added[1]).toEqual({ type: 'separator' })
    expect(added).toHaveLength(3)
    const submenu = added[2] as MenuSubmenu
    expect(submenu.type).toBe('submenu')
    expect(submenu.text).toBe('日本語に翻訳')
    expect(submenu.items.map((button) => [button.text, button.className])).toEqual([
      ['有料', 'app-translate-context-tier app-translate-tier-paid'],
      ['無料', 'app-translate-context-tier app-translate-tier-free']
    ])
    submenu.items[1].onClick(new MouseEvent('click'))
    expect(picked.value).toEqual([['mails', '1', 'subject']])
    expect(picked.tiers).toEqual(['free'])
    // 数、空の文字列、オブジェクトの値には出さない
    for (const path of [['0', 'size'], ['3', 'subject'], ['0', 'from']]) {
      expect(created.renderContextMenu(upstream, context({ mode: Mode.table, selection: { type: 'value', path } as never }))).toBe(upstream)
    }
    expect(created.renderContextMenu(upstream, context({ modal: true }))).toBe(upstream)
    expect(created.renderContextMenu(upstream, context({ mode: Mode.text }))).toBe(upstream)
    expect(created.renderContextMenu(upstream, context({ selection: undefined }))).toBe(upstream)
  })

  it('セルとツリーのサブメニューもキーのある枠だけ。1 つでもサブメニュー。どの枠にも無ければサブメニューの無い項目を 1 つ', () => {
    const only = menu(true, Mode.tree, [], ['paid']).created.renderContextMenu(upstream, context({}))
    expect((only[2] as MenuSubmenu).items.map((item) => item.text)).toEqual(['有料'])
    const free = menu(true, Mode.tree, [], ['free']).created.renderContextMenu(upstream, context({}))
    expect((free[2] as MenuSubmenu).items.map((item) => item.text)).toEqual(['無料'])
    const none = menu(true, Mode.tree, [], [])
    const noneItems = none.created.renderContextMenu(upstream, context({}))
    expect(noneItems[2]).toMatchObject({ type: 'button', text: '日本語に翻訳' })
    ;(noneItems[2] as { onClick: (event: MouseEvent) => void }).onClick(new MouseEvent('click'))
    expect(none.picked.tiers).toEqual([undefined])
    // 知らない枠は項目にしない。並びは有料、無料
    expect(translateChoices(['free', 'gold']).map((choice) => choice.tier)).toEqual(['free'])
    expect(translateChoices(['free', 'paid']).map((choice) => choice.tier)).toEqual(['paid', 'free'])
    expect(translateChoices(['gold'])).toEqual([])
  })

  it('英語の UI では「Translate to English」と「Paid」「Free」', () => {
    setLanguage('en')
    const { created } = menu(true, Mode.tree)
    const added = created.renderContextMenu(upstream, context({}))
    expect((added[2] as MenuSubmenu).text).toBe('Translate to English')
    expect((added[2] as MenuSubmenu).items.map((item) => item.text)).toEqual(['Paid', 'Free'])
    const header = menu(true, Mode.table, ['mails'])
    header.th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(parentItem()?.querySelector('.app-menu-label')?.textContent).toBe('Translate to English')
    parentItem()?.click()
    expect(subItems().map((item) => item[1])).toEqual(['Paid', 'Free'])
  })
})

describe('no_invoke_when_disabled', () => {
  it('殻が無効と知っていれば、設定も読まず、仕事も始めず、確かめも出さない', async () => {
    const { calls, asks, flow, panel } = setup({ enabled: false })
    await flow.request(columnRequest())
    await flow.resume()
    expect(calls).toEqual({ settings: 0, start: [], cancel: [], other: 0, confirms: [], machineNotices: [] })
    expect(asks).toEqual([])
    expect(panel.isOpen()).toBe(false)
  })

  it('設定ファイルで無効なら、仕事を始めず、殻の値を合わせて理由を出す', async () => {
    const { calls, asks, flow, events, notices } = setup({ settings: settings({ enabled: false }) })
    await flow.request(columnRequest())
    expect(calls.start).toEqual([])
    expect(asks).toEqual([])
    expect(events.disabled).toBe(1)
    expect(notices).toEqual([ja['app.translate.error.disabled']])
  })

  it('キーが無ければ、仕事を始めず、設定のダイアログを開く', async () => {
    const { calls, flow, events, notices } = setup({ settings: settings({ keyTiers: [] }) })
    await flow.request(columnRequest())
    expect(calls.start).toEqual([])
    expect(events.settingsOpened).toBe(1)
    expect(notices).toEqual([ja['app.translate.error.noKey']])
  })

  it('送る値が無ければ、Rust を呼ばずに知らせる', async () => {
    const { calls, flow, notices } = setup()
    await flow.request({ source: () => '', items: [] })
    expect(calls.settings).toBe(0)
    expect(calls.start).toEqual([])
    expect(notices).toEqual([ja['app.translate.nothing']])
  })
})

describe('送る前の確かめ', () => {
  it('件数、重複を除いた件数、文字数、サービス、モデル、無料枠の注記、機械の推測の注記を出し、既定は取り消し', async () => {
    const { asks, calls, flow } = setup({ answers: [1] })
    await flow.request(columnRequest())
    expect(asks).toHaveLength(1)
    const [ask] = asks
    expect(ask.body).toContain('列 subject の 3 件（重複を除くと 2 件、14 文字）')
    expect(ask.body).toContain('Google Gemini（モデル gemini-3.1-flash-lite）へ無料枠用のキーで送って翻訳します。')
    expect(ask.body).toContain(ja['app.dialog.translateFreeTierWarning'])
    expect(ask.body).toContain(ja['app.translate.machineNotice'])
    expect(ask.level).toBe('warning')
    expect(ask.buttons[ask.default]).toBe(ja['app.dialog.cancel'])
    expect(ask.cancel).toBe(ask.default)
    // 取り消したので送らない
    expect(calls.start).toEqual([])
  })

  it('有料では無料枠の注記を出さず、機械の推測の注記は出す。英語の UI は英語', async () => {
    setLanguage('en')
    const { asks, flow } = setup({ answers: [1] })
    await flow.request(columnRequest(MAILS, 'paid'))
    expect(asks[0].body).toContain('with the key for: Paid.')
    expect(asks[0].body).not.toContain(en['app.dialog.translateFreeTierWarning'])
    expect(asks[0].body).toContain(en['app.translate.machineNotice'])
    expect(asks[0].level).toBe('info')
  })

  it('送ると、全行を番号つきで UI の言語へ送る', async () => {
    const { calls, flow } = setup()
    await flow.request(columnRequest())
    expect(calls.start).toEqual([
      {
        target: 'ja',
        tier: 'free',
        items: [
          { id: 0, text: 'Hello' },
          { id: 1, text: 'Re: Hello' },
          { id: 2, text: 'Hello' }
        ]
      }
    ])
  })
})

describe('確かめの「今後表示しない」（F4）', () => {
  it('confirmationNeeded: 切ってあるときだけ出さない。値が無い（古い Rust）、真偽でないときは出す', () => {
    expect(confirmationNeeded({ confirm: true })).toBe(true)
    expect(confirmationNeeded({ confirm: false })).toBe(false)
    expect(confirmationNeeded({} as never)).toBe(true)
    expect(confirmationNeeded({ confirm: 'no' } as never)).toBe(true)
    expect(confirmationNeeded({ confirm: null } as never)).toBe(true)
  })

  it('stopsAsking: 入れて「送る」を押したときだけ切る。取り消し、外したまま、真偽でない値では切らない', () => {
    expect(stopsAsking({ button: 0, checked: true })).toBe(true)
    expect(stopsAsking({ button: 0, checked: false })).toBe(false)
    expect(stopsAsking({ button: 1, checked: true })).toBe(false)
    expect(stopsAsking({ button: 1, checked: false })).toBe(false)
    expect(stopsAsking({ button: 0, checked: 'true' } as never)).toBe(false)
  })

  it('確かめに「今後表示しない」を添え、既定とEsc は取り消しのまま', async () => {
    const { asks, checkLabels, flow } = setup({ answers: [1] })
    await flow.request(columnRequest())
    expect(checkLabels).toEqual([ja['app.dialog.translateDontAskAgain']])
    expect(asks[0].buttons[asks[0].default]).toBe(ja['app.dialog.cancel'])
    expect(asks[0].cancel).toBe(asks[0].default)
  })

  it('入れて送ると設定を切って送り、次からは確かめずに送る', async () => {
    const { asks, calls, flow, emit, state } = setup({ answers: [0], checks: [true] })
    await flow.request(columnRequest())
    expect(calls.confirms).toEqual([false])
    expect(state.confirm).toBe(false)
    expect(calls.start).toHaveLength(1)
    emit({ kind: 'finished', job: 1, error: null })
    await flow.request(columnRequest())
    await flush()
    expect(asks).toHaveLength(1) // 2 回目は確かめを出さない
    expect(calls.start).toHaveLength(2)
    expect(calls.confirms).toEqual([false]) // 2 回目は保存もしない
  })

  it('入れて取り消すと、設定を替えず送らない。次も確かめる', async () => {
    const { asks, calls, flow, state } = setup({ answers: [1, 1], checks: [true, false] })
    await flow.request(columnRequest())
    expect(calls.confirms).toEqual([])
    expect(state.confirm).toBe(true)
    expect(calls.start).toEqual([])
    await flow.request(columnRequest())
    expect(asks).toHaveLength(2)
  })

  it('外したまま送ると、設定を替えず送る。次も確かめる', async () => {
    const { asks, calls, flow, emit } = setup({ answers: [0, 1], checks: [false] })
    await flow.request(columnRequest())
    expect(calls.confirms).toEqual([])
    expect(calls.start).toHaveLength(1)
    emit({ kind: 'finished', job: 1, error: null })
    await flow.request(columnRequest())
    expect(asks).toHaveLength(2)
  })

  it('切ってある設定では、続きを訳すも確かめずに送る', async () => {
    const { asks, calls, flow, emit, panel } = setup({ settings: settings({ confirm: false }) })
    await flow.request(columnRequest())
    expect(asks).toEqual([])
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }] })
    flow.cancel()
    await flush()
    expect(panel.resumableIds().length).toBeGreaterThan(0)
    await flow.resume()
    expect(asks).toEqual([])
    expect(calls.start).toHaveLength(2)
  })

  it('保存できなければ今回は送り、保存できなかったことを知らせる', async () => {
    const fake = setup({ answers: [0], checks: [true] })
    fake.rejectConfirm()
    await fake.flow.request(columnRequest())
    expect(fake.calls.confirms).toEqual([false])
    expect(fake.calls.start).toHaveLength(1)
    expect(fake.notices).toEqual([ja['app.translate.confirmNotSaved']])
    expect(fake.state.confirm).toBe(true)
  })
})

describe('translation_leaves_document_unchanged', () => {
  it('集めて、送って、訳を小窓に出しても、文書は 1 か所も変わらない', async () => {
    const doc = deepFreeze(structuredClone(MAILS))
    const before = JSON.stringify(doc)
    const { flow, emit, panel } = setup()
    // 凍らせた文書に書けば例外になる。流れが文書を受け取らない（集めた文字列だけ）ことも見る
    await flow.request(columnRequest(doc))
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }, { id: 1, text: 'Re: こんにちは' }, { id: 2, text: 'こんにちは' }] })
    emit({ kind: 'finished', job: 1, error: null })
    expect(panel.rows().map((row) => row.translation)).toEqual(['こんにちは', 'Re: こんにちは', 'こんにちは'])
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe('panel_renders_text_not_html', () => {
  it('原文と訳に HTML があっても、要素にならず文字として出る', async () => {
    const injected = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    const { flow, emit, panel } = setup()
    await flow.request({ source: () => injected, items: [{ path: ['a'], label: injected, text: injected }], tier: 'free' })
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: `<b>${injected}</b>` }] })
    const element = panel.element
    expect(element.querySelector('img, script, b')).toBeNull()
    expect(element.querySelector('.app-translate-original')?.textContent).toBe(injected)
    expect(element.querySelector('.app-translate-translation')?.textContent).toBe(`<b>${injected}</b>`)
    expect(element.querySelector('.app-translate-place')?.textContent).toBe(injected)
    expect(element.querySelector('.app-translate-source')?.textContent).toBe(injected)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})

describe('cancel_keeps_done_rows', () => {
  it('取り消しても訳せた行は残り、残りは未翻訳で、続きを訳すは未翻訳の分だけ送る', async () => {
    const { flow, emit, panel, calls, asks } = setup()
    await flow.request(columnRequest())
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }, { id: 2, text: 'こんにちは' }] })
    expect(panel.element.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.hidden).toBe(false)
    panel.element.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
    await flush()
    expect(calls.cancel).toEqual([1])
    expect(panel.rows().map((row) => row.status)).toEqual(['done', 'pending', 'done'])
    expect(panel.rows()[0].translation).toBe('こんにちは')
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toBe(ja['app.translate.panel.cancelled'])
    expect(panel.element.querySelector('.app-translate-count')?.textContent).toBe('2 / 3 件')
    const resume = panel.element.querySelector<HTMLButtonElement>('[data-action="resume"]')
    expect(resume?.hidden).toBe(false)
    // 取り消した後の知らせは小窓に出さない
    emit({ kind: 'translated', job: 1, results: [{ id: 1, text: '遅れた訳' }] })
    expect(panel.rows()[1].status).toBe('pending')

    resume?.click()
    await flush()
    expect(asks).toHaveLength(2) // 送る前の確かめをもう一度出す
    expect(asks[1].body).toContain('の 1 件（重複を除くと 1 件、9 文字）')
    expect(calls.start[1].items).toEqual([{ id: 1, text: 'Re: Hello' }])
    emit({ kind: 'translated', job: 2, results: [{ id: 1, text: 'Re: こんにちは' }] })
    emit({ kind: 'finished', job: 2, error: null })
    expect(panel.rows().map((row) => row.status)).toEqual(['done', 'done', 'done'])
    expect(panel.element.querySelector<HTMLButtonElement>('[data-action="resume"]')?.hidden).toBe(true)
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toBe(ja['app.translate.panel.finished'])
  })

  it('途中の失敗（回数の上限）でも訳せた行は残り、理由を UI の言語で出す。行ごとの失敗は状態に出る', async () => {
    const { flow, emit, panel } = setup()
    await flow.request(columnRequest())
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }] })
    emit({ kind: 'failed', job: 1, ids: [2], reason: 'blocked' })
    emit({ kind: 'waiting', job: 1, seconds: 5 })
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toContain('5 秒')
    emit({ kind: 'finished', job: 1, error: 'quota' })
    expect(panel.rows().map((row) => row.status)).toEqual(['done', 'pending', 'blocked'])
    const message = panel.element.querySelector<HTMLElement>('.app-translate-message')
    expect(message?.textContent).toBe(ja['app.translate.error.quota'])
    expect(message?.dataset.kind).toBe('error')
    // 拒まれた行は送り直さない。未翻訳だけ
    expect(panel.resumableIds()).toEqual([1])
  })

  it('仕事を始められなければ、理由を小窓に出し、行は未翻訳のまま', async () => {
    const { flow, panel, rejectStart, events } = setup()
    rejectStart('disabled')
    await flow.request(columnRequest())
    await flush()
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toBe(ja['app.translate.error.disabled'])
    expect(panel.rows().every((row) => row.status === 'pending')).toBe(true)
    expect(flow.running()).toBe(false)
    expect(events.disabled).toBe(1)
  })

  it('動いている間に別の翻訳を頼むと止めるかを聞き、断れば今の仕事を続ける', async () => {
    const { flow, calls, asks, panel } = setup({ answers: [0, 1] })
    await flow.request(columnRequest())
    await flow.request({ source: () => '値 note', items: collectValue(MAILS, ['note']), tier: 'free' })
    expect(asks[1].title).toBe(ja['app.dialog.translateBusyTitle'])
    expect(calls.cancel).toEqual([])
    expect(flow.running()).toBe(true)
    expect(panel.rows()).toHaveLength(3)
  })

  it('文書が替わると、仕事を取り消して小窓を閉じる', async () => {
    const { flow, calls, panel } = setup()
    await flow.request(columnRequest())
    flow.reset()
    expect(calls.cancel).toEqual([1])
    expect(panel.isOpen()).toBe(false)
    expect(flow.running()).toBe(false)
  })
})

describe('コピー', () => {
  it('行の訳、訳の並び（行を揃える）、原文と訳のタブ区切り（タブと改行と引用符は囲む）', async () => {
    const { flow, emit, panel, copies } = setup()
    await flow.request({
      source: () => 's',
      items: [
        { path: ['0'], label: '0', text: 'a\tb' },
        { path: ['1'], label: '1', text: 'c' },
        { path: ['2'], label: '2', text: 'say "hi"' }
      ],
      tier: 'free'
    })
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'A\nB' }, { id: 2, text: '「やあ」' }] })
    panel.element.querySelectorAll<HTMLButtonElement>('[data-action="copyOne"]')[0].click()
    panel.element.querySelector<HTMLButtonElement>('[data-action="copyAll"]')?.click()
    panel.element.querySelector<HTMLButtonElement>('[data-action="copyPairs"]')?.click()
    await flush()
    expect(copies).toEqual(['A\nB', 'A\nB\n\n「やあ」', '"a\tb"\t"A\nB"\nc\t\n"say ""hi"""\t「やあ」'])
    expect(panel.element.querySelector('.app-translate-copied')?.textContent).toBe(ja['app.translate.panel.copied'])
    expect(tsvField('plain')).toBe('plain')
  })
})

describe('誤りの名と辞書', () => {
  /** Rust の `fn code` の `=> "名"` を、その impl の中から全部拾う。 */
  function codesIn(source: string, owner: string): string[] {
    const start = source.indexOf(`impl ${owner} {`)
    expect(start, owner).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    return [...body.matchAll(/=> "(\w+)"/g)].map((match) => match[1])
  }

  it('Rust の仕事を始めない理由（StartError と PlanError）はすべて辞書の文になる', () => {
    const rust = [...codesIn(modRs, 'StartError'), ...codesIn(batchRs, 'PlanError')]
    expect(rust.length).toBeGreaterThan(0)
    expect([...START_ERROR_CODES].sort()).toEqual([...new Set(rust)].sort())
    for (const code of START_ERROR_CODES) {
      expect(startErrorText(code), code).not.toBe(ja['app.translate.error.unknown'])
    }
    expect(startErrorText('nope')).toBe(ja['app.translate.error.unknown'])
  })

  it('Rust の止まった理由（ErrorKind）はすべて辞書の文になる', () => {
    const start = serviceRs.indexOf('pub enum ErrorKind {')
    const body = serviceRs.slice(start, serviceRs.indexOf('}', start))
    const variants = [...body.matchAll(/^\s+(\w+),/gm)].map((match) => match[1].charAt(0).toLowerCase() + match[1].slice(1))
    expect(variants.length).toBeGreaterThan(0)
    expect([...FINISH_ERROR_CODES].sort()).toEqual([...variants].sort())
    for (const code of FINISH_ERROR_CODES) {
      expect(finishErrorText(code), code).not.toBe(ja['app.translate.error.unknown'])
    }
  })

  it('翻訳先の言語の一覧は Rust の言語の一覧と同じ', () => {
    const match = /pub const LANGUAGES: \[&str; \d+\] = \[([^\]]*)\]/.exec(storeRs)
    expect(match).not.toBeNull()
    const rust = [...(match?.[1] ?? '').matchAll(/"(\w+)"/g)].map((item) => item[1])
    expect([...TARGET_LANGUAGES].sort()).toEqual(rust.sort())
  })
})

describe('小窓の言語', () => {
  it('言語を替えると、見出し、注記、状態、ボタンを引き直す', async () => {
    const { flow, panel } = setup()
    await flow.request(columnRequest())
    expect(panel.element.querySelector('.app-translate-machine-text')?.textContent).toBe(ja['app.translate.machineNotice'])
    expect(panel.element.querySelector('[data-action="hideMachineNotice"]')?.textContent).toBe(ja['app.translate.machineNoticeHide'])
    expect(panel.element.querySelector('.app-translate-tier')?.textContent).toBe(ja['app.translate.panel.tierFree'])
    setLanguage('en')
    panel.refresh()
    expect(panel.element.querySelector('.app-translate-title')?.textContent).toBe(en['app.translate.panel.title'])
    expect(panel.element.querySelector('.app-translate-machine-text')?.textContent).toBe(en['app.translate.machineNotice'])
    expect(panel.element.querySelector('[data-action="hideMachineNotice"]')?.textContent).toBe(en['app.translate.machineNoticeHide'])
    expect(panel.element.querySelector('.app-translate-tier')?.textContent).toBe(en['app.translate.panel.tierFree'])
    expect(panel.element.querySelector('.app-translate-status')?.textContent).toBe(en['app.translate.panel.status.pending'])
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toBe(en['app.translate.panel.running'])
  })
})

describe('モデルの切り替え（F3）', () => {
  const A = 'gemini-3.1-flash-lite'
  const B = 'gemini-3.5-flash-lite'
  const BUSY = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
  const text = (panel: { element: HTMLElement }, selector: string) => panel.element.querySelector<HTMLElement>(selector)

  it('切り替えたら、どのモデルの訳かを使ったモデルの行と各行に出す', async () => {
    const { flow, emit, panel } = setup()
    await flow.request(columnRequest())
    emit({ kind: 'translated', job: 1, model: A, results: [{ id: 0, text: 'こんにちは' }] })
    expect(text(panel, '.app-translate-models')?.textContent).toBe(`使ったモデル: ${A}`)
    // 1 つのモデルだけなら行ごとのモデルは出さない
    expect(text(panel, '.app-translate-model')?.hidden).toBe(true)
    emit({ kind: 'waiting', job: 1, seconds: 2, reason: 'overloaded', model: A })
    expect(text(panel, '.app-translate-message')?.textContent).toBe(`${A} が混雑しています。2 秒待ってから送り直します。`)
    emit({ kind: 'switched', job: 1, from: A, to: B, reason: 'overloaded' })
    expect(text(panel, '.app-translate-message')?.textContent).toBe(`残りを ${B} で送ります（${A} が混雑していたため）。`)
    emit({ kind: 'translated', job: 1, model: B, results: [{ id: 1, text: 'Re: こんにちは' }, { id: 2, text: 'こんにちは' }] })
    emit({ kind: 'finished', job: 1, error: null, detail: null })
    expect(text(panel, '.app-translate-models')?.textContent).toBe(`使ったモデル: ${A}、${B}（${A} が混雑していたため）`)
    const shown = [...panel.element.querySelectorAll<HTMLElement>('.app-translate-model')].map((element) => [element.textContent, element.hidden])
    expect(shown).toEqual([[A, false], [B, false], [B, false]])
    expect(panel.rows().map((row) => row.model)).toEqual([A, B, B])
    expect(text(panel, '.app-translate-message')?.textContent).toBe(ja['app.translate.panel.finished'])
    expect(text(panel, '.app-translate-detail')?.hidden).toBe(true)
    // 英語の UI は英語で引き直す
    setLanguage('en')
    panel.refresh()
    expect(text(panel, '.app-translate-models')?.textContent).toBe(`Model used: ${A}, ${B} (because ${A} was busy)`)
  })

  it('混雑で止まったら、原因と次にすることを出し、Google の文を詳しい行に出す', async () => {
    const { flow, emit, panel } = setup()
    await flow.request(columnRequest())
    emit({ kind: 'finished', job: 1, error: 'overloaded', detail: { status: 'UNAVAILABLE', message: BUSY } })
    const message = text(panel, '.app-translate-message')
    expect(message?.textContent).toBe(format('app.translate.error.overloaded', { model: A }))
    expect(message?.textContent).toContain(A)
    expect(message?.textContent).toContain('翻訳の設定')
    expect(message?.dataset.kind).toBe('error')
    const detail = text(panel, '.app-translate-detail')
    expect(detail?.hidden).toBe(false)
    expect(detail?.textContent).toBe(`Google の説明: UNAVAILABLE: ${BUSY}`)
    // 次の仕事を始めると詳しい行は消える
    panel.element.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click()
    await flush()
    expect(text(panel, '.app-translate-detail')?.hidden).toBe(true)
  })

  it('切り替えた先も混雑なら「どのモデルも混雑」、上限なら「どのモデルも上限」', async () => {
    for (const [reason, key] of [['overloaded', 'app.translate.error.allOverloaded'], ['quota', 'app.translate.error.allQuota']]) {
      const { flow, emit, panel } = setup()
      await flow.request(columnRequest())
      emit({ kind: 'switched', job: 1, from: A, to: B, reason })
      emit({ kind: 'finished', job: 1, error: reason, detail: { status: 'X', message: 'm' } })
      expect(text(panel, '.app-translate-message')?.textContent, reason).toBe(ja[key as keyof typeof ja])
      document.body.replaceChildren()
    }
  })

  it('Google の文は文字として出し、長さを切る。キーや本文の欄は持たない', async () => {
    const { flow, emit, panel } = setup()
    await flow.request(columnRequest())
    const injected = '<img src=x onerror="window.__pwned=3">'
    emit({ kind: 'finished', job: 1, error: 'key', detail: { status: 'INVALID_ARGUMENT', message: injected + 'x'.repeat(DETAIL_MAX_CHARS * 2) } })
    const detail = text(panel, '.app-translate-detail')
    expect(panel.element.querySelector('.app-translate-detail img')).toBeNull()
    expect(detail?.textContent?.startsWith(`Google の説明: INVALID_ARGUMENT: ${injected}`)).toBe(true)
    expect([...(detail?.textContent ?? '')].length).toBe(DETAIL_MAX_CHARS)
    expect(detail?.textContent?.endsWith('…')).toBe(true)
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(text(panel, '.app-translate-message')?.textContent).toBe(ja['app.translate.error.key'])
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcd', 3)).toBe('ab…')
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…')
  })

  it('詳しい行は status と message のある方だけで作り、どちらも無ければ出さない', () => {
    expect(detailText(null)).toBeNull()
    expect(detailText(undefined)).toBeNull()
    expect(detailText({ status: '', message: '' })).toBeNull()
    expect(detailText({ status: 'UNAVAILABLE', message: '' })).toBe('Google の説明: UNAVAILABLE')
    expect(detailText({ status: '', message: 'network error 12007' })).toBe('Google の説明: network error 12007')
  })

  it('原因ごとに別の文で、次にすることを言う（日本語と英語）', () => {
    const actions: Record<string, string[]> = {
      overloaded: ['時間をおいて', '翻訳の設定'],
      quota: ['太平洋時間', '有料用のキー'],
      key: ['Google AI Studio', '入れ直して'],
      permission: ['Gemini API が有効でない', '地域'],
      model: ['選び直して'],
      network: ['インターネット', 'プロキシ']
    }
    for (const [code, words] of Object.entries(actions)) {
      const shown = finishErrorText(code, A)
      for (const word of words) {
        expect(shown, code).toContain(word)
      }
      expect(shown, code).not.toContain('{{')
    }
    const texts = FINISH_ERROR_CODES.map((code) => finishErrorText(code, A))
    expect(new Set(texts).size).toBe(texts.length)
    setLanguage('en')
    for (const code of FINISH_ERROR_CODES) {
      expect(finishErrorText(code, A), code).not.toBe(en['app.translate.error.unknown'])
      expect(finishErrorText(code, A), code).not.toContain('{{')
    }
  })

  it('安全のために拒まれた行があれば、終わりの文でそう言う', async () => {
    const { flow, emit, panel } = setup()
    await flow.request(columnRequest())
    emit({ kind: 'translated', job: 1, model: A, results: [{ id: 0, text: 'a' }, { id: 1, text: 'b' }] })
    emit({ kind: 'failed', job: 1, ids: [2], reason: 'blocked' })
    emit({ kind: 'finished', job: 1, error: null, detail: null })
    expect(text(panel, '.app-translate-message')?.textContent).toBe(ja['app.translate.panel.finishedBlocked'])
    expect(text(panel, '.app-translate-row[data-status="blocked"] .app-translate-status')?.textContent).toBe('安全のための判定で拒まれた')
  })

  it('待つ理由、切り替えの理由、全部を試した文の辞書のキーは日本語と英語の両方にある', () => {
    const keys = [
      ...ALL_MODELS_CODES.map((code) => `app.translate.error.all${code.charAt(0).toUpperCase()}${code.slice(1)}`),
      ...WAITING_CODES.map((code) => `app.translate.panel.waiting${code.charAt(0).toUpperCase()}${code.slice(1)}`),
      ...SWITCH_REASON_CODES.map((code) => `app.translate.panel.modelReason.${code}`),
      'app.translate.panel.modelReason.other',
      'app.translate.panel.switched',
      'app.translate.panel.models',
      'app.translate.panel.modelSeparator',
      'app.translate.panel.detail',
      'app.translate.panel.finishedBlocked',
      'app.translate.error.overloaded',
      'app.settings.translation.fallback',
      'app.settings.translation.fallbackHint'
    ]
    for (const key of keys) {
      expect(Object.hasOwn(ja, key), key).toBe(true)
      expect(Object.hasOwn(en, key), key).toBe(true)
    }
    expect(waitingText('nope', A, '3')).toBe(format('app.translate.panel.waiting', { seconds: '3' }))
    expect(modelsText([B], [{ from: A, to: B, reason: 'quota' }])).toBe(`使ったモデル: ${B}（${A} が回数の上限に達したため）`)
  })
})

describe('翻訳のたびに選ぶ枠（F5）', () => {
  it('availableTiers: キーのある知っている枠だけを Rust の一覧の順に返す', () => {
    expect(availableTiers({ tiers: ['free', 'paid'], keyTiers: ['paid', 'free'] })).toEqual(['free', 'paid'])
    expect(availableTiers({ tiers: ['free', 'paid'], keyTiers: ['paid'] })).toEqual(['paid'])
    expect(availableTiers({ tiers: ['free', 'paid'], keyTiers: [] })).toEqual([])
    expect(availableTiers({ tiers: ['free', 'paid', 'gold'], keyTiers: ['gold'] })).toEqual([])
    // 古い Rust（値が無い）は、どの枠にも無い扱い
    expect(availableTiers({} as never)).toEqual([])
  })

  it('有料を選ぶと有料の枠で送り、確かめと小窓が有料と言う。無料枠の注記は出さない', async () => {
    const { calls, asks, flow, panel } = setup()
    await flow.request(columnRequest(MAILS, 'paid'))
    expect(asks[0].body).toContain('有料用のキーで送って翻訳します。')
    expect(asks[0].body).not.toContain(ja['app.dialog.translateFreeTierWarning'])
    expect(asks[0].level).toBe('info')
    expect(calls.start.map((start) => start.tier)).toEqual(['paid'])
    const tier = panel.element.querySelector<HTMLElement>('.app-translate-tier')
    expect(tier?.hidden).toBe(false)
    expect(tier?.textContent).toBe('有料用のキーで送りました。')
    expect(panelTierText('free')).toBe('無料枠用のキーで送りました。')
    expect(panelTierText('gold')).toBeNull()
  })

  it('無料枠を選ぶと無料枠の注記つきで確かめ、小窓は無料枠と言う', async () => {
    const { calls, asks, flow, panel } = setup()
    await flow.request(columnRequest())
    expect(asks[0].body).toContain('無料枠用のキーで送って翻訳します。')
    expect(asks[0].body).toContain(ja['app.dialog.translateFreeTierWarning'])
    expect(asks[0].level).toBe('warning')
    expect(calls.start.map((start) => start.tier)).toEqual(['free'])
    expect(panel.element.querySelector('.app-translate-tier')?.textContent).toBe('無料枠用のキーで送りました。')
  })

  it('選んだ枠にキーが無ければ（もう一方にはあっても）送らず、設定を開く', async () => {
    const { calls, flow, events, notices } = setup({ settings: settings({ keyTiers: ['free'] }) })
    await flow.request(columnRequest(MAILS, 'paid'))
    expect(calls.start).toEqual([])
    expect(events.settingsOpened).toBe(1)
    expect(notices).toEqual([ja['app.translate.error.noKey']])
    // 殻は読み直した枠を覚え直す
    expect(events.settingsRead).toEqual([['free']])
  })

  it('枠の無い項目（どの枠にもキーが無いと殻が見ていた）: キーがまだ無ければ設定へ、置かれていれば選び直しを頼み、どちらも送らない', async () => {
    const none = setup({ settings: settings({ keyTiers: [] }) })
    // 既定の引数（free）を通さず、枠の無い頼みを作る
    const noTier = { ...columnRequest(), tier: undefined }
    await none.flow.request(noTier)
    expect(none.calls.start).toEqual([])
    expect(none.asks).toEqual([])
    expect(none.events.settingsOpened).toBe(1)
    expect(none.notices).toEqual([ja['app.translate.error.noKey']])
    document.body.replaceChildren()

    const appeared = setup({ settings: settings({ keyTiers: ['paid'] }) })
    await appeared.flow.request(noTier)
    expect(appeared.calls.start).toEqual([])
    expect(appeared.asks).toEqual([])
    expect(appeared.events.settingsOpened).toBe(0)
    expect(appeared.notices).toEqual([ja['app.translate.chooseTier']])
    expect(appeared.events.settingsRead).toEqual([['paid']])
  })

  it('続きを訳すは、最初に選んだ枠で送る', async () => {
    const { calls, flow, emit, asks } = setup({ answers: [0, 0] })
    await flow.request(columnRequest(MAILS, 'paid'))
    emit({ kind: 'translated', job: 1, results: [{ id: 0, text: 'こんにちは' }] })
    flow.cancel()
    await flush()
    await flow.resume()
    expect(calls.start.map((start) => start.tier)).toEqual(['paid', 'paid'])
    expect(asks[1].body).toContain('有料用のキーで送って翻訳します。')
  })

  it('Rust が枠を拒んだら（tier）、理由を UI の言語で出す', async () => {
    const { flow, panel, rejectStart } = setup()
    rejectStart('tier')
    await flow.request(columnRequest())
    await flush()
    expect(panel.element.querySelector('.app-translate-message')?.textContent).toBe(ja['app.translate.error.tier'])
  })
})

describe('小窓の注意書きの「今後表示しない」（F5）', () => {
  const note = (panel: { element: HTMLElement }) => panel.element.querySelector<HTMLElement>('[data-notice="machine"]')

  it('machineNoticeShown: 切ってあるときだけ出さない。値が無い（古い Rust）、真偽でないときは出す', () => {
    expect(machineNoticeShown({ machineNotice: true })).toBe(true)
    expect(machineNoticeShown({ machineNotice: false })).toBe(false)
    expect(machineNoticeShown({} as never)).toBe(true)
    expect(machineNoticeShown({ machineNotice: 'no' } as never)).toBe(true)
  })

  it('押すと注意書きを隠して設定に保存し、次の翻訳の小窓でも出さない。確かめの注意書きは残る', async () => {
    const { calls, flow, emit, panel, state, asks } = setup()
    await flow.request(columnRequest())
    expect(note(panel)?.hidden).toBe(false)
    panel.element.querySelector<HTMLButtonElement>('[data-action="hideMachineNotice"]')?.click()
    await flush()
    expect(note(panel)?.hidden).toBe(true)
    expect(calls.machineNotices).toEqual([false])
    expect(state.machineNotice).toBe(false)
    emit({ kind: 'finished', job: 1, error: null })
    await flow.request(columnRequest())
    expect(note(panel)?.hidden).toBe(true)
    expect(calls.machineNotices).toEqual([false]) // 2 回目は保存しない
    // 送る前の確かめ（出したとき）には注意書きを残す
    expect(asks[1].body).toContain(ja['app.translate.machineNotice'])
  })

  it('設定で戻す（machineNotice を true にする）と、次の小窓で出る', async () => {
    const { flow, emit, panel, state } = setup({ settings: settings({ machineNotice: false }) })
    await flow.request(columnRequest())
    expect(note(panel)?.hidden).toBe(true)
    emit({ kind: 'finished', job: 1, error: null })
    state.machineNotice = true
    await flow.request(columnRequest())
    expect(note(panel)?.hidden).toBe(false)
  })

  it('保存できなければ知らせ、今の小窓では隠したまま', async () => {
    const fake = setup()
    fake.rejectMachineNotice()
    await fake.flow.request(columnRequest())
    fake.panel.element.querySelector<HTMLButtonElement>('[data-action="hideMachineNotice"]')?.click()
    await flush()
    expect(fake.calls.machineNotices).toEqual([false])
    expect(fake.notices).toEqual([ja['app.translate.machineNoticeNotSaved']])
    expect(note(fake.panel)?.hidden).toBe(true)
    expect(fake.state.machineNotice).toBe(true)
  })
})
