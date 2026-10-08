export type EntryKind = 'file' | 'dir' | 'other'

/**
 * One entry of a folder, its path relative to the project root.
 */
export type Entry = {
  readonly name: string
  readonly path: string
  readonly kind: EntryKind
  readonly size: number
}

/**
 * A folder as read: its entries in tree order and how many past the cap
 * were left out; or why it could not be read.
 */
export type DirListing =
  | { readonly entries: readonly Entry[]; readonly truncated: number }
  | { readonly error: string }

/**
 * One row of the flattened tree: an entry, or a note under a folder (still
 * loading, unreadable, empty, entries left out).
 */
export type TreeRow =
  | (Entry &
      Branch & {
        readonly type: 'entry'
        readonly depth: number
        readonly isExpanded: boolean
      })
  | (Branch & {
      readonly type: 'note'
      readonly key: string
      readonly depth: number
      readonly text: string
      readonly isError: boolean
    })

/**
 * Where a row sits among the rows of its folder, for the branch lines drawn
 * before it as the `tree` command draws them.
 */
export type Branch = {
  /**
   * One per folder above the row, outermost first: whether that folder has
   * rows still to come below this one, so its line continues past the row.
   */
  readonly guides: readonly boolean[]
  /**
   * Whether the row is the last of its folder.
   */
  readonly isLast: boolean
}

/**
 * Which rows of the flattened tree its window shows, and how many lie out of
 * view on each side. The counts take a row each, at the window's edges.
 */
export type TreeWindow = {
  readonly top: number
  readonly start: number
  readonly end: number
  readonly above: number
  readonly below: number
}

/**
 * A number held between two bounds.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Tree order, as Windows File Explorer sorts by name: every folder before any
 * file, then names as people sort them (dot names first, `file2` before
 * `file10`, case aside), then by code point so the order is total.
 */
export function compareEntries(a: Entry, b: Entry): number {
  const rank = (entry: Entry) => (entry.kind === 'dir' ? 0 : 1)

  return (
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )
}

/**
 * The tree as rows, top to bottom: each folder's entries in order, an open
 * folder's own beneath it one level deeper.
 *
 * @param listingOf a folder's listing, or undefined while it is not read
 * @param expanded the open folders' paths
 * @returns the rows
 */
export function flattenTree(
  listingOf: (dir: string) => DirListing | undefined,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = []

  // A note is always the last row of its folder: alone, or after the entries
  const note = (dir: string, guides: readonly boolean[], text: string, isError = false) =>
    rows.push({
      type: 'note',
      key: `note:${dir}`,
      depth: guides.length,
      guides,
      isLast: true,
      text,
      isError,
    })

  const visit = (dir: string, guides: readonly boolean[]): void => {
    const listing = listingOf(dir)

    if (listing === undefined) {
      note(dir, guides, 'Loading…')

      return
    }

    if ('error' in listing) {
      note(dir, guides, `Can't read this folder: ${listing.error}`, true)

      return
    }

    if (listing.entries.length === 0 && listing.truncated === 0) {
      note(dir, guides, dir === '' ? 'This folder is empty' : 'empty')

      return
    }

    const last = listing.entries.length - 1

    listing.entries.forEach((entry, at) => {
      const isLast = at === last && listing.truncated === 0
      const isExpanded = entry.kind === 'dir' && expanded.has(entry.path)

      rows.push({ ...entry, type: 'entry', depth: guides.length, guides, isLast, isExpanded })

      if (isExpanded) {
        visit(entry.path, [...guides, !isLast])
      }
    })

    if (listing.truncated > 0) {
      note(dir, guides, `… ${listing.truncated.toLocaleString('en-US')} more not shown`)
    }
  }

  visit('', [])

  return rows
}

/**
 * The branch lines drawn before a row, as the `tree` command draws them: a
 * `│` for each folder above whose rows continue, then `├─`, or `└─` for the
 * last row of its folder.
 *
 * @param branch where the row sits among its folder's rows
 * @returns the lines, two cells per folder above and two for the row's own
 */
export function branchPrefixOf(branch: Branch): string {
  const guides = branch.guides.map(continues => (continues ? '│ ' : '  ')).join('')

  return `${guides}${branch.isLast ? '└─' : '├─'}`
}

/**
 * The window's last top: the end of the tree in view, the count of rows
 * above it on the window's first row.
 *
 * @param total the tree's rows
 * @param height the rows the tree's region has
 * @returns the largest top
 */
export function maxTreeTop(total: number, height: number): number {
  return total <= height ? 0 : total - height + 1
}

/**
 * Which rows a region of `height` rows shows from `top`, clamped to the tree.
 *
 * @param total the tree's rows
 * @param top the first row wanted in view
 * @param height the rows the region has
 * @returns the window
 */
export function treeWindowOf(total: number, top: number, height: number): TreeWindow {
  if (total <= height) {
    return { top: 0, start: 0, end: total, above: 0, below: 0 }
  }

  const at = clamp(top, 0, maxTreeTop(total, height))
  const room = height - (at > 0 ? 1 : 0)
  const isRestInView = total - at <= room
  const shown = isRestInView ? total - at : Math.max(1, room - 1)
  const end = at + shown

  return { top: at, start: at, end, above: at, below: total - end }
}

/**
 * The top that keeps one row in view with a row of the tree on each side of
 * it where there is one, so the arrows always have a drawn row to move to.
 *
 * @param index the row to keep in view
 * @param top the window's top now
 * @param total the tree's rows
 * @param height the rows the tree's region has
 * @returns the top, unchanged where the row and its neighbors already show
 */
export function topRevealing(
  index: number,
  top: number,
  total: number,
  height: number,
): number {
  const window = treeWindowOf(total, top, height)
  const first = Math.max(0, index - 1)
  const last = Math.min(total - 1, index + 1)

  if (first < window.start) {
    return clamp(first, 0, maxTreeTop(total, height))
  }

  let next = window.top
  const max = maxTreeTop(total, height)

  while (next < max && treeWindowOf(total, next, height).end <= last) {
    next += 1
  }

  return next
}

/**
 * Where the focus ring lands as it moves onto a row of the tree, and the
 * window's top that keeps the row and its neighbors in view.
 *
 * Claude Code keeps the ring at its place in the focus order across a
 * redraw, not on a key. When the window moves, the ring is landed on the
 * entry drawn now where the row will be drawn after the move, so the redraw
 * brings the row itself under it.
 *
 * @param rows the tree's rows
 * @param top the window's top now
 * @param height the rows the tree's region has
 * @param path the row the ring moves onto
 * @returns the top and the path of the entry to land on, or null for a path
 *   that is no entry of the tree
 */
export function focusLandingOf(
  rows: readonly TreeRow[],
  top: number,
  height: number,
  path: string,
): { readonly top: number; readonly landing: string } | null {
  const index = rows.findIndex(row => row.type === 'entry' && row.path === path)

  if (index < 0) {
    return null
  }

  const before = treeWindowOf(rows.length, top, height)
  const next = topRevealing(index, top, rows.length, height)
  const after = treeWindowOf(rows.length, next, height)

  // Notes are Text, never in the focus order: only entries take places
  const entriesIn = (window: TreeWindow) =>
    rows
      .slice(window.start, window.end)
      .flatMap(row => (row.type === 'entry' ? [row.path] : []))

  const landing =
    after.start === before.start
      ? path
      : (entriesIn(before)[entriesIn(after).indexOf(path)] ?? path)

  return { top: next, landing }
}
