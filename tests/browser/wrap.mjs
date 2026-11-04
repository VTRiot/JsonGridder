// 右端で折り返す（Options の項目）と、表の列の幅のドラッグの試験。実物の殻を使う。
const SETTLE_MS = 300
const ROWS = 200
const SEARCH_ROW = 150
const NEEDLE = `needle${SEARCH_ROW}`
// 表が自分で広げる列の幅の上限（TableMode.scss の $wrap-auto-max-width）と、セルの右の余白の合計の上限
const WRAP_AUTO_MAX_WIDTH = 360
const CELL_PADDING_ALLOWANCE = 16
// ドラッグの最小（tableLayout.ts の MIN_COLUMN_WIDTH）
const MIN_COLUMN_WIDTH = 48
const DRAG_PX = 80
// 位置の比較の誤差（px）。小数の丸めの分
const EPSILON = 1.5
const SCROLL_STEPS = 6
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'

function longText(index) {
  const repeat = (index % 4) + 1
  const words = Array.from({ length: repeat * 4 }, () => WORDS).join(' ')
  return index === SEARCH_ROW ? `${words} ${NEEDLE}` : `${index} ${words}`
}

function documentText() {
  const rows = Array.from({ length: ROWS }, (_, index) => ({
    id: index,
    text: index === 1 ? 'ABCDEFGHIJ'.repeat(60) : longText(index),
    note: `n${index}`
  }))
  return JSON.stringify(rows)
}

// 上の行が短く、下の行が長い文書。測った行（上の短い行）からの見積もりが大きく外れる
const SHORT_HEAD_ROWS = 30
function shortHeadText() {
  const rows = Array.from({ length: ROWS }, (_, index) => ({
    id: index,
    text: index < SHORT_HEAD_ROWS ? `s${index}` : longText(index),
    note: `n${index}`
  }))
  return JSON.stringify(rows)
}

const SHORT_HEAD = '/wrap-short-head.json'

// 見出しの 2 段（Step10 S6、D8）の文書。入れ子の列（address.city）と 3 段の入れ子（address.geo.lat）、入れ子でない列
const NESTED = '/nested-header.json'
const NESTED_ROWS = 60
const NESTED_SCROLL_PX = 400
const CITIES = ['Tokyo', 'Osaka', 'Nagoya', 'Sapporo', 'Fukuoka']
function nestedText() {
  const rows = Array.from({ length: NESTED_ROWS }, (_, index) => ({
    id: index,
    name: `name${index}`,
    address: { city: CITIES[index % CITIES.length], zip: `100-${String(index).padStart(4, '0')}`, geo: { lat: index / 10, lng: -index / 10 } },
    tags: ['t']
  }))
  return JSON.stringify(rows)
}

/** 見出しの 2 段の各セルの文字と位置、データの 1 行目のセルの位置。 */
function headerFacts(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const headerRows = [...document.querySelectorAll('.jse-table-mode tr.jse-table-row-header')]
    const cells = (tr) =>
      [...tr.children].map((th) => ({
        text: th.textContent.trim(),
        colspan: th.colSpan,
        rowspan: th.rowSpan,
        rect: rect(th),
        name: th.querySelector('.jse-column-name') ? rect(th.querySelector('.jse-column-name')) : null
      }))
    const firstRow = document.querySelector('.jse-table-mode tr.jse-table-row:not(.jse-table-row-header) th.jse-table-cell-gutter')?.parentElement
    const contents = document.querySelector('.jse-table-mode .jse-contents')
    return {
      rows: headerRows.map(cells),
      data: firstRow ? [...firstRow.children].map(rect) : [],
      dataText: firstRow ? [...firstRow.children].map((cell) => cell.innerText.trim()) : [],
      contentsTop: contents ? contents.getBoundingClientRect().top : null
    }
  })
}
const near = (a, b) => Math.abs(a - b) <= EPSILON

const DOC = '/wrap.json'
const OTHER = '/wrap-other.json'

let h

const state = (page) => page.evaluate(() => window.fixture.state())
const docText = (page) => page.evaluate(() => window.fixture.text())
const settle = (page) => page.waitForTimeout(SETTLE_MS)

