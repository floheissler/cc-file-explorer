import type { FsStat } from 'claude-code'

import type { Host } from './host'
import Limits from './limits'
import { depthOf, joinPath, nativePathOf } from './paths'
import { isKnownBinary, noticeOf, previewOf, type Preview } from './preview'
import { formatBytes, messageOf } from './text'
import { compareEntries, type DirListing, type Entry } from './tree'

/**
 * The project's folders as read: the root they hang from, each folder read
 * so far by its path, and the time each was modified when it was read.
 */
export type Listing = {
  readonly root: string
  readonly dirs: Map<string, DirListing>
  /**
   * Each read folder's modification time, taken just before it was listed,
   * so a change made while it was listed shows at the next check.
   */
  readonly stamps: Map<string, number>
}

/**
 * A previewed file as read, and its stamp: its modification time and size
 * when it was read, null where it could not be stat'ed.
 */
export type PreviewRead = {
  readonly preview: Preview
  readonly stamp: string | null
}

/**
 * The folder git keeps its repository in: never listed, as no explorer
 * lists it. Everything else is, git-ignored entries included.
 */
const GIT_DIR_NAME = '.git'

/**
 * Starts a listing at the session's project root, nothing read yet.
 *
 * @param host the engine's calls
 * @returns the listing
 */
export async function openListing(host: Host): Promise<Listing> {
  return { root: await host.root(), dirs: new Map(), stamps: new Map() }
}

/**
 * Reads one folder: its entries less `.git`, in tree order, up to the entry
 * cap.
 *
 * @param host the engine's calls
 * @param listing the listing the folder belongs to
 * @param dir the folder, relative to the root
 * @returns the folder's listing
 */
export async function readDir(
  host: Host,
  listing: Listing,
  dir: string,
): Promise<DirListing> {
  try {
    const found = await host.list(nativePathOf(listing.root, dir))

    const entries: Entry[] = found
      .filter(entry => entry.name !== GIT_DIR_NAME)
      .map(entry => ({
        name: entry.name,
        path: joinPath(dir, entry.name),
        kind: entry.kind,
        size: entry.size,
      }))
      .sort(compareEntries)

    return {
      entries: entries.slice(0, Limits.MAX_DIR_ENTRIES),
      truncated: Math.max(0, entries.length - Limits.MAX_DIR_ENTRIES),
    }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/**
 * Reads folders into a listing, `READ_CONCURRENCY` at a time.
 *
 * @param host the engine's calls
 * @param listing the listing to fill
 * @param dirs the folders, relative to the root
 */
export async function readDirs(
  host: Host,
  listing: Listing,
  dirs: readonly string[],
): Promise<void> {
  for (let at = 0; at < dirs.length; at += Limits.READ_CONCURRENCY) {
    const batch = dirs.slice(at, at + Limits.READ_CONCURRENCY)

    const read = await Promise.all(
      batch.map(async dir => {
        const stamp = await dirStampOf(host, listing, dir)

        return { stamp, found: await readDir(host, listing, dir) }
      }),
    )

    batch.forEach((dir, index) => {
      const done = read[index]

      if (done === undefined) {
        return
      }

      listing.dirs.set(dir, done.found)

      if (done.stamp === null) {
        listing.stamps.delete(dir)
      } else {
        listing.stamps.set(dir, done.stamp)
      }
    })
  }
}

/**
 * A folder's modification time, or null where it cannot be stat'ed. A
 * listing carries no folder's time (`FsEntry.mtimeMs` is 0 for folders), so
 * each folder takes a stat of its own.
 */
async function dirStampOf(host: Host, listing: Listing, dir: string): Promise<number | null> {
  return host.stat(nativePathOf(listing.root, dir)).then(
    stat => stat.mtimeMs,
    () => null,
  )
}

/**
 * Folders' modification times now, `READ_CONCURRENCY` at a time.
 *
 * @param host the engine's calls
 * @param listing the listing the folders belong to
 * @param dirs the folders, relative to the root
 * @returns each folder's time, null where it cannot be stat'ed
 */
export async function stampDirs(
  host: Host,
  listing: Listing,
  dirs: readonly string[],
): Promise<Map<string, number | null>> {
  const stamps = new Map<string, number | null>()

  for (let at = 0; at < dirs.length; at += Limits.READ_CONCURRENCY) {
    const batch = dirs.slice(at, at + Limits.READ_CONCURRENCY)
    const read = await Promise.all(batch.map(dir => dirStampOf(host, listing, dir)))

    batch.forEach((dir, index) => stamps.set(dir, read[index] ?? null))
  }

  return stamps
}

const stampOfStat = (stat: FsStat) => `${stat.mtimeMs}:${stat.size}`

/**
 * A file's stamp now: its modification time and size as one key.
 *
 * @param host the engine's calls
 * @param root the project root
 * @param path the file, relative to the root
 * @returns the stamp, or null where the file cannot be stat'ed
 */
export async function fileStampOf(host: Host, root: string, path: string): Promise<string | null> {
  return host.stat(nativePathOf(root, path)).then(stampOfStat, () => null)
}

/**
 * Reads the root and every open folder still in the tree, level by level, so
 * a folder that was removed or is now ignored is not read.
 *
 * @param host the engine's calls
 * @param listing the listing to fill
 * @param expanded the open folders
 */
export async function readTree(
  host: Host,
  listing: Listing,
  expanded: readonly string[],
): Promise<void> {
  await readDirs(host, listing, [''])

  const byDepth = new Map<number, string[]>()

  for (const dir of expanded) {
    const depth = depthOf(dir)

    byDepth.set(depth, [...(byDepth.get(depth) ?? []), dir])
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b)

  for (const depth of depths) {
    const reachable = (byDepth.get(depth) ?? []).filter(dir => isListedDir(listing, dir))

    await readDirs(host, listing, reachable)
  }
}

/**
 * Whether a folder appears in its parent's listing as a folder.
 */
function isListedDir(listing: Listing, dir: string): boolean {
  const cut = dir.lastIndexOf('/')
  const parent = listing.dirs.get(cut < 0 ? '' : dir.slice(0, cut))

  return (
    parent !== undefined &&
    'entries' in parent &&
    parent.entries.some(entry => entry.path === dir && entry.kind === 'dir')
  )
}

/**
 * Reads a file for the preview: binary files by extension, files past the
 * size cap and anything but a regular file get a notice instead.
 *
 * @param host the engine's calls
 * @param root the project root
 * @param path the file, relative to the root
 * @returns its preview, and its stamp from the stat taken before reading
 */
export async function readPreview(
  host: Host,
  root: string,
  path: string,
): Promise<PreviewRead> {
  const absolute = nativePathOf(root, path)
  let stamp: string | null = null

  try {
    const stat = await host.stat(absolute)

    stamp = stampOfStat(stat)

    if (stat.kind !== 'file') {
      return { preview: noticeOf(path, stat.size, 'Not a regular file'), stamp }
    }

    if (isKnownBinary(path)) {
      return { preview: noticeOf(path, stat.size, `Binary file · ${formatBytes(stat.size)}`), stamp }
    }

    if (stat.size > Limits.MAX_PREVIEW_BYTES) {
      return {
        preview: noticeOf(path, stat.size, `Too large to preview · ${formatBytes(stat.size)}`),
        stamp,
      }
    }

    return { preview: previewOf(path, stat.size, await host.read(absolute)), stamp }
  } catch (error) {
    return { preview: noticeOf(path, 0, `Can't read this file: ${messageOf(error)}`), stamp }
  }
}
