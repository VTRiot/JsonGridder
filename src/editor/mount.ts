import { flushSync, mount, unmount } from 'svelte'
import type { JSONPath } from 'immutable-json-patch'
import { JsonEditor } from '$lib/index-vanilla'
import { jsonQueryLanguage } from '$lib/plugins/query/jsonQueryLanguage'
import { withLiteralNumbers } from '$lib/plugins/query/preserveNumbers'
import {
  Mode,
  type Content,
  type ContentErrors,
  type EditCommand,
  type JSONEditorPropsOptional,
  type JSONEditorSelection,
  type JSONParser,
  type JSONPatchResult,
  type TableTargetChange
} from '$lib/types'
import type { JSONPatchDocument } from 'immutable-json-patch'
import type { JsonScanner, TextFormat } from '../document/backend'
import { writeDocument, type Stringify } from '../document/serialize'
import { t } from '../i18n'
import { catchUnhandledErrors } from './errors'
import { createModeGuard, TEXT_MODE_LIMIT_BYTES } from './modeGuard'
import { createNotice } from './notice'
import { strictParser } from './parser'

export interface EditorView {
  mode: Mode
  tableTarget: JSONPath
}

interface RawEditor
  extends Omit<EditorHandle, 'destroy' | 'set' | 'parse' | 'notify' | 'view' | 'setTableTarget' | 'setDocumentFormat' | 'probeMode'> {
  set(content: Content, options?: { mode?: Mode; tableTarget?: JSONPath }): void
}

/** `onChange` の中から同期で呼ばない。公開の口は画面の更新を強制する。 */
export interface EditorHandle {
  get(): Content
  /** `mode` を渡すと、その表示で開く。門番を通らないので、文書を検査した呼び手だけが使う。 */
  set(content: Content, options?: Partial<EditorView>): void
  patch(operations: JSONPatchDocument): JSONPatchResult
  /** 確定前の入力を文書へ入れる。同期で終わり、窓のフォーカスに関わらない。 */
  commitPendingInput(): void
  select(selection: JSONEditorSelection | undefined): void
  focus(): void
  validate(): ContentErrors | undefined
  updateProps(props: JSONEditorPropsOptional): void
  /** エディタと同じパーサ。同じ文字列を続けて読むと、前の結果を返す。文書は不変で扱う。 */
  parse(text: string): unknown
  /** テキストの表示が文書を書き出すときの書式。無ければ上流の動作のまま。 */
  setDocumentFormat(format: TextFormat | undefined): void
  /** 画面の下の帯に文言を出す。 */
  notify(message: string): void
  view(): EditorView
  /** 確定前の入力を今の対象へ入れてから、表の対象を替える。 */
  setTableTarget(path: JSONPath): void
  /**
   * 今の文書が `target` の表示へ入れるかを、切り替えの門番と同じ検査で見る。知らせは出さず、表示も替えない。
   * 画面の補助（ボタンを押せるか）のためだけに使う。切り替えの守りは門番が持つ。
   */
  probeMode(target: Mode): boolean | Promise<boolean>
  /**
   * 編集の命令（Edit メニュー）を、今の表示の右クリックとキーと同じ関数で走らせる。門番の答えを
   * 待つ間は走らせず false。テキストの表示は findReplace だけで、切り取り、コピー、貼り付けは
   * 呼び手が CodeMirror へ直接行う。
   */
  runEditCommand(command: EditCommand): boolean
  destroy(): Promise<void>
}

export interface EditorServices {
  /** 開くときと同じ検査。表示の切り替えの門番が使う。 */
  scanner?: JsonScanner
  /** 表示か表の対象が変わった。エディタが自分で対象を動かしたときは `reason` が付く。 */
  onViewChange?(reason?: TableTargetChange): void
}

interface DocumentParser extends JSONParser {
  setFormat(format: TextFormat | undefined): void
}

