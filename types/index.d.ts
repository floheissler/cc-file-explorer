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
      markdownMode: MarkdownMode
    }
  }
}
