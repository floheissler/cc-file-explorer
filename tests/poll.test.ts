import type { FsEntry, On } from 'claude-code'
import { describe, expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import { testPathOf } from './host'
import Limits from '../hooks/limits'
import { changedDirsOf, mayHaveWritten, pollBatchOf, shownDirsOf } from '../hooks/poll'
import { flattenTree, type Entry } from '../hooks/tree'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

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

const TREE = {
  command: 'tree',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

/**
 * A disk the test changes behind the pane's back, every call the pane made
 * on it, and the pane's open and shown state as the engine reports it.
 */
function diskOf(on: On, clock: MockClock) {
  const folders: Record<string, FsEntry[]> = {
    [ROOT]: [entry('src', 'dir'), entry('README.md', 'file', 7)],
    [`${ROOT}/src`]: [entry('main.ts', 'file', 1)],
  }

  const files: Record<string, string> = {
    [`${ROOT}/README.md`]: '# Hello',
    [`${ROOT}/src/main.ts`]: 'x',
  }

  const times: Record<string, number> = { [ROOT]: 1, [`${ROOT}/src`]: 1, [`${ROOT}/README.md`]: 1 }
  const calls = { stat: [] as string[], list: [] as string[], panes: 0 }
  const pane = { isOpen: false, isShown: true, statDelayMs: 0 }

  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.panes', () => {
    calls.panes += 1

    return {
      value: pane.isOpen
        ? [
            {
              id: 'file-explorer',
              title: 'Explorer',
              isShown: pane.isShown,
              isFocused: true,
              isPlaced: true,
              plugin: 'file-explorer',
            },
          ]
        : [],
    }
  })
  on('ui.open', () => {
    pane.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    pane.isOpen = false

    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const path = testPathOf(e.path)

    calls.list.push(path)

    return { value: folders[path] ?? [] }
  })
  on('fs.stat', async ($, e) => {
    const path = testPathOf(e.path)

    calls.stat.push(path)

    if (pane.statDelayMs > 0) {
      await clock.sleep(pane.statDelayMs)
    }

    const isDir = folders[path] !== undefined
    const text = files[path]

    if (!isDir && text === undefined) {
      return { deny: `ENOENT: no such file or directory, stat '${path}'` }
    }

    return {
      value: {
        kind: isDir ? 'dir' : 'file',
        size: text?.length ?? 0,
        mtimeMs: times[path] ?? 0,
        isLink: false,
      },
    }
  })
  on('fs.read', ($, e) => ({ value: files[testPathOf(e.path)] ?? '' }))

  return { folders, files, times, calls, pane }
}

async function opened($: Engine) {
  await $.command.run(TREE)

  return $.ui.mount(PANE)
}

describe('polls for changes made outside Claude', () => {
  test('a file created in the root appears after a poll', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const ui = await opened($)

    expect(await ui.find({ key: 'row:NEW.md' })).toBeUndefined()

    disk.folders[ROOT] = [...(disk.folders[ROOT] ?? []), entry('NEW.md', 'file', 3)]
    disk.times[ROOT] = 2
    await clock.advance(Limits.POLL_MS)

    expect(await ui.find({ key: 'row:NEW.md' })).toBeDefined()
  })

  test('lists again only the open folder that changed, and nothing when none did', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const ui = await opened($)

    await ui.press({ key: 'row:src' })
    await clock.advance(Limits.POLL_MS)
    disk.calls.list.length = 0

    disk.folders[`${ROOT}/src`] = [entry('main.ts', 'file', 1), entry('util.ts', 'file', 1)]
    disk.times[`${ROOT}/src`] = 2
    await clock.advance(Limits.POLL_MS)

    expect(disk.calls.list).toEqual([`${ROOT}/src`])
    expect(await ui.find({ key: 'row:src/util.ts' })).toBeDefined()

    disk.calls.list.length = 0
    await clock.advance(Limits.POLL_MS)
    expect(disk.calls.list).toEqual([])
  })

  test('reads the previewed file again when it changes, deleted or back', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const ui = await opened($)

    await ui.press({ key: 'row:README.md' })
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Hello' } })

    disk.files[`${ROOT}/README.md`] = '# Changed'
    disk.times[`${ROOT}/README.md`] = 2
    await clock.advance(Limits.POLL_MS)
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Changed' } })

    // Deleted: the preview stays open with a notice, and comes back with the file
    delete disk.files[`${ROOT}/README.md`]
    await clock.advance(Limits.POLL_MS)
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    expect(await ui.find({ key: 'preview-close' })).toBeDefined()

    disk.files[`${ROOT}/README.md`] = '# Back'
    disk.times[`${ROOT}/README.md`] = 3
    await clock.advance(Limits.POLL_MS)
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Back' } })
  })

  test('re-reads a closed folder that changed when it opens again', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const ui = await opened($)

    await ui.press({ key: 'row:src' })
    await ui.press({ key: 'row:src' })

    disk.folders[`${ROOT}/src`] = [entry('main.ts', 'file', 1), entry('util.ts', 'file', 1)]
    disk.times[`${ROOT}/src`] = 2

    // No poll ran: opening the folder reads it again by itself
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ key: 'row:src/util.ts' })).toBeDefined()
  })

  test('stats at most its cap of folders a poll, every open folder in turn', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const names = Array.from({ length: 100 }, (_, at) => `d${String(at).padStart(2, '0')}`)

    disk.folders[ROOT] = names.map(name => entry(name, 'dir'))
    names.forEach(name => {
      disk.folders[`${ROOT}/${name}`] = []
      disk.times[`${ROOT}/${name}`] = 1
    })

    const ui = await opened($)

    await ui.press({ key: 'depth-1' })
    disk.calls.stat.length = 0
    await clock.advance(Limits.POLL_MS)

    const first = [...disk.calls.stat]

    disk.calls.stat.length = 0
    await clock.advance(Limits.POLL_MS)

    expect(first.length).toBeLessThanOrEqual(Limits.MAX_POLL_STATS)
    expect(disk.calls.stat.length).toBeLessThanOrEqual(Limits.MAX_POLL_STATS)
    expect(new Set([...first, ...disk.calls.stat]).size).toBe(names.length + 1)
  })
})