/**
 * 直前の 1 組を覚える。開くときの表示の選択とエディタで 100 MB を 2 回読まないため。
 *
 * 字下げを付けて書く呼び出しは、開いた文書の書式で書く（I5）。表で編集した文書をテキストの表示へ
 * 移すと、この字面がそのまま `{text}` になる。ただし読んだばかりの値を書くのは利用者の「整形」なので、
 * 渡された字下げに従う。字下げの無い文書でも整形が効く。
 */
function documentParser(parser: JSONParser): DocumentParser {
  let last: { text: string; value: unknown } | undefined
  let format: TextFormat | undefined
  return {
    setFormat(next) {
      format = next
    },
    stringify(value, replacer, space) {
      const reformatting = last !== undefined && last.value === value
      if (format === undefined || replacer != null || space === undefined || space === null || reformatting) {
        return parser.stringify(value, replacer, space)
      }
      return writeDocument(value, format, parser.stringify as Stringify)
    },
    parse(text: string) {
      if (last?.text !== text) {
        last = { text, value: parser.parse(text) }
      }
      return last.value
    }
  }
}

/**
 * エディタを target に作る。製品の既定は `props` で上書きできる。
 *
 * 上流の createJSONEditor は返す前に destroy を代入する。開発用のコンパイルでは
 * コンポーネントの export が getter だけになるので、この代入が例外になる。
 * 開発時と配布時で同じ経路にするため、mount を直接呼ぶ。
 */
export function mountEditor(
  target: HTMLElement,
  props: JSONEditorPropsOptional,
  { scanner, onViewChange }: EditorServices = {}
): EditorHandle {
  const notice = createNotice(target)
  const report = (error: Error): void => {
    console.error(error)
    notice.show(t('app.notice.error').replace('{{message}}', () => error.message))
  }
  const stopCatching = catchUnhandledErrors(report)
  const parser = documentParser(props.parser ?? strictParser)
  const view: EditorView = { mode: props.mode ?? Mode.tree, tableTarget: props.tableTarget ?? [] }
  // 門番と同じ検査を、知らせを出さずに走らせる。押せるかの表示だけに使う
  const quietGuard = createModeGuard({ parser, scanner, notify: () => {} })

  // 無いときは上流の動作のまま。案内の画面の Edit はモーダルを開く
  const viewProps: JSONEditorPropsOptional = onViewChange
    ? {
        onChangeMode(mode) {
          view.mode = mode
          props.onChangeMode?.(mode)
          onViewChange()
        },
        onChangeTableTarget(path, reason) {
          view.tableTarget = path
          props.onChangeTableTarget?.(path, reason)
          onViewChange(reason)
        }
      }
    : {}

  const editor = mount(JsonEditor, {
    target,
    props: {
      askToFormat: false,
      allowExtract: false,
      maxDocumentSizeTextMode: TEXT_MODE_LIMIT_BYTES,
      queryLanguages: [withLiteralNumbers(jsonQueryLanguage)],
      modeGuard: createModeGuard({ parser, scanner, notify: notice.show }),
      onError: report,
      ...props,
      ...viewProps,
      parser
    }
  }) as unknown as RawEditor
  flushSync()

  return {
    get: () => editor.get(),
    set(content, { mode, tableTarget = [] } = {}) {
      editor.set(content, { mode, tableTarget })
      view.mode = mode ?? view.mode
      view.tableTarget = tableTarget
      onViewChange?.()
    },
    patch: (operations) => editor.patch(operations),
    commitPendingInput: () => editor.commitPendingInput(),
    select: (selection) => editor.select(selection),
    focus: () => editor.focus(),
    validate: () => editor.validate(),
    updateProps(next) {
      editor.updateProps(next)
      flushSync()
    },
    parse: (text) => parser.parse(text),
    setDocumentFormat: parser.setFormat,
    notify: notice.show,
    view: () => ({ ...view }),
    setTableTarget(path) {
      editor.commitPendingInput()
      editor.updateProps({ tableTarget: path })
      flushSync()
      view.tableTarget = path
    },
    probeMode: (target) => quietGuard(target, editor.get()),
    runEditCommand: (command) => editor.runEditCommand(command),
    async destroy() {
      stopCatching()
      notice.destroy()
      await unmount(editor)
    }
  }
}
