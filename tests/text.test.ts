import { describe, expect, test } from 'claude-code/testing'

import { cellWidth, clipChars, padEnd, sanitize, truncateEnd, truncateMiddle } from '../hooks/text'

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
const FLAG_JP = '\u{1F1EF}\u{1F1F5}'
const FLAG_FR = '\u{1F1EB}\u{1F1F7}'
const KEYCAP_HASH = '#️⃣'

describe('cellWidth', () => {
  // Each value is what Bun.stringWidth(text, { ambiguousIsNarrow: true })
  // returns: how Claude Code lays text out
  const widths: readonly (readonly [string, string, number])[] = [
    ['ASCII', 'README.md', 9],
    ['CJK', '日本語.md', 9],
    ['fullwidth', 'ｆｕｌｌ', 8],
    ['Hangul', '한국어', 6],
    ['decomposed Hangul', '한', 2],
    ['an emoji', '🚀launch.ts', 11],
    ['a text-style heart', '❤', 1],
    ['a heart with VS16', '❤️', 2],
    ['a wide emoji', '⚡', 2],
    ['a skin tone', '\u{1F44D}\u{1F3FD}', 2],
    ['a ZWJ family', FAMILY, 2],
    ['a flag', FLAG_JP, 2],
    ['a lone regional indicator', '\u{1F1EF}', 1],
    ['a keycap', KEYCAP_HASH, 2],
    ['a digit with VS16 alone', '0️', 1],
    ['a combining accent', 'café', 4],
    ['stacked marks', `x́̂̃`, 1],
    ['a zero-width space', '​', 0],
    ['a soft hyphen', '­', 0],
    ['ambiguous characters', '…─·', 3],
    ['a hexagram', '䷀', 2],
    ['a Hebrew point', '֑', 0],
    ['a Hangul vowel jamo alone', 'ᅡ', 0],
    ['a Devanagari syllable', 'क्', 1],
    ['a skin tone after a non-modifier emoji', '‼\u{1F3FD}', 3],
  ]

  for (const [what, text, cells] of widths) {
    test(`measures ${what}`, async () => {
      expect(cellWidth(text)).toBe(cells)
    })
  }
})

describe('truncateMiddle', () => {
  test('keeps the start and end of a long name', async () => {
    expect(truncateMiddle('a-very-long-file-name.ts', 10)).toBe('a-ver…e.ts')
  })

  test('cuts by cells, never across a wide character', async () => {
    expect(truncateMiddle('日本語のファイル名.md', 8)).toBe('日本….md')
    expect(truncateMiddle('ab日本語cd', 6)).toBe('ab…cd')
  })

  test('keeps text that fits, and gives one cell an ellipsis', async () => {
    expect(truncateMiddle('日本語.md', 9)).toBe('日本語.md')
    expect(truncateMiddle('日本語.md', 1)).toBe('…')
    expect(truncateMiddle('日本語.md', 0)).toBe('')
  })
})

describe('truncateEnd', () => {
  test('never splits a flag, a ZWJ sequence or a letter from its accent', async () => {
    expect(truncateEnd(`${FLAG_JP}${FLAG_FR}`, 3)).toBe(`${FLAG_JP}…`)
    expect(truncateEnd(`${FAMILY}abc`, 3)).toBe(`${FAMILY}…`)
    expect(truncateEnd('caféxyz', 5)).toBe('café…')
  })
})

describe('cuts and pads', () => {
  const samples = [
    'README.md',
    '日本語のファイル名.md',
    '🚀launch.ts',
    `${FAMILY}family.txt`,
    `${FLAG_JP}${FLAG_FR}flags`,
    `${KEYCAP_HASH}${KEYCAP_HASH}keys`,
    'café au lait.md',
    'ｆｕｌｌｗｉｄｔｈ.txt',
  ]

  test('fit every width they are given, and leave fitting text alone', async () => {
    for (const text of samples) {
      for (let cells = 0; cells <= 20; cells += 1) {
        expect(cellWidth(truncateEnd(text, cells))).toBeLessThanOrEqual(cells)
        expect(cellWidth(truncateMiddle(text, cells))).toBeLessThanOrEqual(cells)

        if (cellWidth(text) <= cells) {
          expect(truncateEnd(text, cells)).toBe(text)
          expect(truncateMiddle(text, cells)).toBe(text)
          expect(cellWidth(padEnd(text, cells))).toBe(cells)
        }
      }
    }
  })
})

describe('clipChars', () => {
  test('caps text in UTF-16 units without splitting a surrogate pair', async () => {
    expect(clipChars('abcdef', 6)).toBe('abcdef')
    expect(clipChars('abcdef', 4)).toBe('abc…')
    expect(clipChars('ab😀cd', 4)).toBe('ab…')
  })
})

describe('sanitize', () => {
  test('draws control characters as their Control Pictures', async () => {
    expect(sanitize('a\tb\nc\u001b[0m\u007f')).toBe('a␉b␊c␛[0m␡')
  })

  test('replaces C1 controls, bidirectional controls and lone surrogates', async () => {
    expect(sanitize('a\u0085b')).toBe('a�b')
    expect(sanitize('‮txt.exe')).toBe('�txt.exe')
    expect(sanitize('x\uD800y')).toBe('x�y')
    expect(sanitize('ok \u{1F680}')).toBe('ok \u{1F680}')
  })

  test('cuts a run of combining marks, so a stacked name cannot pass as one cell', async () => {
    const stacked = `e${'́'.repeat(2_000)}.txt`
    const kept = sanitize(stacked)

    expect(kept).toBe(`e${'́'.repeat(8)}.txt`)
    expect(truncateMiddle(kept, 4).length).toBeLessThan(20)
  })
})
