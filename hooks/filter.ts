import type { ListingOf } from './levels'
import { ancestorsOf, foldKey, nameOf, type PathStyle } from './paths'
import { flattenTree, type PathSet, type TreeRow } from './tree'

/**
 * Filtering the tree by name: the project's files as one list, the entries
 * a query matches, and the tree drawn as those entries and the folders that
 * hold them.
 *
 * The list finds the matches; the tree draws them from the folders as
 * `$.fs.list` reads them, so every row is a real entry, spelled and sorted
 * as the whole tree spells and sorts it. A list path and a row's key are
 * compared folded (`foldKey`), as git may spell a name another way than
 * the file system lists it.
 */

/**
 * One file or folder of the project, by its key as the list spelled it.
 */
export type FoundEntry = {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/**
 * The project's files and folders the filter searches, and whether the
 * search had to stop short of all of them.
 */
export type FileList = {
  readonly entries: readonly FoundEntry[]
  readonly isPartial: boolean
}

/**
 * One entry ready to match: its name and its path folded once.
 */
type IndexedEntry = FoundEntry & {
  readonly foldedName: string
  readonly foldedPath: string
}

/**
 * A file list ready to match: every folder that holds a listed entry is an
 * entry too, so a query finds folders by name.
 */
export type FilterIndex = {
  readonly entries: readonly IndexedEntry[]
  readonly isPartial: boolean
}

/**
 * What a query asks: every term in the name, or for a term with a `/`, in
 * the path from the root.
 */
export type FilterQuery = {
  readonly terms: readonly { readonly text: string; readonly isPath: boolean }[]
}

/**
 * What a query found: the matches it shows (at most the cap, folded keys),
 * the folders that hold them, and how many entries matched in all.
 */
export type FilterView = {
  readonly style: PathStyle
  readonly matches: ReadonlySet<string>
  readonly ancestors: ReadonlySet<string>
  readonly total: number
  readonly isCapped: boolean
  readonly isPartial: boolean
}

/**
 * A text as a query compares it: composed and lowercase, so `readme`
 * finds `README.md` and a decomposed accent its composed spelling.
 */
const foldText = (text: string) => text.normalize('NFC').toLowerCase()

/**
 * The paths of `git ls-files -z` output, one ended by each NUL. Output cut
 * at the engine's cap ends inside its last path, which is dropped.
 */
function pathsOfNul(output: string): string[] {
  const parts = output.split('\0')

  // Whole output ends in a NUL, leaving an empty last part; cut output
  // leaves the cut path there
  parts.pop()

  return parts.filter(part => part !== '')
}

/**
 * The file list git gives for a work tree: the files it tracks and the
 * untracked ones it does not ignore, less the tracked files deleted from
 * disk; then what it ignores, a wholly ignored folder as the folder alone,
 * so `node_modules` and `dist` are found by name but not searched.
 *
 * @param output the three listings' text, null for one that failed, and
 *   whether any was cut at the engine's output cap
 * @returns the list
 */
export function gitFileListOf(output: {
  readonly listed: string
  readonly deleted: string | null
  readonly ignored: string | null
  readonly isTruncated: boolean
}): FileList {
  const deleted = new Set(output.deleted === null ? [] : pathsOfNul(output.deleted))
  const seen = new Set<string>()
  const entries: FoundEntry[] = []

  const add = (path: string, kind: FoundEntry['kind']) => {
    if (path !== '' && path !== '.' && !seen.has(path) && !deleted.has(path)) {
      seen.add(path)
      entries.push({ path, kind })
    }
  }

  // An unmerged file is listed once per stage
  for (const path of pathsOfNul(output.listed)) {
    add(path, 'file')
  }

  for (const path of output.ignored === null ? [] : pathsOfNul(output.ignored)) {
    if (path.endsWith('/')) {
      add(path.slice(0, -1), 'dir')
    } else {
      add(path, 'file')
    }
  }

  return { entries, isPartial: output.isTruncated }
}

/**
 * Makes a file list ready to match: names every folder that holds an entry,
 * and folds each name and path once, not at every keystroke.
 *
 * @param list the files and folders found
 * @returns the index
 */
export function filterIndexOf(list: FileList): FilterIndex {
  const seen = new Set<string>()
  const entries: IndexedEntry[] = []

  const add = (path: string, kind: FoundEntry['kind']) => {
    if (seen.has(path)) {
      return
    }

    seen.add(path)

    const foldedPath = foldText(path)

    entries.push({ path, kind, foldedPath, foldedName: foldText(nameOf(path)) })
  }

  for (const entry of list.entries) {
    for (const dir of ancestorsOf(entry.path)) {
      add(dir, 'dir')
    }

    add(entry.path, entry.kind)
  }

  return { entries, isPartial: list.isPartial }
}

/**
 * Reads a query: its words, each to be found in an entry's name, or in its
 * path from the root when the word holds a `/` (`src/comp`).
 *
 * @param text what the person typed
 * @returns the query, or null for a blank one, which filters nothing
 */
export function queryOf(text: string): FilterQuery | null {
  const words = foldText(text).split(/\s+/).filter(word => word !== '')

  if (words.length === 0) {
    return null
  }

  return { terms: words.map(word => ({ text: word, isPath: word.includes('/') })) }
}

function isMatch(entry: IndexedEntry, query: FilterQuery): boolean {
  return query.terms.every(term => (term.isPath ? entry.foldedPath : entry.foldedName).includes(term.text))
}

/**
 * The entries a query matches, up to `cap` of them shown, and the folders
 * that hold those.
 *
 * @param index the project's entries
 * @param query the query
 * @param cap the most matches shown
 * @param style the root's style, which keys fold by
 * @returns the view
 */
export function filterViewOf(index: FilterIndex, query: FilterQuery, cap: number, style: PathStyle): FilterView {
  const matches = new Set<string>()
  const ancestors = new Set<string>()
  let total = 0

  for (const entry of index.entries) {
    if (!isMatch(entry, query)) {
      continue
    }

    total += 1

    if (matches.size < cap) {
      matches.add(foldKey(entry.path, style))
      ancestorsOf(entry.path).forEach(dir => ancestors.add(foldKey(dir, style)))
    }
  }

  return { style, matches, ancestors, total, isCapped: total > matches.size, isPartial: index.isPartial }
}

/**
 * The folders as a filtered tree reads them: the root and every folder that
 * holds a match list only their matches and the folders that hold one; any
 * other folder, opened by the person, lists all it holds.
 *
 * @param listingOf the folders as read
 * @param view what the query found
 * @returns the folders as the filtered tree draws them
 */
export function filteredListingOf(listingOf: ListingOf, view: FilterView): ListingOf {
  const isKept = (path: string) => {
    const folded = foldKey(path, view.style)

    return view.matches.has(folded) || view.ancestors.has(folded)
  }

  return dir => {
    const listing = listingOf(dir)

    if (listing === undefined || 'error' in listing) {
      return listing
    }

    if (dir !== '' && !view.ancestors.has(foldKey(dir, view.style))) {
      return listing
    }

    // A match past the folder's entry cap was never listed: none are noted
    return { entries: listing.entries.filter(entry => isKept(entry.path)), truncated: 0 }
  }
}

/**
 * The folders a filtered tree opens before the person opens or closes any:
 * every folder that holds a match.
 *
 * @param view what the query found
 * @returns the folded keys
 */
export function openedOf(view: FilterView): Set<string> {
  return new Set(view.ancestors)
}

/**
 * A set of folded keys asked by key: a filtered tree's open folders.
 *
 * @param folded the folded keys
 * @param style the root's style
 * @returns the set, answering any spelling of a key in it
 */
export function foldedSetOf(folded: ReadonlySet<string>, style: PathStyle): PathSet {
  return { has: path => folded.has(foldKey(path, style)) }
}

/**
 * The filtered tree's rows: the tree of the matches and the folders that
 * hold them, open where `open` says; one note when nothing matched.
 *
 * @param listingOf the folders as read
 * @param view what the query found
 * @param open the open folders, folded keys
 * @returns the rows
 */
export function filteredTreeOf(listingOf: ListingOf, view: FilterView, open: ReadonlySet<string>): TreeRow[] {
  if (view.total === 0) {
    return [noteRow('filter', 'No match')]
  }

  return flattenTree(filteredListingOf(listingOf, view), foldedSetOf(open, view.style))
}

/**
 * The tree's one row while the file list is read.
 */
export function searchingRows(): TreeRow[] {
  return [noteRow('filter', 'Searching…')]
}

function noteRow(key: string, text: string): TreeRow {
  return { type: 'note', key: `note:${key}`, depth: 0, guides: [], isLast: true, text, isError: false }
}

/**
 * The first row of a filtered tree that is a match, where Enter in the
 * filter takes the focus.
 *
 * @param rows the filtered tree's rows
 * @param view what the query found
 * @returns the row's key, or null when none is drawn
 */
export function firstMatchOf(rows: readonly TreeRow[], view: FilterView): string | null {
  const found = rows.find(row => row.type === 'entry' && view.matches.has(foldKey(row.path, view.style)))

  return found?.type === 'entry' ? found.path : null
}

/**
 * What the filter's row says beside the field: how many entries match, the
 * shown ones of all when the cap cut them (`500 of 2,140`), `+` when the
 * search stopped short of the project.
 *
 * @param view what the query found, null while the file list is read
 * @returns the text
 */
export function filterStatusOf(view: FilterView | null): string {
  if (view === null) {
    return 'searching…'
  }

  const more = view.isPartial ? '+' : ''
  const count = (n: number) => n.toLocaleString('en-US')

  if (view.total === 0) {
    return view.isPartial ? 'no match in the part searched' : 'no match'
  }

  if (view.isCapped) {
    return `${count(view.matches.size)} of ${count(view.total)}${more}`
  }

  return `${count(view.total)}${more} ${view.total === 1 && more === '' ? 'match' : 'matches'}`
}
