import Limits from './limits'
import { extensionOf } from './paths'
import { clamp } from './tree'
import { cellWidth, clipChars, expandTabs, formatBytes, sanitize, truncateEnd } from './text'

/**
 * A file as the preview shows it: Markdown or source lines, the rows of a
 * CSV or TSV file, or a notice in place of the text (binary, too large,
 * unreadable, empty).
 */
export type Preview =
  | {
      readonly kind: 'markdown' | 'code'
      readonly path: string
      readonly size: number
      readonly lines: readonly string[]
    }
  | {
      readonly kind: 'table'
      readonly path: string
      readonly size: number
      readonly rows: readonly (readonly string[])[]
    }
  | {
      readonly kind: 'notice'
      readonly path: string
      readonly size: number
      readonly text: string
    }

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
  'mdown',
  'mkd',
])

const TABLE_DELIMITERS: Readonly<Record<string, string>> = {
  csv: ',',
  tsv: '\t',
}

/**
 * Extensions read as binary without opening the file.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'avif', 'heic',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'wasm', 'node',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm',
  'sqlite', 'sqlite3', 'db', 'bin', 'dat', 'iso', 'dmg', 'pkg', 'deb', 'rpm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'psd', 'sketch', 'fig',
])

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TABLE_ROW = /^\s*\|/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/**
 * A notice in the preview's place.
 */
export function noticeOf(path: string, size: number, text: string): Preview {
  return { kind: 'notice', path, size, text }
}

/**
 * Whether a file's extension marks it binary, so it is never read.
 */
export function isKnownBinary(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path))
}

/**
 * Whether decoded text looks binary: a NUL, or many characters that did not
 * decode as UTF-8, near its start.
 *
 * @param text the file's text as decoded
 * @returns whether to show it as binary
 */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, Limits.SNIFF_CHARS)

  if (sample.includes('\u0000')) {
    return true
  }

  let undecoded = 0

  for (const char of sample) {
    if (char === '�') {
      undecoded += 1
    }
  }

  return undecoded > 4 && undecoded > sample.length * 0.01
}

/**
 * A text's lines as the preview draws them: tabs expanded, sanitized, each
 * capped at the line cap, no empty last line.
 *
 * @param text the text
 * @returns the lines
 */
export function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/)

  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines.map(line =>
    clipChars(sanitize(expandTabs(line)), Limits.MAX_LINE_CHARS),
  )
}

/**
 * Parses delimited text as RFC 4180 does: quoted fields may hold the
 * delimiter, line breaks and doubled quotes.
 *
 * @param text the file's text
 * @param delimiter `,` for CSV, a tab for TSV
 * @returns the rows, each a list of fields, up to the row cap
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let isQuoted = false

  for (let at = 0; at < text.length && rows.length < Limits.MAX_TABLE_ROWS; at += 1) {
    const char = text.charAt(at)

    if (isQuoted) {
      if (char !== '"') {
        field += char
      } else if (text.charAt(at + 1) === '"') {
        field += '"'
        at += 1
      } else {
        isQuoted = false
      }
    } else if (char === '"' && field === '') {
      isQuoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(at + 1) === '\n') {
        at += 1
      }

      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * The preview of a file's text, by its extension and its content.
 *
 * @param path the file, relative to the project root
 * @param size its size in bytes
 * @param text its text as decoded
 * @returns the preview
 */
export function previewOf(path: string, size: number, text: string): Preview {
  if (text.length === 0) {
    return noticeOf(path, size, 'Empty file')
  }

  if (looksBinary(text)) {
    return noticeOf(path, size, `Binary file · ${formatBytes(size)}`)
  }

  const extension = extensionOf(path)
  const delimiter = TABLE_DELIMITERS[extension]

  if (delimiter !== undefined) {
    const rows = parseDelimited(text, delimiter).map(cells =>
      cells.map(cell => sanitize(cell.replace(/\s*[\r\n]+\s*/g, ' ').trim())),
    )

    return { kind: 'table', path, size, rows }
  }

  return {
    kind: MARKDOWN_EXTENSIONS.has(extension) ? 'markdown' : 'code',
    path,
    size,
    lines: linesOf(text),
  }
}

/**
 * How many lines (or table rows, header aside) a preview scrolls over.
 */
export function lengthOf(preview: Preview): number {
  switch (preview.kind) {
    case 'markdown':
    case 'code':
      return preview.lines.length
    case 'table':
      return Math.max(0, preview.rows.length - 1)
    case 'notice':
      return 0
  }
}

/**
 * The rows a preview takes drawn whole, as tall as an inline pane draws it:
 * source a row a line, Markdown about one (it wraps and joins lines), a
 * table its head and two a body row, a notice two for a wrapped line, and
 * one while the file is read.
 *
 * @param preview the preview, or null while it is read
 * @returns the rows
 */
