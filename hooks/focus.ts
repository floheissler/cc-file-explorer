import type { RenderElement, RenderNode } from 'claude-code'

import { ROW_KEY_PREFIX } from './names'

/**
 * The pane's focusable elements as last drawn: the ones the person sees, in
 * the order the focus ring walks them, and the ones in a `display: 'none'`
 * box, drawn only so their hotkeys stay armed.
 */
export type FocusOrder = {
  readonly shown: readonly string[]
  readonly hidden: ReadonlySet<string>
}

/**
 * Where the ring goes as it moves onto an element: on as asked, kept where
 * it is, or onto another element.
 */
export type FocusStep = 'pass' | 'stay' | { readonly element: string }

const FOCUSABLE_TYPES: ReadonlySet<string> = new Set(['Button', 'Input'])

/**
 * The plain-data shape every element of a drawn tree shares, as far as the
 * walk below reads it.
 */
type ElementData = {
  readonly type: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly RenderNode[]
}

/**
 * The focusable elements of a drawn tree, shown and hidden, in document
 * order.
 *
 * @param tree what the pane's render hook returns
 * @returns the elements' keys
 */
export function focusOrderOf(tree: RenderElement): FocusOrder {
  const shown: string[] = []
  const hidden = new Set<string>()

  const visit = (node: RenderNode, isHidden: boolean): void => {
    if (typeof node === 'string') {
      return
    }

    const element = node as ElementData
    const key = element.props?.key

    if (FOCUSABLE_TYPES.has(element.type)) {
      if (typeof key === 'string') {
        if (isHidden) {
          hidden.add(key)
        } else {
          shown.push(key)
        }
      }

      return
    }

    const hides = isHidden || (element.type === 'Box' && element.props?.display === 'none')

    for (const child of element.children ?? []) {
      visit(child, hides)
    }
  }

  visit(tree, false)

  return { shown, hidden }
}

/**
 * Where the ring rests in the shown focus order once it landed on an
 * element. Claude Code keeps the ring at that place across a redraw, not on
 * the element's key, so a redraw that adds rows above it rests it on
 * another element.
 *
 * @param order the pane's focusable elements as drawn when the ring landed
 * @param element the key it landed on; absent for Claude Code's own stops
 * @returns the place, or null when it rests on none of the pane's shown
 *   elements
 */
export function ringPlaceOf(order: FocusOrder, element: string | undefined): number | null {
  const at = element === undefined ? -1 : order.shown.indexOf(element)

  return at < 0 ? null : at
}

/**
 * The element the ring rests on in a drawing: the one at its place.
 *
 * @param order the pane's focusable elements as last drawn
 * @param place where the ring rests, from `ringPlaceOf`
 * @returns its key, or undefined when nothing of the pane's is there
 */
export function ringElementOf(order: FocusOrder, place: number | null): string | undefined {
  return place === null ? undefined : order.shown[place]
}

/**
 * Where the ring starts its walk of the pane: the tree's first drawn row,
 * ahead of the header's controls drawn above it, else (the help, a file
 * shown inline) the first shown element.
 *
 * @param order the pane's focusable elements as last drawn
 * @returns its key, or undefined when nothing is shown
 */
export function ringStartOf(order: FocusOrder): string | undefined {
  return order.shown.find(key => key.startsWith(ROW_KEY_PREFIX)) ?? order.shown[0]
}

/**
 * Starts the ring at the tree and keeps it off the hidden elements, which
 * Claude Code lists in the focus order like any other.
 *
 * Coming in onto the first shown element, from nothing or from one of
 * Claude Code's own stops, the ring starts at the tree's first row instead,
 * so the arrows walk the tree before the header's controls; Up from that
 * row still reaches them. Moving onto a hidden element from the tree's last
 * row stops there, as a list stops at its end; from another shown element
 * the ring wraps to the start, and back from the first shown element (or
 * from one of Claude Code's own stops) to the last.
 *
 * @param element the key the ring moves onto; absent for Claude Code's stops
 * @param last the key the ring left; absent for Claude Code's stops, and
 *   while it rests on nothing
 * @param order the pane's focusable elements as last drawn
 * @returns the step
 */
export function focusStepOf(
  element: string | undefined,
  last: string | undefined,
  order: FocusOrder,
): FocusStep {
  const first = order.shown[0]
  const final = order.shown.at(-1)
  const start = ringStartOf(order)

  if (element === undefined) {
    return 'pass'
  }

  if (!order.hidden.has(element)) {
    const isComingIn = last === undefined && element === first

    return isComingIn && start !== undefined && start !== element ? { element: start } : 'pass'
  }

  if (start === undefined || final === undefined || last?.startsWith(ROW_KEY_PREFIX) === true) {
    return 'stay'
  }

  return { element: last === undefined || last === first ? final : start }
}
