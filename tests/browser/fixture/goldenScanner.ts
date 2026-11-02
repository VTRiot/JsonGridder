// 実 Chromium の試験でファイルの核の検査の代わりに使う。結果は表から引く。
// 同じ表を核の試験が読み、全行を検査するので、表と実物は食い違わない。
import type { JsonScanner, ScanResult } from '../../../src/document/backend'
import golden from '../../fixtures/scan-golden.json'

const results = new Map(
  (golden as { input: string; result: ScanResult }[]).map(({ input, result }) => [input, result])
)

export const goldenScanner: JsonScanner = {
  async scan(text) {
    const result = results.get(text)
    if (result === undefined) {
      // 試験の書き間違いを素通りさせない。使う入力は表へ行を足す
      throw new Error(`not in the scan table: ${text.slice(0, 80)}`)
    }
    return result
  }
}
