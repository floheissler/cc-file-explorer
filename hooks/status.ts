import { ancestorsOf, foldKey, type PathStyle } from './paths'
import type { TreeRow } from './tree'

/**
 * What git and the session say of the tree's entries, as the markers at the
 * right end of its rows show it: git's state of each entry, and the files
 * Claude wrote this session.
 *
 * Git names entries by *repository paths*: `/`-separated on every platform,
 * relative to the repository's top, a trailing `/` on a folder git names
 * whole. They become keys here, relative to the session's root, which may
 * be a folder inside the repository. Keys that index a status are folded
 * (`foldKey`): git spells a tracked path as its index does, which under
 * Windows' and macOS' file systems need not be the tree's spelling.
 */

/**
 * An entry's state in git, strongest first: the order in which one of two
 * records for one path wins, and a folder's dot takes its color from the
 * strongest change beneath it.
 */
export type GitState = 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'added' | 'untracked' | 'ignored'

const STRENGTH: readonly GitState[] = [
  'conflicted',
  'deleted',
  'modified',
  'renamed',
  'added',
  'untracked',
  'ignored',
]

/**
 * The letter each state shows, as `git status --short` writes it.
 */
export const GIT_LETTERS: Readonly<Record<GitState, string>> = {
  conflicted: 'U',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  added: 'A',
  untracked: '?',
  ignored: '!',
}

/**
 * What a folder holding changes shows in place of a letter.
 */
export const CHANGES_GLYPH = '•'

/**
 * What a row of a file Claude wrote this session shows, and a folder
 * holding one: Claude Code's own mark.
 */
export const WRITTEN_GLYPH = '✻'

/**
 * The stronger of a state held so far, if any, and another.
 */
function strongerOf(held: GitState | undefined, state: GitState): GitState {
  return held !== undefined && STRENGTH.indexOf(held) < STRENGTH.indexOf(state) ? held : state
}

/**
 * One record of `git status --porcelain=v1 -z`: the path, the path it was
 * renamed or copied from, and its state.
 */
export type GitRecord = {
  readonly path: string
  readonly from?: string
  readonly state: GitState
}

/**
 * The state of a record's two status letters, `XY`: the index's against
 * HEAD, then the work tree's against the index.
 *
 * Both sides unmerged is a conflict. Otherwise the work tree tells a file
 * gone from disk; the index tells the rest, as a file staged new and edited
 * since (`AM`) is still new; the work tree speaks for a file the index left
 * alone (` M`). A copy is a new file; a type change counts as modified.
 *
 * @param xy the two letters
 * @returns the state, or null for letters git does not write
 */
export function stateOf(xy: string): GitState | null {
  if (xy === '??') {
    return 'untracked'
  }

  if (xy === '!!') {
    return 'ignored'
  }

  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '

  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') {
    return 'conflicted'
  }

  switch (y === 'D' ? 'D' : x === ' ' ? y : x) {
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return null
  }
}

/**
 * The records of `git status --porcelain=v1 -z`: `XY path`, each ended by a
 * NUL, a rename or copy followed by the path it came from (to, then from).
 * Paths come unquoted, whatever they hold. Output cut short drops the
 * record it was cut in.
 *
 * @param output what git wrote
 * @returns the records, in git's order
 */
export function parsePorcelain(output: string): GitRecord[] {
  // Whole output ends with a NUL, so the last field is empty; cut short, it
  // is the record the cut fell in
  const fields = output.split('\0').slice(0, -1)
  const records: GitRecord[] = []

  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at] ?? ''

    if (field.length < 4 || field[2] !== ' ') {
      continue
    }

    const xy = field.slice(0, 2)
    const state = stateOf(xy)
    const hasFrom = /[RC]/.test(xy)
    const from = hasFrom ? fields[at + 1] : undefined

    if (hasFrom) {
      at += 1
    }

    if (state !== null) {
      records.push(from === undefined ? { path: field.slice(3), state } : { path: field.slice(3), from, state })
    }
  }

  return records
}

/**
 * Where the session's root sits in its repository, as
 * `git rev-parse --show-prefix --absolute-git-dir` prints it: the root's
 * repository path (`''` at the top, else ending in `/`), and the
 * repository's own folder, native, where its index and HEAD live.
 */
export type RepoPlace = {
  readonly prefix: string
  readonly gitDir: string
}

/**
 * Reads `git rev-parse --show-prefix --absolute-git-dir`'s two lines: the
 * prefix, empty at the top, then the folder. Git for Windows spells the
 * folder `C:/…`.
 *
 * @param output what git wrote
 * @returns the place, or null for output of another shape
 */
export function repoPlaceOf(output: string): RepoPlace | null {
  const text = output.replace(/\r?\n$/, '')
  const cut = text.lastIndexOf('\n')
  const gitDir = text.slice(cut + 1)

  if (cut < 0 || gitDir === '') {
    return null
  }

  return { prefix: text.slice(0, cut).replace(/\r$/, ''), gitDir }
}

/**
 * Git's view of the tree, by folded key: each entry git names, the folders
 * holding a change, and the folders git ignores whole.
 */
export type GitStatus = {
  /**
   * The state of each entry a record names: a file, or a folder git names
   * whole (one it ignores, a nested repository, a submodule).
   */
  readonly states: ReadonlyMap<string, GitState>
  /**
   * Each folder above a change, and the strongest change beneath it; the
   * folder a file was renamed from too.
   */
  readonly changedDirs: ReadonlyMap<string, GitState>
  /**
   * The folders git ignores whole, everything in them ignored with them;
   * `''` when the root itself lies in one.
   */
  readonly ignoredDirs: ReadonlySet<string>
}

/**
 * A repository path's key under the root, or null for a path outside it.
 *
 * @param prefix the root's repository path, split
 * @param parts the path, split
 */
