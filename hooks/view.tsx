/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement } from 'claude-code'

import type { MarkdownMode } from '../types'
import type { InlineView, PaneLayout } from './layout'
import { depthKeyOf, KEYS, ROW_KEY_PREFIX } from './names'
import { nameOf } from './paths'
import {
  codeWindowOf,
  lengthOf,
  markdownWindowOf,
  tableWindowOf,
  type Preview,
} from './preview'
import { cellWidth, formatBytes, padEnd, plural, sanitize, truncateEnd, truncateMiddle } from './text'
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
 * Where the pane sits, as each drawing says: docked beside the transcript,
 * or inline above the prompt; and whether the session draws with Claude
 * Code's classic renderer, which has no mouse and closes an inline pane on
 * Esc (fullscreen below 110 columns seats a pane inline too).
 */
export type Seat = {
  readonly placement: 'dock' | 'inline'
  readonly isClassic: boolean
}

/**
 * Everything one drawing of the pane draws from.
 */
export type PaneModel = {
  readonly seat: Seat
  /**
   * The one view an inline pane shows; null in the dock, which shows the
   * tree and the preview together.
   */
  readonly inlineView: InlineView | null
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

  if (model.inlineView === 'file' && model.selected !== null) {
    return (
      <Box flexDirection="column" width={columns}>
        {inlineFileHeadRow(kit, model, model.selected)}
        {previewRegion(kit, model)}
        {hiddenKeys(kit)}
      </Box>
    )
  }

  if (model.helpShown) {
    return (
      <Box flexDirection="column" width={columns}>
        {headerRow(kit, model)}
        {helpRegion(kit, model.layout.bodyRows - 1, model.seat)}
        {hiddenKeys(kit)}
      </Box>
    )
  }

  if (model.inlineView === 'tree') {
    return (
      <Box flexDirection="column" width={columns}>
        {headerRow(kit, model)}
        {treeRegion(kit, model)}
        {hiddenKeys(kit)}
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
      {hiddenKeys(kit)}
    </Box>
  )
}

/**
 * The digit hotkeys that set the tree's depth, listed in the help view but
 * not in the header. A `display: 'none'` box draws nothing, and Claude Code
 * still arms the hotkeys of the Buttons in it (checked on 2.1.293).
 */
function hiddenKeys(kit: Kit): RenderElement {
  const { Box, Button } = kit.ui

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
    </Box>
  )
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/**
 * One group of the help view: its keys and what each does, and lines of
 * its own under them.
 */
type HelpSection = {
  readonly title: string
  readonly rows: readonly (readonly [string, string])[]
  readonly notes?: readonly string[]
}

/**
 * Every key and pointer action, grouped, as the help view lists them where
 * the pane sits: inline, a file replaces the tree and Esc steps back, and
 * the classic renderer has no mouse.
 *
 * @param seat where the pane sits
 * @returns the sections
 */
function helpSectionsOf(seat: Seat): readonly HelpSection[] {
  const isInline = seat.placement === 'inline'

  const keys: HelpSection = {
    title: 'Keys, while the pane has the keyboard (click it, or Ctrl+X then Tab)',
    rows: [
      ['e', 'open every folder in view one level deeper'],
      ['c', 'close the deepest open folders, one level'],
      ['1 – 9', 'open folders exactly that many levels deep'],
      ['0', 'close every folder'],
      ['r', 're-read the tree and the preview'],
      ['j  k', 'scroll the preview down, up'],
      ['m', 'Markdown preview: rendered or source'],
      ['x', isInline ? 'close the file, back to the tree' : 'close the preview'],
      ['h', 'show or hide this help'],
      ['Tab ↑ ↓', isInline ? 'move between rows; Enter shows a file' : 'move between rows; Enter opens'],
    ],
  }

  const mouse: HelpSection = {
    title: 'Mouse',
    rows: [
      ['click', 'open a folder, preview a file; again to close it'],
      ['wheel', 'scroll the tree or the preview under the pointer'],
    ],
  }

  if (!isInline) {
    return [
      keys,
      mouse,
      {
        title: 'Pane',
        rows: [
          ['Ctrl+X ← →', 'resize'],
          ['Ctrl+X X', 'close'],
          ['Esc', 'give the keyboard back to the prompt'],
        ],
      },
    ]
  }

  const pane: HelpSection = {
    title: 'Pane',
    rows: [
      ['Ctrl+X ↑ ↓', 'resize; kept for every pane above the prompt'],
      ['Ctrl+X X', 'back to the tree, then close'],
      ['Esc', seat.isClassic ? 'back to the tree, then close' : 'give the keyboard back to the prompt'],
    ],
    notes: [
      seat.isClassic
        ? 'Tip: /tui fullscreen docks the tree beside the conversation and adds the mouse.'
        : 'Tip: a terminal 110 columns wide docks the tree beside the conversation.',
    ],
  }

  return seat.isClassic ? [keys, pane] : [keys, mouse, pane]
}

/**
 * The rows the help view takes drawn whole: each section's title, rows and
 * notes, and a blank row between sections.
 *
 * @param seat where the pane sits
 * @returns the rows
 */
export function helpHeightOf(seat: Seat): number {
  const sections = helpSectionsOf(seat)

  return sections.reduce(
    (rows, section, at) => rows + (at > 0 ? 1 : 0) + 1 + section.rows.length + (section.notes?.length ?? 0),
    0,
  )
}

const HELP_KEY_COLUMNS = 12

function helpRegion(kit: Kit, rows: number, seat: Seat): RenderElement {
  const { Box, Text } = kit.ui
  const room = Math.max(1, kit.columns - HELP_KEY_COLUMNS)

  // The inner box keeps its natural height inside the clipped region: rows
  // shrunk to fit would drop or overprint lines instead of clipping them
  return (
    <Box flexDirection="column" height={Math.max(1, rows)} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        {helpSectionsOf(seat).flatMap((section, at) => [
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
          ...(section.notes ?? []).map(note => (
            <Text dimColor italic wrap="truncate-end">
              {truncateEnd(note, kit.columns)}
            </Text>
          )),
        ])}
      </Box>
    </Box>
  )
}

function headerRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text, Button } = kit.ui
  const helpLabel = model.helpShown ? 'back' : 'help'
  const controls = `e: expand c: collapse r: refresh h: ${helpLabel}`
  const nameRoom = Math.max(4, kit.columns - cellWidth(controls) - 2)

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
      {rows
        .slice(window.start, window.end)
        .map(row => treeRow(kit, row, model.selected, model.inlineView === 'tree'))}
      {window.below > 0 && (
        <Text dimColor wrap="truncate-end">{`↓ ${window.below} more`}</Text>
      )}
    </Box>
  )
}

