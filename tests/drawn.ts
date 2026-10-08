import type { RenderNode } from 'claude-code'

import { cellWidth } from '../hooks/text'

/**
 * Widths of a drawn tree as the terminal lays it out, for tests: the test
 * kit hands the tree, never the painted screen, so the widths are modelled
 * on the terminal's elements.
 */

type ElementData = {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly Node[]
}

/**
 * A drawn node, read through the plain-data shape all elements share.
 */
type Node = RenderNode | ElementData

/**
 * Elements whose content wraps or scrolls within a fixed-height clipped
 * region by design, so their width is the region's, not their text's.
 */
const FLOWING = new Set(['Code', 'Markdown', 'Input'])

const textOf = (node: Node): string =>
  typeof node === 'string' ? node : ((node as ElementData).children ?? []).map(textOf).join('')

const isFlowing = (element: ElementData) =>
  FLOWING.has(element.type) || (element.type === 'Text' && element.props?.wrap === 'wrap')

/**
 * The cells an element takes laid out at its natural width: a Text its
 * widest line, a plain Button `k: label` (or its label), another Button
 * `[ label ]`, a row Box its children and the gaps between them, a column
 * Box its widest child; a hidden Box nothing.
 *
 * @param node the element
 * @returns its width in cells
 */
export function naturalWidthOf(node: Node): number {
  if (typeof node === 'string') {
    return Math.max(0, ...node.split('\n').map(cellWidth))
  }

  const element = node as ElementData
  const props = element.props ?? {}

  if (isFlowing(element)) {
    return 0
  }

  switch (element.type) {
    case 'Text':
      return Math.max(0, ...textOf(element).split('\n').map(cellWidth))
    case 'Button': {
      const label = String(props.label ?? '')
      const hotkey = typeof props.hotkey === 'string' ? props.hotkey : undefined

      if (props.plain === true) {
        return cellWidth(hotkey === undefined ? label : `${hotkey}: ${label}`)
      }

      return cellWidth(`[ ${label} ]`)
    }
    case 'Box': {
      if (props.display === 'none') {
        return 0
      }

      const children = element.children ?? []
      const widths = children.map(naturalWidthOf)
      const isColumn = props.flexDirection === 'column'
      const gap = Number(props.columnGap ?? props.gap ?? 0)
      const padding = 2 * Number(props.paddingX ?? props.padding ?? 0)

      const natural = isColumn
        ? Math.max(0, ...widths)
        : widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, children.length - 1)

      return natural + padding
    }
    default:
      return 0
  }
}

/**
 * What in a drawn tree is wider than the body, and any content that wraps
 * or scrolls outside a fixed-height clipped region.
 *
 * @param tree what the render hook drew
 * @param columns the body's width in cells
 * @returns one line per finding, none when the tree fits
 */
export function overflowsOf(tree: Node, columns: number): string[] {
  const found: string[] = []

  const describe = (element: ElementData) => {
    const key = element.props?.key
    const text = textOf(element).slice(0, 40)

    return `${element.type}${typeof key === 'string' ? ` ${key}` : ''}${text === '' ? '' : ` "${text}"`}`
  }

  const visit = (node: Node, isClipped: boolean) => {
    if (typeof node === 'string') {
      return
    }

    const element = node as ElementData
    const props = element.props ?? {}

    if (element.type === 'Box' && props.display === 'none') {
      return
    }

    if (isFlowing(element) && !isClipped) {
      found.push(`${describe(element)} flows outside a clipped region`)
    }

    const width = naturalWidthOf(element)

    if (width > columns && !(element.type === 'Box' && props.width === columns)) {
      found.push(`${describe(element)} takes ${width} cells of ${columns}`)
    }

    const clips = isClipped || (props.overflow === 'hidden' && typeof props.height === 'number')

    for (const child of element.children ?? []) {
      visit(child, clips)
    }
  }

  visit(tree, false)

  return found
}

/**
 * Every hotkey a drawn tree arms, hidden Buttons included.
 *
 * @param tree what the render hook drew
 * @returns the hotkeys, in document order
 */
export function hotkeysOf(tree: Node): string[] {
  if (typeof tree === 'string') {
    return []
  }

  const element = tree as ElementData
  const own = element.type === 'Button' && typeof element.props?.hotkey === 'string' ? [element.props.hotkey] : []

  return [...own, ...(element.children ?? []).flatMap(hotkeysOf)]
}
