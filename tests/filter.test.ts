import { describe, expect, test } from 'claude-code/testing'

import {
  filteredTreeOf,
  filterIndexOf,
  filterStatusOf,
  filterViewOf,
  firstMatchOf,
  gitFileListOf,
  openedOf,
  queryOf,
  type FileList,
  type FilterView,
} from '../hooks/filter'
import { compareEntries, type DirListing, type Entry, type TreeRow } from '../hooks/tree'

const nul = (paths: readonly string[]) => paths.map(path => `${path}\0`).join('')

const listOf = (files: readonly string[], dirs: readonly string[] = []): FileList => ({
  entries: [...files.map(path => ({ path, kind: 'file' as const })), ...dirs.map(path => ({ path, kind: 'dir' as const }))],
  isPartial: false,
})

const viewOf = (list: FileList, text: string, cap = 500, style: 'posix' | 'win32' = 'posix'): FilterView => {
  const query = queryOf(text)

  if (query === null) {
    throw new Error(`blank query: ${text}`)
  }

  return filterViewOf(filterIndexOf(list), query, cap, style)
}

const entry = (path: string, kind: Entry['kind']): Entry => ({
  name: path.split('/').pop() ?? path,
  path,
  kind,
  size: 0,
})

/**
 * The folders as `$.fs.list` reads them, from a list of paths (a trailing
 * `/` for an empty folder), each folder's entries in tree order.
 */
function listingsOf(paths: readonly string[]): Map<string, DirListing> {
  const entries = new Map<string, Map<string, Entry>>([['', new Map()]])

  for (const spelled of paths) {
    const isDir = spelled.endsWith('/')
    const parts = (isDir ? spelled.slice(0, -1) : spelled).split('/')

    parts.forEach((_, at) => {
      const parent = parts.slice(0, at).join('/')
      const path = parts.slice(0, at + 1).join('/')
      const kind = at < parts.length - 1 || isDir ? 'dir' : 'file'

      entries.get(parent)?.set(path, entry(path, kind))

      if (kind === 'dir' && !entries.has(path)) {
        entries.set(path, new Map())
      }
    })
  }

  return new Map(
    [...entries].map(([dir, found]) => [dir, { entries: [...found.values()].sort(compareEntries), truncated: 0 }]),
  )
}

/**
 * Rows as `path` lines, two spaces a level, `/` after a folder, `+` after
 * an open one; notes as their text.
 */
const outline = (rows: readonly TreeRow[]) =>
  rows.map(row =>
    row.type === 'note'
      ? `${'  '.repeat(row.depth)}(${row.text})`
      : `${'  '.repeat(row.depth)}${row.name}${row.kind === 'dir' ? (row.isExpanded ? '/+' : '/') : ''}`,
  )

describe('gitFileListOf', () => {
  test('reads the tracked and untracked files, less the deleted ones, once each', async () => {
    const list = gitFileListOf({
      listed: nul(['new.txt', 'src/a.ts', 'src/gone.ts', 'src/a.ts']),
      deleted: nul(['src/gone.ts']),
      ignored: null,
      isTruncated: false,
    })

    expect(list).toEqual({
      entries: [
        { path: 'new.txt', kind: 'file' },
        { path: 'src/a.ts', kind: 'file' },
      ],
      isPartial: false,
    })
  })

  test('reads an ignored folder as itself alone, and ignored files one by one', async () => {
    const list = gitFileListOf({
      listed: nul(['src/a.ts']),
      deleted: null,
      ignored: nul(['dist/', 'secret.env', 'src/run.log']),
      isTruncated: false,
    })

    expect(list.entries).toEqual([
      { path: 'src/a.ts', kind: 'file' },
      { path: 'dist', kind: 'dir' },
      { path: 'secret.env', kind: 'file' },
      { path: 'src/run.log', kind: 'file' },
    ])
  })

  test('drops the path an output cut at the cap ends in, and says the list is partial', async () => {
    const list = gitFileListOf({
      listed: `${nul(['a.ts', 'b.ts'])}c.t`,
      deleted: null,
      ignored: null,
      isTruncated: true,
    })

    expect(list).toEqual({
      entries: [
        { path: 'a.ts', kind: 'file' },
        { path: 'b.ts', kind: 'file' },
      ],
      isPartial: true,
    })
  })

  test('keeps names with spaces, newlines and non-ASCII letters whole', async () => {
    const names = ['a b.md', 'line\nbreak.txt', 'café/日本語.md']
    const list = gitFileListOf({ listed: nul(names), deleted: null, ignored: null, isTruncated: false })

    expect(list.entries.map(found => found.path)).toEqual(names)
  })
})

describe('queryOf', () => {
  test('reads nothing from a blank query', async () => {
    expect(queryOf('')).toBeNull()
    expect(queryOf('   ')).toBeNull()
  })

  test('reads words, lowercase, and a word with a slash as a path', async () => {
    expect(queryOf(' Main  src/Comp ')).toEqual({
      terms: [
        { text: 'main', isPath: false },
        { text: 'src/comp', isPath: true },
      ],
    })
  })
})

