/**
 * C0 and C1 control characters but tab and line feed: an escape sequence
 * in a file name or a file's text never reaches the terminal as one.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/**
 * Replaces control characters with U+FFFD, so untrusted text draws as text.
 *
 * @param text a file name or a line of a file
 * @returns the text, safe to draw
 */
export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARACTERS, '�')
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
 * Cuts a text to a width, keeping its start and end around an ellipsis.
 *
 * @param text the text
 * @param width the cells it may take
 * @returns the text, at most `width` long
 */
export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  if (text.length <= width) {
    return text
  }

  if (width === 1) {
    return '…'
  }

  const head = Math.ceil((width - 1) / 2)
  const tail = width - 1 - head

  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}`
}

/**
 * Cuts a text to a width, ending it with an ellipsis.
 *
 * @param text the text
 * @param width the cells it may take
 * @returns the text, at most `width` long
 */
export function truncateEnd(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

/**
 * Pads a text with spaces to a width, so a row's Button presses across it.
 *
 * @param text the text
 * @param width the width wanted
 * @returns the padded text
 */
export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
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

  return truncateEnd(sanitize(message.split('\n')[0] ?? ''), 200)
}
