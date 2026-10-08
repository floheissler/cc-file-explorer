import type { FsEntry, On } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { testPathOf } from './host'
import Limits from '../hooks/limits'
import { filterKeyOf, TIP_SHOWN_KEY } from '../hooks/names'
import {
  cappedFolders,
  droppedKeysOf,
  savedAtIn,
  savedKeyOf,
  savedRecordOf,
  savedViewIn,
  type SavedView,
} from '../hooks/saved'

const ROOT = '/work'
const KEY = 'expanded:/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * A project two folders deep, by absolute path.
 */
const FOLDERS: Record<string, FsEntry[]> = {
  [ROOT]: [entry('docs', 'dir'), entry('src', 'dir'), entry('README.md', 'file', 7)],
  [`${ROOT}/docs`]: [entry('guide.md', 'file', 7)],
  [`${ROOT}/src`]: [entry('lib', 'dir'), entry('main.ts', 'file', 7)],
  [`${ROOT}/src/lib`]: [entry('util.ts', 'file', 7)],
}

/**
 * The project's files, by absolute path: any other path is missing.
 */
const FILES = new Set(
  Object.entries(FOLDERS).flatMap(([dir, entries]) =>
    entries.filter(each => each.kind === 'file').map(each => `${dir}/${each.name}`),
  ),
)

const PANE = {
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

const tree = ($: Engine) =>
  $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

/**
 * The project on a stubbed disk under `root`, and the pane's open state as
 * the engine reports it: `/tree` opens a closed pane and closes a shown one.
 */
function projectOf(on: On, root: string = ROOT) {
  const pane = { isOpen: false }

  // The open pane's polls wait on the clock, which no test here moves
  mock.clock(on)
  on('session.root', () => ({ value: root }))
  on('ui.panes', () => ({
    value: pane.isOpen
      ? [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }]
      : [],
  }))
  on('ui.open', () => {
    pane.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    pane.isOpen = false

    return { value: undefined }
  })
  on('fs.list', ($, e) => ({ value: FOLDERS[testPathOf(e.path)] ?? [] }))
  on('fs.stat', ($, e) => {
    const path = testPathOf(e.path)

    if (!(path in FOLDERS) && !FILES.has(path)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
    }

    return { value: { kind: path in FOLDERS ? 'dir' : 'file', size: 7, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', () => ({ value: 'content' }))

  return pane
}

/**
 * Waits until `isDone` holds, a drawing at a time: the pane reads a restored
 * preview's file as it draws.
 */
async function until(
  ui: { readonly find: Mounted['find']; readonly redraw: () => Promise<void> },
  isDone: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (await isDone()) {
      return
    }

    await ui.redraw()
  }

  throw new Error(`waited too long for ${what}`)
}

/**
 * The view saved under a key, as the store holds it.
 */
const viewIn = (store: Map<string, unknown>, key: string = KEY) =>
  store.get(key) as Partial<SavedView & { savedAt: number }> | undefined

/**
 * The store in memory, as `mock.store` keeps it but handed back: the test
 * reads what the mod saved, and writes to it as another session would.
 */
function storeOf(on: On, entries: Readonly<Record<string, unknown>> = {}): Map<string, unknown> {
  const saved = new Map(Object.entries(entries))

  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...saved.keys()] }))

  return saved
}

const foldersIn = (store: Map<string, unknown>, key: string = KEY) => viewIn(store, key)?.expanded

describe('savedKeyOf', () => {
  test('one key for every spelling of a root', async () => {
    expect(savedKeyOf('/work')).toBe(KEY)
    expect(savedKeyOf('/work/')).toBe(KEY)
    expect(savedKeyOf('C:\\Proj\\')).toBe(savedKeyOf('c:/proj'))
    expect(savedKeyOf('/home/me/Cafe\u0301')).toBe(savedKeyOf('/home/me/Caf\u00e9'))
  })

  test('a POSIX root keeps its case', async () => {
    expect(savedKeyOf('/home/me/Proj')).not.toBe(savedKeyOf('/home/me/proj'))
  })
})

