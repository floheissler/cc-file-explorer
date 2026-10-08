import type { FsEntry, On, ProcessRunResult } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { markersOf, rowWidthOf } from './drawn'
import Limits from '../hooks/limits'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

/**
 * What git writes for the project below: `src/main.ts` changed, `NEW.md`
 * new, and `node_modules/` ignored.
 */
const STATUS = ' M src/main.ts\0?? NEW.md\0!! node_modules/\0'

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

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/**
 * A repository on a stubbed disk, git answering from `repo`: the test
 * changes either behind the pane's back. Every git run is recorded.
 */
function repoOf(on: On) {
  const folders: Record<string, FsEntry[]> = {
    [ROOT]: [entry('node_modules', 'dir'), entry('src', 'dir'), entry('NEW.md', 'file', 3), entry('README.md', 'file', 7)],
    [`${ROOT}/node_modules`]: [entry('pkg', 'dir')],
    [`${ROOT}/src`]: [entry('main.ts', 'file', 1)],
  }

  const times: Record<string, number> = {
    [ROOT]: 1,
    [`${ROOT}/src`]: 1,
    [`${ROOT}/node_modules`]: 1,
    [`${ROOT}/.git/index`]: 1,
    [`${ROOT}/.git/HEAD`]: 1,
  }

  const repo = { status: STATUS, place: '\n/work/.git\n', isRepo: true, isInstalled: true }
  const runs: { readonly argv: readonly string[]; readonly init: unknown }[] = []
  const pane = { isOpen: false }
  const real: Record<string, string> = {}

  on('session.root', () => ({ value: ROOT }))
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
  on('fs.list', ($, e) => ({ value: folders[e.path] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: {
      kind: folders[e.path] === undefined ? 'file' : 'dir',
      size: 1,
      mtimeMs: times[e.path] ?? 0,
      isLink: false,
      ...(e.resolve ? { realPath: real[e.path] ?? e.path } : {}),
    },
  }))
  on('fs.read', () => ({ value: 'x' }))
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, init: e.init })

    if (!repo.isInstalled) {
      return { deny: 'ENOENT: git not found' }
    }

    if (e.argv[1] === 'rev-parse') {
      return repo.isRepo ? ran(repo.place) : ran('', 128)
    }

    return ran(repo.status)
  })
  on('tool.call', ($, e) =>
    e.tool === 'Edit' && e.old_string === 'missing' ? { isError: true, result: 'not found', text: 'not found' } : { result: 'ok' },
  )

  const statusRuns = () => runs.filter(run => run.argv[1] === 'status').length

  return { folders, times, repo, runs, statusRuns, real }
}

async function opened($: Engine) {
  await $.command.run(TREE)

  return $.ui.mount(PANE)
}

describe('git markers', () => {
  test('a letter per file, a dot per folder with changes, ! for what git ignores', async ($, on) => {
    mock.clock(on)
    repoOf(on)

    const ui = await opened($)
    await ui.press({ key: 'row:src' })

    const drawn = await ui.drawn()

    expect(markersOf(drawn, 'src/main.ts')).toBe(' M')
    expect(markersOf(drawn, 'src')).toBe(' •')
    expect(markersOf(drawn, 'NEW.md')).toBe(' ?')
    expect(markersOf(drawn, 'node_modules')).toBe(' !')
    expect(markersOf(drawn, 'README.md')).toBe('')

    // Marked or not, every row fills the body's width exactly
    for (const path of ['src', 'src/main.ts', 'NEW.md', 'README.md']) {
      expect(rowWidthOf(drawn, path), path).toBe(PANE.props.bodyColumns - Limits.RIGHT_PAD_COLUMNS)
    }

    // The marker takes the color of what it says
    const marker = await ui.find({ type: 'Text', text: ' M' })
    expect(marker?.props).toMatchObject({ color: 'warning' })
  })

  test('runs git without optional locks, in the C locale, with a timeout and -z', async ($, on) => {
    mock.clock(on)
    const disk = repoOf(on)

    await opened($)

    const status = disk.runs.find(run => run.argv[1] === 'status')

    expect(status?.argv).toEqual([
      'git',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      '.',
    ])
    expect(status?.init).toMatchObject({
      cwd: ROOT,
      env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      timeoutMs: Limits.GIT_TIMEOUT_MS,
    })
  })

  for (const [what, setUp] of [
    ['outside a repository', (repo: { isRepo: boolean }) => (repo.isRepo = false)],
    ['without git installed', (repo: { isInstalled: boolean }) => (repo.isInstalled = false)],
  ] as const) {
    test(`draws no markers ${what}`, async ($, on) => {
      mock.clock(on)
      const disk = repoOf(on)

      setUp(disk.repo as never)

      const ui = await opened($)

      expect(markersOf(await ui.drawn(), 'NEW.md')).toBe('')
      expect(disk.statusRuns()).toBe(0)
    })
  }

  test('a root inside the repository reads its records from below its prefix', async ($, on) => {
    mock.clock(on)
    const disk = repoOf(on)

    disk.repo.place = 'work/\n/home/.git\n'
    disk.repo.status = '?? work/NEW.md\0?? other/x.md\0'

    const ui = await opened($)

    expect(markersOf(await ui.drawn(), 'NEW.md')).toBe(' ?')
  })
})

