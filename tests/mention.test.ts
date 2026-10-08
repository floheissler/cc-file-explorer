import { describe, expect, test } from 'claude-code/testing'

import { insertionOf, mentionOf, mentionPathOf, mentionTargetOf, mentionToastOf } from '../hooks/mention'
import { flattenTree, type DirListing } from '../hooks/tree'

/**
 * The rows of a root holding `src/` (open, with `main.ts`) and `README.md`.
 */
const ROWS = flattenTree(
  dir =>
    (({
      '': {
        entries: [
          { name: 'src', path: 'src', kind: 'dir', size: 0 },
          { name: 'README.md', path: 'README.md', kind: 'file', size: 9 },
        ],
        truncated: 0,
      },
      src: { entries: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file', size: 9 }], truncated: 0 },
    }) as Record<string, DirListing>)[dir],
  new Set(['src']),
)

describe('mentionTargetOf', () => {
  test('takes the row the ring is on, a folder as a folder', async () => {
    expect(mentionTargetOf('row:src', ROWS, null)).toEqual({ key: 'src', isDir: true })
    expect(mentionTargetOf('row:src/main.ts', ROWS, 'README.md')).toEqual({ key: 'src/main.ts', isDir: false })
  })

  test('falls back to the previewed file off the rows', async () => {
    expect(mentionTargetOf('preview-close', ROWS, 'README.md')).toEqual({ key: 'README.md', isDir: false })
    expect(mentionTargetOf(undefined, ROWS, 'README.md')).toEqual({ key: 'README.md', isDir: false })
    expect(mentionTargetOf('row:src', null, 'README.md')).toEqual({ key: 'README.md', isDir: false })
    expect(mentionTargetOf('row:gone.txt', ROWS, 'README.md')).toEqual({ key: 'README.md', isDir: false })
  })

  test('has none without a row or a previewed file', async () => {
    expect(mentionTargetOf('help', ROWS, null)).toBeNull()
    expect(mentionTargetOf(undefined, null, null)).toBeNull()
  })
})

describe('mentionPathOf', () => {
  const file = (key: string) => ({ key, isDir: false })
  const dir = (key: string) => ({ key, isDir: true })

  test('spells the path from the working folder, as Claude Code resolves it', async () => {
    expect(mentionPathOf('/work', '/work', file('src/main.ts'))).toBe('src/main.ts')
    expect(mentionPathOf('/work', '/work/src', file('src/main.ts'))).toBe('main.ts')
    expect(mentionPathOf('/work', '/work/src', file('README.md'))).toBe('../README.md')
    expect(mentionPathOf('/work', '/work/', dir('src'))).toBe('src/')
    expect(mentionPathOf('/work', '/work/src', dir('src'))).toBe('./')
  })

  test('spells a Windows path with /, the root and the working folder compared case-blind', async () => {
    expect(mentionPathOf('C:\\Proj', 'c:\\proj\\src', file('src/main.ts'))).toBe('main.ts')
    expect(mentionPathOf('C:\\Proj', 'C:\\Proj', dir('src/lib'))).toBe('src/lib/')
  })

  test('gives an absolute path while the working folder lies outside the project', async () => {
    expect(mentionPathOf('/work', '/tmp', file('src/main.ts'))).toBe('/work/src/main.ts')
    expect(mentionPathOf('/work', '/tmp', dir('src'))).toBe('/work/src/')
    expect(mentionPathOf('C:\\Proj', 'D:\\', dir('src'))).toBe('C:\\Proj\\src\\')
  })

  test('keeps a name that starts with ~ or " from reading as the home folder or a quote', async () => {
    expect(mentionPathOf('/work', '/work', file('~notes.md'))).toBe('./~notes.md')
    expect(mentionPathOf('/work', '/work', file('"quoted".txt'))).toBe('./"quoted".txt')
    expect(mentionPathOf('/work', '/work', file('a/~b.md'))).toBe('a/~b.md')
  })
})

describe('mentionOf', () => {
  test('writes a plain path bare, a folder with its separator', async () => {
    expect(mentionOf('src/main.ts', false)).toEqual({ text: '@src/main.ts' })
    expect(mentionOf('src/', true)).toEqual({ text: '@src/' })
    expect(mentionOf('node_modules/@types/node/', true)).toEqual({ text: '@node_modules/@types/node/' })
    expect(mentionOf('日本語.md', false)).toEqual({ text: '@日本語.md' })
    expect(mentionOf('./"quoted".txt', false)).toEqual({ text: '@./"quoted".txt' })
  })

  test('quotes a path with whitespace', async () => {
    expect(mentionOf('with space.txt', false)).toEqual({ text: '@"with space.txt"' })
    expect(mentionOf('My Docs/', true)).toEqual({ text: '@"My Docs/"' })
    expect(mentionOf('C:\\Users\\Jo Ann\\a.ts', false)).toEqual({ text: '@"C:\\Users\\Jo Ann\\a.ts"' })
  })

  test('quotes a path a bare mention would cut short', async () => {
    // Claude Code drops what trails the last ASCII letter, digit or `_`
    expect(mentionOf('notes.txt~', false)).toEqual({ text: '@"notes.txt~"' })
    expect(mentionOf('ファイル', false)).toEqual({ text: '@"ファイル"' })
    expect(mentionOf('build-/', true)).toEqual({ text: '@"build-/"' })
    expect(mentionOf('./', true)).toEqual({ text: '@"./"' })
    expect(mentionOf('../', true)).toEqual({ text: '@"../"' })
  })

  test('has no mention for a path Claude Code would read as another', async () => {
    expect(mentionOf('issue#12.md', false)).toEqual({ problem: 'hash' })
    expect(mentionOf('c#/Program.cs', false)).toEqual({ problem: 'hash' })
    expect(mentionOf('a\nb.txt', false)).toEqual({ problem: 'control' })
    expect(mentionOf('a\u009bb.txt', false)).toEqual({ problem: 'control' })
    expect(mentionOf('say "hi" now.txt', false)).toEqual({ problem: 'quote' })
  })
})

describe('insertionOf', () => {
  test('sets the mention off from the words on either side', async () => {
    expect(insertionOf({ text: '', cursor: 0 }, '@a.ts')).toBe('@a.ts ')
    expect(insertionOf({ text: 'look at', cursor: 7 }, '@a.ts')).toBe(' @a.ts ')
    expect(insertionOf({ text: 'look at ', cursor: 8 }, '@a.ts')).toBe('@a.ts ')
    expect(insertionOf({ text: 'fix  please', cursor: 4 }, '@a.ts')).toBe('@a.ts')
    expect(insertionOf({ text: 'fixplease', cursor: 3 }, '@a.ts')).toBe(' @a.ts ')
    expect(insertionOf({ text: 'and\n', cursor: 4 }, '@a.ts')).toBe('@a.ts ')
  })
})

describe('mentionToastOf', () => {
  test('names the entry safely, by its name alone', async () => {
    expect(mentionToastOf('hash', 'docs/issue#1.md')).toBe(
      'Cannot mention issue#1.md: Claude Code reads a # in a mention as a line range',
    )
    expect(mentionToastOf('control', 'a\u001b[31mb')).toContain('a\u241b[31mb')
    expect(mentionToastOf('failed', 'a.ts', 'gone')).toBe('Could not mention a.ts: gone')
  })

  test('says what keeps the prompt box from taking the text', async () => {
    expect(mentionToastOf('dialog', 'a.ts')).toBe('A dialog holds the prompt: close it, then press a again')
    expect(mentionToastOf('no_composer', 'a.ts')).toBe('This session has no prompt box to mention a file in')
    expect(mentionToastOf('refused', 'a.ts')).toBe('The prompt box did not take the mention of a.ts')
  })
})
