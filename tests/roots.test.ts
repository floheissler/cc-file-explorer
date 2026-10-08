import type { FsEntry } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/**
 * Roots as each platform spells them: the header's name for the root, and
 * the native paths `$.fs` must be handed for `src` and `src/main.ts`.
 */
const ROOTS = [
  { root: '/', label: '/', src: '/src', file: '/src/main.ts' },
  {
    root: '/Users/me/Cafe\u0301',
    label: 'Cafe\u0301',
    src: '/Users/me/Cafe\u0301/src',
    file: '/Users/me/Cafe\u0301/src/main.ts',
  },
  { root: 'C:\\work', label: 'work', src: 'C:\\work\\src', file: 'C:\\work\\src\\main.ts' },
  { root: 'C:\\', label: 'C:\\', src: 'C:\\src', file: 'C:\\src\\main.ts' },
  {
    root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\work',
    label: 'work',
    src: '\\\\wsl.localhost\\Ubuntu\\home\\me\\work\\src',
    file: '\\\\wsl.localhost\\Ubuntu\\home\\me\\work\\src\\main.ts',
  },
] as const

const isWindowsSpelled = (root: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root)

for (const { root, label, src, file } of ROOTS) {
  const host = isWindowsSpelled(root) ? ' (on a Windows host)' : ''

  test(`lists and previews under the root ${JSON.stringify(root)}${host}`, async ($, on) => {
    const listed: string[] = []
    const read: string[] = []

    const folders: Record<string, FsEntry[]> = {
      [root]: [entry('.git', 'dir'), entry('src', 'dir')],
      [src]: [entry('main.ts', 'file', 9)],
    }

    on('session.root', () => ({ value: root }))
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.list', ($, e) => {
      listed.push(e.path)

      return { value: folders[e.path] ?? [] }
    })
    on('fs.stat', () => ({ value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false } }))
    on('fs.read', ($, e) => {
      read.push(e.path)

      return { value: 'const a = 1' }
    })

    await $.command.run({
      command: 'tree',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })

    // The test host makes every `$.fs` path absolute by its own platform's
    // rules before a hook sees it (on Linux, `C:\work` arrives as
    // `<cwd>/C:\work`), so a Windows-spelled root is only tried on Windows
    if (isWindowsSpelled(root) && listed[0] !== root) {
      return
    }

    const ui = await $.ui.mount(PANE)

    expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ key: 'row:.git' })).toBeUndefined()

    await ui.press({ key: 'row:src' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()

    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect([...new Set(listed)]).toEqual([root, src])
    expect(read).toEqual([file])

    await ui.unmount()
  })
}
