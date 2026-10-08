import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { focusOrderOf, focusStepOf, type FocusOrder } from './focus'
import type { Host } from './host'
import { paneLayoutOf, regionAt, type PaneLayout } from './layout'
import Limits from './limits'
import { collapseOneLevel, expandOneLevel, expandToDepth } from './levels'
import { openListing, readDirs, readPreview, readTree, type Listing } from './listing'
import { COMMAND_DESCRIPTION, PANE_TITLE, ROW_KEY_PREFIX } from './names'
import { rootLabelOf } from './paths'
import { maxPreviewTop, type Preview } from './preview'
import { messageOf } from './text'
import {
  clamp,
  flattenTree,
  focusLandingOf,
  maxTreeTop,
  topRevealing,
  treeWindowOf,
  type TreeRow,
} from './tree'
import { paneView, type PaneActions } from './view'

/**
 * The pane's id and the command that toggles it. The hooks' matchers spell
 * them as literals too, so `claude plugin validate` and an administrator's
 * review read exactly what each hook matches.
 *
 * The command is not named after the plugin: Claude Code 2.1.293's command
 * menu draws any command whose name starts with `file-` as a one-line
 * `+ /name – description` row instead of its two columns.
 */
const PANE_ID = 'file-explorer'
const COMMAND_NAME = 'tree'

/**
 * The pane's state the drawing reads, held by the session: it survives a
 * reload of the module, a write redraws the pane, and `/clear`, `/resume`
 * and `/branch` reset it.
 */
const EXPANDED = atom({ plugin: 'file-explorer', key: 'expanded' } as const, [])
const SELECTED = atom({ plugin: 'file-explorer', key: 'selected' } as const, null)
const TREE_TOP = atom({ plugin: 'file-explorer', key: 'treeTop' } as const, 0)
const PREVIEW_TOP = atom({ plugin: 'file-explorer', key: 'previewTop' } as const, 0)
const MARKDOWN_MODE = atom({ plugin: 'file-explorer', key: 'markdownMode' } as const, 'rendered')
const HELP_SHOWN = atom({ plugin: 'file-explorer', key: 'helpShown' } as const, false)

/**
 * What the last drawing laid out: the scroll and focus hooks steer by it.
 */
type Drawn = {
  readonly rows: readonly TreeRow[]
  readonly layout: PaneLayout
}

/**
 * Binds the engine calls the explorer makes to one hook's `$`. Every call
 * the mod makes on `$` is spelled here or in a hook below.
 *
 * @param $ the engine, as a hook receives it
 * @returns the calls, as a plain record
 */
function hostOf($: EngineInterface): Host {
  return {
    root: () => $.session.root(),
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
    read: path => $.fs.read(path),
    panes: () => $.ui.panes(),
    invalidate: () => $.ui.invalidate('ui.render'),
    after: (ms, fn) => $.clock.after(ms, fn),
    toast: text => $.ui.toast(text),
    state: {
      expanded: {
        get: () => read($, EXPANDED),
        set: async fn => {
          await update($, EXPANDED, fn)
        },
      },
      selected: {
        get: () => read($, SELECTED),
        set: async fn => {
          await update($, SELECTED, fn)
        },
      },
      treeTop: {
        get: () => read($, TREE_TOP),
        set: async fn => {
          await update($, TREE_TOP, fn)
        },
      },
      previewTop: {
        get: () => read($, PREVIEW_TOP),
        set: async fn => {
          await update($, PREVIEW_TOP, fn)
        },
      },
      markdownMode: {
        get: () => read($, MARKDOWN_MODE),
        set: async fn => {
          await update($, MARKDOWN_MODE, fn)
        },
      },
      helpShown: {
        get: () => read($, HELP_SHOWN),
        set: async fn => {
          await update($, HELP_SHOWN, fn)
        },
      },
    },
  }
}

/**
 * Registers the explorer: `/tree` toggles a pane that lists the project
 * as a tree, folders opening in place, and previews the file picked under
 * it. The pane scrolls its tree and its preview itself, under a header that
 * stays put, and re-reads what it shows after Claude's edits and commands.
 *
 * The person's view of the pane (open folders, the picked file, where each
 * window stands) is session state; the folders and the file as read are
 * this module's, read again after a reload as the pane draws.
 *
 * @param on the engine's registrar
 */