describe('git is read again', () => {
  test('on r, showing what changed', async ($, on) => {
    mock.clock(on)
    const disk = repoOf(on)
    const ui = await opened($)

    disk.repo.status = 'A  NEW.md\0'
    await ui.press({ key: 'refresh' })

    const drawn = await ui.drawn()

    expect(markersOf(drawn, 'NEW.md')).toBe(' A')
    expect(markersOf(drawn, 'src')).toBe('')
  })

  test('after Claude runs a command, once Claude pauses', async ($, on) => {
    const clock = mock.clock(on)
    const disk = repoOf(on)
    const ui = await opened($)
    const before = disk.statusRuns()

    disk.repo.status = ''
    await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m x' } as never)
    await clock.advance(Limits.REFRESH_DEBOUNCE_MS)

    expect(disk.statusRuns()).toBe(before + 1)
    expect(markersOf(await ui.drawn(), 'NEW.md')).toBe('')
  })

  test('when a poll finds the index moved, as after a commit outside Claude', async ($, on) => {
    const clock = mock.clock(on)
    const disk = repoOf(on)
    const ui = await opened($)

    // Polls that find nothing changed run no git
    const before = disk.statusRuns()
    await clock.advance(3 * Limits.POLL_MS)
    expect(disk.statusRuns()).toBe(before)

    disk.repo.status = ''
    disk.times[`${ROOT}/.git/index`] = 2
    await clock.advance(Limits.POLL_MS)

    expect(disk.statusRuns()).toBe(before + 1)
    expect(markersOf(await ui.drawn(), 'NEW.md')).toBe('')
  })

  test('when a poll finds a shown folder changed', async ($, on) => {
    const clock = mock.clock(on)
    const disk = repoOf(on)
    const ui = await opened($)

    disk.folders[ROOT] = [...(disk.folders[ROOT] ?? []), entry('LATER.md', 'file', 1)]
    disk.times[ROOT] = 2
    disk.repo.status = `${STATUS}?? LATER.md\0`
    await clock.advance(Limits.POLL_MS)

    expect(markersOf(await ui.drawn(), 'LATER.md')).toBe(' ?')
  })
})

describe('files Claude wrote this session', () => {
  test('are marked, with every folder above them, beside git', async ($, on) => {
    mock.clock(on)
    repoOf(on)

    await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/main.ts`, content: 'x' } as never)

    const ui = await opened($)
    await ui.press({ key: 'row:src' })

    const drawn = await ui.drawn()

    expect(markersOf(drawn, 'src/main.ts')).toBe(' ✻M')
    expect(markersOf(drawn, 'src')).toBe(' ✻•')
    expect(markersOf(drawn, 'NEW.md')).toBe('  ?')
    expect(rowWidthOf(drawn, 'NEW.md')).toBe(PANE.props.bodyColumns - Limits.RIGHT_PAD_COLUMNS)
  })

  test('only when the edit went through, and only under the root', async ($, on) => {
    mock.clock(on)
    const disk = repoOf(on)

    disk.repo.isRepo = false

    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/README.md`, old_string: 'missing', new_string: 'x' } as never)
    await $.tool.call({ tool: 'Write', file_path: '/elsewhere/NEW.md', content: 'x' } as never)

    const ui = await opened($)

    expect(markersOf(await ui.drawn(), 'README.md')).toBe('')
    expect(markersOf(await ui.drawn(), 'NEW.md')).toBe('')

    await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/NEW.md`, new_source: 'x' } as never)
    await ui.redraw()

    expect(markersOf(await ui.drawn(), 'NEW.md')).toBe(' ✻')
  })

  test('a path through a link counts where it lands', async ($, on) => {
    mock.clock(on)
    const disk = repoOf(on)

    disk.repo.isRepo = false
    disk.real['/link/README.md'] = `${ROOT}/README.md`

    await $.tool.call({ tool: 'Edit', file_path: '/link/README.md', old_string: 'a', new_string: 'b' } as never)

    const ui = await opened($)

    expect(markersOf(await ui.drawn(), 'README.md')).toBe(' ✻')
  })
})

describe('/tree <path> in a marked tree', () => {
  test('reveals a marked file: its marker drawn, its row whole, the ring starting on it', async ($, on) => {
    mock.clock(on)
    repoOf(on)

    await $.command.run({ ...TREE, args: 'src/main.ts' })

    const ui = await $.ui.mount(PANE)
    await ui.redraw()

    const drawn = await ui.drawn()

    expect(markersOf(drawn, 'src/main.ts')).toBe(' M')
    expect(rowWidthOf(drawn, 'src/main.ts')).toBe(PANE.props.bodyColumns - Limits.RIGHT_PAD_COLUMNS)
    expect(await ui.find({ key: 'row:src/main.ts' })).toMatchObject({ props: { autoFocus: true } })
  })
})