export function previewHeightOf(preview: Preview | null): number {
  if (preview === null) {
    return 1
  }

  switch (preview.kind) {
    case 'notice':
      return 2
    case 'table':
      return tableHeightOf(lengthOf(preview))
    case 'markdown':
    case 'code':
      return Math.max(1, lengthOf(preview))
  }
}

/**
 * The preview window's last top. Source fills its rows line for line; the
 * rendered forms draw a line or row taller or shorter than one, so they
 * scroll until their last line or row reaches the top.
 *
 * @param preview the preview
 * @param rows the rows the preview's text has
 * @param isSource whether it draws as source lines
 * @returns the largest top
 */
export function maxPreviewTop(
  preview: Preview,
  rows: number,
  isSource: boolean,
  contentColumns?: number,
): number {
  const length = lengthOf(preview)

  if (!isSource) {
    return Math.max(0, length - 1)
  }

  if (contentColumns === undefined || (preview.kind !== 'code' && preview.kind !== 'markdown')) {
    return Math.max(0, length - rows)
  }

  // Source wraps a line wider than the room onto rows under the gutter: the
  // last top is the first line from which the rest fills the rows
  const { lines } = preview
  let used = 0
  let top = lines.length

  while (top > 0) {
    const need = rowsOfLine(lines[top - 1] ?? '', contentColumns)

    if (used + need > rows) {
      break
    }

    used += need
    top -= 1
  }

  return Math.min(top, Math.max(0, length - 1))
}

/**
 * The rows one source line takes, wrapped to the room beside the gutter.
 *
 * @param line the line, as drawn
 * @param columns the cells a row has beside the gutter
 * @returns the rows, at least one
 */
export function rowsOfLine(line: string, columns: number): number {
  return Math.max(1, Math.ceil(cellWidth(line) / Math.max(1, columns)))
}

/**
 * The cells a source preview has for its text: the row less the gutter,
 * whose right-aligned line numbers grow with the file.
 *
 * @param lineCount the file's lines
 * @param columns the cells across a row
 * @returns the cells for the text
 */
export function sourceColumnsOf(lineCount: number, columns: number): number {
  return Math.max(1, columns - String(Math.max(1, lineCount)).length - Limits.CODE_GUTTER_PAD)
}

/**
 * Lines from `start`, at most `count` and within the drawing's budget.
 */
function linesWithin(lines: readonly string[], start: number, count: number): string[] {
  const taken: string[] = []
  let chars = 0

  for (let at = start; at < lines.length && taken.length < count; at += 1) {
    const line = lines[at] ?? ''

    chars += line.length + 1

    if (chars > Limits.MAX_PREVIEW_CHARS && taken.length > 0) {
      break
    }

    taken.push(line)
  }

  return taken
}

/**
 * The source a `Code` element draws for the window from `top`, and the
 * number of its first line.
 */
export function codeWindowOf(
  lines: readonly string[],
  top: number,
  count: number,
): { source: string; startLine: number } {
  const start = clamp(top, 0, Math.max(0, lines.length - 1))

  return {
    source: linesWithin(lines, start, count).join('\n'),
    startLine: start + 1,
  }
}

/**
 * The opening line of a code fence `end` falls inside, or null.
 */
function openFenceBefore(lines: readonly string[], end: number): string | null {
  let open: { marker: string; line: string } | null = null

  for (let at = 0; at < end; at += 1) {
    const line = lines[at] ?? ''
    const match = FENCE.exec(line)

    if (match === null) {
      continue
    }

    const marker = match[1] ?? ''

    if (open === null) {
      open = { marker, line }
    } else if (
      marker.charAt(0) === open.marker.charAt(0) &&
      marker.length >= open.marker.length &&
      (match[2] ?? '').trim() === ''
    ) {
      open = null
    }
  }

  return open?.line ?? null
}

/**
 * The header and rule of a pipe table `start` falls inside, so the rows in
 * view still draw as a table.
 */
function tableHeadBefore(lines: readonly string[], start: number): string[] {
  if (!TABLE_ROW.test(lines[start] ?? '')) {
    return []
  }

  let first = start

  while (first > 0 && TABLE_ROW.test(lines[first - 1] ?? '')) {
    first -= 1
  }

  const head = lines[first]
  const rule = lines[first + 1]

  if (head === undefined || rule === undefined || !TABLE_RULE.test(rule) || start === first) {
    return []
  }

  return start === first + 1 ? [head] : [head, rule]
}

/**
 * The Markdown a window from `top` draws: the lines in view, led by the
 * fence or table head they sit inside, so a cut mid-block still draws as
 * that block.
 */
