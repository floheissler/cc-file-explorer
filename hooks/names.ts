/**
 * The pane's tab label while other panes are open beside it.
 */
export const PANE_TITLE = 'Explorer'

export const COMMAND_DESCRIPTION = 'Toggle the file explorer pane'

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
  help: 'help',
  previewUp: 'preview-up',
  previewDown: 'preview-down',
  previewMode: 'preview-mode',
  previewClose: 'preview-close',
} as const

/**
 * The key of the hidden Button whose digit hotkey opens the tree `levels`
 * deep; `depth-0` closes every folder.
 */
export function depthKeyOf(levels: number): string {
  return `depth-${levels}`
}