export const register: Register = on => {
  let listing: Listing | null = null
  let listingLoad: Promise<Listing> | null = null
  let preview: Preview | null = null
  let previewLoad: string | null = null
  let refreshTimer: Timer | null = null
  let drawn: Drawn | null = null
  const dirLoads = new Set<string>()

  /**
   * The focusable elements of the last drawing, and the key the focus ring
   * last landed on: the focus hook keeps the ring off the hidden ones by
   * where it comes from.
   */
  let focusOrder: FocusOrder = { shown: [], hidden: new Set() }
  let lastFocused: string | undefined

  /**
   * Drops what was read, so the next drawing reads the project afresh.
   */
  const forget = () => {
    listing = null
    listingLoad = null
    preview = null
    previewLoad = null
    drawn = null
    dirLoads.clear()
  }

  /**
   * The listing, with the root folder read: one read at a time.
   */
  const ensureListing = (host: Host): Promise<Listing> => {
    if (listing !== null) {
      return Promise.resolve(listing)
    }

    listingLoad ??= (async () => {
      try {
        const opened = await openListing(host)

        await readDirs(host, opened, [''])
        listing = opened

        return opened
      } finally {
        listingLoad = null
      }
    })()

    return listingLoad
  }

  /**
   * Reads folders the tree shows open but has not read, then redraws.
   */
  const loadDirs = async (host: Host, into: Listing, dirs: readonly string[]) => {
    const fresh = dirs.filter(dir => !dirLoads.has(dir))

    if (fresh.length === 0) {
      return
    }

    fresh.forEach(dir => dirLoads.add(dir))

    try {
      await readDirs(host, into, fresh)
    } finally {
      fresh.forEach(dir => dirLoads.delete(dir))
    }

    if (listing === into) {
      host.invalidate()
    }
  }

  /**
   * Reads the file the preview shows. A read overtaken by another pick is
   * dropped.
   */
  const loadPreview = async (host: Host, path: string) => {
    previewLoad = path

    try {
      const opened = await ensureListing(host)
      const loaded = await readPreview(host, opened.root, path)

      if (previewLoad === path) {
        preview = loaded
      }
    } finally {
      if (previewLoad === path) {
        previewLoad = null
      }
    }
  }

  /**
   * Moves the tree's window so a row and its neighbors show, under the
   * layout the pane has with or without a preview.
   */
  const revealRow = async (host: Host, path: string, hasPreview: boolean) => {
    if (drawn === null) {
      return
    }

    const { rows, layout } = drawn
    const index = rows.findIndex(row => row.type === 'entry' && row.path === path)

    if (index < 0) {
      return
    }

    const { treeRows } = paneLayoutOf(layout.bodyRows, hasPreview)

    await host.state.treeTop.set(top => topRevealing(index, top, rows.length, treeRows))
  }

  const scrollTreeBy = async (host: Host, by: number) => {
    if (drawn === null) {
      return
    }

    const max = maxTreeTop(drawn.rows.length, drawn.layout.treeRows)

    await host.state.treeTop.set(top => clamp(Math.min(top, max) + by, 0, max))
  }

  const scrollPreviewBy = async (host: Host, by: number) => {
    if (drawn === null || preview === null) {
      return
    }

    const isSource =
      preview.kind === 'code' ||
      (preview.kind === 'markdown' && (await host.state.markdownMode.get()) === 'source')

    const max = maxPreviewTop(preview, drawn.layout.previewRows, isSource)

    await host.state.previewTop.set(top => clamp(Math.min(top, max) + by, 0, max))
  }

  /**
   * Re-reads the tree's open folders and the previewed file, and redraws.
   * A closed pane only forgets what it read: it reads afresh on opening.
   */
  const refresh = async (host: Host) => {
    const isOpen = (await host.panes()).some(pane => pane.id === PANE_ID)

    if (!isOpen) {
      forget()

      return
    }

    const opened = await openListing(host)

    await readTree(host, opened, await host.state.expanded.get())
    listing = opened

    const selected = await host.state.selected.get()

    if (selected !== null) {
      await loadPreview(host, selected)
    }

    host.invalidate()
  }

  const scheduleRefresh = (host: Host) => {
    refreshTimer?.cancel()
    refreshTimer = host.after(Limits.REFRESH_DEBOUNCE_MS, () => {
      refreshTimer = null
      void refresh(host).catch(() => undefined)
    })
  }

  /**
   * Level steps run one after another, so presses in quick succession each
   * start from the tree the last one left.
   */
  let levelSteps: Promise<void> = Promise.resolve()

  const runLevelStep = (step: () => Promise<void>): Promise<void> => {
    levelSteps = levelSteps.then(step).catch(() => undefined)

    return levelSteps
  }

  const cappedText = (key: string) =>
    `Opened ${Limits.MAX_LEVEL_FOLDERS} folders, the most one step opens; press ${key} again for more`

  const actionsOf = (host: Host): PaneActions => ({
    toggleDir: async path => {
      const opened = await ensureListing(host)
      const isOpen = (await host.state.expanded.get()).includes(path)

      if (!isOpen && !opened.dirs.has(path)) {
        await readDirs(host, opened, [path])
      }

      await host.state.expanded.set(paths =>
        paths.includes(path) ? paths.filter(open => open !== path) : [...paths, path],
      )
    },

    selectFile: async path => {
      if ((await host.state.selected.get()) === path) {
        await host.state.selected.set(() => null)

        return
      }

      await loadPreview(host, path)
      await host.state.previewTop.set(() => 0)
      await host.state.selected.set(() => path)
      await revealRow(host, path, true)
    },

    scrollPreview: lines => scrollPreviewBy(host, lines * Limits.KEY_ROWS),

    expandLevel: () =>
      runLevelStep(async () => {
        const opened = await ensureListing(host)
        const step = await expandOneLevel(
          dir => opened.dirs.get(dir),
          new Set(await host.state.expanded.get()),
          dirs => readDirs(host, opened, dirs),
          Limits.MAX_LEVEL_FOLDERS,
        )

        await host.state.expanded.set(() => step.expanded)

        if (step.isCapped) {
          host.toast(cappedText('e'))
        }
      }),

    collapseLevel: () =>
      runLevelStep(async () => {
        const opened = await ensureListing(host)
        const open = collapseOneLevel(
          dir => opened.dirs.get(dir),
          new Set(await host.state.expanded.get()),
        )

        await host.state.expanded.set(() => open)
      }),

    showDepth: levels =>
      runLevelStep(async () => {
        const opened = await ensureListing(host)
        const step = await expandToDepth(
          dir => opened.dirs.get(dir),
          levels,
          dirs => readDirs(host, opened, dirs),
          Limits.MAX_LEVEL_FOLDERS,
        )

        await host.state.expanded.set(() => step.expanded)
        await host.state.treeTop.set(() => 0)

        if (step.isCapped) {
          host.toast(`Opened ${Limits.MAX_LEVEL_FOLDERS} folders, the most one step opens`)
        }
      }),

    toggleHelp: async () => {
      await host.state.helpShown.set(shown => !shown)
    },

    toggleMarkdownMode: async () => {
      await host.state.markdownMode.set(mode => (mode === 'rendered' ? 'source' : 'rendered'))
    },

    closePreview: async () => {
      await host.state.selected.set(() => null)
    },

    refresh: () => refresh(host),
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'tree',
        description: COMMAND_DESCRIPTION,
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`file-explorer: could not register /${COMMAND_NAME}: ${messageOf(error)}`)
    }

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    forget()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'tree' }, async ($, e) => {
    const pane = (await $.ui.panes()).find(open => open.id === PANE_ID)

    if (pane?.isShown === true) {
      await $.ui.close({ id: PANE_ID })

      return {}
    }

    forget()
    lastFocused = undefined
    await ensureListing(hostOf($)).catch(() => undefined)

    const isInline = e.presentation?.isFullscreen === false
    const base = { id: PANE_ID, title: PANE_TITLE, focus: true } as const

    await $.ui.open(isInline ? { ...base, closeOnEscape: true } : base)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'file-explorer' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return next(e)
    }

    const host = hostOf($)
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)

    const [expanded, selected, treeTop, previewTop, markdownMode, helpShown] = await Promise.all([
      read($, EXPANDED),
      read($, SELECTED),
      read($, TREE_TOP),
      read($, PREVIEW_TOP),
      read($, MARKDOWN_MODE),
      read($, HELP_SHOWN),
    ])

    const current = listing

    if (current === null) {
      void ensureListing(host).then(
        () => host.invalidate(),
        () => undefined,
      )
    }

    const unread: string[] = []

    const rows =
      current === null
        ? flattenTree(() => undefined, new Set())
        : flattenTree(dir => {
            const found = current.dirs.get(dir)

            if (found === undefined) {
              unread.push(dir)
            }

            return found
          }, new Set(expanded))

    if (current !== null && unread.length > 0) {
      void loadDirs(host, current, unread).catch(() => undefined)
    }

    const isPreviewStale = selected !== null && preview?.path !== selected

    if (isPreviewStale && previewLoad !== selected) {
      void loadPreview(host, selected)
        .then(() => host.invalidate())
        .catch(() => undefined)
    }

    const layout = paneLayoutOf(e.props.scroll.bodyRows, selected !== null)
    const window = treeWindowOf(rows.length, treeTop, layout.treeRows)

    // The help view stands in for the tree: the scroll and focus hooks then
    // have no rows to steer
    drawn = helpShown ? null : { rows, layout }

    const tree = paneView(
      { Box, Text, Button, Code, Markdown },
      actionsOf(host),
      Math.max(12, e.props.bodyColumns - Limits.RIGHT_PAD_COLUMNS),
      {
        rootName: current === null ? 'Explorer' : rootLabelOf(current.root),
        rows,
        window,
        layout,
        selected,
        preview: isPreviewStale ? null : preview,
        previewTop,
        markdownMode,
        helpShown,
      },
    )

    focusOrder = focusOrderOf(tree)

    return tree
  })

  /**
   * The person's wheel and page keys: the tree and the preview each scroll
   * their own window, by the region the pointer is over, and the engine's
   * window over the whole pane stays still, so the header never moves.
   */
  on('ui.scroll', { requestId: 'file-explorer' }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || drawn === null) {
      return next(e)
    }

    const host = hostOf($)
    const { layout } = drawn
    const hasPreview = layout.previewRows > 0

    const region =
      e.pointer === undefined
        ? hasPreview
          ? 'preview'
          : 'tree'
        : regionAt(layout, e.pointer.row)

    const isPage = e.pointer === undefined && Math.abs(e.by) >= e.bodyRows
    const direction = Math.sign(e.by)

    // A wheel tick's `by` already carries the person's scroll speed
    // (CLAUDE_CODE_SCROLL_SPEED, `/scroll-speed`), so it moves as the
    // conversation does
    if (region === 'tree') {
      await scrollTreeBy(host, isPage ? direction * Math.max(1, layout.treeRows - 2) : e.by)
    } else if (region === 'preview' || region === 'preview-head') {
      await scrollPreviewBy(host, isPage ? direction * Math.max(1, layout.previewRows - 1) : e.by)
    }

    return {}
  }).catch(($, e, next) => next(e))

  /**
   * The focus ring walking the tree: the window follows it, keeping a row
   * on each side of the focused one in view, and the ring lands where the
   * row is drawn after the move. The ring stays off the hidden digit
   * Buttons: it stops at the tree's last row and wraps from the other ends.
   */
  on('ui.focus', { requestId: 'file-explorer' }, async ($, e, next) => {
    const step = focusStepOf(e.element, lastFocused, focusOrder)

    if (step === 'stay') {
      return {}
    }

    // Passes the move on, remembering the element the ring ends up on
    const land = async (element: string | undefined, moved: typeof e) => {
      const result = await next(moved)

      if (result.deny === undefined) {
        lastFocused = element
      }

      return result
    }

    if (step !== 'pass') {
      return land(step.element, { ...e, element: step.element })
    }

    const element = e.element ?? ''

    if (drawn === null || !element.startsWith(ROW_KEY_PREFIX)) {
      return land(e.element, e)
    }

    const { rows, layout } = drawn
    const top = await read($, TREE_TOP)
    const found = focusLandingOf(rows, top, layout.treeRows, element.slice(ROW_KEY_PREFIX.length))

    if (found === null) {
      return land(e.element, e)
    }

    if (found.top !== top) {
      await update($, TREE_TOP, () => found.top)
    }

    return land(e.element, { ...e, element: `${ROW_KEY_PREFIX}${found.landing}` })
  }).catch(($, e, next) => next(e))

  /**
   * After a tool call that can change files, an open pane re-reads what it
   * shows once Claude pauses: an edit, or a shell command (Bash, or
   * PowerShell on native Windows). The hook only watches: a failure in it
   * lets the call's own result through.
   *
   * PowerShell is matched by pattern: only Windows builds have the tool, so
   * the tool names other builds type the matcher with leave it out.
   */
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit', 'Bash', /^PowerShell$/] }, async ($, e, next) => {
    const result = await next(e)

    if (listing !== null) {
      scheduleRefresh(hostOf($))
    }

    return result
  }).catch(($, e, next) => next(e))
}
