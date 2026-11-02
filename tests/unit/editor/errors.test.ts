import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Mode } from '$lib/types'
import { catchUnhandledErrors } from '../../../src/editor/errors'
import { createNotice } from '../../../src/editor/notice'
import { destroyAll, installDomStubs, mountForTest } from './harness'

beforeAll(installDomStubs)
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await destroyAll()
})

describe('例外の受け口', () => {
  it('error と unhandledrejection を受け、外すと受けない', () => {
    const report = vi.fn()
    const stop = catchUnhandledErrors(report)

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('one') }))
    const rejected = new Event('unhandledrejection') as Event & { reason: unknown }
    rejected.reason = 'two'
    window.dispatchEvent(rejected)
    expect(report.mock.calls.map(([error]) => error.message)).toEqual(['one', 'two'])

    stop()
    // 受け手が 1 つも無いと試験の道具が例外として拾う
    const other = (): void => {}
    window.addEventListener('error', other)
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('three') }))
    window.removeEventListener('error', other)
    expect(report).toHaveBeenCalledTimes(2)
  })
})

describe('通知', () => {
  it('文言を出し、時間で消え、押すと消える', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    const notice = createNotice(host)
    const element = host.querySelector('[role="status"]') as HTMLElement

    expect(element.hidden).toBe(true)
    notice.show('文言')
    expect(element.textContent).toBe('文言')
    expect(element.hidden).toBe(false)
    vi.runAllTimers()
    expect(element.hidden).toBe(true)

    notice.show('文言')
    element.click()
    expect(element.hidden).toBe(true)
    notice.destroy()
    expect(host.children.length).toBe(0)
  })
})

describe('エディタの例外', () => {
  it('値の描画の例外は通知へ渡り、alert を使わず、別の表示へ移れる', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let failing = true
    const view = mountForTest({ text: '[{"a":1}]' }, Mode.table, {
      onRenderValue: () => {
        if (failing) {
          throw new Error('injected')
        }
        return []
      }
    })

    expect(view.banner()).toContain('injected')
    expect(alert).not.toHaveBeenCalled()

    failing = false
    view.editor.updateProps({ mode: Mode.tree })
    expect(view.modeLabel()).toBe('ツリー')
  })
})