async function shellPage(browser, base, query = '', first = DOC) {
  const { page, problems } = await h.openPage(browser, `${base}?shell${query}`)
  await page.waitForFunction(() => window.fixture !== undefined)
  await page.evaluate(
    ([doc, other, shortHead, nested, text, shortText, nestedDoc]) => {
      window.fixture.addFile(doc, text)
      window.fixture.addFile(other, text)
      window.fixture.addFile(shortHead, shortText)
      window.fixture.addFile(nested, nestedDoc)
    },
    [DOC, OTHER, SHORT_HEAD, NESTED, documentText(), shortHeadText(), nestedText()]
  )
  await page.evaluate((path) => window.fixture.open(path, {}), first)
  // 正しい文書は既定でツリーで開く（Step10 D3）。折り返しと列の幅は表で測る
  await h.switchTo(page, '表')
  await page.waitForSelector('.jse-table-mode td.jse-table-cell')
  await settle(page)
  return { page, problems }
}

async function toggleWrap(page) {
  await page.click('.app-menubar-button:has-text("オプション")')
  await page.locator('.app-menu-item', { hasText: '右端で折り返す' }).click()
  await settle(page)
}

async function menuChecked(page) {
  await page.click('.app-menubar-button:has-text("オプション")')
  const checked = await page.locator('.app-menu-item', { hasText: '右端で折り返す' }).getAttribute('aria-checked')
  await page.keyboard.press('Escape')
  return checked
}

/** 行 `row` の列 `column` のセルと、表の見た目の数値。 */
function cellMetrics(page, row, column) {
  return page.evaluate(
    ([rowIndex, columnName]) => {
      const contents = document.querySelector('.jse-table-mode .jse-contents')
      const headers = [...document.querySelectorAll('tr.jse-table-row-header th')]
      const columnIndex = headers.findIndex((th) => th.querySelector('.jse-column-name')?.textContent.trim() === columnName)
      const gutter = [...document.querySelectorAll('th.jse-table-cell-gutter')].find(
        (th) => th.firstChild?.textContent.trim() === String(rowIndex)
      )
      if (!contents || columnIndex < 0 || !gutter) {
        const rendered = [...document.querySelectorAll('th.jse-table-cell-gutter')].map((th) => th.firstChild?.textContent.trim())
        return { missing: true, scrollTop: contents?.scrollTop, scrollHeight: contents?.scrollHeight, rendered: `${rendered[0]}..${rendered.at(-1)}` }
      }
      const tr = gutter.parentElement
      const td = tr.children[columnIndex]
      const outer = td.querySelector('.jse-value-outer')
      const lineHeight = parseFloat(getComputedStyle(td).lineHeight)
      const view = contents.getBoundingClientRect()
      const row = tr.getBoundingClientRect()
      const lastHeader = headers.at(-1).getBoundingClientRect()
      const headerBottom = lastHeader.bottom
      return {
        rowHeight: row.height,
        lineHeight,
        cellWidth: td.getBoundingClientRect().width,
        outerScroll: outer.scrollWidth,
        outerClient: outer.clientWidth,
        tdScroll: td.scrollWidth,
        tdClient: td.clientWidth,
        contentsScroll: contents.scrollWidth,
        contentsClient: contents.clientWidth,
        viewRight: view.left + contents.clientWidth,
        lastRight: lastHeader.right,
        // 行が窓より高いこともあるので、見える幅に重なっていれば見えている（見出しの帯の下）
        rowVisible: row.height > 0 && row.bottom > headerBottom && row.top < view.bottom,
        rowEndsInView: row.bottom <= view.bottom + 1,
        rowTop: row.top,
        rowBottom: row.bottom,
        viewTop: view.top,
        viewBottom: view.bottom,
        scrollTop: contents.scrollTop,
        scrollHeight: contents.scrollHeight
      }
    },
    [row, column]
  )
}

const headerWidth = (page, column) =>
  page.evaluate((name) => {
    const th = [...document.querySelectorAll('tr.jse-table-row-header th')].find(
      (cell) => cell.querySelector('.jse-column-name')?.textContent.trim() === name
    )
    return th ? th.getBoundingClientRect().width : null
  }, column)

