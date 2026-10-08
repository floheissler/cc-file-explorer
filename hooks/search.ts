import { lengthOf, maxPreviewTop, rowsOfLine, tableRowsIn, type Preview } from './preview'
import { clamp } from './tree'

/**
 * The in-file search (`g`): which lines of the previewed file a query
 * matches, which match a step goes to, the window that shows it, and the
 * marks beside a source preview's rows. A match is a whole line of a source
 * or Markdown file, or a body row of a table: the steps go line by line.
 */

/**
 * A query as the search reads it: its text as typed, and whether it matches
 * case exactly, which a capital letter in it asks for (smart case).
 */
export type SearchQuery = {
  readonly text: string
  readonly isCaseSensitive: boolean
}

/**
 * The lines a step lands a few lines below, when the match is out of view:
 * the lines above it show what leads up to it.
 */
const CONTEXT_LINES = 2

/**
 * A field's text as a query: null while it holds nothing but spaces. An
 * all-lowercase query matches any case; one with a capital letter matches
 * case exactly.
 *
 * @param text the text as typed
 * @returns the query, or null
 */
export function searchQueryOf(text: string): SearchQuery | null {
  if (text.trim() === '') {
    return null
  }

  return { text, isCaseSensitive: text !== text.toLowerCase() }
}

/**
 * Tells whether a text holds the query: a line or a table cell, as drawn.
 *
 * @param query the query
 * @returns the test
 */
export function matcherOf(query: SearchQuery): (text: string) => boolean {
  if (query.isCaseSensitive) {
    return text => text.includes(query.text)
  }

  const needle = query.text.toLowerCase()

  return text => text.toLowerCase().includes(needle)
}

/**
 * Whether a preview has text to search: source, Markdown or a table with
 * lines or rows; a notice has none.
 */
export function isSearchable(preview: Preview | null): boolean {
  return preview !== null && preview.kind !== 'notice' && lengthOf(preview) > 0
}

/**
 * The lines a query matches, ascending: of a source or Markdown file its
 * lines, of a table its body rows (a row matches by any cell), each counted
 * from 0 as the preview's window counts them.
 *
 * @param preview the previewed file
 * @param query the query
 * @returns the matching lines
 */
export function matchLinesOf(preview: Preview, query: SearchQuery): number[] {
  const matches: number[] = []
  const has = matcherOf(query)

  switch (preview.kind) {
    case 'code':
    case 'markdown':
      preview.lines.forEach((line, at) => {
        if (has(line)) {
          matches.push(at)
        }
      })

      return matches
    case 'table':
      preview.rows.slice(1).forEach((row, at) => {
        if (row.some(has)) {
          matches.push(at)
        }
      })

      return matches
    case 'notice':
      return matches
  }
}

/**
 * The match a step goes to from a line: the first after it, or the last
 * before it, wrapping around the file's ends.
 *
 * @param matches the matching lines, ascending
 * @param from the line the step starts from; it may lie outside the file
 * @param direction 1 for the next match, -1 for the one before
 * @returns the match's line, or null where nothing matches
 */
export function stepMatchOf(matches: readonly number[], from: number, direction: 1 | -1): number | null {
  if (direction > 0) {
    return matches.find(line => line > from) ?? matches[0] ?? null
  }

  for (let at = matches.length - 1; at >= 0; at -= 1) {
    const line = matches[at] ?? 0

    if (line < from) {
      return line
    }
  }

  return matches.at(-1) ?? null
}

/**
 * What the search's row says the query found: nothing for a blank query,
 * the match in view among all (`4/9`), else how many lines match.
 *
 * @param matches the matching lines, null for a blank query
 * @param current the match the steps stand on, null for none
 * @returns the text
 */
export function searchStatusOf(matches: readonly number[] | null, current: number | null): string {
  if (matches === null) {
    return ''
  }

  if (matches.length === 0) {
    return 'no match'
  }

  const at = current === null ? -1 : matches.indexOf(current)
  const count = (n: number) => n.toLocaleString('en-US')

  return at < 0
    ? `${count(matches.length)} ${matches.length === 1 ? 'match' : 'matches'}`
    : `${count(at + 1)}/${count(matches.length)}`
}

/**
 * How the preview's window draws, for placing a match in it: its rows, and
 * whether it draws source lines; source wrapped to `columns` cells beside
 * its gutter, when given.
 */
export type PreviewFit = {
  readonly rows: number
  readonly isSource: boolean
  readonly columns?: number
}

/**
 * The rows the lines `from` to `to` take, both included, each wrapped to
 * the cells a row has.
 */
function rowsBetween(lines: readonly string[], from: number, to: number, columns: number | undefined): number {
  let rows = 0

  for (let at = from; at <= to; at += 1) {
    rows += columns === undefined ? 1 : rowsOfLine(lines[at] ?? '', columns)
  }

  return rows
}

/**
 * The window's top that shows a match. A window that shows the match's line
 * whole stays; else the line lands a few lines below the top, as far as the
 * window scrolls. Rendered Markdown draws its lines at no known height, so
 * there the match's line tops the window.
 *
 * @param preview the previewed file
 * @param line the match's line (a table's body row)
 * @param top the window's top
 * @param fit how the window draws
 * @returns the top
 */
export function topShowingMatch(preview: Preview, line: number, top: number, fit: PreviewFit): number {
  if (preview.kind === 'table') {
    const shown = tableRowsIn(fit.rows)

    if (line >= top && line < top + shown) {
      return top
    }

    return Math.max(0, line - Math.min(CONTEXT_LINES, shown - 1))
  }

  if (preview.kind !== 'code' && preview.kind !== 'markdown') {
    return top
  }

  if (!fit.isSource) {
    return line
  }

  const { lines } = preview

  if (line >= top && rowsBetween(lines, top, line, fit.columns) <= fit.rows) {
    return top
  }

  // As many lines above it as fit with it, up to the context
  let above = Math.min(CONTEXT_LINES, line)

  while (above > 0 && rowsBetween(lines, line - above, line, fit.columns) > fit.rows) {
    above -= 1
  }

  return clamp(line - above, 0, maxPreviewTop(preview, fit.rows, true, fit.columns))
}

/**
 * How a row of the source preview is marked: as a row of the match the
 * steps stand on, of another match, or not.
 */
export type MatchMark = 'current' | 'match' | null

/**
 * The marks of a source window's rows, top down: each line takes the rows
 * it wraps over, every one marked as its line is.
 *
 * @param lines the file's lines
 * @param top the window's first line
 * @param rows the rows the window has
 * @param columns the cells a row has for text beside the gutter
 * @param matches the matching lines
 * @param current the match the steps stand on, null for none
 * @returns a mark per row, at most `rows`
 */
export function windowMarksOf(
  lines: readonly string[],
  top: number,
  rows: number,
  columns: number,
  matches: ReadonlySet<number>,
  current: number | null,
): MatchMark[] {
  const marks: MatchMark[] = []

  for (let at = Math.max(0, top); at < lines.length && marks.length < rows; at += 1) {
    const mark: MatchMark = at === current ? 'current' : matches.has(at) ? 'match' : null
    const wrapped = Math.min(rowsOfLine(lines[at] ?? '', columns), rows - marks.length)

    for (let row = 0; row < wrapped; row += 1) {
      marks.push(mark)
    }
  }

  return marks
}
