/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { MarkdownMode } from '../types'
import type { PaneLayout } from './layout'
import { depthKeyOf, KEYS, ROW_KEY_PREFIX } from './names'
import { baseName } from './paths'
import {
  codeWindowOf,
  lengthOf,
  markdownWindowOf,
  tableWindowOf,
  type Preview,
} from './preview'
import { formatBytes, padEnd, plural, sanitize, truncateEnd, truncateMiddle } from './text'
import { branchPrefixOf, type TreeRow, type TreeWindow } from './tree'

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
  /**
   * Opens every closed folder in view, one level deeper everywhere.
   */
  expandLevel: () => Promise<void>
  /**
   * Closes every open folder in view that holds no open folder.
   */
  collapseLevel: () => Promise<void>
  /**
   * Opens folders exactly `levels` deep; 0 closes every folder.
   */
  showDepth: (levels: number) => Promise<void>
  toggleHelp: () => Promise<void>
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
  /**
   * Whether the help view stands in for the tree and the preview.
   */
  readonly helpShown: boolean
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
 * The pane's tree: the header, then the help view, or the tree's window and
 * while a file is selected its preview. Each region is exactly as tall as
 * the layout says, so the drawing fits the body and the arrows walk the rows.
 * The keys the header does not show sit in a hidden box, which draws nothing
 * and keeps their hotkeys armed.
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

  if (model.helpShown) {
    return (
      <Box flexDirection="column" width={columns}>
        {headerRow(kit, model)}
        {helpRegion(kit, model.layout.bodyRows - 1)}
        {hiddenKeys(kit, model)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={columns}>
      {headerRow(kit, model)}
      {treeRegion(kit, model)}
      {model.selected !== null && <Box height={1} />}
      {model.selected !== null && previewTitleRow(kit, model.selected)}
      {model.selected !== null && previewMetaRow(kit, model)}
      {model.selected !== null && previewRegion(kit, model)}
      {hiddenKeys(kit, model)}
    </Box>
  )
}

/**
 * The hotkeys listed in the help view but not in the header: the digits
 * that set the tree's depth, and while a file is previewed `j` and `k`. A
 * `display: 'none'` box draws nothing, and Claude Code still arms the
 * hotkeys of the Buttons in it (checked on 2.1.293).
 */
function hiddenKeys(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Button } = kit.ui
  const isScrollable = !model.helpShown && model.preview !== null && lengthOf(model.preview) > 0

  return (
    <Box display="none">
      {DIGITS.map(levels => (
        <Button
          key={depthKeyOf(levels)}
          label={levels === 0 ? 'collapse all' : `open ${levels} deep`}
          hotkey={String(levels)}
          plain
          onPress={() => kit.actions.showDepth(levels)}
        />
      ))}
      {isScrollable && (
        <Button
          key={KEYS.previewUp}
          label="scroll up"
          hotkey="k"
          plain
          onPress={() => kit.actions.scrollPreview(-1)}
        />
      )}
      {isScrollable && (
        <Button
          key={KEYS.previewDown}
          label="scroll down"
          hotkey="j"
          plain
          onPress={() => kit.actions.scrollPreview(1)}
        />
      )}
    </Box>
  )
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/**
 * Every key and pointer action, grouped, as the help view lists them.
 */
const HELP: readonly { readonly title: string; readonly rows: readonly (readonly [string, string])[] }[] = [
  {
    title: 'Keys, while the pane has the keyboard (click it, or Ctrl+X then Tab)',
    rows: [
      ['e', 'open every folder in view one level deeper'],
      ['c', 'close the deepest open folders, one level'],
      ['1 – 9', 'open folders exactly that many levels deep'],
      ['0', 'close every folder'],
      ['r', 're-read the tree and the preview'],
      ['j  k', 'scroll the preview down, up'],
      ['m', 'Markdown preview: rendered or source'],
      ['x', 'close the preview'],
      ['h', 'show or hide this help'],
      ['Tab ↑ ↓', 'move between rows; Enter opens'],
    ],
  },
  {
    title: 'Mouse',
    rows: [
      ['click', 'open a folder, preview a file; again to close it'],
      ['wheel', 'scroll the tree or the preview under the pointer'],
    ],
  },
  {
    title: 'Pane',
    rows: [
      ['Ctrl+X ← →', 'resize'],
      ['Ctrl+X X', 'close'],
      ['Esc', 'give the keyboard back to the prompt'],
    ],
  },
]

const HELP_KEY_COLUMNS = 12

function helpRegion(kit: Kit, rows: number): RenderElement {
  const { Box, Text } = kit.ui
  const room = Math.max(1, kit.columns - HELP_KEY_COLUMNS)

  return (
    <Box flexDirection="column" height={Math.max(1, rows)} overflow="hidden">
      {HELP.flatMap((section, at) => [
        ...(at > 0 ? [<Box height={1} />] : []),
        <Text bold wrap="truncate-end">
          {section.title}
        </Text>,
        ...section.rows.map(([keys, does]) => (
          <Box flexDirection="row" height={1}>
            <Text color="suggestion">{padEnd(keys, HELP_KEY_COLUMNS)}</Text>
            <Text dimColor wrap="truncate-end">
              {truncateEnd(does, room)}
            </Text>
          </Box>
        )),
      ])}
    </Box>
  )
}

function headerRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text, Button } = kit.ui
  const helpLabel = model.helpShown ? 'back' : 'help'
  const controls = `e: expand c: collapse r: refresh h: ${helpLabel}`
  const nameRoom = Math.max(4, kit.columns - controls.length - 2)

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text bold wrap="truncate-end">
        {truncateMiddle(sanitize(model.rootName), nameRoom)}
      </Text>
      <Box flexGrow={1} />
      <Button
        key={KEYS.expandLevel}
        label="expand"
        hotkey="e"
        plain
        dimColor
        onPress={kit.actions.expandLevel}
      />
      <Button
        key={KEYS.collapseLevel}
        label="collapse"
        hotkey="c"
        plain
        dimColor
        onPress={kit.actions.collapseLevel}
      />
      <Button
        key={KEYS.help}
        label={helpLabel}
        hotkey="h"
        plain
        dimColor
        onPress={kit.actions.toggleHelp}
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

