// テキストの表示に限る文書を、どの操作も畳まず、理由を出して止める。
import { flushSync } from 'svelte'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Mode, SelectionType } from '$lib/types'
import ja from '../../../src/i18n/ja.json'
import { destroyAll, installDomStubs, mountForTest, type Mounted } from './harness'

const MODAL = '.jse-jsoneditor-modal'
const DUPLICATE = '{ "a": 1, "a": 1, "b": 2 }'
const SETTLE_MS = 30

beforeAll(installDomStubs)
afterEach(destroyAll)

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  flushSync()
}

function clickMode(view: Mounted, label: string): void {
  const button = [...view.target.querySelectorAll<HTMLElement>('.jse-group-button')].find(
    (element) => element.textContent?.trim() === label
  ) as HTMLElement
  button.click()
  flushSync()
}

describe('テキストの操作と重複キー', () => {
  it.each(['.jse-format', '.jse-compact', '.jse-sort', '.jse-transform'])(
    '%s は文書を変えず、理由を出す',
    async (selector) => {
      const view = mountForTest({ text: DUPLICATE }, Mode.text)
      ;(view.target.querySelector(selector) as HTMLElement).click()
      await settled()
      expect(view.text()).toBe(DUPLICATE)
      expect(view.changes).toEqual([])
      expect(view.banner()).toContain(ja['app.parser.duplicateKey'])
    }
  )

  it('表への切り替えは重複の理由を出し、文書を変えない', async () => {
    const view = mountForTest({ text: DUPLICATE }, Mode.text)
    clickMode(view, ja['editor.modeTable'])
    await settled()
    expect(view.modeLabel()).toBe(ja['editor.modeText'])
    expect(view.banner()).toBe(ja['app.parser.duplicateKey'])
    expect(view.text()).toBe(DUPLICATE)
  })

  it('予約のキーの切り替えは理由を出し、不正な JSON と言わない', async () => {
    const view = mountForTest({ text: '{"constructor":1}' }, Mode.text)
    clickMode(view, ja['editor.modeTable'])
    await settled()
    expect(view.banner()).toContain('constructor')
    expect(view.banner()).not.toBe(ja['app.notice.invalidJson'])
  })
})

describe('モーダルの Apply と重複キー', () => {
  function openModalWithText(text: string): Mounted {
    const view = mountForTest({ text: '[{"n":[{"k":1}],"z":1}]' }, Mode.table)
    view.select(0, 'n')
    view.press('Enter')
    clickInModal(view, ja['editor.modeText'])
    replaceInModal(view, text)
    return view
  }

  function clickInModal(view: Mounted, label: string): void {
    const modal = view.target.querySelector(MODAL) as HTMLElement
    const button = [...modal.querySelectorAll<HTMLElement>('.jse-group-button')].find(
      (element) => element.textContent?.trim() === label
    ) as HTMLElement
    button.click()
    flushSync()
  }

  function replaceInModal(view: Mounted, text: string): void {
    const content = (view.target.querySelector(MODAL) as HTMLElement).querySelector(
      '.cm-content'
    ) as unknown as {
      cmTile: {
        root: { view: { state: { doc: { length: number } }; dispatch(spec: unknown): void } }
      }
    }
    const editor = content.cmTile.root.view
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
  }

  it.each(['{"a":1,"a":1}', '{"a":1,"b":2,"a":1}', '{"a":"x","a":"x"}'])(
    '%s の Apply は止まり、理由を出す',
    async (text) => {
      const view = openModalWithText(text)
      await settled()
      ;(view.target.querySelector(`${MODAL} .jse-actions .jse-primary`) as HTMLElement).click()
      flushSync()
      expect(view.target.querySelector(MODAL)).not.toBeNull()
      expect(view.target.querySelector(`${MODAL} .jse-error`)?.textContent).toContain(
        ja['app.parser.duplicateKey']
      )
      expect(view.changes).toEqual([])
    }
  )
})

describe('Transform の結果の予約のキー', () => {
  it('根の constructor は適用しない', () => {
    const text = '{"a":1,"b":2}'
    const view = mountForTest({ text }, Mode.tree)
    expect(() =>
      view.editor.patch([
        { op: 'replace', path: '', value: JSON.parse('{"constructor":1,"b":2}') }
      ])
    ).toThrow('constructor')
    expect(view.text()).toBe(text)
  })

  it('根の __proto__ は適用しない', () => {
    const text = '{"a":1,"b":2}'
    const view = mountForTest({ text }, Mode.tree)
    expect(() =>
      view.editor.patch([{ op: 'replace', path: '', value: JSON.parse('{"__proto__":1}') }])
    ).toThrow('__proto__')
    expect(view.text()).toBe(text)
  })

  it('ツリーの値の編集で文書全体が消えない', () => {
    const view = mountForTest({ text: '{"a":1,"b":2}' }, Mode.tree)
    view.editor.select({ type: SelectionType.value, path: ['a'] })
    view.press('Enter')
    view.typeAndEnter('9')
    expect(view.text()).toBe('{"a":9,"b":2}')
  })
})
