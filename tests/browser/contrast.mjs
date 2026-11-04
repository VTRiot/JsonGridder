// 文字と地のコントラストの全数点検（step9_004）。実 Chromium で、ライトとダークの両方について、
// 画面の状態ごとに「見えている文字の要素」の計算済みの文字色と、その要素の実際の地（透明なら祖先をたどる）を測る。
// 4.5 未満（18.66px 以上の太字と 24px 以上は 3.0 未満）が 1 件でもあれば落ちる。無効なボタンの文字は除外し、件数を出す。

const NORMAL_MIN = 4.5 // WCAG 2.2 AA の本文
const LARGE_MIN = 3.0 // 大きい文字（24px 以上、または 18.66px 以上の太字）
const LARGE_PX = 24
const LARGE_BOLD_PX = 18.66
const BOLD_WEIGHT = 700
const SETTLE_MS = 400
const THEMES = ['light', 'dark']
const SHOW_BAD_MAX = 6

const PAGE_LIB = `(() => {
  const parse = (css) => {
    let m = /^rgba?\\(([^)]+)\\)$/.exec(css)
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }
    }
    m = /^color\\(srgb ([^)]+)\\)$/.exec(css)
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number)
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] === undefined ? 1 : p[3] }
    }
    return null
  }
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1
  })
  const lum = ({ r, g, b }) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const pageBase = () => parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }
  const backgroundOf = (el) => {
    const chain = []
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) chain.push(c)
      if (c && c.a === 1) break
    }
    let base = over(pageBase(), { r: 255, g: 255, b: 255, a: 1 })
    for (const layer of chain.reverse()) base = over(layer, base)
    return base
  }
  const describe = (el) => {
    const id = el.id ? '#' + el.id : ''
    const cls = [...el.classList].slice(0, 3).map((c) => '.' + c).join('')
    return el.tagName.toLowerCase() + id + cls
  }
  const isDisabled = (el) => !!el.closest('[aria-disabled="true"], :disabled, .jse-disabled')
  const measure = (el, text, out) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') return
    if (Number(style.opacity) < 1 || el.closest('[hidden], svg')) return
    const fg = parse(style.color)
    if (!fg) return
    if (isDisabled(el)) { out.disabled++; return }
    const bg = backgroundOf(el)
    const value = ratio(over(fg, bg), bg)
    const px = parseFloat(style.fontSize)
    const bold = Number(style.fontWeight) >= ${BOLD_WEIGHT}
    const large = px >= ${LARGE_PX} || (px >= ${LARGE_BOLD_PX} && bold)
    const min = large ? ${LARGE_MIN} : ${NORMAL_MIN}
    out.count++
    if (value < min) {
      out.bad.push({ where: describe(el), text: text.slice(0, 18), ratio: Number(value.toFixed(2)), fg: hex(over(fg, bg)), bg: hex(bg), min })
    }
  }
  const scan = (rootSelector) => {
    const out = { count: 0, disabled: 0, bad: [] }
    for (const root of document.querySelectorAll(rootSelector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim()
        if (text && node.parentElement) measure(node.parentElement, text, out)
      }
      for (const input of root.querySelectorAll('input, textarea')) {
        const text = (input.value || '').trim()
        if (text && input.type !== 'checkbox' && input.type !== 'radio') measure(input, text, out)
      }
    }
    return out
  }
  // 選んでいる表示の切り替え（D4）。文字とボタンの地、ボタンの縁と周りの地（メニューの行）の対比
  // 左ペインの選んでいる項目（D7）も同じ色なので、同じ物差しで測る（selector で替える）
  const switchFacts = (selector = '.app-view-switch-button.is-selected') => {
    const button = document.querySelector(selector)
    if (!button) return null
    const style = getComputedStyle(button)
    const bg = backgroundOf(button)
    const around = backgroundOf(button.parentElement)
    const border = parse(style.borderTopColor)
    return {
      mode: button.dataset.mode,
      text: Number(ratio(over(parse(style.color), bg), bg).toFixed(2)),
      border: Number(ratio(over(border, around), around).toFixed(2)),
      colors: [hex(over(parse(style.color), bg)), hex(bg), hex(over(border, around)), hex(around)].join(' ')
    }
  }
  // 翻訳のサブメニューの枠の項目（F6）。各項目の文字と、その項目の実際の地の対比
  const tierFacts = (selector) =>
    [...document.querySelectorAll(selector)].map((item) => {
      const bg = backgroundOf(item)
      const fg = over(parse(getComputedStyle(item).color), bg)
      return {
        text: item.textContent.trim(),
        focused: document.activeElement === item,
        ratio: Number(ratio(fg, bg).toFixed(2)),
        colors: hex(fg) + ' ' + hex(bg)
      }
    })
  // 翻訳の設定のまとまりの層（F7）。各まとまりの実際の地、縁の左の太線の色、中の文字の種類ごとの最小の対比
  const cardFacts = (selector) =>
    [...document.querySelectorAll(selector)].map((card) => {
      const bg = backgroundOf(card)
      const style = getComputedStyle(card)
      const edge = parse(style.borderLeftColor)
      const kinds = {}
      const add = (kind, el) => {
        const own = backgroundOf(el)
        const value = Number(ratio(over(parse(getComputedStyle(el).color), own), own).toFixed(2))
        kinds[kind] = Math.min(kinds[kind] ?? Infinity, value)
      }
      const visible = (el) => el.getBoundingClientRect().width > 0 && !el.closest('[hidden]') && !el.closest(':disabled')
      for (const el of card.querySelectorAll('.app-translation-label')) if (visible(el)) add('label', el)
      for (const el of card.querySelectorAll('.app-translation-hint')) if (visible(el)) add('muted', el)
      for (const el of card.querySelectorAll('.app-translation-note, .app-translation-key-status:not([data-saved="true"])')) if (visible(el)) add('body', el)
      for (const el of card.querySelectorAll('.app-translation-key-status[data-saved="true"]')) if (visible(el)) add('saved', el)
      for (const el of card.querySelectorAll('.app-translation-button')) if (visible(el)) add('button', el)
      for (const el of card.querySelectorAll('input:not([type="checkbox"]), select')) if (visible(el)) add('input', el)
      return {
        card: card.dataset.card,
        bg: hex(bg),
        edge: edge && edge.a > 0 ? hex(over(edge, bg)) : null,
        edgeWidth: parseFloat(style.borderLeftWidth),
        kinds
      }
    })
  return { scan, switchFacts, tierFacts, cardFacts }
})()`

