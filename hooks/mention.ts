import type { PromptBox } from 'claude-code'

import { ROW_KEY_PREFIX } from './names'
import { keyOf, nameOf, nativePathOf, relativePathOf, styleOf } from './paths'
import { sanitize, truncateMiddle } from './text'
import type { TreeRow } from './tree'

/**
 * Mentioning an entry of the tree to Claude: `a` puts `@<path>` at the
 * prompt's cursor, as Claude Code's own `@` completion would, and Claude
 * Code reads the file (or lists the folder) when the prompt is sent.
 *
 * How Claude Code reads a mention (checked in 2.1.294's source and live):
 * - It resolves the path against the session's working folder, which a
 *   shell `cd` moves away from the project root.
 * - `@path` runs to the next whitespace, and drops what trails its last
 *   ASCII letter, digit or `_` (`@a.ts,` names `a.ts`; `@ファイル` nothing).
 * - `@"path"` keeps everything between its quotes; no `"` inside.
 * - A `#` ends the path in either form: what follows is a line range.
 * - `~` at the start is the home folder.
 */

/**
 * The entry a mention names: a key of the tree, and whether it is a folder.
 */
export type MentionTarget = {
  readonly key: string
  readonly isDir: boolean
}

/**
 * What `a` mentions: the tree row the focus ring is on, else the previewed
 * file.
 *
 * @param focused the key of the element the ring is on, if any
 * @param rows the tree's rows as last drawn; null while the help shows
 * @param selected the previewed file's key
 * @returns the target, or null when there is none
 */
export function mentionTargetOf(
  focused: string | undefined,
  rows: readonly TreeRow[] | null,
  selected: string | null,
): MentionTarget | null {
  if (focused?.startsWith(ROW_KEY_PREFIX) === true && rows !== null) {
    const path = focused.slice(ROW_KEY_PREFIX.length)
    const row = rows.find(drawn => drawn.type === 'entry' && drawn.path === path)

    if (row?.type === 'entry') {
      return { key: row.path, isDir: row.kind === 'dir' }
    }
  }

  return selected === null ? null : { key: selected, isDir: false }
}

/**
 * The path a mention spells for an entry: relative to the session's working
 * folder while that lies in the project (with `..` when it is a subfolder
 * the entry is not in), else absolute. A folder ends in a separator, as
 * Claude Code's completion writes one.
 *
 * @param root the session's project root, native
 * @param cwd the session's working folder, native
 * @param target the entry
 * @returns the path
 */
export function mentionPathOf(root: string, cwd: string, target: MentionTarget): string {
  const style = styleOf(root)
  const cwdKey = keyOf(root, cwd)

  if (cwdKey === null) {
    const absolute = nativePathOf(root, target.key)

    return target.isDir ? `${absolute}${style === 'win32' ? '\\' : '/'}` : absolute
  }

  const relative = relativePathOf(cwdKey, target.key, style)

  // A name starting with `~` would read as the home folder, and one starting
  // with `"` as a quoted mention
  const path = /^[~"]/.test(relative) ? `./${relative}` : relative

  return target.isDir ? `${path}/` : path
}

/**
 * Why a path cannot be written as a mention that names it.
 */
export type MentionProblem = 'control' | 'hash' | 'quote'

/**
 * A path as a mention: `@path`, or `@"path"` when it holds whitespace, or
 * would lose its last characters bare (a folder's separator aside, which
 * names the folder either way).
 *
 * @param path the path, as `mentionPathOf` spells it
 * @param isDir whether it names a folder, its last character a separator
 * @returns the mention, or why there is none
 */
export function mentionOf(
  path: string,
  isDir: boolean,
): { readonly text: string } | { readonly problem: MentionProblem } {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) {
    return { problem: 'control' }
  }

  if (path.includes('#')) {
    return { problem: 'hash' }
  }

  const named = isDir ? path.slice(0, -1) : path
  const isQuoted = /\s/.test(path) || !/[0-9A-Za-z_]$/.test(named)

  if (!isQuoted) {
    return { text: `@${path}` }
  }

  return path.includes('"') ? { problem: 'quote' } : { text: `@"${path}"` }
}

/**
 * The text that goes in at the prompt's cursor: the mention, set off by a
 * space from the words on either side, as Claude Code reads a mention only
 * after whitespace or at the start.
 *
 * @param box the prompt box as it stands
 * @param mention the mention
 * @returns the text to insert
 */
export function insertionOf(box: PromptBox, mention: string): string {
  const before = box.text.slice(0, box.cursor)
  const after = box.text.slice(box.cursor)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = /^\s/.test(after) ? '' : ' '

  return `${lead}${mention}${trail}`
}

/**
 * The cells of an entry's name a toast quotes.
 */
const NAME_CELLS = 40

/**
 * Why `a` mentioned nothing: no target, a path no mention can name, the
 * prompt box refusing the text (under a dialog, without a box, or a hook's
 * own refusal), or a call that failed.
 */
export type MentionFailure = 'none' | MentionProblem | 'dialog' | 'no_composer' | 'refused' | 'failed'

/**
 * What a toast says when `a` mentions nothing.
 *
 * @param reason why
 * @param key the entry's key, when there is one
 * @param detail the failed call's message, sanitized
 * @returns the toast's text
 */
export function mentionToastOf(reason: MentionFailure, key?: string, detail?: string): string {
  const name = key === undefined ? 'it' : truncateMiddle(sanitize(nameOf(key)), NAME_CELLS)

  switch (reason) {
    case 'none':
      return 'Focus a row or preview a file to mention it'
    case 'control':
      return `Cannot mention ${name}: its path holds a control character`
    case 'hash':
      return `Cannot mention ${name}: Claude Code reads a # in a mention as a line range`
    case 'quote':
      return `Cannot mention ${name}: its path holds both a space and a "`
    case 'dialog':
      return 'A dialog holds the prompt: close it, then press a again'
    case 'no_composer':
      return 'This session has no prompt box to mention a file in'
    case 'refused':
      return `The prompt box did not take the mention of ${name}`
    case 'failed':
      return `Could not mention ${name}: ${detail ?? 'unknown error'}`
  }
}
