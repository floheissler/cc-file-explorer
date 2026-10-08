import { flattenTree, type DirListing, type PathSet, type TreeRow } from './tree'

/**
 * A folder's listing, or undefined while it is not read.
 */
export type ListingOf = (dir: string) => DirListing | undefined

/**
 * Reads the listings of folders not read yet, so `ListingOf` answers them.
 */
export type ReadDirs = (dirs: readonly string[]) => Promise<void>

/**
 * What a level step leaves open, and whether it stopped at the folder cap
 * before it opened all it meant to.
 */
export type LevelStep = {
  readonly expanded: string[]
  readonly isCapped: boolean
}

type FolderRow = Extract<TreeRow, { type: 'entry' }>

function folderRowsOf(listingOf: ListingOf, expanded: PathSet): FolderRow[] {
  return flattenTree(listingOf, expanded).filter(
    (row): row is FolderRow => row.type === 'entry' && row.kind === 'dir',
  )
}

/**
 * The folders directly in a folder, in tree order; none while it is unread.
 */
function subfoldersOf(listingOf: ListingOf, dir: string): string[] {
  const listing = listingOf(dir)

  return listing === undefined || 'error' in listing
    ? []
    : listing.entries.filter(entry => entry.kind === 'dir').map(entry => entry.path)
}

/**
 * Reads the open folders in view that are not read yet (after a reload, the
 * tree is open where it was but nothing is read), so a step sees their
 * subfolders. Each pass can show more open folders; it stops when one reads
 * nothing new.
 */
async function readOpenFolders(
  listingOf: ListingOf,
  expanded: PathSet,
  readDirs: ReadDirs,
): Promise<void> {
  let unread: string[] = []

  for (;;) {
    const before = unread

    unread = folderRowsOf(listingOf, expanded)
      .filter(row => row.isExpanded && listingOf(row.path) === undefined)
      .map(row => row.path)

    const isStuck = unread.length > 0 && unread.join('\0') === before.join('\0')

    if (unread.length === 0 || isStuck) {
      return
    }

    await readDirs(unread)
  }
}

/**
 * One level deeper everywhere: every folder in view that is closed opens,
 * in tree order, up to `cap` of them.
 *
 * The step works on the tree in view: a folder left open inside a closed one
 * is not kept, so pressing `c` after `e` returns to where `e` began.
 *
 * @param listingOf the folders read so far
 * @param expanded the folders open now
 * @param readDirs reads the folders about to open
 * @param cap the most folders the step opens
 * @returns the folders left open
 */
export async function expandOneLevel(
  listingOf: ListingOf,
  expanded: PathSet,
  readDirs: ReadDirs,
  cap: number,
): Promise<LevelStep> {
  await readOpenFolders(listingOf, expanded, readDirs)

  const folders = folderRowsOf(listingOf, expanded)
  const open = folders.filter(row => row.isExpanded).map(row => row.path)
  const closed = folders.filter(row => !row.isExpanded).map(row => row.path)
  const opening = closed.slice(0, Math.max(0, cap))

  await readDirs(opening.filter(dir => listingOf(dir) === undefined))

  return { expanded: [...open, ...opening], isCapped: opening.length < closed.length }
}

/**
 * One level shallower everywhere: every open folder in view that holds no
 * open folder closes.
 *
 * @param listingOf the folders read so far
 * @param expanded the folders open now
 * @returns the folders left open
 */
export function collapseOneLevel(listingOf: ListingOf, expanded: PathSet): string[] {
  const open = folderRowsOf(listingOf, expanded)
    .filter(row => row.isExpanded)
    .map(row => row.path)

  const isParent = new Set(
    open.filter(dir => open.some(other => other.startsWith(`${dir}/`))),
  )

  return open.filter(dir => isParent.has(dir))
}

/**
 * The tree opened exactly `levels` deep: the root's folders open for 1, and
 * theirs too for 2, and so on, up to `cap` folders in all; nothing deeper
 * stays open.
 *
 * @param listingOf the folders read so far; the root must be read
 * @param levels how many levels of folders open, 0 for none
 * @param readDirs reads the folders about to open
 * @param cap the most folders the step opens
 * @returns the folders left open
 */
export async function expandToDepth(
  listingOf: ListingOf,
  levels: number,
  readDirs: ReadDirs,
  cap: number,
): Promise<LevelStep> {
  const expanded: string[] = []
  let level = subfoldersOf(listingOf, '')

  for (let depth = 0; depth < levels && level.length > 0; depth += 1) {
    const opening = level.slice(0, Math.max(0, cap - expanded.length))

    await readDirs(opening.filter(dir => listingOf(dir) === undefined))
    expanded.push(...opening)

    if (opening.length < level.length) {
      return { expanded, isCapped: true }
    }

    level = opening.flatMap(dir => subfoldersOf(listingOf, dir))
  }

  return { expanded, isCapped: false }
}