const scan = (page, selector = 'body') => page.evaluate(`${PAGE_LIB}.scan(${JSON.stringify(selector)})`)
const switchFacts = (page) => page.evaluate(`${PAGE_LIB}.switchFacts()`)
const paneItemFacts = (page) => page.evaluate(`${PAGE_LIB}.switchFacts('.app-target-pane-item.is-selected')`)
const SWITCH_BORDER_MIN = 3.0 // WCAG 2.2 1.4.11（部品の境界）
const tierFacts = (page, selector) => page.evaluate(`${PAGE_LIB}.tierFacts(${JSON.stringify(selector)})`)
const cardFacts = (page, selector) => page.evaluate(`${PAGE_LIB}.cardFacts(${JSON.stringify(selector)})`)
const TRANSLATION_DIALOG = 'dialog.app-translation-dialog'
/** まとまりの層の並び（F7）。一般はダイアログの地、ほかはそれぞれのカード。 */
const TRANSLATION_CARDS = ['general', 'free', 'paid', 'legacy', 'options']
const TRANSLATION_CARD_KINDS = ['label', 'muted', 'body', 'saved', 'button', 'input']

/**
 * 翻訳の設定のダイアログのまとまりの層（F7）。以前のキーの欄も出る状態（legacy=1）で、有料のキーを保存済みにし、
 * 5 つのまとまりの地が互いに違うこと、カードの縁の太線が地と違うこと、まとまりの中の文字の種類
 * （見出し、補助の文、本文、保存済みの状態、ボタン、入力欄）がどれも 4.5 以上であることを測る。
 * ダイアログ全体の文字の全数点検（scan）も同じ状態で回す。
 */
