// 製品の既定のエディタの試験。入力は実キーと実マウス、または同じタスクの操作。
// 各ケースを新しいページで開く。原型の汚染を比べるのと、前のケースの状態を持ち越さないため。

const NEW_DOCUMENT = '{"replaced":true}'
const NEW_MARK = 'replaced'
const TYPED_KEY = '"z":0,'
const TYPED_MARK = '"z"'
const REASON = '.jse-cell-notice'
const MODAL = '.jse-jsoneditor-modal'
const BANNER = '.app-notice'
const QUERY_SETTLE_MS = 700 // プレビューの遅延より長く待つ
const SETTLE_MS = 500 // テキストの遅延より長く待つ
const WALK_STEPS = 8
const LARGE_ARRAY_LENGTH = 2_000_000 // 大文書の条件の要素数
const LARGE_OPEN_TIMEOUT_MS = 120000 // 200 万要素のパースと描画を待つ上限
const OFF_SCREEN_TOP = 2000
const OFF_SCREEN_ROWS = 200
const OFF_SCREEN_ROW = 5

const CANNOT_ADD = [
  ['親が数値', '[{"a":{"b":1}},{"a":5}]', ['1', 'a', 'b']],
  ['親が文字列', '[{"a":{"b":1}},{"a":"s"}]', ['1', 'a', 'b']],
  ['親が配列', '[{"a":{"b":1}},{"a":[1]}]', ['1', 'a', 'b']],
  ['親が null', '[{"a":{"b":1}},{"a":null}]', ['1', 'a', 'b']],
  ['親が真偽値', '[{"a":{"b":1}},{"a":true}]', ['1', 'a', 'b']],
  ['行が数値', '[{"a":1},5]', ['1', 'a']],
  ['行が文字列', '[{"a":1},"s"]', ['1', 'a']],
  ['行が null', '[{"a":1},null]', ['1', 'a']],
  ['行が配列', '[{"a":1},[9]]', ['1', 'a']],
  ['行が数値で入れ子の列', '[{"a":{"b":1}},5]', ['1', 'a', 'b']]
]

// 開いて閉じても変わらない値。文字列と数値の字面
const UNTOUCHED_VALUES = [
  '"  a   b  "',
  '"a\\tb"',
  '"a\\nb"',
  '"a\\r\\nb"',
  '"   "',
  '" "',
  '"\\u0001x"',
  '"\\u00a0"',
  '""',
  '1.50',
  '1e400',
  '-0',
  '12345678901234567890',
  'true',
  'null'
]

const INVALID_SAMPLES = [
  '{"a":1, /* c */ "b":2} // tail',
  '{"a":[1,2',
  '{"a":"hello wor',
  '{"a":1}\n{"a":2}\n',
  '[0x10]',
  '{"a":undefined,"b":NaN,"c":Infinity}',
  '[01, 1.2.3, 2e]',
  '{"a":NumberLong(2),"b":ISODate("2020")}',
  'cb({"a":1});',
  '```json\n{"a":1}\n```',
  '{"a":None}',
  '{"a":"x" + "y"}'
]

const TEXT_ONLY_SAMPLES = [
  ['同値の重複キー', '{"a":1,"a":1}'],
  ['配列の中の重複キー', '[{"a":1,"a":1}]']
]

const NUMBERS_DOCUMENT =
  '[{"id":12345678901234567890,"p":1.50,"q":1.0,"r":1,"s":"x"},{"id":12345678901234567891,"p":0.10,"q":2.0,"r":2,"s":"y"}]'

const BRACKET_TYPING = ['[draft] report', '{x} y', '[1]', '{"a":1}', '[', '{']

const NOT_LOST_QUERIES = [
  ['値が toString の行（uniqBy）', '[{"name":"toString","n":1},{"name":"a","n":2}]', 'uniqBy(.name)', '[{"name":"toString","n":1},{"name":"a","n":2}]'],
  ['値が constructor の行（uniqBy）', '[{"w":"constructor"},{"w":"valueOf"},{"w":"apple"}]', 'uniqBy(.w)', '[{"w":"constructor"},{"w":"valueOf"},{"w":"apple"}]'],
  ['値が toString の行（keyBy）', '[{"name":"toString","n":1},{"name":"a","n":2}]', 'keyBy(.name)', '{"toString":{"name":"toString","n":1},"a":{"name":"a","n":2}}'],
  ['比較の uniqBy', '[{"a":1},{"a":2},{"a":3}]', 'uniqBy(.a > 1)', '[{"a":1},{"a":2}]']
]

const REFUSED_QUERIES = [
  ['結果のキーが __proto__（map）', '[{"n":7}]', 'map({__proto__: .n})'],
  ['計算の結果が 2^53 を超える', '[{"a":9007199254740991}]', 'map(.a + 2)'],
  ['計算の結果が 2^53 を超える（途中）', '[{"a":9007199254740991}]', 'map(.a + 2 - 2)'],
  ['クエリに書いた保てない数値', '[{"a":1}]', 'map({id: 12345678901234567890})'],
  ['クエリに書いた保てない小数', '[{"x":0.1},{"x":0.2}]', 'filter(.x != 0.1000000000000000055)'],
  ['キーがぶつかる', '{"ab":1,"ac":2}', 'mapKeys(substring(get(), 0, 1))']
]

const LITERAL_TYPING = ['C:\\new', 'C:\\temp\\report', 'a\\\\b', '\\n', '\\"q\\"']

const numberTokens = (text) => text.match(/-?\d[\d.eE+-]*/g) ?? []

