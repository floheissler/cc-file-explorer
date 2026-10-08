/**
 * How a Markdown file is previewed: formatted as Claude's replies are, or
 * as its source with syntax colors.
 */
export type MarkdownMode = 'rendered' | 'source'

declare module 'claude-code' {
  interface PluginState {
    'file-explorer': {
      /**
       * The folders open in the tree, as paths relative to the project root.
       */
      expanded: string[]
      /**
       * The file previewed under the tree, relative to the project root.
       */
      selected: string | null
      /**
       * The first tree row the tree's window shows.
       */
      treeTop: number
      /**
       * The first line (or table row) the preview's window shows.
       */
      previewTop: number
      /**
       * Whether the preview keeps its file as the focus ring moves: else,
       * docked, it shows each file the ring lands on. Closing the preview
       * lets go of the pin.
       */
      pinned: boolean
      markdownMode: MarkdownMode
      /**
       * Whether the help view stands in for the tree and the preview.
       */
      helpShown: boolean
      /**
       * The filter's query: null while the filter is not shown; a blank
       * query shows the whole tree under the filter's row.
       */
      filter: string | null
      /**
       * The files Claude wrote this session (Write, Edit, NotebookEdit), as
       * paths relative to the project root, the latest last.
       */
      written: string[]
    }
  }
}
