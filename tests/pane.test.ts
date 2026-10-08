import type { FsEntry, On, PromptBox, PromptFillInput } from 'claude-code'
import { expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'

import { pathTo, type ElementData } from './drawn'
import { testPathOf } from './host'
import Limits from '../hooks/limits'
import { cellWidth } from '../hooks/text'

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
  on('fs.list', ($, e) => ({ value: folders[testPathOf(e.path)] ?? [] }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'file', size: files[testPathOf(e.path)]?.length ?? 0, mtimeMs: 0, isLink: false },
  }))
  on('fs.read', ($, e) => ({ value: files[testPathOf(e.path)] ?? '' }))
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
 * The docked pane on the terminal, `bodyRows` tall and `bodyColumns` wide.
 */
const paneOf = (bodyRows: number, bodyColumns: number = PANE.props.bodyColumns) =>
  ({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, bodyColumns, scroll: { offset: 0, bodyRows } },
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

/**
 * The prompt box, standing in for Claude Code beneath the plugin: it holds
 * `box` and takes every fill, or refuses each; and the toasts the plugin
 * raised. A test's hook answers as a hook does, so its refusal carries no
 * cause (`dialog`, `no_composer`): those only the engine gives.
 */
function stubPrompt(on: On, box: PromptBox, isRefusing = false) {
  const fills: PromptFillInput[] = []
  const toasts: string[] = []

  on('prompt.read', () => ({ value: box }))
  on('prompt.fill', ($, e) => {
    fills.push(e)

    return { isFilled: !isRefusing }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { fills, toasts }
}

/**
 * The text of each fill, as it went in at the cursor.
 */
const insertsOf = (fills: readonly PromptFillInput[]) =>
  fills.map(fill => {
    expect(fill.mode).toBe('insert')

    return fill.text
  })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a mentions the focused row at the prompt's cursor, else the previewed file (${surface})`, async ($, on) => {
    stubProject(on, FOLDERS, FILES)
    on('session.cwd', () => ({ value: ROOT }))
    recordFocus(on)
    const prompt = stubPrompt(on, { text: 'look at', cursor: 7 })
    await openTree($)

    const ui = await $.ui.mount({ ...PANE, surface })

    // A folder ends in its separator, set off from the word before it
    await $.ui.focus(ringOnto('row:src'))
    await ui.press({ key: 'mention' })

    // With the ring off the rows, the previewed file
    await ui.press({ key: 'row:README.md' })
    await $.ui.focus(ringOnto('preview-close'))
    await ui.press({ key: 'mention' })

    expect(insertsOf(prompt.fills)).toEqual([' @src/ ', ' @README.md '])
    expect(prompt.toasts).toEqual([])

    await ui.unmount()
  })
}

test('a mentions the row the ring rests on after rows open above it', async ($, on) => {
  stubProject(on, FOLDERS, FILES)
  on('session.cwd', () => ({ value: ROOT }))
  recordFocus(on)
  const prompt = stubPrompt(on, { text: '', cursor: 0 })
  await openTree($)

  const ui = await $.ui.mount(paneOf(30))

  // node_modules, src, README.md; `e` opens src above README.md, and Claude
  // Code keeps the ring at its place in the focus order, now src/main.ts
  await $.ui.focus(ringOnto('row:README.md'))
  await ui.press({ key: 'expand-level' })
  expect(await ui.find({ key: 'row:src/main.ts' })).toBeDefined()
  await ui.press({ key: 'mention' })

  expect(insertsOf(prompt.fills)).toEqual(['@src/main.ts '])

  await ui.unmount()
})

test('a hands the keyboard to the prompt, and the ring comes back to its row', async ($, on) => {
  stubProject(on, FOLDERS, FILES)
  on('session.cwd', () => ({ value: ROOT }))
  recordFocus(on)
  const prompt = stubPrompt(on, { text: '', cursor: 0 })
  await openTree($)

  const pane = paneOf(30)
  const ui = await $.ui.mount(pane)

  // The mentioned row takes the ring as the pane takes the keyboard back
  await $.ui.focus(ringOnto('row:README.md'))
  await ui.press({ key: 'mention' })
  expect(await ui.find({ key: 'row:README.md' })).toMatchObject({ props: { autoFocus: true } })

  // Without the keyboard the pane shows no ring: nothing to mention
  await ui.redraw({ ...pane.props, isFocused: false })
  await ui.press({ key: 'mention' })
  expect(prompt.toasts).toEqual(['Focus a row or preview a file to mention it'])

  // Once the ring lands elsewhere, the row lets go of it
  await ui.redraw(pane.props)
  await $.ui.focus(ringOnto('row:src'))
  expect(await ui.find({ key: 'row:README.md' })).not.toMatchObject({ props: { autoFocus: true } })
  expect(insertsOf(prompt.fills)).toEqual(['@README.md '])

  await ui.unmount()
})

