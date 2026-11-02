// 設定が無いときの言語は英語。起動の直後に日本語が一瞬出ないよう、画面の初期値も英語に揃える。
// 他の試験は設定で ja を選んだ状態で回るので、ここでは辞書のモジュールを読み直して初期値を見る。
import { describe, expect, it, vi } from 'vitest'
import en from '../../src/i18n/en.json'
import { createDetachedPorts } from '../../src/shell/ports'
import indexSource from '../../index.html?raw'
import splashSource from '../../splash.html?raw'

const htmlLanguage = (source: string) => /<html\s+lang="([^"]*)"/.exec(source)?.[1]

describe('既定の言語', () => {
  it('設定を読む前の言語は英語', async () => {
    vi.resetModules()
    const fresh = await import('../../src/i18n')
    expect(fresh.BASE_LANGUAGE).toBe('en')
    expect(fresh.currentLanguage()).toBe('en')
    expect(fresh.t('app.notice.settingsUnwritable')).toBe(en['app.notice.settingsUnwritable'])
  })

  it('主画面と起動画面の文書の言語は英語', () => {
    expect(htmlLanguage(indexSource)).toBe('en')
    expect(htmlLanguage(splashSource)).toBe('en')
  })

  it('殻の外で立てたときの設定も英語', async () => {
    const startup = await createDetachedPorts().getStartup()
    expect(startup.language).toBe('en')
  })
})
