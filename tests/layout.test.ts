import { describe, expect, test } from 'claude-code/testing'

import { escapeStepOf, inlineLayoutOf, inlineViewOf } from '../hooks/layout'

describe('inlineViewOf', () => {
  test('shows the help while asked for, else a picked and shown file, else the tree', async () => {
    expect(inlineViewOf({ helpShown: true, isFileShown: true, selected: 'a.md' })).toBe('help')
    expect(inlineViewOf({ helpShown: false, isFileShown: true, selected: 'a.md' })).toBe('file')
    expect(inlineViewOf({ helpShown: false, isFileShown: true, selected: null })).toBe('tree')
    expect(inlineViewOf({ helpShown: false, isFileShown: false, selected: 'a.md' })).toBe('tree')
  })
})

describe('inlineLayoutOf', () => {
  test('makes the tree as tall as its rows, up to the room', async () => {
    expect(inlineLayoutOf(12, 'tree', 3)).toEqual({
      bodyRows: 4,
      treeRow: 1,
      treeRows: 3,
      previewRow: 4,
      previewRows: 0,
    })
    expect(inlineLayoutOf(12, 'tree', 50)).toMatchObject({ bodyRows: 12, treeRows: 11 })
  })

  test('gives the file the rows under its head row, and the tree none', async () => {
    expect(inlineLayoutOf(12, 'file', 5)).toEqual({
      bodyRows: 6,
      treeRow: 1,
      treeRows: 0,
      previewRow: 1,
      previewRows: 5,
    })
    expect(inlineLayoutOf(12, 'file', 500)).toMatchObject({ bodyRows: 12, previewRows: 11 })
  })

  test('draws the help whole, for the window over the pane to scroll', async () => {
    expect(inlineLayoutOf(12, 'help', 30)).toMatchObject({ bodyRows: 31, treeRows: 0, previewRows: 0 })
  })

  test('keeps a row for the view in the smallest room', async () => {
    expect(inlineLayoutOf(1, 'tree', 0)).toMatchObject({ bodyRows: 2, treeRows: 1 })
  })
})

describe('escapeStepOf', () => {
  test('steps back from the file and the help to the tree, and closes from the tree', async () => {
    expect(escapeStepOf('file')).toBe('tree')
    expect(escapeStepOf('help')).toBe('tree')
    expect(escapeStepOf('tree')).toBeNull()
  })
})
