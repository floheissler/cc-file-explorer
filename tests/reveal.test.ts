import type { FsEntry, On, PaneOpenArgs } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

import { testPathOf } from './host'
import { findEntry, revealPathsOf, rowsRevealing } from '../hooks/reveal'
import type { DirListing, Entry } from '../hooks/tree'

const dir = (path: string): Entry => ({ name: path.split('/').pop() ?? path, path, kind: 'dir', size: 0 })
const file = (path: string): Entry => ({ name: path.split('/').pop() ?? path, path, kind: 'file', size: 1 })
const listed = (...entries: Entry[]): DirListing => ({ entries, truncated: 0 })

describe('revealPathsOf', () => {
  test('takes the whole text as one path, trimmed and unquoted', async () => {
    expect(revealPathsOf('')).toEqual([])
    expect(revealPathsOf('   ')).toEqual([])
    expect(revealPathsOf('src/main.ts')).toEqual(['src/main.ts'])
    expect(revealPathsOf('  "my notes/a b.md" ')).toEqual(['my notes/a b.md'])
    expect(revealPathsOf("'a b'")).toEqual(['a b'])
    expect(revealPathsOf('notes#L10')).toEqual(['notes#L10'])
  })

  test('reads a mention as the prompt spells one, then tries it as typed', async () => {
    expect(revealPathsOf('@src/main.ts')).toEqual(['src/main.ts', '@src/main.ts'])
    expect(revealPathsOf('@"my dir/a b.md"')).toEqual(['my dir/a b.md', '@"my dir/a b.md"'])
    expect(revealPathsOf('"@src/a.ts"')).toEqual(['src/a.ts', '@src/a.ts'])
    expect(revealPathsOf('@src/a.ts#L10-20')).toEqual(['src/a.ts', '@src/a.ts#L10-20'])
    expect(revealPathsOf('@')).toEqual(['@'])
  })
})

describe('findEntry', () => {
  /**
   * A disk of listings by folder; each folder `findEntry` reads is recorded.
   */
  function diskOf(listings: Record<string, DirListing>) {
    const reads: string[] = []

    return {
      reads,
      readDir: async (path: string) => {
        reads.push(path)

        return listings[path]
      },
    }
  }

  const PROJECT = {
    '': listed(dir('Café'), dir('src'), file('README.md'), file('Readme.md')),
    'Café': listed(file('Café/menu.md')),
    src: listed(file('src/main.ts')),
  }

  test('finds an entry folder by folder, reading each on the way', async () => {
    const { reads, readDir } = diskOf(PROJECT)

    expect(await findEntry('src/main.ts', 'posix', readDir)).toEqual(file('src/main.ts'))
    expect(reads).toEqual(['', 'src'])
    expect(await findEntry('src', 'posix', readDir)).toEqual(dir('src'))
  })

  test('takes the name spelled the same first, then one the platform takes for it', async () => {
    const { readDir } = diskOf(PROJECT)

    expect(await findEntry('SRC/MAIN.TS', 'win32', readDir)).toEqual(file('src/main.ts'))
    expect(await findEntry('Readme.md', 'win32', readDir)).toEqual(file('Readme.md'))
    expect(await findEntry('readme.md', 'win32', readDir)).toEqual(file('README.md'))
    expect(await findEntry('Café/menu.md', 'posix', readDir)).toEqual(file('Café/menu.md'))
    expect(await findEntry('SRC/main.ts', 'posix', readDir)).toBeNull()
  })

  test('finds nothing past a file, in a folder it cannot read, or for a name no entry has', async () => {
    const { readDir } = diskOf({ ...PROJECT, src: { error: 'EACCES' } })

    expect(await findEntry('README.md/x', 'posix', readDir)).toBeNull()
    expect(await findEntry('src/main.ts', 'posix', readDir)).toBeNull()
    expect(await findEntry('nope.md', 'posix', readDir)).toBeNull()
    expect(await findEntry('.git/config', 'posix', readDir)).toBeNull()
  })
})

