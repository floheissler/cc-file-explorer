import { describe, expect, test } from 'claude-code/testing'

import { paneLayoutOf, regionAt } from '../hooks/layout'
import {
  branchPrefixOf,
  compareEntries,
  flattenTree,
  focusLandingOf,
  maxTreeTop,
  topRevealing,
  treeWindowOf,
  type DirListing,
  type Entry,
} from '../hooks/tree'

const dir = (path: string): Entry => ({
  name: path.split('/').pop() ?? path,
  path,
  kind: 'dir',
  size: 0,
})

const file = (path: string): Entry => ({
  name: path.split('/').pop() ?? path,
  path,
  kind: 'file',
  size: 1,
})

describe('compareEntries', () => {
  test('puts folders first, then sorts names as people do', async () => {
    const sorted = [file('b10.txt'), file('B2.txt'), dir('zeta'), file('a.txt'), dir('Alpha')]
      .sort(compareEntries)
      .map(entry => entry.name)

    expect(sorted).toEqual(['Alpha', 'zeta', 'a.txt', 'B2.txt', 'b10.txt'])
  })

  test('orders as Windows File Explorer does: every folder before any file, dot names first in each', async () => {
    const sorted = [
      file('README.md'),
      file('.gitignore'),
      dir('src'),
      dir('.github'),
      file('a.txt'),
      dir('.claude'),
      file('.env'),
    ]
      .sort(compareEntries)
      .map(entry => entry.name)

    expect(sorted).toEqual(['.claude', '.github', 'src', '.env', '.gitignore', 'a.txt', 'README.md'])
  })
})

describe('flattenTree', () => {
  const listings = new Map<string, DirListing>([
    ['', { entries: [dir('src'), dir('docs'), file('README.md')], truncated: 0 }],
    ['src', { entries: [file('src/main.ts')], truncated: 3 }],
    ['docs', { error: 'EACCES: permission denied' }],
  ])

  test('lists open folders beneath themselves, one level deeper', async () => {
    const rows = flattenTree(path => listings.get(path), new Set(['src']))

    expect(
      rows.map(row => (row.type === 'entry' ? `${row.depth}:${row.path}` : `${row.depth}:${row.text}`)),
    ).toEqual(['0:src', '1:src/main.ts', '1:… 3 more not shown', '0:docs', '0:README.md'])
  })

  test('notes a folder still loading and one that cannot be read', async () => {
    const rows = flattenTree(path => listings.get(path), new Set(['docs', 'src/missing']))
    const notes = rows.filter(row => row.type === 'note')

    expect(notes.map(row => row.type === 'note' && row.isError)).toEqual([true])
    expect(flattenTree(() => undefined, new Set())).toMatchObject([{ type: 'note', text: 'Loading…' }])
  })

  test('says when the root is empty', async () => {
    const rows = flattenTree(() => ({ entries: [], truncated: 0 }), new Set())

    expect(rows).toMatchObject([{ type: 'note', text: 'This folder is empty' }])
  })
})

describe('branchPrefixOf', () => {
  test('draws ├─ per row, └─ for the last of its folder, and │ while a folder has rows below', async () => {
    const listings = new Map<string, DirListing>([
      ['', { entries: [dir('src'), file('README.md')], truncated: 0 }],
      ['src', { entries: [file('src/main.ts')], truncated: 3 }],
    ])
    const rows = flattenTree(path => listings.get(path), new Set(['src']))

    // The note counting what was left out is the last row of src
    expect(rows.map(branchPrefixOf)).toEqual(['├─', '│ ├─', '│ └─', '└─'])
  })

  test('ends the outer line under the last folder of the root', async () => {
    const listings = new Map<string, DirListing>([
      ['', { entries: [dir('alpha'), dir('zeta')], truncated: 0 }],
      ['zeta', { entries: [dir('zeta/inner'), file('zeta/z.txt')], truncated: 0 }],
      ['zeta/inner', { entries: [file('zeta/inner/deep.md')], truncated: 0 }],
    ])
    const rows = flattenTree(path => listings.get(path), new Set(['zeta', 'zeta/inner']))

    expect(rows.map(branchPrefixOf)).toEqual(['├─', '└─', '  ├─', '  │ └─', '  └─'])
  })
})

