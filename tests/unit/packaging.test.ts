// 配布物の表記が食い違わないことを見張る。版は package.json、Cargo.toml、tauri.conf.json の 3 か所。
import { describe, expect, it } from 'vitest'
import packageSource from '../../package.json?raw'
import tauriSource from '../../src-tauri/tauri.conf.json?raw'
import cargo from '../../src-tauri/Cargo.toml?raw'

const pkg = JSON.parse(packageSource)
const tauri = JSON.parse(tauriSource)

/** Tauri の権限の設定の全部。 */
const capabilities = import.meta.glob('../../src-tauri/capabilities/*.json', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** WebView で動く原文の全部（殻と取り込んだエディタ、入口の HTML）。.bak は拾わない。 */
const webSources = import.meta.glob(
  ['../../src/**/*.{ts,svelte}', '../../vendor/svelte-jsoneditor/src/lib/**/*.{ts,svelte}', '../../*.html'],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

/** Rust の原文の全部。 */
const rustSources = import.meta.glob('../../src-tauri/src/**/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

/** WebView で許す通信の先。Tauri の IPC だけ。 */
const IPC_ONLY = 'ipc: http://ipc.localhost'

/** 翻訳の宛先。Rust の側だけが持つ。 */
const GEMINI_HOST = 'generativelanguage.googleapis.com'

/** WebView に外への通信の手段を与えるプラグイン。 */
const NETWORK_PLUGINS = ['plugin-http', 'plugin-opener', 'plugin-shell', 'plugin-websocket', 'plugin-upload']

/** WebView から外へ出る API。 */
const NETWORK_APIS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/

/** 注釈の行（`//`、`/*`、`*` で始まる行）。上流の注釈の使い方の例（`fetch(uri)`）を拾わない。 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/

function codeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => !COMMENT_LINE.test(line))
}

function dependencyNames(): string[] {
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
}
const cargoValue = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(cargo)?.[1]

describe('配布物の表記', () => {
  it('版が 3 か所で一致する', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(cargoValue('version')).toBe(pkg.version)
    expect(tauri.version).toBe(pkg.version)
  })

  it('作者とライセンスと著作権が揃っている', () => {
    expect(tauri.bundle.publisher).toBe('VTRiot')
    expect(pkg.author).toBe(tauri.bundle.publisher)
    expect(cargo).toContain(`authors = ["${tauri.bundle.publisher}"]`)
    expect(pkg.license).toBe('MIT')
    expect(cargoValue('license')).toBe('MIT')
    expect(tauri.bundle.copyright).toBe(`Copyright (c) 2026 ${tauri.bundle.publisher}`)
  })

  it('単体の EXE だけを作り、インストーラーを作らない', () => {
    expect(tauri.bundle.active).toBe(false)
    expect(tauri.bundle.targets).toBeUndefined()
    expect(tauri.bundle.windows).toBeUndefined()
    expect(`${tauri.productName}.exe`).toBe(`${tauri.mainBinaryName}.exe`)
  })
})

// 画像は同梱のファイルだけ。lint の印は CSS で描くので data: の画像を許さない（B68、theme.css）
describe('CSP の画像', () => {
  it("img-src は 'self' だけ", () => {
    expect(tauri.app.security.csp['img-src']).toBe("'self'")
  })
})

// 翻訳の通信は Rust の側だけが行う（Step10-002 計画「CSP と Tauri の権限」、危険 R6、R8）
describe('network stays in rust', () => {
  it('CSP の connect-src は IPC だけで、既定は何も許さない', () => {
    const csp = tauri.app.security.csp
    expect(csp['connect-src']).toBe(IPC_ONLY)
    expect(csp['default-src']).toBe("'none'")
    expect(JSON.stringify(tauri)).not.toContain(GEMINI_HOST)
  })

  it('Tauri の権限は空', () => {
    const files = Object.keys(capabilities)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(JSON.parse(capabilities[file]).permissions, file).toEqual([])
    }
  })

  it('外へ通信するプラグインを依存に持たない', () => {
    for (const plugin of NETWORK_PLUGINS) {
      expect(cargo, plugin).not.toContain(`tauri-${plugin}`)
      expect(dependencyNames().filter((name) => name.includes(plugin)), plugin).toEqual([])
    }
  })

  it('WebView の原文に外へ出る API が無い', () => {
    const files = Object.keys(webSources)
    expect(files.some((file) => file.startsWith('../../src/shell/'))).toBe(true)
    expect(files.some((file) => file.startsWith('../../vendor/'))).toBe(true)
    const found = files.flatMap((file) =>
      codeLines(webSources[file])
        .filter((line) => NETWORK_APIS.test(line))
        .map((line) => `${file}: ${line.trim()}`)
    )
    expect(found).toEqual([])
  })

  it('翻訳の宛先は Rust だけが持つ', () => {
    const web = Object.keys(webSources).filter((file) => webSources[file].includes(GEMINI_HOST))
    expect(web).toEqual([])
    const rust = Object.keys(rustSources).filter((file) => rustSources[file].includes(GEMINI_HOST))
    expect(rust).toEqual(['../../src-tauri/src/translate/gemini.rs'])
  })
})
