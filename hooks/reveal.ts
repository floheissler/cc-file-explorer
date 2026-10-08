import type { ListingOf, ReadDirs } from './levels'
import { isSameKey, type PathStyle } from './paths'
import { flattenTree, type DirListing, type Entry, type TreeRow } from './tree'

/**
 * The line range a Claude Code mention may carry after its path (`#L10`,
 * `#L10-20`).
 */
const LINE_FRAGMENT = /#L\d+(?:-\d+)?$/

/**
 * Text without the quotes around all of it, when it has a pair.
 */
function unquoted(text: string): string {
  return /^(["'])(.*)\1$/s.exec(text)?.[2] ?? text
}

/**
 * The paths the text after `/tree` names, to try in order: the whole text,
 * trimmed and unquoted, as one path (spaces and all). A mention, as Claude
 * Code's prompt spells one (`@src/a.ts`, `@"my file.md"`, `@a.ts#L10`), is
 * tried without its `@`, its quotes and its line range first, then as typed,
 * for a name that starts with `@` (`@types`).
 *
 * @param args what followed `/tree`
 * @returns the paths, none for a bare `/tree`
 */
export function revealPathsOf(args: string): string[] {
  const text = unquoted(args.trim())

  if (!text.startsWith('@')) {
    return text === '' ? [] : [text]
  }

  const mention = unquoted(text.slice(1)).replace(LINE_FRAGMENT, '')

  return [...new Set([mention, text])].filter(path => path !== '')
}

/**
 * Finds the entry a key names, folder by folder from the root, as the tree
 * lists them: each name matches the entry spelled the same, else the one the
 * platform takes for it (`isSameKey`), so under win32 `readme.md` finds
 * `README.md`.
 *
 * @param key a key under the root, not the root itself
 * @param style the root's style
 * @param readDir reads a folder afresh, so an entry made since it was last
 *   read is found; undefined where the folder is not read
 * @returns the entry, or null where a name matches none, or matches a file
 *   with names still to follow, or a folder on the way cannot be read
 */
export async function findEntry(
  key: string,
  style: PathStyle,
  readDir: (dir: string) => Promise<DirListing | undefined>,
): Promise<Entry | null> {
  let found: Entry | null = null

  for (const name of key.split('/')) {
    if (found !== null && found.kind !== 'dir') {
      return null
    }

    const listing = await readDir(found?.path ?? '')

    if (listing === undefined || 'error' in listing) {
      return null
    }

    found =
      listing.entries.find(entry => entry.name === name) ??
      listing.entries.find(entry => isSameKey(entry.name, name, style)) ??
      null

    if (found === null) {
      return null
    }
  }

  return found
}

/**
 * The tree's rows and the index of one entry's row, once every open folder
 * drawn above the row is read: an unread one is a single row of its own, and
 * reading it moves the row down by its entries. Folders below the row are
 * left for the drawing to read.
 *
 * @param listingOf the folders read so far
 * @param expanded the open folders
 * @param path the entry's key
 * @param readDirs reads folders into `listingOf`
 * @returns the rows, and the row's index, -1 for an entry the tree does not
 *   show
 */
export async function rowsRevealing(
  listingOf: ListingOf,
  expanded: ReadonlySet<string>,
  path: string,
  readDirs: ReadDirs,
): Promise<{ readonly rows: TreeRow[]; readonly index: number }> {
  let unread: string[] = []

  for (;;) {
    const before = unread
    const rows = flattenTree(listingOf, expanded)
    const index = rows.findIndex(row => row.type === 'entry' && row.path === path)

    unread = rows
      .slice(0, index < 0 ? rows.length : index)
      .flatMap(row => (row.type === 'entry' && row.isExpanded && listingOf(row.path) === undefined ? [row.path] : []))

    const isStuck = unread.length > 0 && unread.join('\0') === before.join('\0')

    if (unread.length === 0 || isStuck) {
      return { rows, index }
    }

    await readDirs(unread)
  }
}