test('a mentions the entry /tree <path> revealed, the ring on it', async ($, on) => {
  stubProject(on, FOLDERS, FILES)
  on('session.cwd', () => ({ value: ROOT }))
  recordFocus(on)
  const prompt = stubPrompt(on, { text: '', cursor: 0 })

  await $.command.run({
    command: 'tree',
    args: 'src',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount(paneOf(30))
  expect(await ui.find({ key: 'row:src' })).toMatchObject({ props: { autoFocus: true } })

  // The revealed row takes the ring as the pane takes the keyboard, which
  // Claude Code raises as the plugin's own focus move
  await $.ui.focus({ ...ringOnto('row:src'), origin: { kind: 'plugin', name: 'file-explorer' } })
  await ui.press({ key: 'mention' })

  expect(insertsOf(prompt.fills)).toEqual(['@src/ '])

  await ui.unmount()
})

test('a spells the path from the folder a shell cd moved the session to', async ($, on) => {
  stubProject(on, FOLDERS, FILES)
  on('session.cwd', () => ({ value: `${ROOT}/src` }))
  recordFocus(on)
  const prompt = stubPrompt(on, { text: '', cursor: 0 })
  await openTree($)

  const ui = await $.ui.mount(paneOf(30))

  await $.ui.focus(ringOnto('row:README.md'))
  await ui.press({ key: 'mention' })
  await $.ui.focus(ringOnto('row:src'))
  await ui.press({ key: 'mention' })

  expect(insertsOf(prompt.fills)).toEqual(['@../README.md ', '@"./" '])

  await ui.unmount()
})

test('a says why when it mentions nothing', async ($, on) => {
  stubProject(on, { [ROOT]: [entry('a.txt', 'file', 2), entry('issue#1.md', 'file', 2)] }, {})
  on('session.cwd', () => ({ value: ROOT }))
  recordFocus(on)
  const prompt = stubPrompt(on, { text: '', cursor: 0 }, true)
  await openTree($)

  const ui = await $.ui.mount(paneOf(30))

  // No row focused and no file previewed
  await ui.press({ key: 'mention' })

  // A # would end the path: nothing goes in
  await $.ui.focus(ringOnto('row:issue#1.md'))
  await ui.press({ key: 'mention' })

  // The prompt box refuses the text
  await $.ui.focus(ringOnto('row:a.txt'))
  await ui.press({ key: 'mention' })

  expect(insertsOf(prompt.fills)).toEqual(['@a.txt '])
  expect(prompt.toasts).toEqual([
    'Focus a row or preview a file to mention it',
    'Cannot mention issue#1.md: Claude Code reads a # in a mention as a line range',
    'The prompt box did not take the mention of a.txt',
  ])

  await ui.unmount()
})

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

    // Source previews with line numbers, and `s` scrolls it
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 1 } })
    expect(await ui.find({ key: 'preview-up' })).toMatchObject({ props: { hotkey: 'w' } })
    expect(await ui.find({ key: 'preview-down' })).toMatchObject({ props: { hotkey: 's' } })
    await ui.press({ key: 'preview-down' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 4 } })

    // Following the focus, pressing the previewed file again keeps it; `x`
    // closes it
    await ui.press({ key: 'row:src/main.ts' })
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 4 } })
    await ui.press({ key: 'preview-close' })
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

    // `h` swaps the tree for the help view and back; it lists the markers
    await ui.press({ key: 'help' })
    expect(await ui.find({ type: 'Text', text: 'Mouse' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Markers' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ignored by git' })).toBeDefined()
    expect(await ui.find({ key: 'row:src' })).toBeUndefined()
    await ui.press({ key: 'help' })
    expect(await ui.find({ key: 'row:src' })).toBeDefined()

    await ui.unmount()
  })
}

