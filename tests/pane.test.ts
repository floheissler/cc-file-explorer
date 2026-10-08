import type { FsEntry, On, RenderNode } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

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

/**
 * A project on the stubbed disk: folders' entries and files' text, by
 * absolute path.
 */
function stubProject(
  on: On,
  folders: Record<string, FsEntry[]>,
  files: Record<string, string>,
): void {
  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', ($, e) => ({ value: folders[e.path] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'file', size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
}

/**
 * A project of `count` files in its root, `f00.txt` onward.
 */
function stubFlatProject(on: On, count: number): void {
  const names = Array.from({ length: count }, (_, at) => `f${String(at).padStart(2, '0')}.txt`)

  stubProject(
    on,
    { [ROOT]: names.map(name => entry(name, 'file', 2)) },
    Object.fromEntries(names.map(name => [`${ROOT}/${name}`, 'hi'])),
  )
}

const openTree = ($: Engine) =>
  $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

/**
 * The docked pane on the terminal, `bodyRows` tall.
 */
const paneOf = (bodyRows: number) =>
  ({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, scroll: { offset: 0, bodyRows } },
  }) as const

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

/**
 * Records where the ring lands, standing in for Claude Code beneath the
 * plugin's focus hook.
 */
function recordFocus(on: On): (string | undefined)[] {
  const focused: (string | undefined)[] = []

  on('ui.focus', ($, e) => {
    focused.push(e.element)

    return {}
  })

  return focused
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`browses the tree and previews files (${surface})`, async ($, on) => {
    stubProject(on, FOLDERS, FILES)
    await openTree($)

    const ui = await $.ui.mount({ ...PANE, surface })

    // The root lists everything but .git, git-ignored folders included
    expect(await ui.find({ key: 'row:src' })).toBeDefined()
    expect(await ui.find({ key: 'row:README.md' })).toBeDefined()
    expect(await ui.find({ key: 'row:node_modules' })).toBeDefined()
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

    // `c` closes one level, `e` opens one level again
    await ui.press({ key: 'collapse-level' })
    expect(await ui.find({ key: 'row:src' })).toBeDefined()
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()
    await ui.press({ key: 'expand-level' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()

    // The digits, hidden from view, set the depth: 0 closes every folder
    await ui.press({ key: 'depth-0' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeUndefined()
    await ui.press({ key: 'depth-1' })
    expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()

    // `h` swaps the tree for the help view and back
    await ui.press({ key: 'help' })
    expect(await ui.find({ type: 'Text', text: 'Mouse' })).toBeDefined()
    expect(await ui.find({ key: 'row:src' })).toBeUndefined()
    await ui.press({ key: 'help' })
    expect(await ui.find({ key: 'row:src' })).toBeDefined()

    await ui.unmount()
  })
}

test('/tree closes the pane it opened', async ($, on) => {
  const closed: string[] = []

  on('ui.panes', () => ({
    value: [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }],
  }))
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined }
  })

  await $.command.run({
    command: 'tree',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(closed).toEqual(['file-explorer'])
})

test('the focus ring lands where its row is drawn after the window moves', async ($, on) => {
  stubFlatProject(on, 20)
  const focused = recordFocus(on)
  await openTree($)

  // 7 rows of tree: f00 … f05, then a count of the rows below
  const ui = await $.ui.mount(paneOf(8))
  expect(await ui.find({ key: 'row:f05.txt' })).toBeDefined()
  expect(await ui.find({ key: 'row:f06.txt' })).toBeUndefined()

  // Down onto the last row drawn: the window moves two rows, so the ring
  // lands on f03, the place f05 takes in the next drawing
  expect(await $.ui.focus(ringOnto('row:f05.txt'))).toEqual({})
  expect(focused).toEqual(['row:f03.txt'])

  await ui.redraw()
  expect(await ui.find({ key: 'row:f01.txt' })).toBeUndefined()
  expect(await ui.find({ key: 'row:f06.txt' })).toBeDefined()

  await ui.unmount()
})

test('the focus ring stops at the tree’s last row and wraps from the other ends', async ($, on) => {
  stubFlatProject(on, 3)
  const focused = recordFocus(on)
  await openTree($)

  const ui = await $.ui.mount(paneOf(30))

  // Past the last row lie the hidden digit Buttons: the ring stays put
  await $.ui.focus(ringOnto('row:f02.txt'))
  expect(await $.ui.focus(ringOnto('depth-0'))).toEqual({})
  expect(focused).toEqual(['row:f02.txt'])

  // With a file previewed, its controls come last: past them the ring wraps
  // to the first control, and back from that to the last
  await ui.press({ key: 'row:f02.txt' })
  await $.ui.focus(ringOnto('preview-close'))
  await $.ui.focus(ringOnto('depth-0'))
  await $.ui.focus(ringOnto('depth-9'))
  expect(focused).toEqual(['row:f02.txt', 'preview-close', 'expand-level', 'preview-close'])

  await ui.unmount()
})

test('a wheel tick moves the tree by the rows it carries', async ($, on) => {
  stubFlatProject(on, 20)
  await openTree($)

  const ui = await $.ui.mount(paneOf(8))

  // `by` already carries the person's scroll speed: one row here
  const tick = {
    component: 'Pane',
    requestId: 'file-explorer',
    offset: 0,
    by: 1,
    bodyRows: 8,
    contentRows: 8,
    origin: { kind: 'person' },
    pointer: { row: 3, column: 2 },
  } as const

  expect(await $.ui.scroll(tick)).toEqual({})

  await ui.redraw()
  expect(await ui.find({ key: 'row:f00.txt' })).toBeUndefined()
  expect(await ui.find({ key: 'row:f01.txt' })).toBeDefined()

  await ui.unmount()
})

/**
 * The plain-data shape of a drawn element, as far as the walk below reads it.
 */
type ElementData = {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly RenderNode[]
}

/**
 * The elements from the root down to the first one `match` picks.
 */
function pathTo(node: RenderNode, match: (element: ElementData) => boolean): ElementData[] {
  if (typeof node === 'string') {
    return []
  }

  const element = node as ElementData

  if (match(element)) {
    return [element]
  }

  for (const child of element.children ?? []) {
    const below = pathTo(child, match)

    if (below.length > 0) {
      return [element, ...below]
    }
  }

  return []
}

test('clipped regions keep their content at its natural height', async ($, on) => {
  stubProject(on, FOLDERS, FILES)
  await openTree($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // The `flexShrink` of the box right under the clipping box above an
  // element: 0, or Markdown rows shrunk to fit drop or overprint lines
  const shrinkUnderClip = async (match: (element: ElementData) => boolean) => {
    const path = pathTo(await ui.drawn(), match)
    const clip = path.findIndex(element => element.props?.overflow === 'hidden')

    return clip >= 0 ? path[clip + 1]?.props?.flexShrink : undefined
  }

  await ui.press({ key: 'row:README.md' })
  expect(await shrinkUnderClip(element => element.type === 'Markdown')).toBe(0)

  await ui.press({ key: 'help' })
  expect(
    await shrinkUnderClip(element => element.type === 'Text' && element.children?.[0] === 'Mouse'),
  ).toBe(0)

  await ui.unmount()
})