describe('cappedFolders', () => {
  test('keeps each folder once, in the order given', async () => {
    expect(cappedFolders(['src', 'docs', 'src', 'src/lib'], 1_000)).toEqual(['src', 'docs', 'src/lib'])
  })

  test('keeps the shallowest folders within the budget of JSON characters', async () => {
    const open = ['a/b/c', 'a', 'a/b']

    // ["a","a/b","a/b/c"] is 19 characters
    expect(cappedFolders(open, 19)).toEqual(open)
    expect(cappedFolders(open, 18)).toEqual(['a', 'a/b'])
    expect(cappedFolders(open, 4)).toEqual([])
  })

  test('counts a name as JSON spells it', async () => {
    // ["a\"b"] takes 8 characters, and ["a\u0001"] 11
    expect(cappedFolders(['a"b'], 8)).toEqual(['a"b'])
    expect(cappedFolders(['a"b'], 7)).toEqual([])
    expect(cappedFolders(['a\u0001'], 11)).toEqual(['a\u0001'])
    expect(cappedFolders(['a\u0001'], 10)).toEqual([])
  })
})

describe('savedRecordOf', () => {
  const view: SavedView = {
    expanded: ['src', 'src/lib'],
    selected: 'src/main.ts',
    pinned: true,
    markdownMode: 'source',
  }

  test('saves the folders, the preview’s file, pin and Markdown mode, and the time', async () => {
    expect(savedRecordOf(view, 1234)).toEqual({ ...view, savedAt: 1234 })
  })

  test('a closed preview saves no pin', async () => {
    expect(savedRecordOf({ ...view, selected: null }, 1)).toMatchObject({ selected: null, pinned: false })
  })

  test('stays within MAX_SAVED_CHARS however many folders are open', async () => {
    const open = Array.from({ length: 2_000 }, (_, at) => `folder-${String(at).padStart(4, '0')}/inner`)
    const record = savedRecordOf({ ...view, expanded: open }, 0)

    expect(JSON.stringify(record.expanded).length + JSON.stringify(record.selected).length).toBeLessThanOrEqual(
      Limits.MAX_SAVED_CHARS,
    )
    expect(record.expanded.length).toBeGreaterThan(0)
    expect(record.selected).toBe('src/main.ts')
  })

  test('the file takes its share of the budget first', async () => {
    // The file's JSON leaves room for ["a"] and no more
    const selected = `${'f'.repeat(Limits.MAX_SAVED_CHARS - '["a"]'.length - '""'.length)}`
    const record = savedRecordOf({ ...view, expanded: ['a', 'b'], selected }, 0)

    expect(record.selected).toBe(selected)
    expect(record.expanded).toEqual(['a'])

    // A file past the budget alone is not saved, nor its pin
    const longer = savedRecordOf({ ...view, expanded: ['a'], selected: 'f'.repeat(Limits.MAX_SAVED_CHARS) }, 0)

    expect(longer).toMatchObject({ expanded: ['a'], selected: null, pinned: false })
  })
})