describe('rowsRevealing', () => {
  const files = (folder: string, count: number) =>
    Array.from({ length: count }, (_, at) => file(`${folder}/f${String(at).padStart(2, '0')}.txt`))

  /**
   * a/ (20 files), m/ (10 files) and z/z.txt, every folder open; only the
   * root and z are read at the start.
   */
  function disk() {
    const all: Record<string, DirListing> = {
      '': listed(dir('a'), dir('m'), dir('z')),
      a: listed(...files('a', 20)),
      m: listed(...files('m', 10)),
      z: listed(file('z/z.txt')),
    }

    const read = new Map<string, DirListing>([
      ['', all[''] as DirListing],
      ['z', all.z as DirListing],
    ])

    const reads: string[][] = []

    return {
      reads,
      listingOf: (path: string) => read.get(path),
      readDirs: async (dirs: readonly string[]) => {
        reads.push([...dirs])
        dirs.forEach(path => read.set(path, all[path] as DirListing))
      },
    }
  }

  test('reads the open folders above the row before placing it', async () => {
    const { reads, listingOf, readDirs } = disk()

    const { rows, index } = await rowsRevealing(listingOf, new Set(['a', 'm', 'z']), 'z/z.txt', readDirs)

    expect(reads).toEqual([['a', 'm']])
    expect(index).toBe(33)
    expect(rows[index]).toMatchObject({ type: 'entry', path: 'z/z.txt' })
  })

  test('leaves the open folders below the row unread', async () => {
    const { reads, listingOf, readDirs } = disk()

    const { index } = await rowsRevealing(listingOf, new Set(['m', 'z']), 'm', readDirs)

    expect(reads).toEqual([])
    expect(index).toBe(1)
  })
})

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 9): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * The pane docked on the terminal, as in pane.test.ts.
 */
const DOCK = {
  plugin: 'file-explorer',
  component: 'Pane',
  requestId: 'file-explorer',
  surface: 'terminal',
  viewport: { columns: 160, rows: 34, isFullscreen: true },
  props: {
    title: 'Explorer',
    isFocused: true,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/**
 * The pane inline above the prompt under the classic renderer, as in
 * inline.test.ts.
 */
const INLINE = {
  ...DOCK,
  viewport: { columns: 80, rows: 24, isFullscreen: false },
  props: { ...DOCK.props, bodyColumns: 76, placement: 'inline', scroll: { offset: 0, bodyRows: 12 } },
} as const

const DOCKING = { isFullscreen: true, columns: 160 } as const
const CLASSIC = { isFullscreen: false, columns: 80 } as const

const tree = ($: Engine, args: string, presentation: typeof DOCKING | typeof CLASSIC = DOCKING) =>
  $.command.run({ command: 'tree', args, origin: { kind: 'composer' }, presentation })

/**
 * A project on the stubbed disk, by absolute path, and what the mod asks of
 * the engine: each open, close and toast, and the pane's open state as the
 * engine reports it, false until a test says otherwise.
 */
function projectOf(
  on: On,
  folders: Record<string, FsEntry[]>,
  options: { readonly realPaths?: Record<string, string> } = {},
) {
  const pane = { isOpen: false }
  const opens: PaneOpenArgs[] = []
  const closes: string[] = []
  const toasts: string[] = []

  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({
    value: pane.isOpen
      ? [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: false, isPlaced: true, plugin: 'file-explorer' }]
      : [],
  }))
  on('ui.open', ($, e) => {
    opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closes.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ value: folders[testPathOf(e.path)] ?? [] }))
  on('fs.stat', ($, e) => {
    const realPath = e.resolve ? options.realPaths?.[testPathOf(e.path)] : undefined

    return { value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false, ...(realPath === undefined ? {} : { realPath }) } }
  })
  on('fs.read', ($, e) => ({ value: testPathOf(e.path).endsWith('.md') ? '# Hello\n\nSome **text**\n' : 'const a = 1' }))

  return { pane, opens, closes, toasts }
}

const SMALL: Record<string, FsEntry[]> = {
  [ROOT]: [entry('@types', 'dir'), entry('src', 'dir'), entry('README.md', 'file'), entry('a.txt', 'file')],
  [`${ROOT}/src`]: [entry('main.ts', 'file')],
  [`${ROOT}/@types`]: [entry('index.d.ts', 'file')],
}

/**
 * The person moving the pane's focus ring onto one of its elements.
 */
const ringOnto = (element: string) =>
  ({
    component: 'Pane',
    requestId: 'file-explorer',
    plugin: 'file-explorer',
    element,
    origin: { kind: 'person' },
  }) as const

