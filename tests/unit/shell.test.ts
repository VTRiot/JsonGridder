import { describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { format, setLanguage, t } from '../../src/i18n'
import { buildMenus, splitAccessKey } from '../../src/shell/menuModel'
import { chooseView, findTableTargets } from '../../src/shell/tableTargets'
import { documentName, windowTitle } from '../../src/shell/title'
import { version } from '../../package.json'

const parse = (text: string): unknown => JSON.parse(text)
const open = (text: string, sizeClass: 'allModes' | 'noTextMode' = 'allModes', textOnly = false) =>
  chooseView(text, { textOnly, sizeClass }, parse)

describe('findTableTargets', () => {
  it('対象は配列の中へ入らない', () => {
    const paths = findTableTargets({ a: [{ b: [1] }] }).map(({ path }) => path)
    expect(paths).toEqual([['a']])
  })

  it('空の配列は対象にしない', () => {
    expect(findTableTargets({ a: [], b: { c: [] } })).toEqual([])
  })

  it('オブジェクトの行を持つ配列を、行の多い配列より先にする', () => {
    const [first] = findTableTargets({ many: [1, 2, 3], rows: [{ a: 1 }] })
    expect(first.path).toEqual(['rows'])
  })

  it('行の多い順、浅い順、文書の順に並ぶ', () => {
    const json = { small: [1], deep: { big: [1, 2] }, big: [1, 2], later: [3, 4] }
    expect(findTableTargets(json).map(({ path }) => path.join('.'))).toEqual([
      'big',
      'later',
      'deep.big',
      'small'
    ])
  })

  it('先頭の 100 行より後のオブジェクトは見ない', () => {
    const late = [...Array.from({ length: 100 }, () => 1), { a: 1 }]
    const [first] = findTableTargets({ late, early: [{ a: 1 }] })
    expect(first.path).toEqual(['early'])
  })

  it('自前のキーだけを見る', () => {
    const json = Object.create({ inherited: [1] }) as Record<string, unknown>
    expect(findTableTargets(json)).toEqual([])
  })
})

describe('chooseView', () => {
  it('ルートの配列はツリー、表の対象は文書全体', () => {
    expect(open('[1]')).toEqual({ mode: Mode.tree, tableTarget: [] })
  })

  it('ルートのオブジェクトはツリー、表の対象に候補の先頭を入れておく', () => {
    expect(open('{"a":{"rows":[{"x":1}]}}')).toEqual({ mode: Mode.tree, tableTarget: ['a', 'rows'] })
  })

  it('候補が無いオブジェクトと値はツリー、対象なし', () => {
    expect(open('{"a":[]}')).toEqual({ mode: Mode.tree, tableTarget: [] })
    expect(open('1')).toEqual({ mode: Mode.tree, tableTarget: [] })
  })

  it('テキストに限る文書はテキスト、対象なし', () => {
    expect(open('{', 'allModes', true)).toEqual({ mode: Mode.text, tableTarget: [] })
    expect(open('{"a":[{"x":1}]}', 'allModes', true)).toEqual({ mode: Mode.text, tableTarget: [] })
  })

  it('10 MB 超の文書はテキストへ入らない', () => {
    expect(open('[1]', 'noTextMode').mode).toBe(Mode.tree)
    expect(open('{"a":1}', 'noTextMode').mode).toBe(Mode.tree)
  })

  it('読めない文書でも 10 MB 超ならテキストへ入らない', () => {
    expect(open('{', 'allModes').mode).toBe(Mode.text)
    expect(open('{', 'noTextMode').mode).toBe(Mode.tree)
  })
})

describe('windowTitle', () => {
  it('ファイル名とアプリ名と版を出す', () => {
    expect(windowTitle('C:\\docs\\日本語 😀.json', false)).toBe(`日本語 😀.json - JsonGridder ${version}`)
    expect(windowTitle('/docs/a.json', true)).toBe(`*a.json - JsonGridder ${version}`)
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('開いていなければ無題', () => {
    expect(documentName(null)).toBe(t('app.window.untitled'))
  })

  it('ファイル名の中の差し込み記号を置き換えない', () => {
    expect(windowTitle('{{app}}.json', false)).toBe(`{{app}}.json - JsonGridder ${version}`)
  })
})

describe('format', () => {
  it('知らない名前は残す', () => {
    expect(format('app.window.title', {})).toBe('{{dirty}}{{name}} - {{app}}')
  })
})

describe('menuModel', () => {
  const edit = { undo: true, redo: false, cut: true, copy: true, paste: true, findReplace: true, openInTextEditor: false }
  const state = {
    splashCeremony: false,
    splashCeremonyUnlocked: false,
    wrapLines: false,
    hideTargetsInTree: false,
    translationSettings: true,
    edit
  }
  const groups = buildMenus({ language: 'ja', theme: 'light', recent: [], ...state })
  const recentChildren = (recent: string[]) =>
    buildMenus({ language: 'ja', theme: 'light', recent, ...state })[0].entries[1].children ?? []

  it('履歴が空なら空の項目が出て、消す項目は押せない', () => {
    const [empty, clear] = recentChildren([])
    expect(empty.enabled).toBe(false)
    expect(clear.command).toBe('clearRecent')
    expect(clear.enabled).toBe(false)
  })

  it('履歴は新しい順に並び、パスの & をアクセスキーとして読まない', () => {
    const children = recentChildren(['C:\\R&D\\a.json', 'C:\\b.json'])
    expect(children.map(({ label }) => label)).toEqual(['C:\\R&D\\a.json', 'C:\\b.json', '履歴を消す(C)'])
    expect(children[0].command).toBe('recent:C:\\R&D\\a.json')
    expect(children[0].accessKey).toBeUndefined()
    expect(children[2].enabled).toBe(true)
  })

  it('アクセスキーを分ける', () => {
    expect(splitAccessKey('ファイル(&F)')).toEqual({ label: 'ファイル(F)', accessKey: 'F' })
    expect(splitAccessKey('印なし')).toEqual({ label: '印なし' })
  })

  it('4 つのメニューが辞書から作られる（Edit は File と Options の間）', () => {
    expect(groups.map(({ accessKey }) => accessKey)).toEqual(['F', 'E', 'O', 'H'])
    expect(groups.flatMap(({ entries }) => entries).every(({ label }) => !label.startsWith('app.'))).toBe(true)
  })

  it('Edit の項目が発注書のとおり（最後にテキストで開く）、群の間に区切り', () => {
    const entries = groups[1].entries
    expect(entries.map(({ command }) => command)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'findReplace',
      'openInTextEditor'
    ])
    expect(entries.map(({ separatorBefore }) => separatorBefore === true)).toEqual([false, false, true, false, false, true, true])
    expect(entries.map(({ shortcut }) => shortcut)).toEqual([
      'Ctrl+Z',
      'Ctrl+Shift+Z',
      'Ctrl+X',
      'Ctrl+C',
      'Ctrl+V',
      'Ctrl+H',
      undefined
    ])
    expect(entries.at(-1)?.label).toBe('テキストで開く(O)')
  })

  it('Edit の項目の押せる状態は渡された状態のまま', () => {
    expect(groups[1].entries.map(({ enabled }) => enabled)).toEqual([true, false, true, true, true, true, false])
    const none = {
      undo: false,
      redo: false,
      cut: false,
      copy: false,
      paste: false,
      findReplace: false,
      openInTextEditor: false
    }
    const closed = buildMenus({ language: 'ja', theme: 'light', recent: [], ...state, edit: none })[1].entries
    expect(closed.every(({ enabled }) => !enabled)).toBe(true)
  })

  it('メニューの名前と Edit の項目のアクセスキーが重ならない', () => {
    for (const language of ['ja', 'en']) {
      setLanguage(language)
      const menus = buildMenus({ language, theme: 'light', recent: [], ...state })
      const groupKeys = menus.map(({ accessKey }) => accessKey)
      expect(new Set(groupKeys).size, `${language}: ${groupKeys.join()}`).toBe(groupKeys.length)
      const keys = menus[1].entries.map(({ accessKey }) => accessKey)
      expect(keys.every((key) => key !== undefined), `${language}: ${keys.join()}`).toBe(true)
      expect(new Set(keys).size, `${language}: ${keys.join()}`).toBe(keys.length)
    }
    setLanguage('ja')
  })

  it('File の項目が発注書のとおり', () => {
    const commands = groups[0].entries.map(({ command }) => command)
    expect(commands).toEqual(['open', undefined, 'save', 'saveAs', 'exit'])
  })

  it('保存の入口が押せる', () => {
    const save = groups[0].entries.find(({ command }) => command === 'save')
    expect(save?.enabled).toBe(true)
  })

  it('テーマと言語は今の値に印が付く', () => {
    const [language, dark, light] = groups[2].entries
    expect(dark.checked).toBe(false)
    expect(light.checked).toBe(true)
    expect(language.children?.map(({ checked }) => checked)).toEqual([true, false])
  })

  it('右端で折り返すはチェックの項目で、今の値に印が付く', () => {
    const find = (wrapLines: boolean) =>
      buildMenus({ language: 'ja', theme: 'light', recent: [], ...state, wrapLines })[2].entries.find(
        ({ command }) => command === 'wrapLines'
      )
    expect(find(false)?.role).toBe('menuitemcheckbox')
    expect(find(false)?.checked).toBe(false)
    expect(find(true)?.checked).toBe(true)
    expect(find(true)?.label).toBe('右端で折り返す(W)')
  })

  it('ツリーのときは左ペインを出さないはチェックの項目で、今の値に印が付く（D13）', () => {
    const find = (hideTargetsInTree: boolean) =>
      buildMenus({ language: 'ja', theme: 'light', recent: [], ...state, hideTargetsInTree })[2].entries.find(
        ({ command }) => command === 'hideTargetsInTree'
      )
    expect(find(false)?.role).toBe('menuitemcheckbox')
    expect(find(false)?.checked).toBe(false)
    expect(find(true)?.checked).toBe(true)
    expect(find(true)?.label).toBe('ツリーのときは左ペインを出さない(P)')
    expect(find(true)?.accessKey).toBe('P')
  })

  it('Options の最後に翻訳の設定の入口があり、設定の口が無ければ押せない', () => {
    const find = (translationSettings: boolean) =>
      buildMenus({ language: 'ja', theme: 'light', recent: [], ...state, translationSettings })[2].entries.at(-1)
    expect(find(true)?.command).toBe('translationSettings')
    expect(find(true)?.label).toBe('翻訳の設定(R)...')
    expect(find(true)?.enabled).toBe(true)
    expect(find(true)?.separatorBefore).toBe(true)
    expect(find(false)?.enabled).toBe(false)
  })

  it('Options のアクセスキーが重ならない', () => {
    for (const language of ['ja', 'en']) {
      setLanguage(language)
      const keys = buildMenus({ language, theme: 'light', recent: [], ...state, splashCeremonyUnlocked: true })[2].entries.map(
        ({ accessKey }) => accessKey
      )
      expect(new Set(keys).size, `${language}: ${keys.join()}`).toBe(keys.length)
    }
    setLanguage('ja')
  })
})