describe('polls only while the pane is open and shown', () => {
  test('a closed pane polls nothing: the wait is cancelled', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)
    const ui = await opened($)

    await clock.advance(Limits.POLL_MS)
    await ui.unmount()
    await $.command.run(TREE)

    disk.calls.stat.length = 0
    disk.calls.list.length = 0
    disk.calls.panes = 0
    await clock.advance(10 * Limits.POLL_MS)

    expect(disk.calls.panes).toBe(0)
    expect(disk.calls.stat).toEqual([])
    expect(disk.calls.list).toEqual([])
  })

  test('a poll under way when the pane closes schedules no other', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)

    await opened($)

    // The next poll's stat takes a while: meanwhile the pane closes and
    // opens again, which starts polls of its own
    disk.pane.statDelayMs = 1_000
    await clock.advance(Limits.POLL_MS + 10)
    disk.pane.statDelayMs = 0
    await $.command.run(TREE)
    await $.command.run(TREE)
    await clock.advance(1_000)

    // One chain of polls, one `ui.panes` each: the stale poll ended there
    disk.calls.panes = 0
    await clock.advance(3 * Limits.POLL_MS)
    expect(disk.calls.panes).toBe(3)
  })

  test('a pane hidden behind another polls nothing', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)

    await opened($)
    disk.pane.isShown = false
    disk.calls.stat.length = 0
    await clock.advance(5 * Limits.POLL_MS)

    expect(disk.calls.stat).toEqual([])
  })

  test('polls start again when the session finds the pane open, as after a reload', async ($, on) => {
    const clock = mock.clock(on)
    const disk = diskOf(on, clock)

    // Open from before the reload: no /tree has run in this module
    disk.pane.isOpen = true
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })

    const ui = await $.ui.mount(PANE)

    disk.folders[ROOT] = [...(disk.folders[ROOT] ?? []), entry('NEW.md', 'file', 3)]
    disk.times[ROOT] = 2
    await clock.advance(Limits.POLL_MS)

    expect(await ui.find({ key: 'row:NEW.md' })).toBeDefined()
  })
})

describe("Claude's tool calls", () => {
  for (const [what, answer] of [
    ['a read-only command', { result: 'ran', isReadOnly: true }],
    ['a denied command', { deny: 'not allowed' }],
  ] as const) {
    test(`${what} refreshes nothing`, async ($, on) => {
      const clock = mock.clock(on)
      const disk = diskOf(on, clock)

      on('tool.call', () => answer)

      await opened($)
      disk.calls.list.length = 0

      await $.tool.call({ tool: 'Bash', command: 'ls' } as never).catch(() => undefined)
      await clock.advance(Limits.REFRESH_DEBOUNCE_MS)

      expect(disk.calls.list).toEqual([])
    })
  }

  test('mayHaveWritten: a call that ran or threw, unless held read-only or denied', async () => {
    expect(mayHaveWritten({ result: 'done' } as never)).toBe(true)
    expect(mayHaveWritten(undefined)).toBe(true)
    expect(mayHaveWritten({ result: 'listed', isReadOnly: true } as never)).toBe(false)
    expect(mayHaveWritten({ deny: 'no' } as never)).toBe(false)
  })
})

describe('poll batches', () => {
  const dir = (path: string): Entry => ({ name: path, path, kind: 'dir', size: 0 })

  test('shownDirsOf: the root and every open folder drawn', async () => {
    const rows = flattenTree(
      folder =>
        folder === ''
          ? { entries: [dir('a'), dir('b')], truncated: 0 }
          : { entries: [], truncated: 0 },
      new Set(['a']),
    )

    expect(shownDirsOf(rows)).toEqual(['', 'a'])
  })

  test('pollBatchOf: the root always, the rest in turns', async () => {
    const dirs = ['', ...Array.from({ length: 100 }, (_, at) => `d${at}`)]
    const first = pollBatchOf(dirs, 0, 10)
    const second = pollBatchOf(dirs, first.cursor, 10)

    expect(first.batch).toEqual(['', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'])
    expect(second.batch.slice(0, 2)).toEqual(['', 'd9'])
    expect(pollBatchOf(['', 'a'], 5, 10)).toEqual({ batch: ['', 'a'], cursor: 0 })
  })

  test('changedDirsOf: a moved time, or a vanished folder and its parent', async () => {
    const stamps = new Map([
      ['', 1],
      ['a', 1],
      ['a/b', 1],
    ])

    const now = new Map<string, number | null>([
      ['', 1],
      ['a', 2],
      ['a/b', null],
    ])

    expect(changedDirsOf(['', 'a', 'a/b'], stamps, now).sort()).toEqual(['a', 'a/b'])
    expect(changedDirsOf(['', 'a'], stamps, new Map([['', 1], ['a', 1]]))).toEqual([])
    expect(changedDirsOf(['never-read'], stamps, new Map([['never-read', 5]]))).toEqual([])
  })
})
