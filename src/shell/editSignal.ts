/** 文書の外の入力欄。ここだけを除く。知らない入力は印を立てる側へ倒す。 */
const OUTSIDE_DOCUMENT = '.jse-search-box, .cm-panels'
const CELL_EDITOR = '.jse-editable-div'

/** エディタが `preventDefault` して `input` を出さない編集の合図。 */
const EDIT_EVENTS = ['input', 'compositionstart', 'paste', 'cut', 'drop'] as const
/** 単独で編集になるキー。動くだけのときも立つが、余分な確認は安全側である。 */
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'Enter', 'Tab'])
/** Alt と組み合わせると行を動かすキー。 */
const LINE_MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown'])
/** Ctrl と組み合わせても文書を変えない文字。全選択、写す、検索と置換の欄、行へ移動、開く、保存。 */
const READ_ONLY_CHORDS = new Set(['a', 'c', 'f', 'h', 'g', 'o', 's'])

const isCharacterKey = (event: KeyboardEvent): boolean =>
  event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey

/** 知らない組み合わせは編集に倒す。 */
function isEditKey(event: KeyboardEvent): boolean {
  if (EDIT_KEYS.has(event.key) || (event.altKey && LINE_MOVE_KEYS.has(event.key))) {
    return true
  }
  const chord = event.ctrlKey || event.metaKey
  return chord && event.key.length === 1 && !READ_ONLY_CHORDS.has(event.key.toLowerCase())
}

/**
 * 打鍵の時点で印を立てる。セルの編集中、IME の変換中、デバウンス中の text は `onChange` が来ない。
 * モーダルの中の打鍵も立てる。Apply の前でも、確認なしで閉じると編集を黙って失うためである。
 * Rust の閉じる判断は印だけを見るので、遅れて立つ印は無いのと同じである。
 *
 * 選んだセルへ打った 1 字は、編集欄を開く値になり `input` が来ない。文字のキーの直後に編集欄が
 * フォーカスを得たことで受ける。足せないセルは編集欄が開かないので、印は立たない。
 *
 * ここでは印を下ろさない。下ろすのは、保存が確定した中身を基準と比べて一致したときだけである。
 */
export function installEditSignal(root: HTMLElement, noteEdit: () => void): () => void {
  let characterDown = false

  const signal = (event: Event): void => {
    const { target } = event
    if (!(target instanceof Element) || target.closest(OUTSIDE_DOCUMENT) === null) {
      noteEdit()
    }
  }
  const trackKey = (event: KeyboardEvent): void => {
    characterDown = isCharacterKey(event)
    if (isEditKey(event)) {
      signal(event)
    }
  }
  const releaseKey = (): void => {
    characterDown = false
  }
  const signalOpenedEditor = (event: FocusEvent): void => {
    if (characterDown && event.target instanceof Element && event.target.closest(CELL_EDITOR) !== null) {
      noteEdit()
    }
  }

  for (const type of EDIT_EVENTS) {
    root.addEventListener(type, signal, true)
  }
  root.addEventListener('keydown', trackKey, true)
  root.addEventListener('keyup', releaseKey, true)
  root.addEventListener('focusin', signalOpenedEditor, true)
  return () => {
    for (const type of EDIT_EVENTS) {
      root.removeEventListener(type, signal, true)
    }
    root.removeEventListener('keydown', trackKey, true)
    root.removeEventListener('keyup', releaseKey, true)
    root.removeEventListener('focusin', signalOpenedEditor, true)
  }
}
