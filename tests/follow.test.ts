import { describe, expect, test } from 'claude-code/testing'

import { followedFileOf, pressStepOf, type PreviewSeat } from '../hooks/follow'
import { flattenTree, type DirListing, type Entry } from '../hooks/tree'

const entry = (path: string, kind: Entry['kind']): Entry => ({
  name: path.split('/').pop() ?? path,
  path,
  kind,
  size: 1,
})

/**
 * A tree of a folder, a file in it, a file, and an entry neither file nor
 * folder; the folder open.
 */
const LISTINGS: Record<string, DirListing> = {
  '': {
    entries: [entry('src', 'dir'), entry('README.md', 'file'), entry('fifo', 'other')],
    truncated: 0,
  },
  src: { entries: [entry('src/main.ts', 'file')], truncated: 0 },
}

const ROWS = flattenTree(dir => LISTINGS[dir], new Set(['src']))

const FOLLOWING: PreviewSeat = { selected: 'README.md', isPinned: false, placement: 'dock' }

describe('followedFileOf', () => {
  test('follows the ring onto a file’s row, and an entry a press would preview', async () => {
    expect(followedFileOf('row:src/main.ts', ROWS, FOLLOWING)).toBe('src/main.ts')
    expect(followedFileOf('row:fifo', ROWS, FOLLOWING)).toBe('fifo')
  })

  test('leaves the preview on a folder’s row, a control, Claude Code’s stops and its own file', async () => {
    expect(followedFileOf('row:src', ROWS, FOLLOWING)).toBeNull()
    expect(followedFileOf('refresh', ROWS, FOLLOWING)).toBeNull()
    expect(followedFileOf(undefined, ROWS, FOLLOWING)).toBeNull()
    expect(followedFileOf('row:README.md', ROWS, FOLLOWING)).toBeNull()
  })

  test('knows no file for a row the tree does not draw', async () => {
    expect(followedFileOf('row:gone.txt', ROWS, FOLLOWING)).toBeNull()
  })

  test('never moves a closed or pinned preview, or one inline', async () => {
    expect(followedFileOf('row:src/main.ts', ROWS, { ...FOLLOWING, selected: null })).toBeNull()
    expect(followedFileOf('row:src/main.ts', ROWS, { ...FOLLOWING, isPinned: true })).toBeNull()
    expect(followedFileOf('row:src/main.ts', ROWS, { ...FOLLOWING, placement: 'inline' })).toBeNull()
  })
})

describe('pressStepOf', () => {
  test('shows a file the preview does not show, open, closed or pinned', async () => {
    expect(pressStepOf('a.txt', null, false)).toBe('show')
    expect(pressStepOf('a.txt', 'b.txt', false)).toBe('show')
    expect(pressStepOf('a.txt', 'b.txt', true)).toBe('show')
  })

  test('keeps the file it shows while following the ring, and closes it pinned', async () => {
    expect(pressStepOf('a.txt', 'a.txt', false)).toBe('keep')
    expect(pressStepOf('a.txt', 'a.txt', true)).toBe('close')
  })
})
