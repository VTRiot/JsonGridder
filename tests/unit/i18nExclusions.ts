// 辞書に載せない文字列の除外表。各行に理由を書く。
export interface Exclusion {
  kind: 'svelte' | 'engine'
  /** 取り込んだエディタの lib からのパスの末尾 */
  file: string
  text: string
  reason: string
}

export const EXCLUSIONS: Exclusion[] = [
  {
    kind: 'svelte',
    file: 'TableModeWelcome.svelte',
    text: 'Ctrl+V',
    reason: 'キーの名前。どの言語でもキーボードの刻印と同じ表記を使う'
  },
  {
    kind: 'svelte',
    file: 'Welcome.svelte',
    text: 'Ctrl+V',
    reason: 'キーの名前。どの言語でもキーボードの刻印と同じ表記を使う'
  },
  {
    kind: 'svelte',
    file: 'JSONNode.svelte',
    text: '&nbsp;',
    reason: 'HTML の文字参照。見える文字は空白で、言語に依らない'
  },
  {
    kind: 'svelte',
    file: 'JSONNode.svelte',
    text: '&lbrace;',
    reason: 'HTML の文字参照。JSON の記号の括弧で、言語に依らない'
  },
  {
    kind: 'svelte',
    file: 'JSONNode.svelte',
    text: '&rbrace;',
    reason: 'HTML の文字参照。JSON の記号の括弧で、言語に依らない'
  }
]

/**
 * 画面に出るが辞書に載せられない文言（表の検査では捕まらないもの）。理由は報告書にも写す。
 */
export const KNOWN_UNTRANSLATED: { where: string; reason: string }[] = [
  {
    where: 'svelte-select の "No options"（node_modules）',
    reason: '依存パッケージ内の文言で、差し替える口が無い。選択肢が空のときだけ出る。製品の画面では選択肢が必ずある'
  },
  {
    where: 'エンジンのエラー文（jsonrepair、lossless-json、Ajv、JSON Query の構文エラー）',
    reason: '依存パッケージが投げる例外の文。文書の内容を示す診断で、翻訳の口が無い。上流も英語のまま出す'
  },
  {
    where: 'メニューの言語名 English、日本語',
    reason: '言語の自称（エンドニム）。どちらの画面でも同じ表記にするのが慣例で、辞書には同じ値で載っている'
  }
]
