import type { ExternalFiles, TextEditorReply } from '../document/backend'
import type { DocumentModel, OpenOutcome } from '../document/model'
import { format, t } from '../i18n'
import type { OpenFlowCall } from './openFlow'
import type { ShellPorts } from './ports'
import type { SaveDestination, SaveResult } from './saveFlow'

const RELOAD_BUTTON = 0
const KEEP_BUTTON = 1
const SAVE_AND_OPEN_BUTTON = 0
const OPEN_WITHOUT_SAVING_BUTTON = 1
const CANCEL_TEXT_EDITOR_BUTTON = 2

export interface ExternalFlowOptions {
  model: Pick<DocumentModel, 'baseline' | 'dirty' | 'busy' | 'editEpoch' | 'revision'>
  external: ExternalFiles
  ask: ShellPorts['ask']
  notify(message: string): void
  hasOpenModal(): boolean
  /**
   * 開く処理か保存の 1 関数が、確認（文字コード、サイズ、外の変更の上書きなど）を含めて途中か。
   * 確認の間は文書モデルの処理が止まっているので、`model.busy` だけでは見えない。
   */
  flowBusy(): boolean
  /** 既存の開く処理（`createOpenFlow` の 1 関数）。読み直しはこれだけを通す。 */
  open(path: string, call: OpenFlowCall): Promise<OpenOutcome>
  /** 既存の保存の 1 関数。 */
  save(destination: SaveDestination): Promise<SaveResult>
  /**
   * 読み直しの直前の表示（表示と表の対象）を覚え、読み直しが済んだ後に呼ぶ関数を返す。
   * 返した関数は、新しい文書でも前の表示が使えるときだけ戻す。戻す経路は表示の切り替えと同じ（門番を通る）。
   */
  captureView?(): () => void
}

export interface ExternalFlow {
  /** 窓に戻ったときの外の変更の見張り。途中なら何もしない（次の `focus` で見る）。 */
  check(): Promise<void>
  /** Edit の「テキストで開く」。 */
  openInTextEditor(): Promise<void>
}

/**
 * 外のアプリとの間の流れ（D5）。
 * - 外の変更: 未保存が無ければ読み直し、あれば聞く。読み直しは既存の開く処理だけを通るので、読み込みの間の
 *   打鍵は開く処理の `NeedsUnsavedDecision` が守り、不正になった文書はテキストで開く（D6）。
 * - テキストで開く: 未保存があれば先に聞く。保存して開くは保存が済んだときだけ開く。
 * 保存の安全は保存直前の照合（Rust）が持つ。ここは「聞くかどうか」だけを決める。
 */
