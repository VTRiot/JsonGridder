import type { Content } from '$lib/types'
import type { EditorHandle } from '../editor/mount'
import { chooseView } from '../shell/tableTargets'
import type { Indent, SizeClass, TextFormat } from './backend'

/** 文書モデルがエディタに頼むことの全部。`onChange` の中から呼ばない。 */
export interface EditorPort {
  /** 遅延中の入力と編集中のセルを文書へ確定する。同期で終わる。 */
  commitPending(): void
  current(): Content
  /** モーダルが開いている間は文書を替えない。 */
  hasOpenModal(): boolean
  /** テキストの表示が文書を書き出すときの書式。文書を替える前に渡す。 */
  applyFormat(format: TextFormat | undefined): void
  /** 文書を置き換える。表示は文書から選ぶ。 */
  replace(text: string, options: { textOnly: boolean; sizeClass: SizeClass }): void
}

const OPEN_MODAL = 'dialog[open]'

/** CodeMirror の字下げの単位。空は受け付けないので、字下げの無い文書は既定に任せる。 */
function indentationUnit(indent: Indent | undefined): number | string | undefined {
  switch (indent?.kind) {
    case 'spaces':
      return indent.count
    case 'tab':
      return '\t'
    default:
      return undefined
  }
}

export function createEditorPort(editor: EditorHandle, root: HTMLElement): EditorPort {
  return {
    commitPending: () => editor.commitPendingInput(),
    current: () => editor.get(),
    hasOpenModal: () => root.querySelector(OPEN_MODAL) !== null,
    applyFormat(format) {
      editor.setDocumentFormat(format)
      editor.updateProps({ indentation: indentationUnit(format?.indent) })
    },
    replace(text, options) {
      // 文書は開くときに検査済みなので、切り替えの門番を通さない。
      // 必ず表示を選ぶので、10 MB を超える文書が今の表示のままテキストへ入らない
      editor.set({ text }, chooseView(text, options, editor.parse))
    }
  }
}