/**
 * The branch lines before a row, cut from the left in a pane too narrow for
 * the whole depth, so a name always keeps a few cells.
 */
function branchOf(row: TreeRow, columns: number): string {
  const branch = branchPrefixOf(row)
  const room = Math.max(2, columns - 6)

  return branch.length <= room ? branch : branch.slice(branch.length - room)
}

/**
 * One row of the tree: its branch lines, dim, then the row itself. An entry
 * is a Button padded to the row's end, so the name and the rest of the row
 * press it; the branch lines are drawing only.
 */
function treeRow(kit: Kit, row: TreeRow, selected: string | null): RenderElement {
  const { Box, Text, Button } = kit.ui
  const branch = branchOf(row, kit.columns)
  const room = Math.max(1, kit.columns - branch.length)

  if (row.type === 'note') {
    const text = truncateEnd(` ${row.text}`, room)

    return (
      <Box flexDirection="row" height={1}>
        <Text dimColor>{branch}</Text>
        {row.isError ? (
          <Text color="error">{text}</Text>
        ) : (
          <Text dimColor italic>
            {text}
          </Text>
        )}
      </Box>
    )
  }

  const isDir = row.kind === 'dir'
  const isSelected = row.path === selected
  const glyph = isDir ? (row.isExpanded ? '▾' : '▸') : isSelected ? '•' : ' '
  const lead = `${glyph} `
  const name = truncateMiddle(sanitize(row.name), Math.max(1, room - lead.length))
  const label = padEnd(`${lead}${name}`, room)

  const onPress = isDir
    ? () => kit.actions.toggleDir(row.path)
    : () => kit.actions.selectFile(row.path)

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor>{branch}</Text>
      <Button
        key={`${ROW_KEY_PREFIX}${row.path}`}
        label={label}
        plain
        dimColor={!isDir && !isSelected}
        onPress={onPress}
      />
    </Box>
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

/**
 * The preview's size and mode, and its two controls. They are bracketed
 * Buttons, which the terminal draws without their hotkey (`m`, `x`): the
 * header lists only the tree's keys, the help view the rest.
 */
function previewMetaRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text, Button } = kit.ui
  const { preview, markdownMode } = model
  const isMarkdown = preview?.kind === 'markdown'

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text dimColor wrap="truncate-end">
        {metaTextOf(preview, markdownMode)}
      </Text>
      <Box flexGrow={1} />
      {isMarkdown && (
        <Button
          key={KEYS.previewMode}
          label={markdownMode === 'rendered' ? 'source' : 'rendered'}
          hotkey="m"
          dimColor
          onPress={kit.actions.toggleMarkdownMode}
        />
      )}
      <Button
        key={KEYS.previewClose}
        label="✕"
        hotkey="x"
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
