import { describe, expect, test } from 'claude-code/testing'

import { collapseOneLevel, expandOneLevel, expandToDepth } from '../hooks/levels'
import type { DirListing, Entry } from '../hooks/tree'

const dir = (path: string): Entry => ({ name: path.split('/').pop() ?? path, path, kind: 'dir', size: 0 })
const file = (path: string): Entry => ({ name: path.split('/').pop() ?? path, path, kind: 'file', size: 1 })

/**
 * A project three folders deep:
 *
 *   a/ a1/ a11/       b/ b1/      c.txt
 */
const PROJECT = new Map<string, DirListing>([
  ['', { entries: [dir('a'), dir('b'), file('c.txt')], truncated: 0 }],
  ['a', { entries: [dir('a/a1'), file('a/x.txt')], truncated: 0 }],
  ['a/a1', { entries: [dir('a/a1/a11')], truncated: 0 }],
  ['a/a1/a11', { entries: [file('a/a1/a11/deep.md')], truncated: 0 }],
  ['b', { entries: [dir('b/b1')], truncated: 0 }],
  ['b/b1', { entries: [], truncated: 0 }],
])

/**
 * A disk the steps read from: only the root is read at the start, and
 * each folder a step reads is recorded.
 */
function disk() {
  const read = new Map<string, DirListing>([['', PROJECT.get('') as DirListing]])
  const reads: string[] = []

  return {
    reads,
    listingOf: (path: string) => read.get(path),
    readDirs: async (dirs: readonly string[]) => {
      for (const path of dirs) {
        reads.push(path)
        read.set(path, PROJECT.get(path) as DirListing)
      }
    },
  }
}

describe('expandOneLevel', () => {
  test('opens every closed folder in view, reading only those', async () => {
    const { listingOf, readDirs, reads } = disk()

    const first = await expandOneLevel(listingOf, new Set(), readDirs, 100)
    expect(first).toEqual({ expanded: ['a', 'b'], isCapped: false })
    expect(reads).toEqual(['a', 'b'])

    const second = await expandOneLevel(listingOf, new Set(first.expanded), readDirs, 100)
    expect(second.expanded).toEqual(['a', 'b', 'a/a1', 'b/b1'])
  })

  test('stops at the cap and says so', async () => {
    const { listingOf, readDirs } = disk()

    expect(await expandOneLevel(listingOf, new Set(), readDirs, 1)).toEqual({ expanded: ['a'], isCapped: true })
  })
})

describe('collapseOneLevel', () => {
  test('closes the open folders that hold no open folder', async () => {
    const { listingOf, readDirs } = disk()
    const deep = await expandToDepth(listingOf, 3, readDirs, 100)

    expect(collapseOneLevel(listingOf, new Set(deep.expanded))).toEqual(['a', 'a/a1', 'b'])
    expect(collapseOneLevel(listingOf, new Set(['a']))).toEqual([])
  })

  test('undoes an expand step', async () => {
    const { listingOf, readDirs } = disk()
    const start = new Set(['a'])
    const expanded = await expandOneLevel(listingOf, start, readDirs, 100)

    // a's open folder a/a1 and the root's b opened; closing one level returns to a
    expect(collapseOneLevel(listingOf, new Set(expanded.expanded))).toEqual(['a'])
  })

  test('drops folders left open inside a closed one', async () => {
    const { listingOf } = disk()

    // a/a1 is remembered open, but a is closed, so it is not in view
    expect(collapseOneLevel(listingOf, new Set(['a/a1']))).toEqual([])
  })
})

describe('expandToDepth', () => {
  test('opens exactly that many levels of folders', async () => {
    const { listingOf, readDirs } = disk()

    expect((await expandToDepth(listingOf, 1, readDirs, 100)).expanded).toEqual(['a', 'b'])
    expect((await expandToDepth(listingOf, 2, readDirs, 100)).expanded).toEqual(['a', 'b', 'a/a1', 'b/b1'])
    expect((await expandToDepth(listingOf, 9, readDirs, 100)).expanded).toEqual([
      'a',
      'b',
      'a/a1',
      'b/b1',
      'a/a1/a11',
    ])
  })

  test('closes everything at depth 0', async () => {
    const { listingOf, readDirs } = disk()

    expect(await expandToDepth(listingOf, 0, readDirs, 100)).toEqual({ expanded: [], isCapped: false })
  })

  test('stops at the cap and says so', async () => {
    const { listingOf, readDirs } = disk()

    expect(await expandToDepth(listingOf, 3, readDirs, 3)).toEqual({
      expanded: ['a', 'b', 'a/a1'],
      isCapped: true,
    })
  })
})
