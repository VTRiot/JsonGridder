// 検索と置換の試験（step9_001）。実 Chromium で、表の検索の欄の表示崩れと、3 つの表示の置換を確かめる。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ja = JSON.parse(fs.readFileSync(path.join(here, '../../src/i18n/ja.json'), 'utf8'))

const CITIES = ['東京', '大阪', '名古屋', '福岡', '札幌']
const ROW_COUNT = 60
const AKITA_ROW = 5
const rows = Array.from({ length: ROW_COUNT }, (_, index) => ({
  id: index + 1,
  city: index === AKITA_ROW ? '秋田' : CITIES[index % CITIES.length],
  note: `メモ ${index + 1}`,
  tags: ['sample', `level ${index % 3}`]
}))
const TEXT = JSON.stringify(rows)
const TOKYO_ROWS = rows.filter((row) => row.city === '東京').length
const REPLACEMENT = 'TOKYO'
const SETTLE_MS = 700

export async function testSearch(browser, base, tools) {
  const { record, openPage, switchTo } = tools
  const url = (mode) => `${base}?product&mode=${mode}&text=${encodeURIComponent(TEXT)}`

  const docText = (page) => page.evaluate(() => window.fixture.text())
  const docRows = async (page) => JSON.parse(await docText(page))
  const count = (value, word) => value.split(word).length - 1
  const settle = (page) => page.waitForTimeout(SETTLE_MS)

  // 表: 検索の欄を開いたときの帯が、表の幅いっぱいで、行の手前だけにある
  async function bandGeometry(page) {
    return page.evaluate(() => {
      const band = document.querySelector('.jse-search-box-background td')
      const table = document.querySelector('table.jse-table-main')
      const firstRow = document.querySelector('tr.jse-table-row:not(.jse-table-row-header)')
      const header = document.querySelector('tr.jse-table-row-header')
      if (!band || !table || !firstRow || !header) return null
      const b = band.getBoundingClientRect()
      const t = table.getBoundingClientRect()
      return {
        bandWidth: b.width,
        tableWidth: t.width,
        bandHeight: b.height,
        gap: firstRow.getBoundingClientRect().top - header.getBoundingClientRect().bottom
      }
    })
  }

  async function openTableSearch(page) {
    await page.click('td.jse-table-cell')
    await page.keyboard.press('Control+F')
    await page.waitForSelector('.jse-search-box', { timeout: 3000 })
  }

  {
    const name = '表の検索の欄の帯'
    const { page, problems } = await openPage(browser, url('table'))
    await page.waitForSelector('.jse-table-mode')
    await openTableSearch(page)
    await settle(page)
    const top = await bandGeometry(page)
    record(`${name}: 先頭で開いても表の幅いっぱい`, !!top && top.bandWidth >= top.tableWidth - 1, JSON.stringify(top))

    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const contents = document.querySelector('.jse-contents')
      contents.scrollTop = contents.scrollHeight
    })
    await settle(page)
    await page.click('td.jse-table-cell:not(.jse-table-cell-gutter)').catch(() => {})
    await page.keyboard.press('Control+F')
    await page.waitForSelector('.jse-search-box', { timeout: 3000 })
    await page.keyboard.type('秋田')
    await page.keyboard.press('Enter')
    await settle(page)
    const found = await bandGeometry(page)
    record(`${name}: 下から検索して先頭へ戻っても表の幅いっぱい`, !!found && found.bandWidth >= found.tableWidth - 1, JSON.stringify(found))
    record(`${name}: 見出しと最初の行の間が検索の欄の高さ以内`, !!found && found.gap <= 100 + 2, JSON.stringify(found))
    record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }

  // 3 つの表示で、置換の欄、1 件の置換、全部の置換、Ctrl+Z 1 回
  for (const mode of ['table', 'tree']) {
    const name = `${mode === 'table' ? '表' : 'ツリー'}の置換`
    const { page, problems } = await openPage(browser, url(mode))
    await page.waitForSelector(mode === 'table' ? '.jse-table-mode' : '.jse-tree-mode')
    await page.click(mode === 'table' ? 'td.jse-table-cell' : '.jse-tree-mode .jse-contents').catch(() => {})
    await page.keyboard.press('Control+F')
    await page.waitForSelector('.jse-search-box', { timeout: 3000 })
    record(`${name}: 置換の欄は最初は閉じている`, (await page.locator('.jse-replace-input').count()) === 0)
    await page.keyboard.press('Control+H')
    record(
      `${name}: Ctrl+H で置換の欄が開く`,
      await page.waitForSelector('.jse-replace-input', { timeout: 3000 }).then(() => true, () => false)
    )
    const title = await page.getAttribute('.jse-replace-toggle', 'title')
    record(`${name}: ▶ のツールチップが辞書の文言`, title === ja['editor.toggleReplaceOptions'], String(title))

    await page.fill('.jse-search-input, .jse-search-section input', '東京')
    await page.waitForTimeout(SETTLE_MS)
    await page.fill('.jse-replace-input', REPLACEMENT)
    const before = await docText(page)
    await page.click('.jse-replace-section button[title="' + ja['editor.replaceCtrlEnter'] + '"]')
    await settle(page)
    const afterOne = await docText(page)
    record(`${name}: 1 件の置換で 1 件だけ変わる`, count(afterOne, REPLACEMENT) === 1 && count(before, '東京') - count(afterOne, '東京') === 1, `${count(afterOne, REPLACEMENT)}`)
    await page.click('.jse-replace-section button[title="' + ja['editor.replaceAllTitle'] + '"]')
    await settle(page)
    const afterAll = await docText(page)
    record(`${name}: 全部の置換で残りが全部変わる`, count(afterAll, '東京') === 0 && count(afterAll, REPLACEMENT) === TOKYO_ROWS, `${count(afterAll, REPLACEMENT)}/${TOKYO_ROWS}`)
    await page.keyboard.press('Control+Z')
    await settle(page)
    const undone = await docText(page)
    record(`${name}: 全部の置換の後の Ctrl+Z 1 回で全部の置換の前へ戻る`, undone === afterOne, `置換語 ${count(undone, REPLACEMENT)} 件`)
    // 一致の無い置換は履歴を作らない。置換の欄の Ctrl+Z が、古い編集を戻してはならない
    await page.fill('.jse-search-input, .jse-search-section input', 'ZZZ存在しない')
    await page.waitForTimeout(SETTLE_MS)
    await page.click('.jse-replace-section button[title="' + ja['editor.replaceAllTitle'] + '"]')
    await settle(page)
    await page.focus('.jse-replace-input')
    await page.keyboard.press('Control+Z')
    await settle(page)
    record(`${name}: 一致の無い置換の後、置換の欄の Ctrl+Z は文書を戻さない`, (await docText(page)) === afterOne, `置換語 ${count(await docText(page), REPLACEMENT)} 件`)
    record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }

  {
    const name = 'テキストの置換'
    const { page, problems } = await openPage(browser, url('text'))
    await page.waitForSelector('.cm-content')
    await page.click('.cm-content')
    await page.keyboard.press('Control+H')
    const opened = await page.waitForSelector('.cm-search input[name="replace"]', { timeout: 3000 }).then(() => true, () => false)
    record(`${name}: Ctrl+H で置換の欄が開く`, opened)
    if (opened) {
      await page.fill('.cm-search input[name="search"]', '東京')
      await page.fill('.cm-search input[name="replace"]', REPLACEMENT)
      const before = await docText(page)
      // 上流の CodeMirror は、最初の 1 回は一致へ移るだけで、2 回目で置換する
      await page.click('.cm-search button[name="replace"]')
      await page.click('.cm-search button[name="replace"]')
      await settle(page)
      const afterOne = await docText(page)
      record(`${name}: 1 件の置換で 1 件だけ変わる`, count(afterOne, REPLACEMENT) === 1 && count(before, '東京') - count(afterOne, '東京') === 1, `${count(afterOne, REPLACEMENT)}`)
      await page.click('.cm-search button[name="replaceAll"]')
      await settle(page)
      const afterAll = await docText(page)
      record(`${name}: 全部の置換で残りが全部変わる`, count(afterAll, '東京') === 0 && count(afterAll, REPLACEMENT) === TOKYO_ROWS, `${count(afterAll, REPLACEMENT)}/${TOKYO_ROWS}`)
      await page.click('.cm-content')
      await page.keyboard.press('Control+Z')
      await settle(page)
      const undone = await docText(page)
      record(`${name}: 全部の置換の後の Ctrl+Z 1 回で全部の置換の前へ戻る`, undone === afterOne, `置換語 ${count(undone, REPLACEMENT)} 件`)
    }
    record(`${name}: エラーが 0 件`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }
}
