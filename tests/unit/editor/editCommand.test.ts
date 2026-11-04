// Edit メニューの命令の公開の関数（vendor CHANGES 26）。右クリックとキーと同じ関数を呼ぶこと、
// 門番の答えを待つ間は何もしないことを確かめる。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const DOC = '[{"a":"first","b":2},{"a":"second","b":3}]'
const CLIPBOARD_TEXT = '"pasted"'

beforeAll(installDomStubs)
afterEach(destroyAll)

let written: string[] = []
let toRead = CLIPBOARD_TEXT

beforeEach(() => {
  written = []
  toRead = CLIPBOARD_TEXT
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text)
      },
      readText: async () => toRead
    }
  })
})

const settled = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync()
  }
}

/** 表で 0 行目の a のセルを選んだ状態。 */
function tableWithCell(): Mounted {
  const view = mountForTest({ text: DOC }, Mode.table)
  view.select(0, 'a')
  return view
}

/** キーの貼り付け（ClipboardEvent の paste）。jsdom に DataTransfer が無いので clipboardData を足す。 */
function pasteEvent(view: Mounted, text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  ;(view.target.querySelector('.jse-hidden-input') as HTMLElement).dispatchEvent(event)
  flushSync()
}

describe('Edit の命令（表）', () => {
  it('コピーは Ctrl+C と同じ文字をクリップボードへ書く', async () => {
    const byMenu = tableWithCell()
    expect(byMenu.editor.runEditCommand('copy')).toBe(true)
    await settled()
    const byKey = tableWithCell()
    byKey.press('c', { ctrlKey: true })
    await settled()
    expect(written).toHaveLength(2)
    expect(written[0]).toBe(written[1])
    expect(written[0]).toContain('first')
    expect(byMenu.text()).toBe(byKey.text()) // コピーは文書を変えない
  })

  it('切り取りは Ctrl+X と同じ結果', async () => {
    const byMenu = tableWithCell()
    byMenu.editor.runEditCommand('cut')
    await settled()
    const byKey = tableWithCell()
    byKey.press('x', { ctrlKey: true })
    await settled()
    expect(written).toHaveLength(2)
    expect(written[0]).toBe(written[1])
    expect(byMenu.text()).toBe(byKey.text())
    expect(byMenu.text()).not.toContain('first')
  })

  it('貼り付けは右クリックとキーの貼り付けと同じ結果', async () => {
    const byMenu = tableWithCell()
    byMenu.editor.runEditCommand('paste')
    await settled()
    const byKey = tableWithCell()
    pasteEvent(byKey, CLIPBOARD_TEXT)
    await settled()
    expect(byMenu.text()).toBe(byKey.text())
    expect(byMenu.text()).toContain('pasted')
    expect(byMenu.text()).not.toContain('first')
  })

  it('検索と置換は置換の欄つきで検索を開く（Ctrl+H と同じ）', async () => {
    const view = tableWithCell()
    expect(view.target.querySelector('.jse-search-box')).toBeNull()
    expect(view.editor.runEditCommand('findReplace')).toBe(true)
    await settled()
    expect(view.target.querySelector('.jse-search-box')).not.toBeNull()
    expect(view.target.querySelector('.jse-search-box .jse-replace-input')).not.toBeNull()
  })

})

describe('Edit の命令（門番の待ち）', () => {
  it('門番の答えを待つ間は何もしない', async () => {
    // テキストから表へ。門番は Rust の走査の答えを待つ（テキストへ入るのは待たない）
    const view = mountForTest({ text: DOC }, Mode.text)
    await settled()
    const before = view.text()
    view.scanner.hold()
    view.editor.updateProps({ mode: Mode.table })
    for (const command of ['findReplace', 'cut', 'copy', 'paste'] as const) {
      expect(view.editor.runEditCommand(command)).toBe(false)
    }
    await settled()
    expect(view.target.querySelector('.cm-search')).toBeNull()
    expect(view.text()).toBe(before)
    expect(written).toHaveLength(0)
    view.scanner.release()
    await settled()
    // 答えの後は走る
    expect(view.editor.runEditCommand('findReplace')).toBe(true)
  })
})

describe('Edit の命令（ツリー）', () => {
  it('検索と置換を開き、選択の無い切り取りは文書を変えない', async () => {
    const view = mountForTest({ text: DOC }, Mode.tree)
    const before = view.text()
    expect(view.editor.runEditCommand('cut')).toBe(true)
    await settled()
    expect(view.text()).toBe(before)
    expect(written).toHaveLength(0)
    view.editor.runEditCommand('findReplace')
    await settled()
    expect(view.target.querySelector('.jse-search-box .jse-replace-input')).not.toBeNull()
  })
})

describe('Edit の命令（テキスト）', () => {
  it('検索と置換だけを走らせ、切り取り、コピー、貼り付けは殻へ返す', async () => {
    const view = mountForTest({ text: DOC }, Mode.text)
    const before = view.text()
    for (const command of ['cut', 'copy', 'paste'] as const) {
      expect(view.editor.runEditCommand(command)).toBe(false)
    }
    await settled()
    expect(view.text()).toBe(before)
    expect(written).toHaveLength(0)
    expect(view.editor.runEditCommand('findReplace')).toBe(true)
    await settled()
    expect(view.target.querySelector('.cm-search')).not.toBeNull()
  })
})
