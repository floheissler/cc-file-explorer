import { EMOJI, EMOJI_MODIFIER_BASE, WIDE, ZERO_WIDTH } from './cell-widths'

/**
 * Characters that never reach the terminal as themselves: C0 and C1
 * controls (an escape sequence in a file name or a file's text draws as
 * text), the bidirectional controls Claude Code itself strips (they could
 * reorder what a name shows) and lone surrogates.
 */
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u061C\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/gu

/**
 * Combining marks one character keeps: enough for every script, few enough
 * that a name stacked with thousands of marks cannot pass as one cell.
 */
const MAX_MARKS = 8

const MARK_RUN = new RegExp(`([\\p{Mn}\\p{Me}]{${MAX_MARKS}})[\\p{Mn}\\p{Me}]+`, 'gu')

/**
 * Makes untrusted text safe to draw on one row: a C0 control or DEL becomes
 * its Control Picture (a tab `␉`, a line feed `␊`, an escape `␛`), any other
 * unsafe character U+FFFD, and a run of combining marks is cut to
 * `MAX_MARKS`.
 *
 * @param text a file name, or one line of a file with its tabs expanded
 * @returns the text, safe to draw
 */
export function sanitize(text: string): string {
  return text
    .replace(UNSAFE_CHARACTERS, char => {
      const code = char.charCodeAt(0)

      return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\uFFFD'
    })
    .replace(MARK_RUN, '$1')
}

/**
 * Whether a code point lies in one of a table's [first, last] pairs.
 */
function isIn(table: readonly number[], cp: number): boolean {
  let lo = 0
  let hi = table.length / 2

  while (lo < hi) {
    const mid = (lo + hi) >> 1

    if ((table[mid * 2] ?? 0) <= cp) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  return lo > 0 && cp <= (table[lo * 2 - 1] ?? -1)
}

/**
 * The cells one code point takes on its own: 0, 1 or 2.
 */
function codePointWidth(cp: number): number {
  return isIn(ZERO_WIDTH, cp) ? 0 : isIn(WIDE, cp) ? 2 : 1
}

/**
 * Whether a code point can start an emoji cluster: the Emoji property, from
 * U+203C on and outside U+2C00 – U+1EFFF, as Bun counts it.
 */
function isEmojiBase(cp: number): boolean {
  return cp >= 0x203c && (cp < 0x2c00 || cp >= 0x1f000) && isIn(EMOJI, cp)
}

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff

const SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u

/**
 * Splits a grapheme before each skin tone that follows no Emoji_Modifier_Base
 * (`‼🏽` is two characters), as Bun does and Unicode's current rules do not.
 */
function splitSkinTones(grapheme: string): string[] {
  if (!SKIN_TONE.test(grapheme)) {
    return [grapheme]
  }

  const parts: string[] = []
  let part = ''
  let previous = -1

  for (const char of grapheme) {
    const cp = char.codePointAt(0) ?? 0

    if (isSkinTone(cp) && part !== '' && !isIn(EMOJI_MODIFIER_BASE, previous)) {
      parts.push(part)
      part = ''
    }

    part += char
    previous = cp
  }

  return [...parts, part]
}

/**
 * Splits text into what Claude Code measures as one character: graphemes
 * by `Intl.Segmenter`, split where Bun breaks and Unicode does not, or code
 * points where the runtime has no segmenter.
 */
function graphemesOf(text: string): string[] {
  if (SEGMENTER === null) {
    return Array.from(text)
  }

  return Array.from(SEGMENTER.segment(text), part => part.segment).flatMap(splitSkinTones)
}

/**
 * The cells one grapheme takes, by the rules Claude Code measures with
 * (Bun's `stringWidth`, East Asian Ambiguous as narrow): a flag, a keycap
 * and an emoji with a skin tone or a joiner take 2; VS16 widens an emoji to
 * 2; anything else is the sum of its code points.
 *
 * Without `Intl.Segmenter` a grapheme is one code point, and the joiner,
 * VS16 and the keycap mark count a cell each, so text is never measured
 * narrower than it draws.
 */
function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0) ?? 0

  if (grapheme.length === 1 && first < 0x80) {
    return first >= 0x20 && first < 0x7f ? 1 : 0
  }

  if (SEGMENTER === null) {
    return first === 0x200d || first === 0xfe0f || first === 0x20e3 ? 1 : codePointWidth(first)
  }

  let count = 0
  let sum = 0
  let hasKeycap = false
  let hasRegional = false
  let hasSkinTone = false
  let hasJoiner = false
  let hasVs15 = false
  let hasVs16 = false

  for (const char of grapheme) {
    const cp = char.codePointAt(0) ?? 0

    count += 1
    sum += codePointWidth(cp)
    hasKeycap ||= cp === 0x20e3
    hasRegional ||= isRegionalIndicator(cp)
    hasSkinTone ||= isSkinTone(cp)
    hasJoiner ||= cp === 0x200d
    hasVs15 ||= cp === 0xfe0e
    hasVs16 ||= cp === 0xfe0f
  }

  const isEmoji = isEmojiBase(first)

  if (hasRegional && count >= 2) {
    return 2
  }

  if (hasKeycap) {
    return 2
  }

  if (hasRegional) {
    return 1
  }

  if (isEmoji && (hasSkinTone || hasJoiner)) {
    return 2
  }

  if (hasVs15 || hasVs16) {
    const base = codePointWidth(first)

    return base === 2 || (hasVs16 && (isEmoji || first === 0xa9 || first === 0xae)) ? 2 : base
  }

  return sum
}

