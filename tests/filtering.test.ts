import type { FsEntry, On, ProcessRunResult } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { testPathOf } from './host'
import Limits from '../hooks/limits'
import { filterKeyOf } from '../hooks/names'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 2): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * A small project on disk, by absolute path, `node_modules` in it.
 */
const FOLDERS: Record<string, FsEntry[]> = {
  [ROOT]: [
    entry('.git', 'dir'),
    entry('docs', 'dir'),
    entry('node_modules', 'dir'),
    entry('src', 'dir'),
    entry('README.md', 'file'),
  ],
  [`${ROOT}/docs`]: [entry('guide.md', 'file')],
  [`${ROOT}/node_modules`]: [entry('left-pad', 'dir')],
  [`${ROOT}/node_modules/left-pad`]: [entry('index.js', 'file')],
  [`${ROOT}/src`]: [entry('components', 'dir'), entry('main.ts', 'file'), entry('util.ts', 'file')],
  [`${ROOT}/src/components`]: [entry('Button.tsx', 'file'), entry('Card.tsx', 'file')],
}

/**
 * What git lists: the files it tracks, and `node_modules`, which it ignores.
 */
const TRACKED = ['README.md', 'docs/guide.md', 'src/components/Button.tsx', 'src/components/Card.tsx', 'src/main.ts', 'src/util.ts']

const nul = (paths: readonly string[]) => paths.map(path => `${path}\0`).join('')

const ran = (exitCode: number, stdout = ''): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Project = {
  /**
   * The files git lists as tracked; a test may change them.
   */
  tracked: string[]
  /**
   * Whether the root is a git work tree.
   */
  isRepo: boolean
  /**
   * Every git argument vector run, in order.
   */
  readonly runs: (readonly string[])[]
}

/**
 * The project on the stubbed disk, git answering for it, and the open pane
 * as the engine reports it.
 *
 * The test kit answers no plugin's own `$.ui.focus` (2.1.294: a test's
 * `ui.focus` hook never sees it), so where the filter puts the focus ring is
 * checked through `firstMatchOf` and live, not here.
 */
