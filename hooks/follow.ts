import { ROW_KEY_PREFIX } from './names'
import type { TreeRow } from './tree'

/**
 * The preview following the focus ring: docked, with a file previewed, each
 * file's row the ring lands on shows that file, until `p` pins the preview
 * to the file it shows. Inline, the file and the tree never show together,
 * so nothing follows there.
 */

/**
 * What the preview shows, and how it takes a ring's move, as the pane
 * stands.
 */
export type PreviewSeat = {
  /**
   * The previewed file, null while the preview is closed.
   */
  readonly selected: string | null
  readonly isPinned: boolean
  readonly placement: 'dock' | 'inline'
}

/**
 * The file the preview moves to as the ring lands on an element: the file
 * whose row it landed on, while the pane is docked and its preview open and
 * not pinned. A folder's row, the header's controls and Claude Code's own
 * stops leave the preview as it is.
 *
 * @param element the key the ring landed on; absent for Claude Code's stops
 * @param rows the tree's rows as last drawn
 * @param seat what the preview shows and how
 * @returns the file's key, or null to leave the preview
 */
export function followedFileOf(
  element: string | undefined,
  rows: readonly TreeRow[],
  seat: PreviewSeat,
): string | null {
  if (seat.placement !== 'dock' || seat.isPinned || seat.selected === null) {
    return null
  }

  if (element === undefined || !element.startsWith(ROW_KEY_PREFIX)) {
    return null
  }

  const path = element.slice(ROW_KEY_PREFIX.length)

  if (path === seat.selected) {
    return null
  }

  const row = rows.find(drawn => drawn.type === 'entry' && drawn.path === path)

  return row?.type === 'entry' && row.kind !== 'dir' ? path : null
}

/**
 * What a press on a file's row does to a docked preview: shows the file.
 * On the file the preview shows, a press keeps it while the preview follows
 * the ring, as the ring's file is the one shown and Enter must not close it;
 * pinned, a press closes it.
 *
 * @param path the pressed file
 * @param selected the previewed file, null while the preview is closed
 * @param isPinned whether the preview is pinned to its file
 * @returns the step
 */
export function pressStepOf(path: string, selected: string | null, isPinned: boolean): 'show' | 'keep' | 'close' {
  if (path !== selected) {
    return 'show'
  }

  return isPinned ? 'close' : 'keep'
}
