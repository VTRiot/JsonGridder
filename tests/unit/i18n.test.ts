import { describe, expect, test } from 'vitest'
import {
  currentLanguage,
  editorLanguage,
  registerDictionary,
  setLanguage,
  subscribeLanguage,
  t,
  toEditorLanguage,
  translate,
  unregisterDictionary
} from '../../src/i18n'
import en from '../../src/i18n/en.json'
import ja from '../../src/i18n/ja.json'

describe('アプリの文言', () => {
  test('現在の言語の値を返す', () => {
    expect(translate('a', { a: '今の言語' }, { a: '既定' })).toBe('今の言語')
  })

  test('現在の言語に無いキーは既定の言語へ落ちる', () => {
    expect(translate('a', {}, { a: '既定' })).toBe('既定')
  })

  test('どの言語にも無いキーはキー名を返す', () => {
    expect(translate('no.such.key', {}, {})).toBe('no.such.key')
  })

  test('空の値と文字列でない値は欠けとして扱う', () => {
    expect(translate('a', { a: '' }, { a: '既定' })).toBe('既定')
    expect(translate('a', { a: 1 }, {})).toBe('a')
  })

  test('Object の組み込みの名前をキーとして拾わない', () => {
    expect(translate('constructor', {}, {})).toBe('constructor')
  })

  test('既定の辞書から引ける', () => {
    expect(t('app.title')).toBe('JsonGridder')
  })
})

describe('エディタへの変換', () => {
  test('editor. の付くキーだけを、接頭辞を外して渡す', () => {
    const language = toEditorLanguage({ 'editor.cancel': '取消', 'app.title': 'x' }, 'ja')
    expect(language).toEqual({ langCode: 'ja', values: { cancel: '取消' } })
  })

  test('空の値は渡さず、エディタの既定へ任せる', () => {
    const language = toEditorLanguage({ 'editor.cancel': '', 'editor.ok': 'OK' }, 'ja')
    expect(language.values).toEqual({ ok: 'OK' })
  })

  test('__proto__ のキーで Object.prototype を汚さない', () => {
    const dictionary = JSON.parse('{"editor.__proto__":"x"}') as Record<string, unknown>
    const language = toEditorLanguage(dictionary, 'ja')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(Object.getPrototypeOf(language.values)).toBe(Object.prototype)
  })

  test('辞書から 3 つの表示の名前が届く', () => {
    setLanguage('ja')
    expect(editorLanguage().values).toMatchObject({
      modeText: ja['editor.modeText'],
      modeTree: ja['editor.modeTree'],
      modeTable: ja['editor.modeTable']
    })
  })
})

describe('言語の切り替え', () => {
  const dummy = { 'app.title': 'ダミー言語のタイトル', 'editor.cancel': 'ダミー取消', 'cm.Find': 'ダミー検索' }

  test('辞書を 1 つ足して言語を替えるだけで、アプリとエディタの文言が替わる', () => {
    registerDictionary('xx', dummy)
    try {
      setLanguage('xx')
      expect(currentLanguage()).toBe('xx')
      expect(t('app.title')).toBe('ダミー言語のタイトル')
      expect(editorLanguage().values).toMatchObject({ cancel: 'ダミー取消' })
      expect(editorLanguage().phrases).toEqual({ Find: 'ダミー検索' })
    } finally {
      setLanguage('ja')
      unregisterDictionary('xx')
    }
  })

  test('足した辞書に無いキーは基準の言語の英語へ落ちる', () => {
    registerDictionary('xx', dummy)
    try {
      setLanguage('xx')
      expect(t('app.menu.file')).toBe(en['app.menu.file'])
    } finally {
      setLanguage('ja')
      unregisterDictionary('xx')
    }
  })

  test('登録の無い言語は英語として動く', () => {
    setLanguage('zz')
    expect(t('app.menu.file')).toBe(en['app.menu.file'])
    setLanguage('ja')
  })

  test('ja と en の切り替えで、同じキーが別の文言になる', () => {
    setLanguage('en')
    const english = t('app.dialog.dontSave')
    setLanguage('ja')
    const japanese = t('app.dialog.dontSave')
    expect(english).toBe("Don't Save")
    expect(japanese).toBe('保存しない')
  })

  test('切り替えを購読者へ知らせる', () => {
    let notified = 0
    const stop = subscribeLanguage(() => notified++)
    setLanguage('en')
    setLanguage('ja')
    stop()
    setLanguage('en')
    setLanguage('ja')
    expect(notified).toBe(2)
  })

  test('エディタへ CodeMirror の phrase が届く', () => {
    setLanguage('ja')
    expect(editorLanguage().phrases).toMatchObject({ 'Fold line': ja['cm.Fold line'] })
  })

  test('JSON の中身の語は辞書を通らない（キー名の Sort は Sort のまま）', () => {
    setLanguage('ja')
    expect(t('Sort')).toBe('Sort')
    expect(t('editor.sort')).toBe(ja['editor.sort'])
  })
})

describe('辞書ファイル', () => {
  test('値はすべて空でない文字列', () => {
    for (const [key, value] of Object.entries(ja)) {
      expect(typeof value, key).toBe('string')
      expect(value, key).not.toBe('')
    }
  })
})
