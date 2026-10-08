import type {
  FsEntry,
  FsStat,
  ProcessRunInit,
  ProcessRunResult,
  Timer,
  UiFocusResult,
  UiPane,
} from 'claude-code'

import type { MarkdownMode } from '../types'

/**
 * One value of the pane's session state: read it, or write it from its
 * current value, which redraws the pane.
 */
export type StateCell<T> = {
  readonly get: () => Promise<T>
  readonly set: (fn: (value: T) => T) => Promise<void>
}

/**
 * The pane's session state, value by value.
 */
export type PaneState = {
  readonly expanded: StateCell<string[]>
  readonly selected: StateCell<string | null>
  readonly treeTop: StateCell<number>
  readonly previewTop: StateCell<number>
  readonly markdownMode: StateCell<MarkdownMode>
  readonly helpShown: StateCell<boolean>
  readonly filter: StateCell<string | null>
}

/**
 * What the explorer asks of the engine, bound to one hook's `$` by
 * `hostOf` in register.tsx: every engine call the mod makes is spelled
 * there, where `claude plugin validate` reads it, and the parts beyond
 * that file take this plain record instead of `$`.
 */
export type Host = {
  /**
   * The session's project root, absolute: the tree's root.
   */
  readonly root: () => Promise<string>
  /**
   * Runs a program (git) with no shell: the filter's file list.
   */
  readonly run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  readonly list: (path: string) => Promise<readonly FsEntry[]>
  readonly stat: (path: string) => Promise<FsStat>
  readonly read: (path: string) => Promise<string>
  /**
   * This plugin's open panes.
   */
  readonly panes: () => Promise<readonly UiPane[]>
  /**
   * Asks for the pane to be drawn again from what the module holds.
   */
  readonly invalidate: () => void
  /**
   * Moves the pane's focus ring onto an element it draws, waiting a while
   * for one not drawn yet; denied while the pane does not hold the keys.
   */
  readonly focus: (key: string) => Promise<UiFocusResult>
  readonly after: (ms: number, fn: () => void) => Timer
  /**
   * Says something briefly without a turn: a level step that stopped early.
   */
  readonly toast: (text: string) => void
  /**
   * This plugin's own store, kept between sessions: what the pane has told
   * the person once.
   */
  readonly store: {
    readonly get: (key: string) => Promise<unknown>
    readonly set: (key: string, value: unknown) => Promise<void>
  }
  readonly state: PaneState
}
