// 翻訳の右クリックと小窓（Step10-002 T4）。実物のエディタと殻をつなぎ、Rust の呼び出し（翻訳の仕事を含む）
// だけを偽物にする。通信はしない（偽物の仕事は「訳:」を付けて返すだけ）。

const MAIL = '/mail.json'
const SHELL_MENU = '.app-translate-context-menu'
const UPSTREAM_MENU = '.jse-contextmenu'
const SUBMENU = '.app-translate-submenu'
const UPSTREAM_SUBMENU = `${UPSTREAM_MENU} .jse-context-submenu-items`
const PANEL = '.app-translate-panel'
const ITEM_LABEL = '日本語に翻訳'

let h

const record = (name, passed, detail = '') => h.record(name, passed, detail)
const docText = (page) => page.evaluate(() => window.fixture.text())
const state = (page) => page.evaluate(() => window.fixture.state())
const calls = (page) => page.evaluate(() => window.fixture.translation())
const header = (column) => `th[data-column-path="${encodeURIComponent(`/${column.join('/')}`)}"]`
const cell = (path) => `td[data-path="${encodeURIComponent(`/${path.join('/')}`)}"]`

async function page(browser, base, query) {
  const opened = await h.openPage(browser, `${base}?shell${query}`)
  await opened.page.waitForFunction(() => window.fixture !== undefined)
  return opened
}

/** メールの文書を開き、表の対象を mails にして表へ移る。 */
async function openMails(p) {
  await p.evaluate((path) => window.fixture.open(path, {}), MAIL)
  await p.evaluate(() => window.fixture.setTarget(['mails']))
  await h.switchTo(p, '表')
  await p.waitForSelector(header(['subject']), { timeout: h.STATE_TIMEOUT_MS })
}

const panelRows = (p) =>
  p.evaluate((selector) =>
    [...document.querySelectorAll(`${selector} .app-translate-row`)].map((row) => ({
      place: row.querySelector('.app-translate-place')?.textContent,
      original: row.querySelector('.app-translate-original')?.textContent,
      translation: row.querySelector('.app-translate-translation')?.textContent,
      status: row.dataset.status
    })), PANEL)

/**
 * 見出しの殻のメニューの「日本語に翻訳」を押してサブメニューを開き、枠を押す（F6）。
 * 既定は無料枠（key=saved は無料枠用のキーだけ）。
 */
async function choose(p, tier = 'free') {
  await p.click(`${SHELL_MENU} .app-menu-item`)
  await p.click(`${SUBMENU} .app-menu-item[data-tier="${tier}"]`)
}

/** 上流のメニュー（セルとツリー）の「日本語に翻訳」を押してサブメニューを開き、枠を押す（F6）。 */
async function chooseInMenu(p, tier = 'free') {
  await p.click(`${UPSTREAM_MENU} .app-translate-context-item`)
  await p.click(`${UPSTREAM_SUBMENU} .app-translate-tier-${tier}`)
}

async function closeMenus(p) {
  await p.keyboard.press('Escape')
  await p.mouse.click(5, 5)
}

