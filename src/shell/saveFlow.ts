import type { Encoding, SaveConfirmations, SaveReply } from '../document/backend'
import type { DocumentModel, SaveOutcome } from '../document/model'
import { format, t } from '../i18n'
import type { AskRequest, DialogLevel, ShellPorts } from './ports'

export type SaveDestination = 'current' | 'choosePath'

export type SaveResult = 'saved' | 'noChange' | 'cancelled' | 'failed'

export interface SaveFlowOptions {
  model: Pick<DocumentModel, 'baseline' | 'revision' | 'saveBlocked' | 'save' | 'saveAs'>
  ask: ShellPorts['ask']
  pickSave: ShellPorts['pickSave']
  notify(message: string): void
  hasOpenModal(): boolean
}

/** 1 回の保存の間に積み上がる決定。確認を認めるたびに呼び直す。 */
interface Attempt {
  destination: SaveDestination
  path?: string
  revision: number
  encoding?: Encoding
  confirm: SaveConfirmations
}

const EXTENDED_PREFIX = '\\\\?\\'
const CODE_POINT_DIGITS = 4
const HEX = 16

/** 拡張長の接頭辞を外す。 */
export function displayPath(path: string): string {
  return path.startsWith(EXTENDED_PREFIX) ? path.slice(EXTENDED_PREFIX.length) : path
}

function codePointName(codePoint: number): string {
  return `U+${codePoint.toString(HEX).toUpperCase().padStart(CODE_POINT_DIGITS, '0')}`
}

/** 返事の理由の文言。別名保存へ導く種類も、退避名の内側の理由もここで引く。 */
function reasonText(reply: SaveOutcome | SaveReply): string {
  switch (reply.kind) {
    case 'ReadOnly':
      return t('app.save.readOnly')
    case 'WriteDenied':
      return t('app.save.writeDenied')
    case 'FolderDenied':
      return format('app.save.folderDenied', { code: String(reply.code) })
    case 'Locked':
      return format('app.save.locked', { code: String(reply.code) })
    case 'StaleRevision':
      return t('app.save.staleRevision')
    case 'RecoveryNeeded':
      return format('app.save.recoveryNeeded', { path: displayPath(reply.originalAt) })
    case 'BackupLeft':
      return format('app.save.backupLeft', {
        reason: reasonText(reply.reason),
        path: displayPath(reply.backupLeft)
      })
    case 'UnpairedSurrogate':
      return t('app.save.unpairedSurrogate')
    case 'SerializationMismatch':
      return t('app.save.serializationMismatch')
    case 'SerializationFailed':
      return t('app.save.serializationFailed')
    case 'VerifyFailed':
      return t('app.save.verifyFailed')
    case 'TargetAppeared':
      return t('app.save.targetAppeared')
    case 'Denied':
      return t('app.save.denied')
    case 'NoDocument':
      return t('app.save.noDocument')
    case 'Failed':
      return format('app.save.failed', { code: String(reply.code) })
    case 'Blocked':
      return t(`app.save.blocked.${reply.reason}`)
    case 'ExternalChange':
      return t('app.dialog.externalBody')
    case 'Missing':
      return t('app.dialog.missingBody')
    case 'Unrepresentable':
      return format('app.dialog.unrepresentableBody', { char: codePointName(reply.codePoint) })
    case 'NeedsConfirm':
      return reply.reasons.map((reason) => t(`app.save.confirm.${reason}`)).join(' ')
    case 'Saved':
    case 'Unchanged':
    case 'NoChange':
    case 'NeedsPath':
      return ''
  }
}

