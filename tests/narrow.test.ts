import type { FsEntry, On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { hotkeysOf, overflowsOf } from './drawn'
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

function stubProject(on: On): void {
  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', ($, e) => ({ value: FOLDERS[e.path] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: {
      kind: FOLDERS[e.path] === undefined ? 'file' : 'dir',
      size: FILES[e.path]?.length ?? 0,
      mtimeMs: 0,
      isLink: false,
    },
  }))
  on('fs.read', ($, e) => ({ value: FILES[e.path] ?? '' }))
}

const openTree = ($: Engine, isFullscreen: boolean) =>
  $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen, columns: 160 },
  })

const WIDTHS = [16, 24, 32, 40, 60, 120] as const

/**
 * Each view the sweep draws, reached by presses from the tree.
 */
const VIEWS: readonly { readonly name: string; readonly presses: readonly string[] }[] = [
  { name: 'tree', presses: [] },
  { name: 'tree 9 deep', presses: ['depth-9'] },
  { name: 'Markdown', presses: ['row:README.md'] },
  { name: 'Markdown source', presses: ['row:README.md', 'preview-mode'] },
  { name: 'code', presses: ['row:main-with-a-rather-long-name.ts'] },
  { name: 'notice', presses: ['row:archive.zip'] },
  { name: 'table', presses: ['row:data.csv'] },
  { name: 'help', presses: ['help'] },
]

const SEATS = [
  { name: 'docked, terminal', surface: 'terminal', placement: 'dock', isFullscreen: true, pad: 1 },
  { name: 'docked, desktop', surface: 'desktop', placement: 'dock', isFullscreen: true, pad: 1 },
  { name: 'inline, classic', surface: 'terminal', placement: 'inline', isFullscreen: false, pad: 0 },
] as const

describe('rows fit the body at every width', () => {
  for (const seat of SEATS) {
    for (const view of VIEWS) {
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

        for (const bodyColumns of WIDTHS) {
          await ui.redraw({ ...pane.props, bodyColumns })

          const drawn = await ui.drawn()
          const columns = bodyColumns - seat.pad
          const hotkeys = hotkeysOf(drawn)

          expect(drawn.type, `${bodyColumns} columns: drawn by the plugin`).not.toBe('engine')
          expect(overflowsOf(drawn, columns), `${bodyColumns} columns`).toEqual([])
          expect(new Set(hotkeys).size, `${bodyColumns} columns: one Button a hotkey`).toBe(hotkeys.length)
        }

        await ui.unmount()
      })
    }
  }
})

describe('a narrow header', () => {
  test('keeps every key working with its labels hidden', async ($, on) => {
    stubProject(on)
    await openTree($, true)

    const ui = await $.ui.mount({
      plugin: 'file-explorer',
      component: 'Pane',
      requestId: 'file-explorer',
      surface: 'terminal',
      viewport: { columns: 160, rows: 40, isFullscreen: true },
      props: {
        title: 'Explorer',
        isFocused: true,
        bodyColumns: 24,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })

    // At 24 columns the header draws `e c r  h: help`: e is a hidden Button
    expect(await ui.find({ type: 'Text', text: 'e c r' })).toBeDefined()
    expect(await ui.find({ key: 'help' })).toMatchObject({ props: { label: 'help' } })

    await ui.press({ key: 'expand-level' })
    expect(await ui.find({ key: `row:${DEEP[0]}/${DEEP[1]}` })).toBeDefined()

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