export function createExternalFlow(options: ExternalFlowOptions): ExternalFlow {
  const { model, external, ask, notify, hasOpenModal, flowBusy, open, save, captureView } = options
  let running = false
  /** 残すを選んだ外の変更（`revision:sha256`）。同じ変更では 2 度聞かない。 */
  let kept: string | undefined
  /** 消えたと知らせた版。同じ版では 2 度知らせない。 */
  let missingTold: number | undefined

  const idle = (): boolean => !hasOpenModal() && !model.busy && !flowBusy()

  /**
   * 読み直しを試した結果を受ける。開けなかった（読めない、断られた、確認で取り消した）変更は覚えて、
   * 窓に戻るたびに同じ失敗や確認を繰り返さない。打鍵で止まったとき（聞く流れへ移る）と、ほかの処理の途中で
   * 止まったとき（次の見張りでやり直す）は覚えない。
   */
  function settleReload(outcome: OpenOutcome, change: string, restoreView: (() => void) | undefined): void {
    if (outcome.kind === 'Opened') {
      // 開く処理は既定の表示（ツリー）で開く。前の表示が新しい文書でも使えるなら戻す
      restoreView?.()
      notify(t('app.notice.externalReloaded'))
    } else if (outcome.kind !== 'NeedsUnsavedDecision' && outcome.kind !== 'Blocked') {
      kept = change
    }
  }

  async function askReload(): Promise<boolean> {
    const answer = await ask({
      title: t('app.dialog.reloadTitle'),
      body: t('app.dialog.reloadBody'),
      level: 'warning',
      buttons: [t('app.dialog.reload'), t('app.dialog.keepMine')],
      // 既定とキャンセルは残す側。自分の編集を黙って捨てない
      default: KEEP_BUTTON,
      cancel: KEEP_BUTTON
    })
    return answer === RELOAD_BUTTON
  }

  /** 未保存があるときの読み直し。聞いている間に編集があれば読み直さず、次の見張りでもう一度聞く。 */
  async function reloadAfterAsking(path: string, revision: number, change: string): Promise<void> {
    const epoch = model.editEpoch
    const reload = await askReload()
    if (model.baseline?.revision !== revision) {
      return // 聞いている間に保存か開く処理があった。次の見張りで見直す
    }
    if (!reload) {
      kept = change
      return
    }
    if (model.editEpoch !== epoch || !idle()) {
      return
    }
    const restoreView = captureView?.()
    settleReload(await open(path, { discardConfirmed: true, askUnsaved: false }), change, restoreView)
  }

  async function checkNow(): Promise<void> {
    const base = model.baseline
    if (base === null || !idle()) {
      return
    }
    const { revision, path } = base
    const status = await external.diskStatus(revision)
    // 見ている間に保存、開く処理、モーダルがあれば、今回は何もしない
    if (model.baseline?.revision !== revision || !idle()) {
      return
    }
    switch (status.kind) {
      case 'Same':
      case 'Stale':
      case 'Unreadable':
        return
      case 'Missing':
        if (missingTold !== revision) {
          missingTold = revision
          notify(t('app.notice.externalMissing'))
        }
        return
      case 'Changed': {
        const change = `${revision}:${status.sha256}`
        if (kept === change) {
          return
        }
        if (model.dirty) {
          await reloadAfterAsking(path, revision, change)
          return
        }
        // 未保存が無い。確かめを付けずに開く。読み込みの間に打鍵があれば開く処理が止めて返す
        const restoreView = captureView?.()
        const outcome = await open(path, { askUnsaved: false })
        settleReload(outcome, change, restoreView)
        if (outcome.kind === 'NeedsUnsavedDecision' && model.baseline?.revision === revision) {
          await reloadAfterAsking(path, revision, change)
        }
        return
      }
      default:
        return status satisfies never
    }
  }

  function tellTextEditor(reply: TextEditorReply): void {
    switch (reply.kind) {
      case 'Opened':
      case 'Stale':
        return
      case 'SelfAssociated':
        notify(t('app.notice.textEditorSelf'))
        return
      case 'Missing':
        notify(t('app.notice.missing'))
        return
      case 'Failed':
        notify(format('app.notice.textEditorFailed', { code: String(reply.code) }))
        return
      default:
        return reply satisfies never
    }
  }

  return {
    async check() {
      if (running) {
        return
      }
      running = true
      try {
        await checkNow()
      } catch (error) {
        notify(format('app.notice.error', { message: String(error) }))
      } finally {
        running = false
      }
    },

    async openInTextEditor() {
      if (model.baseline === null || hasOpenModal() || running) {
        return
      }
      running = true // 聞いている間と保存の間は、外の変更の見張りを止める
      try {
        if (model.dirty) {
          const answer = await ask({
            title: t('app.dialog.textEditorTitle'),
            body: t('app.dialog.textEditorUnsavedBody'),
            level: 'warning',
            buttons: [t('app.dialog.saveAndOpen'), t('app.dialog.openWithoutSaving'), t('app.dialog.cancel')],
            default: SAVE_AND_OPEN_BUTTON,
            cancel: CANCEL_TEXT_EDITOR_BUTTON
          })
          if (answer === SAVE_AND_OPEN_BUTTON) {
            const result = await save('current')
            if (result !== 'saved' && result !== 'noChange') {
              return // 保存できなかった。開かない（I10）
            }
          } else if (answer !== OPEN_WITHOUT_SAVING_BUTTON) {
            return
          }
        }
        if (model.baseline === null) {
          return
        }
        tellTextEditor(await external.openInTextEditor(model.revision))
      } catch (error) {
        notify(format('app.notice.error', { message: String(error) }))
      } finally {
        running = false
      }
    }
  }
}