describe('treeWindowOf', () => {
  test('shows everything when the tree fits', async () => {
    expect(treeWindowOf(5, 3, 10)).toEqual({ top: 0, start: 0, end: 5, above: 0, below: 0 })
  })

  test('spends a row on each count of rows out of view', async () => {
    expect(treeWindowOf(100, 0, 10)).toEqual({ top: 0, start: 0, end: 9, above: 0, below: 91 })
    expect(treeWindowOf(100, 40, 10)).toEqual({ top: 40, start: 40, end: 48, above: 40, below: 52 })
  })

  test('ends with the last row in view at its largest top', async () => {
    const top = maxTreeTop(100, 10)

    expect(treeWindowOf(100, 1_000, 10)).toEqual({ top, start: top, end: 100, above: top, below: 0 })
  })
})

describe('topRevealing', () => {
  test('keeps the row after the focused one in view, moving down', async () => {
    const top = topRevealing(8, 0, 100, 10)
    const window = treeWindowOf(100, top, 10)

    expect(window.start).toBeLessThan(9)
    expect(window.end).toBeGreaterThan(9)
  })

  test('keeps the row before the focused one in view, moving up', async () => {
    expect(topRevealing(40, 41, 100, 10)).toBe(39)
  })

  test('leaves a window that already shows the row and its neighbors', async () => {
    expect(topRevealing(44, 40, 100, 10)).toBe(40)
  })
})

describe('focusLandingOf', () => {
  // f00 … f19 in the root; a region of 7 rows first shows f00 … f05 and a
  // count of the rows below
  const files = Array.from({ length: 20 }, (_, at) => file(`f${String(at).padStart(2, '0')}`))
  const rows = flattenTree(dir => (dir === '' ? { entries: files, truncated: 0 } : undefined), new Set())

  test('lands on the row itself while the window stays', async () => {
    expect(focusLandingOf(rows, 0, 7, 'f02')).toEqual({ top: 0, landing: 'f02' })
  })

  test('moving down past the edge, lands where the row is drawn after the move', async () => {
    // The window moves two rows down: f05 then sits where f03 sits now
    expect(focusLandingOf(rows, 0, 7, 'f05')).toEqual({ top: 2, landing: 'f03' })
  })

  test('moving up past the edge, lands where the row is drawn after the move', async () => {
    // From top 2 (f02 … f06), the window moves a row up: f02 then sits
    // where f03 sits now
    expect(focusLandingOf(rows, 2, 7, 'f02')).toEqual({ top: 1, landing: 'f03' })
  })

  test('counts only entries, since notes are not in the focus order', async () => {
    // An open folder still loading draws a note row under it
    const withNote = flattenTree(
      folder => (folder === '' ? { entries: [dir('a'), ...files.slice(0, 19)], truncated: 0 } : undefined),
      new Set(['a']),
    )

    expect(withNote[1]).toMatchObject({ type: 'note' })
    expect(focusLandingOf(withNote, 0, 7, 'f03')).toEqual({ top: 2, landing: 'f02' })
  })

  test('knows no row for a path not in the tree', async () => {
    expect(focusLandingOf(rows, 0, 7, 'nowhere')).toBeNull()
  })
})

describe('paneLayoutOf', () => {
  test('gives the tree the whole body below the header without a preview', async () => {
    expect(paneLayoutOf(30, false)).toMatchObject({ treeRow: 1, treeRows: 29, previewRows: 0 })
  })

  test('splits the body between the tree and the preview', async () => {
    const layout = paneLayoutOf(30, true)

    // The header, then the tree, then a blank row, the title rule and the meta row
    expect(layout.treeRows + layout.previewRows + 4).toBe(30)
    expect(layout.treeRows).toBe(10)
    expect(regionAt(layout, 0)).toBe('header')
    expect(regionAt(layout, 10)).toBe('tree')
    expect(regionAt(layout, 11)).toBe('preview-head')
    expect(regionAt(layout, 13)).toBe('preview-head')
    expect(regionAt(layout, 14)).toBe('preview')
  })
})
