import type {
  FsEntry,
  FsStat,
  Timer,
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
  readonly after: (ms: number, fn: () => void) => Timer
  /**
   * Says something briefly without a turn: a level step that stopped early.
   */
  readonly toast: (text: string) => void
  readonly state: PaneState
}
