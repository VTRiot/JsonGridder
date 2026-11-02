import { describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { format, t } from '../../src/i18n'
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
  it('ルートの配列は表、対象なし', () => {
    expect(open('[1]')).toEqual({ mode: Mode.table, tableTarget: [] })
  })

  it('ルートのオブジェクトは候補の先頭を対象に表', () => {
    expect(open('{"a":{"rows":[{"x":1}]}}')).toEqual({ mode: Mode.table, tableTarget: ['a', 'rows'] })
  })

  it('候補が無いオブジェクトと値はツリー', () => {
    expect(open('{"a":[]}').mode).toBe(Mode.tree)
    expect(open('1').mode).toBe(Mode.tree)
  })

  it('テキストに限る文書はテキスト', () => {
    expect(open('{', 'allModes', true).mode).toBe(Mode.text)
  })

  it('10 MB 超の文書はテキストへ入らない', () => {
    expect(open('[1]', 'noTextMode').mode).toBe(Mode.table)
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
  const state = { splashCeremony: false, splashCeremonyUnlocked: false, wrapLines: false }
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

  it('3 つのメニューが辞書から作られる', () => {
    expect(groups.map(({ accessKey }) => accessKey)).toEqual(['F', 'O', 'H'])
    expect(groups.flatMap(({ entries }) => entries).every(({ label }) => !label.startsWith('app.'))).toBe(true)
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
    const [language, dark, light] = groups[1].entries
    expect(dark.checked).toBe(false)
    expect(light.checked).toBe(true)
    expect(language.children?.map(({ checked }) => checked)).toEqual([true, false])
  })

  it('右端で折り返すはチェックの項目で、今の値に印が付く', () => {
    const find = (wrapLines: boolean) =>
      buildMenus({ language: 'ja', theme: 'light', recent: [], ...state, wrapLines })[1].entries.find(
        ({ command }) => command === 'wrapLines'
      )
    expect(find(false)?.role).toBe('menuitemcheckbox')
    expect(find(false)?.checked).toBe(false)
    expect(find(true)?.checked).toBe(true)
    expect(find(true)?.label).toBe('右端で折り返す(W)')
  })
})