export function markdownWindowOf(
  lines: readonly string[],
  top: number,
  count: number,
): string {
  const start = clamp(top, 0, Math.max(0, lines.length - 1))
  const fence = openFenceBefore(lines, start)
  const lead = fence === null ? tableHeadBefore(lines, start) : [fence]

  return [...lead, ...linesWithin(lines, start, count)].join('\n')
}

/**
 * The cells Claude Code draws a table column at the least, however short
 * its cells (checked live on 2.1.294).
 */
const MIN_TABLE_CELL_COLUMNS = 3

/**
 * The cells a drawn table takes beyond its columns' text: a border before
 * each column and after the last, and a space each side of every cell.
 */
const tableFrameCellsOf = (columnCount: number) => 3 * columnCount + 1

/**
 * The cell cap that fits a table to `columns` cells: the cell cap, or less,
 * as much as every column cut to it leaves the table no wider than the row.
 * Claude Code draws a table at its natural width and wraps a line wider
 * than the row, which breaks the table's lines apart. A cap under a
 * column's least width saves no cells, so a table too wide even at that
 * keeps it, and wraps.
 *
 * @param widths each column's widest cell, in cells
 * @param columns the cells across a row
 * @returns the cap
 */
function tableCellCapOf(widths: readonly number[], columns: number): number {
  const room = columns - tableFrameCellsOf(widths.length)
  const widthAt = (cap: number) =>
    widths.reduce((sum, width) => sum + Math.max(MIN_TABLE_CELL_COLUMNS, Math.min(width, cap)), 0)

  let cap = Limits.MAX_CELL_COLUMNS

  while (cap > MIN_TABLE_CELL_COLUMNS && widthAt(cap) > room) {
    cap -= 1
  }

  return cap
}

/**
 * One cell of a Markdown table: cut to the cap in terminal columns, its
 * pipes escaped; bold when marked, its asterisks escaped so they stay text.
 */
function tableCellOf(cell: string, cap: number, isBold = false): string {
  const cut = truncateEnd(cell, cap)

  if (cut === '') {
    return ' '
  }

  const escaped = cut.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

  return isBold ? `**${escaped.replace(/\*/g, '\\*')}**` : escaped
}

/**
 * The rows a drawn table takes above its first body row: its top border,
 * its header and the rule under it.
 */
export const TABLE_HEAD_ROWS = 3

/**
 * The rows one body row of a drawn table takes: the row, and the rule under
 * it, or the bottom border under the last (checked live on 2.1.294).
 */
export const TABLE_ROW_ROWS = 2

/**
 * The rows a table of `count` body rows takes drawn whole; with none, its
 * head and the bottom border.
 *
 * @param count the body rows
 * @returns the rows
 */
export function tableHeightOf(count: number): number {
  return TABLE_HEAD_ROWS + Math.max(1, TABLE_ROW_ROWS * count)
}

/**
 * The body rows a window of `rows` rows draws whole under the table's head,
 * at least one.
 *
 * @param rows the window's rows
 * @returns the body rows
 */
export function tableRowsIn(rows: number): number {
  return Math.max(1, Math.floor((rows - TABLE_HEAD_ROWS - 1) / TABLE_ROW_ROWS) + 1)
}

/**
 * A body row of a table window whose cells the in-file search marks: the
 * row, counted as `top` counts, and which of its cells hold the match.
 */
export type TableMark = {
  readonly row: number
  readonly isMatch: (cell: string) => boolean
}

/**
 * The Markdown table a CSV or TSV window from `top` draws: the header row,
 * then up to `count` rows from `top`, every row as wide as the widest, its
 * cells cut so the table fits `columns` cells; a marked row's matching
 * cells bold.
 */
export function tableWindowOf(
  rows: readonly (readonly string[])[],
  top: number,
  count: number,
  columns: number,
  mark?: TableMark,
): string {
  const head = rows[0] ?? []
  const body = rows.slice(1)
  const start = clamp(top, 0, Math.max(0, body.length - 1))
  const shown = body.slice(start, start + count)
  const columnCount = shown.reduce((widest, row) => Math.max(widest, row.length), Math.max(1, head.length))

  const widths = Array.from({ length: columnCount }, (_, at) =>
    [head, ...shown].reduce(
      (widest, cells) => Math.max(widest, cellWidth(truncateEnd(cells[at] ?? '', Limits.MAX_CELL_COLUMNS))),
      0,
    ),
  )

  const cap = tableCellCapOf(widths, columns)

  const lineOf = (cells: readonly string[], row: number | null = null) => {
    const isMarked = mark !== undefined && row === mark.row

    return `| ${Array.from({ length: columnCount }, (_, at) => {
      const cell = cells[at] ?? ''

      return tableCellOf(cell, cap, isMarked && mark.isMatch(cell))
    }).join(' | ')} |`
  }

  const rule = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`

  return [lineOf(head), rule, ...shown.map((cells, at) => lineOf(cells, start + at))].join('\n')
}