async function testTranslationLayers(h, browser, base, theme) {
  const name = `コントラスト ${theme}/翻訳の設定のまとまりの層`
  const { page } = await h.openPage(browser, `${base}?shell&theme=${theme}&legacy=1`)
  await page.waitForFunction(() => window.fixture !== undefined)
  const failure = await attempt(async () => {
    await open(page, '/first.json')
    await page.click('.app-menubar-button:has-text("オプション")')
    await page.click('.app-menu-item:has-text("翻訳の設定")')
    await page.waitForSelector(`${TRANSLATION_DIALOG}[open]`, { timeout: 5000 })
    await page.fill(`${TRANSLATION_DIALOG} [data-card="paid"] .app-translation-key-input`, 'test-not-a-real-key')
    await page.click(`${TRANSLATION_DIALOG} [data-card="paid"] [data-action="saveKey"]`)
    await page.waitForSelector(`${TRANSLATION_DIALOG} [data-card="paid"] .app-translation-key-status[data-saved="true"]`, { timeout: 5000 })
    // 入力欄の文字も測るため、無料枠の欄に値を入れておく（保存はしない）
    await page.fill(`${TRANSLATION_DIALOG} [data-card="free"] .app-translation-key-input`, 'typed-not-saved')
    await page.mouse.move(1, 1)
    await settle(page)
  })
  if (failure) {
    h.record(`${name}: 状態を作れる`, false, failure)
    await page.close()
    return
  }
  const facts = await cardFacts(page, `${TRANSLATION_DIALOG} [data-card]`)
  const detail = JSON.stringify(facts)
  console.log(`  ${name}: ${detail}`)
  h.record(
    `${name}: 一般、無料枠、有料、以前のキー、モデルと動きの 5 つのまとまりが並ぶ`,
    JSON.stringify(facts.map((fact) => fact.card)) === JSON.stringify(TRANSLATION_CARDS),
    detail
  )
  const backgrounds = facts.map((fact) => fact.bg)
  h.record(`${name}: 5 つのまとまりの地がどれも違う`, new Set(backgrounds).size === TRANSLATION_CARDS.length, backgrounds.join(' '))
  const cards = facts.filter((fact) => fact.card !== 'general')
  h.record(
    `${name}: カードの左の太線は地と違う色`,
    cards.length === TRANSLATION_CARDS.length - 1 && cards.every((fact) => fact.edge !== null && fact.edge !== fact.bg && fact.edgeWidth > 1),
    detail
  )
  const ratios = facts.flatMap((fact) => Object.entries(fact.kinds).map(([kind, value]) => [fact.card, kind, value]))
  const kindsSeen = new Set(ratios.map(([, kind]) => kind))
  h.record(
    `${name}: 見出し、補助の文、本文、保存済み、ボタン、入力欄を測った`,
    TRANSLATION_CARD_KINDS.every((kind) => kindsSeen.has(kind)),
    [...kindsSeen].join(' ')
  )
  h.record(
    `${name}: まとまりの中の文字がどれも ${NORMAL_MIN} 以上`,
    ratios.length > 0 && ratios.every(([, , value]) => value >= NORMAL_MIN),
    ratios.filter(([, , value]) => value < NORMAL_MIN).map((row) => row.join(':')).join(' | ') || detail
  )
  const result = await scan(page, TRANSLATION_DIALOG)
  h.record(
    `${name}: ダイアログの文字 ${result.count} 件が基準以上（無効 ${result.disabled} 件は除外）`,
    result.count > 0 && result.bad.length === 0,
    result.bad
      .slice(0, SHOW_BAD_MAX)
      .map((b) => `${b.where} "${b.text}" ${b.ratio}<${b.min} ${b.fg}/${b.bg}`)
      .join(' | ')
  )
  await page.close()
}

/**
 * 翻訳のサブメニュー（F6）の有料と無料の文字の色。見出し（殻のメニュー）とセル（上流のメニュー）で、
 * 各項目を、フォーカスの無いとき（メニューの地）とフォーカスのあるとき（選んだ行の地）の両方で測る。
 * 2 つの枠の色が違うことも確かめる。
 */