describe('savedViewIn', () => {
  test('reads the view of a saved record', async () => {
    const stored = { expanded: ['src', 'src/lib'], selected: 'src/main.ts', pinned: true, markdownMode: 'source', savedAt: 1 }

    expect(savedViewIn(stored, ROOT)).toEqual({
      expanded: ['src', 'src/lib'],
      selected: 'src/main.ts',
      pinned: true,
      markdownMode: 'source',
    })
  })

  test('a record of folders alone, as older versions saved, opens no preview', async () => {
    expect(savedViewIn({ expanded: ['src'], savedAt: 1 }, ROOT)).toEqual({
      expanded: ['src'],
      selected: null,
      pinned: false,
      markdownMode: 'rendered',
    })
  })

  test('a value that is no record of folders holds none', async () => {
    const values = [undefined, null, 'src', ['src'], { expanded: 'src' }, {}, { selected: 'README.md' }]

    expect(values.map(value => savedViewIn(value, ROOT))).toEqual(values.map(() => null))
  })

  test('leaves out entries that cannot be folder keys', async () => {
    const stored = { expanded: ['src', 7, '', '/abs', 'a//b', '../up', 'a/./b', 'trail/', 'docs'], savedAt: 1 }

    expect(savedViewIn(stored, ROOT)?.expanded).toEqual(['src', 'docs'])
  })

  test('previews no file that cannot be one under the root, and drops its pin', async () => {
    const read = (selected: unknown, root: string = ROOT) =>
      savedViewIn({ expanded: [], selected, pinned: true }, root)

    for (const selected of [7, '', '/etc/passwd', '../up.txt', 'a//b', 'trail/']) {
      expect(read(selected)).toMatchObject({ selected: null, pinned: false })
    }

    // Under Windows, `\` separates: a key that climbs out by it is refused
    expect(read('..\\secret.txt', 'C:\\Proj')).toMatchObject({ selected: null, pinned: false })
    expect(read('src\\..\\..\\secret.txt', 'C:\\Proj')).toMatchObject({ selected: null })
    expect(read('src/main.ts', 'C:\\Proj')).toMatchObject({ selected: 'src/main.ts', pinned: true })

    // On POSIX, `\` is part of a name
    expect(read('odd\\name.txt')).toMatchObject({ selected: 'odd\\name.txt', pinned: true })
  })

  test('a pin without a file, or a pin or mode of another type, reads as the default', async () => {
    expect(savedViewIn({ expanded: [], selected: null, pinned: true }, ROOT)).toMatchObject({ pinned: false })
    expect(savedViewIn({ expanded: [], selected: 'README.md', pinned: 'yes' }, ROOT)).toMatchObject({
      pinned: false,
    })
    expect(savedViewIn({ expanded: [], markdownMode: 'raw' }, ROOT)).toMatchObject({ markdownMode: 'rendered' })
  })
})

