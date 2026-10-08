import { describe, expect, test } from 'claude-code/testing'

import { fitRow, hintOf, legendsOf, plainButtonCells, wrapCells, type Control } from '../hooks/fit'
import { cellWidth } from '../hooks/text'

const HEADER: readonly Control[] = [
  { key: 'expand-level', hotkey: 'e', label: 'expand' },
  { key: 'collapse-level', hotkey: 'c', label: 'collapse' },
  { key: 'refresh', hotkey: 'r', label: 'refresh' },
  { key: 'help', hotkey: 'h', label: 'help' },
]

const LEGENDS = legendsOf(HEADER)

describe('legendsOf', () => {
  test('steps from every control labelled to a hint, to the last alone, to none', async () => {
    expect(LEGENDS.map(legend => [hintOf(legend), legend.labelled.map(control => control.hotkey).join(' ')])).toEqual([
      ['', 'e c r h'],
      ['e c r', 'h'],
      ['', 'h'],
      ['', ''],
    ])
  })

  test('measures a plain Button as its hotkey, a colon and its label', async () => {
    expect(plainButtonCells({ key: 'help', hotkey: 'h', label: 'help' })).toBe(7)
  })
})

describe('fitRow', () => {
  // The header: the name, a spacer, then the legend, a cell between each
  const pick = (columns: number) => {
    const { legend, room } = fitRow(columns, LEGENDS, 8)

    return { at: LEGENDS.indexOf(legend), room }
  }

  test('keeps every control labelled while the name keeps its floor', async () => {
    expect(pick(50)).toEqual({ at: 0, room: 8 })
    expect(pick(120)).toEqual({ at: 0, room: 78 })
  })

  test('steps down to a hint, then help alone, then nothing', async () => {
    expect(pick(49)).toEqual({ at: 1, room: 34 })
    expect(pick(23)).toEqual({ at: 1, room: 8 })
    expect(pick(22)).toEqual({ at: 2, room: 13 })
    expect(pick(17)).toEqual({ at: 2, room: 8 })
    expect(pick(16)).toEqual({ at: 3, room: 15 })
  })

  test('never draws wider than the row, and never richer as the row narrows', async () => {
    let previous = 0

    for (let columns = 200; columns >= 1; columns -= 1) {
      const { legend, room } = fitRow(columns, LEGENDS, 8)
      const hint = hintOf(legend)
      const items = [...(hint === '' ? [] : [cellWidth(hint)]), ...legend.labelled.map(plainButtonCells)]
      const used = room + 1 + items.length + items.reduce((sum, cells) => sum + cells, 0)
      const at = LEGENDS.indexOf(legend)

      expect(used).toBeLessThanOrEqual(columns)
      expect(at).toBeGreaterThanOrEqual(previous)
      previous = at
    }
  })

  test('counts the fixed parts of a row with a lead of its own', async () => {
    // The inline file view's head: `──`, the name, `──`, then the legend
    const { room } = fitRow(40, legendsOf([{ key: 'preview-close', hotkey: 'x', label: 'back' }]), 8, {
      fixedCells: 4,
      children: 3,
    })

    expect(room).toBe(40 - 4 - 4 - 7)
  })
})

describe('wrapCells', () => {
  test('wraps at spaces to rows no wider than the room, dropping the break', async () => {
    const rows = wrapCells('open every folder in view one level deeper', 12)

    expect(rows).toEqual(['open every', 'folder in', 'view one', 'level deeper'])
    expect(rows.every(row => cellWidth(row) <= 12 && !row.endsWith(' '))).toBe(true)
  })

  test('cuts a word wider than a row, and keeps a short line whole', async () => {
    expect(wrapCells('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapCells('help', 20)).toEqual(['help'])
    expect(wrapCells('', 20)).toEqual([''])
  })

  test('wraps wide characters by their cells', async () => {
    expect(wrapCells('日本語 日本語', 6)).toEqual(['日本語', '日本語'])
  })
})
