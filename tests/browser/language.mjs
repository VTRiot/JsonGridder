// 言語の切り替えの試験（step5_001）。実 Chromium で、実物のエディタと殻をつなぐ。
// 実 EXE を要る条件（実 EXE の一巡、権限の確認の有無）は含まない。

const JAPANESE_CHARACTERS = /[぀-ヿ一-鿿]/
const DUMMY = {
  'app.menu.file': 'ダミー(&F)',
  'app.menu.options': 'ダミーオプション(&O)',
  'app.menu.help': 'ダミーヘルプ(&H)',
  'editor.modeTable': 'ダミー表',
  'cm.Find': 'ダミー検索'
}

let h

const state = (page) => page.evaluate(() => window.fixture.state())
const docText = (page) => page.evaluate(() => window.fixture.text())
const open = (page, path, options = {}) =>
  page.evaluate(([target, opts]) => window.fixture.open(target, opts), [path, options])
const menubar = (page) => page.locator('.app-menubar-button').allInnerTexts()

async function shellPage(browser, base, query = '?shell') {
  const { page, problems } = await h.openPage(browser, `${base}${query}`)
  await page.waitForFunction(() => window.fixture !== undefined)
  return { page, problems }
}

async function chooseLanguage(page, optionsLabel, languageLabel, choice) {
  await page.click(`.app-menubar-button:has-text("${optionsLabel}")`, { timeout: h.STATE_TIMEOUT_MS })
  await page.hover(`.app-menu-item:has-text("${languageLabel}")`)
  await page.click(`.app-menu-item:has-text("${choice}")`, { timeout: h.STATE_TIMEOUT_MS })
}

/** 見えている文字のうち、文書の中身と言語名の項目を除いたものに日本語が残るか。 */
const visibleJapanese = (page) =>
  page.evaluate(
    (source) => {
      const pattern = new RegExp(source)
      const skip = '.jse-contents, .cm-content, .jse-table-cell, .jse-value, .jse-key, td, .app-menu-popup'
      const found = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim()
        if (text && pattern.test(text) && !node.parentElement?.closest(skip)) found.push(text)
      }
      const titles = [...document.querySelectorAll('[title], [aria-label]')]
        .flatMap((el) => [el.getAttribute('title'), el.getAttribute('aria-label')])
        .filter((value) => value && pattern.test(value))
      return [...found, ...titles, document.title].filter((value) => pattern.test(value))
    },
    JAPANESE_CHARACTERS.source
  )

