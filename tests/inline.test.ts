import type { FsEntry, On, PaneOpenArgs, RenderNode } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { testPathOf } from './host'
import { helpHeightOf } from '../hooks/view'
import { FULLSCREEN_TIP_TEXT, WIDEN_TIP_TEXT } from '../hooks/names'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * The pane seated inline above the prompt, as the classic renderer seats it
 * on an 80×24 terminal: 76 columns, at most 12 body rows.
 */
const INLINE = {
  plugin: 'file-explorer',
  component: 'Pane',
  requestId: 'file-explorer',
  surface: 'terminal',
  viewport: { columns: 80, rows: 24, isFullscreen: false },
  props: {
    title: 'Explorer',
    isFocused: true,
    bodyColumns: 76,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const CLASSIC = { isFullscreen: false, columns: 80 } as const
const DOCKING = { isFullscreen: true, columns: 160 } as const
const NARROW = { isFullscreen: true, columns: 100 } as const

const treeIn = ($: Engine, presentation: { readonly isFullscreen: boolean; readonly columns: number }) =>
  $.command.run({ command: 'tree', args: '', origin: { kind: 'composer' }, presentation })

/**
 * A project of `names` in its root (README.md a Markdown file), the pane's
 * open state as the engine reports it, and every open's argument.
 */
function projectOf(on: On, names: readonly string[]) {
  const pane = { isOpen: false }
  const opens: PaneOpenArgs[] = []

  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({
    value: pane.isOpen
      ? [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }]
      : [],
  }))
  on('ui.open', ($, e) => {
    opens.push(e)
    pane.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    pane.isOpen = false

    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ value: testPathOf(e.path) === ROOT ? names.map(name => entry(name, 'file', 9)) : [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, e) => ({ value: testPathOf(e.path).endsWith('.md') ? '# Hello\n\nSome **text**\n' : 'const a = 1' }))

  return { pane, opens }
}

type ElementData = {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly RenderNode[]
}

/**
 * The heights of the drawing's top-level regions, in order.
 */
function regionHeightsOf(tree: RenderNode): unknown[] {
  return ((tree as ElementData).children ?? []).map(child => (child as ElementData).props?.height)
}

describe('an inline pane', () => {
  test('asks for its rows and, under the classic renderer, to close on Esc', async ($, on) => {
    const { opens } = projectOf(on, ['a.txt'])

    await treeIn($, CLASSIC)
    await treeIn($, CLASSIC)
    await treeIn($, DOCKING)

    expect(opens).toEqual([
      { id: 'file-explorer', title: 'Explorer', focus: true, rows: 40, closeOnEscape: true },
      { id: 'file-explorer', title: 'Explorer', focus: true, rows: 40 },
    ])
  })

  test('is as tall as its tree, up to the room', async ($, on) => {
    projectOf(on, ['a.txt', 'b.txt', 'c.txt'])
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    // The header, the tree's 3 rows, and the hidden keys' box
    expect(regionHeightsOf(await ui.drawn())).toEqual([1, 3, undefined])
    await ui.unmount()
  })

  test('caps a long tree at the room and scrolls it', async ($, on) => {
    projectOf(on, Array.from({ length: 30 }, (_, at) => `f${String(at).padStart(2, '0')}.txt`))
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    expect(regionHeightsOf(await ui.drawn())).toEqual([1, 11, undefined])
    expect(await ui.find({ type: 'Text', text: '↓ 20 more' })).toBeDefined()
    await ui.unmount()
  })

  test('shows a picked file in place of the tree, and x steps back', async ($, on) => {
    projectOf(on, ['README.md', 'a.txt'])
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    await ui.press({ key: 'row:README.md' })
    expect(await ui.find({ key: 'row:a.txt' })).toBeUndefined()
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'preview-close' })).toMatchObject({ props: { label: 'back' } })

    // Its head row, then the file's three lines
    expect(regionHeightsOf(await ui.drawn())).toEqual([1, 3, undefined])

    await ui.press({ key: 'preview-close' })
    expect(await ui.find({ key: 'row:a.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  })

  test('mentions the file it shows, its row carrying a', async ($, on) => {
    projectOf(on, ['README.md', 'a.txt'])
    const fills: string[] = []

    on('session.cwd', () => ({ value: ROOT }))
    on('ui.focus', () => ({}))
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', ($, e) => {
      fills.push(e.text)

      return { isFilled: true }
    })
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    // The ring rested on another row before the file took the tree's place
    await $.ui.focus({
      component: 'Pane',
      requestId: 'file-explorer',
      plugin: 'file-explorer',
      element: 'row:README.md',
      origin: { kind: 'person' },
    })
    await ui.press({ key: 'row:a.txt' })
    expect(await ui.find({ key: 'mention' })).toMatchObject({ props: { label: 'mention', hotkey: 'a' } })

    await ui.press({ key: 'mention' })
    expect(fills).toEqual(['@a.txt '])
    await ui.unmount()
  })

  test('draws the tree and the file together once it moves to the dock', async ($, on) => {
    projectOf(on, ['README.md', 'a.txt'])
    await treeIn($, NARROW)

    const ui = await $.ui.mount(INLINE)

    await ui.press({ key: 'row:README.md' })
    await ui.redraw({ ...INLINE.props, placement: 'dock', bodyColumns: 60, scroll: { offset: 0, bodyRows: 30 } })

    expect(await ui.find({ key: 'row:a.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'preview-close' })).toMatchObject({ props: { label: 'close' } })
    await ui.unmount()
  })

  test('opens again on the tree, the picked file first in the focus ring', async ($, on) => {
    projectOf(on, ['README.md', 'a.txt'])
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    await ui.press({ key: 'row:README.md' })
    await treeIn($, CLASSIC)
    await treeIn($, CLASSIC)
    await ui.redraw()

    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    expect(await ui.find({ key: 'row:README.md' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ key: 'row:a.txt' })).not.toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('keeps the picked file as the ring walks the tree, with no preview beside it to follow', async ($, on) => {
    projectOf(on, ['README.md', 'a.txt'])
    on('ui.focus', () => ({}))
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount(INLINE)

    // The file view has nothing to pin: nothing follows the ring here
    await ui.press({ key: 'row:README.md' })
    expect(await ui.find({ key: 'preview-pin' })).toBeUndefined()

    await treeIn($, CLASSIC)
    await treeIn($, CLASSIC)
    await ui.redraw()
    await $.ui.focus({
      component: 'Pane',
      requestId: 'file-explorer',
      plugin: 'file-explorer',
      element: 'row:a.txt',
      origin: { kind: 'person' },
    })

    for (let turn = 0; turn < 10; turn += 1) {
      await ui.redraw()
    }

    // Docked, the picked file shows beside the tree, and can be pinned
    await ui.redraw({ ...INLINE.props, placement: 'dock', bodyColumns: 60, scroll: { offset: 0, bodyRows: 30 } })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ key: 'preview-pin' })).toMatchObject({ props: { label: 'pin' } })
    await ui.unmount()
  })

  test('shows help without the mouse, with the fullscreen tip, at its natural height', async ($, on) => {
    projectOf(on, ['a.txt'])
    await treeIn($, CLASSIC)

    const ui = await $.ui.mount({ ...INLINE, props: { ...INLINE.props, scroll: { offset: 0, bodyRows: 40 } } })

    await ui.press({ key: 'help' })
    expect(await ui.find({ type: 'Text', text: 'Mouse' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Esc' })).toBeDefined()
    expect(regionHeightsOf(await ui.drawn())[1]).toBe(helpHeightOf({ placement: 'inline', isClassic: true }, 76))
    await ui.unmount()
  })
})

describe('the fullscreen tip', () => {
  test('under the classic renderer, the first open leaves it, once ever', async ($, on) => {
    mock.store(on)
    projectOf(on, ['a.txt'])

    expect(await treeIn($, CLASSIC)).toMatchObject({ text: FULLSCREEN_TIP_TEXT })
    await treeIn($, CLASSIC)
    expect((await treeIn($, CLASSIC)).text).toBeUndefined()
  })

  test('a terminal too narrow to dock is told its width, once a session', async ($, on) => {
    mock.store(on)
    projectOf(on, ['a.txt'])

    expect(await treeIn($, NARROW)).toMatchObject({ text: WIDEN_TIP_TEXT })
    await treeIn($, NARROW)
    expect((await treeIn($, NARROW)).text).toBeUndefined()
  })

  test('a docked pane says nothing', async ($, on) => {
    mock.store(on)
    projectOf(on, ['a.txt'])

    expect((await treeIn($, DOCKING)).text).toBeUndefined()
  })
})
