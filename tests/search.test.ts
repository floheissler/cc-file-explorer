import { describe, expect, test } from 'claude-code/testing'

import { noticeOf, previewOf } from '../hooks/preview'
import {
  isSearchable,
  matcherOf,
  matchLinesOf,
  searchQueryOf,
  searchStatusOf,
  stepMatchOf,
  topShowingMatch,
  windowMarksOf,
  type SearchQuery,
} from '../hooks/search'
import { cellWidth } from '../hooks/text'

const queryOf = (text: string): SearchQuery => {
  const query = searchQueryOf(text)

  if (query === null) {
    throw new Error(`${text} is blank`)
  }

  return query
}

describe('searchQueryOf', () => {
  test('reads nothing but spaces as no query', async () => {
    expect(searchQueryOf('')).toBeNull()
    expect(searchQueryOf('   ')).toBeNull()
  })

  test('matches any case all lowercase, and case exactly with a capital letter', async () => {
    expect(searchQueryOf('value')).toEqual({ text: 'value', isCaseSensitive: false })
    expect(searchQueryOf('Value')).toEqual({ text: 'Value', isCaseSensitive: true })
    expect(searchQueryOf('größe')).toEqual({ text: 'größe', isCaseSensitive: false })
    expect(searchQueryOf('Ärger')).toEqual({ text: 'Ärger', isCaseSensitive: true })
  })

  test('keeps the spaces typed around the words', async () => {
    expect(searchQueryOf(' a ')?.text).toBe(' a ')
  })
})

describe('matcherOf', () => {
  test('finds the query anywhere in the text, by the query’s case', async () => {
    expect(matcherOf(queryOf('run'))('const out = await runGit(')).toBe(true)
    expect(matcherOf(queryOf('run'))('RUN it')).toBe(true)
    expect(matcherOf(queryOf('Run'))('const run = 1')).toBe(false)
    expect(matcherOf(queryOf('Run'))('Run it')).toBe(true)
  })
})

describe('matchLinesOf', () => {
  test('lists the matching lines of source and Markdown, from 0', async () => {
    const code = previewOf('a.ts', 0, 'alpha\nbeta\nAlphabet\ngamma')

    expect(matchLinesOf(code, queryOf('alpha'))).toEqual([0, 2])
    expect(matchLinesOf(code, queryOf('Alpha'))).toEqual([2])
    expect(matchLinesOf(previewOf('a.md', 0, '# Title\n\ntitle words'), queryOf('title'))).toEqual([0, 2])
  })

  test('lists a table’s body rows a cell of matches, the header left out', async () => {
    const table = previewOf('a.csv', 0, 'name,note\nalpha,first\nbeta,alpha too\ngamma,last\n')

    expect(matchLinesOf(table, queryOf('alpha'))).toEqual([0, 1])
    expect(matchLinesOf(table, queryOf('name'))).toEqual([])
  })

  test('finds nothing in a notice', async () => {
    expect(matchLinesOf(noticeOf('a.bin', 4, 'Binary file'), queryOf('binary'))).toEqual([])
  })
})

describe('isSearchable', () => {
  test('searches files with text, never a notice or a file still read', async () => {
    expect(isSearchable(previewOf('a.ts', 0, 'x'))).toBe(true)
    expect(isSearchable(previewOf('a.csv', 0, 'h\nrow\n'))).toBe(true)
    expect(isSearchable(previewOf('a.csv', 0, 'only a header\n'))).toBe(false)
    expect(isSearchable(noticeOf('a.bin', 4, 'Binary file'))).toBe(false)
    expect(isSearchable(null)).toBe(false)
  })
})

describe('stepMatchOf', () => {
  const matches = [3, 10, 42]

  test('steps to the next match, and around the end to the first', async () => {
    expect(stepMatchOf(matches, 3, 1)).toBe(10)
    expect(stepMatchOf(matches, 5, 1)).toBe(10)
    expect(stepMatchOf(matches, 42, 1)).toBe(3)
    expect(stepMatchOf(matches, -1, 1)).toBe(3)
  })

  test('steps back to the one before, and around the start to the last', async () => {
    expect(stepMatchOf(matches, 10, -1)).toBe(3)
    expect(stepMatchOf(matches, 11, -1)).toBe(10)
    expect(stepMatchOf(matches, 3, -1)).toBe(42)
  })

  test('stays on the one match there is, and finds none in none', async () => {
    expect(stepMatchOf([7], 7, 1)).toBe(7)
    expect(stepMatchOf([7], 7, -1)).toBe(7)
    expect(stepMatchOf([], 0, 1)).toBeNull()
    expect(stepMatchOf([], 0, -1)).toBeNull()
  })
})

