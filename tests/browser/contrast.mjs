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
  return { scan }
})()`

const scan = (page, selector = 'body') => page.evaluate(`${PAGE_LIB}.scan(${JSON.stringify(selector)})`)

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
    ['文書全体の案内（入れ子の表）', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.click('.app-targetbar-button', { timeout: 5000 })
      await page.click('.app-targetbar .app-menu-item:has-text("文書全体")', { timeout: 5000 })
      await page.waitForSelector('.jse-table-mode-welcome', { timeout: 5000 })
      await settle(page)
    }],
    ['対象の選択の一覧', async (page) => {
      await open(page, '/i19.json', { discardConfirmed: true })
      await mode(page, '表')
      await page.click('.app-targetbar-button', { timeout: 5000 })
      await page.waitForSelector('.app-targetbar .app-menu-item', { timeout: 5000 })
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
    ['モーダル（並べ替え）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.jse-menu .jse-sort').first().click()
      await page.waitForSelector('.jse-modal', { timeout: 5000 })
      await settle(page)
    }],
    ['モーダル（Transform）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.jse-menu .jse-transform').first().click()
      await page.waitForSelector('.jse-transform-modal', { timeout: 5000 })
      await settle(page)
    }],
    ['モーダル（Transform のエラー）', async (page) => {
      await open(page, '/first.json', { discardConfirmed: true })
      await mode(page, 'ツリー')
      await page.locator('.jse-menu .jse-transform').first().click()
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
    // ページのエラーは他の試験が見る。ここは色だけ（偽物の画像の CSP 違反などで揺れない）
    void problems
    await page.close()
  }
  const total = summary.reduce((sum, row) => sum + row[2], 0)
  const disabled = summary.reduce((sum, row) => sum + row[3], 0)
  console.log(`  コントラストの点検: ${summary.length} 状態、文字 ${total} 件、無効な文字 ${disabled} 件を除外`)
}
