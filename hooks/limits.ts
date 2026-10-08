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
   * Characters kept of one cell of a CSV or TSV preview.
   */
  MAX_CELL_CHARS: 32,
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
   * The quiet time after Claude's last edit or command before an open pane
   * re-reads the tree.
   */
  REFRESH_DEBOUNCE_MS: 300,
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
} as const

export default Limits