describe('searchStatusOf', () => {
  test('says where the steps stand among the matches, else how many match', async () => {
    expect(searchStatusOf(null, null)).toBe('')
    expect(searchStatusOf([], null)).toBe('no match')
    expect(searchStatusOf([4], null)).toBe('1 match')
    expect(searchStatusOf([1, 4, 9], null)).toBe('3 matches')
    expect(searchStatusOf([1, 4, 9], 4)).toBe('2/3')
    expect(searchStatusOf(Array.from({ length: 1200 }, (_, at) => at), 1199)).toBe('1,200/1,200')
  })

  test('counts a match the steps no longer stand on as none', async () => {
    expect(searchStatusOf([1, 4, 9], 5)).toBe('3 matches')
  })
})

describe('topShowingMatch', () => {
  const lines = Array.from({ length: 100 }, (_, at) => `line ${at}`)
  const code = previewOf('a.ts', 0, lines.join('\n'))

  test('leaves a window that shows the match', async () => {
    expect(topShowingMatch(code, 15, 10, { rows: 10, isSource: true, columns: 40 })).toBe(10)
    expect(topShowingMatch(code, 19, 10, { rows: 10, isSource: true, columns: 40 })).toBe(10)
  })

  test('lands a match out of view two lines below the top', async () => {
    expect(topShowingMatch(code, 20, 10, { rows: 10, isSource: true, columns: 40 })).toBe(18)
    expect(topShowingMatch(code, 5, 10, { rows: 10, isSource: true, columns: 40 })).toBe(3)
    expect(topShowingMatch(code, 1, 50, { rows: 10, isSource: true, columns: 40 })).toBe(0)
  })

  test('scrolls no further than the window does at the end', async () => {
    expect(topShowingMatch(code, 99, 0, { rows: 10, isSource: true, columns: 40 })).toBe(90)
  })

  test('counts the rows the lines above it wrap over', async () => {
    const wide = previewOf('a.ts', 0, ['a', 'b', 'x'.repeat(30), 'c', 'match', 'd'].join('\n'))

    // Line 2 wraps over 3 rows of 10 cells: lines 2 to 4 take 5 rows of 4,
    // so only line 3 stays above the match
    expect(topShowingMatch(wide, 4, 0, { rows: 4, isSource: true, columns: 10 })).toBe(3)

    // A window that holds lines 0 to 4 in its 7 rows shows it where it is
    expect(topShowingMatch(wide, 4, 0, { rows: 7, isSource: true, columns: 10 })).toBe(0)
  })

  test('tops rendered Markdown’s window with the match’s line', async () => {
    const markdown = previewOf('a.md', 0, lines.join('\n'))

    expect(topShowingMatch(markdown, 15, 10, { rows: 10, isSource: false })).toBe(15)
  })

  test('keeps a table’s window while it shows the row under the table’s head', async () => {
    const table = previewOf('a.csv', 0, ['h', ...lines].join('\n'))

    // 10 rows: the top border, the header and the rule, then 7 body rows
    expect(topShowingMatch(table, 16, 10, { rows: 10, isSource: false })).toBe(10)
    expect(topShowingMatch(table, 17, 10, { rows: 10, isSource: false })).toBe(15)
  })
})

describe('windowMarksOf', () => {
  test('marks each row of a matching line, the current match apart', async () => {
    const lines = ['a', 'match one', 'b', 'x'.repeat(25), 'match two']

    expect(windowMarksOf(lines, 0, 8, 10, new Set([1, 3, 4]), 4)).toEqual([
      null,
      'match',
      null,
      'match',
      'match',
      'match',
      'current',
    ])
  })

  test('stops at the window’s rows, mid-line too', async () => {
    const lines = ['x'.repeat(25), 'y']

    expect(windowMarksOf(lines, 0, 2, 10, new Set([0]), 0)).toEqual(['current', 'current'])
    expect(windowMarksOf(lines, 1, 5, 10, new Set([0]), null)).toEqual([null])
  })

  test('draws its glyph in one cell, as Claude Code measures it', async () => {
    expect(cellWidth('▌')).toBe(1)
  })
})
