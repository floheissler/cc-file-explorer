import Limits from './limits'

/**
 * How the pane's body is split, top to bottom: the header row, the tree,
 * and while a file is previewed its head (a blank row, its title rule and
 * its meta row) and its text.
 */
export type PaneLayout = {
  readonly bodyRows: number
  readonly treeRow: number
  readonly treeRows: number
  /**
   * The preview's first text row; the preview's head sits above it.
   */
  readonly previewRow: number
  /**
   * 0 while no file is previewed.
   */
  readonly previewRows: number
}

/**
 * The regions a body row belongs to.
 */
export type Region = 'header' | 'tree' | 'preview-head' | 'preview'

const HEADER_ROWS = 1
/**
 * A blank row setting the preview off from the tree, the rule that carries
 * the file's name, and the row of its size and controls.
 */
const PREVIEW_HEAD_ROWS = 3

/**
 * Splits a body of `bodyRows` rows: the tree alone, or the tree over the
 * preview, the tree keeping its share and each at least its minimum.
 *
 * @param bodyRows the rows the pane's body has
 * @param hasPreview whether a file is previewed
 * @returns the layout
 */
export function paneLayoutOf(bodyRows: number, hasPreview: boolean): PaneLayout {
  const rows = Math.max(HEADER_ROWS + 1, bodyRows)
  const treeRow = HEADER_ROWS

  if (!hasPreview) {
    return {
      bodyRows: rows,
      treeRow,
      treeRows: rows - HEADER_ROWS,
      previewRow: rows,
      previewRows: 0,
    }
  }

  const shared = Math.max(2, rows - HEADER_ROWS - PREVIEW_HEAD_ROWS)
  const isRoomy = shared >= Limits.MIN_TREE_ROWS + Limits.MIN_PREVIEW_ROWS

  const treeRows = isRoomy
    ? Math.min(
        shared - Limits.MIN_PREVIEW_ROWS,
        Math.max(Limits.MIN_TREE_ROWS, Math.round(shared * Limits.TREE_SHARE)),
      )
    : Math.max(1, Math.floor(shared / 2))

  const previewRow = treeRow + treeRows + PREVIEW_HEAD_ROWS

  return {
    bodyRows: rows,
    treeRow,
    treeRows,
    previewRow,
    previewRows: Math.max(1, shared - treeRows),
  }
}

/**
 * Which region a body row lies in, as the wheel's pointer names the row.
 *
 * @param layout the body as last drawn
 * @param row the body row, 0 at the top
 * @returns its region
 */
export function regionAt(layout: PaneLayout, row: number): Region {
  if (row < layout.treeRow) {
    return 'header'
  }

  if (row < layout.treeRow + layout.treeRows) {
    return 'tree'
  }

  return row < layout.previewRow ? 'preview-head' : 'preview'
}

/**
 * What an inline pane shows, one view at a time: the tree, the file picked
 * from it, or the help.
 */
export type InlineView = 'tree' | 'file' | 'help'

/**
 * The view an inline pane shows: the help while it is asked for, else the
 * file while one is picked and shown, else the tree.
 *
 * @param state the help's state, whether the file view is shown, and the
 *   picked file
 * @returns the view
 */
export function inlineViewOf(state: {
  readonly helpShown: boolean
  readonly isFileShown: boolean
  readonly selected: string | null
}): InlineView {
  if (state.helpShown) {
    return 'help'
  }

  return state.isFileShown && state.selected !== null ? 'file' : 'tree'
}

/**
 * How an inline pane's body is split: its header (the tree's, or the file's
 * head row) and the one view under it, as tall as its content and at most
 * what the room leaves. The frame of an inline pane fits what is drawn, so a
 * short tree takes few rows. The help is drawn whole: taller than the room,
 * Claude Code's window over the pane scrolls it.
 *
 * @param bodyRows the most rows the pane may take
 * @param view the view shown
 * @param contentRows the rows the view's content would take
 * @returns the layout
 */
export function inlineLayoutOf(bodyRows: number, view: InlineView, contentRows: number): PaneLayout {
  const room = Math.max(1, bodyRows - HEADER_ROWS)
  const rows = Math.max(1, view === 'help' ? contentRows : Math.min(contentRows, room))

  return {
    bodyRows: HEADER_ROWS + rows,
    treeRow: HEADER_ROWS,
    treeRows: view === 'tree' ? rows : 0,
    previewRow: view === 'file' ? HEADER_ROWS : HEADER_ROWS + rows,
    previewRows: view === 'file' ? rows : 0,
  }
}

/**
 * Where closing an inline pane by hand (Esc, its close mark) takes it first:
 * from the file or the help back to the tree; from the tree it closes.
 *
 * @param view the view shown
 * @returns the view to step back to, or null to close
 */
export function escapeStepOf(view: InlineView): InlineView | null {
  return view === 'tree' ? null : 'tree'
}
