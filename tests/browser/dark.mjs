// ダークモードの試験（step4_002）。実 Chromium で計算済みの色を走査する。
// 実 EXE を要る条件（起動直後の画面、タイトルバー）は含まない。

const CONTRAST_MIN = 4.5 // WCAG 2.2 AA の本文の基準
const ROLE_ROWS = [
  ['文字', '--app-text'],
  ['補助の文字', '--app-text-muted'],
  ['エラー', '--app-error'],
  ['成功', '--app-success'],
  ['警告', '--app-warning'],
  ['JSON のキー', '--app-json-key'],
  ['JSON の文字列', '--app-json-string'],
  ['JSON の数値', '--app-json-number'],
  ['JSON の真偽', '--app-json-boolean'],
  ['JSON の null', '--app-json-null']
]
const MESSAGE_PAIRS = ['error', 'warning', 'success', 'info'].map((kind) => [
  `メッセージ ${kind}`,
  `--jse-message-${kind}-color`,
  `--jse-message-${kind}-background`
])
const GROUND_VARS = ['--app-bg', '--app-surface', '--app-header', '--app-selection', '--app-selection-inactive', '--app-hover', '--app-row-odd']
// ライトの地と面の明るさの上限（step9_008）。白が目に刺さらないよう、CIE L* でこれを超える面を作らない。
const LIGHT_GROUND_LSTAR_MAX = 95
const LIGHT_GROUND_VARS = [...GROUND_VARS, '--app-frame', '--app-border']
const EXPECTED_ACCENT = '#f29ab9'
const PROBE_ACCENT = '#12ab34'
const MODES = ['table', 'tree', 'text']

