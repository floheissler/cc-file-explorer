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
  | (Entry & {
      readonly type: 'entry'
      readonly depth: number
      readonly isExpanded: boolean
    })
  | {
      readonly type: 'note'
      readonly key: string
      readonly depth: number
      readonly text: string
      readonly isError: boolean
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

  const note = (dir: string, depth: number, text: string, isError = false) =>
    rows.push({ type: 'note', key: `note:${dir}`, depth, text, isError })

  const visit = (dir: string, depth: number): void => {
    const listing = listingOf(dir)

    if (listing === undefined) {
      note(dir, depth, 'Loading…')

      return
    }

    if ('error' in listing) {
      note(dir, depth, `Can't read this folder: ${listing.error}`, true)

      return
    }

    if (listing.entries.length === 0 && listing.truncated === 0) {
      note(dir, depth, dir === '' ? 'This folder is empty' : 'empty')

      return
    }

    for (const entry of listing.entries) {
      const isExpanded = entry.kind === 'dir' && expanded.has(entry.path)

      rows.push({ ...entry, type: 'entry', depth, isExpanded })

      if (isExpanded) {
        visit(entry.path, depth + 1)
      }
    }

    if (listing.truncated > 0) {
      note(dir, depth, `… ${listing.truncated.toLocaleString('en-US')} more not shown`)
    }
  }

  visit('', 0)

  return rows
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
