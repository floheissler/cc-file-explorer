import { describe, expect, test } from 'claude-code/testing'

import {
  NO_MARKS,
  parsePorcelain,
  repoPlaceOf,
  stateOf,
  statusOf,
  treeMarksOf,
  type GitStatus,
} from '../hooks/status'
import { flattenTree, type DirListing, type Entry } from '../hooks/tree'

/**
 * `git status --porcelain=v1 -z --untracked-files=all --ignored=matching`
 * as git 2.53 wrote it for a repository with a staged rename, a file
 * removed from the index but kept (`D ` and `??` for one path), changes on
 * both sides, untracked files with a space and accents in their names, and
 * ignored folders and files.
 */
const STATUS = [
  'D  keep.md',
  'R  new.txt',
  'old.txt',
  ' M src/a.ts',
  ' M src/b.ts',
  'M  sub/s.txt',
  '?? keep.md',
  '?? src/deep/n2.ts',
  '?? src/new.ts',
  '?? sub/we ird name.txt',
  '?? sub/\u00fcn\u00ef.txt',
  '!! build/',
  '!! debug.log',
  '!! node_modules/',
  '!! src/deep/x.log',
]
  .map(field => `${field}\0`)
  .join('')

describe('parsePorcelain', () => {
  test('reads each record, a rename as its new path then the one it came from', async () => {
    const records = parsePorcelain(STATUS)

    expect(records.length).toBe(14)
    expect(records[1]).toEqual({ path: 'new.txt', from: 'old.txt', state: 'renamed' })
    expect(records[2]).toEqual({ path: 'src/a.ts', state: 'modified' })
    expect(records[9]).toEqual({ path: 'sub/\u00fcn\u00ef.txt', state: 'untracked' })
    expect(records[12]).toEqual({ path: 'node_modules/', state: 'ignored' })
  })

  test('takes names as git writes them under -z: spaces, tabs and newlines unquoted', async () => {
    expect(parsePorcelain('?? a b.txt\0 M tab\there\0?? line\nbreak\0')).toEqual([
      { path: 'a b.txt', state: 'untracked' },
      { path: 'tab\there', state: 'modified' },
      { path: 'line\nbreak', state: 'untracked' },
    ])
  })

  test('drops the record output cut short ends in, and reads nothing from nothing', async () => {
    expect(parsePorcelain('M  a.ts\0?? b.t')).toEqual([{ path: 'a.ts', state: 'modified' }])
    expect(parsePorcelain('R  new\0old')).toEqual([{ path: 'new', state: 'renamed' }])
    expect(parsePorcelain('')).toEqual([])
  })
})

describe('stateOf', () => {
  test('reads both status letters as one state', async () => {
    const cases: Record<string, string> = {
      '??': 'untracked',
      '!!': 'ignored',
      UU: 'conflicted',
      AA: 'conflicted',
      DD: 'conflicted',
      AU: 'conflicted',
      UD: 'conflicted',
      ' M': 'modified',
      'M ': 'modified',
      MM: 'modified',
      ' T': 'modified',
      'A ': 'added',
      AM: 'added',
      ' A': 'added',
      'C ': 'added',
      'R ': 'renamed',
      RM: 'renamed',
      ' R': 'renamed',
      'D ': 'deleted',
      ' D': 'deleted',
      AD: 'deleted',
      MD: 'deleted',
    }

    for (const [xy, state] of Object.entries(cases)) {
      expect(stateOf(xy), xy).toBe(state)
    }

    expect(stateOf('  ')).toBe(null)
  })
})

describe('repoPlaceOf', () => {
  test('reads the prefix, empty at the top, and the repository folder', async () => {
    expect(repoPlaceOf('sub/\n/home/me/repo/.git\n')).toEqual({ prefix: 'sub/', gitDir: '/home/me/repo/.git' })
    expect(repoPlaceOf('\n/home/me/repo/.git\n')).toEqual({ prefix: '', gitDir: '/home/me/repo/.git' })
    expect(repoPlaceOf('\r\nC:/Users/me/repo/.git\r\n')).toEqual({ prefix: '', gitDir: 'C:/Users/me/repo/.git' })
    expect(repoPlaceOf('fatal: not a git repository\n')).toBe(null)
  })
})

/**
 * A tree of the given folders, every one open, from `{ folder: names }`
 * where a name ending in `/` is a folder.
 */
function rowsOf(folders: Record<string, readonly string[]>) {
  const listingOf = (dir: string): DirListing | undefined => {
    const names = folders[dir]

    if (names === undefined) {
      return undefined
    }

    const entries = names.map((name): Entry => {
      const isDir = name.endsWith('/')
      const bare = name.replace(/\/$/, '')

      return { name: bare, path: dir === '' ? bare : `${dir}/${bare}`, kind: isDir ? 'dir' : 'file', size: 0 }
    })

    return { entries, truncated: 0 }
  }

  return flattenTree(listingOf, new Set(Object.keys(folders)))
}

/**
 * The glyph each row draws in the git column, by key.
 */
const glyphsOf = (marks: ReturnType<typeof treeMarksOf>) =>
  Object.fromEntries([...marks.byPath].flatMap(([path, mark]) => (mark.git === null ? [] : [[path, mark.git.glyph]])))