/** 保存の 1 関数。Ctrl+S、Ctrl+Shift+S、メニュー、閉じる確認の「保存」が全部ここを通る。 */
export function createSaveFlow({ model, ask, pickSave, notify, hasOpenModal }: SaveFlowOptions) {
  /** ボタンを選ばせる。Esc と×は最後のボタン。最後のボタンは必ずキャンセルにする。 */
  async function choose(title: string, body: string, buttons: string[], level: DialogLevel = 'warning', defaultIndex = 0): Promise<number> {
    const request: AskRequest = {
      title,
      body,
      level,
      buttons: [...buttons, t('app.dialog.cancel')],
      default: defaultIndex,
      cancel: buttons.length
    }
    return ask(request)
  }

  async function showFailure(message: string): Promise<void> {
    await ask({
      title: t('app.dialog.saveFailedTitle'),
      body: message,
      level: 'error',
      buttons: [t('app.dialog.ok')],
      default: 0,
      cancel: 0
    })
  }

  function toSaveAs(attempt: Attempt): void {
    attempt.destination = 'choosePath'
    attempt.path = undefined
  }

  /** 別名で保存へ導く失敗。 */
  async function offerSaveAs(attempt: Attempt, outcome: SaveOutcome): Promise<SaveResult | undefined> {
    const answer = await choose(t('app.dialog.saveFailedTitle'), reasonText(outcome), [t('app.dialog.saveAs')], 'error')
    if (answer !== 0) {
      return 'cancelled'
    }
    toSaveAs(attempt)
    return undefined
  }

  /** 保存の結果を画面に出し、終わりなら結果を返す。呼び直すなら `undefined`。 */
  async function settle(attempt: Attempt, outcome: SaveOutcome): Promise<SaveResult | undefined> {
    switch (outcome.kind) {
      case 'Saved':
        if (outcome.backupLeft !== null) {
          notify(format('app.save.backupLeftAfterSave', { path: displayPath(outcome.backupLeft) }))
        } else if (outcome.eolNormalized) {
          notify(t('app.save.eolNormalized'))
        }
        return 'saved'
      case 'NoChange':
        return 'noChange'
      case 'NeedsPath':
        toSaveAs(attempt)
        return undefined
      case 'NeedsConfirm': {
        for (const reason of outcome.reasons) {
          const body = t(`app.save.confirm.${reason}`)
          const answer = await choose(t('app.dialog.confirmTitle'), body, [t('app.dialog.saveAnyway')], 'warning', 1)
          if (answer !== 0) {
            return 'cancelled'
          }
          attempt.confirm = { ...attempt.confirm, [reason]: true }
        }
        return undefined
      }
      case 'ExternalChange': {
        const buttons = [t('app.dialog.saveAs'), t('app.dialog.overwrite')]
        const answer = await choose(t('app.dialog.externalTitle'), reasonText(outcome), buttons)
        if (answer === 0) {
          toSaveAs(attempt)
          return undefined
        }
        if (answer === 1) {
          attempt.confirm = { ...attempt.confirm, overwriteExternal: true }
          return undefined
        }
        return 'cancelled'
      }
      case 'Missing': {
        const buttons = [t('app.dialog.saveNew'), t('app.dialog.saveAs')]
        const answer = await choose(t('app.dialog.missingTitle'), reasonText(outcome), buttons)
        if (answer === 0) {
          attempt.confirm = { ...attempt.confirm, recreateMissing: true }
          return undefined
        }
        if (answer === 1) {
          toSaveAs(attempt)
          return undefined
        }
        return 'cancelled'
      }
      case 'Unrepresentable': {
        const buttons = [t('app.dialog.saveUtf8')]
        const answer = await choose(t('app.dialog.unrepresentableTitle'), reasonText(outcome), buttons)
        if (answer !== 0) {
          return 'cancelled'
        }
        toSaveAs(attempt)
        attempt.encoding = 'utf8'
        return undefined
      }
      case 'ReadOnly':
      case 'WriteDenied':
      case 'FolderDenied':
      case 'Locked':
        return offerSaveAs(attempt, outcome)
      case 'Blocked':
        if (outcome.reason === 'replaceFailed') {
          await showFailure(reasonText(outcome))
        } else {
          notify(reasonText(outcome))
        }
        return 'failed'
      case 'StaleRevision':
      case 'RecoveryNeeded':
      case 'BackupLeft':
      case 'UnpairedSurrogate':
      case 'SerializationMismatch':
      case 'SerializationFailed':
      case 'VerifyFailed':
      case 'TargetAppeared':
      case 'Denied':
      case 'NoDocument':
      case 'Failed':
        await showFailure(reasonText(outcome))
        return 'failed'
      default:
        return outcome satisfies never
    }
  }

  /** 保存先のダイアログを開く前に止める。選んだ後で断らない。 */
  function blockedBeforePicking(): SaveOutcome | undefined {
    if (hasOpenModal()) {
      return { kind: 'Blocked', reason: 'modalOpen' }
    }
    return model.saveBlocked ? { kind: 'Blocked', reason: 'replaceFailed' } : undefined
  }

  async function run(destination: SaveDestination): Promise<SaveResult> {
    const attempt: Attempt = { destination, revision: model.revision, confirm: {} }
    for (;;) {
      if (attempt.destination === 'choosePath' && attempt.path === undefined) {
        const blocked = blockedBeforePicking()
        if (blocked !== undefined) {
          return (await settle(attempt, blocked)) ?? 'failed'
        }
        // 版は保存先を選ぶ前に取る。選ぶ間に文書が替わったら保存を止める
        attempt.revision = model.revision
        const picked = await pickSave(model.baseline?.path ?? null)
        if (picked === null) {
          return 'cancelled'
        }
        attempt.path = picked
      }
      const { path, revision, confirm, encoding } = attempt
      const outcome =
        path === undefined
          ? await model.save(confirm)
          : await model.saveAs(path, revision, { confirm, encoding })
      const result = await settle(attempt, outcome)
      if (result !== undefined) {
        return result
      }
    }
  }

  async function guarded(destination: SaveDestination): Promise<SaveResult> {
    try {
      return await run(destination)
    } catch (error) {
      notify(format('app.save.unexpected', { message: String(error) }))
      return 'failed'
    }
  }

  let tail: Promise<unknown> = Promise.resolve()
  let waiting: { destination: SaveDestination; result: Promise<SaveResult> } | undefined

  /** 実行中に来た同じ保存は、次の 1 回に畳む。保存の間の入力は止めない。 */
  return function saveDocument(destination: SaveDestination): Promise<SaveResult> {
    if (waiting?.destination === destination) {
      return waiting.result
    }
    const queued = { destination } as NonNullable<typeof waiting>
    queued.result = tail.then(() => {
      if (waiting === queued) {
        waiting = undefined
      }
      return guarded(destination)
    })
    waiting = queued
    tail = queued.result
    return queued.result
  }
}
