import { describe, expect, test } from 'claude-code/testing'

import {
  codeWindowOf,
  linesOf,
  looksBinary,
  markdownWindowOf,
  maxPreviewTop,
  parseDelimited,
  previewOf,
  tableWindowOf,
} from '../hooks/preview'
import { formatBytes, sanitize, truncateMiddle } from '../hooks/text'

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
    expect(linesOf('\u001b[31mred')).toEqual(['�[31mred'])
    expect(sanitize('a\u0007b')).toBe('a�b')
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
    const table = tableWindowOf(rows, 1, 5)

    expect(table.split('\n')).toEqual([
      '| id | note |',
      '| --- | --- |',
      `| 2 | ${'x'.repeat(31)}… |`,
    ])
    expect(tableWindowOf(rows, 0, 1)).toContain('a\\|b')
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
