// 取り込んだソースの文言の誤りを直したことの固定（step5_001 の 5）。空白は 1 つに畳んで比べる。
import { describe, expect, test } from 'vitest'

const sources = import.meta.glob(
  [
    '../../vendor/svelte-jsoneditor/src/lib/components/modes/**/*.svelte',
    '../../vendor/svelte-jsoneditor/src/lib/components/modes/**/contextmenu/*.ts'
  ],
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

function source(suffix: string): string {
  const file = Object.keys(sources).find((name) => name.endsWith(suffix))
  expect(file, suffix).toBeDefined()
  return sources[file as string].replace(/\s+/g, ' ')
}

describe('取り込んだソースの文言の誤りの修正', () => {
  test('表の案内の「ツリーへ」のボタンは switchToTreeMode を引く', () => {
    const welcome = source('/tablemode/TableModeWelcome.svelte')
    expect(welcome).toContain("onChangeMode(Mode.tree)}> {$t('switchToTreeMode')}")
    expect(welcome).not.toContain('switchToTextMode')
  })

  test('ツリーの右クリックの「切り取り（圧縮）」は cutCompacted を引く', () => {
    const items = source('/contextmenu/createTreeContextMenuItems.ts')
    expect(items).toContain("text: tString('cutCompacted'), title: `${tString('cutCompactedTitle')}")
  })

  test('ツリーの右クリックの「コピー（整形）」は copyFormatted を引く', () => {
    const items = source('/contextmenu/createTreeContextMenuItems.ts')
    expect(items).toContain("text: tString('copyFormatted'), title: `${tString('copyWithIndent')}")
  })

  test('ツリーの複数行貼り付けの「そのままにする」の title は leaveAsIsTitle を引かない', () => {
    const tree = source('/treemode/TreeMode.svelte')
    expect(tree).toContain("title: $t('keepThePastedArray'), onClick: handleClearPastedMultilineText")
  })

  test('表の右クリックの「整形してコピー」は onCopy(true) を、「圧縮してコピー」は onCopy(false) を呼ぶ', () => {
    const items = source('/contextmenu/createTableContextMenuItems.ts')
    expect(items).toMatch(/text: tString\('copyFormatted'\),[^}]{0,120}onClick: \(\) => onCopy\(true\)/)
    expect(items).toMatch(/text: tString\('copyCompacted'\),[^}]{0,120}onClick: \(\) => onCopy\(false\)/)
  })
})
