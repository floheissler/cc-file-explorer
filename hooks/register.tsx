import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

import {
  filteredListingOf,
  filteredTreeOf,
  filterIndexOf,
  filterStatusOf,
  filterViewOf,
  firstMatchOf,
  foldedSetOf,
  openedOf,
  queryOf,
  searchingRows,
  type FilterIndex,
  type FilterView,
} from './filter'
import { focusOrderOf, focusStepOf, ringElementOf, ringPlaceOf, type FocusOrder } from './focus'
import { followedFileOf, pressStepOf } from './follow'
import { hasStampMoved, isSameRead, readGitStatus, stampsOf, type GitRead } from './git'
import type { Host } from './host'
import {
  escapeStepOf,
  inlineLayoutOf,
  inlineViewOf,
  paneLayoutOf,
  regionAt,
  type PaneLayout,
} from './layout'
import Limits from './limits'
import { collapseOneLevel, expandOneLevel, expandToDepth, type ListingOf, type ReadDirs } from './levels'
import {
  fileStampOf,
  openListing,
  readDirs,
  readFileList,
  readPreview,
  readTree,
  realKeyOf,
  stampDirs,
  type Listing,
} from './listing'
import { insertionOf, mentionOf, mentionPathOf, mentionTargetOf, mentionToastOf } from './mention'
import {
  COMMAND_DESCRIPTION,
  filterKeyOf,
  FULLSCREEN_TIP_TEXT,
  PANE_TITLE,
  ROW_KEY_PREFIX,
  TIP_SHOWN_KEY,
  WIDEN_TIP_TEXT,
} from './names'
import { ancestorsOf, foldKey, isAbsolute, isSameKey, keyOf, rootLabelOf, styleOf } from './paths'
import {
  changedDirsOf,
  hasSucceeded,
  mayHaveWritten,
  pollBatchOf,
  shownDirsOf,
  writtenPathOf,
} from './poll'
import { maxPreviewTop, previewHeightOf, sourceColumnsOf, type Preview } from './preview'
import { findEntry, revealPathsOf, rowsRevealing } from './reveal'
import { loadFolders, saveFolders } from './saved'
import { NO_MARKS, treeMarksOf } from './status'
import { messageOf, sanitize, truncateMiddle } from './text'
import {
  clamp,
  flattenTree,
  focusLandingOf,
  maxTreeTop,
  topRevealing,
  treeWindowOf,
  type Entry,
  type PathSet,
  type TreeRow,
} from './tree'
import { helpHeightOf, paneView, type FilterModel, type PaneActions, type Seat } from './view'

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
 * and `/branch` reset it. The open folders are also saved for the project
 * (saved.ts), and a session's first open and those resets start from them.
 */
const EXPANDED = atom({ plugin: 'file-explorer', key: 'expanded' } as const, [])
const SELECTED = atom({ plugin: 'file-explorer', key: 'selected' } as const, null)
const TREE_TOP = atom({ plugin: 'file-explorer', key: 'treeTop' } as const, 0)
const PREVIEW_TOP = atom({ plugin: 'file-explorer', key: 'previewTop' } as const, 0)
const PINNED = atom({ plugin: 'file-explorer', key: 'pinned' } as const, false)
const MARKDOWN_MODE = atom({ plugin: 'file-explorer', key: 'markdownMode' } as const, 'rendered')
const HELP_SHOWN = atom({ plugin: 'file-explorer', key: 'helpShown' } as const, false)
const FILTER = atom({ plugin: 'file-explorer', key: 'filter' } as const, null)

/**
 * The files Claude wrote this session, which the tree marks: session state
 * too, so `/clear` and `/resume` start a new list, as they start a new
 * session.
 */
const WRITTEN = atom({ plugin: 'file-explorer', key: 'written' } as const, [])

/**
 * What the last drawing laid out: the scroll and focus hooks steer by it.
 */
type Drawn = {
  readonly rows: readonly TreeRow[]
  readonly layout: PaneLayout
  /**
   * The cells across a row.
   */
  readonly columns: number
  /**
   * Whether the filter's row sat over the tree.
   */
  readonly hasFilter: boolean
}

/**
 * The tree a level step works on, the one the pane shows: its folders as
 * drawn, which are open, how to read more, and where the step's result is
 * kept.
 */
