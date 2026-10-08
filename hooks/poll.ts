import type { ToolCallResult } from 'claude-code'

import { parentOf } from './paths'
import type { TreeRow } from './tree'

/**
 * How the pane notices changes on disk: the checks that look at the folders
 * it shows for changes made outside Claude, and which of Claude's tool calls
 * may have written, and what.
 */

/**
 * The folders the tree shows: the root and every open folder it draws, in
 * tree order. Only these are checked; a closed folder is checked again when
 * it opens.
 *
 * @param rows the tree's rows
 * @returns the folders, relative to the root
 */
export function shownDirsOf(rows: readonly TreeRow[]): string[] {
  return ['', ...rows.flatMap(row => (row.type === 'entry' && row.isExpanded ? [row.path] : []))]
}

/**
 * The folders one check stats: the root always, and the rest in turns of at
 * most `cap` all told, so a tree with hundreds of open folders costs every
 * check the same.
 *
 * @param dirs the folders shown, the root first
 * @param cursor where this turn starts among the folders past the root
 * @param cap the most folders one check stats
 * @returns the batch, and where the next turn starts
 */
export function pollBatchOf(
  dirs: readonly string[],
  cursor: number,
  cap: number,
): { readonly batch: string[]; readonly cursor: number } {
  const rest = dirs.filter(dir => dir !== '')

  if (rest.length < cap) {
    return { batch: ['', ...rest], cursor: 0 }
  }

  const take = cap - 1
  const start = cursor % rest.length
  const batch = Array.from({ length: take }, (_, at) => rest[(start + at) % rest.length] ?? '')

  return { batch: ['', ...batch], cursor: (start + take) % rest.length }
}

/**
 * The folders to list again: those modified since they were read, and for
 * one that can no longer be stat'ed, its parent too, which no longer lists
 * it. A folder never read is not one of them: drawing it reads it.
 *
 * @param batch the folders checked
 * @param stamps each read folder's time when it was read
 * @param now each checked folder's time now, null where it cannot be stat'ed
 * @returns the folders, relative to the root
 */
export function changedDirsOf(
  batch: readonly string[],
  stamps: ReadonlyMap<string, number>,
  now: ReadonlyMap<string, number | null>,
): string[] {
  const changed = new Set<string>()

  for (const dir of batch) {
    const then = stamps.get(dir)
    const time = now.get(dir)

    if (then === undefined) {
      continue
    }

    if (time === null || time === undefined) {
      changed.add(dir)
      changed.add(parentOf(dir))
    } else if (time !== then) {
      changed.add(dir)
    }
  }

  return [...changed]
}

/**
 * Whether a tool call may have changed files, as Claude Code gates its own
 * refresh: it ran or threw, and the engine did not hold it read-only (`ls`,
 * `git status`); a denied call changed nothing.
 *
 * @param result what the call resolved to, undefined when it threw
 * @returns whether a refresh is due
 */
export function mayHaveWritten(result: ToolCallResult | undefined): boolean {
  if (result === undefined) {
    return true
  }

  const settled: { readonly deny?: string; readonly isReadOnly?: boolean } = result

  return settled.deny === undefined && settled.isReadOnly !== true
}

/**
 * The file a tool call writes by its input: Write's and Edit's `file_path`,
 * NotebookEdit's `notebook_path`. A shell command's writes cannot be told
 * from its text.
 *
 * @param input the call's input, its tool's name in `tool`
 * @returns the path as the call names it, or null for another tool
 */
export function writtenPathOf(input: {
  readonly tool: string
  readonly file_path?: unknown
  readonly notebook_path?: unknown
}): string | null {
  const path =
    input.tool === 'NotebookEdit'
      ? input.notebook_path
      : input.tool === 'Write' || input.tool === 'Edit'
        ? input.file_path
        : undefined

  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * Whether a tool call ran through: answered, neither denied nor an error,
 * as an Edit whose text was not found is.
 *
 * @param result what the call resolved to, undefined when it threw
 * @returns whether it did what it was asked
 */
export function hasSucceeded(result: ToolCallResult | undefined): boolean {
  return result !== undefined && result.deny === undefined && result.isError !== true
}