describe('/tree <path>', () => {
  test('opens the pane onto a file: its folders open, previewed, its row taking the ring', async ($, on) => {
    const { opens, toasts } = projectOf(on, SMALL)

    await tree($, 'src/main.ts')

    const ui = await $.ui.mount(DOCK)

    expect(opens).toHaveLength(1)
    expect(toasts).toEqual([])
    expect(await ui.find({ key: 'row:src/main.ts' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ key: 'row:README.md' })).not.toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('opens a folder in place, previewing nothing', async ($, on) => {
    projectOf(on, SMALL)

    await tree($, 'src/')

    const ui = await $.ui.mount(DOCK)

    expect(await ui.find({ key: 'row:src' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.unmount()
  })

  test('takes a mention, quoted or not, and a name that starts with @', async ($, on) => {
    projectOf(on, SMALL)

    await tree($, '@"src/main.ts"')

    let ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:src/main.ts' })).toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()

    await tree($, '@types/index.d.ts')

    ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:@types/index.d.ts' })).toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('takes an absolute path, and one spelled through a link', async ($, on) => {
    projectOf(on, SMALL, {
      realPaths: { '/alias/work/src/main.ts': `${ROOT}/src/main.ts`, [ROOT]: ROOT },
    })

    await tree($, `${ROOT}/README.md`)

    let ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:README.md' })).toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()

    await tree($, '/alias/work/src/main.ts')

    ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:src/main.ts' })).toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('says so for a path the tree does not list, and opens as usual', async ($, on) => {
    const { opens, toasts } = projectOf(on, SMALL)

    await tree($, 'src/nope.ts')
    await tree($, '/elsewhere/x.txt')
    await tree($, '.git/config')

    expect(toasts).toEqual([
      'Not in the tree: src/nope.ts',
      'Outside the project: /elsewhere/x.txt',
      'Not in the tree: .git/config',
    ])
    expect(opens).toHaveLength(3)

    const ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:README.md' })).toBeDefined()
    await ui.unmount()
  })

  test('the root shows the tree from its top', async ($, on) => {
    const { toasts } = projectOf(on, SMALL)

    await tree($, '.')

    const ui = await $.ui.mount(DOCK)
    expect(toasts).toEqual([])
    expect(await ui.find({ key: 'row:@types' })).toBeDefined()
    await ui.unmount()
  })

  test('moves the window to a row far down the tree', async ($, on) => {
    const names = Array.from({ length: 30 }, (_, at) => `d${String(at).padStart(2, '0')}`)

    projectOf(on, {
      [ROOT]: names.map(name => entry(name, 'dir')),
      [`${ROOT}/d27`]: [entry('x.txt', 'file')],
    })

    await tree($, 'd27/x.txt')

    const ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:d27/x.txt' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ key: 'row:d00' })).toBeUndefined()
    await ui.unmount()
  })

  test('reads the open folders above the row first, so the window lands on it', async ($, on) => {
    projectOf(on, {
      [ROOT]: [entry('a', 'dir'), entry('z', 'dir')],
      [`${ROOT}/a`]: Array.from({ length: 40 }, (_, at) => entry(`f${String(at).padStart(2, '0')}.txt`, 'file')),
      [`${ROOT}/z`]: [entry('z.txt', 'file')],
    })

    // `a` stays open, but a pane opened afresh has read none of it
    await tree($, '')
    let ui = await $.ui.mount(DOCK)
    await ui.press({ key: 'row:a' })
    await ui.unmount()

    await tree($, 'z/z.txt')

    ui = await $.ui.mount(DOCK)
    expect(await ui.find({ key: 'row:z/z.txt' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ key: 'row:a/f00.txt' })).toBeUndefined()
    await ui.unmount()
  })

  test('in a shown pane, reveals in place, never closing it, and moves the window no more than needed', async ($, on) => {
    const names = Array.from({ length: 20 }, (_, at) => `f${String(at).padStart(2, '0')}.txt`)
    const { pane, closes } = projectOf(on, { [ROOT]: names.map(name => entry(name, 'file')) })

    await tree($, '')
    pane.isOpen = true

    const ui = await $.ui.mount(DOCK)

    await tree($, 'f03.txt')
    await ui.redraw()

    expect(closes).toEqual([])
    expect(await ui.find({ key: 'row:f03.txt' })).toMatchObject({ props: { autoFocus: true } })
    expect(await ui.find({ key: 'row:f00.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.unmount()
  })

  test('the revealed row gives up the ring as the person moves it, or picks a file', async ($, on) => {
    projectOf(on, SMALL)
    on('ui.focus', () => ({}))

    await tree($, 'src')

    let ui = await $.ui.mount(DOCK)
    await $.ui.focus(ringOnto('row:README.md'))
    await ui.redraw()
    expect(await ui.find({ key: 'row:src' })).not.toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()

    await tree($, 'src')

    ui = await $.ui.mount(DOCK)
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ key: 'row:src' })).not.toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('inline, opens straight into the file, and steps back onto its row', async ($, on) => {
    projectOf(on, SMALL)

    await tree($, 'README.md', CLASSIC)

    const ui = await $.ui.mount(INLINE)

    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'row:a.txt' })).toBeUndefined()

    await ui.press({ key: 'preview-close' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    expect(await ui.find({ key: 'row:README.md' })).toMatchObject({ props: { autoFocus: true } })
    await ui.unmount()
  })

  test('/tree registers with a [path] hint', async ($, on) => {
    const registered: unknown[] = []

    projectOf(on, SMALL)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => {
      registered.push(e)

      return { value: { command: e.name } }
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })

    expect(registered).toEqual([expect.objectContaining({ name: 'tree', argumentHint: '[path]' })])
  })
})
