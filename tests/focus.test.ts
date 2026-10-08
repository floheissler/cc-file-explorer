import type { RenderElement } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { focusOrderOf, focusStepOf, type FocusOrder } from '../hooks/focus'

/**
 * A drawn element as plain data, as the render hook returns it.
 */
const el = (
  type: string,
  props: Record<string, unknown>,
  ...children: (RenderElement | string)[]
): RenderElement => ({ type, props, children }) as unknown as RenderElement

const button = (key: string) => el('Button', { key, label: key })

describe('focusOrderOf', () => {
  test('lists shown and hidden focusables in document order', async () => {
    const tree = el(
      'Box',
      {},
      el('Box', {}, el('Text', {}, 'name'), button('expand-level'), button('help')),
      el('Box', {}, button('row:a'), 'a string', el('Input', { key: 'filter' })),
      el('Box', { display: 'none' }, button('depth-0'), el('Box', {}, button('depth-1'))),
    )

    expect(focusOrderOf(tree)).toEqual({
      shown: ['expand-level', 'help', 'row:a', 'filter'],
      hidden: new Set(['depth-0', 'depth-1']),
    })
  })
})

describe('focusStepOf', () => {
  const order: FocusOrder = {
    shown: ['expand-level', 'help', 'row:a', 'row:b', 'preview-close'],
    hidden: new Set(['depth-0', 'depth-9']),
  }

  test('passes moves onto shown elements and Claude Code’s own stops', async () => {
    expect(focusStepOf('row:b', 'row:a', order)).toBe('pass')
    expect(focusStepOf(undefined, 'preview-close', order)).toBe('pass')
  })

  test('stops at the tree’s last row', async () => {
    expect(focusStepOf('depth-0', 'row:b', order)).toBe('stay')
  })

  test('wraps forward from another shown element to the first', async () => {
    expect(focusStepOf('depth-0', 'preview-close', order)).toEqual({ element: 'expand-level' })
  })

  test('wraps back from the first element, or from a stop of Claude Code’s, to the last', async () => {
    expect(focusStepOf('depth-9', 'expand-level', order)).toEqual({ element: 'preview-close' })
    expect(focusStepOf('depth-9', undefined, order)).toEqual({ element: 'preview-close' })
  })

  test('stays when nothing is shown', async () => {
    expect(focusStepOf('depth-0', 'help', { shown: [], hidden: order.hidden })).toBe('stay')
  })
})