async function testTranslateTierColors(h, browser, base, theme) {
  const name = `コントラスト ${theme}/翻訳のサブメニューの枠の色`
  const { page } = await h.openPage(browser, `${base}?shell&theme=${theme}&translation=on&key=both`)
  await page.waitForFunction(() => window.fixture !== undefined)
  await open(page, '/mail.json')
  await page.evaluate(() => window.fixture.setTarget(['mails']))
  await h.switchTo(page, '表')
  const menus = [
    {
      label: '見出し',
      items: '.app-translate-submenu .app-menu-item',
      openMenu: async () => {
        await page.click(`th[data-column-path="${encodeURIComponent('/subject')}"]`, { button: 'right' })
        await page.waitForSelector('.app-translate-context-menu .app-menu-item', { timeout: 5000 })
        await page.keyboard.press('ArrowRight')
      }
    },
    {
      label: 'セル',
      items: '.jse-contextmenu .jse-context-submenu-items button',
      openMenu: async () => {
        await page.click(`td[data-path="${encodeURIComponent('/1/subject')}"]`, { button: 'right' })
        await page.waitForSelector('.jse-contextmenu .app-translate-context-item', { timeout: 5000 })
        await page.focus('.jse-contextmenu .app-translate-context-item')
        await page.keyboard.press('ArrowRight')
      }
    }
  ]
  for (const menu of menus) {
    const failure = await attempt(menu.openMenu)
    if (failure) {
      h.record(`${name}（${menu.label}）: 状態を作れる`, false, failure)
      continue
    }
    await page.mouse.move(1, 1) // 指の当たりの地を外す（フォーカスの地だけを測る）
    const first = await tierFacts(page, menu.items) // 先頭（有料）にフォーカス
    await page.keyboard.press('ArrowDown')
    const second = await tierFacts(page, menu.items) // 無料にフォーカス
    const facts = [...first, ...second]
    const detail = JSON.stringify(facts)
    h.record(
      `${name}（${menu.label}）: 有料と無料の 2 つを、フォーカスの有無の両方で測った`,
      first.length === 2 && second.length === 2 && first[0].focused && second[1].focused && first[0].text === '有料' && first[1].text === '無料',
      detail
    )
    h.record(`${name}（${menu.label}）: 文字と地が ${NORMAL_MIN} 以上`, facts.length === 4 && facts.every((fact) => fact.ratio >= NORMAL_MIN), detail)
    h.record(
      `${name}（${menu.label}）: 有料と無料で文字の色が違う`,
      first.length === 2 && first[0].colors.split(' ')[0] !== first[1].colors.split(' ')[0],
      detail
    )
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await settle(page)
  }
  await page.close()
}

async function shellPage(h, browser, base, theme) {
  const { page, problems } = await h.openPage(browser, `${base}?shell&theme=${theme}`)
  await page.waitForFunction(() => window.fixture !== undefined)
  return { page, problems }
}

const open = (page, path, options = {}) =>
  page.evaluate(([target, opts]) => window.fixture.open(target, opts), [path, options])
const settle = (page) => page.waitForTimeout(SETTLE_MS)
const attempt = async (step) => {
  try {
    await step()
    return null
  } catch (error) {
    return String(error).split('\n')[0].slice(0, 120)
  }
}

