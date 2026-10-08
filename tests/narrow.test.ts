import type { FsEntry, On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { hotkeysOf, markersOf, overflowsOf } from './drawn'
import { testPathOf } from './host'
import { filterKeyOf, searchKeyOf } from '../hooks/names'
import { maxPreviewTop, previewOf, sourceColumnsOf } from '../hooks/preview'

const ROOT = '/work/an-unusually-long-project-folder-name'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * Seven folders deep, each name long enough to press on a narrow row.
 */
const DEEP = Array.from({ length: 7 }, (_, at) => `folder-level-${at + 1}-with-a-longer-name`)

const FILES: Record<string, string> = {
  [`${ROOT}/README.md`]: `# A title long enough to wrap in a narrow pane\n\n${'Some words that run on. '.repeat(30)}\n`,
  [`${ROOT}/main-with-a-rather-long-name.ts`]: Array.from(
    { length: 40 },
    (_, at) => `export const value${at} = '${'x'.repeat(at * 4)}'`,
  ).join('\n'),
  [`${ROOT}/data.csv`]: 'name,note\nalpha,a note that runs on and on\nbeta,short\n',
  [`${ROOT}/archive.zip`]: 'PK\u0003\u0004',
  [`${ROOT}/${DEEP.join('/')}/a-file-at-the-bottom-of-it-all.txt`]: 'deep',
}

const FOLDERS: Record<string, FsEntry[]> = {
  [ROOT]: [
    entry(DEEP[0] ?? '', 'dir'),
    entry('README.md', 'file', 700),
    entry('main-with-a-rather-long-name.ts', 'file', 4000),
    entry('data.csv', 'file', 60),
    entry('archive.zip', 'file', 4),
  ],
  ...Object.fromEntries(
    DEEP.map((name, at) => [
      `${ROOT}/${DEEP.slice(0, at + 1).join('/')}`,
      at + 1 < DEEP.length
        ? [entry(DEEP[at + 1] ?? '', 'dir')]
        : [entry('a-file-at-the-bottom-of-it-all.txt', 'file', 4)],
    ]),
  ),
}

/**
 * Git's markers on the root's files and down the deep folders, so the
 * sweep draws rows with markers; with a file Claude wrote (`openTree`),
 * both marker columns.
 */
const STATUS = [
  ' M README.md',
  '?? main-with-a-rather-long-name.ts',
  '!! archive.zip',
  `?? ${DEEP.join('/')}/a-file-at-the-bottom-of-it-all.txt`,
]
  .map(field => `${field}\0`)
  .join('')

/**
 * What git writes: for the markers, where the root sits and the status;
 * for the filter, every file, and none ignored or deleted.
 */
function gitOutputOf(argv: readonly string[]): string {
  if (argv[1] === 'rev-parse') {
    return `\n${ROOT}/.git\n`
  }

  if (argv[1] === 'status') {
    return STATUS
  }

  return argv.includes('--cached') ? Object.keys(FILES).map(path => `${path.slice(ROOT.length + 1)}\0`).join('') : ''
}

function stubProject(on: On): void {
  on('tool.call', () => ({ result: 'ok' }))
  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: gitOutputOf(e.argv),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
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

const openTree = async ($: Engine, isFullscreen: boolean) => {
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/data.csv`, content: '' } as never)

  return $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen, columns: 160 },
  })
}

const WIDTHS = [16, 24, 32, 40, 60, 120] as const

/**
 * Each view the sweep draws, reached from the tree by presses, then a query
 * submitted in the filter or the in-file search, then presses again.
 */
const VIEWS: readonly {
  readonly name: string
  readonly presses: readonly string[]
  readonly query?: string
  readonly search?: string
  readonly then?: readonly string[]
  /**
   * An element the view draws, by key, so the sweep checks the view it
   * means to: docked always, inline unless the file view stands in.
   */
  readonly shows?: string
  /**
   * Whether only the dock draws the view's controls.
   */
  readonly isDockOnly?: true
}[] = [
  { name: 'tree', presses: [] },
  { name: 'tree 9 deep', presses: ['depth-9'] },
  { name: 'Markdown', presses: ['row:README.md'] },
  { name: 'Markdown source', presses: ['row:README.md', 'preview-mode'] },
  { name: 'pinned', presses: ['row:README.md', 'preview-pin'], shows: 'preview-pin', isDockOnly: true },
  { name: 'code', presses: ['row:main-with-a-rather-long-name.ts'] },
  { name: 'notice', presses: ['row:archive.zip'] },
  { name: 'table', presses: ['row:data.csv'] },
  { name: 'help', presses: ['help'] },
  { name: 'filter', presses: ['filter'], shows: filterKeyOf(0) },
  {
    name: 'filtered deep',
    presses: ['filter'],
    query: 'bottom',
    shows: `row:${DEEP.join('/')}/a-file-at-the-bottom-of-it-all.txt`,
  },
  { name: 'filtered, no match', presses: ['filter'], query: 'nothing-is-called-this', shows: filterKeyOf(1) },
  { name: 'filtered preview', presses: ['filter'], query: 'readme', then: ['row:README.md'], shows: filterKeyOf(1) },
  { name: 'search', presses: ['row:main-with-a-rather-long-name.ts', 'search'], shows: searchKeyOf(0) },
  {
    name: 'searched code',
    presses: ['row:main-with-a-rather-long-name.ts', 'search'],
    search: 'value1',
    shows: 'search-next',
  },
  {
    name: 'searched Markdown',
    presses: ['row:README.md', 'search'],
    search: 'words',
    shows: 'search-next',
  },
  { name: 'searched table', presses: ['row:data.csv', 'search'], search: 'beta', shows: 'search-next' },
  {
    name: 'searched, no match',
    presses: ['row:main-with-a-rather-long-name.ts', 'search'],
    search: 'nothing-is-called-this',
    shows: searchKeyOf(1),
  },
]

const SEATS = [
  { name: 'docked, terminal', surface: 'terminal', placement: 'dock', isFullscreen: true, pad: 1 },
  { name: 'docked, desktop', surface: 'desktop', placement: 'dock', isFullscreen: true, pad: 1 },
  { name: 'inline, classic', surface: 'terminal', placement: 'inline', isFullscreen: false, pad: 0 },
] as const

describe('rows fit the body at every width', () => {
  for (const seat of SEATS) {
    for (const view of VIEWS.filter(shown => shown.isDockOnly !== true || seat.placement === 'dock')) {
      test(`${view.name}, ${seat.name}`, async ($, on) => {
        stubProject(on)
        await openTree($, seat.isFullscreen)

        const pane = {
          plugin: 'file-explorer',
          component: 'Pane',
          requestId: 'file-explorer',
          surface: seat.surface,
          viewport: { columns: 160, rows: 40, isFullscreen: seat.isFullscreen },
          props: {
            title: 'Explorer',
            isFocused: true,
            bodyColumns: 120,
            placement: seat.placement,
            scroll: { offset: 0, bodyRows: 30 },
            view: {},
          },
        } as const

        const ui = await $.ui.mount(pane)

        for (const key of view.presses) {
          await ui.press({ key })
        }

        if (view.query !== undefined) {
          await ui.input({ key: filterKeyOf(0), text: view.query })
        }

        if (view.search !== undefined) {
          await ui.input({ key: searchKeyOf(0), text: view.search })
        }

        for (const key of view.then ?? []) {
          await ui.press({ key })
        }

        // Inline, a picked file stands in for the tree and the filter's row
        if (view.shows !== undefined && !(seat.placement === 'inline' && view.then !== undefined)) {
          expect(await ui.find({ key: view.shows }), `${view.name} draws ${view.shows}`).toBeDefined()
        }

        for (const bodyColumns of WIDTHS) {
          await ui.redraw({ ...pane.props, bodyColumns })

          const drawn = await ui.drawn()
          const columns = bodyColumns - seat.pad
          const hotkeys = hotkeysOf(drawn)

          expect(drawn.type, `${bodyColumns} columns: drawn by the plugin`).not.toBe('engine')
          expect(overflowsOf(drawn, columns), `${bodyColumns} columns`).toEqual([])
          expect(new Set(hotkeys).size, `${bodyColumns} columns: one Button a hotkey`).toBe(hotkeys.length)

          // The rows swept carry both marker columns, in a filtered tree too
          if (view.name === 'tree') {
            expect(markersOf(drawn, 'README.md'), `${bodyColumns} columns: markers`).toBe('  M')
            expect(markersOf(drawn, 'data.csv'), `${bodyColumns} columns: markers`).toBe(' ✻ ')
          }

          if (view.name === 'filtered deep') {
            const bottom = `${DEEP.join('/')}/a-file-at-the-bottom-of-it-all.txt`

            expect(markersOf(drawn, bottom), `${bodyColumns} columns: markers`).toBe(' ?')
          }
        }

        await ui.unmount()
      })
    }
  }
})

describe('the width model', () => {
  const input = (label: string) => ({ type: 'Input', props: { key: 'q', label, onSubmit: () => undefined } })

  test('finds an Input outside a clipped box of fixed width, where a long text wraps', async () => {
    const row = { type: 'Box', props: { flexDirection: 'row', height: 1 }, children: [input('filter')] }

    expect(overflowsOf(row, 40)).toEqual(['Input q sits outside a clipped box of fixed width'])
  })

  test('finds a clipped box too narrow for its Input’s label', async () => {
    const box = (width: number) => ({
      type: 'Box',
      props: { width, height: 1, overflow: 'hidden' },
      children: [input('filter')],
    })

    // `filter: ` and a cell of field take 9 cells
    expect(overflowsOf(box(9), 40)).toEqual([])
    expect(overflowsOf(box(8), 40)).toEqual(["Input q needs 9 cells of its box's 8"])
  })
})

describe('a narrow header', () => {
  test('keeps every key working with its labels hidden', async ($, on) => {
    stubProject(on)
    await openTree($, true)

    const props = {
      title: 'Explorer',
      isFocused: true,
      bodyColumns: 28,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    } as const

    const ui = await $.ui.mount({
      plugin: 'file-explorer',
      component: 'Pane',
      requestId: 'file-explorer',
      surface: 'terminal',
      viewport: { columns: 160, rows: 40, isFullscreen: true },
      props,
    })

    // At 28 columns the header draws `e c r f a  h: help`: e is a hidden Button
    expect(await ui.find({ type: 'Text', text: 'e c r f a' })).toBeDefined()
    expect(await ui.find({ key: 'help' })).toMatchObject({ props: { label: 'help' } })

    await ui.press({ key: 'expand-level' })
    expect(await ui.find({ key: `row:${DEEP[0]}/${DEEP[1]}` })).toBeDefined()

    // At 26, `h: help` alone: the name keeps its 8 cells
    await ui.redraw({ ...props, bodyColumns: 26 })
    expect(await ui.find({ type: 'Text', text: 'e c r' })).toBeUndefined()
    expect(await ui.find({ key: 'help' })).toMatchObject({ props: { label: 'help' } })

    await ui.unmount()
  })
})

describe('a source preview of long lines', () => {
  test('scrolls until its last line shows, wrapped lines counted', async () => {
    const preview = previewOf('wide.ts', 0, Array.from({ length: 10 }, (_, at) => 'x'.repeat(at === 9 ? 100 : 10)).join('\n'))
    const columns = sourceColumnsOf(10, 40)

    // The gutter takes a cell, two digits and a cell. The last line wraps
    // over 3 rows of the 5, so the window ends at line 7
    expect(columns).toBe(36)
    expect(maxPreviewTop(preview, 5, true, columns)).toBe(7)

    // Without the width, the window would stop two lines short of the end
    expect(maxPreviewTop(preview, 5, true)).toBe(5)
  })

  test('shows a line taller than the window from its start', async () => {
    const preview = previewOf('wide.ts', 0, ['short', 'x'.repeat(500)].join('\n'))

    expect(maxPreviewTop(preview, 3, true, 30)).toBe(1)
  })
})
