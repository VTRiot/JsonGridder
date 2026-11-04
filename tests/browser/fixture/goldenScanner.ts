// 実 Chromium の試験でファイルの核の検査の代わりに使う。結果は表から引く。
// 同じ表を核の試験が読み、全行を検査するので、表と実物は食い違わない。
import type { Diagnosis, JsonDiagnoser, JsonScanner, ScanResult } from '../../../src/document/backend'
import golden from '../../fixtures/scan-golden.json'

const rows = golden as { input: string; result: ScanResult; diagnosis: Diagnosis | null }[]
const results = new Map(rows.map(({ input, result }) => [input, result]))
const diagnoses = new Map(rows.map(({ input, diagnosis }) => [input, diagnosis]))

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

/** 警告の帯の理由。表に無い入力は失敗にする（帯は総称の文言になる）。 */
export const goldenDiagnoser: JsonDiagnoser = {
  async diagnose(text) {
    const diagnosis = diagnoses.get(text)
    if (diagnosis === undefined) {
      throw new Error(`not in the scan table: ${text.slice(0, 80)}`)
    }
    return diagnosis
  }
}
