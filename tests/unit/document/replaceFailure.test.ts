import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parse, stringify } from 'lossless-json'
import { isTextContent } from '$lib/utils/jsonUtils'
import { Mode, type JSONParser } from '$lib/types'
import { createEditorPort } from '../../../src/document/editorPort'
import { DocumentModel } from '../../../src/document/model'
import { mountEditor } from '../../../src/editor/mount'
import { createFakeBackend } from '../../browser/fixture/fakeBackend'

/** 実物のエディタで、置き換えが例外になった後の保存を確かめる。 */
const FIRST = '{"keep":"my data","n":[1.0,2,3]}'
const SMALL = '{"other":2}'
const DEEP_DEPTH = 1000
const deep = `${'{"a":'.repeat(DEEP_DEPTH)}1${'}'.repeat(DEEP_DEPTH)}`
const STOPPED = { kind: 'Blocked', reason: 'replaceFailed' }

let failRendering = false
const targets: HTMLElement[] = []

beforeAll(() => {
  // jsdom に無い口。エディタの描画が呼ぶ
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  })) as unknown as typeof window.matchMedia
  const noRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })
  const noRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
  Range.prototype.getClientRects = noRects as unknown as typeof Range.prototype.getClientRects
  Range.prototype.getBoundingClientRect =
    noRect as unknown as typeof Range.prototype.getBoundingClientRect
})

afterEach(() => {
  failRendering = false
  for (const target of targets.splice(0)) {
    target.remove()
  }
})

function setup(mode: Mode, files: Record<string, string>) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  targets.push(target)
  const backend = createFakeBackend(files)
  let model: DocumentModel | undefined
  const editor = mountEditor(target, {
    content: { text: '' },
    mode,
    parser: { parse, stringify } as JSONParser,
    onRenderMenu: (items) => {
      if (failRendering) {
        throw new Error('injected')
      }
      return items
    },
    onChange: () => model?.noteEdit()
  })
  const opened = new DocumentModel(backend, createEditorPort(editor, target))
  model = opened
  const current = () => {
    const content = editor.get()
    return isTextContent(content) ? content.text : String(stringify(content.json))
  }
  return { backend, model: opened, current }
}

describe('実物のエディタの置き換えの失敗', () => {
  it('深い文書をツリーで開けなかった後は、保存も別名保存も書かず、別のファイルは開ける', async () => {
    const { backend, model, current } = setup(Mode.tree, {
      '/a.json': FIRST,
      '/deep.json': deep,
      '/x.json': 'old',
      '/small.json': SMALL
    })
    await model.open('/a.json')

    expect(await model.open('/deep.json')).toEqual({ kind: 'ReplaceFailed' })
    expect(current()).toBe(deep)

    expect(await model.save()).toEqual(STOPPED)
    expect(await model.saveAs('/x.json', model.revision)).toEqual(STOPPED)
    expect(backend.writes).toEqual([])
    expect(backend.files.get('/a.json')).toBe(FIRST)

    expect(await model.open('/small.json')).toEqual({ kind: 'NeedsUnsavedDecision' })
    expect((await model.open('/small.json', { discardConfirmed: true })).kind).toBe('Opened')
    expect(current()).toBe(SMALL)
    expect(model.dirty).toBe(false)
    expect(await model.save()).toEqual({ kind: 'NoChange' })
  })

  it('描画の例外を注入しても同じように止まり、別のファイルは開ける', async () => {
    const { backend, model, current } = setup(Mode.table, {
      '/a.json': FIRST,
      '/b.json': SMALL,
      '/small.json': '[3]'
    })
    await model.open('/a.json')

    failRendering = true
    expect(await model.open('/b.json')).toEqual({ kind: 'ReplaceFailed' })
    failRendering = false
    expect(current()).toBe(SMALL)

    expect(await model.save()).toEqual(STOPPED)
    expect(backend.writes).toEqual([])
    expect(backend.files.get('/a.json')).toBe(FIRST)

    const again = await model.open('/small.json', { discardConfirmed: true })
    expect(again.kind).toBe('Opened')
    expect(current()).toBe('[3]')
    expect(await model.save()).toEqual({ kind: 'NoChange' })
  })
})