function keyUnder(prefix: readonly string[], parts: readonly string[], style: PathStyle): string | null {
  const isUnder =
    parts.length >= prefix.length && prefix.every((part, at) => foldKey(part, style) === foldKey(parts[at] ?? '', style))

  return isUnder ? parts.slice(prefix.length).join('/') : null
}

const partsOf = (path: string) => path.split('/').filter(part => part !== '')

/**
 * Git's view of the tree from its status records.
 *
 * @param records the records of `git status --porcelain=v1 -z`
 * @param prefix the root's repository path (`RepoPlace.prefix`)
 * @param style the root's style, for folding keys
 * @returns the status
 */
export function statusOf(records: readonly GitRecord[], prefix: string, style: PathStyle): GitStatus {
  const prefixParts = partsOf(prefix)
  const states = new Map<string, GitState>()
  const changedDirs = new Map<string, GitState>()
  const ignoredDirs = new Set<string>()

  const markAbove = (key: string, state: GitState) => {
    for (const dir of ancestorsOf(key)) {
      changedDirs.set(dir, strongerOf(changedDirs.get(dir), state))
    }
  }

  for (const record of records) {
    const parts = partsOf(record.path)
    const found = keyUnder(prefixParts, parts, style)
    const key = found === null ? null : foldKey(found, style)

    if (record.state === 'ignored') {
      // A folder ignored whole holds the root when it is the root or above it
      const isRootInside = parts.length <= prefixParts.length && keyUnder(parts, prefixParts, style) !== null

      if (isRootInside) {
        ignoredDirs.add('')
      } else if (key !== null) {
        states.set(key, strongerOf(states.get(key), 'ignored'))

        if (record.path.endsWith('/')) {
          ignoredDirs.add(key)
        }
      }

      continue
    }

    if (key !== null && key !== '') {
      states.set(key, strongerOf(states.get(key), record.state))
      markAbove(key, record.state)
    }

    const from = record.from === undefined || record.state !== 'renamed' ? null : keyUnder(prefixParts, partsOf(record.from), style)

    if (from !== null && from !== '') {
      markAbove(foldKey(from, style), record.state)
    }
  }

  return { states, changedDirs, ignoredDirs }
}

/**
 * The git marker of one row: its glyph, and the state it stands for.
 */
export type GitMark = {
  readonly glyph: string
  readonly state: GitState
}

/**
 * The markers of one row: git's, and whether Claude wrote it this session
 * (for a folder, something in it).
 */
export type RowMark = {
  readonly git: GitMark | null
  readonly isWritten: boolean
}

/**
 * The markers of a tree's rows, by key; and which marker columns the tree
 * draws, so every row's markers line up whether or not it has one.
 */
export type TreeMarks = {
  readonly byPath: ReadonlyMap<string, RowMark>
  readonly hasGit: boolean
  readonly hasWritten: boolean
}

/**
 * No markers at all.
 */
export const NO_MARKS: TreeMarks = { byPath: new Map(), hasGit: false, hasWritten: false }

/**
 * Whether a folded key lies in a folder git ignores whole, the root included.
 */
function isInIgnored(status: GitStatus, folded: string): boolean {
  if (status.ignoredDirs.size === 0) {
    return false
  }

  return status.ignoredDirs.has('') || ancestorsOf(folded).some(dir => status.ignoredDirs.has(dir))
}

/**
 * The git marker of an entry: a file's letter; a folder's dot, colored by
 * the strongest change beneath it or of its own; `!` for an entry git
 * ignores, or one in a folder it ignores, unless it changed.
 *
 * @param status git's view of the tree
 * @param folded the entry's folded key
 * @param isDir whether the entry is a folder
 * @returns the marker, or null for an entry git has nothing to say of
 */
export function gitMarkOf(status: GitStatus, folded: string, isDir: boolean): GitMark | null {
  const own = status.states.get(folded)
  const change = own === 'ignored' ? undefined : own

  if (isDir) {
    const held = status.changedDirs.get(folded)
    const beneath = change === undefined ? held : strongerOf(held, change)

    if (beneath !== undefined) {
      return { glyph: CHANGES_GLYPH, state: beneath }
    }
  } else if (change !== undefined) {
    return { glyph: GIT_LETTERS[change], state: change }
  }

  return own === 'ignored' || isInIgnored(status, folded) ? { glyph: GIT_LETTERS.ignored, state: 'ignored' } : null
}

/**
 * The markers of a tree's rows.
 *
 * @param rows the tree's rows
 * @param status git's view of the tree, or null where git has none
 * @param written the keys of the files Claude wrote this session
 * @param style the root's style, for folding keys
 * @returns the markers, by row key
 */
export function treeMarksOf(
  rows: readonly TreeRow[],
  status: GitStatus | null,
  written: readonly string[],
  style: PathStyle,
): TreeMarks {
  if (status === null && written.length === 0) {
    return NO_MARKS
  }

  const writtenFiles = new Set(written.map(key => foldKey(key, style)))
  const writtenDirs = new Set([...writtenFiles].flatMap(ancestorsOf))

  const byPath = new Map<string, RowMark>()
  let hasGit = false
  let hasWritten = false

  for (const row of rows) {
    if (row.type !== 'entry') {
      continue
    }

    const folded = foldKey(row.path, style)
    const isDir = row.kind === 'dir'
    const git = status === null ? null : gitMarkOf(status, folded, isDir)
    const isWritten = isDir ? writtenDirs.has(folded) : writtenFiles.has(folded)

    if (git !== null || isWritten) {
      byPath.set(row.path, { git, isWritten })
      hasGit ||= git !== null
      hasWritten ||= isWritten
    }
  }

  return { byPath, hasGit, hasWritten }
}