describe('filterViewOf', () => {
  const list = listOf(
    ['README.md', 'src/main.ts', 'src/components/Button.tsx', 'src/components/button.test.tsx', 'docs/readme-notes.md'],
    ['node_modules'],
  )

  test('matches names in any case, and the folders that hold the matches', async () => {
    const view = viewOf(list, 'readme')

    expect([...view.matches]).toEqual(['README.md', 'docs/readme-notes.md'])
    expect([...view.ancestors]).toEqual(['docs'])
    expect(view.total).toBe(2)
  })

  test('matches folders by name, the ones the list only implies too', async () => {
    expect([...viewOf(list, 'compon').matches]).toEqual(['src/components'])
    expect([...viewOf(list, 'node_mod').matches]).toEqual(['node_modules'])
  })

  test('needs every word in the name', async () => {
    expect([...viewOf(list, 'button test').matches]).toEqual(['src/components/button.test.tsx'])
  })

  test('matches a word with a slash against the path from the root', async () => {
    expect([...viewOf(list, 'src/comp').matches]).toEqual([
      'src/components',
      'src/components/Button.tsx',
      'src/components/button.test.tsx',
    ])

    // Without the slash, `src` matches the folder's name alone
    expect([...viewOf(list, 'src').matches]).toEqual(['src'])
  })

  test('finds a decomposed accent by its composed spelling', async () => {
    const view = viewOf(listOf(['café.md']), 'café')

    expect(view.total).toBe(1)
  })

  test('shows at most the cap, and counts all', async () => {
    const many = listOf(Array.from({ length: 30 }, (_, at) => `logs/day-${at}.log`))
    const view = viewOf(many, 'day', 10)

    expect(view.matches.size).toBe(10)
    expect(view.total).toBe(30)
    expect(view.isCapped).toBe(true)
  })

  test('keys matches folded for a win32 root, as Windows compares names', async () => {
    const view = viewOf(listOf(['Src/Main.ts']), 'main', 500, 'win32')

    expect([...view.matches]).toEqual(['src/main.ts'])
    expect([...view.ancestors]).toEqual(['src'])
  })
})

describe('filteredTreeOf', () => {
  const disk = listingsOf([
    'README.md',
    'src/main.ts',
    'src/util.ts',
    'src/components/Button.tsx',
    'src/components/Card.tsx',
    'docs/guide.md',
    'node_modules/left-pad/index.js',
  ])

  const list = listOf(
    ['README.md', 'src/main.ts', 'src/util.ts', 'src/components/Button.tsx', 'src/components/Card.tsx', 'docs/guide.md'],
    ['node_modules'],
  )

  test('draws the matches under the folders that hold them, open, from the folders as read', async () => {
    const view = viewOf(list, 'button')
    const rows = filteredTreeOf(dir => disk.get(dir), view, openedOf(view))

    expect(outline(rows)).toEqual(['src/+', '  components/+', '    Button.tsx'])
  })

  test('draws a matched folder closed, and opened by the person, all it holds', async () => {
    const view = viewOf(list, 'compo')
    const closed = filteredTreeOf(dir => disk.get(dir), view, openedOf(view))

    expect(outline(closed)).toEqual(['src/+', '  components/'])

    const open = new Set([...openedOf(view), 'src/components'])

    expect(outline(filteredTreeOf(dir => disk.get(dir), view, open))).toEqual([
      'src/+',
      '  components/+',
      '    Button.tsx',
      '    Card.tsx',
    ])
  })

  test('keeps a folder the person closed closed', async () => {
    const view = viewOf(list, 'ts')
    const open = openedOf(view)

    open.delete('src')

    expect(outline(filteredTreeOf(dir => disk.get(dir), view, open))).toEqual(['src/'])
  })

  test('says so when nothing matches', async () => {
    const view = viewOf(list, 'nothing')

    expect(outline(filteredTreeOf(dir => disk.get(dir), view, openedOf(view)))).toEqual(['(No match)'])
  })

  test('notes a folder still being read', async () => {
    const view = viewOf(list, 'guide')
    const rows = filteredTreeOf(dir => (dir === 'docs' ? undefined : disk.get(dir)), view, openedOf(view))

    expect(outline(rows)).toEqual(['docs/+', '  (Loading…)'])
  })

  test('finds a match git spells in another case under a win32 root, by the name the folder lists', async () => {
    const view = viewOf(listOf(['SRC/MAIN.TS']), 'main', 500, 'win32')
    const rows = filteredTreeOf(dir => disk.get(dir), view, openedOf(view))

    expect(outline(rows)).toEqual(['src/+', '  main.ts'])
    expect(firstMatchOf(rows, view)).toBe('src/main.ts')
  })

  test('puts the focus on the first match drawn, not on a folder that only holds one', async () => {
    const view = viewOf(list, 'card')
    const rows = filteredTreeOf(dir => disk.get(dir), view, openedOf(view))

    expect(firstMatchOf(rows, view)).toBe('src/components/Card.tsx')
  })
})

describe('filterStatusOf', () => {
  const list = listOf(['a.md', 'b.md', 'c.txt'])

  test('counts the matches', async () => {
    expect(filterStatusOf(null)).toBe('searching…')
    expect(filterStatusOf(viewOf(list, 'c.'))).toBe('1 match')
    expect(filterStatusOf(viewOf(list, '.md'))).toBe('2 matches')
    expect(filterStatusOf(viewOf(list, 'zzz'))).toBe('no match')
  })

  test('counts the shown ones of all past the cap, and marks a partial search', async () => {
    const many = listOf(Array.from({ length: 1200 }, (_, at) => `f${at}.md`))

    expect(filterStatusOf(viewOf(many, 'md'))).toBe('500 of 1,200')
    expect(filterStatusOf(viewOf({ ...list, isPartial: true }, '.md'))).toBe('2+ matches')
  })
})