/** ページ内で使う関数群。evaluate に文字列で渡す。 */
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
  const resolve = (name) => {
    const probe = document.createElement('i')
    probe.style.color = 'var(' + name + ')'
    document.body.append(probe)
    const value = parse(getComputedStyle(probe).color)
    probe.remove()
    return value
  }
  const backgroundOf = (el) => {
    const chain = []
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0) chain.push(c)
      if (c && c.a === 1) break
    }
    let base = resolve('--app-bg')
    for (const layer of chain.reverse()) base = over(layer, base)
    return base
  }
  const scan = (rootSelector) => {
    const bad = []
    let count = 0
    for (const root of document.querySelectorAll(rootSelector)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim()
        const el = node.parentElement
        if (!text || !el || el.closest('svg, [aria-disabled="true"], :disabled, [hidden]')) continue
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue
        if (Number(style.opacity) < 1) continue
        const fg = parse(style.color)
        if (!fg) continue
        const bg = backgroundOf(el)
        const value = ratio(over(fg, bg), bg)
        count++
        if (value < ${CONTRAST_MIN}) {
          bad.push(el.className.toString().slice(0, 40) + ' "' + text.slice(0, 16) + '" ' + value.toFixed(2))
        }
      }
    }
    return { count, bad }
  }
  return { resolve, ratio, scan, over }
})()`

// ページの CSP は eval を止める。文字列の式は CDP が直接評価するので通る。
const roleRatios = (page) =>
  page.evaluate(`(() => {
    const api = ${PAGE_LIB}
    return ${JSON.stringify(ROLE_ROWS)}.flatMap(([label, name]) =>
      ${JSON.stringify(GROUND_VARS)}.map((ground) => {
        const bg = api.resolve(ground)
        return [label, name, ground, api.ratio(api.over(api.resolve(name), bg), bg)]
      })
    )
  })()`)

const pairRatios = (page) =>
  page.evaluate(`(() => {
    const api = ${PAGE_LIB}
    return ${JSON.stringify(MESSAGE_PAIRS)}.map(([label, fg, bg]) => {
      const ground = api.resolve(bg)
      return [label, fg, bg, api.ratio(api.over(api.resolve(fg), ground), ground)]
    })
  })()`)

const scanPage = (page, selector) => page.evaluate(`${PAGE_LIB}.scan(${JSON.stringify(selector)})`)

export async function testDark(browser, base, h) {
  const name = 'ダーク'
  const { page, problems } = await h.openPage(browser, `${base}?shell&theme=dark`)
  await page.waitForFunction(() => window.fixture !== undefined)
  const open = (path) => page.evaluate((target) => window.fixture.open(target, {}), path)
  await open('/first.json')
  const attr = () => page.evaluate(() => document.documentElement.dataset.theme)

  h.record(`${name}: 起動時の設定が最初から当たる`, (await attr()) === 'dark')
  h.record(
    `${name}: ネイティブの部品の配色が暗い`,
    (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) === 'dark'
  )

  // 条件 3: 色の役割の表
  const rows = await roleRatios(page)
  const weak = rows.filter((row) => row[3] < CONTRAST_MIN)
  h.record(
    `${name}: 色の役割 ${rows.length} 組が 4.5 以上（最小 ${Math.min(...rows.map((r) => r[3])).toFixed(2)}）`,
    weak.length === 0,
    weak.map((r) => r.slice(0, 3).join('/') + ' ' + r[3].toFixed(2)).join(', ')
  )
  const pairs = await pairRatios(page)
  h.record(
    `${name}: 上流のメッセージ ${pairs.length} 種が 4.5 以上（最小 ${Math.min(...pairs.map((r) => r[3])).toFixed(2)}）`,
    pairs.every((row) => row[3] >= CONTRAST_MIN),
    pairs.map((r) => r[0] + ' ' + r[3].toFixed(2)).join(', ')
  )
  console.log('  役割の表: ' + rows.map((r) => `${r[0]}@${r[2]}=${r[3].toFixed(2)}`).join(' '))

  // 条件 3: 画面の文字を走査（表、ツリー、テキスト）。主の画面のテキストの表示は、
  // テキストでしか開けない文書を開いたときだけ出る（Step10 D3、D6）ので、不正な文書を開いて撮る
  for (const mode of MODES) {
    if (mode === 'text') {
      await page.evaluate(() => window.fixture.nextOpen({ textOnly: true }))
      await open('/broken.json')
    } else {
      await h.switchTo(page, mode)
    }
    await page.waitForSelector(`.jse-${mode}-mode, .cm-editor`, { timeout: 5000 })
    await page.waitForTimeout(300)
    const result = await scanPage(page, '.jse-main')
    h.record(
      `${name}: ${mode} の文字 ${result.count} 件が 4.5 以上`,
      result.count > 0 && result.bad.length === 0,
      result.bad.slice(0, 4).join(' | ')
    )
    const bar = await scanPage(page, '.app-menubar')
    h.record(
      `${name}: ${mode} のメニューの行（切り替えを含む）の文字 ${bar.count} 件が 4.5 以上`,
      bar.count > 0 && bar.bad.length === 0,
      bar.bad.slice(0, 4).join(' | ')
    )
  }
  await open('/first.json')

  // 条件 3: 右クリックのメニューとモーダル
  await h.switchTo(page, 'tree')
  await page.waitForSelector('.jse-tree-mode', { timeout: 5000 })
  await page.locator('.jse-tree-mode .jse-key').first().click({ button: 'right' })
  await page.waitForSelector('div.jse-contextmenu', { timeout: 5000 })
  const menu = await scanPage(page, 'div.jse-contextmenu')
  h.record(
    `${name}: 右クリックのメニューの文字 ${menu.count} 件が 4.5 以上`,
    menu.count > 0 && menu.bad.length === 0,
    menu.bad.slice(0, 4).join(' | ')
  )
  await page.keyboard.press('Escape')
  await page.locator('.app-command-button[data-command="sort"]').first().click()
  await page.waitForSelector('.jse-modal', { timeout: 5000 })
  const modal = await scanPage(page, '.jse-modal')
  h.record(
    `${name}: モーダルの文字 ${modal.count} 件が 4.5 以上`,
    modal.count > 0 && modal.bad.length === 0,
    modal.bad.slice(0, 4).join(' | ')
  )
  await page.keyboard.press('Escape')

  // 条件 4: アクセントは 1 か所。変数を替えると見える色が替わる
  const accent = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.color = 'var(--app-accent)'
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
  h.record(`${name}: アクセントが ${EXPECTED_ACCENT}`, accent === 'rgb(242, 154, 185)', accent)
  await page.click('.app-menubar-button')
  const ring = () => page.evaluate(() => getComputedStyle(document.querySelector('.app-menu-item:focus')).boxShadow)
  await page.keyboard.press('ArrowDown')
  const before = await ring()
  await page.evaluate((value) => document.documentElement.style.setProperty('--app-accent', value), PROBE_ACCENT)
  const after = await ring()
  h.record(`${name}: アクセントの変数を替えるとメニューの枠が替わる`, before !== after && after.includes('rgb(18, 171, 52)'), `${before} -> ${after}`)
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-accent'))
  await page.keyboard.press('Escape')
  const buttons = await page.evaluate(() => {
    const css = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join('\n')
    return (css.match(/#f29ab9/gi) ?? []).length
  })
  h.record(`${name}: アクセントの値は CSS の 1 か所`, buttons === 1, String(buttons))

  // 桜の飾り: ダークだけ、右下、クリックを妨げない、文字を損なわない
  await page.evaluate(() => window.fixture.setMode('table'))
  await page.waitForSelector('.jse-table-mode', { timeout: 5000 })
  const sakura = () =>
    page.evaluate(`(() => {
      const editor = document.querySelector('.app-editor')
      const s = getComputedStyle(editor, '::after')
      const e = editor.getBoundingClientRect()
      const probe = document.createElement('i')
      probe.style.opacity = 'var(--sakura-opacity)'
      document.body.append(probe)
      const constant = Number(getComputedStyle(probe).opacity)
      probe.remove()
      return { content: s.content, opacity: Number(s.opacity), events: s.pointerEvents, image: s.backgroundImage,
        widthRatio: parseFloat(s.width) / e.width, position: s.position, constant }
    })()`)
  const dark = await sakura()
  h.record(`${name}: 桜がダークに出る`, dark.content !== 'none' && dark.image.includes('sakura'), dark.content + ' ' + dark.image.slice(0, 60))
  h.record(`${name}: 桜は pointer-events が none`, dark.events === 'none', dark.events)
  h.record(`${name}: 桜の幅は窓の幅の 22%、不透明度は 0.16 の定数`, Math.abs(dark.widthRatio - 0.22) < 0.01 && dark.opacity === 0.16 && dark.constant === 0.16, `${dark.widthRatio.toFixed(3)} ${dark.opacity} ${dark.constant}`)
  const worst = await page.evaluate(`(() => {
    const api = ${PAGE_LIB}
    const white = { r: 255, g: 255, b: 255, a: Number(getComputedStyle(document.querySelector('.app-editor'), '::after').opacity) }
    return ['--app-text', '--app-text-muted'].map((name) => {
      const bg = api.over(white, api.resolve('--app-bg'))
      return api.ratio(api.over(white, api.resolve(name)), bg)
    })
  })()`)
  h.record(`${name}: 桜の最も明るい点の下でも表の文字が 4.5 以上（最小 ${Math.min(...worst).toFixed(2)}）`, worst.every((v) => v >= CONTRAST_MIN), worst.join())
  const findPair = await page.evaluate(`(() => {
    const api = ${PAGE_LIB}
    const g = api.resolve('--app-find')
    return api.ratio(api.resolve('--app-find-text'), g)
  })()`)
  h.record(`${name}: 検索の当たりの文字が 4.5 以上（${findPair.toFixed(2)}）`, findPair >= CONTRAST_MIN)
  const btn = await page.evaluate(`(() => {
    const api = ${PAGE_LIB}
    return api.ratio(api.resolve('--app-accent-text'), api.resolve('--app-accent'))
  })()`)
  h.record(`${name}: 選んだボタンの文字が 4.5 以上（${btn.toFixed(2)}）`, btn >= CONTRAST_MIN)

  // 条件 1: 切り替えが設定へ渡り、反映される
  await page.click('.app-menubar-button:has-text("オプション")')
  await page.click('.app-menu-item:has-text("ライト")')
  h.record(`${name}: ライトへ切り替わる`, (await attr()) === 'light')
  {
    const lname = 'ライト'
    const light = await sakura()
    h.record(
      `${lname}: 桜が出る（sakura-light.png、幅 22%、不透明度 0.28 の定数、クリックを妨げない）`,
      light.content !== 'none' &&
        light.image.includes('sakura-light') &&
        light.events === 'none' &&
        Math.abs(light.widthRatio - 0.22) < 0.01 &&
        light.opacity === 0.28 &&
        light.constant === 0.28,
      `${light.content} ${light.image.slice(0, 70)} ${light.widthRatio.toFixed(3)} ${light.opacity} ${light.constant}`
    )
    const lworst = await page.evaluate(`(() => {
      const api = ${PAGE_LIB}
      const alpha = Number(getComputedStyle(document.querySelector('.app-editor'), '::after').opacity)
      const blend = getComputedStyle(document.querySelector('.app-editor'), '::after').mixBlendMode
      // ライトの桜は乗算。桜の色が白（無変化）から黒（地を 1-alpha 倍に暗く）までのどこに振れても、本文と補助の文字が読めるか（最悪の場合）
      const multiply = (backdrop, shade) => {
        const k = 1 - alpha + alpha * shade
        return { r: backdrop.r * k, g: backdrop.g * k, b: backdrop.b * k, a: 1 }
      }
      const pairs = [['--app-text', 1], ['--app-text', 0], ['--app-text-muted', 1], ['--app-text-muted', 0]]
      const ratios = pairs.map(([name, shade]) =>
        api.ratio(multiply(api.resolve(name), shade), multiply(api.resolve('--app-bg'), shade))
      )
      return blend === 'multiply' ? ratios : [0]
    })()`)
    h.record(`${lname}: 桜の最も明るい点と暗い点の下でも本文が 4.5 以上（最小 ${Math.min(...lworst).toFixed(2)}）`, lworst.every((v) => v >= CONTRAST_MIN), lworst.join())
    const lrows = await roleRatios(page)
    const lweak = lrows.filter((row) => row[3] < CONTRAST_MIN)
    h.record(
      `${lname}: 色の役割 ${lrows.length} 組が 4.5 以上（最小 ${Math.min(...lrows.map((r) => r[3])).toFixed(2)}）`,
      lweak.length === 0,
      lweak.map((r) => r.slice(0, 3).join('/') + ' ' + r[3].toFixed(2)).join(', ')
    )
    const lpairs = await pairRatios(page)
    h.record(
      `${lname}: 上流のメッセージ ${lpairs.length} 種が 4.5 以上（最小 ${Math.min(...lpairs.map((r) => r[3])).toFixed(2)}）`,
      lpairs.every((row) => row[3] >= CONTRAST_MIN),
      lpairs.map((r) => r[0] + ' ' + r[3].toFixed(2)).join(', ')
    )
    for (const mode of MODES) {
      await page.evaluate((value) => window.fixture.setMode(value), mode)
      await page.waitForSelector(`.jse-${mode}-mode, .cm-editor`, { timeout: 5000 })
      await page.waitForTimeout(300)
      const result = await scanPage(page, '.jse-main')
      h.record(
        `${lname}: ${mode} の文字 ${result.count} 件が 4.5 以上`,
        result.count > 0 && result.bad.length === 0,
        result.bad.slice(0, 4).join(' | ')
      )
    }
    const lfind = await page.evaluate(`(() => {
      const api = ${PAGE_LIB}
      return [api.ratio(api.resolve('--app-find-text'), api.resolve('--app-find')), api.ratio(api.resolve('--app-accent-text'), api.resolve('--app-accent'))]
    })()`)
    h.record(`${lname}: 検索の当たりと選んだボタンの文字が 4.5 以上（${lfind.map((v) => v.toFixed(2)).join(', ')}）`, lfind.every((v) => v >= CONTRAST_MIN))
    const lcolors = await page.evaluate(() => {
      const v = (n) => { const p = document.createElement('i'); p.style.color = 'var(' + n + ')'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c }
      return [v('--app-accent'), v('--app-surface')]
    })
    h.record(`${lname}: ワンポイントが #b9a3e3、面が #e0dbea`, lcolors.join() === 'rgb(185, 163, 227),rgb(224, 219, 234)', lcolors.join())
    const lstars = await page.evaluate(`(() => {
      const api = ${PAGE_LIB}
      const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
      const lstar = ({ r, g, b }) => {
        const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y
      }
      return ${JSON.stringify(LIGHT_GROUND_VARS)}.map((name) => [name, lstar(api.resolve(name))])
    })()`)
    const lbright = lstars.filter(([, value]) => value > LIGHT_GROUND_LSTAR_MAX)
    h.record(
      `${lname}: 地と面 ${lstars.length} 色が L* ${LIGHT_GROUND_LSTAR_MAX} 以下（最大 ${Math.max(...lstars.map((r) => r[1])).toFixed(1)}）`,
      lbright.length === 0,
      lbright.map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')
    )
  }
  h.record(
    `${name}: ライトの地が少し濁した藤色（#eae6f1）`,
    (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(234, 230, 241)'
  )
  await page.click('.app-menubar-button:has-text("オプション")')
  await page.click('.app-menu-item:has-text("ダーク")')
  const themeCalls = (await page.evaluate(() => window.fixture.state())).themeCalls
  h.record(`${name}: 切り替えが保存の入口へ渡る`, themeCalls.join() === 'light,dark', themeCalls.join())

  // 条件 6: 全モードを往復しても文書と未保存の判定が変わらない
  const text0 = await page.evaluate(() => window.fixture.text())
  const dirty0 = (await page.evaluate(() => window.fixture.state())).dirty
  for (const mode of [...MODES, 'table']) {
    await page.evaluate((value) => window.fixture.setMode(value), mode)
    await page.waitForTimeout(200)
  }
  const end = await page.evaluate(() => window.fixture.state())
  const text1 = await page.evaluate(() => window.fixture.text())
  h.record(`${name}: 全モードの往復で文書が変わらない`, text0 === text1)
  h.record(`${name}: 全モードの往復で未保存の判定が変わらない`, end.dirty === dirty0, `${dirty0} -> ${end.dirty}`)
  h.record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await page.close()
}
