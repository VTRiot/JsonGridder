import { describe, expect, it, vi } from 'vitest'
import type { SaveAsOptions, SaveOutcome } from '../../src/document/model'
import type { AskRequest } from '../../src/shell/ports'
import { createSaveFlow, displayPath, type SaveDestination } from '../../src/shell/saveFlow'

const SAVED: SaveOutcome = { kind: 'Saved', eolNormalized: false, backupLeft: null }
const FIRST = 0
const SECOND = 1
const CANCEL = 99
const REVISION = 7

interface Setup {
  outcomes: SaveOutcome[]
  answers?: number[]
  picks?: (string | null)[]
  modal?: boolean
  saveBlocked?: boolean
}

function setup({ outcomes, answers = [], picks = [], modal = false, saveBlocked = false }: Setup) {
  const saves: unknown[] = []
  const asks: AskRequest[] = []
  const notices: string[] = []
  const pickSave = vi.fn((_: string | null) => Promise.resolve(picks.shift() ?? null))
  const next = (): Promise<SaveOutcome> => Promise.resolve(outcomes.shift() ?? SAVED)
  const flow = createSaveFlow({
    model: {
      baseline: null,
      revision: REVISION,
      saveBlocked,
      save(confirm) {
        saves.push({ confirm })
        return next()
      },
      saveAs(path: string, revision: number, options?: SaveAsOptions) {
        saves.push({ path, revision, ...options })
        return next()
      }
    },
    ask(request) {
      asks.push(request)
      const answer = answers.shift() ?? CANCEL
      return Promise.resolve(answer === CANCEL ? request.cancel : answer)
    },
    pickSave,
    notify: (message) => notices.push(message),
    hasOpenModal: () => modal
  })
  return { flow, saves, asks, notices, pickSave }
}

const run = (options: Setup, destination: SaveDestination = 'current') => {
  const context = setup(options)
  return context.flow(destination).then((result) => ({ ...context, result }))
}