async function dragColumnEdge(page, column, dx) {
  const box = await page.evaluate((name) => {
    const th = [...document.querySelectorAll('tr.jse-table-row-header th')].find(
      (cell) => cell.querySelector('.jse-column-name')?.textContent.trim() === name
    )
    const handle = th?.querySelector('.jse-column-resizer')
    if (!handle) return null
    const rect = handle.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, column)
  if (!box) return false
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x + dx / 2, box.y)
  await page.mouse.move(box.x + dx, box.y)
  await page.mouse.up()
  await settle(page)
  return true
}

/** 一番下まで送る。行の高さの記録が更新されると下端が伸びるので、何度か送る。 */
async function scrollToBottom(page) {
  for (let step = 0; step < SCROLL_STEPS; step++) {
    await page.evaluate(() => {
      const contents = document.querySelector('.jse-table-mode .jse-contents')
      contents.scrollTop = contents.scrollHeight
    })
    await settle(page)
  }
}

/** 検索の欄で NEEDLE を探し、飛び終えた後の行 SEARCH_ROW の数値を返す。 */
async function searchRow(page) {
  await page.click('td.jse-table-cell >> nth=0')
  await page.keyboard.press('Control+F')
  await page.waitForSelector('.jse-search-box', { timeout: h.STATE_TIMEOUT_MS })
  await page.fill('.jse-search-input, .jse-search-section input', NEEDLE)
  // 飛ぶ動きは時間をかけて動くので、行が見えるまで待つ（見えなければ時間切れで呼び手の判定が落ちる）
  await h.reaches(
    page,
    (row) => {
      const gutter = [...document.querySelectorAll('th.jse-table-cell-gutter')].find(
        (th) => th.firstChild?.textContent.trim() === row
      )
      const view = document.querySelector('.jse-table-mode .jse-contents')?.getBoundingClientRect()
      const rect = gutter?.getBoundingClientRect()
      return !!rect && !!view && rect.bottom > view.top && rect.top < view.bottom
    },
    String(SEARCH_ROW)
  )
  // 飛び終えた後も見えたままであること
  await settle(page)
  await settle(page)
  return cellMetrics(page, SEARCH_ROW, 'text')
}