/** 6b: 編集中の文書、未保存の印、undo の履歴が、切り替えで変わらない。 */
async function testSwitchKeepsDocument(browser, base) {
  const name = '言語の切り替え'
  const { page, problems } = await shellPage(browser, base)
  await open(page, '/first.json')
  await page.getByText('x', { exact: true }).dblclick({ timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  await page.keyboard.press('Control+A')
  await page.keyboard.type('edited')
  await page.keyboard.press('Enter')
  const before = await state(page)
  const textBefore = await docText(page)
  const reportsBefore = before.reports.length
  await page.evaluate(() => {
    document.querySelector('.jse-main').__sentinel = 'same-element'
  })
  const undoBefore = await page.locator('.jse-undo').isDisabled()

  await chooseLanguage(page, 'オプション', '言語', 'English')
  const reachedEnglish = await h.reaches(page, () => document.documentElement.lang === 'en')
  const after = await state(page)
  record(h, `${name}: 英語へ替わる`, reachedEnglish)
  record(h, `${name}: 設定の保存へ en を渡す`, after.languageCalls.at(-1) === 'en', after.languageCalls.join())
  record(h, `${name}: 文書の文字が同じ`, (await docText(page)) === textBefore)
  record(h, `${name}: 未保存の印が残る`, before.dirty && after.dirty)
  const lastReport = after.reports.at(-1)
  record(h, `${name}: 窓へ未保存の通知を保つ`, lastReport.unsaved === true && after.reports.length >= reportsBefore)
  record(
    h,
    `${name}: 編集画面を作り直さない`,
    await page.evaluate(() => document.querySelector('.jse-main')?.__sentinel === 'same-element')
  )
  record(h, `${name}: undo の履歴が残る`, (await page.locator('.jse-undo').isDisabled()) === undoBefore && !undoBefore)
  await page.click('.jse-undo')
  record(h, `${name}: 切り替えの後も undo が効く`, (await docText(page)).includes('x') && !(await docText(page)).includes('edited'))
  await page.click('.jse-redo')
  record(h, `${name}: redo も効く`, (await docText(page)).includes('edited'))

  const labels = (await menubar(page)).join()
  record(h, `${name}: 英語のメニュー`, /^File.*,Options.*,Help/.test(labels), labels)
  const modes = (await page.locator('.jse-group-button').allInnerTexts()).map((s) => s.trim()).join()
  record(h, `${name}: 英語の表示切り替え`, modes === 'text,tree,table', modes)
  const leftover = await visibleJapanese(page)
  record(h, `${name}: 英語の画面に日本語が残らない`, leftover.length === 0, JSON.stringify(leftover))

  await chooseLanguage(page, 'Options', 'Language', '日本語')
  record(h, `${name}: 日本語へ戻る`, await h.reaches(page, () => document.documentElement.lang === 'ja'))
  record(h, `${name}: 戻しても文書と印が同じ`, (await docText(page)).includes('edited') && (await state(page)).dirty)
  record(h, `${name}: 画面の例外なし`, problems.length === 0, problems.join('|'))
  await page.close()
}

/** 6b: セルの編集中でも入力が消えない。 */
async function testSwitchWhileEditingCell(browser, base) {
  const name = '言語の切り替え 編集中'
  const { page, problems } = await shellPage(browser, base)
  await open(page, '/first.json')
  await page.getByText('x', { exact: true }).dblclick({ timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  await page.keyboard.press('Control+A')
  await page.keyboard.type('typing')
  await page.evaluate(() => window.fixture.setLanguage('en'))
  await page.waitForTimeout(h.INPUT_SETTLE_MS ?? 300)
  const stillEditing = await page.locator('.jse-editable-div').first().innerText().catch(() => '')
  record(h, `${name}: 入力欄の中身が残る`, stillEditing.includes('typing'), stillEditing)
  await page.keyboard.press('Enter')
  record(h, `${name}: 確定すると文書に入る`, (await docText(page)).includes('typing'))
  record(h, `${name}: 未保存の印が立つ`, (await state(page)).dirty)
  record(h, `${name}: 画面の例外なし`, problems.length === 0, problems.join('|'))
  await page.close()
}

/** 5: 辞書を 1 つ足して言語を替えるだけで画面が替わる。ダミーは製品のファイルに無い。 */
async function testDummyDictionary(browser, base) {
  const name = '言語を足す'
  const { page } = await shellPage(browser, base)
  await open(page, '/first.json')
  await page.evaluate((dictionary) => {
    window.fixture.registerDictionary('xx', dictionary)
    window.fixture.setLanguage('xx')
  }, DUMMY)
  const labels = (await menubar(page)).join()
  record(h, `${name}: ダミーのメニュー名が出る`, labels.startsWith('ダミー') && labels.includes('ダミーヘルプ'), labels)
  const modes = (await page.locator('.jse-group-button').allInnerTexts()).map((s) => s.trim())
  record(h, `${name}: エディタの文言も替わる`, modes.includes('ダミー表'), modes.join())
  const lang = await page.evaluate(() => document.documentElement.lang)
  record(h, `${name}: html の lang が替わる`, lang === 'xx', lang)
  const inherited = await page.locator('.app-menubar-button').nth(3).count()
  record(h, `${name}: 4 つ目のメニューは無い（欠けは基準の言語、キー名で補う）`, inherited === 0)
  await page.evaluate(() => window.fixture.setLanguage('ja'))
  record(h, `${name}: 戻せる`, (await menubar(page))[0] === 'ファイル(F)')
  await page.close()
}

/** 6: JSON の中身は翻訳されない。 */
async function testContentNotTranslated(browser, base) {
  const name = '中身は訳さない'
  const { page } = await shellPage(browser, base)
  await page.evaluate(() => {
    window.fixture.addFile('/words.json', '[{"Sort":"Sort","Cancel":"Cancel","New item":"New item"}]')
  })
  await open(page, '/words.json')
  const before = await docText(page)
  const cellsBefore = await page.locator('td, th').allInnerTexts()
  await page.evaluate(() => window.fixture.setLanguage('en'))
  const cellsEn = await page.locator('td, th').allInnerTexts()
  await page.evaluate(() => window.fixture.setLanguage('ja'))
  const cellsJa = await page.locator('td, th').allInnerTexts()
  const want = ['Sort', 'Cancel', 'New item']
  const has = (cells) => want.every((word) => cells.some((cell) => cell.includes(word)))
  record(h, `${name}: ja で Sort/Cancel/New item のまま`, has(cellsBefore), cellsBefore.join('|'))
  record(h, `${name}: en で同じ`, has(cellsEn), cellsEn.join('|'))
  record(h, `${name}: ja に戻して同じ`, has(cellsJa))
  record(h, `${name}: 文書の文字が変わらない`, (await docText(page)) === before)
  await page.close()
}

/** 6c: 起動時の言語。 */
async function testStartupLanguage(browser, base) {
  const name = '起動の言語'
  for (const [lang, expected] of [
    ['en', /^File/],
    ['ja', /^ファイル/]
  ]) {
    const { page } = await shellPage(browser, base, `?shell&lang=${lang}`)
    const first = (await menubar(page))[0]
    record(h, `${name}: ${lang} で始まる`, expected.test(first), first)
    const attr = await page.evaluate(() => document.documentElement.lang)
    record(h, `${name}: ${lang} の html lang`, attr === lang, attr)
    await page.close()
  }
}

/** 4: text モードの右クリック。表の貼り付けは確認の窓（CopyPasteModal）に落ちない。 */
async function testTextContextMenu(browser, base) {
  const name = 'テキストの右クリック'
  for (const [lang, labels] of [
    ['ja', ['切り取り', 'コピー', '貼り付け', 'すべて選択']],
    ['en', ['Cut', 'Copy', 'Paste', 'Select all']]
  ]) {
    const { page } = await shellPage(browser, base, `?shell&lang=${lang}`)
    await page.evaluate(() => {
      window.__written = null
      window.__readTexts = 0
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: async () => {
            window.__readTexts++
            return 'PASTED'
          },
          writeText: async (text) => {
            window.__written = text
          }
        }
      })
    })
    await open(page, '/first.json')
    await page.evaluate(() => window.fixture.setMode('text'))
    await page.waitForSelector('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
    await page.click('.cm-content', { button: 'right' })
    const popup = page.locator('.app-text-context-menu')
    record(h, `${name} ${lang}: メニューが出る`, (await popup.count()) === 1)
    const items = (await popup.locator('.app-menu-item').allInnerTexts()).map((s) => s.replace(/\s+Ctrl\+.$/, '').trim())
    record(h, `${name} ${lang}: 4 項目が辞書の文言`, labels.every((label, i) => items[i]?.startsWith(label)), items.join('|'))

    await popup.locator('.app-menu-item', { hasText: labels[3] }).click()
    await page.click('.cm-content', { button: 'right' })
    await page.locator('.app-text-context-menu .app-menu-item', { hasText: labels[1] }).click()
    const written = await page.evaluate(() => window.__written)
    const whole = await docText(page)
    record(h, `${name} ${lang}: すべて選択してコピーで文書全体を書く`, written === whole, String(written).slice(0, 40))

    await page.click('.cm-content', { button: 'right' })
    await page.locator('.app-text-context-menu .app-menu-item', { hasText: labels[2] }).click()
    await h.reaches(page, () => window.fixture.text() === 'PASTED')
    record(h, `${name} ${lang}: 貼り付けは選択を置き換える`, (await docText(page)) === 'PASTED')
    record(h, `${name} ${lang}: readText を 1 回だけ呼ぶ`, (await page.evaluate(() => window.__readTexts)) === 1)
    record(h, `${name} ${lang}: 確認の窓に落ちない`, (await page.locator('.jse-copy-paste').count()) === 0)
    record(h, `${name} ${lang}: 貼り付けは未保存の印を立てる`, (await state(page)).dirty)

    await page.click('.cm-content', { button: 'right' })
    await page.locator('.app-text-context-menu .app-menu-item', { hasText: labels[3] }).click()
    await page.click('.cm-content', { button: 'right' })
    await page.locator('.app-text-context-menu .app-menu-item', { hasText: labels[0] }).click()
    record(h, `${name} ${lang}: 切り取りで文書が空になる`, await h.reaches(page, () => window.fixture.text() === ''))
    await page.keyboard.press('Control+Z')
    await page.click('.cm-content', { button: 'right' })
    await page.keyboard.press('Escape')
    record(h, `${name} ${lang}: Esc で閉じる`, (await page.locator('.app-text-context-menu').count()) === 0)
    await page.close()
  }
}

/** 遅れて届いた読み取りは、開き直した別の文書へ貼らない（レビューの指摘）。 */
async function testPasteRace(browser, base) {
  const name = 'テキストの貼り付けの競合'
  const { page } = await shellPage(browser, base)
  await page.evaluate(() => {
    window.__release = () => {}
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => new Promise((resolve) => (window.__release = () => resolve('LATE'))),
        writeText: async () => {}
      }
    })
  })
  await open(page, '/first.json')
  await page.evaluate(() => window.fixture.setMode('text'))
  await page.waitForSelector('.cm-content', { timeout: h.STATE_TIMEOUT_MS })
  await page.click('.cm-content', { button: 'right' })
  await page.locator('.app-text-context-menu .app-menu-item', { hasText: '貼り付け' }).click()
  await open(page, '/second.json')
  const second = await docText(page)
  await page.evaluate(() => window.__release())
  await page.waitForTimeout(300)
  record(h, `${name}: 待つ間に開いた文書は変わらない`, (await docText(page)) === second && !second.includes('LATE'))
  record(h, `${name}: 未保存の印が立たない`, !(await state(page)).dirty)
  await page.close()
}