describe('保存の 1 関数', () => {
  it('Saved と NoChange はそのまま終わる', async () => {
    expect((await run({ outcomes: [SAVED] })).result).toBe('saved')
    expect((await run({ outcomes: [{ kind: 'NoChange' }] })).result).toBe('noChange')
  })

  it('改行を揃えたことと残った退避名を知らせる', async () => {
    const eol = await run({ outcomes: [{ kind: 'Saved', eolNormalized: true, backupLeft: null }] })
    expect(eol.notices[0]).toContain('改行')
    const left = await run({
      outcomes: [{ kind: 'Saved', eolNormalized: false, backupLeft: '\\\\?\\C:\\a.bak' }]
    })
    expect(left.notices[0]).toContain('C:\\a.bak')
    expect(left.notices[0]).not.toContain('\\\\?\\')
  })

  it('保存先が無ければ別名へ進む', async () => {
    const { result, saves } = await run({ outcomes: [{ kind: 'NeedsPath' }, SAVED], picks: ['/n.json'] })
    expect(result).toBe('saved')
    expect(saves[1]).toMatchObject({ path: '/n.json', revision: REVISION })
  })

  it('別名の取り消しは書かない', async () => {
    const { result, saves } = await run({ outcomes: [] }, 'choosePath')
    expect(result).toBe('cancelled')
    expect(saves).toEqual([])
  })

  it('確認は理由ごとに聞き、既定はキャンセル', async () => {
    const reasons = ['blank', 'unparsable'] as const
    const { result, asks, saves } = await run({
      outcomes: [{ kind: 'NeedsConfirm', reasons: [...reasons] }, SAVED],
      answers: [FIRST, FIRST]
    })
    expect(result).toBe('saved')
    expect(asks).toHaveLength(reasons.length)
    expect(asks.every((request) => request.default === request.cancel)).toBe(true)
    expect(saves[1]).toEqual({ confirm: { blank: true, unparsable: true } })
  })

  it('確認を断ると書かない', async () => {
    const { result, saves } = await run({
      outcomes: [{ kind: 'NeedsConfirm', reasons: ['roundTrip'] }]
    })
    expect(result).toBe('cancelled')
    expect(saves).toHaveLength(1)
  })

  it('外部変更の既定は別名で、元へ書かない', async () => {
    const { result, asks, saves } = await run({
      outcomes: [{ kind: 'ExternalChange' }, SAVED],
      answers: [FIRST],
      picks: ['/kept.json']
    })
    expect(result).toBe('saved')
    expect(asks[0].default).toBe(FIRST)
    expect(saves[1]).toMatchObject({ path: '/kept.json' })
  })

  it('外部変更の上書きは決定を付けて呼び直す', async () => {
    const { saves } = await run({ outcomes: [{ kind: 'ExternalChange' }, SAVED], answers: [SECOND] })
    expect(saves[1]).toEqual({ confirm: { overwriteExternal: true } })
  })

  it('外部変更のキャンセルは書かない', async () => {
    const { result, saves } = await run({ outcomes: [{ kind: 'ExternalChange' }] })
    expect(result).toBe('cancelled')
    expect(saves).toHaveLength(1)
  })

  it('消失は新しく保存か別名を選べる', async () => {
    const created = await run({ outcomes: [{ kind: 'Missing' }, SAVED], answers: [FIRST] })
    expect(created.saves[1]).toEqual({ confirm: { recreateMissing: true } })
    const moved = await run({
      outcomes: [{ kind: 'Missing' }, SAVED],
      answers: [SECOND],
      picks: ['/m.json']
    })
    expect(moved.saves[1]).toMatchObject({ path: '/m.json' })
    expect((await run({ outcomes: [{ kind: 'Missing' }] })).result).toBe('cancelled')
  })

  it('表せない文字は UTF-8 の別名へ導き、文字を示す', async () => {
    const { result, asks, saves } = await run({
      outcomes: [{ kind: 'Unrepresentable', codePoint: 0x3042, offset: 0 }, SAVED],
      answers: [FIRST],
      picks: ['/u.json']
    })
    expect(result).toBe('saved')
    expect(asks[0].body).toContain('U+3042')
    expect(saves[1]).toMatchObject({ path: '/u.json', encoding: 'utf8' })
  })

  it.each<SaveOutcome>([
    { kind: 'ReadOnly' },
    { kind: 'WriteDenied' },
    { kind: 'FolderDenied', code: 5 },
    { kind: 'Locked', code: 32 }
  ])('$kind は別名へ導く', async (outcome) => {
    const { result, saves } = await run({ outcomes: [outcome, SAVED], answers: [FIRST], picks: ['/a.json'] })
    expect(result).toBe('saved')
    expect(saves[1]).toMatchObject({ path: '/a.json' })
    expect((await run({ outcomes: [outcome] })).result).toBe('cancelled')
  })

  it.each<SaveOutcome>([
    { kind: 'StaleRevision' },
    { kind: 'RecoveryNeeded', originalAt: '\\\\?\\C:\\a.json' },
    { kind: 'UnpairedSurrogate' },
    { kind: 'SerializationMismatch' },
    { kind: 'SerializationFailed' },
    { kind: 'VerifyFailed' },
    { kind: 'TargetAppeared' },
    { kind: 'Denied', reason: 'notGranted' },
    { kind: 'NoDocument' },
    { kind: 'Failed', code: 5 },
    { kind: 'Blocked', reason: 'replaceFailed' }
  ])('$kind は理由を出して失敗にする', async (outcome) => {
    const { result, asks } = await run({ outcomes: [outcome], answers: [FIRST] })
    expect(result).toBe('failed')
    expect(asks[0].body.length).toBeGreaterThan(0)
    expect(asks[0].body).not.toContain('app.save')
    expect(asks[0].body).not.toContain('\\\\?\\')
  })

  it('退避名の失敗は内側の理由と場所の両方を出す', async () => {
    const { asks } = await run({
      outcomes: [{ kind: 'BackupLeft', reason: { kind: 'ReadOnly' }, backupLeft: '\\\\?\\C:\\a.bak' }],
      answers: [FIRST]
    })
    expect(asks[0].body).toContain('読み取り専用')
    expect(asks[0].body).toContain('C:\\a.bak')
  })

  it('モーダルと処理中は帯で知らせて失敗にする', async () => {
    const modal = await run({ outcomes: [{ kind: 'Blocked', reason: 'modalOpen' }] })
    expect(modal.result).toBe('failed')
    expect(modal.asks).toEqual([])
    expect(modal.notices[0]).toContain('ダイアログ')
    const busy = await run({ outcomes: [{ kind: 'Blocked', reason: 'busy' }] })
    expect(busy.result).toBe('failed')
  })

  it('モーダルか保存の停止の間は保存先を聞かない', async () => {
    const modal = await run({ outcomes: [], modal: true }, 'choosePath')
    expect(modal.result).toBe('failed')
    expect(modal.pickSave).not.toHaveBeenCalled()
    const stopped = await run({ outcomes: [], saveBlocked: true, answers: [FIRST] }, 'choosePath')
    expect(stopped.result).toBe('failed')
    expect(stopped.pickSave).not.toHaveBeenCalled()
  })

  it('例外は失敗にして、閉じる判断を止めない', async () => {
    const context = setup({ outcomes: [] })
    context.pickSave.mockRejectedValueOnce(new Error('injected'))
    await expect(context.flow('choosePath')).resolves.toBe('failed')
    expect(context.notices[0]).toContain('injected')
  })

  it('実行中の同じ保存は次の 1 回に畳む', async () => {
    const { flow, saves } = setup({ outcomes: [] })
    const results = await Promise.all([flow('current'), flow('current'), flow('current')])
    expect(results).toEqual(['saved', 'saved', 'saved'])
    expect(saves).toHaveLength(1)
  })

  it('実行中に来た保存は畳まず、終わった後にもう 1 回走る', async () => {
    let release: (outcome: SaveOutcome) => void = () => {}
    const saves: string[] = []
    const flow = createSaveFlow({
      model: {
        baseline: null,
        revision: REVISION,
        saveBlocked: false,
        save() {
          saves.push('save')
          return saves.length === 1
            ? new Promise<SaveOutcome>((resolve) => {
                release = resolve
              })
            : Promise.resolve(SAVED)
        },
        saveAs: () => Promise.resolve(SAVED)
      },
      ask: () => Promise.resolve(0),
      pickSave: () => Promise.resolve(null),
      notify: () => {},
      hasOpenModal: () => false
    })

    const first = flow('current')
    await vi.waitFor(() => expect(saves).toHaveLength(1))
    const second = flow('current')
    const third = flow('current')
    release(SAVED)
    await Promise.all([first, second, third])
    expect(saves).toHaveLength(2)
  })

  it('拡張長の接頭辞だけを外す', () => {
    expect(displayPath('\\\\?\\C:\\a.json')).toBe('C:\\a.json')
    expect(displayPath('C:\\a.json')).toBe('C:\\a.json')
  })
})