describe('savedAtIn', () => {
  test('reads the time, and minus infinity where there is none', async () => {
    expect(savedAtIn({ expanded: [], savedAt: 42 })).toBe(42)
    expect(savedAtIn({ expanded: [] })).toBe(Number.NEGATIVE_INFINITY)
    expect(savedAtIn({ savedAt: '42' })).toBe(Number.NEGATIVE_INFINITY)
    expect(savedAtIn('garbage')).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('droppedKeysOf', () => {
  const saved = [
    { key: 'b', savedAt: 20 },
    { key: 'a', savedAt: 10 },
    { key: 'broken', savedAt: Number.NEGATIVE_INFINITY },
    { key: 'c', savedAt: 30 },
  ]

  test('drops nothing within the cap', async () => {
    expect(droppedKeysOf(saved, 4)).toEqual([])
    expect(droppedKeysOf(saved, 9)).toEqual([])
  })

  test('drops the projects saved longest ago, an unreadable one first', async () => {
    expect(droppedKeysOf(saved, 3)).toEqual(['broken'])
    expect(droppedKeysOf(saved, 2)).toEqual(['broken', 'a'])
    expect(droppedKeysOf(saved, 0)).toEqual(['broken', 'a', 'b', 'c'])
  })
})

describe('the open folders, kept per project', () => {
  test('every change saves them for the project', async ($, on) => {
    const store = storeOf(on)
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'row:src' })
    expect(foldersIn(store)).toEqual(['src'])

    await ui.press({ key: 'row:src/lib' })
    expect(foldersIn(store)).toEqual(['src', 'src/lib'])
    expect(savedAtIn(store.get(KEY))).toBeGreaterThan(0)

    // The level keys save too
    await ui.press({ key: 'collapse-level' })
    expect(foldersIn(store)).toEqual(['src'])
    await ui.press({ key: 'depth-0' })
    expect(foldersIn(store)).toEqual([])
    await ui.press({ key: 'expand-level' })
    expect(foldersIn(store)).toEqual(['docs', 'src'])

    await ui.unmount()
  })

  test('a new session opens the tree where the project’s last one left it', async ($, on) => {
    mock.store(on, { [KEY]: { expanded: ['src', 'src/lib'], savedAt: 1 } })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ key: 'row:src/lib/util.ts' })).toBeDefined()
    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeUndefined()

    await ui.unmount()
  })

  test('a root spelled with a trailing separator finds the same folders', async ($, on) => {
    mock.store(on, { [KEY]: { expanded: ['docs'], savedAt: 1 } })
    projectOf(on, `${ROOT}/`)
    await tree($)

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeDefined()

    await ui.unmount()
  })

  test('saved folders that are gone stay closed', async ($, on) => {
    mock.store(on, { [KEY]: { expanded: ['gone', 'src', 'gone/deeper'], savedAt: 1 } })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()
    expect(await ui.find({ key: 'row:gone' })).toBeUndefined()

    await ui.unmount()
  })

  test('later opens keep the folders this session left open', async ($, on) => {
    const store = storeOf(on, { [KEY]: { expanded: ['src'], savedAt: 1 } })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'depth-0' })
    await tree($)

    // Another session in the project saves its own folders meanwhile
    store.set(KEY, { expanded: ['docs'], savedAt: 2 })
    await tree($)
    await ui.redraw()

    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()
    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeUndefined()

    await ui.unmount()
  })

  test('a first /tree <path> opens the saved folders and the path’s, and saves both', async ($, on) => {
    const store = storeOf(on, { [KEY]: { expanded: ['docs'], savedAt: 1 } })
    const toasts: string[] = []

    projectOf(on)
    on('ui.toast', ($, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })

    // No git work tree: the tree carries no markers
    on('process.run', () => ({
      value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))

    await $.command.run({
      command: 'tree',
      args: 'src/lib/util.ts',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

    const ui = await $.ui.mount(PANE)

    expect(toasts).toEqual([])
    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeDefined()
    expect(await ui.find({ key: 'row:src/lib/util.ts' })).toBeDefined()
    expect(foldersIn(store)).toEqual(['docs', 'src', 'src/lib'])

    await ui.unmount()
  })

  test('after /clear, /resume or /branch the tree opens where the folders were saved', async ($, on) => {
    mock.store(on, { [KEY]: { expanded: ['docs'], savedAt: 1 } })
    projectOf(on)
    on('classic.SessionStart', () => ({}))

    // A test starts with the state at its default, as /clear leaves it
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeDefined()

    await ui.unmount()
  })

  test('the store keeps MAX_SAVED_PROJECTS projects, dropping the one saved longest ago', async ($, on) => {
    const others = Array.from({ length: Limits.MAX_SAVED_PROJECTS }, (_, at) => [
      `expanded:/p${String(at).padStart(2, '0')}`,
      { expanded: ['src'], savedAt: 1_000 + at },
    ])

    const store = storeOf(on, { [TIP_SHOWN_KEY]: true, ...Object.fromEntries(others) })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'row:src' })

    const projects = [...store.keys()].filter(key => key.startsWith('expanded:'))

    expect(projects).toHaveLength(Limits.MAX_SAVED_PROJECTS)
    expect(projects).toContain(KEY)
    expect(projects).not.toContain('expanded:/p00')
    expect(projects).toContain('expanded:/p01')
    expect(store.get(TIP_SHOWN_KEY)).toBe(true)

    await ui.unmount()
  })

  test('a filtered tree’s folders are its own; showing its pick in the whole tree saves', async ($, on) => {
    const store = storeOf(on, { [KEY]: { expanded: ['docs'], savedAt: 1 } })
    projectOf(on)

    // No git work tree: the filter walks the folders
    on('process.run', () => ({
      value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'filter' })
    await ui.input({ key: filterKeyOf(0), text: 'util' })
    expect(await ui.find({ key: 'row:src/lib/util.ts' })).toBeDefined()

    await ui.press({ key: 'row:src/lib' })
    await ui.press({ key: 'row:src/lib' })
    expect(foldersIn(store)).toEqual(['docs'])

    // Closing the filter opens the pick's folders in the whole tree
    await ui.press({ key: 'row:src/lib/util.ts' })
    await ui.press({ key: 'filter' })
    expect(foldersIn(store)).toEqual(['docs', 'src', 'src/lib'])

    await ui.unmount()
  })

  test('folders open and close when the store fails', async ($, on) => {
    on('store.get', () => {
      throw new Error('store unreadable')
    })
    on('store.set', () => {
      throw new Error('store full')
    })
    on('store.keys', () => ({ value: [] }))
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'row:src' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()

    await ui.unmount()
  })
})

