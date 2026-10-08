/**
 * The pane's tab label while other panes are open beside it.
 */
export const PANE_TITLE = 'Explorer'

export const COMMAND_DESCRIPTION = 'Toggle the file explorer pane'

/**
 * The line `/tree` leaves the first time it opens a pane under Claude
 * Code's classic renderer, once ever: Claude Code offers the switch itself,
 * and many people chose the classic renderer on purpose.
 */
export const FULLSCREEN_TIP_TEXT =
  'Tip: /tui fullscreen docks the tree beside the conversation and adds mouse support.'

/**
 * The line `/tree` leaves, once a session, when a fullscreen terminal is too
 * narrow to dock the pane.
 */
export const WIDEN_TIP_TEXT = 'Widen the terminal to 110 columns to dock the tree beside the conversation.'

/**
 * The store key that says the fullscreen tip was shown.
 */
export const TIP_SHOWN_KEY = 'fullscreenTipShown'

/**
 * The key prefix of a tree row's Button; the rest of the key is the row's
 * path, so a focus event names the row it lands on.
 */
export const ROW_KEY_PREFIX = 'row:'

/**
 * The keys of the pane's own controls.
 */
export const KEYS = {
  refresh: 'refresh',
  expandLevel: 'expand-level',
  collapseLevel: 'collapse-level',
  filter: 'filter',
  help: 'help',
  previewUp: 'preview-up',
  previewDown: 'preview-down',
  previewMode: 'preview-mode',
  previewClose: 'preview-close',
} as const

/**
 * The key of the filter's field, drawn anew under the next key each time
 * Enter is pressed in it: Claude Code empties a field on Enter and only
 * hands a field the `value` drawn when it differs from the last one, so a
 * new field is how the query stays in it.
 *
 * @param submits how many times Enter was pressed in the field
 * @returns the key
 */
export function filterKeyOf(submits: number): string {
  return `filter-field-${submits}`
}

/**
 * The key of the hidden Button whose digit hotkey opens the tree `levels`
 * deep; `depth-0` closes every folder.
 */
export function depthKeyOf(levels: number): string {
  return `depth-${levels}`
}
