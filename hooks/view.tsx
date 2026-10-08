/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ElementTable, RenderElement, ThemeKey } from 'claude-code'

import type { MarkdownMode } from '../types'
import { fitRow, hintOf, legendsOf, wrapCells, type Control, type Legend } from './fit'
import type { InlineView, PaneLayout } from './layout'
import Limits from './limits'
import { depthKeyOf, KEYS, ROW_KEY_PREFIX } from './names'
import { nameOf } from './paths'
import {
  codeWindowOf,
  lengthOf,
  markdownWindowOf,
  tableWindowOf,
  type Preview,
} from './preview'
import {
  CHANGES_GLYPH,
  GIT_LETTERS,
  WRITTEN_GLYPH,
  type GitState,
  type RowMark,
  type TreeMarks,
} from './status'
import { cellWidth, formatBytes, padEnd, plural, sanitize, truncateEnd, truncateMiddle } from './text'
import { branchPrefixOf, type TreeRow, type TreeWindow } from './tree'

/**
 * The elements the pane draws with, from the table `$.ui.resolve(e)` hands
 * the render hook: the terminal and the desktop carry all six.
 */
export type Ui = Pick<
  ElementTable<'terminal' | 'desktop'>,
  'Box' | 'Text' | 'Button' | 'Code' | 'Markdown' | 'Input'
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
  /**
   * Shows the filter and puts the keyboard in its field; shown, closes it.
   */
  toggleFilter: () => Promise<void>
  /**
   * The filter's text changed: the tree narrows to it once typing pauses.
   */
  typeFilter: (text: string) => Promise<void>
  /**
   * Enter in the filter: the focus goes to the first match; with nothing
   * typed, the filter closes.
   */
  submitFilter: (text: string) => Promise<void>
  /**
   * Puts an `@` mention of the focused row, else the previewed file, at the
   * prompt's cursor.
   */
  mention: () => Promise<void>
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
  /**
   * The markers at the rows' right ends: git's, and Claude's writes.
   */
  readonly marks: TreeMarks
  readonly window: TreeWindow
  readonly layout: PaneLayout
  readonly selected: string | null
  /**
   * The entry `/tree <path>` revealed, whose row takes the focus ring as the
   * pane takes the keyboard, until the person moves the ring; null for none.
   */
  readonly revealed: string | null
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
  /**
   * The filter's row over the tree, null while the filter is not shown.
   */
  readonly filter: FilterModel | null
  /**
   * The row `a` mentioned, which takes the focus ring back as the pane takes
   * the keyboard again, until the ring lands anywhere; null for none.
   */
  readonly mentioned: string | null
}

/**
 * The filter's row as drawn: its field and what the query found.
 */