/** 見出しの右クリックで殻のメニューが出て上流のメニューが出ない。押すと確かめの後に小窓へ訳が出る。文書は変わらない。 */
async function testHeader(browser, base) {
  const name = '翻訳: 見出しの右クリック'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  const before = await docText(p)
  const asksBefore = (await state(p)).asks.length

  await p.click(header(['subject']), { button: 'right' })
  const shell = await p.waitForSelector(`${SHELL_MENU} .app-menu-item`, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  record(`${name}: 殻のメニューが出る`, shell)
  record(`${name}: 上流のメニューは出ない`, (await p.locator(UPSTREAM_MENU).count()) === 0)
  record(`${name}: 項目は「${ITEM_LABEL}」`, (await p.locator(`${SHELL_MENU} .app-menu-item`).innerText()).includes(ITEM_LABEL))
  await choose(p)
  const shown = await h.reaches(p, (selector) => {
    const rows = [...document.querySelectorAll(`${selector} .app-translate-row[data-status="done"]`)]
    return rows.length === 4
  }, PANEL)
  record(`${name}: 小窓に 4 行の訳が出る`, shown)
  const rows = await panelRows(p)
  record(
    `${name}: 行の番号、原文、訳が並ぶ（送らない値の行とオブジェクトでない行は無い）`,
    JSON.stringify(rows.map((row) => [row.place, row.original, row.translation])) ===
      JSON.stringify([
        ['0', 'Hello', '訳:Hello'],
        ['1', 'Re: Hello', '訳:Re: Hello'],
        ['2', 'Hello', '訳:Hello'],
        ['4', '<img src=x onerror=alert(1)>', '訳:<img src=x onerror=alert(1)>']
      ]),
    JSON.stringify(rows)
  )
  const s = await state(p)
  const ask = s.asks[asksBefore]
  const askText = ask?.body.replaceAll('\n', ' ')
  record(`${name}: 送る前に確かめる（件数、重複を除いた件数、文字数）`, ask !== undefined && ask.body.includes('4 件（重複を除くと 3 件'), askText)
  record(`${name}: 確かめに機械の推測の注記`, ask !== undefined && ask.body.includes('行の取り違えが起きることがあります'), askText)
  record(`${name}: 確かめに無料枠の注記`, ask !== undefined && ask.body.includes('製品の改善に使われ'), askText)
  record(`${name}: 確かめの既定は取り消し`, ask !== undefined && ask.buttons[ask.default] === 'キャンセル' && ask.cancel === ask.default)
  const c = await calls(p)
  record(
    `${name}: 送るのは文字列の値だけで、UI の言語へ`,
    c.starts.length === 1 && c.starts[0].target === 'ja' && JSON.stringify(c.starts[0].items.map((item) => item.text)) === JSON.stringify(['Hello', 'Re: Hello', 'Hello', '<img src=x onerror=alert(1)>']),
    JSON.stringify(c.starts)
  )
  record(`${name}: HTML に見える訳は文字のまま（要素にならない）`, (await p.locator(`${PANEL} img`).count()) === 0)
  record(`${name}: 小窓に機械の推測の注記`, (await p.locator(`${PANEL} [data-notice="machine"]`).innerText()).includes('行の取り違え'))
  record(`${name}: translation_leaves_document_unchanged（文書と未保存の印）`, (await docText(p)) === before && !(await state(p)).dirty)
  // 保存しても 1 バイトも変わらない（未保存でないので書かない）
  await p.evaluate(() => window.fixture.save())
  record(`${name}: 保存しても書かない`, (await state(p)).writes === 0)

  // 2 段の見出しの下の段（入れ子の列）
  await p.click(header(['from', 'name']), { button: 'right' })
  await choose(p)
  const nested = await h.reaches(p, (selector) => document.querySelector(`${selector} .app-translate-source`)?.textContent === '列 from > name', PANEL)
  const nestedCalls = await calls(p)
  record(
    `${name}: 2 段の見出しの下の段は入れ子の列を送る（空と空白だけは送らない）`,
    nested && JSON.stringify(nestedCalls.starts.at(-1)?.items.map((item) => item.text)) === JSON.stringify(['Ann', 'Bob', 'Eve']),
    JSON.stringify(nestedCalls.starts.at(-1))
  )
  // 上の段の群のセルには項目を出さない（属性が無い）
  record(`${name}: 上の段の群のセルには列のパスが無い`, (await p.locator('th.jse-table-cell-header-group[data-column-path]').count()) === 0)

  // 閉じると結果は消え、文書を開き直すと小窓は閉じる
  await p.click(`${PANEL} [data-action="close"]`)
  record(`${name}: 閉じると小窓が消える`, await h.reaches(p, (selector) => document.querySelector(selector)?.hidden === true, PANEL))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** セルとツリーの値の右クリックは、上流のメニューの後ろに項目が足される。 */
async function testCellAndTree(browser, base) {
  const name = '翻訳: セルとツリーの右クリック'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  const before = await docText(p)
  await p.click(cell(['1', 'subject']), { button: 'right' })
  const menu = await p.waitForSelector(`${UPSTREAM_MENU} .app-translate-context-item`, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  record(`${name}: 表のセルは上流のメニューに項目が足される`, menu)
  record(`${name}: 上流の項目も残る`, (await p.locator(`${UPSTREAM_MENU} .jse-context-menu-button`).count()) > 1)
  await chooseInMenu(p)
  const one = await h.reaches(p, (selector) => document.querySelectorAll(`${selector} .app-translate-row[data-status="done"]`).length === 1, PANEL)
  const rows = await panelRows(p)
  record(`${name}: セルの値 1 件を訳す`, one && rows[0]?.original === 'Re: Hello' && rows[0]?.place === 'mails > 1 > subject', JSON.stringify(rows))

  // 数のセルには項目を出さない
  await p.click(cell(['0', 'size']), { button: 'right' })
  await p.waitForSelector(UPSTREAM_MENU, { timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: 数のセルには項目が無い`, (await p.locator(`${UPSTREAM_MENU} .app-translate-context-item`).count()) === 0)
  await closeMenus(p)

  // ツリーの文字列の値
  await h.switchTo(p, 'ツリー')
  const value = p.locator('.jse-tree-mode .jse-value', { hasText: 'keep 1.0' }).first()
  await value.click({ button: 'right' })
  const treeMenu = await p.waitForSelector(`${UPSTREAM_MENU} .app-translate-context-item`, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  record(`${name}: ツリーの文字列の値に項目が足される`, treeMenu)
  if (treeMenu) {
    await chooseInMenu(p)
    const translated = await h.reaches(p, (selector) => document.querySelector(`${selector} .app-translate-translation`)?.textContent === '訳:keep 1.0', PANEL)
    record(`${name}: ツリーの値を訳す`, translated)
  }
  record(`${name}: 文書は変わらない`, (await docText(p)) === before && !(await state(p)).dirty)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 無効のときは項目を出さず、仕事も始めない。見出しの右クリックは上流のまま。 */
async function testDisabled(browser, base) {
  const name = '翻訳: 無効のとき'
  const { page: p, problems } = await page(browser, base, '&key=saved')
  await openMails(p)
  await p.click(header(['subject']), { button: 'right' })
  await p.waitForTimeout(300)
  record(`${name}: 見出しに殻のメニューを出さない`, (await p.locator(SHELL_MENU).count()) === 0)
  await closeMenus(p)
  await p.click(cell(['1', 'subject']), { button: 'right' })
  await p.waitForSelector(UPSTREAM_MENU, { timeout: h.STATE_TIMEOUT_MS }).catch(() => {})
  record(`${name}: セルのメニューに項目が無い`, (await p.locator(`${UPSTREAM_MENU} .app-translate-context-item`).count()) === 0)
  record(`${name}: 上流のメニューは出る`, (await p.locator(UPSTREAM_MENU).count()) > 0)
  await closeMenus(p)
  const c = await calls(p)
  record(`${name}: no_invoke_when_disabled（仕事を始めない）`, c.starts.length === 0, JSON.stringify(c.starts))
  record(`${name}: 小窓は出ない`, await p.evaluate((selector) => document.querySelector(selector)?.hidden === true, PANEL))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 取り消しと続きを訳す。訳せた行は残り、未翻訳だけを送り直す。文書を開き直すと小窓は閉じる。 */
async function testCancelAndResume(browser, base) {
  const name = '翻訳: 取り消しと続き'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  await p.evaluate(() => window.fixture.holdTranslate(true))
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  await p.waitForSelector(`${PANEL} [data-action="cancel"]:not([hidden])`, { timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 動いている間は取り消しのボタン`, true)
  await p.evaluate(() => window.fixture.emitTranslate({ kind: 'translated', job: 0, results: [{ id: 0, text: 'こんにちは' }, { id: 2, text: 'こんにちは' }] }))
  await p.click(`${PANEL} [data-action="cancel"]`)
  const cancelled = await h.reaches(p, (selector) => document.querySelector(`${selector} .app-translate-message`)?.textContent?.includes('取り消しました') === true, PANEL)
  record(`${name}: 取り消すと「取り消しました」`, cancelled)
  const rows = await panelRows(p)
  record(`${name}: cancel_keeps_done_rows（訳せた行は残る）`, JSON.stringify(rows.map((row) => row.status)) === JSON.stringify(['done', 'pending', 'done', 'pending']), JSON.stringify(rows))
  record(`${name}: 取り消しは Rust へ 1 回`, (await calls(p)).cancels.length === 1)

  await p.evaluate(() => window.fixture.holdTranslate(false))
  await p.click(`${PANEL} [data-action="resume"]`)
  const resumed = await h.reaches(p, (selector) => document.querySelectorAll(`${selector} .app-translate-row[data-status="done"]`).length === 4, PANEL)
  const c = await calls(p)
  record(`${name}: 続きを訳すは未翻訳の行だけを送る`, resumed && JSON.stringify(c.starts.at(-1)?.items.map((item) => item.id)) === JSON.stringify([1, 3]), JSON.stringify(c.starts.at(-1)))

  // 文書が替わると小窓を閉じる
  await p.evaluate(() => window.fixture.open('/first.json', { discardConfirmed: true }))
  record(`${name}: 別の文書を開くと小窓を閉じる`, await h.reaches(p, (selector) => document.querySelector(selector)?.hidden === true, PANEL))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** キーが無いときは仕事を始めず、設定のダイアログを開く。 */
async function testNoKey(browser, base) {
  const name = '翻訳: キーが無いとき'
  const { page: p, problems } = await page(browser, base, '&translation=on')
  await openMails(p)
  await p.click(header(['subject']), { button: 'right' })
  const noSub = await p.evaluate((selector) => {
    const item = document.querySelector(`${selector} .app-menu-item`)
    return { label: item?.querySelector('.app-menu-label')?.textContent, popup: item?.getAttribute('aria-haspopup') ?? null }
  }, SHELL_MENU)
  record(`${name}: 見出しはサブメニューの無い「${ITEM_LABEL}」の 1 つ（F6）`, noSub.label === ITEM_LABEL && noSub.popup === null, JSON.stringify(noSub))
  await p.click(`${SHELL_MENU} .app-menu-item`)
  const opened = await p.waitForSelector('dialog.app-translation-dialog[open]', { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  record(`${name}: 設定のダイアログを開く`, opened)
  record(`${name}: サブメニューは出ない`, (await p.locator(SUBMENU).count()) === 0)
  record(`${name}: 仕事を始めない`, (await calls(p)).starts.length === 0)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()

  // セルの右クリックも、サブメニューの無い項目を 1 つ。押すと設定のダイアログ
  const second = await page(browser, base, '&translation=on')
  await openMails(second.page)
  await second.page.click(cell(['1', 'subject']), { button: 'right' })
  await second.page.waitForSelector(`${UPSTREAM_MENU} .app-translate-context-item`, { timeout: h.STATE_TIMEOUT_MS })
  const cellItems = await second.page.locator(`${UPSTREAM_MENU} .app-translate-context-item`).allInnerTexts()
  record(
    `${name}: セルはサブメニューの無い「${ITEM_LABEL}」の 1 つ（F6）`,
    JSON.stringify(cellItems.map((text) => text.trim())) === JSON.stringify([ITEM_LABEL]) && (await second.page.locator(`${UPSTREAM_MENU} .jse-context-submenu`).count()) === 0,
    JSON.stringify(cellItems)
  )
  await second.page.click(`${UPSTREAM_MENU} .app-translate-context-item`)
  record(
    `${name}: セルの項目を押すと設定のダイアログを開く`,
    await second.page.waitForSelector('dialog.app-translation-dialog[open]', { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  )
  record(`${name}: セルからも仕事を始めない`, (await calls(second.page)).starts.length === 0)
  record(`${name}: エラーが無い（セル）`, second.problems.length === 0, second.problems.slice(0, 2).join(' / '))
  await second.page.close()
}

/** 見出しから訳して、小窓の「訳を新しい列として足す」を押すまで。 */
async function translateColumn(p, column) {
  await p.click(header(column), { button: 'right' })
  await choose(p)
  await h.reaches(p, (selector) => {
    const button = document.querySelector(`${selector} [data-action="addColumn"]`)
    return button !== null && !button.hidden && !button.disabled
  }, PANEL)
}

const addColumnButton = (selector) => `${selector} [data-action="addColumn"]`

/** 訳を新しい列として足す（T5）。1 回の編集で、元に戻す 1 回で全部戻り、戻すと未保存の印も消える。 */
async function testAddColumn(browser, base) {
  const name = '翻訳: 新しい列として足す'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  const before = await docText(p)
  await translateColumn(p, ['subject'])
  record(`${name}: 列から訳すとボタンが出る`, await p.locator(addColumnButton(PANEL)).isVisible())
  record(`${name}: 訳すだけでは文書は変わらない`, (await docText(p)) === before && !(await state(p)).dirty)
  const asksBefore = (await state(p)).asks.length
  await p.click(addColumnButton(PANEL))
  const added = await h.reaches(p, () => window.fixture.text().includes('subject_ja'))
  const json = JSON.parse(await docText(p))
  record(
    `${name}: 訳せた行に subject_ja を足す（送らなかった行とオブジェクトでない行には足さない）`,
    added && JSON.stringify(json.mails.map((row) => (typeof row === 'object' ? row.subject_ja ?? null : 'not-object'))) ===
      JSON.stringify(['訳:Hello', '訳:Re: Hello', '訳:Hello', null, '訳:<img src=x onerror=alert(1)>', 'not-object']),
    JSON.stringify(json.mails)
  )
  record(`${name}: 元の値は変わらない`, JSON.stringify(json.mails.map((row) => row.subject)) === JSON.stringify(JSON.parse(before).mails.map((row) => row.subject)))
  record(`${name}: 全行が訳せていれば確かめを出さない`, (await state(p)).asks.length === asksBefore)
  record(`${name}: add_marks_unsaved（未保存の印が付く）`, (await state(p)).dirty === true)
  record(
    `${name}: 足した列が表の見出しにすぐ出る`,
    await p.waitForSelector(header(['subject_ja']), { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  )
  record(
    `${name}: 小窓に足した結果が出る`,
    (await p.locator(`${PANEL} .app-translate-message`).innerText()).includes('列 subject_ja を 4 行に足しました')
  )

  // 元に戻す 1 回で全部戻り、未保存の印も消える
  await p.keyboard.press('Control+z')
  const undone = await h.reaches(p, (text) => window.fixture.text() === text, before)
  record(`${name}: add_column_is_one_undo（元に戻す 1 回で全部戻る）`, undone, (await docText(p)).slice(0, 200))
  // 未保存の印は編集で立ち、内容の比較は保存の時に行う（I1）。戻した文書は保存しても 1 バイトも書かず、印も消える
  await p.evaluate(() => window.fixture.save())
  const afterSave = await state(p)
  record(
    `${name}: undo_restores_unedited_state（元に戻すと、保存しても書かず、未保存の印も消える）`,
    undone && afterSave.writes === 0 && afterSave.dirty === false,
    JSON.stringify({ writes: afterSave.writes, dirty: afterSave.dirty })
  )
  await p.keyboard.press('Control+y')
  record(`${name}: やり直すで戻る`, await h.reaches(p, () => window.fixture.text().includes('subject_ja')))
  await p.keyboard.press('Control+z')
  await h.reaches(p, (text) => window.fixture.text() === text, before)

  // 2 回足すと、2 回目は空いている名前（上書きしない）
  await p.click(addColumnButton(PANEL))
  await h.reaches(p, () => window.fixture.text().includes('subject_ja'))
  await p.click(addColumnButton(PANEL))
  const twice = await h.reaches(p, () => window.fixture.text().includes('subject_ja_2'))
  const twiceJson = JSON.parse(await docText(p))
  record(
    `${name}: add_column_never_overwrites（2 回目は subject_ja_2、1 回目の列は変わらない）`,
    twice && twiceJson.mails[0].subject_ja === '訳:Hello' && twiceJson.mails[0].subject_ja_2 === '訳:Hello',
    JSON.stringify(twiceJson.mails[0])
  )
  await p.keyboard.press('Control+z')
  await p.keyboard.press('Control+z')
  await h.reaches(p, (text) => window.fixture.text() === text, before)

  // 入れ子の列は同じ親の中へ
  await translateColumn(p, ['from', 'name'])
  await p.click(addColumnButton(PANEL))
  await h.reaches(p, () => window.fixture.text().includes('name_ja'))
  const nested = JSON.parse(await docText(p))
  record(
    `${name}: nested_column_adds_beside_source（from の中に name_ja）`,
    nested.mails[0].from.name_ja === '訳:Ann' && nested.mails[0].name_ja === undefined && nested.mails[2].from.name_ja === undefined,
    JSON.stringify(nested.mails.slice(0, 3))
  )
  await p.keyboard.press('Control+z')
  await h.reaches(p, (text) => window.fixture.text() === text, before)

  // 訳せた後に値を書き換えた行には足さない
  await translateColumn(p, ['subject'])
  await p.evaluate(() => window.fixture.patch([{ op: 'replace', path: '/mails/1/subject', value: 'changed' }]))
  await p.click(addColumnButton(PANEL))
  await h.reaches(p, () => window.fixture.text().includes('subject_ja'))
  const changed = JSON.parse(await docText(p))
  record(
    `${name}: add_column_skips_changed_rows（書き換えた行には足さず、数を出す）`,
    changed.mails[1].subject_ja === undefined && changed.mails[0].subject_ja === '訳:Hello' &&
      (await p.locator(`${PANEL} .app-translate-message`).innerText()).includes('1 行には足しませんでした'),
    JSON.stringify(changed.mails.slice(0, 2))
  )

  // 値から訳したときはボタンを出さない
  await p.click(cell(['0', 'subject']), { button: 'right' })
  await chooseInMenu(p)
  await h.reaches(p, (selector) => document.querySelector(`${selector} .app-translate-source`)?.textContent?.startsWith('値') === true, PANEL)
  record(`${name}: 値から訳したときはボタンが無い`, !(await p.locator(addColumnButton(PANEL)).isVisible()))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 一部だけ訳せたときは確かめる（既定は取り消し）。断ると足さない。 */
async function testAddColumnPartial(browser, base) {
  const name = '翻訳: 一部だけ訳せた列を足す'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  const before = await docText(p)
  await p.evaluate(() => window.fixture.holdTranslate(true))
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  await p.waitForSelector(`${PANEL} [data-action="cancel"]:not([hidden])`, { timeout: h.STATE_TIMEOUT_MS })
  record(`${name}: 動いている間は押せない`, await p.locator(addColumnButton(PANEL)).isDisabled())
  await p.evaluate(() => window.fixture.emitTranslate({ kind: 'translated', job: 0, results: [{ id: 0, text: 'こんにちは' }] }))
  await p.click(`${PANEL} [data-action="cancel"]`)
  await h.reaches(p, (selector) => !document.querySelector(`${selector} [data-action="addColumn"]`)?.disabled, PANEL)
  const asksBefore = (await state(p)).asks.length
  await p.evaluate(() => window.fixture.setAnswer(1))
  await p.click(addColumnButton(PANEL))
  await h.reaches(p, (count) => window.fixture.state().asks.length > count, asksBefore)
  const ask = (await state(p)).asks[asksBefore]
  record(`${name}: 確かめを出し、既定は取り消し`, ask !== undefined && ask.body.includes('4 行のうち 1 行') && ask.buttons[ask.default] === 'キャンセル', ask?.body)
  record(`${name}: 断ると足さない`, (await docText(p)) === before && !(await state(p)).dirty)
  await p.evaluate(() => window.fixture.setAnswer(0))
  await p.click(addColumnButton(PANEL))
  await h.reaches(p, () => window.fixture.text().includes('subject_ja'))
  const json = JSON.parse(await docText(p))
  record(
    `${name}: 承けると訳せた行にだけ足す`,
    json.mails[0].subject_ja === 'こんにちは' && json.mails.slice(1).every((row) => typeof row !== 'object' || row.subject_ja === undefined),
    JSON.stringify(json.mails)
  )
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/**
 * 小窓を開いたまま、エディタの右端に近いセルを右クリックしても、上流のメニューはエディタの見える枠の中に収まる
 * （T4 で見つけた、右端で切れる不具合）。
 */
async function testMenuInsideEditor(browser, base) {
  const name = '翻訳: 小窓を開いたままの右クリックのメニュー'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  await translateColumn(p, ['subject'])
  // エディタの枠の中に見えているセルのうち、いちばん右のもの（行 1）
  const point = await p.evaluate(() => {
    const editor = document.querySelector('.app-editor').getBoundingClientRect()
    const cells = [...document.querySelectorAll('.jse-main td[data-path^="%2F1%2F"]')]
      .map((cell) => cell.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.left < editor.right - 20)
    const rightmost = cells.sort((a, b) => b.left - a.left)[0]
    return rightmost && { x: Math.min(rightmost.right, editor.right) - 10, y: rightmost.top + rightmost.height / 2, editorRight: editor.right }
  })
  await p.mouse.click(point.x, point.y)
  await p.mouse.click(point.x, point.y, { button: 'right' })
  const shown = await p.waitForSelector(`${UPSTREAM_MENU}`, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  record(`${name}: エディタの右端の近くでメニューが出る`, shown && point.x > point.editorRight - 200, JSON.stringify(point))
  await p.waitForTimeout(100)
  const box = await p.evaluate((menu) => {
    const editor = document.querySelector('.app-editor').getBoundingClientRect()
    const rect = document.querySelector(menu).getBoundingClientRect()
    return { editor: { left: editor.left, top: editor.top, right: editor.right, bottom: editor.bottom }, menu: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } }
  }, UPSTREAM_MENU)
  const inside =
    box.menu.left >= box.editor.left && box.menu.right <= box.editor.right && box.menu.top >= box.editor.top && box.menu.bottom <= box.editor.bottom
  record(`${name}: メニューはエディタの見える枠の中に収まる（右端で切れない）`, inside, JSON.stringify(box))
  // F6: 右端の近くで開いたサブメニューも見える枠の中に収まる（収まらない側を避けて左へ開く）
  await p.hover(`${UPSTREAM_MENU} .app-translate-context-item`)
  const subShown = await p.waitForSelector(UPSTREAM_SUBMENU, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false)
  const subBox = await p.evaluate((sub) => {
    const editor = document.querySelector('.app-editor').getBoundingClientRect()
    const rect = document.querySelector(sub)?.getBoundingClientRect()
    return rect && { editor: { left: editor.left, right: editor.right, top: editor.top, bottom: editor.bottom }, sub: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
  }, UPSTREAM_SUBMENU)
  record(
    `${name}: 右端の近くのサブメニューもエディタの見える枠の中に収まる`,
    subShown && subBox !== undefined && subBox.sub.left >= subBox.editor.left && subBox.sub.right <= subBox.editor.right && subBox.sub.bottom <= subBox.editor.bottom,
    JSON.stringify(subBox)
  )
  record(`${name}: 小窓は開いたまま`, await p.locator(PANEL).isVisible())
  await closeMenus(p)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 見出しから訳して、`starts` 回目の仕事が終わり小窓に 4 行の訳が出るまで。 */
async function translateHeader(p, starts) {
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  return h.reaches(
    p,
    ([selector, count]) =>
      window.fixture.translation().starts.length === count &&
      document.querySelectorAll(`${selector} .app-translate-row[data-status="done"]`).length === 4,
    [PANEL, starts]
  )
}

/**
 * 確かめの「今後表示しない」（F4）。入れて送ると次から確かめずに送る。外したまま・取り消しでは設定を替えない。
 * 翻訳の設定のダイアログの「送る前に確認する」で戻せる。
 */
async function testDontAskAgain(browser, base) {
  const name = '翻訳: 確かめの今後表示しない'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)

  // 入れて取り消す: 送らず、設定も替えない
  await p.evaluate(() => window.fixture.setCheckAnswer(true))
  await p.evaluate(() => window.fixture.setAnswer(1))
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  await h.reaches(p, () => window.fixture.state().asks.length === 1)
  const first = (await state(p)).asks[0]
  record(`${name}: 確かめに「今後表示しない」を添える`, first?.check === '今後表示しない', JSON.stringify(first?.check))
  record(`${name}: 既定と Esc は取り消しのまま`, first !== undefined && first.buttons[first.default] === 'キャンセル' && first.cancel === first.default)
  let c = await calls(p)
  record(`${name}: 入れて取り消すと送らず、設定を替えない`, c.starts.length === 0 && c.confirmSaves.length === 0 && c.settingsConfirm === true, JSON.stringify(c.confirmSaves))

  // 外したまま送る: 送るが、設定は替えない
  await p.evaluate(() => window.fixture.setCheckAnswer(false))
  await p.evaluate(() => window.fixture.setAnswer(0))
  await translateHeader(p, 1)
  c = await calls(p)
  record(`${name}: 外したまま送ると送り、設定は替えない`, c.starts.length === 1 && c.confirmSaves.length === 0 && c.settingsConfirm === true)

  // 入れて送る: 設定を切る。次は確かめずに送る
  await p.evaluate(() => window.fixture.setCheckAnswer(true))
  const asksBefore = (await state(p)).asks.length
  await translateHeader(p, 2)
  c = await calls(p)
  record(`${name}: 入れて送ると確かめを切って保存する`, JSON.stringify(c.confirmSaves) === '[false]' && c.settingsConfirm === false && c.starts.length === 2, JSON.stringify(c.confirmSaves))
  record(`${name}: その回は確かめを 1 回出した`, (await state(p)).asks.length === asksBefore + 1)
  await p.evaluate(() => window.fixture.setCheckAnswer(false))
  await p.evaluate(() => window.fixture.setAnswer(1)) // 出れば取り消しになる答え
  const asksAfter = (await state(p)).asks.length
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  const sent = await h.reaches(p, () => window.fixture.translation().starts.length === 3)
  record(`${name}: 次からは確かめずに送る`, sent && (await state(p)).asks.length === asksAfter, JSON.stringify({ asks: (await state(p)).asks.length - asksAfter }))

  // 設定のダイアログで戻す
  await p.click('.app-menubar-button:has-text("オプション")')
  await p.click('.app-menu-item:has-text("翻訳の設定")')
  await p.waitForSelector('dialog.app-translation-dialog[open]', { timeout: h.STATE_TIMEOUT_MS })
  const box = 'dialog.app-translation-dialog [data-field="confirm"]'
  record(`${name}: 設定のダイアログに「送る前に確認する」があり、切った値で出る`, (await p.locator('dialog.app-translation-dialog').innerText()).includes('送る前に確認する') && !(await p.isChecked(box)))
  await p.check(box)
  await p.click('dialog.app-translation-dialog [data-action="save"]')
  await p.waitForSelector('dialog.app-translation-dialog', { state: 'detached', timeout: h.STATE_TIMEOUT_MS })
  c = await calls(p)
  record(`${name}: 入れて保存すると確かめが戻る`, c.saves.at(-1)?.confirm === true && c.settingsConfirm === true, JSON.stringify(c.saves.at(-1)))
  const asksBack = (await state(p)).asks.length
  await p.evaluate(() => window.fixture.setAnswer(1))
  await p.click(header(['subject']), { button: 'right' })
  await choose(p)
  const askedAgain = await h.reaches(p, (count) => window.fixture.state().asks.length > count, asksBack)
  record(`${name}: 戻した後は確かめを出す`, askedAgain && (await calls(p)).starts.length === 3)
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 見出しの右クリックの親の項目の名と、開いたサブメニューの [枠, 名, 文字の色] の並び（F6）。 */
const headerItems = async (p) => {
  await p.click(header(['subject']), { button: 'right' })
  await p.waitForSelector(`${SHELL_MENU} .app-menu-item`, { timeout: h.STATE_TIMEOUT_MS })
  const parents = await p.evaluate((selector) =>
    [...document.querySelectorAll(`${selector} .app-menu-item`)].map((item) => [item.querySelector('.app-menu-label')?.textContent, item.getAttribute('aria-haspopup')]), SHELL_MENU)
  await p.click(`${SHELL_MENU} .app-menu-item`)
  await p.waitForSelector(`${SUBMENU} .app-menu-item`, { timeout: h.STATE_TIMEOUT_MS })
  const subs = await p.evaluate((selector) =>
    [...document.querySelectorAll(`${selector} .app-menu-item`)].map((item) => [item.dataset.tier, item.querySelector('.app-menu-label')?.textContent, getComputedStyle(item).color]), SUBMENU)
  return { parents, subs }
}

/** 上流のメニュー（セル）の親の項目の名と、開いたサブメニューの [名, 文字の色] の並び（F6）。 */
const cellItems = async (p) => {
  await p.click(cell(['1', 'subject']), { button: 'right' })
  await p.waitForSelector(`${UPSTREAM_MENU} .app-translate-context-item`, { timeout: h.STATE_TIMEOUT_MS })
  const parents = (await p.locator(`${UPSTREAM_MENU} .app-translate-context-item`).allInnerTexts()).map((text) => text.trim())
  const before = await p.locator(UPSTREAM_SUBMENU).count()
  await p.click(`${UPSTREAM_MENU} .app-translate-context-item`)
  await p.waitForSelector(`${UPSTREAM_SUBMENU} button`, { timeout: h.STATE_TIMEOUT_MS })
  const subs = await p.evaluate((selector) =>
    [...document.querySelectorAll(`${selector} button`)].map((item) => [item.textContent.trim(), getComputedStyle(item).color]), UPSTREAM_SUBMENU)
  return { parents, before, subs }
}

const activeTier = (p) => p.evaluate(() => document.activeElement?.dataset.tier ?? document.activeElement?.className ?? '')
const activeText = (p) => p.evaluate(() => document.activeElement?.textContent?.trim() ?? '')

/**
 * 翻訳のたびに選ぶ枠（F5）を、1 つの「日本語に翻訳」とそのサブメニュー（有料、無料）で選ぶ（F6）。
 * 選んだ枠で送り、確かめと小窓がその枠を言う。2 つの枠は文字の色が違う。キーは →、Enter で開き、←、Esc で閉じる。
 */
async function testTiers(browser, base) {
  const name = '翻訳: 無料枠と有料を選ぶ'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=both')
  await openMails(p)
  const items = await headerItems(p)
  record(`${name}: 見出しは「${ITEM_LABEL}」の 1 つで、サブメニューを持つ`, JSON.stringify(items.parents) === JSON.stringify([[ITEM_LABEL, 'menu']]), JSON.stringify(items.parents))
  record(
    `${name}: 両方のキーがあるとサブメニューは「有料」「無料」の順`,
    JSON.stringify(items.subs.map(([tier, label]) => [tier, label])) === JSON.stringify([['paid', '有料'], ['free', '無料']]),
    JSON.stringify(items.subs)
  )
  record(`${name}: 見出しのサブメニューの 2 つは文字の色が違う`, items.subs.length === 2 && items.subs[0][2] !== items.subs[1][2], JSON.stringify(items.subs))
  // 色は theme.css の役割の変数（有料 --app-translate-paid、無料 --app-translate-free）
  const roleColors = await p.evaluate(() =>
    ['--app-translate-paid', '--app-translate-free'].map((role) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${role})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }))
  record(
    `${name}: 見出しの有料と無料は役割の変数の色`,
    JSON.stringify(items.subs.map((item) => item[2])) === JSON.stringify(roleColors),
    JSON.stringify({ items: items.subs, roleColors })
  )
  const asksBefore = (await state(p)).asks.length
  await p.click(`${SUBMENU} .app-menu-item[data-tier="paid"]`)
  const done = await h.reaches(p, (selector) => document.querySelectorAll(`${selector} .app-translate-row[data-status="done"]`).length === 4, PANEL)
  const c = await calls(p)
  record(`${name}: 有料を選ぶと有料の枠で送る`, done && c.starts.length === 1 && c.starts[0].tier === 'paid', JSON.stringify(c.starts.map((start) => start.tier)))
  record(`${name}: 押すとメニューもサブメニューも閉じる`, (await p.locator(SHELL_MENU).count()) === 0 && (await p.locator(SUBMENU).count()) === 0)
  const ask = (await state(p)).asks[asksBefore]
  record(
    `${name}: 確かめは有料のキーと言い、無料枠の注記を出さない`,
    ask !== undefined && ask.body.includes('有料用のキーで送って翻訳します') && !ask.body.includes('製品の改善に使われ'),
    ask?.body
  )
  record(`${name}: 小窓は有料のキーで送ったと言う`, (await p.locator(`${PANEL} .app-translate-tier`).innerText()) === '有料用のキーで送りました。')

  // セルの右クリックも 1 つの項目とサブメニュー。無料を選ぶと無料枠で送る
  const cellMenu = await cellItems(p)
  record(`${name}: セルも「${ITEM_LABEL}」の 1 つで、開くまでサブメニューは無い`, JSON.stringify(cellMenu.parents) === JSON.stringify([ITEM_LABEL]) && cellMenu.before === 0, JSON.stringify(cellMenu))
  record(`${name}: セルのサブメニューは「有料」「無料」の順`, JSON.stringify(cellMenu.subs.map(([label]) => label)) === JSON.stringify(['有料', '無料']), JSON.stringify(cellMenu.subs))
  record(
    `${name}: セルの 2 つも文字の色が違い、見出しと同じ色`,
    cellMenu.subs.length === 2 && cellMenu.subs[0][1] !== cellMenu.subs[1][1] && cellMenu.subs[0][1] === items.subs[0][2] && cellMenu.subs[1][1] === items.subs[1][2],
    JSON.stringify({ cell: cellMenu.subs, header: items.subs })
  )
  await p.click(`${UPSTREAM_SUBMENU} .app-translate-tier-free`)
  await h.reaches(p, () => window.fixture.translation().starts.length === 2)
  const freeStart = (await calls(p)).starts[1]
  record(`${name}: セルで無料を選ぶと無料枠で送る`, freeStart?.tier === 'free', JSON.stringify(freeStart))
  record(`${name}: セルのメニューは閉じる`, (await p.locator(UPSTREAM_MENU).count()) === 0)
  await h.reaches(p, (selector) => document.querySelector(`${selector} .app-translate-tier`)?.textContent === '無料枠用のキーで送りました。', PANEL)
  record(`${name}: 小窓は無料枠のキーで送ったと言う`, (await p.locator(`${PANEL} .app-translate-tier`).innerText()) === '無料枠用のキーで送りました。')
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()

  // 片方のキーだけでもサブメニュー（その 1 つ）
  for (const [key, expected] of [['paid', [['paid', '有料']]], ['saved', [['free', '無料']]]]) {
    const only = await page(browser, base, `&translation=on&key=${key}`)
    await openMails(only.page)
    const onlyItems = await headerItems(only.page)
    record(
      `${name}: key=${key} なら見出しのサブメニューは「${expected[0][1]}」の 1 つ`,
      JSON.stringify(onlyItems.parents) === JSON.stringify([[ITEM_LABEL, 'menu']]) && JSON.stringify(onlyItems.subs.map(([tier, label]) => [tier, label])) === JSON.stringify(expected),
      JSON.stringify(onlyItems)
    )
    await closeMenus(only.page)
    const onlyCell = await cellItems(only.page)
    record(
      `${name}: key=${key} ならセルのサブメニューも「${expected[0][1]}」の 1 つ`,
      JSON.stringify(onlyCell.parents) === JSON.stringify([ITEM_LABEL]) && JSON.stringify(onlyCell.subs.map(([label]) => label)) === JSON.stringify([expected[0][1]]),
      JSON.stringify(onlyCell)
    )
    record(`${name}: エラーが無い（key=${key}）`, only.problems.length === 0, only.problems.slice(0, 2).join(' / '))
    await only.page.close()
  }
}

/** サブメニューのキー（F6）。見出し（殻のメニュー）とセル（上流のメニュー）の両方。 */
async function testSubmenuKeys(browser, base) {
  const name = '翻訳: サブメニューのキー'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=both')
  await openMails(p)

  // 見出し: 右クリックで親にフォーカス。→ で開いて先頭（有料）、↓ で無料、← で閉じて親、Enter で開く、Esc でサブメニューだけ、もう一度 Esc で全部
  await p.click(header(['subject']), { button: 'right' })
  await p.waitForSelector(`${SHELL_MENU} .app-menu-item`, { timeout: h.STATE_TIMEOUT_MS })
  await p.keyboard.press('ArrowRight')
  record(`${name}: 見出しで → を押すとサブメニューが開き、先頭の有料へ`, (await p.locator(SUBMENU).count()) === 1 && (await activeTier(p)) === 'paid')
  await p.keyboard.press('ArrowDown')
  record(`${name}: 見出しで ↓ は無料へ`, (await activeTier(p)) === 'free')
  await p.keyboard.press('ArrowLeft')
  record(
    `${name}: 見出しで ← はサブメニューだけ閉じて親へ戻る`,
    (await p.locator(SUBMENU).count()) === 0 && (await p.locator(SHELL_MENU).count()) === 1 && (await activeText(p)).startsWith(ITEM_LABEL)
  )
  await p.keyboard.press('Enter')
  record(`${name}: 見出しで Enter でも開き、先頭の有料へ`, (await p.locator(SUBMENU).count()) === 1 && (await activeTier(p)) === 'paid')
  await p.keyboard.press('Escape')
  record(`${name}: 見出しで Esc はサブメニューだけ閉じる`, (await p.locator(SUBMENU).count()) === 0 && (await p.locator(SHELL_MENU).count()) === 1)
  await p.keyboard.press('Escape')
  record(`${name}: 見出しでもう一度 Esc でメニューごと閉じる`, (await p.locator(SHELL_MENU).count()) === 0)
  await p.click(header(['subject']), { button: 'right' })
  await p.keyboard.press('ArrowRight')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Enter')
  const keyed = await h.reaches(p, () => window.fixture.translation().starts.length === 1)
  record(`${name}: 見出しで → ↓ Enter で無料枠で送る`, keyed && (await calls(p)).starts[0]?.tier === 'free', JSON.stringify((await calls(p)).starts))

  // セル（上流のメニュー）: 親へフォーカスを移し、同じキーで開閉する
  await p.click(cell(['1', 'subject']), { button: 'right' })
  await p.waitForSelector(`${UPSTREAM_MENU} .app-translate-context-item`, { timeout: h.STATE_TIMEOUT_MS })
  await p.focus(`${UPSTREAM_MENU} .app-translate-context-item`)
  await p.keyboard.press('ArrowRight')
  record(`${name}: セルで → を押すとサブメニューが開き、先頭の有料へ`, (await p.locator(UPSTREAM_SUBMENU).count()) === 1 && (await activeText(p)) === '有料')
  await p.keyboard.press('ArrowDown')
  record(`${name}: セルで ↓ は無料へ`, (await activeText(p)) === '無料')
  await p.keyboard.press('ArrowDown')
  record(`${name}: セルで ↓ は端で先頭へ回る`, (await activeText(p)) === '有料')
  await p.keyboard.press('ArrowLeft')
  record(
    `${name}: セルで ← はサブメニューだけ閉じて親へ戻る`,
    (await p.locator(UPSTREAM_SUBMENU).count()) === 0 && (await p.locator(UPSTREAM_MENU).count()) === 1 && (await activeText(p)) === ITEM_LABEL
  )
  await p.keyboard.press('Enter')
  record(`${name}: セルで Enter でも開き、先頭の有料へ`, (await p.locator(UPSTREAM_SUBMENU).count()) === 1 && (await activeText(p)) === '有料')
  await p.keyboard.press('Escape')
  record(
    `${name}: セルで Esc はサブメニューだけ閉じ、上流のメニューは残る`,
    (await p.locator(UPSTREAM_SUBMENU).count()) === 0 && (await p.locator(UPSTREAM_MENU).count()) === 1 && (await activeText(p)) === ITEM_LABEL
  )
  await p.keyboard.press('Escape')
  record(`${name}: セルでもう一度 Esc で上流のメニューごと閉じる`, await h.reaches(p, (selector) => document.querySelector(selector) === null, UPSTREAM_MENU))
  // 指を載せると開き、離すと閉じる
  await p.click(cell(['1', 'subject']), { button: 'right' })
  await p.hover(`${UPSTREAM_MENU} .app-translate-context-item`)
  record(`${name}: セルの親に指を載せるとサブメニューが開く`, await p.waitForSelector(UPSTREAM_SUBMENU, { timeout: h.STATE_TIMEOUT_MS }).then(() => true, () => false))
  await p.hover(`${UPSTREAM_MENU} .jse-context-menu-button >> nth=0`)
  record(`${name}: 別の項目へ移るとサブメニューが閉じる`, await h.reaches(p, (selector) => document.querySelector(selector) === null, UPSTREAM_SUBMENU))
  await p.focus(`${UPSTREAM_MENU} .app-translate-context-item`)
  await p.keyboard.press('ArrowRight')
  await p.keyboard.press('Enter')
  const keyedCell = await h.reaches(p, () => window.fixture.translation().starts.length === 2)
  record(`${name}: セルで → Enter で有料で送る`, keyedCell && (await calls(p)).starts[1]?.tier === 'paid', JSON.stringify((await calls(p)).starts))
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

/** 小窓の注意書きの「今後表示しない」（F5）。押すと保存して次から出さず、設定のダイアログで戻せる。 */
async function testMachineNotice(browser, base) {
  const name = '翻訳: 小窓の注意書きの今後表示しない'
  const { page: p, problems } = await page(browser, base, '&translation=on&key=saved')
  await openMails(p)
  await translateHeader(p, 1)
  const notice = `${PANEL} [data-notice="machine"]`
  record(`${name}: 注意書きに「今後表示しない」がある`, (await p.locator(`${notice} [data-action="hideMachineNotice"]`).innerText()) === '今後表示しない')
  await p.click(`${notice} [data-action="hideMachineNotice"]`)
  const hidden = await h.reaches(p, (selector) => document.querySelector(selector)?.hidden === true, notice)
  let c = await calls(p)
  record(`${name}: 押すと隠れて設定に保存する`, hidden && JSON.stringify(c.machineNoticeSaves) === '[false]' && c.settingsMachineNotice === false, JSON.stringify(c.machineNoticeSaves))
  await translateHeader(p, 2)
  record(`${name}: 次の翻訳の小窓でも出さない`, !(await p.locator(notice).isVisible()))
  const lastAsk = (await state(p)).asks.at(-1)
  record(`${name}: 送る前の確かめには注意書きが残る`, lastAsk !== undefined && lastAsk.body.includes('行の取り違えが起きることがあります'), lastAsk?.body)

  // 設定のダイアログで戻す
  await p.click('.app-menubar-button:has-text("オプション")')
  await p.click('.app-menu-item:has-text("翻訳の設定")')
  await p.waitForSelector('dialog.app-translation-dialog[open]', { timeout: h.STATE_TIMEOUT_MS })
  const box = 'dialog.app-translation-dialog [data-field="machineNotice"]'
  record(`${name}: 設定のダイアログに「結果の小窓に注意書きを出す」があり、切った値で出る`, (await p.locator('dialog.app-translation-dialog').innerText()).includes('結果の小窓に注意書きを出す') && !(await p.isChecked(box)))
  await p.check(box)
  await p.click('dialog.app-translation-dialog [data-action="save"]')
  await p.waitForSelector('dialog.app-translation-dialog', { state: 'detached', timeout: h.STATE_TIMEOUT_MS })
  c = await calls(p)
  record(`${name}: 入れて保存すると戻る`, c.saves.at(-1)?.machineNotice === true && c.settingsMachineNotice === true, JSON.stringify(c.saves.at(-1)))
  await translateHeader(p, 3)
  record(`${name}: 戻した後の小窓には注意書きが出る`, await p.locator(notice).isVisible())
  record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  await p.close()
}

export async function testTranslate(browser, base, helpers) {
  h = helpers
  await testHeader(browser, base)
  await testCellAndTree(browser, base)
  await testDisabled(browser, base)
  await testCancelAndResume(browser, base)
  await testNoKey(browser, base)
  await testAddColumn(browser, base)
  await testAddColumnPartial(browser, base)
  await testMenuInsideEditor(browser, base)
  await testDontAskAgain(browser, base)
  await testTiers(browser, base)
  await testSubmenuKeys(browser, base)
  await testMachineNotice(browser, base)
}
