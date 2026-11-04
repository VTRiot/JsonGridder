import type { DocumentModel, OpenOptions, OpenOutcome } from '../document/model'
import { format, t } from '../i18n'
import type { AskRequest, ShellPorts } from './ports'

const MEBIBYTE = 1024 * 1024
const FIRST_BUTTON = 0
const SECOND_BUTTON = 1

export interface OpenFlowOptions {
  model: DocumentModel
  ask: ShellPorts['ask']
  notify(message: string): void
  onOpened(): void
  /** 開く途中で未保存を見つけた。確認は Rust が出す。 */
  onUnsaved(path: string): void
  /** ファイルが無かった。履歴から外す。 */
  onMissing(path: string): void
}

export interface OpenFlowCall extends Pick<OpenOptions, 'discardConfirmed'> {
  /**
   * 未保存を見つけたときに Rust の確認（別のファイルを開く確認）を出すか。外の変更の読み直しは
   * 自分で聞くので false にし、`NeedsUnsavedDecision` を受け取る。
   */
  askUnsaved?: boolean
}

/** 2 つのボタンの確認。1 つ目を押したときだけ true。Esc と×は 2 つ目と同じ。 */
async function confirm(
  ask: ShellPorts['ask'],
  { title, body, accept, defaultCancel }: { title: string; body: string; accept: string; defaultCancel?: boolean }
): Promise<boolean> {
  const request: AskRequest = {
    title,
    body,
    level: 'warning',
    buttons: [accept, t('app.dialog.cancel')],
    default: defaultCancel ? SECOND_BUTTON : FIRST_BUTTON,
    cancel: SECOND_BUTTON
  }
  return (await ask(request)) === FIRST_BUTTON
}

function failureMessage(outcome: OpenOutcome): string | undefined {
  switch (outcome.kind) {
    case 'Blocked':
      return t(outcome.reason === 'modalOpen' ? 'app.notice.openBlockedModal' : 'app.notice.openBlockedBusy')
    case 'ReplaceFailed':
      return t('app.notice.replaceFailed')
    case 'Refused':
      return t(`app.notice.refused.${outcome.reason}`)
    case 'Denied':
      return t('app.notice.denied')
    case 'Missing':
      return t('app.notice.missing')
    case 'Locked':
      return t('app.notice.locked')
    case 'Failed':
      return format('app.notice.failed', { code: String(outcome.code) })
    default:
      return undefined
  }
}

/** 全部の入口が通る 1 関数。確認で断ったら開かず、文書も印も変えない。 */
export function createOpenFlow({ model, ask, notify, onOpened, onUnsaved, onMissing }: OpenFlowOptions) {
  return async function open(
    path: string,
    { discardConfirmed = false, askUnsaved = true }: OpenFlowCall = {}
  ): Promise<OpenOutcome> {
    const options: OpenOptions = { discardConfirmed, accept: {} }

    for (;;) {
      const outcome = await model.open(path, options)
      let accepted = false

      if (outcome.kind === 'NeedsUnsavedDecision') {
        if (askUnsaved) {
          onUnsaved(path)
        }
      } else if (outcome.kind === 'NeedsEncodingConfirm') {
        accepted = await confirm(ask, {
          title: t('app.dialog.encodingTitle'),
          body: format('app.dialog.encodingBody', { encoding: t(`app.encoding.${outcome.encoding}`) }),
          accept: t('app.dialog.open')
        })
        options.accept = { ...options.accept, encoding: outcome.encoding }
      } else if (outcome.kind === 'NeedsSizeConfirm') {
        accepted = await confirm(ask, {
          title: t('app.dialog.sizeTitle'),
          body: format('app.dialog.sizeBody', { size: String(Math.round(outcome.size / MEBIBYTE)) }),
          accept: t('app.dialog.open'),
          defaultCancel: true
        })
        options.accept = { ...options.accept, size: true }
      } else {
        if (outcome.kind === 'Opened') {
          onOpened()
          if (outcome.baseline.scan.numericKeyReorder) {
            notify(t('app.notice.numericKeyReorder'))
          }
        } else {
          if (outcome.kind === 'Missing') {
            onMissing(path)
          }
          const message = failureMessage(outcome)
          if (message !== undefined) {
            notify(message)
          }
        }
        return outcome
      }

      if (!accepted) {
        return outcome
      }
    }
  }
}
