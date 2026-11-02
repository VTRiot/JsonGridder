// 配布物の表記が食い違わないことを見張る。版は package.json、Cargo.toml、tauri.conf.json の 3 か所。
import { describe, expect, it } from 'vitest'
import packageSource from '../../package.json?raw'
import tauriSource from '../../src-tauri/tauri.conf.json?raw'
import cargo from '../../src-tauri/Cargo.toml?raw'

const pkg = JSON.parse(packageSource)
const tauri = JSON.parse(tauriSource)
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
