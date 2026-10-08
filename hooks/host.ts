import type {
  FsEntry,
  FsStat,
  ProcessRunInit,
  ProcessRunResult,
  PromptBox,
  PromptFillArgs,
  PromptFilled,
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
 * A value of session state that a value kept in the store can start: it
 * also says whether this session wrote it yet, as a session starts on its
 * default.
 */
export type SeededStateCell<T> = StateCell<T> & {
  readonly isSet: () => Promise<boolean>
}

/**
 * The pane's session state, value by value.
 */
export type PaneState = {
  readonly expanded: SeededStateCell<string[]>
  readonly selected: StateCell<string | null>
  readonly treeTop: StateCell<number>
  readonly previewTop: StateCell<number>
  readonly pinned: StateCell<boolean>
  readonly markdownMode: StateCell<MarkdownMode>
  readonly helpShown: StateCell<boolean>
  readonly filter: StateCell<string | null>
  readonly search: StateCell<string | null>
  readonly written: StateCell<string[]>
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
   * The session's working folder, absolute: where a shell `cd` took it, and
   * what Claude Code resolves a mention's path against.
   */
  readonly cwd: () => Promise<string>
  /**
   * Runs a program by its argument vector, no shell, and resolves once it
   * exits, any exit code. The mod runs `git` alone, through `git.ts`: the
   * filter's file list and the markers' status.
   */
  readonly run: (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>
  readonly list: (path: string) => Promise<readonly FsEntry[]>
  readonly stat: (path: string) => Promise<FsStat>
  /**
   * Where a path lands, every link followed and `.`/`..` folded; undefined
   * where it leads nowhere. Rejects when the path is missing.
   */
  readonly realPath: (path: string) => Promise<string | undefined>
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
   * The person's prompt box: read as it stands, and written into, which
   * hands it the keyboard.
   */
  readonly prompt: {
    readonly read: () => Promise<PromptBox>
    readonly fill: (args: PromptFillArgs) => Promise<PromptFilled>
  }
  /**
   * This plugin's own store, kept between sessions and shared by every
   * session that runs the mod: what the pane has told the person once, and
   * each project's view of the pane.
   */
  readonly store: {
    readonly get: (key: string) => Promise<unknown>
    readonly set: (key: string, value: unknown) => Promise<void>
    readonly delete: (key: string) => Promise<void>
    readonly keys: () => Promise<readonly string[]>
  }
  readonly state: PaneState
}