export async function testEditorFixes(browser, base, tools, only) {
  const { record, openPage, reaches, switchTo, cyclesAllModes, reachesMode, STATE_TIMEOUT_MS } = tools

  async function open(text, mode = 'table', extra = '') {
    const url = `${base}?product&mode=${mode}&text=${encodeURIComponent(text)}${extra}`
    const opened = await openPage(browser, url)
    return opened
  }

  const documentText = (page) => page.evaluate(() => window.fixture.text())
  const changeCount = (page) => page.evaluate(() => window.fixture.changes.length)
  const editorCount = (page) => page.locator('.jse-table-mode .jse-editable-div').count()
  const reasonCount = (page) => page.locator(REASON).count()
  const inputCount = (page) => page.evaluate(() => window.fixture.inputs())

  async function cellBox(page, path) {
    const selector = await page.evaluate((target) => window.fixture.cellSelector(target), path)
    const box = await page.locator(selector).boundingBox()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  async function clickCell(page, path) {
    const { x, y } = await cellBox(page, path)
    await page.mouse.click(x, y)
  }

  async function doubleClickCell(page, path) {
    const { x, y } = await cellBox(page, path)
    await page.mouse.dblclick(x, y)
  }

  async function expectUntouched(page, problems, name, text) {
    record(`${name}: 文書が変わらない`, (await documentText(page)) === text, await documentText(page))
    record(`${name}: onChange が出ない`, (await changeCount(page)) === 0, String(await changeCount(page)))
    record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
  }

  /** キーを足せないセル。打鍵、Enter、ダブルクリックのどれでも編集欄が開かない。 */
  async function cannotAddGroup() {
    for (const [label, text, path] of CANNOT_ADD) {
      const name = `キーを足せないセル（${label}）`
      const { page, problems } = await open(text)

      await clickCell(page, path)
      const selected = await page.locator('.jse-selected-value').count()
      // 配列のセルは内側のパスの選択も自分の選択として見せる。編集欄は開かない
      const expectedSelected = label.endsWith('が配列') ? 2 : 1
      record(`${name}: 選択は対象のセルだけ`, selected === expectedSelected, String(selected))
      await page.keyboard.type('7')
      record(`${name}: 打鍵で編集欄が開かない`, (await editorCount(page)) === 0)
      record(`${name}: 理由が出る`, (await reasonCount(page)) === 1)
      record(`${name}: input が起きない`, (await inputCount(page)) === 0, String(await inputCount(page)))
      await page.keyboard.press('Enter')
      record(`${name}: Enter で編集欄が開かない`, (await editorCount(page)) === 0)
      await doubleClickCell(page, path)
      record(`${name}: ダブルクリックで編集欄が開かない`, (await editorCount(page)) === 0)
      await expectUntouched(page, problems, name, text)
      record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
      record(`${name}: 回した後も文書が同じ`, (await documentText(page)) === text, await documentText(page))
      await page.close()
    }
  }

  async function missingCellGroup() {
    const MISSING = '[{"a":1,"b":2},{"a":3}]'
    const NO_PARENT = '[{"a":{"b":1}},{"a":{"b":2}},{"c":1}]'
    const cases = [
      ['欠けセル', MISSING, ['1', 'b']],
      ['親の欠け', NO_PARENT, ['2', 'a', 'b']]
    ]

    for (const [label, text, path] of cases) {
      for (const close of ['Enter', 'Tab']) {
        const name = `${label}を開いて ${close}`
        const { page, problems } = await open(text)
        await clickCell(page, path)
        await page.keyboard.press('Enter')
        record(`${name}: 編集欄が開く`, (await editorCount(page)) === 1)
        await page.keyboard.press(close)
        await expectUntouched(page, problems, name, text)
        await page.close()
      }

      const name = `${label}を開いて離れる`
      const { page, problems } = await open(text)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await clickCell(page, ['0', ...path.slice(1)])
      await expectUntouched(page, problems, name, text)
      await page.close()
    }

    const added = '[{"a":1,"b":2},{"a":3,"b":7}]'
    {
      const name = '欠けセルへの入力'
      const { page, problems } = await open(MISSING)
      await clickCell(page, ['1', 'b'])
      await page.keyboard.type('7')
      await page.keyboard.press('Enter')
      record(`${name}: キーが足される`, (await documentText(page)) === added, await documentText(page))
      await page.keyboard.press('Control+z')
      record(`${name}: undo で戻る`, await reaches(page, (expected) => window.fixture.text() === expected, MISSING))
      await page.keyboard.press('Control+Shift+z')
      record(`${name}: redo で進む`, await reaches(page, (expected) => window.fixture.text() === expected, added))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '親の欠けへの入力'
      const { page, problems } = await open(NO_PARENT)
      await clickCell(page, ['2', 'a', 'b'])
      await page.keyboard.type('7')
      await page.keyboard.press('Enter')
      const expected = '[{"a":{"b":1}},{"a":{"b":2}},{"c":1,"a":{"b":7}}]'
      record(`${name}: 親ごと足される`, (await documentText(page)) === expected, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = 'Enter で欠けの列を縦に歩く'
      const text = '[{"a":1,"b":2},{"a":3},{"a":4},{"a":5}]'
      const { page, problems } = await open(text)
      await clickCell(page, ['0', 'b'])
      for (let step = 0; step < WALK_STEPS; step++) {
        await page.keyboard.press('Enter')
      }
      const last = await page.evaluate(() => document.querySelector('.jse-selected-value')?.closest('td')?.dataset.path)
      record(`${name}: 下の行へ進む`, last !== undefined && !last.startsWith('%2F0'), String(last))
      await expectUntouched(page, problems, name, text)
      await page.close()
    }
    {
      const name = '編集欄は対象のセルに 1 つ'
      const { page } = await open('[{"a":{"b":1}},{"a":{"b":2}}]')
      await clickCell(page, ['1', 'a', 'b'])
      await page.keyboard.press('Enter')
      record(`${name}: 1 つだけ`, (await editorCount(page)) === 1, String(await editorCount(page)))
      await page.close()
    }
  }

  /** 開いて閉じるだけで値が変わらない。 */
  async function untouchedGroup() {
    for (const value of UNTOUCHED_VALUES) {
      const text = `[{"s":${value}},{"s":"other"}]`
      for (const close of ['Enter', 'blur']) {
        const name = `${value} を開いて ${close === 'Enter' ? 'Enter' : '離れる'}`
        const { page, problems } = await open(text)
        await clickCell(page, ['0', 's'])
        await page.keyboard.press('Enter')
        if (close === 'Enter') {
          await page.keyboard.press('Enter')
        } else {
          await clickCell(page, ['1', 's'])
        }
        await expectUntouched(page, problems, name, text)
        await page.close()
      }
    }
  }

  /** 打っても、書いていない文字が畳まれない。 */
  async function typingKeepsTheRestGroup() {
    for (const value of ['"  a   b  "', '"a\\tb"', '"a\\nb"', '"a\\r\\nb"']) {
      const name = `${value} の末尾へ打つ`
      const text = `[{"s":${value}},{"s":"other"}]`
      const { page, problems } = await open(text)
      await clickCell(page, ['0', 's'])
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('X')
      await page.keyboard.press('Enter')
      const expected = `${JSON.parse(value)}X`
      const actual = JSON.parse(await documentText(page))[0].s
      record(`${name}: 元の文字が残る`, actual === expected, JSON.stringify(actual))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  /** 打った文字は打ったとおりに入る。 */
  async function literalTypingGroup() {
    for (const typed of LITERAL_TYPING) {
      {
        const name = `${typed} を表のセルへ打つ`
        const { page, problems } = await open('[{"p":"old"}]')
        await clickCell(page, ['0', 'p'])
        await page.keyboard.press('Enter')
        await page.keyboard.press('Control+a')
        await page.keyboard.type(typed)
        await page.keyboard.press('Enter')
        const value = JSON.parse(await documentText(page))[0].p
        record(`${name}: 文書が打ったとおり`, value === typed, JSON.stringify(value))
        const shown = (await page.locator(await page.evaluate(() => window.fixture.cellSelector(['0', 'p']))).innerText()).trim()
        record(`${name}: 表示が打ったとおり`, shown === typed, shown)
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
      for (const [label, selector, read] of [
        ['値', '.jse-tree-mode .jse-value', (json) => json.p],
        ['キー', '.jse-tree-mode .jse-key', (json) => Object.keys(json)[0]]
      ]) {
        const name = `${typed} をツリーの${label}へ打つ`
        const { page } = await open('{"p":"old"}', 'tree')
        await page.dblclick(selector)
        await page.keyboard.press('Control+a')
        await page.keyboard.type(typed)
        await page.keyboard.press('Enter')
        const value = read(JSON.parse(await documentText(page)))
        record(`${name}: 文書が打ったとおり`, value === typed, JSON.stringify(value))
        await page.close()
      }
    }
    {
      const name = '制御文字の値の先頭へ打つ'
      const { page, problems } = await open('[{"s":"a\\r\\nb\\tc"}]')
      await clickCell(page, ['0', 's'])
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+Home')
      await page.keyboard.type('X')
      await page.keyboard.press('Enter')
      const value = JSON.parse(await documentText(page))[0].s
      record(`${name}: 元の文字が残る`, value === 'Xa\r\nb\tc', JSON.stringify(value))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '制御文字の値の表示'
      const { page } = await open('[{"s":"a\\nb"}]')
      const shown = await page.locator(await page.evaluate(() => window.fixture.cellSelector(['0', 's']))).innerText()
      record(`${name}: バックスラッシュで見せない`, !shown.includes('\\'), JSON.stringify(shown))
      await page.close()
    }
  }

  /** 画面の外の選択へ打っても、最初の文字から残る。 */
  async function offScreenGroup() {
    const text = JSON.stringify(Array.from({ length: OFF_SCREEN_ROWS }, (_, a) => ({ a })))
    const scrollAway = async (page) => {
      const selector = await page.evaluate((row) => window.fixture.cellSelector([row, 'a']), String(OFF_SCREEN_ROW))
      await page.evaluate((top) => {
        document.querySelector('.jse-contents').scrollTop = top
      }, OFF_SCREEN_TOP)
      await reaches(page, (cell) => document.querySelector(cell) === null, selector)
    }
    const row = async (page) => JSON.parse(await documentText(page))[OFF_SCREEN_ROW].a

    {
      const name = '画面の外へ打って Enter'
      const { page, problems } = await open(text)
      await clickCell(page, [String(OFF_SCREEN_ROW), 'a'])
      await scrollAway(page)
      await page.keyboard.type('abc')
      await page.keyboard.press('Enter')
      record(`${name}: 全部の文字が入る`, (await row(page)) === 'abc', String(await row(page)))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '画面の外へ打って確定'
      const { page } = await open(text)
      await clickCell(page, [String(OFF_SCREEN_ROW), 'a'])
      await scrollAway(page)
      await page.keyboard.type('abc')
      await page.evaluate(() => window.fixture.commit())
      record(`${name}: 全部の文字が入る`, (await row(page)) === 'abc', String(await row(page)))
      await page.close()
    }
    {
      const name = '画面の外で打って矢印'
      const { page } = await open(text)
      await clickCell(page, [String(OFF_SCREEN_ROW), 'a'])
      await scrollAway(page)
      await page.keyboard.type('abc')
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowDown')
      record(`${name}: 全部の文字が入る`, (await row(page)) === 'abc', String(await row(page)))
      await page.close()
    }
    {
      const name = '画面の外で Enter から打つ'
      const { page } = await open(text)
      await clickCell(page, [String(OFF_SCREEN_ROW), 'a'])
      await scrollAway(page)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('x')
      await page.keyboard.press('Enter')
      record(`${name}: 値の後ろへ入る`, (await row(page)) === `${OFF_SCREEN_ROW}x`, String(await row(page)))
      await page.close()
    }
  }

  /** 開いた編集欄の行を画面の外へ出しても、値も打った文字も残る。 */
  async function scrollEditorAwayGroup() {
    const text = JSON.stringify(Array.from({ length: OFF_SCREEN_ROWS }, (_, a) => ({ a })))
    const scrollTo = (page, top) =>
      page.evaluate((value) => {
        document.querySelector('.jse-contents').scrollTop = value
      }, top)
    const row = async (page) => JSON.parse(await documentText(page))[OFF_SCREEN_ROW].a

    for (const [name, typed, expected] of [
      ['何も打たず開いた行を画面の外へ出す', '', OFF_SCREEN_ROW],
      ['打って開いた行を画面の外へ出す', '9', Number(`${OFF_SCREEN_ROW}9`)]
    ]) {
      const { page, problems } = await open(text)
      await clickCell(page, [String(OFF_SCREEN_ROW), 'a'])
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type(typed)
      await scrollTo(page, OFF_SCREEN_TOP)
      await page.waitForTimeout(SETTLE_MS)
      await scrollTo(page, 0)
      await page.waitForTimeout(SETTLE_MS)
      await page.evaluate(() => window.fixture.commit())
      record(`${name}: 値が残る`, (await row(page)) === expected, String(await row(page)))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  /** スクロールで編集は終わらない。行は画面の外でも描画に残り、打鍵は値の続きに入る。 */
  async function scrollKeepsEditGroup() {
    const text = JSON.stringify(Array.from({ length: OFF_SCREEN_ROWS }, (_, a) => ({ a, b: `long text ${a}` })))
    const path = [String(OFF_SCREEN_ROW), 'b']
    const value = `long text ${OFF_SCREEN_ROW}`
    const row = async (page, index = OFF_SCREEN_ROW) => JSON.parse(await documentText(page))[index].b
    const editing = (page) => page.evaluate(() => document.activeElement?.classList.contains('jse-editable-div') === true)

    const leaves = {
      scrollTop: async (page, top) => {
        await page.evaluate((value) => {
          document.querySelector('.jse-contents').scrollTop = value
        }, top)
      },
      wheel: async (page, top) => {
        const box = await page.locator('.jse-contents').boundingBox()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, top === 0 ? -OFF_SCREEN_TOP : OFF_SCREEN_TOP)
      }
    }

    for (const [how, leave] of Object.entries(leaves)) {
      {
        const name = `何も打たず開いて外へ出して戻す（${how}）`
        const { page, problems } = await open(text)
        await clickCell(page, path)
        await page.keyboard.press('Enter')
        await leave(page, OFF_SCREEN_TOP)
        await page.waitForTimeout(SETTLE_MS)
        record(`${name}: 外でも編集欄が残る`, (await editorCount(page)) === 1, String(await editorCount(page)))
        record(`${name}: フォーカスが残る`, await editing(page))
        await leave(page, 0)
        await page.waitForTimeout(SETTLE_MS)
        await page.keyboard.press('Control+End')
        await page.keyboard.type(' more')
        await page.keyboard.press('Enter')
        record(`${name}: 値の続きに入る`, (await row(page)) === `${value} more`, String(await row(page)))
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
      {
        const name = `打って外へ出して打ち続ける（${how}）`
        const { page, problems } = await open(text)
        await clickCell(page, path)
        await page.keyboard.press('Enter')
        await page.keyboard.press('Control+End')
        await page.keyboard.type('X')
        await leave(page, OFF_SCREEN_TOP)
        await page.waitForTimeout(SETTLE_MS)
        record(`${name}: 外でも途中の値は文書に入らない`, (await row(page)) === value, String(await row(page)))
        await page.keyboard.type(' more')
        await page.keyboard.press('Enter')
        record(`${name}: 値の続きに入る`, (await row(page)) === `${value}X more`, String(await row(page)))
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
    }
    {
      const name = '編集中の行があっても見える行の位置は同じ'
      const { page } = await open(text)
      await leaves.scrollTop(page, OFF_SCREEN_TOP)
      await page.waitForTimeout(SETTLE_MS)
      const measure = () =>
        page.evaluate(() => {
          const contents = document.querySelector('.jse-contents')
          return {
            height: contents.scrollHeight,
            rows: [...contents.querySelectorAll('tr.jse-table-row th.jse-table-cell-gutter')]
              .filter((cell) => {
                const box = cell.getBoundingClientRect()
                const view = contents.getBoundingClientRect()
                return box.bottom > view.top && box.top < view.bottom
              })
              .map((cell) => `${cell.textContent.trim()}:${Math.round(cell.getBoundingClientRect().top)}`)
          }
        })
      const plain = await measure()
      await leaves.scrollTop(page, 0)
      await page.waitForTimeout(SETTLE_MS)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await leaves.scrollTop(page, OFF_SCREEN_TOP)
      await page.waitForTimeout(SETTLE_MS)
      const kept = await measure()
      record(`${name}: 全体の高さが同じ`, kept.height === plain.height, `${plain.height} ${kept.height}`)
      record(`${name}: 見える行が同じ`, JSON.stringify(kept.rows) === JSON.stringify(plain.rows), JSON.stringify(kept.rows.slice(0, 3)))
      await page.close()
    }
    {
      const name = '外へ出して Escape'
      const { page } = await open(text)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('X')
      await leaves.scrollTop(page, OFF_SCREEN_TOP)
      await page.waitForTimeout(SETTLE_MS)
      await page.keyboard.press('Escape')
      record(`${name}: 値が変わらない`, (await row(page)) === value, String(await row(page)))
      await page.close()
    }
    {
      const name = '外へ出して別のセルを押す'
      const { page } = await open(text)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('X')
      await leaves.scrollTop(page, OFF_SCREEN_TOP)
      await page.waitForTimeout(SETTLE_MS)
      const box = await page.locator('.jse-contents').boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 値が入る`, (await row(page)) === `${value}X`, String(await row(page)))
      record(`${name}: 編集欄が閉じる`, (await editorCount(page)) === 0, String(await editorCount(page)))
      await page.close()
    }
    {
      const name = 'スクロールバーを押す'
      const { page } = await open(text)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('X')
      const bar = await page.evaluate(() => {
        const contents = document.querySelector('.jse-contents')
        const box = contents.getBoundingClientRect()
        return { width: contents.offsetWidth - contents.clientWidth, x: box.right - 4, y: box.bottom - 40 }
      })
      await page.mouse.click(bar.x, bar.y)
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 幅のあるスクロールバーがある`, bar.width > 0, String(bar.width))
      record(`${name}: 編集が続く`, await editing(page))
      await page.keyboard.type(' more')
      await page.keyboard.press('Enter')
      record(`${name}: 値の続きに入る`, (await row(page)) === `${value}X more`, String(await row(page)))
      await page.close()
    }
    {
      const name = '編集欄からフォーカスが消える'
      const { page, problems } = await open(text)
      await clickCell(page, path)
      await page.keyboard.press('Enter')
      await page.evaluate(() => document.activeElement.blur())
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 編集欄が閉じる`, (await editorCount(page)) === 0, String(await editorCount(page)))
      await page.keyboard.press('ArrowDown')
      await page.keyboard.type('z')
      await page.keyboard.press('Enter')
      record(`${name}: 打鍵が表へ届く`, (await row(page, OFF_SCREEN_ROW + 1)) === 'z', String(await row(page, OFF_SCREEN_ROW + 1)))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  /** 値の選択へ打つ [ と { は普通の文字。 */
  async function bracketsGroup() {
    for (const typed of BRACKET_TYPING) {
      {
        const name = `${typed} を選択したセルへ打つ`
        const { page, problems } = await open('[{"s":"keep me"},{"s":"other"}]')
        await clickCell(page, ['0', 's'])
        await page.keyboard.type(typed)
        await page.keyboard.press('Enter')
        const value = JSON.parse(await documentText(page))[0].s
        record(`${name}: 文書が打ったとおり`, value === typed, JSON.stringify(value))
        record(`${name}: モーダルが開かない`, (await page.locator(MODAL).count()) === 0)
        await page.keyboard.press('Control+z')
        record(`${name}: undo で元の値`, JSON.parse(await documentText(page))[0].s === 'keep me', await documentText(page))
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
      {
        const name = `${typed} をツリーの値へ打つ`
        const { page, problems } = await open('{"s":"keep me"}', 'tree')
        await page.click('.jse-tree-mode .jse-value')
        await page.keyboard.type(typed)
        await page.keyboard.press('Enter')
        const value = JSON.parse(await documentText(page)).s
        record(`${name}: 文書が打ったとおり`, value === typed, JSON.stringify(value))
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
    }
  }

  /** 変換の結果が黙って減らず、丸めた値を書かない。 */
  async function queryLossGroup() {
    const modeFor = (source) => (source.startsWith('[') ? 'table' : 'tree') // 表は配列の文書だけ
    for (const [label, source, query, expected] of NOT_LOST_QUERIES) {
      const name = `Transform（${label}）`
      const { page, problems } = await open(source)
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', query)
      await page.waitForTimeout(QUERY_SETTLE_MS)
      record(`${name}: 止まらない`, (await page.locator('.jse-transform-modal .jse-preview.jse-error').count()) === 0)
      await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
      record(`${name}: 行が残る`, (await documentText(page)) === expected, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    for (const [label, source, query] of REFUSED_QUERIES) {
      const name = `止まる Transform（${label}）`
      const { page } = await open(source, modeFor(source))
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', query)
      await page.waitForTimeout(QUERY_SETTLE_MS)
      record(`${name}: 理由が出る`, (await page.locator('.jse-transform-modal .jse-preview.jse-error').count()) === 1)
      record(`${name}: 適用が止まる`, await page.locator('.jse-transform-modal .jse-primary').isDisabled())
      record(`${name}: 文書が変わらない`, (await documentText(page)) === source)
      await page.close()
    }
    for (const [label, source, query] of [
      ['keyBy', '[{"name":"__proto__","n":1},{"name":"a","n":2}]', 'keyBy(.name)'],
      ['mapKeys', '{"a":{"x":1},"b":{"y":2}}', 'mapKeys(if(get() == "a", "__proto__", get()))'],
      ['mapObject', '{"a":"__proto__","c":"d"}', 'mapObject({key: .value, value: .key})']
    ]) {
      const name = `結果のキーが __proto__（${label}）`
      const { page } = await open(source, modeFor(source))
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', query)
      await page.waitForTimeout(QUERY_SETTLE_MS)
      await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === source, await documentText(page))
      await page.close()
    }
  }

  /** undo の待ちの間に打っても、履歴の項目を失わず、削除を二重に当てない。 */
  async function undoWaitGroup() {
    const source = '[{"a":1},{"a":2},{"a":3}]'
    const compact = (value) => {
      try {
        return JSON.stringify(JSON.parse(value))
      } catch {
        return value
      }
    }
    const { page, problems } = await open(source, 'text')
    const name = 'undo の待ちの間に打つ'
    await switchTo(page, '表')
    await clickCell(page, ['0', 'a'])
    const { x, y } = await cellBox(page, ['0', 'a'])
    await page.mouse.click(x, y, { button: 'right' })
    await page.locator('div.jse-contextmenu button').filter({ hasText: /行を削除/ }).first().click({ timeout: STATE_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS)
    await switchTo(page, 'テキスト')
    await page.waitForTimeout(SETTLE_MS)
    await page.click('.jse-main .cm-content')
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' ')
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => window.fixture.holdScan())
    await page.keyboard.press('Control+z')
    await page.keyboard.type(' ')
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => window.fixture.releaseScan())
    await page.waitForTimeout(SETTLE_MS)
    const allowed = new Set(['[{"a":1},{"a":2},{"a":3}]', '[{"a":2},{"a":3}]'])
    const seen = [compact(await documentText(page))]
    const steps = async (key, count) => {
      for (let step = 0; step < count; step++) {
        await page.keyboard.press(key)
        await page.waitForTimeout(SETTLE_MS)
        seen.push(compact(await documentText(page)))
      }
    }
    await steps('Control+z', 3)
    record(`${name}: undo で消した行へ戻れる`, seen.includes(source), JSON.stringify(seen))
    await steps('Control+Shift+z', 4)
    record(`${name}: 過去に無かった文書が出ない`, seen.every((value) => allowed.has(value)), JSON.stringify(seen))
    record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }

  /** 離れたら編集欄は本当に閉じる。 */
  async function leaveGroup() {
    const text = '[{"a":"x"},{"a":"y"}]'
    {
      const name = '何も打たずメニューの余白を押す'
      const { page, problems } = await open(text)
      await clickCell(page, ['0', 'a'])
      await page.keyboard.press('Enter')
      await page.click('.jse-table-mode .jse-menu .jse-space')
      record(`${name}: 編集欄が閉じる`, (await editorCount(page)) === 0, String(await editorCount(page)))
      await expectUntouched(page, problems, name, text)
      await page.close()
    }
    {
      const name = '何も打たず見出しで並べ替える'
      const { page } = await open('[{"a":"z","id":1},{"a":"b","id":2},{"a":"m","id":3}]')
      await clickCell(page, ['0', 'a'])
      await page.keyboard.press('Enter')
      await page.click('.jse-column-header')
      record(`${name}: 編集欄が閉じる`, (await editorCount(page)) === 0, String(await editorCount(page)))
      const sorted = '[{"a":"b","id":2},{"a":"m","id":3},{"a":"z","id":1}]'
      record(`${name}: 並べ替えだけが入る`, (await documentText(page)) === sorted, await documentText(page))
      await page.close()
    }
    {
      const name = '打ってから見出しで並べ替える'
      const { page } = await open('[{"a":"z","id":1},{"a":"b","id":2},{"a":"m","id":3}]')
      await clickCell(page, ['0', 'a'])
      await page.keyboard.press('Enter')
      await page.keyboard.press('Control+End')
      await page.keyboard.type('2')
      await page.click('.jse-column-header')
      const after = JSON.parse(await documentText(page))
      record(`${name}: 打った行に入る`, after.find((row) => row.id === 1)?.a === 'z2', JSON.stringify(after))
      record(`${name}: 別の行が残る`, after.find((row) => row.id === 2)?.a === 'b', JSON.stringify(after))
      await page.close()
    }
  }

  /** テキストの表示に限る文書は、正しい JSON でも理由を出す。 */
  async function textOnlyReasonGroup() {
    for (const [label, text, reason] of [
      ['同値の重複キー', '{"a":1,"a":1}', '同じキー'],
      ['constructor', '{"constructor":1}', 'constructor'],
      ['__proto__', '{"__proto__":{"x":1}}', '__proto__']
    ]) {
      const name = `テキストの案内（${label}）`
      const { page } = await open(text, 'text')
      await page.waitForSelector('.jse-message', { timeout: STATE_TIMEOUT_MS })
      const shown = await page.locator('.jse-message').first().innerText()
      record(`${name}: 理由が出る`, shown.includes(reason), shown)
      await page.close()
    }
  }

  /** 要素数の多い配列でも開ける。 */
  async function hugeArrayGroup() {
    const name = '200 万要素の配列'
    const { page, problems } = await open('[]')
    await page.evaluate(
      (length) => window.fixture.set({ text: `[${'{"a":1},'.repeat(length - 1)}{"a":1}]` }),
      LARGE_ARRAY_LENGTH
    )
    const shown = await page
      .waitForSelector('.jse-table-main td[data-path]', { timeout: LARGE_OPEN_TIMEOUT_MS })
      .then(() => true, () => false)
    record(`${name}: 表で開ける`, shown)
    record(`${name}: 不正と言わない`, (await page.locator('.jse-message').count()) === 0)
    record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }

  async function numbersGroup() {
    const text = '[{"a":1.50,"b":1e400,"c":-0,"d":12345678901234567890,"e":"x"}]'
    const tokens = numberTokens(text).join()
    {
      const name = '別のセルの編集'
      const { page, problems } = await open(text)
      await clickCell(page, ['0', 'e'])
      await page.keyboard.type('y')
      await page.keyboard.press('Enter')
      const after = await documentText(page)
      record(`${name}: 数値のトークン列が同じ`, numberTokens(after).join() === tokens, after)
      record(`${name}: 編集が入る`, after.includes('"e":"y"'), after)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    const queries = [
      ['', NUMBERS_DOCUMENT],
      ['sort(.p)', null],
      ['filter(.q > 1)', null],
      ['map(.p)', '[1.50,0.10]'],
      ['map(.id)', '[12345678901234567890,12345678901234567891]'],
      ['map({a: .id, b: .p})', null]
    ]
    for (const [query, expected] of queries) {
      const name = `Transform の ${query === '' ? '空のクエリ' : query}`
      const { page, problems } = await open(NUMBERS_DOCUMENT)
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', query)
      await page.waitForTimeout(QUERY_SETTLE_MS)
      await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
      const after = await documentText(page)
      const everyToken = numberTokens(after).every((token) => numberTokens(NUMBERS_DOCUMENT).includes(token))
      record(`${name}: 字面が残る`, expected === null ? everyToken : after === expected, after)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '1.0 を含む文書の計算'
      const source = '[{"q":1.0},{"q":2}]'
      const { page } = await open(source)
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', 'map(.q * 2)')
      await page.waitForTimeout(QUERY_SETTLE_MS)
      await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
      record(`${name}: 動く`, (await documentText(page)) === '[2,4]', await documentText(page))
      await page.close()
    }
    const refused = [
      ['字面が割れる値', '[{"q":1.0},{"q":1}]', 'map(.q)'],
      ['安全でない数値を含む文書の計算', NUMBERS_DOCUMENT, 'map(.p * 2)'],
      ['保てない数値の重複の判定', NUMBERS_DOCUMENT, 'uniqBy(.id)'],
      ['保てない数値のキー化', NUMBERS_DOCUMENT, 'keyBy(.id)'],
      ['保てない数値の文字列化', NUMBERS_DOCUMENT, 'map(string(.id))'],
      ['保てない数値の比較', NUMBERS_DOCUMENT, 'filter(.id > 1)'],
      ['保てない数値の並べ替え', NUMBERS_DOCUMENT, 'sort(.id)']
    ]
    for (const [label, source, query] of refused) {
      const name = `止まる Transform（${label}）`
      const { page } = await open(source)
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', query)
      await page.waitForTimeout(QUERY_SETTLE_MS)
      record(`${name}: 理由が出る`, (await page.locator('.jse-transform-modal .jse-preview.jse-error').count()) === 1)
      record(`${name}: 適用が止まる`, await page.locator('.jse-transform-modal .jse-primary').isDisabled())
      record(`${name}: 文書が変わらない`, (await documentText(page)) === source)
      await page.close()
    }
  }

  /** 表とツリーに入らない文書。 */
  async function guardGroup() {
    const samples = [
      ...INVALID_SAMPLES.map((text) => [text.slice(0, 24), text]),
      ...TEXT_ONLY_SAMPLES
    ]
    for (const [label, text] of samples) {
      const name = `門番（${label}）`
      const { page, problems } = await open(text, 'text')
      for (const target of ['table', 'tree']) {
        await page.click(`.jse-group-button:has-text("${target === 'table' ? '表' : 'ツリー'}")`, { timeout: STATE_TIMEOUT_MS })
        await page.waitForTimeout(0)
        await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      }
      await page.evaluate(() => window.fixture.setMode('table'))
      await page.waitForTimeout(0)
      const screen = await page.evaluate(() => ({
        table: document.querySelectorAll('.jse-table-mode').length,
        tree: document.querySelectorAll('.jse-tree-mode').length
      }))
      record(`${name}: 表もツリーも出ない`, screen.table === 0 && screen.tree === 0, JSON.stringify(screen))
      await expectUntouched(page, problems, name, text)
      await page.close()
    }

    {
      const name = '深さ超過の文書'
      const text = '[[1]]'
      const { page, problems } = await open(text, 'text')
      await page.evaluate((target) => {
        window.fixture.markScan(target, {
          duplicateKey: false,
          numericKeyReorder: false,
          reservedKey: false,
          depthExceeded: true,
          syntaxOk: true
        })
      }, text)
      await page.click('.jse-group-button:has-text("表")', { timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: テキストの表示のまま`, (await page.evaluate(() => window.fixture.mode())) === 'テキスト')
      await expectUntouched(page, problems, name, text)
      await page.close()
    }

    for (const [label, undoKey] of [['ボタン', null], ['Ctrl+Z', 'Control+z']]) {
      const name = `表示の undo を検査が止める（${label}）`
      const text = '[{"a":1}]'
      const { page, problems } = await open(text, 'table')
      await switchTo(page, 'テキスト')
      await page.evaluate((target) => {
        window.fixture.markScan(target, {
          duplicateKey: true,
          numericKeyReorder: false,
          reservedKey: false,
          depthExceeded: false,
          syntaxOk: true
        })
      }, text)
      if (undoKey) {
        await page.click('.cm-content')
        await page.keyboard.press(undoKey)
      } else {
        await page.click('.jse-undo', { timeout: STATE_TIMEOUT_MS })
      }
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: 表へ戻らない`, (await page.locator('.jse-table-mode').count()) === 0)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === text, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }

    {
      const name = '検査を待つ間の入力'
      const text = '[{"a":1}]'
      const { page } = await open(text, 'text')
      await page.evaluate(() => window.fixture.holdScan())
      await page.click('.jse-group-button:has-text("表")', { timeout: STATE_TIMEOUT_MS })
      await page.evaluate(() => {
        window.fixture.typeAt('2', 6)
        window.fixture.releaseScan()
      })
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 切り替わらない`, (await page.evaluate(() => window.fixture.mode())) === 'テキスト')
      record(`${name}: 入力が残る`, (await documentText(page)) !== text, await documentText(page))
      await page.close()
    }

    {
      const name = '検査を待つ間の set'
      const { page } = await open('[{"a":1}]', 'text')
      await page.evaluate(() => window.fixture.holdScan())
      await page.click('.jse-group-button:has-text("表")', { timeout: STATE_TIMEOUT_MS })
      await page.evaluate(() => {
        window.fixture.set({ text: '{bad' })
        window.fixture.releaseScan()
      })
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 表示を替えない`, (await page.evaluate(() => window.fixture.mode())) === 'テキスト')
      record(`${name}: 新しい文書が残る`, (await documentText(page)) === '{bad')
      await page.close()
    }

    {
      const name = 'モーダルの中の切り替え'
      const { page, problems } = await open('[{"n":[1,2]}]')
      await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector(MODAL, { timeout: STATE_TIMEOUT_MS })
      await page.click(`${MODAL} .jse-group-button:has-text("テキスト")`, { timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector(`${MODAL} .cm-content`, { timeout: STATE_TIMEOUT_MS })
      await page.click(`${MODAL} .cm-content`)
      await page.keyboard.press('Control+End')
      await page.keyboard.type(',')
      await page.click(`${MODAL} .jse-group-button:has-text("表")`, { timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: 不正な内容で表へ入らない`, (await page.locator(`${MODAL} .jse-table-mode`).count()) === 0)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  async function largeWarningGroup() {
    const big = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({ index })))
    const limit = '&limit=100'
    const message = '.jse-message.jse-error'
    {
      const name = '大文書の警告'
      const { page, problems } = await open(big, 'text', limit)
      await page.waitForSelector(message, { timeout: STATE_TIMEOUT_MS })
      const labels = await page.locator(`${message} button`).allTextContents()
      record(`${name}: Cancel が無い`, labels.length === 2, labels.join())
      await page.locator(`${message} button`).first().click({ timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector('.cm-content', { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 開いても文書が同じ`, (await documentText(page)) === big)
      record(`${name}: undo が押せない`, await page.locator('.jse-undo').isDisabled())
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: Ctrl+Z でも空にならない`, (await documentText(page)) === big)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '有効な大文書の Open in tree mode'
      const { page, problems } = await open(big, 'text', limit)
      await page.waitForSelector(message, { timeout: STATE_TIMEOUT_MS })
      await page.locator(`${message} button`).last().click({ timeout: STATE_TIMEOUT_MS })
      record(`${name}: 開ける`, await reachesMode(page, 'ツリー'))
      record(`${name}: 文書が同じ`, (await documentText(page)) === big)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '不正な大文書の Open in tree mode'
      const broken = big.slice(0, -1)
      const { page, problems } = await open(broken, 'text', limit)
      await page.waitForSelector(message, { timeout: STATE_TIMEOUT_MS })
      await page.locator(`${message} button`).last().click({ timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: ツリーへ入らない`, (await page.locator('.jse-tree-mode').count()) === 0)
      await expectUntouched(page, problems, name, broken)
      await page.close()
    }
  }

  async function keysGroup() {
    const reserved = [
      ['__proto__ の表', '[{"__proto__":{"polluted":"yes"},"a":1}]', 'table'],
      ['__proto__ のツリー', '{"__proto__":{"polluted":"yes"},"a":2}', 'tree'],
      ['constructor の表', '[{"constructor":"x","a":1}]', 'table'],
      ['constructor のツリー', '{"constructor":"x","a":1}', 'tree']
    ]
    for (const [label, text, mode] of reserved) {
      const name = `予約のキー（${label}）`
      const { page, problems } = await open(text, mode)
      const polluted = await page.evaluate(() => window.fixture.prototypeChanges())
      record(`${name}: 原型が変わらない`, polluted.length === 0, polluted.join())
      record(`${name}: 値が化けない`, !(await page.evaluate(() => document.querySelector('.jse-main').innerText)).includes('[object Object]'))
      await expectUntouched(page, problems, name, text)
      await page.close()
    }
    for (const [mode, label] of [['tree', 'ツリー'], ['text', 'テキスト']]) {
      const name = `__proto__ のキーの並べ替え（${label}）`
      const text = '{"b":1,"__proto__":{"x":1},"a":2}'
      const { page } = await open(text, mode)
      await page.click('.jse-sort', { timeout: STATE_TIMEOUT_MS }).catch(() => {})
      await page.waitForTimeout(SETTLE_MS)
      const after = await documentText(page)
      record(`${name}: 文書が変わらない`, after === text, after)
      const polluted = await page.evaluate(() => window.fixture.prototypeChanges())
      record(`${name}: 原型が変わらない`, polluted.length === 0, polluted.join())
      await page.close()
    }
    for (const key of ['__proto__', 'constructor']) {
      const name = `キーを ${key} へ改名`
      const text = '{"a":1,"b":2}'
      const { page } = await open(text, 'tree')
      await page.locator('.jse-tree-mode .jse-key:has-text("a")').dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.keyboard.press('Control+A')
      await page.keyboard.type(key)
      await page.keyboard.press('Enter')
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === text, await documentText(page))
      record(`${name}: onChange が出ない`, (await changeCount(page)) === 0)
      record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
      await page.close()
    }
    {
      const name = '変換の結果の予約のキー'
      const text = '[{"a":1}]'
      const { page } = await open(text)
      await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
      await page.fill('.jse-transform-modal textarea.jse-query', 'map({constructor: .a})')
      await page.waitForTimeout(QUERY_SETTLE_MS)
      await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === text, await documentText(page))
      await page.close()
    }
    {
      const name = '継承の名前の列'
      const text = '[{"toString":1,"valueOf":2,"a":3},{"a":4}]'
      const { page, problems } = await open(text)
      const heads = await page.locator('th.jse-table-cell-header').allTextContents()
      record(`${name}: 列が出る`, heads.join().includes('toString') && heads.join().includes('valueOf'), heads.join())
      await clickCell(page, ['1', 'toString'])
      await page.keyboard.type('7')
      await page.keyboard.press('Enter')
      const expected = '[{"toString":1,"valueOf":2,"a":3},{"a":4,"toString":7}]'
      record(`${name}: 欠けセルへ入力できる`, (await documentText(page)) === expected, await documentText(page))
      await page.keyboard.press('Control+z')
      record(`${name}: undo で消える`, await reaches(page, (value) => window.fixture.text() === value, text))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  async function pendingGroup() {
    const DOC = '{"b":1,"a":2}'
    const actions = [
      ['整形', '.jse-format', null],
      ['圧縮', '.jse-compact', null],
      ['並べ替えの適用', '.jse-sort', '.jse-sort-modal'],
      ['変換の適用', '.jse-transform', '.jse-transform-modal']
    ]
    for (const [label, selector, modal] of actions) {
      const name = `遅延中の${label}`
      const { page, problems } = await open(DOC, 'text')
      await page.waitForSelector('.cm-content', { timeout: STATE_TIMEOUT_MS })
      const pending = await page.evaluate(([typed, button]) => {
        const before = window.fixture.changes.length
        window.fixture.typeNow(typed)
        const waiting = window.fixture.changes.length === before
        document.querySelector(button).click()
        return waiting
      }, [TYPED_KEY, selector])
      record(`${name}: 操作の時点で変更が渡っていない`, pending)
      if (modal) {
        await page.waitForSelector(modal, { timeout: STATE_TIMEOUT_MS })
        await page.waitForTimeout(QUERY_SETTLE_MS)
        await page.click(`${modal} .jse-primary`, { timeout: STATE_TIMEOUT_MS })
      }
      await page.waitForTimeout(SETTLE_MS)
      const after = await documentText(page)
      record(`${name}: 打った文字が残る`, after.includes(TYPED_MARK), after)
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '遅延中の修復'
      const text = '{"a":1,}'
      const { page } = await open(text, 'text')
      await page.locator('.jse-message button').first().waitFor({ timeout: STATE_TIMEOUT_MS })
      await page.evaluate((typed) => {
        window.fixture.typeNow(typed)
        document.querySelector('.jse-message button').click()
      }, TYPED_KEY)
      await page.waitForTimeout(SETTLE_MS)
      const after = await documentText(page)
      record(`${name}: 打った文字が残る`, after.includes(TYPED_MARK), after)
      await page.close()
    }
    for (const [label, call] of [
      ['set', 'set'],
      ['updateProps の content', 'setContent']
    ]) {
      const name = `遅延中の ${label}`
      const { page, problems } = await open(DOC, 'text')
      await page.waitForSelector('.cm-content', { timeout: STATE_TIMEOUT_MS })
      await page.evaluate(([typed, method, text]) => {
        window.fixture.typeNow(typed)
        window.fixture[method]({ text })
      }, [TYPED_KEY, call, NEW_DOCUMENT])
      await page.waitForTimeout(SETTLE_MS)
      const after = await documentText(page)
      record(`${name}: 新しい文書が残る`, after === NEW_DOCUMENT, after)
      const changes = await page.evaluate(() => window.fixture.changes)
      record(`${name}: 打った文字は onChange で渡る`, changes.length === 1 && changes[0].includes('z'), changes.join())
      record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    for (const [mode, modeLabel, doc, path] of [
      ['table', '表', '[{"a":1,"b":"x"}]', ['0', 'b']],
      ['tree', 'ツリー', '{"a":1,"b":"x"}', null]
    ]) {
      const name = `${modeLabel}のセルの編集中の set`
      const { page, problems } = await open(doc, mode)
      if (path) {
        await clickCell(page, path)
        await page.keyboard.press('Enter')
      } else {
        await page.getByText('x', { exact: false }).last().dblclick({ timeout: STATE_TIMEOUT_MS })
      }
      await page.keyboard.press('Control+A')
      await page.keyboard.type('ZZ')
      await page.evaluate((text) => window.fixture.set({ text }), NEW_DOCUMENT)
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 新しい文書が残る`, (await documentText(page)) === NEW_DOCUMENT, await documentText(page))
      const changes = await page.evaluate(() => window.fixture.changes)
      record(`${name}: 編集は onChange で渡る`, changes.length === 1 && changes[0].includes('ZZ'), changes.join())
      record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '確定の直後の patch'
      const { page, problems } = await open('[1,2]', 'text')
      await page.waitForSelector('.cm-content', { timeout: STATE_TIMEOUT_MS })
      const text = await page.evaluate(() => {
        window.fixture.typeNow('777,')
        window.fixture.commit()
        window.fixture.patch([{ op: 'replace', path: '/0', value: 888 }])
        return window.fixture.text()
      })
      await page.waitForTimeout(SETTLE_MS)
      record(`${name}: 文書に残る`, text.includes('888') && (await documentText(page)).includes('888'), await documentText(page))
      record(`${name}: 画面に残る`, (await page.locator('.cm-content').innerText()).includes('888'))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  async function staleSelectionGroup() {
    const NESTED = '[{"a":{"b":1},"c":2}]'
    const pick = async (page, mode) => {
      if (mode === 'table') {
        await clickCell(page, ['0', 'a', 'b'])
      } else {
        await page.locator('.jse-tree-mode .jse-value').first().click({ timeout: STATE_TIMEOUT_MS })
      }
    }
    for (const [label, mode, after] of [
      ['表で選択→テキストで変換', 'table', 'transform'],
      ['表で選択→set', 'table', 'set'],
      ['ツリーで選択→set', 'tree', 'set'],
      ['表で選択→テキストで set', 'table', 'text-set']
    ]) {
      const name = `古い選択（${label}）`
      const { page, problems } = await open(NESTED, mode)
      await pick(page, mode)
      if (after === 'transform') {
        await switchTo(page, 'テキスト')
        await page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS })
        await page.fill('.jse-transform-modal textarea.jse-query', 'map(.c)')
        await page.waitForTimeout(QUERY_SETTLE_MS)
        await page.click('.jse-transform-modal .jse-primary', { timeout: STATE_TIMEOUT_MS })
        await page.waitForTimeout(SETTLE_MS)
      } else {
        if (after === 'text-set') await switchTo(page, 'テキスト')
        await page.evaluate(() => window.fixture.set({ json: [1, 2] }))
      }
      const before = await documentText(page)
      record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
      record(`${name}: 文書が変わらない`, (await documentText(page)) === before, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
  }

  /** 表で行き先を失った選択は、次の文書の入力を受けない。 */
  async function staleCellGroup() {
    const name = '表で古い選択のまま打つ'
    const replaced = '[{"c":1}]'
    const { page, problems } = await open('[{"a":{"b":1},"c":2}]')
    await clickCell(page, ['0', 'a', 'b'])
    await page.evaluate((text) => window.fixture.set({ text }), replaced)
    await page.waitForTimeout(SETTLE_MS)
    await page.locator('.jse-table-mode .jse-hidden-input').focus()
    await page.keyboard.type('7')
    await page.keyboard.press('Enter')
    record(`${name}: 編集欄が開かない`, (await editorCount(page)) === 0)
    record(`${name}: 文書が変わらない`, (await documentText(page)) === replaced, await documentText(page))
    record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
    await page.close()
  }

  async function modalGroup() {
    const DOC = '[{"n":[{"m":[1,2],"o":"keep"}],"k":1}]'
    const APPLY = `${MODAL} .jse-actions .jse-primary`
    const BACK = `${MODAL} .jse-actions .jse-secondary`
    const open1 = async (page) => {
      await page.locator('.jse-table-mode .jse-inline-value').first().dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector(MODAL, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(SETTLE_MS)
    }
    const open2 = async (page) => {
      await open1(page)
      await page.locator(`${MODAL} .jse-table-mode .jse-inline-value`).first().dblclick({ timeout: STATE_TIMEOUT_MS })
      await reaches(page, (selector) => document.querySelector(selector)?.value.includes('m'), `${MODAL} .jse-path`)
      await page.waitForTimeout(SETTLE_MS)
    }
    const editFirst = async (page, value) => {
      await page.locator(`${MODAL} .jse-table-mode .jse-value`).first().dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.keyboard.press('Control+A')
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
    }
    const applyAll = async (page) => {
      while (await page.locator(APPLY).count()) {
        await page.click(APPLY, { timeout: STATE_TIMEOUT_MS })
        await page.waitForTimeout(MODAL_STEP_MS)
      }
    }
    const MODAL_STEP_MS = 200

    {
      const name = '2 段目の編集を捨てて親で undo'
      const { page, problems } = await open(DOC)
      await open2(page)
      await editFirst(page, '55')
      await page.click(BACK, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      record(`${name}: undo が押せない`, await page.locator(`${MODAL} .jse-undo`).isDisabled())
      await applyAll(page)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === DOC, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = 'テキストの 2 段目を捨てて親で undo'
      const { page, problems } = await open(DOC)
      await open2(page)
      await page.click(`${MODAL} .jse-group-button:has-text("テキスト")`, { timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector(`${MODAL} .cm-content`, { timeout: STATE_TIMEOUT_MS })
      await page.click(`${MODAL} .cm-content`)
      await page.keyboard.press('Control+Home')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.type('777,')
      await page.waitForTimeout(SETTLE_MS)
      await page.click(BACK, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      record(`${name}: undo が押せない`, await page.locator(`${MODAL} .jse-undo`).isDisabled())
      await applyAll(page)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === DOC, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '編集なしの 2 段目'
      const { page, problems } = await open(DOC)
      await open2(page)
      record(`${name}: undo が押せない`, await page.locator(`${MODAL} .jse-undo`).isDisabled())
      await applyAll(page)
      record(`${name}: 文書が変わらない`, (await documentText(page)) === DOC, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '2 段目の Apply の後の親の undo と redo'
      const { page, problems } = await open(DOC)
      await open2(page)
      await editFirst(page, '55')
      await page.click(APPLY, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      await page.click(`${MODAL} .jse-undo`, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      await page.click(`${MODAL} .jse-redo`, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      await applyAll(page)
      const expected = '[{"n":[{"m":[55,2],"o":"keep"}],"k":1}]'
      record(`${name}: 編集が入る`, (await documentText(page)) === expected, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }
    {
      const name = '1 段目の undo'
      const { page, problems } = await open(DOC)
      await open1(page)
      await page.locator(`${MODAL} .jse-table-mode .jse-value:has-text("keep")`).dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.keyboard.press('Control+A')
      await page.keyboard.type('K')
      await page.keyboard.press('Enter')
      await page.locator(`${MODAL} .jse-table-mode .jse-inline-value`).first().dblclick({ timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(SETTLE_MS)
      await page.click(BACK, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      await page.click(`${MODAL} .jse-undo`, { timeout: STATE_TIMEOUT_MS })
      await page.waitForTimeout(MODAL_STEP_MS)
      record(`${name}: 次の undo が押せない`, await page.locator(`${MODAL} .jse-undo`).isDisabled())
      await applyAll(page)
      record(`${name}: 文書が戻る`, (await documentText(page)) === DOC, await documentText(page))
      record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
      await page.close()
    }

    const OPENERS = [
      ['セルのモーダル', '[{"n":[1,2]}]', 'table', open1, MODAL],
      ['Transform のモーダル', '[{"a":1}]', 'table', async (page) => page.click('.jse-transform', { timeout: STATE_TIMEOUT_MS }), '.jse-transform-modal'],
      ['Sort のモーダル', '[{"a":1}]', 'table', async (page) => page.click('.jse-sort', { timeout: STATE_TIMEOUT_MS }), '.jse-sort-modal']
    ]
    for (const [label, text, mode, show, modal] of OPENERS) {
      for (const call of ['set', 'setContent']) {
        const name = `${label}を開いたままの ${call === 'set' ? 'set' : 'updateProps'}`
        const { page, problems } = await open(text, mode)
        await show(page)
        await page.waitForSelector(modal, { timeout: STATE_TIMEOUT_MS })
        await page.evaluate(([method, content]) => window.fixture[method]({ text: content }), [call, NEW_DOCUMENT])
        await page.waitForTimeout(SETTLE_MS)
        record(`${name}: モーダルが閉じる`, (await page.locator(modal).count()) === 0)
        record(`${name}: 新しい文書が残る`, (await documentText(page)).includes(NEW_MARK), await documentText(page))
        record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
        record(`${name}: エラーが無い`, problems.length === 0, problems.slice(0, 2).join(' / '))
        await page.close()
      }
    }
  }

  async function extractGroup() {
    {
      const name = '表の案内の Extract'
      const text = '{"items":[{"a":1}],"keep":true}'
      const { page, problems } = await open(text)
      const labels = await page.locator('.jse-nested-array-action').allTextContents()
      record(`${name}: ボタンが無い`, !labels.some((label) => label.includes('抽出')), labels.join())
      await expectUntouched(page, problems, name, text)
      await page.close()
    }
    {
      const name = 'ツリーの右クリックの Extract'
      const text = '{"items":[{"a":1}],"keep":true}'
      const { page, problems } = await open(text, 'tree')
      await page.locator('.jse-tree-mode .jse-key:has-text("keep")').click({ button: 'right', timeout: STATE_TIMEOUT_MS })
      await page.waitForSelector('div.jse-contextmenu', { timeout: STATE_TIMEOUT_MS })
      const menu = await page.locator('div.jse-contextmenu').innerText()
      record(`${name}: 項目が無い`, !menu.includes('抽出') && !menu.includes('Extract'), menu.replace(/\s+/g, ' '))
      await expectUntouched(page, problems, name, text)
      await page.close()
    }
  }

  async function errorsGroup() {
    const name = '表の例外'
    const text = '[{"a":1,"b":"x"}]'
    const { page, problems } = await open(text)
    await page.evaluate(() => window.fixture.failRendering(true))
    await page.evaluate(() => window.fixture.setContent({ text: '[{"a":2,"b":"y"}]' }))
    await reaches(page, (selector) => !document.querySelector(selector).hidden, BANNER)
    const banner = await page.locator(BANNER).innerText()
    record(`${name}: 通知が出る`, banner.length > 0, banner)
    await page.evaluate(() => {
      window.fixture.failRendering(false)
      window.fixture.setContent({ text: '[{"a":3,"b":"z"}]' })
    })
    record(`${name}: alert が出ない`, (await page.evaluate(() => window.fixture.alerts.length)) === 0)
    record(`${name}: 3 つの表示を回せる`, await cyclesAllModes(page))
    await switchTo(page, '表')
    await page.getByText('z', { exact: true }).dblclick({ timeout: STATE_TIMEOUT_MS }).catch(() => {})
    await page.keyboard.press('Control+A')
    await page.keyboard.type('w')
    await page.keyboard.press('Enter')
    record(`${name}: 続けて編集できる`, (await documentText(page)).includes('"b":"w"'), await documentText(page))
    record(`${name}: 例外の外の問題が無い`, problems.every((problem) => problem.includes('injected')), problems.slice(0, 2).join(' / '))
    await page.close()

    {
      const asyncName = '非同期の例外'
      const { page: second } = await open(text)
      await second.evaluate(() => {
        void Promise.reject(new Error('injected async'))
      })
      await reaches(second, (selector) => !document.querySelector(selector).hidden, BANNER)
      record(`${asyncName}: 通知が出る`, (await second.locator(BANNER).innerText()).includes('injected async'))
      record(`${asyncName}: alert が出ない`, (await second.evaluate(() => window.fixture.alerts.length)) === 0)
      await second.close()
    }
  }

  const groups = {
    cannotAdd: cannotAddGroup,
    missing: missingCellGroup,
    untouched: untouchedGroup,
    typing: typingKeepsTheRestGroup,
    literal: literalTypingGroup,
    offScreen: offScreenGroup,
    scrollEditorAway: scrollEditorAwayGroup,
    scrollKeepsEdit: scrollKeepsEditGroup,
    brackets: bracketsGroup,
    queryLoss: queryLossGroup,
    undoWait: undoWaitGroup,
    leave: leaveGroup,
    textOnlyReason: textOnlyReasonGroup,
    hugeArray: hugeArrayGroup,
    numbers: numbersGroup,
    guard: guardGroup,
    large: largeWarningGroup,
    keys: keysGroup,
    pending: pendingGroup,
    selection: staleSelectionGroup,
    staleCell: staleCellGroup,
    modal: modalGroup,
    extract: extractGroup,
    errors: errorsGroup
  }

  for (const [name, group] of Object.entries(groups)) {
    if (only === undefined || only.includes(name)) {
      await group()
    }
  }
}