/** 画面の状態の一覧。それぞれ、その状態を作ってから scan する。作れなかった状態は失敗にする（点検の穴を許さない）。 */
function states(h) {
  const mode = async (page, label) => h.switchTo(page, label)
  const closeAll = async (page) => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await settle(page)
  }
  return [
    ['表', async (page) => { await open(page, '/first.json'); await mode(page, '表'); await settle(page) }],
    ['ツリー', async (page) => { await open(page, '/i19.json', { discardConfirmed: true }); await mode(page, 'ツリー'); await settle(page) }],
    ['テキスト', async (page) => { await mode(page, 'テキスト'); await settle(page) }],
    ['ツリーの選択した行', async (page) => {
      await mode(page, 'ツリー')
      await page.locator('.jse-tree-mode .jse-key').first().click()
      await settle(page)
    }],
    ['ナビゲーションの帯', async (page) => {
      await mode(page, 'ツリー')
      await page.locator('.jse-navigation-bar').first().waitFor({ timeout: 5000 })
      await page.locator('.jse-tree-mode .jse-key').nth(2).click()
      await settle(page)
    }],
    ['表の選択したセル', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('td.jse-table-cell').first().click()
      await settle(page)
    }],
    ['空の文書の案内（表）', async (page) => {
      await page.evaluate(() => window.fixture.addFile('/empty-doc.json', '{}'))
      await open(page, '/empty-doc.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.waitForSelector('.jse-table-mode-welcome', { timeout: 5000 })
      await settle(page)
    }],
    ['空の文書の案内（ツリー）', async (page) => {
      await page.evaluate(() => window.fixture.addFile('/empty-text.json', ''))
      await open(page, '/empty-text.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await settle(page)
    }],
    // 根がオブジェクトの文書の「文書全体」は左ペインに無い（D12）。対象が空になる経路は器の公開の口で作る
    ['文書全体の案内（入れ子の表）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.evaluate(() => window.fixture.setTarget([]))
      await page.waitForSelector('.jse-table-mode-welcome', { timeout: 5000 })
      await settle(page)
    }],
    // 左ペイン（D7）。選んでいる項目は切り替えと同じ緑。押していない項目と件数も測る
    ['左ペイン（表、選んでいる項目）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.waitForSelector('.app-target-pane:not([hidden]) .app-target-pane-item.is-selected', { timeout: 5000 })
      await settle(page)
    }],
    ['左ペイン（ツリー）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.waitForSelector('.app-target-pane:not([hidden]) .app-target-pane-item', { timeout: 5000 })
      await settle(page)
    }],
    ['検索と置換の欄（当たりあり）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('td.jse-table-cell').first().click()
      await page.keyboard.press('Control+F')
      await page.waitForSelector('.jse-search-box', { timeout: 3000 })
      await page.keyboard.press('Control+H')
      await page.waitForSelector('.jse-replace-input', { timeout: 3000 })
      await page.fill('.jse-search-input, .jse-search-section input', 'x')
      await page.fill('.jse-replace-input', 'z')
      await settle(page)
    }],
    ['検索の当たり（ツリー）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.jse-tree-mode .jse-key').first().click()
      await page.keyboard.press('Control+F')
      await page.waitForSelector('.jse-search-box', { timeout: 3000 })
      await page.fill('.jse-search-input, .jse-search-section input', 'p')
      await settle(page)
    }],
    ['検索の当たり（テキスト）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, 'テキスト')
      await page.locator('.cm-content').first().click()
      await page.keyboard.press('Control+F')
      await settle(page)
      await page.keyboard.type('items')
      await page.keyboard.press('Enter')
      await settle(page)
    }],
    ['右クリックのメニュー（ツリー）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.jse-tree-mode .jse-key').first().click({ button: 'right' })
      await page.waitForSelector('div.jse-contextmenu', { timeout: 5000 })
    }],
    ['右クリックのメニュー（表）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('td.jse-table-cell').first().click({ button: 'right' })
      await page.waitForSelector('div.jse-contextmenu', { timeout: 5000 })
    }],
    ['メニューバーの開いたメニュー', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await page.locator('.app-menubar-button').first().click()
      await page.waitForSelector('.app-menu-item', { timeout: 5000 })
    }],
    // S4: Edit メニュー（押せない項目と区切りを含む）と、表の場所の行とコマンドの行
    ['Edit メニュー', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('td.jse-table-cell').first().click()
      await page.locator('.app-menubar-button').nth(1).click()
      await page.waitForSelector('.app-menu-separator', { timeout: 5000 })
    }],
    ['表の場所の行', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('td.jse-table-cell').first().click()
      await page.waitForSelector('.app-location-row:not([hidden]) .app-location-separator', { timeout: 5000 })
      await settle(page)
    }],
    ['モーダル（並べ替え）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.app-command-button[data-command="sort"]').first().click()
      await page.waitForSelector('.jse-modal', { timeout: 5000 })
      await settle(page)
    }],
    ['モーダル（Transform）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.app-command-button[data-command="transform"]').first().click()
      await page.waitForSelector('.jse-transform-modal', { timeout: 5000 })
      await settle(page)
    }],
    ['モーダル（Transform のエラー）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.app-command-button[data-command="transform"]').first().click()
      await page.waitForSelector('.jse-transform-modal', { timeout: 5000 })
      await page.fill('.jse-transform-modal textarea.jse-query', 'function (data) { return data.nothing.x }')
      await settle(page)
    }],
    ['モーダル（入れ子の編集）', async (page) => {
      await page.evaluate(() => window.fixture.addFile('/nested-cell.json', '[{"n":[{"m":1}],"k":"kept"}]'))
      await open(page, '/nested-cell.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: 5000 })
      await page.waitForSelector('dialog[open]', { timeout: 5000 })
      await settle(page)
    }],
    ['通知の帯', async (page) => {
      await open(page, '/delete.json', { discardConfirmed: true })
      await mode(page, 'テキスト')
      const before = await page.evaluate(() => window.fixture.text())
      const find = ',"items":[{"a":1}]'
      await page.evaluate(([from, to]) => window.fixture.typeAt('', from, to), [before.indexOf(find), before.indexOf(find) + find.length])
      await page.waitForTimeout(700)
      await page.evaluate(() => window.fixture.setTarget(['items'])).catch(() => {})
      await mode(page, '表')
      await page.waitForSelector('.app-notice', { timeout: 5000 })
    }],
    ['エラーの表示（壊れた JSON）', async (page) => {
      await open(page, '/broken.json', { discardConfirmed: true })
      await settle(page)
    }],
    ['エラーの表示（壊れた JSON の表）', async (page) => {
      await mode(page, '表')
      await settle(page)
    }],
    ['エラーの表示（検証の一覧）', async (page) => {
      await open(page, '/broken.json', { discardConfirmed: true })
      await mode(page, 'テキスト')
      await settle(page)
    }],
    // 翻訳の設定のダイアログ（Step10-002 T3）。無料枠の注記、キーが要るの案内、キーを保存できなかった誤りの文
    ['翻訳の設定（無料枠、誤りの文）', async (page) => {
      await page.evaluate(() => window.fixture.loseKeyWrites(true))
      await page.click('.app-menubar-button:has-text("オプション")')
      await page.click('.app-menu-item:has-text("翻訳の設定")')
      await page.waitForSelector('dialog.app-translation-dialog[open]', { timeout: 5000 })
      await page.check('dialog.app-translation-dialog [data-field="enabled"]')
      await page.fill('dialog.app-translation-dialog [data-tier="free"] .app-translation-key-input', 'test-not-a-real-key')
      await page.click('dialog.app-translation-dialog [data-tier="free"] [data-action="saveKey"]')
      await page.waitForSelector('.app-translation-message[data-kind="error"]:not([hidden])', { timeout: 5000 })
      await page.waitForSelector('[data-notice="needsKey"]:not([hidden])', { timeout: 5000 })
      await page.evaluate(() => window.fixture.loseKeyWrites(false))
      await settle(page)
    }],
    ['翻訳の設定（有料のキー保存済み）', async (page) => {
      await page.click('.app-menubar-button:has-text("オプション")')
      await page.click('.app-menu-item:has-text("翻訳の設定")')
      await page.waitForSelector('dialog.app-translation-dialog[open]', { timeout: 5000 })
      await page.fill('dialog.app-translation-dialog .app-translation-key-block[data-tier="paid"] .app-translation-key-input', 'test-not-a-real-key')
      await page.click('dialog.app-translation-dialog .app-translation-key-block[data-tier="paid"] [data-action="saveKey"]')
      await page.waitForSelector('.app-translation-key-status[data-saved="true"]', { timeout: 5000 })
      await page.waitForSelector('.app-translation-message[data-kind="info"]:not([hidden])', { timeout: 5000 })
      await settle(page)
    }],
    // 翻訳の結果の小窓（Step10-002 T4）。機械の推測の注記、済み、拒まれた、未翻訳の状態、止まった理由（誤りの文）。
    // 前の状態でキーを保存してある。ここで翻訳を有効にして保存する
    ['翻訳の小窓（訳、失敗、誤りの文）', async (page) => {
      await page.keyboard.press('Escape')
      await page.click('.app-menubar-button:has-text("オプション")')
      await page.click('.app-menu-item:has-text("翻訳の設定")')
      await page.waitForSelector('dialog.app-translation-dialog[open]', { timeout: 5000 })
      await page.check('dialog.app-translation-dialog [data-field="enabled"]')
      await page.click('dialog.app-translation-dialog [data-action="save"]')
      await page.waitForSelector('dialog.app-translation-dialog', { state: 'detached', timeout: 5000 })
      await open(page, '/mail.json', { discardConfirmed: true })
      await page.evaluate(() => window.fixture.setTarget(['mails']))
      await mode(page, '表')
      await page.evaluate(() => window.fixture.holdTranslate(true))
      await page.click(`th[data-column-path="${encodeURIComponent('/subject')}"]`, { button: 'right' })
      await page.click('.app-translate-context-menu .app-menu-item')
      // F6: 「日本語に翻訳」のサブメニューの、キーのある枠（前の状態で保存した有料）
      await page.click('.app-translate-submenu .app-menu-item')
      await page.waitForSelector('.app-translate-panel:not([hidden]) [data-action="cancel"]:not([hidden])', { timeout: 5000 })
      await page.evaluate(() => {
        window.fixture.emitTranslate({ kind: 'translated', job: 0, results: [{ id: 0, text: 'こんにちは' }, { id: 1, text: 'Re: こんにちは' }] })
        window.fixture.emitTranslate({ kind: 'failed', job: 0, ids: [2], reason: 'blocked' })
        window.fixture.emitTranslate({ kind: 'finished', job: 0, error: 'quota' })
      })
      await page.evaluate(() => window.fixture.holdTranslate(false))
      await page.waitForSelector('.app-translate-message[data-kind="error"]:not([hidden])', { timeout: 5000 })
      await settle(page)
    }],
    // テキストでしか開けない文書の警告の帯（D6）と状態の行。帯が出ていなければ状態を作れない扱い
    ['警告の帯（重複キー）', async (page) => {
      await page.evaluate(() => window.fixture.nextOpen({ textOnly: true }))
      await open(page, '/duplicate.json', { discardConfirmed: true })
      await page.waitForSelector('.app-invalid-banner:not([hidden])', { timeout: 5000 })
      await page.waitForSelector('.app-status-row [data-item="save"]', { timeout: 5000 })
      await settle(page)
    }]
  ].map(([label, make]) => ({ label, make, closeAll }))
}