const PRINTABLE_ASCII = /^[\u0020-\u007E]*$/

/**
 * The terminal cells text takes, as Claude Code measures it: CJK and most
 * emoji two, combining marks none.
 *
 * @param text one line of text, sanitized
 * @returns its width in cells
 */
export function cellWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) {
    return text.length
  }

  let width = 0

  for (const grapheme of graphemesOf(text)) {
    width += graphemeWidth(grapheme)
  }

  return width
}

/**
 * Replaces each tab with spaces up to the next stop of four.
 *
 * @param line one line, without its line break
 * @returns the line, tab-free
 */
export function expandTabs(line: string): string {
  if (!line.includes('\t')) {
    return line
  }

  let out = ''

  for (const char of line) {
    out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char
  }

  return out
}

/**
 * Cuts text to a width in cells, keeping its start and end around an
 * ellipsis; a grapheme is never split.
 *
 * @param text one line of text, sanitized
 * @param cells the cells it may take
 * @returns the text if it fits, else its start, `…` and its end, at most
 *   `cells` wide; the start gets the odd cell
 */
export function truncateMiddle(text: string, cells: number): string {
  if (cells <= 0) {
    return ''
  }

  if (cellWidth(text) <= cells) {
    return text
  }

  if (cells === 1) {
    return '…'
  }

  const parts = graphemesOf(text).map(grapheme => ({ grapheme, width: graphemeWidth(grapheme) }))
  const room = cells - 1
  let head = 0
  let headCells = 0

  while (head < parts.length && headCells + (parts[head]?.width ?? 0) <= Math.ceil(room / 2)) {
    headCells += parts[head]?.width ?? 0
    head += 1
  }

  // The end takes what the start left, a cell a wide character did not fit
  // in included
  let tail = parts.length
  let tailCells = 0

  while (tail > head && tailCells + (parts[tail - 1]?.width ?? 0) <= room - headCells) {
    tailCells += parts[tail - 1]?.width ?? 0
    tail -= 1
  }

  const join = (from: number, to: number) =>
    parts
      .slice(from, to)
      .map(part => part.grapheme)
      .join('')

  return `${join(0, head)}…${join(tail, parts.length)}`
}

/**
 * Cuts text to a width in cells, ending it with an ellipsis; a grapheme is
 * never split.
 *
 * @param text one line of text, sanitized
 * @param cells the cells it may take
 * @returns the text if it fits, else its start and `…`, at most `cells` wide
 */
export function truncateEnd(text: string, cells: number): string {
  if (cells <= 0) {
    return ''
  }

  if (cellWidth(text) <= cells) {
    return text
  }

  let kept = ''
  let used = 0

  for (const grapheme of graphemesOf(text)) {
    const width = graphemeWidth(grapheme)

    if (used + width > cells - 1) {
      break
    }

    kept += grapheme
    used += width
  }

  return `${kept}…`
}

/**
 * Pads text with spaces to a width in cells, so a row's Button presses
 * across it.
 *
 * @param text one line of text, sanitized
 * @param cells the width wanted
 * @returns the text, `cells` wide when it was narrower
 */
export function padEnd(text: string, cells: number): string {
  const width = cellWidth(text)

  return width >= cells ? text : text + ' '.repeat(cells - width)
}

/**
 * Caps text at a number of UTF-16 units, ending it with an ellipsis; a
 * surrogate pair is never split. A size cap for long lines, not a fit to a
 * row: measuring every line of a large file in cells would cost too much.
 *
 * @param text the text
 * @param max the most UTF-16 units to keep, the ellipsis included
 * @returns the text, at most `max` units long
 */
export function clipChars(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }

  if (max <= 0) {
    return ''
  }

  const cut = max - 1
  const code = text.charCodeAt(cut - 1)
  const end = cut > 0 && code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut

  return `${text.slice(0, end)}…`
}

/**
 * A size as people read it: `512 B`, `4.2 KB`, `18 MB`.
 *
 * @param bytes the size
 * @returns the size, in its largest whole unit
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value))

  return `${shown} ${units[unit] ?? 'TB'}`
}

/**
 * A count and its noun: `1 line`, `2 lines`.
 *
 * @param count the count
 * @param noun the noun in the singular
 * @returns the phrase
 */
export function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * An error's message, one short line, safe to draw.
 *
 * @param error what was thrown or rejected
 * @returns the message
 */
export function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return clipChars(sanitize(message.split('\n')[0] ?? ''), 200)
}