describe('the preview, kept per project', () => {
  test('every change of its file, pin and Markdown mode saves them', async ($, on) => {
    const store = storeOf(on)
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'row:README.md' })
    expect(viewIn(store)).toMatchObject({ selected: 'README.md', pinned: false, markdownMode: 'rendered' })

    await ui.press({ key: 'preview-pin' })
    expect(viewIn(store)).toMatchObject({ selected: 'README.md', pinned: true })

    await ui.press({ key: 'preview-mode' })
    expect(viewIn(store)).toMatchObject({ markdownMode: 'source' })

    // Closing the preview lets go of its pin; the mode stays
    await ui.press({ key: 'preview-close' })
    expect(viewIn(store)).toMatchObject({ selected: null, pinned: false, markdownMode: 'source' })

    await ui.unmount()
  })

  test('a new session opens the preview where the project’s last one left it', async ($, on) => {
    mock.store(on, {
      [KEY]: { expanded: ['docs'], selected: 'docs/guide.md', pinned: true, markdownMode: 'source', savedAt: 1 },
    })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    // The file as source, pinned, its row in the tree
    await until(ui, async () => (await ui.find({ type: 'Code' })) !== undefined, 'the saved file')
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { language: 'markdown' } })
    expect(await ui.find({ type: 'Text', text: 'guide.md' })).toBeDefined()
    expect(await ui.find({ key: 'preview-pin' })).toMatchObject({ props: { label: 'unpin' } })
    expect(await ui.find({ key: 'row:docs/guide.md' })).toBeDefined()

    await ui.unmount()
  })

  test('a saved file that is gone opens no preview, nor its pin', async ($, on) => {
    const store = storeOf(on, {
      [KEY]: { expanded: ['src'], selected: 'src/gone.ts', pinned: true, markdownMode: 'rendered', savedAt: 1 },
    })
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()
    expect(await ui.find({ key: 'preview-close' })).toBeUndefined()

    // A file picked then pins no more
    await ui.press({ key: 'row:src/main.ts' })
    expect(viewIn(store)).toMatchObject({ selected: 'src/main.ts', pinned: false })

    await ui.unmount()
  })

  test('later opens keep this session’s preview, though its first found nothing saved', async ($, on) => {
    const store = storeOf(on)
    projectOf(on)
    await tree($)

    const ui = await $.ui.mount(PANE)

    await ui.press({ key: 'row:README.md' })

    // Another session in the project saves its own view meanwhile
    store.set(KEY, { expanded: ['src'], selected: 'src/main.ts', pinned: false, markdownMode: 'rendered', savedAt: 2 })
    await tree($)
    await tree($)

    const isPreviewed = async () =>
      (await ui.find({ type: 'Markdown' })) !== undefined || (await ui.find({ type: 'Code' })) !== undefined

    await until(ui, isPreviewed, 'the preview')
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()

    await ui.unmount()
  })

  test('after /clear, /resume or /branch the preview opens where it was saved', async ($, on) => {
    mock.store(on, {
      [KEY]: { expanded: ['src'], selected: 'src/main.ts', pinned: false, markdownMode: 'rendered', savedAt: 1 },
    })
    projectOf(on)
    on('classic.SessionStart', () => ({}))

    await $.classic.SessionStart({ source: 'resume' })

    const ui = await $.ui.mount(PANE)

    await until(ui, async () => (await ui.find({ type: 'Code' })) !== undefined, 'the saved file')
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: 'src/main.ts' } })

    await ui.unmount()
  })
})
