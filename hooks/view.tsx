/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { MarkdownMode } from '../types'
import type { PaneLayout } from './layout'
import { KEYS, ROW_KEY_PREFIX } from './names'
import { baseName } from './paths'
import {
  codeWindowOf,
  lengthOf,
  markdownWindowOf,
  tableWindowOf,
  type Preview,
} from './preview'
import { formatBytes, padEnd, plural, sanitize, truncateMiddle } from './text'
import type { TreeRow, TreeWindow } from './tree'

/**
 * The elements the pane draws with, from the table `$.ui.resolve(e)` hands
 * the render hook: the terminal and the desktop carry all five.
 */
export type Ui = Pick<
  ElementTable<'terminal' | 'desktop'>,
  'Box' | 'Text' | 'Button' | 'Code' | 'Markdown'
>

/**
 * What the pane's controls do.
 */
export type PaneActions = {
  toggleDir: (path: string) => Promise<void>
  selectFile: (path: string) => Promise<void>
  collapseAll: () => Promise<void>
  scrollPreview: (lines: number) => Promise<void>
  toggleMarkdownMode: () => Promise<void>
  closePreview: () => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Everything one drawing of the pane draws from.
 */
export type PaneModel = {
  readonly rootName: string
  readonly rows: readonly TreeRow[]
  readonly window: TreeWindow
  readonly layout: PaneLayout
  readonly selected: string | null
  /**
   * The selected file's preview, or null while it is read.
   */
  readonly preview: Preview | null
  readonly previewTop: number
  readonly markdownMode: MarkdownMode
}

/**
 * What every part of one drawing is handed.
 */
type Kit = {
  readonly ui: Ui
  readonly actions: PaneActions
  /**
   * The cells across a row, kept clear of the body's right edge.
   */
  readonly columns: number
}

/**
 * The pane's tree: the header, the tree's window, and while a file is
 * selected its preview. Each region is exactly as tall as the layout says,
 * so the drawing fits the body and the arrows walk the rows.
 *
 * @param ui the surface's elements
 * @param actions what the controls do
 * @param columns the cells across a row
 * @param model what to draw
 * @returns the tree
 */
export function paneView(
  ui: Ui,
  actions: PaneActions,
  columns: number,
  model: PaneModel,
): RenderElement {
  const { Box } = ui
  const kit: Kit = { ui, actions, columns }

  return (
    <Box flexDirection="column" width={columns}>
      {headerRow(kit, model)}
      {treeRegion(kit, model)}
      {model.selected !== null && <Box height={1} />}
      {model.selected !== null && previewTitleRow(kit, model.selected)}
      {model.selected !== null && previewMetaRow(kit, model)}
      {model.selected !== null && previewRegion(kit, model)}
    </Box>
  )
}

function headerRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text, Button } = kit.ui
  const controls = 'c: collapse r: refresh'
  const nameRoom = Math.max(4, kit.columns - controls.length - 2)

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text bold wrap="truncate-end">
        {truncateMiddle(sanitize(model.rootName), nameRoom)}
      </Text>
      <Box flexGrow={1} />
      <Button
        key={KEYS.collapseAll}
        label="collapse"
        hotkey="c"
        plain
        dimColor
        onPress={kit.actions.collapseAll}
      />
      <Button
        key={KEYS.refresh}
        label="refresh"
        hotkey="r"
        plain
        dimColor
        onPress={kit.actions.refresh}
      />
    </Box>
  )
}

function treeRegion(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text } = kit.ui
  const { window, rows, layout } = model

  return (
    <Box flexDirection="column" height={layout.treeRows} overflow="hidden">
      {window.above > 0 && (
        <Text dimColor wrap="truncate-end">{`↑ ${window.above} more`}</Text>
      )}
      {rows.slice(window.start, window.end).map(row => treeRow(kit, row, model.selected))}
      {window.below > 0 && (
        <Text dimColor wrap="truncate-end">{`↓ ${window.below} more`}</Text>
      )}
    </Box>
  )
}

function treeRow(kit: Kit, row: TreeRow, selected: string | null): RenderElement {
  const { Text, Button } = kit.ui
  const indent = '  '.repeat(row.depth)

  if (row.type === 'note') {
    return row.isError ? (
      <Text color="error" wrap="truncate-end">{`${indent}  ${row.text}`}</Text>
    ) : (
      <Text dimColor italic wrap="truncate-end">{`${indent}  ${row.text}`}</Text>
    )
  }

  const isDir = row.kind === 'dir'
  const isSelected = row.path === selected
  const glyph = isDir ? (row.isExpanded ? '▾' : '▸') : isSelected ? '•' : ' '
  const lead = `${indent}${glyph} `
  const name = truncateMiddle(sanitize(row.name), Math.max(1, kit.columns - lead.length))
  const label = padEnd(`${lead}${name}`, kit.columns)

  const onPress = isDir
    ? () => kit.actions.toggleDir(row.path)
    : () => kit.actions.selectFile(row.path)

  return (
    <Button
      key={`${ROW_KEY_PREFIX}${row.path}`}
      label={label}
      plain
      dimColor={!isDir && !isSelected}
      onPress={onPress}
    />
  )
}

