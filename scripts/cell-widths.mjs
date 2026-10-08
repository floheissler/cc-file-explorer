// Generates hooks/cell-widths.ts: the code point tables `cellWidth` in
// hooks/text.ts measures with, so the pane counts cells as Claude Code does.
//
// Claude Code measures text with Bun.stringWidth(text, { ambiguousIsNarrow:
// true }). The rules below mirror isZeroWidth(), widthClass() and isEmoji()
// of Bun's scripts/generate-stringwidth-tables.mjs at bun-v1.4.2 (MIT), line
// for line, over the same Unicode Character Database version. Re-run this
// script when Bun moves to a newer Unicode version, and update both versions.
//
// Usage: node scripts/cell-widths.mjs [--ucd <dir>]
//        Downloads the UCD files from unicode.org unless --ucd points at a
//        directory holding EastAsianWidth.txt, DerivedGeneralCategory.txt and
//        emoji-data.txt for UNICODE_VERSION.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UNICODE_VERSION = '17.0.0'
const BUN_VERSION = 'bun-v1.4.2'
const UCD_BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '../hooks/cell-widths.ts')

const args = process.argv.slice(2)
const ucdAt = args.indexOf('--ucd')

if (ucdAt !== -1 && !args[ucdAt + 1]) {
  throw new Error('--ucd needs a directory argument')
}

const ucdDir = ucdAt !== -1 ? args[ucdAt + 1] : null

async function loadUCD(remotePath) {
  const name = remotePath.split('/').pop()

  if (ucdDir) {
    return readFileSync(join(ucdDir, name), 'utf8')
  }

  const url = `${UCD_BASE}/${remotePath}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }

  return response.text()
}

// Parses `LO(..HI) ; VALUE # comment` lines whose VALUE `wanted` accepts
function parseUCDRanges(text, wanted) {
  const ranges = []

  for (const m of text.matchAll(/^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*(\w+)\s*#/gm)) {
    if (wanted(m[3])) {
      ranges.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)])
    }
  }

  return mergeRanges(ranges)
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0])

  const merged = []

  for (const [lo, hi] of ranges) {
    const last = merged[merged.length - 1]

    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi)
    } else {
      merged.push([lo, hi])
    }
  }

  return merged
}

function inRanges(cp, ranges) {
  let lo = 0
  let hi = ranges.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1

    if (ranges[mid][0] <= cp) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  return lo > 0 && cp <= ranges[lo - 1][1]
}

const eastAsianWidthText = await loadUCD('EastAsianWidth.txt')
const generalCategoryText = await loadUCD('extracted/DerivedGeneralCategory.txt')
const emojiDataText = await loadUCD('emoji/emoji-data.txt')

// East Asian Width W (wide) and F (fullwidth); A (ambiguous) is narrow here
const wideRanges = parseUCDRanges(eastAsianWidthText, type => type === 'W' || type === 'F')
// General_Category Mn (nonspacing mark) and Me (enclosing mark)
const markRanges = parseUCDRanges(generalCategoryText, gc => gc === 'Mn' || gc === 'Me')
// The Emoji binary property
const emojiRanges = parseUCDRanges(emojiDataText, property => property === 'Emoji')
// Emoji_Modifier_Base: the only code points a skin tone joins in Bun's
// grapheme breaking, which keeps UAX #29's older E_Base / E_Modifier rule
const modifierBaseRanges = parseUCDRanges(emojiDataText, property => property === 'Emoji_Modifier_Base')

// Guards against a UCD format change silently emptying a table
if (
  !inRanges(0x4e00, wideRanges) ||
  !inRanges(0x300, markRanges) ||
  !inRanges(0x1f600, emojiRanges) ||
  !inRanges(0x1f44d, modifierBaseRanges)
) {
  throw new Error('UCD parse sanity check failed')
}