/**
 * The branch lines before a row, cut from the left in a pane too narrow for
 * the whole depth, so a name always keeps a few cells. Every branch
 * character (`│`, `├`, `└`, `─`, space) takes one cell and one UTF-16 unit,
 * so lengths here are cells.
 */
function branchOf(row: TreeRow, columns: number): string {
  const branch = branchPrefixOf(row)
  const room = Math.max(2, columns - 6)

  return branch.length <= room ? branch : branch.slice(branch.length - room)
}

/**
 * One row of the tree: its branch lines, dim, then the row itself. An entry
 * is a Button padded to the row's end, so the name and the rest of the row
 * press it; the branch lines are drawing only. In an inline pane's tree the
 * picked file's row takes the focus ring as the pane takes the keyboard, so
 * stepping back from the file lands on it.
 */
function treeRow(
  kit: Kit,
  row: TreeRow,
  selected: string | null,
  isInlineTree: boolean,
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const branch = branchOf(row, kit.columns)
  const room = Math.max(1, kit.columns - branch.length)

  if (row.type === 'note') {
    const text = truncateEnd(` ${row.text}`, room)

    return (
      <Box flexDirection="row" height={1}>
        <Text dimColor wrap="truncate-start">
          {branch}
        </Text>
        {row.isError ? (
          <Text color="error" wrap="truncate-end">
            {text}
          </Text>
        ) : (
          <Text dimColor italic wrap="truncate-end">
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
  const name = truncateMiddle(sanitize(row.name), Math.max(1, room - cellWidth(lead)))
  const label = padEnd(`${lead}${name}`, room)

  const onPress = isDir
    ? () => kit.actions.toggleDir(row.path)
    : () => kit.actions.selectFile(row.path)

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor wrap="truncate-start">
        {branch}
      </Text>
      <Button
        key={`${ROW_KEY_PREFIX}${row.path}`}
        label={label}
        plain
        dimColor={!isDir && !isSelected}
        onPress={onPress}
        {...(isInlineTree && isSelected ? { autoFocus: true } : {})}
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
  const name = truncateMiddle(sanitize(nameOf(selected)), Math.max(4, kit.columns - 8))

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor>{'── '}</Text>
      <Text bold wrap="truncate-middle">
        {name}
      </Text>
      <Text dimColor wrap="truncate-end">{` ${'─'.repeat(kit.columns)}`}</Text>
    </Box>
  )
}

/**
 * An inline pane's file view starts with one row: the file's name set in a
 * rule, then its controls; `x` steps back to the tree.
 */
function inlineFileHeadRow(kit: Kit, model: PaneModel, selected: string): RenderElement {
  const { Box, Text } = kit.ui
  const controls = previewControls(kit, model, 'back')
  const name = truncateMiddle(sanitize(nameOf(selected)), Math.max(4, kit.columns - 40))

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text dimColor>{'──'}</Text>
      <Text bold wrap="truncate-middle">
        {name}
      </Text>
      <Text dimColor>{'──'}</Text>
      <Box flexGrow={1} />
      {controls}
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
 * The previewed file's controls: scroll it (when it has lines), switch a
 * Markdown file's form, and close it, `x` labelled for where it leads.
 */
function previewControls(kit: Kit, model: PaneModel, closeLabel: string): RenderElement[] {
  const { Button } = kit.ui
  const { preview, markdownMode } = model
  const isScrollable = preview !== null && lengthOf(preview) > 0
  const isMarkdown = preview?.kind === 'markdown'

  return [
    ...(isScrollable
      ? [
          <Button
            key={KEYS.previewUp}
            label="↑"
            hotkey="k"
            plain
            dimColor
            onPress={() => kit.actions.scrollPreview(-1)}
          />,
          <Button
            key={KEYS.previewDown}
            label="↓"
            hotkey="j"
            plain
            dimColor
            onPress={() => kit.actions.scrollPreview(1)}
          />,
        ]
      : []),
    ...(isMarkdown
      ? [
          <Button
            key={KEYS.previewMode}
            label={markdownMode === 'rendered' ? 'source' : 'rendered'}
            hotkey="m"
            plain
            dimColor
            onPress={kit.actions.toggleMarkdownMode}
          />,
        ]
      : []),
    <Button
      key={KEYS.previewClose}
      label={closeLabel}
      hotkey="x"
      plain
      dimColor
      onPress={kit.actions.closePreview}
    />,
  ]
}

function previewMetaRow(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text } = kit.ui

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Text dimColor wrap="truncate-end">
        {metaTextOf(model.preview, model.markdownMode)}
      </Text>
      <Box flexGrow={1} />
      {previewControls(kit, model, 'close')}
    </Box>
  )
}

function previewRegion(kit: Kit, model: PaneModel): RenderElement {
  const { Box } = kit.ui

  // As in the help view: the content keeps its natural height and the
  // region clips it, or Markdown's rows shrink and drop or overprint lines
  return (
    <Box flexDirection="column" height={model.layout.previewRows} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        {previewBody(kit, model)}
      </Box>
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