/**
 * The rule that sets the preview off from the tree, carrying the file's
 * name: `── README.md ──────`.
 */
function previewTitleRow(kit: Kit, selected: string): RenderElement {
  const { Box, Text } = kit.ui
  const name = truncateMiddle(sanitize(baseName(selected)), Math.max(4, kit.columns - 8))

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor>{'── '}</Text>
      <Text bold>{name}</Text>
      <Text dimColor wrap="truncate-end">{` ${'─'.repeat(kit.columns)}`}</Text>
    </Box>
  )
}

function metaTextOf(preview: Preview | null, markdownMode: MarkdownMode): string {
  if (preview === null) {
    return ''
  }

  const size = formatBytes(preview.size)

  switch (preview.kind) {
    case 'markdown':
      return `${size} · ${plural(preview.lines.length, 'line')} · ${markdownMode}`
    case 'code':
      return `${size} · ${plural(preview.lines.length, 'line')}`
    case 'table':
      return `${size} · ${plural(lengthOf(preview), 'row')}`
    case 'notice':
      return preview.size > 0 ? size : ''
  }
}

function previewMetaRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text, Button } = kit.ui
  const { preview, markdownMode } = model
  const isScrollable = preview !== null && lengthOf(preview) > 0
  const isMarkdown = preview?.kind === 'markdown'

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text dimColor wrap="truncate-end">
        {metaTextOf(preview, markdownMode)}
      </Text>
      <Box flexGrow={1} />
      {isScrollable && (
        <Button
          key={KEYS.previewUp}
          label="↑"
          hotkey="k"
          plain
          dimColor
          onPress={() => kit.actions.scrollPreview(-1)}
        />
      )}
      {isScrollable && (
        <Button
          key={KEYS.previewDown}
          label="↓"
          hotkey="j"
          plain
          dimColor
          onPress={() => kit.actions.scrollPreview(1)}
        />
      )}
      {isMarkdown && (
        <Button
          key={KEYS.previewMode}
          label={markdownMode === 'rendered' ? 'source' : 'rendered'}
          hotkey="m"
          plain
          dimColor
          onPress={kit.actions.toggleMarkdownMode}
        />
      )}
      <Button
        key={KEYS.previewClose}
        label="close"
        hotkey="x"
        plain
        dimColor
        onPress={kit.actions.closePreview}
      />
    </Box>
  )
}

function previewRegion(kit: Kit, model: PaneModel): RenderElement {
  const { Box } = kit.ui

  return (
    <Box flexDirection="column" height={model.layout.previewRows} overflow="hidden">
      {previewBody(kit, model)}
    </Box>
  )
}

function previewBody(kit: Kit, model: PaneModel): RenderElement {
  const { Text, Code, Markdown } = kit.ui
  const { preview, previewTop, layout, markdownMode } = model
  const rows = layout.previewRows

  if (preview === null) {
    return <Text dimColor italic>Loading…</Text>
  }

  switch (preview.kind) {
    case 'notice':
      return (
        <Text dimColor italic wrap="wrap">
          {preview.text}
        </Text>
      )
    case 'table':
      return <Markdown text={tableWindowOf(preview.rows, previewTop, rows)} />
    case 'markdown':
      if (markdownMode === 'rendered') {
        // Markdown can draw a line in less than a row (a joined paragraph),
        // so twice the rows are drawn and the region clips the rest.
        return <Markdown text={markdownWindowOf(preview.lines, previewTop, rows * 2)} />
      }

      return codeOf(Code, preview.path, codeWindowOf(preview.lines, previewTop, rows), 'markdown')
    case 'code':
      return codeOf(Code, preview.path, codeWindowOf(preview.lines, previewTop, rows))
  }
}

function codeOf(
  Code: Ui['Code'],
  path: string,
  window: { source: string; startLine: number },
  language?: string,
): RenderElement {
  return language === undefined ? (
    <Code source={window.source} path={sanitize(path)} startLine={window.startLine} />
  ) : (
    <Code source={window.source} language={language} startLine={window.startLine} />
  )
}