export async function testWrap(browser, base, helpers) {
  h = helpers
  const { record } = h
  const name = '右端で折り返す'

  {
    const { page, problems } = await shellPage(browser, base)
    const original = await docText(page)

    // オフ（既定）: 今までどおり 1 行
    let off = await cellMetrics(page, 0, 'text')
    record(`${name}: オフの長い文字の行は 1 行の高さ`, off !== null && off.rowHeight < off.lineHeight * 1.5, JSON.stringify(off))
    record(`${name}: オフの長い文字はセルからはみ出す（横スクロールが要る）`, off !== null && off.contentsScroll > off.contentsClient, JSON.stringify(off))
    record(`${name}: 既定のメニューのチェックはオフ`, (await menuChecked(page)) === 'false')

    // オン
    await toggleWrap(page)
    const on = await cellMetrics(page, 0, 'text')
    record(`${name}: オンで長い文字の行が 2 行以上の高さになる`, on !== null && on.rowHeight > on.lineHeight * 1.5, JSON.stringify(on))
    record(`${name}: オンで長い文字のセルの中に全文が収まる`, on !== null && on.outerScroll <= on.outerClient && on.tdScroll <= on.tdClient, JSON.stringify(on))
    record(`${name}: オンで表の横スクロールが無い`, on !== null && on.contentsScroll <= on.contentsClient, JSON.stringify(on))
    record(`${name}: 内容に合わせた列の幅は上限まで`, on !== null && on.cellWidth <= WRAP_AUTO_MAX_WIDTH + CELL_PADDING_ALLOWANCE, JSON.stringify(on))
    record(`${name}: 一番右の列の右端が表の見える幅の右端に揃う`, on !== null && Math.abs(on.lastRight - on.viewRight) <= EPSILON, JSON.stringify(on))
    const alnum = await cellMetrics(page, 1, 'text')
    record(`${name}: 長い英数字の連続も折り返す`, alnum !== null && alnum.rowHeight > alnum.lineHeight * 1.5 && alnum.outerScroll <= alnum.outerClient, JSON.stringify(alnum))
    let s = await state(page)
    record(`${name}: 切り替えで文書が変わらない`, (await docText(page)) === original)
    record(`${name}: 切り替えで未保存の印が付かない`, s.dirty === false && s.reports.at(-1)?.unsaved === false, JSON.stringify(s.reports.at(-1)))
    record(`${name}: 切り替えを保存する`, JSON.stringify(s.wrapCalls) === '[true]', JSON.stringify(s.wrapCalls))
    record(`${name}: メニューのチェックがオン`, (await menuChecked(page)) === 'true')

    // 列の境目のドラッグ: 幅が変わり、並べ替えが起きない
    const before = await headerWidth(page, 'id')
    const dragged = await dragColumnEdge(page, 'id', DRAG_PX)
    const after = await headerWidth(page, 'id')
    record(`${name}: 列の境目のドラッグで幅が広がる`, dragged && Math.abs(after - before - DRAG_PX) <= EPSILON * 2, `${before} -> ${after}`)
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
    record(`${name}: ドラッグで画面の文字が選択されない`, selected === '', JSON.stringify(selected.slice(0, 40)))
    const sortIcons = await page.locator('.jse-column-sort-icon').count()
    record(`${name}: ドラッグで並べ替えが起きない`, sortIcons === 0 && (await docText(page)) === original, `icons=${sortIcons}`)
    await dragColumnEdge(page, 'text', -2000)
    const narrow = await headerWidth(page, 'text')
    record(`${name}: 列の幅は最小で止まる`, Math.abs(narrow - MIN_COLUMN_WIDTH) <= EPSILON, String(narrow))
    // 窓の外でボタンを離して mouseup が届かなかった: 次の動きでドラッグを終え、以後の動きで幅が変わらない
    const lostRelease = await page.evaluate(async (name) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const th = [...document.querySelectorAll('tr.jse-table-row-header th')].find(
        (cell) => cell.querySelector('.jse-column-name')?.textContent.trim() === name
      )
      const handle = th.querySelector('.jse-column-resizer')
      const x = handle.getBoundingClientRect().left
      const before = th.getBoundingClientRect().width
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: x }))
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0, clientX: x + 100 }))
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x + 100 }))
      await frame()
      await frame()
      return { before, after: th.getBoundingClientRect().width }
    }, 'id')
    record(`${name}: mouseup を取り逃しても掴みっぱなしにならない`, Math.abs(lostRelease.after - lostRelease.before) <= EPSILON, JSON.stringify(lostRelease))
    const narrowCell = await cellMetrics(page, 0, 'text')
    record(`${name}: 狭めた列でも全文がセルに収まる`, narrowCell !== null && narrowCell.outerScroll <= narrowCell.outerClient, JSON.stringify(narrowCell))
    record(`${name}: 列の幅を変えても文書と未保存の印が変わらない`, (await docText(page)) === original && (await state(page)).dirty === false)

    // 別の文書を開くと列の幅は戻る
    await page.evaluate((path) => window.fixture.open(path, {}), OTHER)
    await h.switchTo(page, '表')
    await settle(page)
    const sized = await page.locator('th.jse-column-sized').count()
    record(`${name}: 別の文書を開くと列の幅が戻る`, sized === 0, `sized=${sized}`)

    // 200 行の高さがばらばらの文書で下まで送ると、最後の行が見える
    await scrollToBottom(page)
    const last = await cellMetrics(page, ROWS - 1, 'text')
    record(`${name}: 下まで送ると最後の行の下端まで見える`, last !== null && last.rowVisible && last.rowEndsInView, JSON.stringify(last))

    // 行 150 の検索で該当の行が見える
    await page.evaluate(() => {
      document.querySelector('.jse-table-mode .jse-contents').scrollTop = 0
    })
    await settle(page)
    const found = await searchRow(page)
    record(`${name}: 行 ${SEARCH_ROW} の検索で該当の行が見える`, found !== null && found.rowVisible, JSON.stringify(found))
    await page.keyboard.press('Escape')
    await settle(page)

    // 折り返したセルを編集して確定しても値に改行が入らない
    await page.evaluate(() => {
      document.querySelector('.jse-table-mode .jse-contents').scrollTop = 0
    })
    await settle(page)
    const cellText = await page.evaluate(() => JSON.parse(window.fixture.text())[0].text)
    const target = page.locator('tr.jse-table-row:has(th.jse-table-cell-gutter:text-is("0")) td >> nth=1')
    await target.click()
    await page.keyboard.press('Enter')
    await page.waitForSelector('.jse-editable-div[contenteditable="true"]', { timeout: h.STATE_TIMEOUT_MS })
    await page.keyboard.press('End')
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Z')
    await page.keyboard.press('Enter')
    await settle(page)
    const edited = await page.evaluate(() => JSON.parse(window.fixture.text())[0].text)
    record(`${name}: 折り返したセルを編集して確定しても改行が入らない`, edited === `${cellText}Z` && !edited.includes('\n'), JSON.stringify(edited.slice(-20)))

    // オフに戻すと 1 行
    await toggleWrap(page)
    off = await cellMetrics(page, 2, 'text')
    record(`${name}: オフに戻すと 1 行の高さ`, off !== null && off.rowHeight < off.lineHeight * 1.5, JSON.stringify(off))
    // 折り返していたときに測った行の高さが残ると、描かれていない行の分の余白が伸びたままになる
    record(
      `${name}: オフに戻すと表の全体の高さも 1 行ずつに戻る`,
      off !== null && off.scrollHeight < ROWS * off.lineHeight * 1.5,
      `${off?.scrollHeight}`
    )
    s = await state(page)
    record(`${name}: オフも保存する`, JSON.stringify(s.wrapCalls) === '[true,false]', JSON.stringify(s.wrapCalls))
    record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 3).join(' / '))
    await page.close()
  }

  {
    // 起動で効く。ツリーとテキストも窓の幅で折り返す
    const { page, problems } = await shellPage(browser, base, '&wrap=on')
    const on = await cellMetrics(page, 0, 'text')
    record(`${name}: 設定がオンなら起動から折り返す`, on !== null && on.rowHeight > on.lineHeight * 1.5, JSON.stringify(on))
    record(`${name}: 起動のメニューのチェックがオン`, (await menuChecked(page)) === 'true')

    await h.switchTo(page, 'ツリー')
    await settle(page)
    const tree = await page.evaluate(() => {
      const contents = document.querySelector('.jse-tree-mode .jse-contents')
      const value = [...document.querySelectorAll('.jse-tree-mode .jse-value')].find((element) =>
        element.textContent.startsWith('0 lorem')
      )
      if (!contents || !value) return null
      const lineHeight = parseFloat(getComputedStyle(value).lineHeight)
      return {
        height: value.getBoundingClientRect().height,
        lineHeight,
        right: value.getBoundingClientRect().right,
        viewRight: contents.getBoundingClientRect().left + contents.clientWidth,
        scroll: contents.scrollWidth,
        client: contents.clientWidth
      }
    })
    record(
      `${name}: ツリーの長い値が窓の幅で折り返す`,
      tree !== null && tree.height > tree.lineHeight * 1.5 && tree.right <= tree.viewRight + EPSILON && tree.scroll <= tree.client,
      JSON.stringify(tree)
    )

    await h.switchTo(page, 'テキスト')
    await settle(page)
    const text = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')
      const content = document.querySelector('.cm-content')
      if (!scroller || !content) return null
      return {
        wrapping: content.classList.contains('cm-lineWrapping'),
        scroll: scroller.scrollWidth,
        client: scroller.clientWidth
      }
    })
    record(`${name}: テキストの長い行が窓の幅で折り返す`, text !== null && text.wrapping && text.scroll <= text.client, JSON.stringify(text))
    const s = await state(page)
    record(`${name}: 表示を回しても未保存の印が付かない`, s.dirty === false)
    record(`${name}: 起動の試験のエラーが 0 件`, problems.length === 0, problems.slice(0, 3).join(' / '))
    await page.close()
  }

  {
    // 上の行が短く下の行が長い文書で、開いてすぐ検索する（測った行がほとんど無い）
    const { page, problems } = await shellPage(browser, base, '&wrap=on', SHORT_HEAD)
    const found = await searchRow(page)
    record(`${name}: 見積もりが外れる文書でも行 ${SEARCH_ROW} の検索で該当の行が見える`, found !== null && found.rowVisible, JSON.stringify(found))
    record(`${name}: 見積もりが外れる文書の試験のエラーが 0 件`, problems.length === 0, problems.slice(0, 3).join(' / '))
    await page.close()
  }

  await testHeaderRows(browser, base)
}