type ShownFolders = {
  readonly listingOf: ListingOf
  readonly expanded: PathSet
  readonly read: ReadDirs
  readonly open: (paths: readonly string[]) => Promise<void>
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
    cwd: () => $.session.cwd(),
    run: (argv, init) => $.process.run(argv, init),
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
    realPath: async path => (await $.fs.stat(path, { resolve: true })).realPath,
    read: path => $.fs.read(path),
    panes: () => $.ui.panes(),
    invalidate: () => $.ui.invalidate('ui.render'),
    focus: key => $.ui.focus({ requestId: PANE_ID, key }),
    after: (ms, fn) => $.clock.after(ms, fn),
    toast: text => $.ui.toast(text),
    prompt: {
      read: () => $.prompt.read(),
      fill: args => $.prompt.fill(args),
    },
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    state: {
      expanded: {
        get: () => read($, EXPANDED),
        set: async fn => {
          await update($, EXPANDED, fn)
        },
        // The atom reads its default while unset, the plain reference nothing
        isSet: async () =>
          (await $.state.get({ plugin: 'file-explorer', key: 'expanded' })).value !== undefined,
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
      pinned: {
        get: () => read($, PINNED),
        set: async fn => {
          await update($, PINNED, fn)
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
      filter: {
        get: () => read($, FILTER),
        set: async fn => {
          await update($, FILTER, fn)
        },
      },
      written: {
        get: () => read($, WRITTEN),
        set: async fn => {
          await update($, WRITTEN, fn)
        },
      },
    },
  }
}

/**
 * What `/tree` opens the pane with, and opens it again with: focused, as
 * tall as its content inline up to `INLINE_ROWS` (the dock ignores `rows`),
 * and under the classic renderer closed by Esc, as Claude Code's own dialogs
 * are. One builder, as each open sets every one of these anew.
 *
 * @param isClassic whether the session draws with the classic renderer
 * @returns the open's argument
 */
function paneArgsOf(isClassic: boolean) {
  const base = { id: PANE_ID, title: PANE_TITLE, focus: true, rows: Limits.INLINE_ROWS } as const

  return isClassic ? { ...base, closeOnEscape: true as const } : base
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
   * Where the focus ring rests in the focus order. Claude Code keeps it at
   * that place across a redraw, so `a` reads the row under it off the last
   * drawing, not off `lastFocused`, which a redraw that adds rows above it
   * leaves naming a row the ring has left.
   */
  let ringPlace: number | null = null

  /**
   * The row the ring was on when `a` handed the keyboard to the prompt: the
   * ring starts there again as the pane takes the keyboard back, so the
   * person walks on from it. Cleared once the ring lands anywhere.
   */
  let ringReturn: string | null = null

  /**
   * Forgets where the ring was: a pane without the keyboard shows none, and
   * takes the keyboard back with the ring on nothing, or on its autofocused
   * row.
   */
  const dropRing = () => {
    ringPlace = null
    lastFocused = undefined
  }

  /**
   * Notes where the ring went: the element it landed on, and its place in
   * the drawing it landed in. The row `a` left lets go of the ring then, and
   * a preview that follows the ring shows the file it landed on.
   */
  const noteRing = (host: Host, element: string | undefined, place: number | null) => {
    lastFocused = element
    ringPlace = place

    if (ringReturn !== null) {
      ringReturn = null
      host.invalidate()
    }

    // The ring moves on at once; the preview catches up once the file is read
    void followRing(host, element).catch(() => undefined)
  }

  /**
   * The previewed file's stamp when it was read, and whether `refresh` is
   * reading the tree: a poll leaves the disk alone while it is.
   */
  let previewStamp: { readonly path: string; readonly stamp: string | null } | null = null
  let isRefreshing = false

  /**
   * Where the last drawing sat, and whether an inline pane shows the picked
   * file in place of the tree. `/tree` opens on the tree; picking a file
   * shows it; `x`, Esc or the close mark step back.
   */
  let seat: Seat = { placement: 'dock', isClassic: false }
  let isFileShown = false

  /**
   * The rows the pane's body had at its last drawing (docked, its height;
   * inline, the most it may take), and the entry `/tree <path>` revealed,
   * whose row takes the focus ring as the pane takes the keyboard until the
   * person moves the ring. A pane opened afresh has neither yet.
   */
  let room: number | null = null
  let revealed: string | null = null

  /**
   * Whether this session was told once to widen a fullscreen terminal too
   * narrow to dock the pane.
   */
  let hasToldWiden = false

  /**
   * Switches of the preview to another file, one at a time: the one asked
   * for next, which a later ask replaces, so walking the tree reads the file
   * the ring stops on, not each one it passed; the run under way; and a
   * generation `forget` moves on, dropping both.
   */
  const switching = {
    next: null as {
      readonly host: Host
      readonly path: string
      readonly isFollow: boolean
      readonly generation: number
    } | null,
    run: null as Promise<void> | null,
    generation: 0,
  }

  /**
   * The preview drawn while a switch to another file waits for the session
   * state to name it: the file read is `preview` from the moment it is read,
   * and this one stays drawn until then, so the title, the facts and the
   * text switch together.
   */
  let leaving: Preview | null = null

  /**
   * The polls for changes made outside Claude, while the pane is open: one
   * pending wait at a time, each poll scheduling the next as it ends, so
   * polls never overlap. A stop moves `generation` on, so a poll still
   * running when the pane closed schedules nothing.
   */
  const polling = { isOn: false, generation: 0, cursor: 0, timer: null as Timer | null }

  /**
   * The filter, beyond its query in the session state:
   * - the project's files as read for it, as an index, read once per
   *   filter and again after a refresh (`generation` drops a read overtaken
   *   by one);
   * - the text in its field, ahead of the query while typing pauses;
   * - how many times Enter was pressed in the field, which keys the field;
   * - the last query's matches, and the folders the filtered tree has open
   *   for them;
   * - where the whole tree's window stood when the filter opened.
   */
  const filtering = {
    index: null as FilterIndex | null,
    load: null as Promise<void> | null,
    generation: 0,
    typed: null as string | null,
    submits: 0,
    debounce: null as Timer | null,
    found: null as { readonly index: FilterIndex; readonly text: string; readonly view: FilterView } | null,
    open: null as { readonly text: string; readonly view: FilterView; readonly folders: Set<string> } | null,
    treeTopBefore: 0,
  }

  /**
   * Drops the filter's file list, so the next drawing that filters reads it
   * afresh.
   */
  const dropFileList = () => {
    filtering.generation += 1
    filtering.index = null
    filtering.load = null
    filtering.found = null
  }

  /**
   * Leaves the filter's own state: the field's text and the open folders.
   */
  const leaveFilter = () => {
    filtering.debounce?.cancel()
    filtering.debounce = null
    filtering.typed = null
    filtering.open = null
  }

  /**
   * Git's view of the tree as last read, null where the root is in no
   * repository or git failed; the read under way, one at a time, and
   * whether another was asked for meanwhile; and whether what is held is
   * due a read, as after `forget`, which keeps it drawn until then.
   */
  let gitRead: GitRead | null = null
  let gitLoad: Promise<void> | null = null
  let isGitDue = false
  let isGitStale = true

  /**
   * Drops what was read, so the next drawing reads the project afresh. Git's
   * view stays drawn until it is read again, so markers do not blink.
   */
  const forget = () => {
    listing = null
    listingLoad = null
    preview = null
    previewLoad = null
    previewStamp = null
    leaving = null
    switching.next = null
    switching.generation += 1
    drawn = null
    room = null
    revealed = null
    dirLoads.clear()
    polling.cursor = 0
    dropFileList()
    leaveFilter()
    isGitStale = true
  }

  /**
   * Reads git's view of the tree, and redraws when it says something new.
   * A read asked for while one runs is run once after it, and the promise
   * settles when that one has: every caller sees git as it stood after it
   * asked.
   */
  const loadGit = (host: Host): Promise<void> => {
    if (gitLoad !== null) {
      isGitDue = true

      return gitLoad
    }

    gitLoad = (async () => {
      try {
        do {
          isGitDue = false

          const read = await readGitStatus(host, await host.root())
          const isSame = isSameRead(gitRead, read)

          gitRead = read
          isGitStale = false

          if (!isSame) {
            host.invalidate()
          }
        } while (isGitDue)
      } finally {
        gitLoad = null
      }
    })()

    return gitLoad
  }

  /**
   * Whether the repository's index or HEAD moved since git was read: a
   * commit, a stage or a checkout made outside Claude. Not while a read
   * runs, which stamps them afresh.
   */
  const hasGitMoved = async (host: Host): Promise<boolean> => {
    const read = gitRead

    if (read === null || gitLoad !== null) {
      return false
    }

    return hasStampMoved(read.stamps, await stampsOf(host, [...read.stamps.keys()]))
  }

  /**
   * Remembers a file Claude wrote this session by its key, the latest
   * last; a path outside the root is left out.
   */
  const recordWritten = async (host: Host, path: string) => {
    const root = await host.root()
    const key = keyOf(root, path) ?? (await realKeyOf(host, root, path))

    if (key === null || key === '') {
      return
    }

    const style = styleOf(root)

    await host.state.written.set(keys =>
      [...keys.filter(known => !isSameKey(known, key, style)), key].slice(-Limits.MAX_WRITTEN_FILES),
    )
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
   * Reads the project's file list for the filter anew. The index it had
   * stays drawn until the new one is in; a read a later one overtook is
   * dropped.
   */
  const loadFilterIndex = (host: Host): Promise<void> => {
    filtering.generation += 1

    const generation = filtering.generation

    const load: Promise<void> = (async () => {
      const opened = await ensureListing(host)
      const index = filterIndexOf(await readFileList(host, opened))

      if (generation === filtering.generation) {
        filtering.index = index
        host.invalidate()
      }
    })().finally(() => {
      if (filtering.load === load) {
        filtering.load = null
      }
    })

    filtering.load = load

    return load
  }

  /**
   * The filter's index of the project's files, read once.
   */
  const ensureFilterIndex = (host: Host): Promise<void> =>
    filtering.index !== null ? Promise.resolve() : (filtering.load ?? loadFilterIndex(host))

  /**
   * What a query finds in the index, worked out once per query and index,
   * as every drawing, focus move and scroll asks again.
   *
   * @returns what it found, or null for a blank query
   */
  const filterViewFor = (index: FilterIndex, text: string, root: string): FilterView | null => {
    const query = queryOf(text)

    if (query === null) {
      return null
    }

    if (filtering.found?.index !== index || filtering.found.text !== text) {
      const view = filterViewOf(index, query, Limits.MAX_FILTER_MATCHES, styleOf(root))

      filtering.found = { index, text, view }
    }

    return filtering.found.view
  }

  /**
   * The folders the filtered tree has open, folded keys: every folder that
   * holds a match, until the person opens or closes some. A new query starts
   * again from those; the same query over a file list read again keeps the
   * person's choices and opens the folders of new matches.
   */
  const openFoldersOf = (view: FilterView, text: string): Set<string> => {
    const open = filtering.open

    if (open !== null && open.text === text && open.view === view) {
      return open.folders
    }

    const folders =
      open === null || open.text !== text
        ? openedOf(view)
        : new Set([...open.folders, ...[...view.ancestors].filter(dir => !open.view.ancestors.has(dir))])

    filtering.open = { text, view, folders }

    return folders
  }

  /**
   * The query the tree is filtered by, what it found, and the folders as
   * the filtered tree draws them; null while the tree is not filtered, or
   * its file list is still being read.
   */
  const filterNow = async (host: Host, opened: Listing) => {
    const text = await host.state.filter.get()

    if (text === null || filtering.index === null) {
      return null
    }

    const view = filterViewFor(filtering.index, text, opened.root)

    return view === null
      ? null
      : { text, view, listingOf: filteredListingOf(dir => opened.dirs.get(dir), view) }
  }

  /**
   * The tree as the pane shows it: the whole tree, or while the filter holds
   * a query, the tree of what it found, a note while its files are read.
   *
   * @param current the folders as read
   * @param expanded the whole tree's open folders
   * @param text the filter's query, null while it is not shown
   * @param onUnread told each open folder not read yet
   * @returns the rows, and what the query found
   */
  const shownTreeOf = (
    current: Listing,
    expanded: readonly string[],
    text: string | null,
    onUnread: (dir: string) => void = () => undefined,
  ): { readonly rows: TreeRow[]; readonly view: FilterView | null } => {
    const listingOf: ListingOf = dir => {
      const found = current.dirs.get(dir)

      if (found === undefined) {
        onUnread(dir)
      }

      return found
    }

    if (text === null || queryOf(text) === null) {
      return { rows: flattenTree(listingOf, new Set(expanded)), view: null }
    }

    const view = filtering.index === null ? null : filterViewFor(filtering.index, text, current.root)

    return view === null
      ? { rows: searchingRows(), view: null }
      : { rows: filteredTreeOf(listingOf, view, openFoldersOf(view, text)), view }
  }

  /**
   * Saves of the open folders to the store, one at a time and in order, each
   * saving the folders open when it runs: the last save leaves the store as
   * the tree stands.
   */
  let saves: Promise<void> = Promise.resolve()

  /**
   * Opens or closes folders of the whole tree, and saves the folders then
   * open for the project, so its next session opens the tree where this one
   * left it. A filtered tree's own open folders are the module's, unsaved.
   */
  const setExpanded = async (host: Host, change: (paths: string[]) => string[]) => {
    await host.state.expanded.set(change)

    // A failed save keeps the one before it; the next change saves again
    const save = saves
      .then(async () => saveFolders(host, await host.state.expanded.get(), Date.now()))
      .catch(() => undefined)

    saves = save
    await save
  }

  /**
   * Opens the tree where the project's open folders were last saved, by
   * this session or another; nothing saved leaves it as it is.
   */
  const restoreFolders = async (host: Host) => {
    const saved = await loadFolders(host)

    if (saved !== null) {
      await host.state.expanded.set(() => saved)
    }
  }

  /**
   * The tree a level step works on: the filtered tree while the filter holds
   * a query, its open folders kept here; else the whole tree, its open
   * folders kept in the session state.
   */
  const shownFoldersOf = async (host: Host): Promise<ShownFolders> => {
    const opened = await ensureListing(host)
    const read: ReadDirs = dirs => readDirs(host, opened, dirs)
    const filter = await filterNow(host, opened)

    if (filter === null) {
      return {
        listingOf: dir => opened.dirs.get(dir),
        expanded: new Set(await host.state.expanded.get()),
        read,
        open: async paths => {
          await setExpanded(host, () => [...paths])
        },
      }
    }

    const { text, view, listingOf } = filter
    const folders = openFoldersOf(view, text)

    return {
      listingOf,
      expanded: foldedSetOf(folders, view.style),
      read,
      open: async paths => {
        folders.clear()
        paths.forEach(path => folders.add(foldKey(path, view.style)))
        host.invalidate()
      },
    }
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
        preview = loaded.preview
        previewStamp = { path, stamp: loaded.stamp }
      }
    } finally {
      if (previewLoad === path) {
        previewLoad = null
      }
    }
  }

  /**
   * Shows a file in the preview from its top: read first, then named in the
   * session state, `leaving` drawn meanwhile. A later switch to another file
   * waiting, or `forget`, drops it; a follow of the ring lapses where the
   * preview was closed or pinned since the ring moved, and a pick of the
   * person's never does. A file the preview shows already is left as it is.
   */
  const switchOnce = async (host: Host, path: string, isFollow: boolean, generation: number) => {
    const isWanted = async () => {
      const [selected, isPinned] = await Promise.all([host.state.selected.get(), host.state.pinned.get()])

      // A click on a file asks twice, as the ring lands on its row and as it
      // presses it: the second ask waits for this one
      const isReplaced = switching.next !== null && switching.next.path !== path

      return (
        !isReplaced &&
        generation === switching.generation &&
        selected !== path &&
        !(isFollow && (selected === null || isPinned))
      )
    }

    if (!(await isWanted())) {
      return
    }

    const opened = await ensureListing(host)
    const loaded = await readPreview(host, opened.root, path)

    if (!(await isWanted())) {
      return
    }

    // A read of the leaving file still under way is dropped
    leaving = preview
    preview = loaded.preview
    previewStamp = { path, stamp: loaded.stamp }
    previewLoad = null

    try {
      // A follow never opens a preview closed meanwhile
      await Promise.all([
        host.state.selected.set(current => (isFollow && current === null ? null : path)),
        host.state.previewTop.set(() => 0),
      ])
    } finally {
      leaving = null
    }
  }

  /**
   * Asks for the preview to show a file, after any switch under way.
   *
   * @param isFollow whether the ring's move asks it, not the person's pick
   * @returns settles once the switches asked for so far have run
   */
  const switchPreview = (host: Host, path: string, isFollow: boolean): Promise<void> => {
    switching.next = { host, path, isFollow, generation: switching.generation }

    switching.run ??= (async () => {
      try {
        while (switching.next !== null) {
          const ask = switching.next

          switching.next = null

          // A failed switch leaves the preview as it was, and the next runs
          await switchOnce(ask.host, ask.path, ask.isFollow, ask.generation).catch(() => undefined)
        }
      } finally {
        switching.run = null
      }
    })()

    return switching.run
  }

  /**
   * Shows the file of the row the ring landed on, docked, in a preview that
   * is open and follows the ring.
   */
  const followRing = async (host: Host, element: string | undefined) => {
    const rows = drawn?.rows ?? []
    const { placement } = seat
    const [selected, isPinned] = await Promise.all([host.state.selected.get(), host.state.pinned.get()])
    const path = followedFileOf(element, rows, { selected, isPinned, placement })

    if (path !== null) {
      await switchPreview(host, path, true)
    }
  }

  /**
   * Closes the preview, inline back to the tree, and lets go of its pin: the
   * next file previewed follows the ring again.
   */
  const closePreview = async (host: Host) => {
    isFileShown = false
    await Promise.all([host.state.selected.set(() => null), host.state.pinned.set(() => false)])
  }

  /**
   * Moves the tree's window so a row and its neighbors show, under the
   * layout the pane has with or without a preview.
   */
  const revealRow = async (host: Host, path: string, hasPreview: boolean) => {
    if (drawn === null || seat.placement === 'inline') {
      return
    }

    const { rows, layout } = drawn
    const index = rows.findIndex(row => row.type === 'entry' && row.path === path)

    if (index < 0) {
      return
    }

    const { treeRows } = paneLayoutOf(layout.bodyRows, hasPreview, drawn.hasFilter)

    await host.state.treeTop.set(top => topRevealing(index, top, rows.length, treeRows))
  }

  /**
   * The tree window's top that shows a row and its neighbors. On a pane
   * drawn before, it moves as little as the focus ring moves it, under the
   * layout the pane will have. On one opened afresh, whose height is not
   * known until it draws, the row above it comes first, which shows the row
   * in a tree of `MIN_TREE_ROWS` rows or more, the markers of the rows out
   * of view included.
   */
  const revealTopOf = (rows: readonly TreeRow[], index: number, top: number, hasPreview: boolean): number => {
    if (index < 0) {
      return top
    }

    if (room === null) {
      return Math.max(0, index - 1)
    }

    const { treeRows } =
      seat.placement === 'inline' ? inlineLayoutOf(room, 'tree', rows.length) : paneLayoutOf(room, hasPreview)

    return topRevealing(index, top, rows.length, treeRows)
  }

  /**
   * Opens the tree onto an entry: the folders above it open, and a folder
   * itself; a file is picked and previewed, inline in the tree's place. The
   * window moves to the entry's row, the open folders above it read first so
   * the row is drawn where the window expects it, and the row takes the
   * focus ring as the pane takes the keyboard.
   */
  const showEntry = async (host: Host, opened: Listing, entry: Entry) => {
    const isDir = entry.kind === 'dir'
    const before = await host.state.expanded.get()
    const opening = [...ancestorsOf(entry.path), ...(isDir ? [entry.path] : [])]
    const expanded = [...before, ...opening.filter(dir => !before.includes(dir))]

    if (isDir) {
      await readDirs(host, opened, [entry.path])
    }

    const { rows, index } = await rowsRevealing(
      dir => opened.dirs.get(dir),
      new Set(expanded),
      entry.path,
      dirs => readDirs(host, opened, dirs),
    )

    if (!isDir) {
      await switchPreview(host, entry.path, false)
    }

    const hasPreview = (await host.state.selected.get()) !== null

    isFileShown = !isDir
    revealed = entry.path
    await setExpanded(host, () => expanded)
    await host.state.treeTop.set(top => revealTopOf(rows, index, top, hasPreview))
  }

  /**
   * `/tree <path>`: shows the first of the paths the tree lists, each read
   * afresh along the way, so an entry made a moment ago is found. The root
   * itself shows the tree from its top. A path outside the project, or one
   * the tree does not list, is said in a toast, the path as typed.
   *
   * An absolute path that spells the root another way, through a link above
   * it (macOS's `/tmp` for `/private/tmp`), is placed by where it lands. A
   * relative one counts from the root alone: `$.fs` would resolve it from
   * the engine's working folder.
   */
  const reveal = async (host: Host, paths: readonly string[], typed: string) => {
    const opened = await ensureListing(host)
    const style = styleOf(opened.root)

    const placed = async (path: string) =>
      keyOf(opened.root, path) ??
      (isAbsolute(path, style) ? await realKeyOf(host, opened.root, path) : null)

    const readDir = async (dir: string) => {
      await readDirs(host, opened, [dir])

      return opened.dirs.get(dir)
    }

    let isOutside = true

    for (const path of paths) {
      const key = await placed(path)

      if (key === null) {
        continue
      }

      isOutside = false

      if (key === '') {
        await host.state.treeTop.set(() => 0)

        return
      }

      const entry = await findEntry(key, style, readDir)

      if (entry !== null) {
        await showEntry(host, opened, entry)

        return
      }
    }

    const shown = truncateMiddle(sanitize(typed), Limits.TOAST_PATH_CELLS)

    host.toast(`${isOutside ? 'Outside the project' : 'Not in the tree'}: ${shown}`)
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

    const textColumns =
      preview.kind === 'code' || preview.kind === 'markdown'
        ? sourceColumnsOf(preview.lines.length, drawn.columns)
        : undefined

    const max = maxPreviewTop(preview, drawn.layout.previewRows, isSource, textColumns)

    await host.state.previewTop.set(top => clamp(Math.min(top, max) + by, 0, max))
  }

  /**
   * Re-reads the tree's open folders, the previewed file and, the next time
   * the tree is filtered, the project's file list; and redraws; then git's
   * view of them. A closed pane only forgets what it read: it reads afresh
   * on opening.
   */
  const refresh = async (host: Host) => {
    const isOpen = (await host.panes()).some(pane => pane.id === PANE_ID)

    if (!isOpen) {
      forget()

      return
    }

    const isFiltering = queryOf((await host.state.filter.get()) ?? '') !== null

    if (!isFiltering) {
      dropFileList()
    }

    const opened = await openListing(host)

    isRefreshing = true

    try {
      await readTree(host, opened, await host.state.expanded.get())
    } finally {
      isRefreshing = false
    }

    listing = opened

    // A filtered tree keeps its matches drawn while the list is read again,
    // into the listing just read
    if (isFiltering) {
      void loadFilterIndex(host).catch(() => undefined)
    }

    const selected = await host.state.selected.get()

    if (selected !== null) {
      await loadPreview(host, selected)
    }

    host.invalidate()

    await loadGit(host)
  }

  /**
   * Re-reads the previewed file when its time or size moved since it was
   * read: deleted, it shows the read's notice, and comes back when the file
   * does.
   *
   * @returns whether the preview was read again
   */
  const pollPreview = async (host: Host, current: Listing): Promise<boolean> => {
    const selected = await host.state.selected.get()

    if (selected === null || previewLoad !== null || previewStamp?.path !== selected) {
      return false
    }

    if ((await fileStampOf(host, current.root, selected)) === previewStamp.stamp) {
      return false
    }

    await loadPreview(host, selected)

    return true
  }

  /**
   * One poll: the shown folders' times, a bounded batch taking turns past
   * the cap; the changed ones listed again, a bounded few; and the previewed
   * file. While the tree is filtered, the folders the filtered tree shows,
   * and a change among them reads the file list again, so a new match
   * appears. Git is read again when any of them changed, or when the
   * repository's index or HEAD moved, as a commit or a stage made outside
   * Claude moves no file the tree shows; never on every poll. A poll never
   * writes state.
   *
   * @returns whether the tree or the preview changed; a git read redraws
   *   by itself
   */
  const pollOnce = async (host: Host, current: Listing): Promise<boolean> => {
    const text = await host.state.filter.get()
    const { rows, view } = shownTreeOf(current, await host.state.expanded.get(), text)
    const shown = shownDirsOf(rows).filter(dir => !dirLoads.has(dir))
    const { batch, cursor } = pollBatchOf(shown, polling.cursor, Limits.MAX_POLL_STATS)

    polling.cursor = cursor

    const now = await stampDirs(host, current, batch)
    const changed = changedDirsOf(batch, current.stamps, now).slice(0, Limits.MAX_POLL_RELISTS)

    await readDirs(host, current, changed)

    if (view !== null && changed.length > 0 && filtering.load === null) {
      void loadFilterIndex(host).catch(() => undefined)
    }

    const isPreviewRead = await pollPreview(host, current)
    const isChanged = changed.length > 0 || isPreviewRead

    if (isChanged || (await hasGitMoved(host))) {
      await loadGit(host)
    }

    return isChanged
  }

  /**
   * Runs one poll, then schedules the next after the poll interval, or twice
   * the poll's own time when that is longer, which keeps the polls' share of
   * the disk's time bounded on a slow file system. Nothing is read while the
   * pane is hidden, or while the tree is being read anyway.
   */
  const runPoll = async (host: Host, generation: number) => {
    const started = Date.now()

    try {
      const pane = (await host.panes()).find(open => open.id === PANE_ID)

      if (pane === undefined) {
        stopPolling()

        return
      }

      const current = listing
      const isBusy = isRefreshing || listingLoad !== null || previewLoad !== null

      if (pane.isShown && current !== null && !isBusy && (await pollOnce(host, current))) {
        if (listing === current) {
          host.invalidate()
        }
      }
    } catch {
      // A failed poll waits for the next one
    } finally {
      if (polling.isOn && generation === polling.generation) {
        schedulePoll(host, generation, Math.max(Limits.POLL_MS, 2 * (Date.now() - started)))
      }
    }
  }

  const schedulePoll = (host: Host, generation: number, ms: number) => {
    polling.timer = host.after(ms, () => {
      polling.timer = null
      void runPoll(host, generation)
    })
  }

  const startPolling = (host: Host) => {
    if (polling.isOn) {
      return
    }

    polling.isOn = true
    polling.generation += 1
    schedulePoll(host, polling.generation, Limits.POLL_MS)
  }

  const stopPolling = () => {
    polling.isOn = false
    polling.generation += 1
    polling.timer?.cancel()
    polling.timer = null
  }

  /**
   * The line `/tree` leaves as it opens a pane inline: under the classic
   * renderer the fullscreen tip, once ever; on a fullscreen terminal too
   * narrow to dock, the width it takes, once a session.
   *
   * @returns the line, or null
   */
  const tipOf = async (host: Host, presentation: CommandPresentation | undefined): Promise<string | null> => {
    if (presentation === undefined) {
      return null
    }

    if (!presentation.isFullscreen) {
      if ((await host.store.get(TIP_SHOWN_KEY)) === true) {
        return null
      }

      await host.store.set(TIP_SHOWN_KEY, true)

      return FULLSCREEN_TIP_TEXT
    }

    if (presentation.columns < Limits.DOCK_MIN_COLUMNS && !hasToldWiden) {
      hasToldWiden = true

      return WIDEN_TIP_TEXT
    }

    return null
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

  /**
   * Moves the focus ring onto an element of the pane. The plugin's own move
   * raises no `ui.focus` of its own hooks, so it notes where the ring went.
   */
  const focusOn = async (host: Host, key: string) => {
    const moved = await host.focus(key).catch(() => ({ deny: 'the pane could not take the focus' }))

    // The ring landed once the element was drawn: its place is read off the
    // drawing that holds it
    if (moved.deny === undefined) {
      noteRing(host, key, ringPlaceOf(focusOrder, key))
    }
  }

  const focusField = (host: Host) => focusOn(host, filterKeyOf(filtering.submits))

  /**
   * Makes the tree show a query's matches: the filter's query in the session
   * state, and the tree's window at its top for a new query, or where the
   * whole tree's stood for a blank one. A filter closed meanwhile stays shut.
   */
  const applyFilter = async (host: Host, text: string) => {
    const before = await host.state.filter.get()

    if (before === null || before === text) {
      return
    }

    await host.state.filter.set(query => (query === null ? null : text))
    await host.state.treeTop.set(() => (queryOf(text) === null ? filtering.treeTopBefore : 0))
  }

  /**
   * The filtered tree with every folder it opens read, level by level.
   *
   * @returns its rows and what the query found, or null for a blank query
   */
  const readFilteredTree = async (host: Host, text: string) => {
    await ensureFilterIndex(host)

    const opened = await ensureListing(host)
    let before = ''

    for (;;) {
      const unread = new Set<string>()
      const shown = shownTreeOf(opened, [], text, dir => unread.add(dir))
      const reading = [...unread].join('\0')

      if (shown.view === null) {
        return null
      }

      // A folder that cannot be read is read as its error, so each pass
      // reads deeper; one that reads nothing new ends it
      if (unread.size === 0 || reading === before) {
        return { rows: shown.rows, view: shown.view }
      }

      before = reading
      await readDirs(host, opened, [...unread])
    }
  }

  /**
   * Shows a file in the whole tree: its folders open, the tree's window
   * moved to it in the dock, and the focus ring on it.
   */
  const revealInTree = async (host: Host, path: string) => {
    const opened = await ensureListing(host)
    const folders = ancestorsOf(path)

    await readDirs(host, opened, folders.filter(dir => !opened.dirs.has(dir)))
    await setExpanded(host, open => [...open, ...folders.filter(dir => !open.includes(dir))])

    const rows = flattenTree(dir => opened.dirs.get(dir), new Set(await host.state.expanded.get()))
    const index = rows.findIndex(row => row.type === 'entry' && row.path === path)

    if (index >= 0 && drawn !== null && seat.placement === 'dock') {
      const { treeRows } = paneLayoutOf(drawn.layout.bodyRows, true)

      await host.state.treeTop.set(() => topRevealing(index, filtering.treeTopBefore, rows.length, treeRows))
    }

    await focusOn(host, `${ROW_KEY_PREFIX}${path}`)
  }

  /**
   * Closes the filter: the whole tree shows again, the file picked while
   * filtering shown in it, else where its window stood.
   */
  const closeFilter = async (host: Host) => {
    leaveFilter()
    await host.state.filter.set(() => null)

    const selected = await host.state.selected.get()

    if (selected === null) {
      await host.state.treeTop.set(() => filtering.treeTopBefore)
    } else {
      await revealInTree(host, selected)
    }
  }

  const actionsOf = (host: Host): PaneActions => ({
    toggleDir: async path => {
      const opened = await ensureListing(host)
      const filter = await filterNow(host, opened)
      const folders = filter === null ? null : openFoldersOf(filter.view, filter.text)
      const folded = filter === null ? path : foldKey(path, filter.view.style)

      const isOpen =
        folders === null ? (await host.state.expanded.get()).includes(path) : folders.has(folded)

      // A folder read before is read again when it changed while closed,
      // as the polls only look at open folders
      const isStale = async () =>
        (await stampDirs(host, opened, [path])).get(path) !== opened.stamps.get(path)

      if (!isOpen && (!opened.dirs.has(path) || (await isStale()))) {
        await readDirs(host, opened, [path])
      }

      // The filtered tree keeps its open folders here, apart from the whole
      // tree's, which it leaves as they were
      if (folders !== null) {
        if (isOpen) {
          folders.delete(folded)
        } else {
          folders.add(folded)
        }

        host.invalidate()

        return
      }

      await setExpanded(host, paths =>
        paths.includes(path) ? paths.filter(open => open !== path) : [...paths, path],
      )
    },

    selectFile: async path => {
      revealed = null

      // Inline, a file takes the tree's place; picked again, it shows again
      if (seat.placement === 'inline') {
        await switchPreview(host, path, false)
        isFileShown = true
        host.invalidate()

        return
      }

      const [selected, isPinned] = await Promise.all([host.state.selected.get(), host.state.pinned.get()])

      switch (pressStepOf(path, selected, isPinned)) {
        case 'keep':
          return
        case 'close':
          await closePreview(host)

          return
        case 'show':
          await switchPreview(host, path, false)
          await revealRow(host, path, true)
      }
    },

    scrollPreview: lines => scrollPreviewBy(host, lines * Limits.KEY_ROWS),

    // The level steps work on the tree in view, filtered or whole
    expandLevel: () =>
      runLevelStep(async () => {
        const shown = await shownFoldersOf(host)
        const step = await expandOneLevel(shown.listingOf, shown.expanded, shown.read, Limits.MAX_LEVEL_FOLDERS)

        await shown.open(step.expanded)

        if (step.isCapped) {
          host.toast(cappedText('e'))
        }
      }),

    collapseLevel: () =>
      runLevelStep(async () => {
        const shown = await shownFoldersOf(host)

        await shown.open(collapseOneLevel(shown.listingOf, shown.expanded))
      }),

    showDepth: levels =>
      runLevelStep(async () => {
        const shown = await shownFoldersOf(host)
        const step = await expandToDepth(shown.listingOf, levels, shown.read, Limits.MAX_LEVEL_FOLDERS)

        await shown.open(step.expanded)
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

    togglePin: async () => {
      await host.state.pinned.set(pinned => !pinned)

      // Let go, the preview shows the file the ring rests on at once
      if (!(await host.state.pinned.get())) {
        await followRing(host, ringElementOf(focusOrder, ringPlace))
      }
    },

    closePreview: () => closePreview(host),

    refresh: () => refresh(host),

    toggleFilter: async () => {
      // The person turns to the filter: a revealed row no longer starts the ring
      revealed = null

      if ((await host.state.filter.get()) !== null) {
        await closeFilter(host)

        return
      }

      // Each filter reads the project's files afresh, from the moment it shows
      leaveFilter()
      filtering.typed = ''
      filtering.treeTopBefore = await host.state.treeTop.get()
      dropFileList()
      void ensureFilterIndex(host).catch(() => undefined)

      await host.state.helpShown.set(() => false)
      await host.state.filter.set(() => '')
      await focusField(host)
    },

    typeFilter: async text => {
      filtering.typed = text
      filtering.debounce?.cancel()
      filtering.debounce = host.after(Limits.FILTER_DEBOUNCE_MS, () => {
        filtering.debounce = null
        void applyFilter(host, text).catch(() => undefined)
      })
    },

    submitFilter: async text => {
      filtering.debounce?.cancel()
      filtering.debounce = null
      filtering.typed = text

      // Claude Code empties the field on Enter: the next one is drawn
      // holding the query
      filtering.submits += 1

      if (queryOf(text) === null) {
        await closeFilter(host)

        return
      }

      await applyFilter(host, text)

      const shown = await readFilteredTree(host, text)
      const first = shown === null ? null : firstMatchOf(shown.rows, shown.view)

      if (shown === null || first === null) {
        await focusField(host)

        return
      }

      // The plugin's own focus move raises none of its focus hooks: the
      // window is moved to the match here
      const index = shown.rows.findIndex(row => row.type === 'entry' && row.path === first)

      if (drawn !== null && seat.placement === 'dock') {
        const { treeRows } = paneLayoutOf(drawn.layout.bodyRows, drawn.layout.previewRows > 0, true)

        await host.state.treeTop.set(top => topRevealing(index, top, shown.rows.length, treeRows))
      }

      await focusOn(host, `${ROW_KEY_PREFIX}${first}`)
    },

    // The prompt box takes the keyboard as it takes the text, so the person
    // types on at once; Ctrl+X Tab brings the ring back to the row
    mention: async () => {
      const focused = ringElementOf(focusOrder, ringPlace)
      const target = mentionTargetOf(focused, drawn?.rows ?? null, await host.state.selected.get())

      if (target === null) {
        host.toast(mentionToastOf('none'))

        return
      }

      try {
        const opened = await ensureListing(host)
        const mention = mentionOf(mentionPathOf(opened.root, await host.cwd(), target), target.isDir)

        if ('problem' in mention) {
          host.toast(mentionToastOf(mention.problem, target.key))

          return
        }

        const box = await host.prompt.read()
        const filled = await host.prompt.fill({ text: insertionOf(box, mention.text), mode: 'insert' })

        if (!filled.isFilled) {
          host.toast(mentionToastOf(filled.refusal ?? 'refused', target.key))

          return
        }

        dropRing()
        ringReturn = focused === `${ROW_KEY_PREFIX}${target.key}` ? target.key : null
        host.invalidate()
      } catch (error) {
        host.toast(mentionToastOf('failed', target.key, messageOf(error)))
      }
    },
  })

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'tree',
        description: COMMAND_DESCRIPTION,
        argumentHint: '[path]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`file-explorer: could not register /${COMMAND_NAME}: ${messageOf(error)}`)
    }

    // A reload of the module cancels its waits but keeps the pane open: an
    // open pane's polls start again
    try {
      if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) {
        startPolling(hostOf($))
      }
    } catch {
      // The next /tree starts them
    }

    return next(e)
  })

  /**
   * `/clear`, `/resume` and `/branch` start the session state over: what was
   * read is forgotten, and the tree, open or not, opens again where the
   * project's folders were saved. Left at its default, the next change would
   * save the default over them.
   */
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    forget()
    await restoreFolders(hostOf($)).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * `/tree` toggles the pane. `/tree <path>` opens it onto that file or
   * folder, or reveals it in a pane already shown, which it never closes.
   */
  on('command.run', { command: 'tree' }, async ($, e) => {
    const host = hostOf($)
    const paths = revealPathsOf(e.args)
    const pane = (await $.ui.panes()).find(open => open.id === PANE_ID)
    const isShown = pane?.isShown === true

    if (isShown && paths.length === 0) {
      await $.ui.close({ id: PANE_ID })

      return {}
    }

    // A session's first open starts the tree where the project's folders
    // were saved; later opens keep the folders this session left open
    if (!(await host.state.expanded.isSet())) {
      await restoreFolders(host).catch(() => undefined)
    }

    // A pane opens on the whole tree: a file shown inline, the help, or a
    // filter is left. `/tree <path>` reveals in the whole tree too: a shown
    // pane closes its filter as `f` does, and keeps what it read and git's
    // markers, which its refreshes and polls keep fresh
    if (!isShown) {
      forget()
    } else if ((await host.state.filter.get()) !== null) {
      await closeFilter(host)
    }

    dropRing()
    ringReturn = null
    isFileShown = false
    revealed = null
    await update($, HELP_SHOWN, () => false)
    await update($, FILTER, () => null)

    // Git is read beside the open, never before it: its markers follow
    if (!isShown) {
      void loadGit(host).catch(() => undefined)
    }

    await ensureListing(host).catch(() => undefined)

    if (paths.length > 0) {
      const typed = e.args.trim()

      await reveal(host, paths, typed).catch(error =>
        host.toast(`Can't show ${truncateMiddle(sanitize(typed), Limits.TOAST_PATH_CELLS)}: ${messageOf(error)}`),
      )
    }

    host.invalidate()
    await $.ui.open(paneArgsOf(e.presentation?.isFullscreen === false))
    startPolling(host)

    const tip = await tipOf(host, e.presentation).catch(() => null)

    return tip === null ? {} : { text: tip }
  })

  on('ui.render', { component: 'Pane', requestId: 'file-explorer' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      return next(e)
    }

    const host = hostOf($)
    const { Box, Text, Button, Code, Markdown, Input } = $.ui.resolve(e)

    const [expanded, selected, treeTop, previewTop, isPinned, markdownMode, helpShown, filterText, written] =
      await Promise.all([
        read($, EXPANDED),
        read($, SELECTED),
        read($, TREE_TOP),
        read($, PREVIEW_TOP),
        read($, PINNED),
        read($, MARKDOWN_MODE),
        read($, HELP_SHOWN),
        read($, FILTER),
        read($, WRITTEN),
      ])

    const current = listing

    if (current === null) {
      void ensureListing(host).then(
        () => host.invalidate(),
        () => undefined,
      )
    }

    // A query filters the tree once the project's file list is read
    if (queryOf(filterText ?? '') !== null && filtering.index === null) {
      void ensureFilterIndex(host).catch(() => undefined)
    }

    const unread: string[] = []

    const shown =
      current === null
        ? { rows: flattenTree(() => undefined, new Set()), view: null }
        : shownTreeOf(current, expanded, filterText, dir => unread.push(dir))

    const { rows } = shown

    if (current !== null && unread.length > 0) {
      void loadDirs(host, current, unread).catch(() => undefined)
    }

    // Git's view as last read, of this root: a reload of the module drew
    // none yet, and reads it now
    if (isGitStale && gitLoad === null) {
      void loadGit(host).catch(() => undefined)
    }

    const marks =
      current === null
        ? NO_MARKS
        : treeMarksOf(rows, gitRead?.root === current.root ? gitRead.status : null, written, styleOf(current.root))

    // The file read for the selection, or while a switch waits for the state
    // to name the next, the one it leaves
    const inHand = preview?.path === selected ? preview : leaving?.path === selected ? leaving : null
    const isPreviewStale = selected !== null && inHand === null

    if (isPreviewStale && previewLoad !== selected) {
      void loadPreview(host, selected)
        .then(() => host.invalidate())
        .catch(() => undefined)
    }

    // The layout follows each drawing's seat: the pane moves between the dock
    // and inline as the terminal is resized. Inline it shows one view, as
    // tall as its content.
    seat = { placement: e.props.placement, isClassic: e.viewport?.isFullscreen === false }
    room = e.props.scroll.bodyRows

    // Without the keyboard the pane shows no ring, and it takes the keyboard
    // back with the ring on nothing, or on the row drawn to take it
    if (!e.props.isFocused) {
      dropRing()
    }

    // The cells across a row: the dock keeps a column clear at its edge
    const columns = Math.max(
      1,
      e.props.bodyColumns - (seat.placement === 'dock' ? Limits.RIGHT_PAD_COLUMNS : 0),
    )

    const shownPreview = inHand
    const inlineView = seat.placement === 'inline' ? inlineViewOf({ helpShown, isFileShown, selected }) : null

    // The filter's row sits over the tree, whole or filtered; the help and an
    // inline file view stand in for both
    const hasFilter = filterText !== null && !helpShown && inlineView !== 'file'

    const layout =
      inlineView === null
        ? paneLayoutOf(e.props.scroll.bodyRows, selected !== null, hasFilter)
        : inlineLayoutOf(
            e.props.scroll.bodyRows,
            inlineView,
            inlineView === 'tree'
              ? rows.length
              : inlineView === 'file'
                ? previewHeightOf(shownPreview)
                : helpHeightOf(seat, columns),
            hasFilter,
          )

    const window = treeWindowOf(rows.length, treeTop, layout.treeRows)

    // The help view stands in for the tree: the scroll and focus hooks then
    // have no rows to steer
    drawn = helpShown ? null : { rows, layout, columns, hasFilter }

    // The field holds what was typed, ahead of the query while typing pauses
    const filter: FilterModel | null =
      filterText === null
        ? null
        : {
            key: filterKeyOf(filtering.submits),
            value: filtering.typed ?? filterText,
            status: queryOf(filterText) === null ? '' : filterStatusOf(shown.view),
            isBlank: queryOf(filtering.typed ?? filterText) === null,
          }

    const tree = paneView(
      { Box, Text, Button, Code, Markdown, Input },
      actionsOf(host),
      columns,
      {
        seat,
        inlineView,
        rootName: current === null ? 'Explorer' : rootLabelOf(current.root),
        rows,
        marks,
        window,
        layout,
        selected,
        revealed,
        preview: shownPreview,
        previewTop,
        isPinned,
        markdownMode,
        helpShown,
        filter,
        mentioned: ringReturn,
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
   * row is drawn after the move. The ring comes into the pane at the tree's
   * first row, ahead of the header's controls, and stays off the hidden
   * digit Buttons: it stops at the tree's last row and wraps from the other
   * ends.
   */
  on('ui.focus', { requestId: 'file-explorer' }, async ($, e, next) => {
    // The revealed row holds the ring's start until the person moves it
    if (e.origin.kind === 'person') {
      revealed = null
    }

    // The drawing the ring moves in: moving the window below redraws the
    // pane before the ring lands
    const order = focusOrder
    const step = focusStepOf(e.element, lastFocused, order)

    if (step === 'stay') {
      return {}
    }

    // Passes the move on, remembering the element the ring ends up on, and
    // its place: where `moved` lands it in this drawing, which is where
    // `element` is drawn once the window moved
    const land = async (element: string | undefined, moved: typeof e) => {
      const result = await next(moved)

      if (result.deny === undefined) {
        noteRing(hostOf($), element, ringPlaceOf(order, moved.element))
      }

      return result
    }

    // A row the step moves the ring to scrolls into view as the person's own
    // move onto it would
    const target = step === 'pass' ? e : { ...e, element: step.element }
    const element = target.element ?? ''

    if (drawn === null || !element.startsWith(ROW_KEY_PREFIX)) {
      return land(target.element, target)
    }

    const { rows, layout } = drawn
    const top = await read($, TREE_TOP)
    const found = focusLandingOf(rows, top, layout.treeRows, element.slice(ROW_KEY_PREFIX.length))

    if (found === null) {
      return land(target.element, target)
    }

    if (found.top !== top) {
      await update($, TREE_TOP, () => found.top)
    }

    return land(target.element, { ...target, element: `${ROW_KEY_PREFIX}${found.landing}` })
  }).catch(($, e, next) => next(e))

  /**
   * The pane closing, by `/tree`, its close mark or a key: the polls stop.
   * Inline, the person's close steps back first, as Claude Code's own
   * dialogs do: from the file or the help to the tree, from a filtered tree
   * (Esc in the filter's field, under the classic renderer) to the whole
   * tree; the pane opens again with the keyboard, and the picked file's row
   * takes the focus ring. No `.catch`: a throw of `next` passes on as it
   * came, never run twice.
   */
  on('ui.close', { id: 'file-explorer' }, async ($, e, next) => {
    if (e.origin.kind === 'person' && seat.placement === 'inline') {
      const view = inlineViewOf({
        helpShown: await read($, HELP_SHOWN),
        isFileShown,
        selected: await read($, SELECTED),
      })

      const step = escapeStepOf(view, (await read($, FILTER)) !== null)

      if (step !== null) {
        if (step === 'unfilter') {
          await closeFilter(hostOf($)).catch(() => undefined)
        }

        isFileShown = false
        await update($, HELP_SHOWN, () => false)
        hostOf($).invalidate()
        void $.ui.open(paneArgsOf(seat.isClassic)).catch(() => undefined)

        return { deny: step === 'unfilter' ? 'back to the whole tree' : 'back to the tree' }
      }
    }

    const result = await next(e)

    if (result.deny === undefined) {
      stopPolling()
    }

    return result
  })

  /**
   * After a tool call that may have changed files, an open pane re-reads
   * what it shows, git's view included, once Claude pauses: an edit, or a
   * shell command (Bash, or PowerShell on native Windows) the engine did
   * not hold read-only. A call that threw may have written too. An edit
   * that went through marks its file as written this session, open pane or
   * not.
   *
   * The hook only watches. It has no `.catch`, whose handler would run the
   * call again after a throw of `next`: that throw passes on as it came, and
   * neither scheduling the refresh nor marking the file throws.
   *
   * PowerShell is matched by pattern: only Windows builds have the tool, so
   * the tool names other builds type the matcher with leave it out.
   */
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit', 'Bash', /^PowerShell$/] }, async ($, e, next) => {
    let result: ToolCallResult | undefined

    try {
      result = await next(e)

      return result
    } finally {
      if (listing !== null && mayHaveWritten(result)) {
        try {
          scheduleRefresh(hostOf($))
        } catch {
          // The call's own outcome stands
        }
      }

      const written = writtenPathOf(e)

      if (written !== null && hasSucceeded(result)) {
        await recordWritten(hostOf($), written).catch(() => undefined)
      }
    }
  })
}
