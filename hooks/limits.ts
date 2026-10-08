/**
 * The sizes the pane draws and reads within.
 *
 * A pane draws the first 100,000 characters of a tree's texts and
 * `$.fs.read` stops at 4 MiB, so the preview reads and draws well inside
 * both and shows the rest as the person scrolls.
 */
const Limits = {
  /**
   * Lines one press of `j` or `k` moves the preview.
   */
  KEY_ROWS: 3,
  /**
   * The largest file the preview reads, in bytes.
   */
  MAX_PREVIEW_BYTES: 2 * 1024 * 1024,
  /**
   * Characters of preview text one drawing holds.
   */
  MAX_PREVIEW_CHARS: 40_000,
  /**
   * Characters kept of one line of a preview; the rest is cut with `…`.
   */
  MAX_LINE_CHARS: 1_000,
  /**
   * Terminal columns kept of one cell of a CSV or TSV preview.
   */
  MAX_CELL_COLUMNS: 32,
  /**
   * Rows of a CSV or TSV file the preview parses.
   */
  MAX_TABLE_ROWS: 100_000,
  /**
   * Entries the tree lists for one folder; a note counts the rest.
   */
  MAX_DIR_ENTRIES: 2_000,
  /**
   * Characters sniffed at a file's start to tell binary from text.
   */
  SNIFF_CHARS: 8_000,
  /**
   * The share of the body the tree keeps while a file is previewed.
   */
  TREE_SHARE: 0.4,
  MIN_TREE_ROWS: 4,
  MIN_PREVIEW_ROWS: 4,
  /**
   * Columns kept clear at the body's right edge.
   */
  RIGHT_PAD_COLUMNS: 1,
  /**
   * The cells a row's name keeps before its controls give up their labels.
   */
  NAME_FLOOR_CELLS: 8,
  /**
   * The cells the source preview's gutter takes beyond its line numbers'
   * digits: one before the right-aligned numbers and one after (checked on
   * Claude Code 2.1.294).
   */
  CODE_GUTTER_PAD: 2,
  /**
   * The body rows an inline pane asks for: as tall as its content, up to
   * this, so a long tree leaves some of the conversation in view.
   */
  INLINE_ROWS: 40,
  /**
   * The terminal width from which Claude Code's fullscreen layout docks a
   * pane beside the conversation; narrower, it seats the pane inline.
   */
  DOCK_MIN_COLUMNS: 110,
  /**
   * The quiet time after Claude's last edit or command before an open pane
   * re-reads the tree.
   */
  REFRESH_DEBOUNCE_MS: 300,
  /**
   * How often an open, shown pane polls the folders it shows and the
   * previewed file for changes made outside Claude.
   */
  POLL_MS: 2_000,
  /**
   * Folders one poll stats at most, the root included; past it the open
   * folders take turns.
   */
  MAX_POLL_STATS: 64,
  /**
   * Changed folders one poll lists again at most; the rest wait for the
   * next poll.
   */
  MAX_POLL_RELISTS: 8,
  /**
   * Folders read at once, so a level opened in a large repository does not
   * list hundreds of folders in one go.
   */
  READ_CONCURRENCY: 8,
  /**
   * Folders one press of `e` or a digit opens at most; past it the press
   * stops and says so.
   */
  MAX_LEVEL_FOLDERS: 200,
  /**
   * The quiet time after the last keystroke in the filter before the tree
   * narrows to it.
   */
  FILTER_DEBOUNCE_MS: 150,
  /**
   * Matches a filtered tree shows at most; the filter's row counts the rest.
   */
  MAX_FILTER_MATCHES: 500,
  /**
   * How long one git call may run (the filter's file list, the markers'
   * status) before it is dropped: the filter walks the folders instead, and
   * the tree draws no git markers.
   */
  GIT_TIMEOUT_MS: 10_000,
  /**
   * Folders the filter reads at most outside a git work tree, shallowest
   * first, and the entries it collects at most.
   */
  MAX_WALK_FOLDERS: 1_000,
  MAX_WALK_ENTRIES: 100_000,
  /**
   * Files Claude wrote this session that the tree marks; past it the
   * earliest are forgotten.
   */
  MAX_WRITTEN_FILES: 1_000,
} as const

export default Limits