/** 見出しの 2 段（Step10 S6、D8）。入れ子の値は親のキーを上の段、子のキーを下の段に出す。 */
async function testHeaderRows(browser, base) {
  const { record } = h
  const name = '見出しの 2 段'

  // 入れ子の無い文書は今までどおり 1 段
  {
    const { page, problems } = await shellPage(browser, base)
    const flat = await headerFacts(page)
    record(`${name}: 入れ子の無い文書は 1 段のまま`, flat.rows.length === 1 && flat.rows[0].every((cell) => cell.rowspan === 1 && cell.colspan === 1), JSON.stringify(flat.rows.map((row) => row.map((cell) => cell.text))))
    record(`${name}: 1 段の文書のエラーが 0 件`, problems.length === 0, problems.slice(0, 3).join(' / '))
    await page.close()
  }

  const { page, problems } = await shellPage(browser, base, '', NESTED)
  const original = await docText(page)
  let facts = await headerFacts(page)
  const [top, bottom] = facts.rows
  record(`${name}: 入れ子の列があると 2 段`, facts.rows.length === 2, String(facts.rows.length))
  record(
    `${name}: 上の段は入れ子でない列と親のキー`,
    JSON.stringify(top?.map((cell) => cell.text)) === JSON.stringify(['', 'id', 'name', 'address', 'tags']),
    JSON.stringify(top?.map((cell) => cell.text))
  )
  record(
    `${name}: 下の段は子のキー（3 段以上は点でつなぐ）`,
    JSON.stringify(bottom?.map((cell) => cell.text)) === JSON.stringify(['city', 'zip', 'geo.lat', 'geo.lng']),
    JSON.stringify(bottom?.map((cell) => cell.text))
  )
  record(`${name}: 親のキーは子の列をまとめる（colspan 4）`, top?.[3]?.colspan === 4, String(top?.[3]?.colspan))
  record(
    `${name}: 入れ子でない列と行番号の列は 2 段を通す（rowspan 2）`,
    [0, 1, 2, 4].every((index) => top?.[index]?.rowspan === 2),
    JSON.stringify(top?.map((cell) => cell.rowspan))
  )
  const id = top?.[1]
  const centerX = (r) => (r.left + r.right) / 2
  const centerY = (r) => (r.top + r.bottom) / 2
  record(
    `${name}: 入れ子でない列のラベルは縦横の中央`,
    id?.name !== null && near(centerX(id.name), centerX(id.rect)) && Math.abs(centerY(id.name) - centerY(id.rect)) <= EPSILON * 2,
    JSON.stringify({ name: id?.name, th: id?.rect })
  )
  // 列の位置: 見出しのセルとデータのセルの左右が揃う（行番号の列 1 + id + name の後が address.city）
  const NESTED_FIRST_DATA_INDEX = 3
  const aligned = (bottom ?? []).every(
    (cell, index) => near(cell.rect.left, facts.data[NESTED_FIRST_DATA_INDEX + index]?.left) && near(cell.rect.right, facts.data[NESTED_FIRST_DATA_INDEX + index]?.right)
  )
  record(`${name}: 下の段のセルはデータの列と揃う`, aligned, JSON.stringify({ bottom: bottom?.map((cell) => [cell.rect.left, cell.rect.right]), data: facts.data.map((r) => [r.left, r.right]) }))
  record(
    `${name}: 親のキーのセルは子の列の左端から右端まで`,
    near(top?.[3]?.rect.left, bottom?.[0]?.rect.left) && near(top?.[3]?.rect.right, bottom?.at(-1)?.rect.right),
    JSON.stringify({ group: top?.[3]?.rect, first: bottom?.[0]?.rect, last: bottom?.at(-1)?.rect })
  )
  record(`${name}: 下の段は上の段の真下`, near(bottom?.[0]?.rect.top, top?.[3]?.rect.bottom), JSON.stringify({ group: top?.[3]?.rect, nested: bottom?.[0]?.rect }))
  record(`${name}: 表の文字列は引用符なし（D10）`, facts.dataText[NESTED_FIRST_DATA_INDEX] === 'Tokyo' && facts.dataText[2] === 'name0', JSON.stringify(facts.dataText))

  // 送っても 2 段とも上に残る
  await page.evaluate((px) => {
    document.querySelector('.jse-table-mode .jse-contents').scrollTop = px
  }, NESTED_SCROLL_PX)
  await settle(page)
  facts = await headerFacts(page)
  record(
    `${name}: 送っても 2 段の見出しが上に残る`,
    near(facts.rows[0]?.[3]?.rect.top, facts.contentsTop) && near(facts.rows[1]?.[0]?.rect.top, facts.rows[0]?.[3]?.rect.bottom),
    JSON.stringify({ contentsTop: facts.contentsTop, group: facts.rows[0]?.[3]?.rect, nested: facts.rows[1]?.[0]?.rect })
  )
  await page.evaluate(() => {
    document.querySelector('.jse-table-mode .jse-contents').scrollTop = 0
  })
  await settle(page)

  // 親のキーのセルを押しても何も起きない
  await page.locator('th.jse-table-cell-header-group').click()
  await settle(page)
  record(`${name}: 親のキーを押しても並べ替えない`, (await docText(page)) === original && (await page.locator('.jse-column-sort-icon').count()) === 0)

  // 下の段の列の幅のドラッグは、その列だけに効く
  const zipBefore = await headerWidth(page, 'zip')
  const cityBefore = await headerWidth(page, 'city')
  const dragged = await dragColumnEdge(page, 'zip', DRAG_PX)
  const zipAfter = await headerWidth(page, 'zip')
  record(`${name}: 下の段の列の境目のドラッグで幅が広がる`, dragged && Math.abs(zipAfter - zipBefore - DRAG_PX) <= EPSILON * 2, `${zipBefore} -> ${zipAfter}`)
  record(`${name}: 隣の列（city）の幅は変わらない`, near(await headerWidth(page, 'city'), cityBefore))
  facts = await headerFacts(page)
  record(
    `${name}: ドラッグの後も見出しとデータの列が揃う`,
    near(facts.rows[1]?.[1]?.rect.right, facts.data[NESTED_FIRST_DATA_INDEX + 1]?.right) && near(facts.rows[0]?.[3]?.rect.right, facts.rows[1]?.at(-1)?.rect.right),
    JSON.stringify({ zip: facts.rows[1]?.[1]?.rect, data: facts.data[NESTED_FIRST_DATA_INDEX + 1] })
  )
  record(`${name}: ドラッグで文書が変わらない`, (await docText(page)) === original)

  // 下の段の見出しで並べ替えると、列のパス全体（address.city）で並ぶ
  await page.locator('tr.jse-table-row-header-bottom .jse-column-header', { hasText: 'city' }).click()
  const sorted = await h.reaches(
    page,
    () => {
      const cities = JSON.parse(window.fixture.text()).map((row) => row.address.city)
      return cities.every((city, index) => index === 0 || cities[index - 1].localeCompare(city) <= 0)
    }
  )
  record(`${name}: 下の段の見出しの並べ替えは address.city で並ぶ`, sorted, (await docText(page)).slice(0, 120))
  record(
    `${name}: 並べ替えの印は押した列（city）に出る`,
    (await page.locator('tr.jse-table-row-header-bottom th', { hasText: 'city' }).locator('.jse-column-sort-icon').count()) === 1
  )

  // 検索の欄は 2 段の見出しの下に出る
  await page.click('td.jse-table-cell >> nth=0')
  await page.keyboard.press('Control+F')
  await page.waitForSelector('.jse-search-box', { timeout: h.STATE_TIMEOUT_MS })
  await settle(page)
  const search = await page.evaluate(() => ({
    box: document.querySelector('.jse-search-box').getBoundingClientRect().top,
    header: document.querySelector('tr.jse-table-row-header-bottom th').getBoundingClientRect().bottom
  }))
  record(`${name}: 検索の欄は 2 段目の見出しに重ならない`, search.box >= search.header - EPSILON, JSON.stringify(search))
  await page.keyboard.press('Escape')

  // 折り返すと見出しの高さが変わっても、下の段は上の段の真下
  await toggleWrap(page)
  facts = await headerFacts(page)
  record(`${name}: 折り返しても下の段は上の段の真下`, near(facts.rows[1]?.[0]?.rect.top, facts.rows[0]?.[3]?.rect.bottom), JSON.stringify({ group: facts.rows[0]?.[3]?.rect, nested: facts.rows[1]?.[0]?.rect }))
  await toggleWrap(page)
  record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 3).join(' / '))
  await page.close()
}