// Bun's isZeroWidth(), as at BUN_VERSION
function isZeroWidth(cp) {
  if (cp <= 0x1f) return true
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0xad) return true
  if (inRanges(cp, markRanges)) return true
  if (cp >= 0x1160 && cp <= 0x11ff) return true
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true
  if (cp >= 0x200b && cp <= 0x200f) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  if (cp >= 0x2060 && cp <= 0x206f) return true
  if (cp === 0x61c) return true
  if (cp >= 0x1bca0 && cp <= 0x1bca3) return true
  if (cp >= 0x1d173 && cp <= 0x1d17a) return true
  if (cp >= 0x180b && cp <= 0x180f) return true
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true
  if (cp >= 0x20d0 && cp <= 0x20ff) return true
  if (cp === 0xfeff) return true
  if (cp >= 0xd800 && cp <= 0xdfff) return true
  if ((cp >= 0x600 && cp <= 0x605) || cp === 0x6dd || cp === 0x70f || cp === 0x8e2) return true

  if (cp >= 0x900 && cp <= 0xd4f) {
    const offset = cp & 0x7f

    if (offset <= 0x02) return true
    if (offset >= 0x3a && offset <= 0x4d && offset !== 0x3d) return true
    if (offset >= 0x51 && offset <= 0x57) return true
    if (offset >= 0x62 && offset <= 0x63) return true
  }

  if (cp >= 0xe0000 && cp <= 0xe007f) return true

  return false
}

// Bun's widthClass() with ambiguous as narrow: 0, 1 or 2 cells
function widthOf(cp) {
  if (isZeroWidth(cp)) return 0
  if (inRanges(cp, wideRanges)) return 2

  return 1
}

// Bun's isEmoji(): the Emoji property with its early-outs
function isEmoji(cp) {
  if (cp < 0x203c) return false
  if (cp >= 0x2c00 && cp < 0x1f000) return false
  if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d) return false

  return inRanges(cp, emojiRanges)
}

// Runs of code points a predicate holds for, as [first, last] pairs
function runsOf(holds) {
  const runs = []
  let start = -1

  for (let cp = 0; cp <= 0x110000; cp += 1) {
    const isIn = cp <= 0x10ffff && holds(cp)

    if (isIn && start < 0) {
      start = cp
    } else if (!isIn && start >= 0) {
      runs.push([start, cp - 1])
      start = -1
    }
  }

  return runs
}

const zero = runsOf(cp => widthOf(cp) === 0)
const wide = runsOf(cp => widthOf(cp) === 2)
const emoji = runsOf(isEmoji)
const modifierBase = modifierBaseRanges

const hex = cp => `0x${cp.toString(16)}`

function formatRuns(runs) {
  const lines = []

  for (let at = 0; at < runs.length; at += 6) {
    lines.push(
      `  ${runs
        .slice(at, at + 6)
        .map(([lo, hi]) => `${hex(lo)}, ${hex(hi)}`)
        .join(', ')},`,
    )
  }

  return lines.join('\n')
}

const output = `// Generated by scripts/cell-widths.mjs from the Unicode ${UNICODE_VERSION} Character
// Database, mirroring Bun's stringWidth tables at ${BUN_VERSION}. Do not edit;
// regenerate with \`node scripts/cell-widths.mjs\`.
//
// Each table is a flat list of [first, last] code point pairs, sorted and
// disjoint, for a binary search.

/**
 * The Unicode version the tables are built from: Bun's, under Claude Code.
 */
export const UNICODE_VERSION = '${UNICODE_VERSION}'

/**
 * Code points that take no cell: controls, combining and enclosing marks,
 * conjoining Hangul vowels and finals, invisible format characters.
 */
export const ZERO_WIDTH: readonly number[] = [
${formatRuns(zero)}
]

/**
 * Code points that take two cells: East Asian Wide and Fullwidth.
 */
export const WIDE: readonly number[] = [
${formatRuns(wide)}
]

/**
 * Code points with the Emoji property that can start an emoji cluster.
 */
export const EMOJI: readonly number[] = [
${formatRuns(emoji)}
]

/**
 * Emoji a skin tone joins (Emoji_Modifier_Base); after any other code point
 * a skin tone starts a character of its own.
 */
export const EMOJI_MODIFIER_BASE: readonly number[] = [
${formatRuns(modifierBase)}
]
`

writeFileSync(OUTPUT, output)

console.log(
  `Unicode ${UNICODE_VERSION}: ${zero.length} zero-width, ${wide.length} wide, ${emoji.length} emoji, ` +
    `${modifierBase.length} modifier-base ranges`,
)
