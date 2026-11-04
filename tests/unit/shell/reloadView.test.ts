// 外の変更を読み直した後の表示。前の表示と表の対象が新しい文書でも使えるときだけ戻す。
import { describe, expect, it } from 'vitest'
import { Mode } from '$lib/types'
import { isTableTarget, viewAfterReload } from '../../../src/shell/tableTargets'

const USERS = { users: [{ id: 1 }, { id: 2 }], tags: ['a', 'b', 'c'] }
const OPENED_TREE = { mode: Mode.tree, tableTarget: ['tags'] }
const valid = (json: unknown) => ({ json, textOnly: false })

describe('isTableTarget', () => {
  it('根の配列と、左ペインに出る配列だけを表の対象と見なす', () => {
    expect(isTableTarget([1, 2], [])).toBe(true)
    expect(isTableTarget(USERS, [])).toBe(false)
    expect(isTableTarget(USERS, ['users'])).toBe(true)
    expect(isTableTarget(USERS, ['tags'])).toBe(true)
    expect(isTableTarget(USERS, ['user'])).toBe(false)
    expect(isTableTarget({ users: [] }, ['users'])).toBe(false) // 空の配列は左ペインに出ない
    expect(isTableTarget({ users: { id: 1 } }, ['users'])).toBe(false)
    expect(isTableTarget(USERS, ['users', '0'])).toBe(false)
  })
})

describe('viewAfterReload（保つ側）', () => {
  it('表で開いていて、同じ配列が新しい文書にあれば、表と同じ対象を戻す', () => {
    expect(viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, OPENED_TREE, valid(USERS))).toEqual({
      mode: Mode.table,
      tableTarget: ['users']
    })
  })

  it('根の配列の表は、根がまだ配列なら表へ戻す', () => {
    expect(viewAfterReload({ mode: Mode.table, tableTarget: [] }, { mode: Mode.tree, tableTarget: [] }, valid([{ a: 1 }]))).toEqual({
      mode: Mode.table,
      tableTarget: []
    })
  })

  it('ツリーで開いていれば、ツリーのまま前の表の対象を保つ', () => {
    expect(viewAfterReload({ mode: Mode.tree, tableTarget: ['users'] }, OPENED_TREE, valid(USERS))).toEqual({
      mode: Mode.tree,
      tableTarget: ['users']
    })
  })
})

describe('viewAfterReload（ツリーへ落とす側）', () => {
  it('前の配列が新しい文書に無ければ戻さない（開く処理が選んだツリーと先頭の候補のまま）', () => {
    expect(viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, OPENED_TREE, valid({ tags: ['a'] }))).toBeUndefined()
    expect(viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, OPENED_TREE, valid({ users: 'gone' }))).toBeUndefined()
    expect(viewAfterReload({ mode: Mode.table, tableTarget: [] }, OPENED_TREE, valid(USERS))).toBeUndefined()
  })

  it('読み直した文書がテキストでしか開けなければ戻さない', () => {
    expect(
      viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, { mode: Mode.text, tableTarget: [] }, { json: undefined, textOnly: true })
    ).toBeUndefined()
    // 10 MB を超えるテキストでしか開けない文書はツリーで開く。それでも表へは戻さない
    expect(viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, OPENED_TREE, { json: USERS, textOnly: true })).toBeUndefined()
  })

  it('開く処理がツリーで開かなかった（テキスト）ときは戻さない', () => {
    expect(viewAfterReload({ mode: Mode.table, tableTarget: ['users'] }, { mode: Mode.text, tableTarget: [] }, valid(USERS))).toBeUndefined()
  })

  it('前がテキストの表示（undo で戻った形）なら戻さない。テキストは選ぶ表示ではない（D3）', () => {
    expect(viewAfterReload({ mode: Mode.text, tableTarget: ['users'] }, OPENED_TREE, valid(USERS))).toBeUndefined()
  })
})