/**
 * A mounted pane, as the waits below drive it.
 */
type Drawing = {
  readonly find: Mounted['find']
  readonly redraw: () => Promise<void>
}

/**
 * Waits until `isDone` holds, a drawing at a time, for work the plugin left
 * running in the background: a preview following the ring. Each drawing is
 * a round trip through the engine, as the plugin's own calls are.
 */
async function until(ui: Drawing, isDone: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (await isDone()) {
      return
    }

    await ui.redraw()
  }

  throw new Error(`waited too long for ${what}`)
}

/**
 * Gives the plugin's background work a few drawings' time, so a check that
 * it left something as it was means it.
 */
async function settle(ui: Drawing): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await ui.redraw()
  }
}


/**
 * The file the docked preview shows: a source preview by its path, Markdown
 * as such; null while no preview is drawn.
 */
async function previewedOf(ui: Pick<Mounted, 'find'>): Promise<string | null> {
  const code = await ui.find({ type: 'Code' })

  if (code !== undefined) {
    return String(code.props.path)
  }

  return (await ui.find({ type: 'Markdown' })) === undefined ? null : 'markdown'
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the preview follows the focus ring onto files until p pins it (${surface})`, async ($, on) => {
    stubProject(on, FOLDERS, FILES)
    recordFocus(on)
    await openTree($)

    const ui = await $.ui.mount({ ...PANE, surface })
    const previewed = (path: string | null) => until(ui, async () => (await previewedOf(ui)) === path, `${path}`)

    await ui.press({ key: 'row:src' })

    // A closed preview stays closed as the ring walks the tree
    await $.ui.focus(ringOnto('row:README.md'))
    await settle(ui)
    expect(await previewedOf(ui)).toBeNull()

    // Open, it shows each file the ring lands on, from its top, its row
    // marked as the previewed one
    await ui.press({ key: 'row:README.md' })
    expect(await previewedOf(ui)).toBe('markdown')
    await $.ui.focus(ringOnto('row:src/main.ts'))
    await previewed('src/main.ts')
    expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { startLine: 1 } })
    expect(await ui.find({ key: 'row:src/main.ts' })).toMatchObject({ props: { label: expect.stringContaining('• main.ts') } })

    // A folder's row and the header's controls leave it as it is
    await $.ui.focus(ringOnto('row:src'))
    await $.ui.focus(ringOnto('refresh'))
    await settle(ui)
    expect(await previewedOf(ui)).toBe('src/main.ts')

    // Pinned, it keeps its file as the ring moves, and says so
    await ui.press({ key: 'preview-pin' })
    expect(await ui.find({ key: 'preview-pin' })).toMatchObject({ props: { label: 'unpin', hotkey: 'p' } })
    expect(await ui.find({ type: 'Text', text: /· pinned$/ })).toBeDefined()
    await $.ui.focus(ringOnto('row:README.md'))
    await settle(ui)
    expect(await previewedOf(ui)).toBe('src/main.ts')

    // A press shows another file, still pinned; on the pinned file, it closes
    // the preview and lets go of the pin
    await ui.press({ key: 'row:README.md' })
    expect(await previewedOf(ui)).toBe('markdown')
    expect(await ui.find({ key: 'preview-pin' })).toMatchObject({ props: { label: 'unpin' } })
    await ui.press({ key: 'row:README.md' })
    expect(await previewedOf(ui)).toBeNull()
    await ui.press({ key: 'row:README.md' })
    expect(await ui.find({ key: 'preview-pin' })).toMatchObject({ props: { label: 'pin' } })
    expect(await ui.find({ type: 'Text', text: /pinned/ })).toBeUndefined()

    // Let go of the pin, the preview moves to the ring's file at once
    await ui.press({ key: 'preview-pin' })
    await $.ui.focus(ringOnto('row:src/main.ts'))
    await settle(ui)
    expect(await previewedOf(ui)).toBe('markdown')
    await ui.press({ key: 'preview-pin' })
    await previewed('src/main.ts')

    await ui.unmount()
  })
}

test('the preview reads the file the ring stops on, drawing the one it shows until then', async ($, on) => {
  const names = ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']

  // Each file's text waits until the test lets it go
  const reads: { readonly path: string; readonly release: () => void }[] = []

  on('session.root', () => ({ value: ROOT }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', ($, e) => ({ value: testPathOf(e.path) === ROOT ? names.map(name => entry(name, 'file', 9)) : [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false } }))
  on(
    'fs.read',
    ($, e) =>
      new Promise(resolve => {
        const path = testPathOf(e.path)

        reads.push({ path, release: () => resolve({ value: `text of ${path}` }) })
      }),
  )
  recordFocus(on)
  await openTree($)

  const ui = await $.ui.mount(paneOf(30))
  const sourceOf = async () => (await ui.find({ type: 'Code' }))?.props.source
  const pressed = ui.press({ key: 'row:f0.txt' })

  await until(ui, () => reads.length === 1, 'f0 to be read')
  reads[0]?.release()
  await pressed
  expect(await sourceOf()).toBe(`text of ${ROOT}/f0.txt`)

  // The ring walks three rows while f1 is read: f0 stays drawn, and of the
  // rest only f3, where the ring stops, is read after it
  await $.ui.focus(ringOnto('row:f1.txt'))
  await until(ui, () => reads.length === 2, 'f1 to be read')
  await $.ui.focus(ringOnto('row:f2.txt'))
  await $.ui.focus(ringOnto('row:f3.txt'))
  await settle(ui)
  expect(await sourceOf()).toBe(`text of ${ROOT}/f0.txt`)

  reads[1]?.release()
  await until(ui, () => reads.length === 3, 'f3 to be read')
  expect(await sourceOf()).toBe(`text of ${ROOT}/f0.txt`)
  reads[2]?.release()
  await until(ui, async () => (await sourceOf()) === `text of ${ROOT}/f3.txt`, 'f3 to show')
  expect(reads.map(read => read.path)).toEqual([`${ROOT}/f0.txt`, `${ROOT}/f1.txt`, `${ROOT}/f3.txt`])

  // A click asks twice, as the ring lands on the row and as it presses it:
  // the file is read once
  await $.ui.focus(ringOnto('row:f1.txt'))
  const clicked = ui.press({ key: 'row:f1.txt' })

  await until(ui, () => reads.length === 4, 'f1 to be read again')
  reads[3]?.release()
  await settle(ui)
  expect(reads.length, 'reads of f1').toBe(4)
  await clicked
  expect(await sourceOf()).toBe(`text of ${ROOT}/f1.txt`)

  await ui.unmount()
})

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

test('the focus ring comes in at the tree, ahead of the header’s controls', async ($, on) => {
  stubFlatProject(on, 3)
  const focused = recordFocus(on)
  await openTree($)

  // Wide enough for the header to draw every control, `expand` first
  const pane = paneOf(30, 80)
  const ui = await $.ui.mount(pane)

  // From nothing, Down moves onto `expand`: the ring takes the first row
  // instead, and Up from there walks into the header
  await $.ui.focus(ringOnto('expand-level'))
  await $.ui.focus(ringOnto('help'))
  await $.ui.focus(ringOnto('expand-level'))
  expect(focused).toEqual(['row:f00.txt', 'help', 'expand-level'])

  // The pane takes the keyboard back with the ring on nothing
  await ui.redraw({ ...pane.props, isFocused: false })
  await ui.redraw(pane.props)
  await $.ui.focus(ringOnto('expand-level'))
  expect(focused.at(-1)).toBe('row:f00.txt')

  await ui.unmount()
})

test('the focus ring comes in where the tree’s first row is drawn after the window moves', async ($, on) => {
  stubFlatProject(on, 20)
  const focused = recordFocus(on)
  await openTree($)

  const pane = paneOf(8, 80)
  const ui = await $.ui.mount(pane)

  // The window moves two rows down: f02 … f06 drawn under a count
  await $.ui.focus(ringOnto('row:f05.txt'))
  await ui.redraw({ ...pane.props, isFocused: false })
  expect(await ui.find({ key: 'row:f01.txt' })).toBeUndefined()

  // Coming in on f02, the window moves a row up to keep f01 above it, and
  // the ring lands on f03, the place f02 takes in the next drawing
  await ui.redraw(pane.props)
  await $.ui.focus(ringOnto('expand-level'))
  expect(focused.at(-1)).toBe('row:f03.txt')

  await ui.redraw()
  expect(await ui.find({ key: 'row:f01.txt' })).toBeDefined()

  await ui.unmount()
})

test('the focus ring stops at the tree’s last row and wraps from the other ends', async ($, on) => {
  stubFlatProject(on, 3)
  const focused = recordFocus(on)
  await openTree($)

  // Wide enough for the header to draw every control, `expand` first
  const ui = await $.ui.mount(paneOf(30, 80))

  // Past the last row lie the hidden digit Buttons: the ring stays put
  await $.ui.focus(ringOnto('row:f02.txt'))
  expect(await $.ui.focus(ringOnto('depth-0'))).toEqual({})
  expect(focused).toEqual(['row:f02.txt'])

  // With a file previewed, its controls come last: past them the ring wraps
  // to the tree's first row; from the first control it wraps back to the last
  await ui.press({ key: 'row:f02.txt' })
  await $.ui.focus(ringOnto('preview-close'))
  await $.ui.focus(ringOnto('depth-0'))
  await $.ui.focus(ringOnto('help'))
  await $.ui.focus(ringOnto('expand-level'))
  await $.ui.focus(ringOnto('depth-9'))
  expect(focused).toEqual(['row:f02.txt', 'preview-close', 'row:f00.txt', 'help', 'expand-level', 'preview-close'])

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

test('rows of wide names fill the row exactly, in cells', async ($, on) => {
  const names = [
    '日本語.md',
    '🚀launch.ts',
    '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}family.txt',
    'cafe\u0301.md',
    'ｌｏｎｇ全角フォルダ名のファイル.txt',
  ]

  stubProject(on, { [ROOT]: names.map(name => entry(name, 'file', 2)) }, {})
  await openTree($)

  for (const bodyColumns of [24, 40]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns } })
    const drawn = await ui.drawn()

    for (const name of names) {
      // The row: its branch lines' Text, then the Button padded to the end
      const path = pathTo(drawn, element => element.props?.key === `row:${name}`)
      const [branch, button] = path.at(-2)?.children ?? []
      const branchText = (branch as ElementData | undefined)?.children?.[0]
      const label = (button as ElementData | undefined)?.props?.label

      expect(typeof branchText === 'string' && typeof label === 'string').toBe(true)
      expect(cellWidth(String(branchText)) + cellWidth(String(label))).toBe(bodyColumns - 1)
    }

    await ui.unmount()
  }
})

// PowerShell is Claude Code's shell on native Windows; the hook matches it by
// pattern, since only Windows builds list the tool
for (const tool of ['Bash', 'PowerShell'] as const) {
  test(`after a ${tool} command, an open pane re-reads its tree`, async ($, on) => {
    const clock = mock.clock(on)
    const folders: Record<string, FsEntry[]> = { [ROOT]: [entry('a.txt', 'file', 2)] }
    let isOpen = false

    on('session.root', () => ({ value: ROOT }))
    on('ui.panes', () => ({
      value: isOpen
        ? [{ id: 'file-explorer', title: 'Explorer', isShown: true, isFocused: true, isPlaced: true, plugin: 'file-explorer' }]
        : [],
    }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('fs.list', ($, e) => ({ value: folders[testPathOf(e.path)] ?? [] }))
    on('fs.stat', () => ({ value: { kind: 'file', size: 2, mtimeMs: 0, isLink: false } }))
    on('fs.read', () => ({ value: 'hi' }))
    on('tool.call', () => ({ result: 'ran' }))

    await openTree($)
    isOpen = true

    const ui = await $.ui.mount(paneOf(30))
    expect(await ui.find({ key: 'row:b.txt' })).toBeUndefined()

    // The command writes a file; the pane re-reads once Claude pauses
    folders[ROOT] = [entry('a.txt', 'file', 2), entry('b.txt', 'file', 2)]
    await $.tool.call({ tool, command: 'echo hi > b.txt' } as never)
    await clock.advance(Limits.REFRESH_DEBOUNCE_MS)

    await ui.redraw()
    expect(await ui.find({ key: 'row:b.txt' })).toBeDefined()

    await ui.unmount()
  })
}
