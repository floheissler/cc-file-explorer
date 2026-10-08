import type { Host } from './host'
import Limits from './limits'
import { absolutePath, depthOf, joinPath } from './paths'
import { isKnownBinary, noticeOf, previewOf, type Preview } from './preview'
import { formatBytes, messageOf } from './text'
import { compareEntries, type DirListing, type Entry } from './tree'

/**
 * The project's folders as read: the root they hang from, and each folder
 * read so far by its path.
 */
export type Listing = {
  readonly root: string
  readonly dirs: Map<string, DirListing>
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
  return { root: await host.root(), dirs: new Map() }
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
    const found = await host.list(absolutePath(listing.root, dir))

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
    const read = await Promise.all(batch.map(dir => readDir(host, listing, dir)))

    batch.forEach((dir, index) => {
      const found = read[index]

      if (found !== undefined) {
        listing.dirs.set(dir, found)
      }
    })
  }
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
 * @returns its preview
 */
export async function readPreview(
  host: Host,
  root: string,
  path: string,
): Promise<Preview> {
  const absolute = absolutePath(root, path)

  try {
    const stat = await host.stat(absolute)

    if (stat.kind !== 'file') {
      return noticeOf(path, stat.size, 'Not a regular file')
    }

    if (isKnownBinary(path)) {
      return noticeOf(path, stat.size, `Binary file · ${formatBytes(stat.size)}`)
    }

    if (stat.size > Limits.MAX_PREVIEW_BYTES) {
      return noticeOf(path, stat.size, `Too large to preview · ${formatBytes(stat.size)}`)
    }

    return previewOf(path, stat.size, await host.read(absolute))
  } catch (error) {
    return noticeOf(path, 0, `Can't read this file: ${messageOf(error)}`)
  }
}
