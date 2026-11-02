import { describe, expect, test } from 'vitest'
import { createHistoryInstance } from './history.js'

describe('history', () => {
  test('should restore the items and the position of a snapshot', () => {
    const instance = createHistoryInstance<string>()
    const history = () => instance.get()

    history().add('a')
    history().add('b')
    history().undo()
    const snapshot = instance.snapshot()

    history().clear()
    history().add('other')
    instance.restore(snapshot)

    expect(history().items()).toEqual(['a', 'b'])
    expect(history().canRedo).toBe(true)
    expect(history().redo()).toBe('b')
  })

  test('should not change a snapshot by adding items', () => {
    const instance = createHistoryInstance<string>()

    instance.get().add('a')
    const snapshot = instance.snapshot()
    instance.get().add('b')
    instance.restore(snapshot)

    expect(instance.get().items()).toEqual(['a'])
  })

  test('should report a restore to the listener', () => {
    const states: boolean[] = []
    const instance = createHistoryInstance<string>({
      onChange: (state) => states.push(state.canUndo)
    })
    const snapshot = instance.snapshot()

    instance.get().add('a')
    instance.restore(snapshot)

    expect(states).toEqual([true, false])
  })
})