export type FilterModel = {
  /**
   * The field's key, which moves on at each Enter (`filterKeyOf`).
   */
  readonly key: string
  /**
   * The text the field is drawn holding: the query as typed.
   */
  readonly value: string
  /**
   * What the query found (`3 matches`), `''` for a blank query.
   */
  readonly status: string
  /**
   * Whether nothing is typed: Enter then closes the filter.
   */
  readonly isBlank: boolean
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
 * How a Text is colored: in a theme color, which follows the person's
 * theme, or dim.
 */
type Tone = { readonly color: ThemeKey } | { readonly dimColor: true }

/**
 * Keys in the color a plain Button draws its hotkey in.
 */
const KEY_TONE: Tone = { color: 'suggestion' }

/**
 * Git's markers in the colors of a diff: new in green, changed in yellow,
 * gone or conflicting in red, ignored dim.
 */
const GIT_TONES: Readonly<Record<GitState, Tone>> = {
  conflicted: { color: 'error' },
  deleted: { color: 'error' },
  modified: { color: 'warning' },
  renamed: { color: 'success' },
  added: { color: 'success' },
  untracked: { color: 'success' },
  ignored: { dimColor: true },
}

/**
 * Claude's writes in Claude's own color.
 */
const WRITTEN_TONE: Tone = { color: 'claude' }

/**
 * The pane's tree: the header, then the help view, or the filter's row while
 * shown, the tree's window and while a file is selected its preview. Each
 * region is exactly as tall as the layout says, so the drawing fits the body
 * and the arrows walk the rows. The keys the header does not show sit in a
 * hidden box, which draws nothing and keeps their hotkeys armed.
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
    const head = inlineFileHeadRow(kit, model, model.selected)

    return (
      <Box flexDirection="column" width={columns}>
        {head.row}
        {previewRegion(kit, model)}
        {hiddenKeys(kit, head.hidden)}
      </Box>
    )
  }

  const header = headerRow(kit, model)

  if (model.helpShown) {
    return (
      <Box flexDirection="column" width={columns}>
        {header.row}
        {helpRegion(kit, model.layout.bodyRows - 1, model.seat)}
        {hiddenKeys(kit, header.hidden)}
      </Box>
    )
  }

  const filter = model.filter === null ? null : filterRow(kit, model.filter)

  if (model.inlineView === 'tree' || model.selected === null) {
    return (
      <Box flexDirection="column" width={columns}>
        {header.row}
        {filter}
        {treeRegion(kit, model)}
        {hiddenKeys(kit, header.hidden)}
      </Box>
    )
  }

  const meta = previewMetaRow(kit, model)

  return (
    <Box flexDirection="column" width={columns}>
      {header.row}
      {filter}
      {treeRegion(kit, model)}
      <Box height={1} />
      {previewTitleRow(kit, model.selected)}
      {meta.row}
      {previewRegion(kit, model)}
      {hiddenKeys(kit, [...header.hidden, ...meta.hidden])}
    </Box>
  )
}

/**
 * A control the pane draws, with what pressing it does.
 */
type ActionControl = Control & {
  readonly onPress: () => Promise<void>
}

/**
 * A row fitted to the pane's width, and the controls it does not draw
 * labelled: they keep their hotkeys in the hidden box.
 */
type Fitted = {
  readonly row: RenderElement
  readonly hidden: readonly ActionControl[]
}

/**
 * The keys the rows do not draw: the digits that set the tree's depth,
 * listed in the help view only, and each row's controls left out of its
 * legend in a narrow pane. A `display: 'none'` box draws nothing, and
 * Claude Code still arms the hotkeys of the Buttons in it (checked on
 * 2.1.293); every control is drawn exactly once, here or in its row.
 */
function hiddenKeys(kit: Kit, hidden: readonly ActionControl[]): RenderElement {
  const { Box, Button } = kit.ui

  return (
    <Box display="none">
      {hidden.map(control => (
        <Button
          key={control.key}
          label={control.label}
          hotkey={control.hotkey}
          plain
          onPress={control.onPress}
        />
      ))}
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

/**
 * A legend's items: the hint of keys, in the color a plain Button draws its
 * hotkey in, then the labelled Buttons.
 */
function legendItems(kit: Kit, legend: Legend, controls: readonly ActionControl[]): RenderElement[] {
  const { Text, Button } = kit.ui
  const hint = hintOf(legend)
  const labelled = controls.filter(control => legend.labelled.includes(control))

  return [
    ...(hint === '' ? [] : [<Text color="suggestion">{hint}</Text>]),
    ...labelled.map(control => (
      <Button
        key={control.key}
        label={control.label}
        hotkey={control.hotkey}
        plain
        dimColor
        onPress={control.onPress}
      />
    )),
  ]
}

const notLabelledIn = (controls: readonly ActionControl[], legend: Legend) =>
  controls.filter(control => !legend.labelled.includes(control))

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/**
 * One row of a help group: its keys (or the marker it explains), what it
 * does or means, and the marker's own tone; keys are drawn in the color of
 * a plain Button's hotkey.
 */
type HelpRow = readonly [keys: string, does: string, tone?: Tone]

/**
 * One group of the help view: its rows, and lines of its own under them.
 */
type HelpSection = {
  readonly title: string
  readonly rows: readonly HelpRow[]
  readonly notes?: readonly string[]
}

/**
 * What the markers at the rows' right ends mean.
 */
const MARKERS: HelpSection = {
  title: 'Markers',
  rows: [
    [GIT_LETTERS.modified, 'changed since the last commit', GIT_TONES.modified],
    [GIT_LETTERS.added, 'new, staged', GIT_TONES.added],
    [GIT_LETTERS.renamed, 'renamed, staged', GIT_TONES.renamed],
    [GIT_LETTERS.untracked, 'new, not tracked yet', GIT_TONES.untracked],
    [GIT_LETTERS.deleted, 'removed from git, kept on disk', GIT_TONES.deleted],
    [GIT_LETTERS.conflicted, 'in a merge conflict', GIT_TONES.conflicted],
    [GIT_LETTERS.ignored, 'ignored by git, or in an ignored folder', GIT_TONES.ignored],
    [CHANGES_GLYPH, 'a folder with changes in it, colored by the strongest', GIT_TONES.modified],
    [WRITTEN_GLYPH, 'Claude wrote it this session (a folder: something in it)', WRITTEN_TONE],
  ],
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
      ['f', 'filter the tree by name as you type; again to clear'],
      ['a', 'mention the focused row to Claude at the prompt (@path), else the previewed file'],
      ['w  s', 'scroll the preview up, down'],
      ['m', 'Markdown preview: rendered or source'],
      ['x', isInline ? 'close the file, back to the tree' : 'close the preview'],
      ['h', 'show or hide this help'],
      ['Tab ↑ ↓', isInline ? 'move between rows; Enter shows a file' : 'move between rows; Enter opens'],
    ],
  }

  const filter: HelpSection = {
    title: 'Filter',
    rows: [
      ['Enter', 'go to the first match; with nothing typed, close the filter'],
      ['↓ ↑', 'from the filter to the tree, and back'],
      ['Esc', isInline && seat.isClassic ? 'close the filter' : 'give the keyboard back to the prompt'],
    ],
    notes: [
      'Words match parts of names, in any case; a word with a / matches the path from the project root. Folders git ignores match by name, not by what they hold.',
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
      filter,
      mouse,
      MARKERS,
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

  return seat.isClassic ? [keys, filter, MARKERS, pane] : [keys, filter, mouse, MARKERS, pane]
}

/**
 * One row of the help view as drawn: a section's title, a key and a row of
 * what it does (a description wrapped over rows has no key on the rest), a
 * note's row, or a blank row between sections.
 */
type HelpLine =
  | { readonly kind: 'title' | 'note'; readonly text: string }
  | { readonly kind: 'key'; readonly keys: string; readonly text: string; readonly tone: Tone }
  | { readonly kind: 'blank' }

const HELP_KEY_COLUMNS = 12

/**
 * The cells the help view gives its key column: 12, or half a narrow pane.
 */
const helpKeyColumnsOf = (columns: number) => Math.max(1, Math.min(HELP_KEY_COLUMNS, Math.floor(columns / 2)))

/**
 * The help view's rows at a width, every description and note wrapped to
 * fit it.
 *
 * @param seat where the pane sits
 * @param columns the cells across a row
 * @returns the rows
 */
function helpLinesOf(seat: Seat, columns: number): HelpLine[] {
  const keyColumns = helpKeyColumnsOf(columns)
  const room = Math.max(1, columns - keyColumns)

  return helpSectionsOf(seat).flatMap((section, at): HelpLine[] => [
    ...(at > 0 ? [{ kind: 'blank' } as const] : []),
    { kind: 'title', text: truncateEnd(section.title, columns) },
    ...section.rows.flatMap(([keys, does, tone = KEY_TONE]) =>
      wrapCells(does, room).map(
        (text, row): HelpLine => ({
          kind: 'key',
          keys: row === 0 ? padEnd(truncateEnd(keys, Math.max(1, keyColumns - 1)), keyColumns) : ' '.repeat(keyColumns),
          text,
          tone,
        }),
      ),
    ),
    ...(section.notes ?? []).flatMap(note => wrapCells(note, columns).map((text): HelpLine => ({ kind: 'note', text }))),
  ])
}

/**
 * The rows the help view takes drawn whole at a width.
 *
 * @param seat where the pane sits
 * @param columns the cells across a row
 * @returns the rows
 */
export function helpHeightOf(seat: Seat, columns: number): number {
  return helpLinesOf(seat, columns).length
}

function helpRegion(kit: Kit, rows: number, seat: Seat): RenderElement {
  const { Box, Text } = kit.ui

  const lineOf = (line: HelpLine): RenderElement => {
    switch (line.kind) {
      case 'blank':
        return <Box height={1} />
      case 'title':
        return (
          <Text bold wrap="truncate-end">
            {line.text}
          </Text>
        )
      case 'note':
        return (
          <Text dimColor italic wrap="truncate-end">
            {line.text}
          </Text>
        )
      case 'key':
        return (
          <Box flexDirection="row" height={1}>
            <Text {...line.tone}>{line.keys}</Text>
            <Text dimColor wrap="truncate-end">
              {line.text}
            </Text>
          </Box>
        )
    }
  }

  // The inner box keeps its natural height inside the clipped region: rows
  // shrunk to fit would drop or overprint lines instead of clipping them
  return (
    <Box flexDirection="column" height={Math.max(1, rows)} overflow="hidden">
      <Box flexDirection="column" flexShrink={0}>
        {helpLinesOf(seat, kit.columns).map(lineOf)}
      </Box>
    </Box>
  )
}

/**
 * The control that mentions the focused row, else the previewed file, at the
 * prompt: in the header, and in an inline file view's row, which stands in
 * for the header.
 */
function mentionControlOf(kit: Kit): ActionControl {
  return { key: KEYS.mention, hotkey: 'a', label: 'mention', onPress: kit.actions.mention }
}

/**
 * The header: the project's name, then the tree's controls, as many labelled
 * as the width leaves the name its floor (`e c r f a h` in the order the help
 * lists them).
 */
function headerRow(kit: Kit, model: PaneModel): Fitted {
  const { Box, Text } = kit.ui

  const controls: readonly ActionControl[] = [
    { key: KEYS.expandLevel, hotkey: 'e', label: 'expand', onPress: kit.actions.expandLevel },
    { key: KEYS.collapseLevel, hotkey: 'c', label: 'collapse', onPress: kit.actions.collapseLevel },
    { key: KEYS.refresh, hotkey: 'r', label: 'refresh', onPress: kit.actions.refresh },
    {
      key: KEYS.filter,
      hotkey: 'f',
      label: model.filter === null ? 'filter' : 'clear',
      onPress: kit.actions.toggleFilter,
    },
    mentionControlOf(kit),
    { key: KEYS.help, hotkey: 'h', label: model.helpShown ? 'back' : 'help', onPress: kit.actions.toggleHelp },
  ]

  const { legend, room } = fitRow(kit.columns, legendsOf(controls), Limits.NAME_FLOOR_CELLS)

  return {
    row: (
      <Box flexDirection="row" height={1} columnGap={1}>
        <Text bold wrap="truncate-middle">
          {truncateMiddle(sanitize(model.rootName), room)}
        </Text>
        <Box flexGrow={1} />
        {legendItems(kit, legend, controls)}
      </Box>
    ),
    hidden: notLabelledIn(controls, legend),
  }
}

const FILTER_LABEL = 'filter'

/**
 * The cells the filter's field keeps to type in beside its label before
 * what it found gives way.
 */
const FILTER_FIELD_FLOOR = 8

/**
 * The filter's row: its field, then what the query found while the field
 * keeps its floor beside it.
 *
 * The field sits in a box exactly as wide as its share of the row, clipped:
 * there Claude Code fits the field to the box, cutting a long query, where
 * a field left to its natural width wraps a long query over the rows below
 * (checked on 2.1.294). While the field has the keyboard, Claude Code draws
 * what Enter does beside it: `go`, or `close` with nothing typed.
 */
function filterRow(kit: Kit, filter: FilterModel): RenderElement {
  const { Box, Text, Input } = kit.ui
  const statusCells = cellWidth(filter.status)
  const floor = cellWidth(`${FILTER_LABEL}: `) + FILTER_FIELD_FLOOR
  const showsStatus = statusCells > 0 && kit.columns - statusCells - 1 >= floor
  const fieldCells = showsStatus ? kit.columns - statusCells - 1 : kit.columns

  return (
    <Box flexDirection="row" height={1} columnGap={1}>
      <Box width={fieldCells} height={1} overflow="hidden" flexShrink={0}>
        <Input
          key={filter.key}
          label={FILTER_LABEL}
          placeholder="type a name"
          value={filter.value}
          submitLabel={filter.isBlank ? 'close' : 'go'}
          onInput={kit.actions.typeFilter}
          onSubmit={kit.actions.submitFilter}
        />
      </Box>
      {showsStatus && (
        <Text dimColor wrap="truncate-end">
          {filter.status}
        </Text>
      )}
    </Box>
  )
}

function treeRegion(kit: Kit, model: PaneModel): RenderElement {
  const { Box, Text } = kit.ui
  const { window, rows, layout } = model

  // The row the ring starts on: the one `a` mentioned, which the ring
  // left for the prompt; the revealed one; else in an inline pane's tree
  // the picked file's, so stepping back from the file lands on it
  const landing =
    model.mentioned ?? model.revealed ?? (model.inlineView === 'tree' ? model.selected : null)

  return (
    <Box flexDirection="column" height={layout.treeRows} overflow="hidden">
      {window.above > 0 && (
        <Text dimColor wrap="truncate-end">
          {truncateEnd(`↑ ${window.above} more`, kit.columns)}
        </Text>
      )}
      {rows
        .slice(window.start, window.end)
        .map(row => treeRow(kit, row, model.marks, model.selected, landing))}
      {window.below > 0 && (
        <Text dimColor wrap="truncate-end">
          {truncateEnd(`↓ ${window.below} more`, kit.columns)}
        </Text>
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
 * The cells the markers take at the end of every row of a tree that has
 * any: a gap, then a cell for Claude's writes and a cell for git, each
 * where some row has one, so the markers of all rows line up.
 */
function markCellsOf(marks: TreeMarks): number {
  const columns = (marks.hasWritten ? 1 : 0) + (marks.hasGit ? 1 : 0)

  return columns === 0 ? 0 : columns + 1
}

/**
 * The cells a row's Button keeps at least: its glyph, a gap and a cell of
 * its name. A row narrower than that with its markers draws none.
 */
const MIN_BUTTON_CELLS = 3

/**
 * A marked row's markers, after the gap that sets them off from its name;
 * a column the row has no marker in is blank, so the next one lines up.
 */
function markTexts(kit: Kit, mark: RowMark, marks: TreeMarks): RenderElement[] {
  const { Text } = kit.ui
  const blank = { glyph: ' ', tone: { dimColor: true } as Tone }

  const cells = [
    ...(marks.hasWritten ? [mark.isWritten ? { glyph: WRITTEN_GLYPH, tone: WRITTEN_TONE } : blank] : []),
    ...(marks.hasGit ? [mark.git === null ? blank : { glyph: mark.git.glyph, tone: GIT_TONES[mark.git.state] }] : []),
  ]

  return cells.map((cell, at) => (
    <Text {...cell.tone} wrap="truncate-start">
      {at === 0 ? ` ${cell.glyph}` : cell.glyph}
    </Text>
  ))
}

/**
 * One row of the tree: its branch lines, dim, then the row itself, then
 * its markers. An entry is a Button padded to the markers, or to the row's
 * end when it has none, so the name and the rest of the row press it; the
 * branch lines and the markers are drawing only. Names stop short of the
 * markers' cells in every row of a tree that has them. The `landing` row
 * takes the focus ring as the pane takes the keyboard.
 */
function treeRow(
  kit: Kit,
  row: TreeRow,
  marks: TreeMarks,
  selected: string | null,
  landing: string | null,
): RenderElement {
  const { Box, Text, Button } = kit.ui
  const markCells = markCellsOf(marks)
  const branch = branchOf(row, kit.columns - markCells)
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
  const mark = marks.byPath.get(row.path)
  const cells = room - markCells >= MIN_BUTTON_CELLS ? markCells : 0
  const name = truncateMiddle(sanitize(row.name), Math.max(1, room - cells - cellWidth(lead)))
  const label = padEnd(`${lead}${name}`, mark === undefined || cells === 0 ? room : room - cells)

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
        {...(row.path === landing ? { autoFocus: true } : {})}
      />
      {mark !== undefined && cells > 0 && markTexts(kit, mark, marks)}
    </Box>
  )
}

/**
 * The rule that sets the preview off from the tree, carrying the file's
 * name, drawn to exactly the row's width: `── README.md ──────`.
 */
function previewTitleRow(kit: Kit, selected: string): RenderElement {
  const { Box, Text } = kit.ui
  const name = truncateMiddle(sanitize(nameOf(selected)), Math.max(1, kit.columns - 5))
  const rule = Math.max(0, kit.columns - 4 - cellWidth(name))

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor>{'── '}</Text>
      <Text bold wrap="truncate-middle">
        {name}
      </Text>
      <Text dimColor wrap="truncate-end">{` ${'─'.repeat(rule)}`}</Text>
    </Box>
  )
}

/**
 * An inline pane's file view starts with one row: the file's name set in a
 * rule, then its controls, as many labelled as the width leaves the name its
 * floor; `a` mentions the file, `x` steps back to the tree.
 */
function inlineFileHeadRow(kit: Kit, model: PaneModel, selected: string): Fitted {
  const { Box, Text } = kit.ui
  const controls = previewControlsOf(kit, model, { closeLabel: 'back', hasMention: true })

  // The two rules take two cells each, set off from the name by the gap
  const { legend, room } = fitRow(kit.columns, legendsOf(controls), Limits.NAME_FLOOR_CELLS, {
    fixedCells: 4,
    children: 3,
  })

  return {
    row: (
      <Box flexDirection="row" height={1} columnGap={1}>
        <Text dimColor>{'──'}</Text>
        <Text bold wrap="truncate-middle">
          {truncateMiddle(sanitize(nameOf(selected)), room)}
        </Text>
        <Text dimColor>{'──'}</Text>
        <Box flexGrow={1} />
        {legendItems(kit, legend, controls)}
      </Box>
    ),
    hidden: notLabelledIn(controls, legend),
  }
}

/**
 * The previewed file's facts for its meta row, richest first, down to its
 * size alone: the row draws the richest that fits.
 */
function metaTextsOf(preview: Preview | null, markdownMode: MarkdownMode): string[] {
  if (preview === null) {
    return ['']
  }

  const size = formatBytes(preview.size)

  switch (preview.kind) {
    case 'markdown': {
      const lines = `${size} · ${plural(preview.lines.length, 'line')}`

      return [`${lines} · ${markdownMode}`, lines, size]
    }
    case 'code':
      return [`${size} · ${plural(preview.lines.length, 'line')}`, size]
    case 'table':
      return [`${size} · ${plural(lengthOf(preview), 'row')}`, size]
    case 'notice':
      return [preview.size > 0 ? size : '']
  }
}

/**
 * The previewed file's controls: scroll it (when it has lines), switch a
 * Markdown file's form, mention it where no header carries `a`, and close
 * it, `x` labelled for where it leads.
 */
function previewControlsOf(
  kit: Kit,
  model: PaneModel,
  { closeLabel, hasMention }: { readonly closeLabel: string; readonly hasMention: boolean },
): readonly ActionControl[] {
  const { preview, markdownMode } = model
  const isScrollable = preview !== null && lengthOf(preview) > 0
  const isMarkdown = preview?.kind === 'markdown'

  return [
    ...(isScrollable
      ? [
          { key: KEYS.previewUp, hotkey: 'w', label: '↑', onPress: () => kit.actions.scrollPreview(-1) },
          { key: KEYS.previewDown, hotkey: 's', label: '↓', onPress: () => kit.actions.scrollPreview(1) },
        ]
      : []),
    ...(isMarkdown
      ? [
          {
            key: KEYS.previewMode,
            hotkey: 'm',
            label: markdownMode === 'rendered' ? 'source' : 'rendered',
            onPress: kit.actions.toggleMarkdownMode,
          },
        ]
      : []),
    ...(hasMention ? [mentionControlOf(kit)] : []),
    { key: KEYS.previewClose, hotkey: 'x', label: closeLabel, onPress: kit.actions.closePreview },
  ]
}

/**
 * The row under the title rule: the file's facts, as rich as fits beside
 * its controls, which keep the room for its size at least.
 */
function previewMetaRow(kit: Kit, model: PaneModel): Fitted {
  const { Box, Text } = kit.ui
  const controls = previewControlsOf(kit, model, { closeLabel: 'close', hasMention: false })
  const facts = metaTextsOf(model.preview, model.markdownMode)
  const { legend, room } = fitRow(kit.columns, legendsOf(controls), cellWidth(facts.at(-1) ?? ''))

  return {
    row: (
      <Box flexDirection="row" height={1} columnGap={1}>
        <Text dimColor wrap="truncate-end">
          {facts.find(text => cellWidth(text) <= room) ?? ''}
        </Text>
        <Box flexGrow={1} />
        {legendItems(kit, legend, controls)}
      </Box>
    ),
    hidden: notLabelledIn(controls, legend),
  }
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