export async function testContrast(browser, base, h) {
  const summary = []
  for (const theme of THEMES) {
    const { page, problems } = await shellPage(h, browser, base, theme)
    for (const { label, make, closeAll } of states(h)) {
      const name = `コントラスト ${theme}/${label}`
      const failure = await attempt(() => make(page))
      if (failure) {
        h.record(`${name}: 状態を作れる`, false, failure)
        await closeAll(page).catch(() => {})
        continue
      }
      const result = await scan(page)
      summary.push([theme, label, result.count, result.disabled, result.bad.length])
      h.record(
        `${name}: 文字 ${result.count} 件が基準以上（無効 ${result.disabled} 件は除外）`,
        result.count > 0 && result.bad.length === 0,
        result.bad
          .slice(0, SHOW_BAD_MAX)
          .map((b) => `${b.where} "${b.text}" ${b.ratio}<${b.min} ${b.fg}/${b.bg}`)
          .join(' | ')
      )
      await closeAll(page).catch(() => {})
    }
    for (const label of ['ツリー', '表']) {
      const name = `コントラスト ${theme}/選んでいる切り替え（${label}）`
      await open(page, '/first.json', { discardConfirmed: true })
      await h.switchTo(page, label)
      const facts = await switchFacts(page)
      const detail = JSON.stringify(facts)
      h.record(`${name}: 文字と地が ${NORMAL_MIN} 以上`, facts !== null && facts.text >= NORMAL_MIN, detail)
      h.record(`${name}: 縁と周りの地が ${SWITCH_BORDER_MIN} 以上`, facts !== null && facts.border >= SWITCH_BORDER_MIN, detail)
    }
    {
      const name = `コントラスト ${theme}/左ペインの選んでいる項目`
      await open(page, '/i19.json', { discardConfirmed: true })
      await h.switchTo(page, '表')
      await page.waitForSelector('.app-target-pane-item.is-selected', { timeout: 5000 }).catch(() => {})
      const facts = await paneItemFacts(page)
      const detail = JSON.stringify(facts)
      h.record(`${name}: 文字と地が ${NORMAL_MIN} 以上`, facts !== null && facts.text >= NORMAL_MIN, detail)
      h.record(`${name}: 縁と周りの地が ${SWITCH_BORDER_MIN} 以上`, facts !== null && facts.border >= SWITCH_BORDER_MIN, detail)
    }
    // ページのエラーは他の試験が見る。ここは色だけ（偽物の画像の CSP 違反などで揺れない）
    void problems
    await page.close()
    await testTranslateTierColors(h, browser, base, theme)
    await testTranslationLayers(h, browser, base, theme)
  }
  const total = summary.reduce((sum, row) => sum + row[2], 0)
  const disabled = summary.reduce((sum, row) => sum + row[3], 0)
  console.log(`  コントラストの点検: ${summary.length} 状態、文字 ${total} 件、無効な文字 ${disabled} 件を除外`)
}