/** 4: 表のメニューの貼り付けも確認の窓に落ちない（readText の完了を見る）。 */
async function testTablePasteNoModal(browser, base) {
  const name = '表の貼り付け'
  const { page } = await shellPage(browser, base)
  await page.evaluate(() => {
    window.__readTexts = 0
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          window.__readTexts++
          return 'cellvalue'
        },
        writeText: async () => {}
      }
    })
  })
  await open(page, '/first.json')
  await page.getByText('x', { exact: true }).click({ timeout: h.STATE_TIMEOUT_MS })
  await page.click('.jse-context-menu-pointer', { timeout: h.STATE_TIMEOUT_MS })
  await page.locator('.jse-contextmenu button', { hasText: '貼り付け' }).first().click({ timeout: h.STATE_TIMEOUT_MS })
  await h.reaches(page, () => window.__readTexts >= 1)
  record(h, `${name}: readText が完了する`, (await page.evaluate(() => window.__readTexts)) === 1)
  record(h, `${name}: 確認の窓に落ちない`, (await page.locator('.jse-copy-paste').count()) === 0)
  await page.close()
}

/** 5: 取り込んだソースの取り違えの修正（辞書の文言の取り違え）。 */
async function testWordingFixes(browser, base) {
  const name = '文言の取り違えの修正'
  const { page } = await shellPage(browser, base, '?shell&lang=en')
  await page.evaluate(() => window.fixture.addFile('/obj.json', '{"a":{"b":1}}'))
  await open(page, '/obj.json')
  await page.evaluate(() => window.fixture.setMode('table'))
  await page.waitForSelector('.jse-nested-array-action', { timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  const texts = await page.locator('.jse-nested-array-action').allInnerTexts()
  record(h, `${name}: 表の案内の切り替えボタンはツリーと読める`, texts.some((s) => s.trim() === 'Switch to tree mode'), texts.join('|'))
  await page.close()
}

function record(helpers, label, passed, detail = '') {
  helpers.record(label, Boolean(passed), detail)
}

export async function testLanguage(browser, base, helpers) {
  h = helpers
  await testSwitchKeepsDocument(browser, base)
  await testSwitchWhileEditingCell(browser, base)
  await testDummyDictionary(browser, base)
  await testContentNotTranslated(browser, base)
  await testStartupLanguage(browser, base)
  await testTextContextMenu(browser, base)
  await testPasteRace(browser, base)
  await testTablePasteNoModal(browser, base)
  await testWordingFixes(browser, base)
}