const TREE = rowsOf({
  '': ['build/', 'node_modules/', 'src/', 'sub/', 'debug.log', 'keep.md', 'new.txt'],
  build: ['out.js'],
  node_modules: ['pkg/'],
  'node_modules/pkg': ['index.js'],
  src: ['deep/', 'a.ts', 'b.ts', 'new.ts', 'same.ts'],
  'src/deep': ['n2.ts', 'x.log'],
  sub: ['s.txt', 'we ird name.txt', '\u00fcn\u00ef.txt'],
})

describe('statusOf and treeMarksOf', () => {
  test('a letter per file, a dot per folder holding changes, ! for what git ignores', async () => {
    const status = statusOf(parsePorcelain(STATUS), '', 'posix')
    const marks = treeMarksOf(TREE, status, [], 'posix')

    expect(glyphsOf(marks)).toEqual({
      build: '!',
      'build/out.js': '!',
      node_modules: '!',
      'node_modules/pkg': '!',
      'node_modules/pkg/index.js': '!',
      src: '•',
      'src/deep': '•',
      'src/deep/n2.ts': '?',
      'src/deep/x.log': '!',
      'src/a.ts': 'M',
      'src/b.ts': 'M',
      'src/new.ts': '?',
      sub: '•',
      'sub/s.txt': 'M',
      'sub/we ird name.txt': '?',
      'sub/\u00fcn\u00ef.txt': '?',
      'debug.log': '!',
      'keep.md': 'D',
      'new.txt': 'R',
    })

    // A folder's dot takes the strongest change beneath it
    expect(marks.byPath.get('src')?.git?.state).toBe('modified')
    expect(marks.byPath.get('src/deep')?.git?.state).toBe('untracked')
    expect(marks.byPath.has('src/same.ts')).toBe(false)
    expect(marks).toMatchObject({ hasGit: true, hasWritten: false })
  })

  test('a root inside the repository keeps its own records, its keys from below it', async () => {
    const status = statusOf(parsePorcelain(STATUS), 'sub/', 'posix')
    const tree = rowsOf({ '': ['s.txt', 'we ird name.txt', 'other.txt'] })

    expect(glyphsOf(treeMarksOf(tree, status, [], 'posix'))).toEqual({ 's.txt': 'M', 'we ird name.txt': '?' })
  })

  test('a root inside an ignored folder is ignored whole', async () => {
    const status = statusOf(parsePorcelain('!! node_modules/\0'), 'node_modules/pkg/', 'posix')
    const tree = rowsOf({ '': ['lib/', 'index.js'], lib: ['a.js'] })

    expect(glyphsOf(treeMarksOf(tree, status, [], 'posix'))).toEqual({ lib: '!', 'lib/a.js': '!', 'index.js': '!' })
  })

  test('a change in an ignored folder shows over its ignored mark', async () => {
    const status = statusOf(parsePorcelain('!! vendor/\0 M vendor/kept.js\0'), '', 'posix')
    const tree = rowsOf({ '': ['vendor/'], vendor: ['kept.js', 'other.js'] })

    expect(glyphsOf(treeMarksOf(tree, status, [], 'posix'))).toEqual({
      vendor: '•',
      'vendor/kept.js': 'M',
      'vendor/other.js': '!',
    })
  })

  test('a rename marks the folder it left as well as the one it entered', async () => {
    const status = statusOf(parsePorcelain('R  new/x.ts\0old/x.ts\0'), '', 'posix')

    expect([...status.changedDirs.keys()].sort()).toEqual(['new', 'old'])
  })

  test('Windows matches git paths and keys in any case; POSIX in composed accents', async () => {
    const windows = statusOf(parsePorcelain(' M Sub/Main.TS\0'), 'sub/', 'win32')

    expect(glyphsOf(treeMarksOf(rowsOf({ '': ['main.ts'] }), windows, [], 'win32'))).toEqual({ 'main.ts': 'M' })

    const mac = statusOf(parsePorcelain('?? cafe\u0301.md\0'), '', 'posix')

    expect(glyphsOf(treeMarksOf(rowsOf({ '': ['caf\u00e9.md'] }), mac, [], 'posix'))).toEqual({ 'caf\u00e9.md': '?' })
    const linux = statusOf(parsePorcelain(' M main.ts\0'), '', 'posix')

    expect(treeMarksOf(rowsOf({ '': ['MAIN.TS'] }), linux, [], 'posix').byPath.size).toBe(0)
  })
})

describe('files Claude wrote', () => {
  const none: GitStatus | null = null

  test('mark the files and every folder above them', async () => {
    const marks = treeMarksOf(TREE, none, ['src/deep/n2.ts', 'keep.md'], 'posix')

    expect([...marks.byPath].filter(([, mark]) => mark.isWritten).map(([path]) => path)).toEqual([
      'src',
      'src/deep',
      'src/deep/n2.ts',
      'keep.md',
    ])
    expect(marks).toMatchObject({ hasGit: false, hasWritten: true })
  })

  test('match their rows by fold, and draw nothing without a status or a write', async () => {
    const marks = treeMarksOf(rowsOf({ '': ['Main.ts'] }), none, ['main.TS'], 'win32')

    expect(marks.byPath.get('Main.ts')).toEqual({ git: null, isWritten: true })
    expect(treeMarksOf(TREE, none, [], 'posix')).toBe(NO_MARKS)
  })
})