function stubProject(on: On): Project {
  const project: Project = { tracked: [...TRACKED], isRepo: true, runs: [] }
  let isOpen = false

  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({
    value: isOpen
      ? [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }]
      : [],
  }))
  on('ui.open', () => {
    isOpen = true

    return { value: { isPlaced: true } }
  })
  on('fs.list', ($, e) => ({ value: FOLDERS[testPathOf(e.path)] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: { kind: FOLDERS[testPathOf(e.path)] === undefined ? 'file' : 'dir', size: 2, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', () => ({ value: 'export {}' }))
  on('process.run', ($, e) => {
    project.runs.push(e.argv)

    if (!project.isRepo) {
      return ran(128)
    }

    if (e.argv.includes('--ignored')) {
      return ran(0, nul(['node_modules/']))
    }

    return ran(0, e.argv.includes('--deleted') ? '' : nul(project.tracked))
  })

  return project
}

const openTree = ($: Engine) =>
  $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

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
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const rowsOf = async (ui: { readonly findAll: (query: { readonly type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' }))
    .map(found => found.key ?? '')
    .filter(key => key.startsWith('row:'))
    .map(key => key.slice('row:'.length))

for (const surface of ['terminal', 'desktop'] as const) {
  test(`filters the tree as the person types, and shows the pick in the whole tree after (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const project = stubProject(on)

    await openTree($)

    const ui = await $.ui.mount(paneOn(surface))

    // `f` shows the filter's field over the whole tree
    await ui.press({ key: 'filter' })
    expect(await ui.find({ key: filterKeyOf(0) })).toMatchObject({ type: 'Input', props: { value: '', label: 'filter' } })
    expect(await ui.find({ key: 'filter' })).toMatchObject({ props: { label: 'clear' } })
    expect(await rowsOf(ui)).toEqual(['docs', 'node_modules', 'src', 'README.md'])

    // The tree narrows once typing pauses
    await ui.input({ key: filterKeyOf(0), text: 'butt', kind: 'change' })
    await ui.redraw()
    expect(await rowsOf(ui)).toEqual(['docs', 'node_modules', 'src', 'README.md'])

    await clock.advance(Limits.FILTER_DEBOUNCE_MS)
    await ui.redraw()
    expect(await rowsOf(ui)).toEqual(['src', 'src/components', 'src/components/Button.tsx'])
    expect(await ui.find({ type: 'Text', text: '1 match' })).toBeDefined()

    // Claude Code empties the field on Enter, so a new one holds the query
    await ui.input({ key: filterKeyOf(0), text: 'butt' })
    expect(await ui.find({ key: filterKeyOf(0) })).toBeUndefined()
    expect(await ui.find({ key: filterKeyOf(1) })).toMatchObject({ props: { value: 'butt' } })

    // A folder closes and opens in the filtered tree alone
    await ui.press({ key: 'row:src/components' })
    expect(await rowsOf(ui)).toEqual(['src', 'src/components'])
    await ui.press({ key: 'row:src/components' })
    await ui.press({ key: 'row:src/components/Button.tsx' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    // `f` again closes the filter: the whole tree, the picked file shown in it
    await ui.press({ key: 'filter' })
    expect(await ui.find({ key: filterKeyOf(1) })).toBeUndefined()
    expect(await rowsOf(ui)).toEqual([
      'docs',
      'node_modules',
      'src',
      'src/components',
      'src/components/Button.tsx',
      'src/components/Card.tsx',
      'src/main.ts',
      'src/util.ts',
      'README.md',
    ])

    // git listed the files; git alone ran, and only to read: the filter's
    // list and the markers' status
    const reads = ['ls-files', 'rev-parse', 'status']

    expect(project.runs.some(argv => argv[1] === 'ls-files')).toBe(true)
    expect(project.runs.every(argv => argv[0] === 'git' && reads.includes(argv[1] ?? ''))).toBe(true)

    await ui.unmount()
  })
}

test('/tree <path> closes the filter and reveals the entry in the whole tree', async ($, on) => {
  const clock = mock.clock(on)
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: 'butt', kind: 'change' })
  await clock.advance(Limits.FILTER_DEBOUNCE_MS)
  await ui.redraw()
  expect(await rowsOf(ui)).toEqual(['src', 'src/components', 'src/components/Button.tsx'])

  // docs/guide.md matches no query typed: it shows in the whole tree
  await $.command.run({
    command: 'tree',
    args: 'docs/guide.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await ui.redraw()

  expect(await ui.find({ key: filterKeyOf(0) })).toBeUndefined()
  expect(await ui.find({ key: 'row:docs/guide.md' })).toMatchObject({ props: { autoFocus: true } })
  expect(await rowsOf(ui)).toEqual(['docs', 'docs/guide.md', 'node_modules', 'src', 'README.md'])
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()

  await ui.unmount()
})

test('Enter with nothing typed closes the filter', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: '' })
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ key: 'filter' })).toMatchObject({ props: { label: 'filter' } })

  await ui.unmount()
})

test('finds a folder git ignores by its name, not by what it holds', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: 'node' })
  expect(await rowsOf(ui)).toEqual(['node_modules'])

  await ui.input({ key: filterKeyOf(1), text: 'left-pad' })
  expect(await rowsOf(ui)).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'No match' })).toBeDefined()

  await ui.unmount()
})

test('outside a git work tree, filters what a walk of the folders finds', async ($, on) => {
  const project = stubProject(on)

  project.isRepo = false
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: 'index' })
  expect(await rowsOf(ui)).toEqual(['node_modules', 'node_modules/left-pad', 'node_modules/left-pad/index.js'])

  await ui.unmount()
})

test('the level keys work on the filtered tree, and leave the whole tree as it was', async ($, on) => {
  stubProject(on)
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: '.ts' })
  expect(await rowsOf(ui)).toEqual(['src', 'src/components', 'src/components/Button.tsx', 'src/components/Card.tsx', 'src/main.ts', 'src/util.ts'])

  await ui.press({ key: 'depth-0' })
  expect(await rowsOf(ui)).toEqual(['src'])

  await ui.press({ key: 'depth-1' })
  expect(await rowsOf(ui)).toEqual(['src', 'src/components', 'src/main.ts', 'src/util.ts'])

  await ui.press({ key: 'expand-level' })
  expect(await rowsOf(ui)).toEqual(['src', 'src/components', 'src/components/Button.tsx', 'src/components/Card.tsx', 'src/main.ts', 'src/util.ts'])

  await ui.press({ key: 'filter' })
  expect(await rowsOf(ui)).toEqual(['docs', 'node_modules', 'src', 'README.md'])

  await ui.unmount()
})

test('after Claude writes a file, the filter lists the files again, keeping the folders the person closed', async ($, on) => {
  const clock = mock.clock(on)
  const project = stubProject(on)

  on('tool.call', () => ({ result: 'ran' }))
  await openTree($)

  const ui = await $.ui.mount(paneOn('terminal'))

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: 'util' })
  expect(await rowsOf(ui)).toEqual(['src', 'src/util.ts'])

  await ui.press({ key: 'row:src' })
  expect(await rowsOf(ui)).toEqual(['src'])

  FOLDERS[`${ROOT}/docs`] = [entry('guide.md', 'file'), entry('util-notes.md', 'file')]
  project.tracked = [...TRACKED, 'docs/util-notes.md']

  try {
    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/util-notes.md`, content: '' } as never)
    await clock.advance(Limits.REFRESH_DEBOUNCE_MS)
    await ui.redraw()

    // The new match's folder opens; the one the person closed stays closed
    expect(await rowsOf(ui)).toEqual(['docs', 'docs/util-notes.md', 'src'])
    expect(await ui.find({ type: 'Text', text: '2 matches' })).toBeDefined()
  } finally {
    FOLDERS[`${ROOT}/docs`] = [entry('guide.md', 'file')]
  }

  await ui.unmount()
})

test('inline, a file picked from the filtered tree steps back to it', async ($, on) => {
  stubProject(on)

  await $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

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
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  })

  await ui.press({ key: 'filter' })
  await ui.input({ key: filterKeyOf(0), text: 'guide' })
  await ui.press({ key: 'row:docs/guide.md' })

  // The file stands in for the tree and the filter's row
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()

  await ui.press({ key: 'preview-close' })
  expect(await ui.find({ key: filterKeyOf(1) })).toMatchObject({ props: { value: 'guide' } })
  expect(await rowsOf(ui)).toEqual(['docs', 'docs/guide.md'])

  await ui.unmount()
})
