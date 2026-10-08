import { describe, expect, test } from 'claude-code/testing'

import {
  codeWindowOf,
  linesOf,
  looksBinary,
  markdownWindowOf,
  maxPreviewTop,
  parseDelimited,
  previewHeightOf,
  previewOf,
  tableHeightOf,
  tableRowsIn,
  tableWindowOf,
} from '../hooks/preview'
import { cellWidth, formatBytes, sanitize, truncateMiddle } from '../hooks/text'

/**
 * The cells Claude Code draws a Markdown table's lines across: each
 * column as wide as its widest cell (three at the least) and a space each
 * side, between borders (checked live on 2.1.294). Escapes and bold marks
 * take no cells.
 */
function drawnTableWidthOf(markdown: string): number {
  const rows = markdown.split('\n').map(line =>
    line
      .slice(2, -2)
      .split(/(?<!\\) \| /)
      .map(cell => cell.replace(/\*\*/g, '').replace(/\\(.)/g, '$1')),
  )

  const widths = (rows[0] ?? []).map((_, at) =>
    Math.max(3, ...rows.filter((_, row) => row !== 1).map(cells => cellWidth(cells[at] ?? ''))),
  )

  return widths.reduce((sum, width) => sum + width + 3, 1)
}

describe('previewOf', () => {
  test('reads Markdown, source and delimited files by their extension', async () => {
    expect(previewOf('docs/guide.md', 9, '# Title\n').kind).toBe('markdown')
    expect(previewOf('src/main.ts', 9, 'let a = 1').kind).toBe('code')
    expect(previewOf('notes.txt', 5, 'hello').kind).toBe('code')
    expect(previewOf('data.csv', 7, 'a,b\n1,2').kind).toBe('table')
    expect(previewOf('data.tsv', 7, 'a\tb\n1\t2')).toMatchObject({ rows: [['a', 'b'], ['1', '2']] })
  })

  test('shows a notice for empty and binary content', async () => {
    expect(previewOf('empty.txt', 0, '')).toMatchObject({ kind: 'notice', text: 'Empty file' })
    expect(previewOf('blob.txt', 2048, 'PK\u0000\u0003')).toMatchObject({
      kind: 'notice',
      text: 'Binary file · 2.0 KB',
    })
  })
})

describe('looksBinary', () => {
  test('tells text from bytes that did not decode', async () => {
    expect(looksBinary('plain text with a stray � in it')).toBe(false)
    expect(looksBinary('�'.repeat(50) + 'x'.repeat(100))).toBe(true)
  })
})

describe('linesOf', () => {
  test('splits on either line break, drops the last empty line and expands tabs', async () => {
    expect(linesOf('a\r\n\tb\n')).toEqual(['a', '    b'])
  })

  test('replaces control characters, so an escape sequence draws as text', async () => {
    expect(linesOf('\u001b[31mred')).toEqual(['\u241b[31mred'])
    expect(sanitize('a\u0007b')).toBe('a\u2407b')
  })
})

describe('parseDelimited', () => {
  test('reads quoted fields with delimiters, doubled quotes and line breaks', async () => {
    expect(parseDelimited('name,note\r\n"Doe, Jane","said ""hi""\nthen left"\n', ',')).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"\nthen left'],
    ])
  })
})

describe('preview windows', () => {
  const lines = Array.from({ length: 50 }, (_, at) => `line ${at + 1}`)

  test('numbers a code window from its first line', async () => {
    expect(codeWindowOf(lines, 10, 3)).toEqual({ source: 'line 11\nline 12\nline 13', startLine: 11 })
  })

  test('reopens the code fence a Markdown window starts inside', async () => {
    const markdown = ['# Title', '', '```ts', 'const a = 1', 'const b = 2', '```', 'after']

    expect(markdownWindowOf(markdown, 4, 2)).toBe('```ts\nconst b = 2\n```')
    expect(markdownWindowOf(markdown, 6, 2)).toBe('after')
  })

  test('repeats the head of a table a Markdown window starts inside', async () => {
    const markdown = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |']

    expect(markdownWindowOf(markdown, 3, 1)).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |')
  })

  test('draws a CSV window as a Markdown table under its header row', async () => {
    const rows = [['id', 'note'], ['1', 'a|b'], ['2', 'x'.repeat(40)]]
    const table = tableWindowOf(rows, 1, 5, 80)

    expect(table.split('\n')).toEqual([
      '| id | note |',
      '| --- | --- |',
      `| 2 | ${'x'.repeat(31)}… |`,
    ])
    expect(tableWindowOf(rows, 0, 1, 80)).toContain('a\\|b')
  })

  test('cuts the widest columns’ cells until the table fits the row', async () => {
    const rows = [
      ['first column', 'second column', 'third column', 'fourth column'],
      ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30)],
      ['some words in a cell', 'more words in this one', 'short', 'the last cell has words too'],
    ]

    // Drawn whole, 133 cells across
    expect(drawnTableWidthOf(tableWindowOf(rows, 0, 5, 200))).toBe(133)

    for (const columns of [88, 60, 40, 30]) {
      const table = tableWindowOf(rows, 0, 5, columns)

      expect(drawnTableWidthOf(table), `${columns} columns`).toBeLessThanOrEqual(columns)
    }

    // A cell shorter than the cut stays whole
    expect(tableWindowOf(rows, 0, 5, 40).split('\n')[3]).toContain('| short |')
  })

  test('cuts no cell below the three cells a column takes anyway', async () => {
    const rows = [Array.from({ length: 12 }, (_, at) => `column ${at}`)]
    const table = tableWindowOf(rows, 0, 5, 30)

    // Too wide even then, it wraps, as each column takes 3 cells and its frame
    expect(drawnTableWidthOf(table)).toBe(12 * 6 + 1)
    expect(table.split('\n')[0]).toMatch(/^\| co… \| co… \|/)
  })

  test('measures a table at three rows of head and two a body row', async () => {
    expect(tableHeightOf(0)).toBe(4)
    expect(tableHeightOf(1)).toBe(5)
    expect(tableHeightOf(3)).toBe(9)
    expect(previewHeightOf(previewOf('a.csv', 0, 'name,note\nalpha,1\nbeta,2\ngamma,3\n'))).toBe(9)

    expect(tableRowsIn(9)).toBe(3)
    expect(tableRowsIn(10)).toBe(4)
    expect(tableRowsIn(4)).toBe(1)
    expect(tableRowsIn(2)).toBe(1)
  })

  test('bolds the marked row’s matching cells, their asterisks kept as text', async () => {
    const rows = [['id', 'note'], ['1', 'a*b'], ['2', 'a*b']]
    const mark = { row: 1, isMatch: (cell: string) => cell.includes('*') }

    expect(tableWindowOf(rows, 0, 5, 80, mark).split('\n')).toEqual([
      '| id | note |',
      '| --- | --- |',
      '| 1 | a*b |',
      '| 2 | **a\\*b** |',
    ])
  })

  test('lets source scroll until its last line reaches the bottom', async () => {
    const code = previewOf('a.ts', 1, lines.join('\n'))

    expect(maxPreviewTop(code, 20, true)).toBe(30)
    expect(maxPreviewTop(code, 20, false)).toBe(49)
  })
})

describe('text', () => {
  test('cuts long names in the middle and sizes files for people', async () => {
    expect(truncateMiddle('a-very-long-file-name.ts', 10)).toBe('a-ver…e.ts')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
  })
})
