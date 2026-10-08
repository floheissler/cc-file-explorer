import type { FsEntry, On } from 'claude-code'
import { expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { testPathOf } from './host'
import Limits from '../hooks/limits'
import { searchKeyOf } from '../hooks/names'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * Sixty lines, `needle` on lines 20, 40 and 41 (counted from 0) and
 * `Needle` on line 30.
 */
const MAIN_TS = Array.from({ length: 60 }, (_, at) => {
  const tail = at === 30 ? ' // Needle' : [20, 40, 41].includes(at) ? ' // needle' : ''

  return `export const n${at} = ${at}${tail}`
}).join('\n')

/**
 * Forty lines of Markdown, `needle` on line 25 alone.
 */
const README = Array.from({ length: 40 }, (_, at) => (at === 25 ? 'the needle line' : `line ${at}`)).join('\n\n')

const FILES: Record<string, string> = {
  [`${ROOT}/README.md`]: README,
  [`${ROOT}/data.csv`]: 'name,note\nalpha,first\nbeta,has a needle\n',
  [`${ROOT}/archive.zip`]: 'PK\u0003\u0004',
  [`${ROOT}/src/main.ts`]: MAIN_TS,
}

const FOLDERS: Record<string, FsEntry[]> = {
  [ROOT]: [
    entry('src', 'dir'),
    entry('archive.zip', 'file', 4),
    entry('data.csv', 'file', 40),
    entry('README.md', 'file', README.length),
  ],
  [`${ROOT}/src`]: [entry('main.ts', 'file', MAIN_TS.length)],
}

function stubProject(on: On): void {
  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('fs.list', ($, e) => ({ value: FOLDERS[testPathOf(e.path)] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: {
      kind: FOLDERS[testPathOf(e.path)] === undefined ? 'file' : 'dir',
      size: FILES[testPathOf(e.path)]?.length ?? 0,
      mtimeMs: 0,
      isLink: false,
    },
  }))
  on('fs.read', ($, e) => ({ value: FILES[testPathOf(e.path)] ?? '' }))
}

const openTree = ($: Engine, isFullscreen = true) =>
  $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen, columns: isFullscreen ? 160 : 80 },
  })

/**
 * The docked pane: 30 rows, so a searched file's window has 15.
 */
const paneOn = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'file-explorer',
    component: 'Pane',
    requestId: 'file-explorer',
    surface,
    viewport: { columns: 160, rows: 40, isFullscreen: true },
    props: {
      title: 'Explorer',
      isFocused: true,
      bodyColumns: 72,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const ringOnto = (element: string) =>
  ({
    component: 'Pane',
    requestId: 'file-explorer',
    plugin: 'file-explorer',
    element,
    origin: { kind: 'person' },
  }) as const

/**
 * What the search's row says it found, as drawn.
 */
const statusOf = async (ui: Pick<Mounted, 'find'>, text: string) => ui.find({ type: 'Text', text })

/**
 * The first line number the source preview draws.
 */
const startLineOf = async (ui: Pick<Mounted, 'find'>) => (await ui.find({ type: 'Code' }))?.props.startLine

/**
 * The marks left of the source, top down: `current`, `match` or a blank
 * row (`-`), as the search's column draws them.
 */
async function marksOf(ui: Pick<Mounted, 'drawn'>): Promise<string[]> {
  type Node = { readonly type?: string; readonly props?: Record<string, unknown>; readonly children?: unknown[] }

  const find = (node: unknown): Node | undefined => {
    if (typeof node !== 'object' || node === null) {
      return undefined
    }

    const element = node as Node

    if (element.type === 'Box' && element.props?.width === Limits.SEARCH_MARK_CELLS) {
      return element
    }

    for (const child of element.children ?? []) {
      const found = find(child)

      if (found !== undefined) {
        return found
      }
    }

    return undefined
  }

  const column = find(await ui.drawn())

  return (column?.children ?? []).map(child => {
    const row = child as Node

    if (row.type !== 'Text') {
      return '-'
    }

    return row.props?.color === 'warning' ? 'current' : 'match'
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`g searches the previewed file as the person types, n and b step through it (${surface})`, async ($, on) => {
    const clock = mock.clock(on)

    stubProject(on)
    await openTree($)

    const ui = await $.ui.mount(paneOn(surface))

    await ui.press({ key: 'row:src' })
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ key: 'search' })).toMatchObject({ props: { label: 'search', hotkey: 'g' } })

    // g shows the field over the preview; nothing typed marks nothing
    await ui.press({ key: 'search' })
    expect(await ui.find({ key: searchKeyOf(0) })).toMatchObject({ type: 'Input', props: { value: '', label: 'search' } })
    expect(await ui.find({ key: 'search' })).toMatchObject({ props: { label: 'clear' } })
    expect(await ui.find({ key: 'search-next' })).toBeUndefined()
    expect((await marksOf(ui)).every(mark => mark === '-')).toBe(true)

    // Once typing pauses, the first match shows two lines below the top
    await ui.input({ key: searchKeyOf(0), text: 'needle', kind: 'change' })
    await ui.redraw()
    expect(await startLineOf(ui)).toBe(1)

    await clock.advance(Limits.SEARCH_DEBOUNCE_MS)
    await ui.redraw()
    expect(await statusOf(ui, '1/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(19)
    expect(await marksOf(ui)).toEqual(['-', '-', 'current', ...Array(9).fill('-'), 'match', '-', '-'])

    // Claude Code empties the field on Enter, so a new one holds the query;
    // the match found stays
    await ui.input({ key: searchKeyOf(0), text: 'needle' })
    expect(await ui.find({ key: searchKeyOf(0) })).toBeUndefined()
    expect(await ui.find({ key: searchKeyOf(1) })).toMatchObject({ props: { value: 'needle' } })
    expect(await statusOf(ui, '1/4')).toBeDefined()
    expect(await ui.find({ key: 'search-next' })).toMatchObject({ props: { label: 'next', hotkey: 'n' } })
    expect(await ui.find({ key: 'search-back' })).toMatchObject({ props: { label: 'back', hotkey: 'b' } })

    // A match in view moves the marks alone; one out of view moves the window
    await ui.press({ key: 'search-next' })
    expect(await statusOf(ui, '2/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(19)
    expect(await marksOf(ui)).toEqual(['-', '-', 'match', ...Array(9).fill('-'), 'current', '-', '-'])

    await ui.press({ key: 'search-next' })
    expect(await statusOf(ui, '3/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(39)

    await ui.press({ key: 'search-next' })
    expect(await statusOf(ui, '4/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(39)

    // Around the end to the first, and back around the start to the last
    await ui.press({ key: 'search-next' })
    expect(await statusOf(ui, '1/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(19)

    await ui.press({ key: 'search-back' })
    expect(await statusOf(ui, '4/4')).toBeDefined()
    expect(await startLineOf(ui)).toBe(40)

    // A capital letter matches case exactly
    await ui.input({ key: searchKeyOf(1), text: 'Needle' })
    expect(await statusOf(ui, '1/1')).toBeDefined()
    expect(await startLineOf(ui)).toBe(29)

    // Nothing matching draws no steps
    await ui.input({ key: searchKeyOf(2), text: 'haystack' })
    expect(await statusOf(ui, 'no match')).toBeDefined()
    expect(await ui.find({ key: 'search-next' })).toBeUndefined()

    // g again closes the search; the window stays where it was
    await ui.press({ key: 'search' })
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    expect(await ui.find({ key: 'search' })).toMatchObject({ props: { label: 'search' } })
    expect(await marksOf(ui)).toEqual([])
    expect(await startLineOf(ui)).toBe(29)

    await ui.unmount()
  })
}

test('Enter with nothing typed closes the search', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'row:src' })
  await ui.press({ key: 'row:src/main.ts' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: '  ' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'search' })).toMatchObject({ props: { label: 'search' } })

  await ui.unmount()
})

test('a table bolds the matching cells of the match’s row', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'row:data.csv' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: 'needle' })

  expect(await statusOf(ui, '1/1')).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toContain('| beta | **has a needle** |')

  await ui.unmount()
})

test('rendered Markdown tops its window with the match’s line', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'row:README.md' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: 'needle' })

  expect(await statusOf(ui, '1/1')).toBeDefined()
  expect(String((await ui.find({ type: 'Markdown' }))?.props.text)).toMatch(/^the needle line/)

  // Its source draws the marks
  await ui.press({ key: 'preview-mode' })
  await ui.press({ key: 'search-next' })
  expect(await marksOf(ui)).toContain('current')

  await ui.unmount()
})

