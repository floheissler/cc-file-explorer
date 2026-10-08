import type { FsEntry } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ROOT = '/work'

const entry = (name: string, kind: FsEntry['kind'], size = 0): FsEntry => ({
  name,
  kind,
  size,
  mtimeMs: 0,
  isLink: false,
})

const MAIN_TS = Array.from({ length: 100 }, (_, at) => `export const n${at} = ${at}`).join('\n')

/**
 * A small project on disk, by absolute path.
 */
const FOLDERS: Record<string, FsEntry[]> = {
  [ROOT]: [
    entry('README.md', 'file', 24),
    entry('node_modules', 'dir'),
    entry('.git', 'dir'),
    entry('src', 'dir'),
  ],
  [`${ROOT}/src`]: [entry('main.ts', 'file', MAIN_TS.length)],
}

const FILES: Record<string, string> = {
  [`${ROOT}/README.md`]: '# Hello\n\nSome **text**\n',
  [`${ROOT}/src/main.ts`]: MAIN_TS,
}

/**
 * What Claude Code passes the pane's render hook, but the surface.
 */
const PANE = {
  plugin: 'file-explorer',
  component: 'Pane',
  requestId: 'file-explorer',
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

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`browses the tree and previews files (${surface})`, async ($, on) => {
    on('session.root', () => ({ value: ROOT }))
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.list', ($, e) => ({ value: FOLDERS[e.path] ?? [] }))
    on('fs.stat', ($, e) => ({
      value: { kind: 'file', size: FILES[e.path]?.length ?? 0, mtimeMs: 0, isLink: false },
    }))
    on('fs.read', ($, e) => ({ value: FILES[e.path] ?? '' }))
    on('process.run', ($, e) => {
      if (e.argv[1] === 'rev-parse') {
        return ran('true\n')
      }

      // git check-ignore: node_modules is ignored, nothing else is
      const asked = (e.init?.stdin ?? '').split('\0')

      return asked.includes('node_modules') ? ran('node_modules\0') : ran('', 1)
    })

    await $.command.run({
      command: 'explorer',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

    const ui = await $.ui.mount({ ...PANE, surface })

    // The root lists folders first; .git and what git ignores are left out
    expect(await ui.find({ key: 'row:src' })).toBeDefined()
    expect(await ui.find({ key: 'row:README.md' })).toBeDefined()
    expect(await ui.find({ key: 'row:node_modules' })).toBeUndefined()
    expect(await ui.find({ key: 'row:.git' })).toBeUndefined()

    // A folder opens in place
    await ui.press({ key: 'row:src' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()

    // Branch lines as the tree command draws them: src/main.ts is the last
    // row of src, and README.md, after it, the last of the root
    expect(await ui.find({ type: 'Text', text: '│ └─' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '└─' })).toBeDefined()

    // Markdown previews rendered, and as source on `m`
    await ui.press({ key: 'row:README.md' })
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ props: { text: '# Hello\n\nSome **text**' } })
    await ui.press({ key: 'preview-mode' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { language: 'markdown' } })

    // Source previews with line numbers, and `j` scrolls it
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 1 } })
    await ui.press({ key: 'preview-down' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 4 } })

    // Pressing the previewed file again closes the preview
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    // `c` collapses every open folder
    await ui.press({ key: 'collapse-all' })
    expect(await ui.find({ key: 'row:src' })).toBeDefined()
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()

    await ui.unmount()
  })
}

test('/explorer closes the pane it opened', async ($, on) => {
  const closed: string[] = []

  on('ui.panes', () => ({
    value: [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }],
  }))
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })

  await $.command.run({
    command: 'explorer',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(closed).toEqual(['file-explorer'])
})
