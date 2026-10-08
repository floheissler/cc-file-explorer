import { cellWidth } from './text'

/**
 * Fitting a row's controls to its width. A Button never shrinks and cannot
 * be cut, so a row picks the richest legend of its controls that leaves its
 * name room, and every control it does not draw labelled keeps its hotkey
 * in the hidden box.
 */

/**
 * One control of a row: its key, its hotkey and its label.
 */
export type Control = {
  readonly key: string
  readonly hotkey: string
  readonly label: string
}

/**
 * A row's controls as drawn: some as labelled Buttons, and some named by
 * their hotkeys alone in a hint before them. The rest are not drawn.
 */
export type Legend = {
  readonly hinted: readonly Control[]
  readonly labelled: readonly Control[]
}

/**
 * The cells a plain Button with a hotkey takes: `h: help`.
 *
 * @param control the control
 * @returns its width in cells
 */
export function plainButtonCells(control: Control): number {
  return cellWidth(control.hotkey) + 2 + cellWidth(control.label)
}

/**
 * The hint naming hinted controls by their hotkeys: `e c r`.
 *
 * @param legend the legend
 * @returns the hint, `''` for none
 */
export function hintOf(legend: Legend): string {
  return legend.hinted.map(control => control.hotkey).join(' ')
}

/**
 * The items a legend draws, a hint and its labelled Buttons, each with its
 * width in cells.
 */
function itemCellsOf(legend: Legend): number[] {
  const hint = hintOf(legend)

  return [...(hint === '' ? [] : [cellWidth(hint)]), ...legend.labelled.map(plainButtonCells)]
}

/**
 * A row's legends, richest first: every control labelled; then the last one
 * labelled after a hint of the others' keys; then the last one alone; then
 * none. The last control is the one a row keeps longest (help, close).
 *
 * @param controls the row's controls, in drawing order
 * @returns the legends
 */
export function legendsOf(controls: readonly Control[]): Legend[] {
  if (controls.length === 0) {
    return [{ hinted: [], labelled: [] }]
  }

  const last = controls.slice(-1)
  const rest = controls.slice(0, -1)

  return [
    { hinted: [], labelled: controls },
    ...(rest.length > 0 ? [{ hinted: rest, labelled: last }] : []),
    { hinted: [], labelled: last },
    { hinted: [], labelled: [] },
  ]
}

/**
 * How a row's parts besides its legend sit: the cells its fixed parts take
 * (rules, not the name), and how many children come before the spacer that
 * pushes the legend right, the name among them. Each child is set off by
 * the row's gap of one cell.
 */
export type RowLead = {
  readonly fixedCells: number
  readonly children: number
}

/**
 * Picks the richest legend that leaves the row's name `floor` cells, or the
 * poorest when none does, and the cells the name then has.
 *
 * @param columns the row's width in cells
 * @param legends the legends, richest first
 * @param floor the cells the name should keep
 * @param lead the row's other parts
 * @returns the legend and the name's room, 0 when there is none
 */
export function fitRow(
  columns: number,
  legends: readonly Legend[],
  floor: number,
  lead: RowLead = { fixedCells: 0, children: 1 },
): { readonly legend: Legend; readonly room: number } {
  const roomOf = (legend: Legend) => {
    const items = itemCellsOf(legend)
    const gaps = lead.children + items.length

    return columns - lead.fixedCells - gaps - items.reduce((sum, cells) => sum + cells, 0)
  }

  const fits = legends.find(legend => roomOf(legend) >= floor)
  const legend = fits ?? legends.at(-1) ?? { hinted: [], labelled: [] }

  return { legend, room: Math.max(0, roomOf(legend)) }
}

/**
 * Wraps a line to rows of at most `cells` cells, at spaces where it can,
 * cutting a word longer than a row. The space a row breaks at is dropped,
 * so no row ends in one.
 *
 * @param text one line, sanitized
 * @param cells the cells a row has
 * @returns the rows, at least one
 */
export function wrapCells(text: string, cells: number): string[] {
  const width = Math.max(1, cells)
  const rows: string[] = []
  let row = ''

  const push = () => {
    rows.push(row.trimEnd())
    row = ''
  }

  for (const word of text.split(/ +/)) {
    const joined = row === '' ? word : `${row} ${word}`

    if (cellWidth(joined) <= width) {
      row = joined

      continue
    }

    if (row !== '') {
      push()
    }

    // A word wider than a row is cut where the row ends
    let rest = word

    while (cellWidth(rest) > width) {
      let cut = ''

      for (const char of rest) {
        if (cellWidth(cut + char) > width) {
          break
        }

        cut += char
      }

      if (cut === '') {
        cut = Array.from(rest)[0] ?? ''
      }

      rows.push(cut)
      rest = rest.slice(cut.length)
    }

    row = rest
  }

  if (row !== '' || rows.length === 0) {
    push()
  }

  return rows
}