test('the search follows the preview onto the next file, from its top', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'row:src' })
  await ui.press({ key: 'row:src/main.ts' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: 'needle' })
  expect(await statusOf(ui, '1/4')).toBeDefined()

  // The ring lands on another file: the preview shows it, the query counts
  // its matches, and the steps start from its top
  await $.ui.focus(ringOnto('row:data.csv'))

  for (let turn = 0; turn < 20 && (await ui.find({ type: 'Markdown' })) === undefined; turn += 1) {
    await ui.redraw()
  }

  expect(await ui.find({ key: searchKeyOf(1) })).toMatchObject({ props: { value: 'needle' } })
  expect(await statusOf(ui, '1 match')).toBeDefined()

  await ui.press({ key: 'search-next' })
  expect(await statusOf(ui, '1/1')).toBeDefined()

  // A binary file has nothing to search, and g still closes the search
  await $.ui.focus(ringOnto('row:archive.zip'))

  for (let turn = 0; turn < 20 && (await ui.find({ type: 'Markdown' })) !== undefined; turn += 1) {
    await ui.redraw()
  }

  expect(await statusOf(ui, 'no match')).toBeDefined()
  await ui.press({ key: 'search' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'search' })).toBeUndefined()

  await ui.unmount()
})

test('closing the preview closes its search', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'row:src' })
  await ui.press({ key: 'row:src/main.ts' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: 'needle' })

  await ui.press({ key: 'preview-close' })
  await ui.press({ key: 'row:src/main.ts' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'search' })).toMatchObject({ props: { label: 'search' } })

  await ui.unmount()
})

test('inline, the search’s row sits over the file shown', async ($, on) => {
  stubProject(on)
  await openTree($, false)

  const ui = await $.ui.mount({
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
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  await ui.press({ key: 'row:src' })
  await ui.press({ key: 'row:src/main.ts' })
  await ui.press({ key: 'search' })
  await ui.input({ key: searchKeyOf(0), text: 'needle' })

  // 20 rows: the file's head row, the search's row and 18 of source
  expect(await statusOf(ui, '1/4')).toBeDefined()
  expect(await startLineOf(ui)).toBe(19)
  expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()

  // Back to the tree, the search goes with the file
  await ui.press({ key: 'preview-close' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()

  await ui.unmount()
})
