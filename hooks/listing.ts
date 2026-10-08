import type { FsStat } from 'claude-code'

import { gitFileListOf, type FileList, type FoundEntry } from './filter'
import { runGit } from './git'
import type { Host } from './host'
import Limits from './limits'
import { depthOf, joinPath, keyOf, nativePathOf, rootOf } from './paths'
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
 * The key of a path from outside the tree that its spelling does not place
 * under the root (`keyOf`): where it lands, every link followed, under where
 * the root lands, as `/tmp/p/x` lies under the root `/private/tmp/p`.
 *
 * @param host the engine's calls
 * @param root the project root
 * @param path the path, native
 * @returns its key, or null where either does not resolve or it lands
 *   outside the root
 */
export async function realKeyOf(host: Host, root: string, path: string): Promise<string | null> {
  const [realRoot, realPath] = await Promise.all([
    host.realPath(rootOf(root)).catch(() => undefined),
    host.realPath(path).catch(() => undefined),
  ])

  return realRoot === undefined || realPath === undefined ? null : keyOf(realRoot, realPath)
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

/**
 * Reads the project's files and folders for the filter: from git in a work
 * tree, which knows them all at once and what it ignores; elsewhere, or
 * where git cannot answer, from the folders themselves, within bounds.
 *
 * @param host the engine's calls
 * @param listing the listing the walk reads folders into
 * @returns the list
 */
export async function readFileList(host: Host, listing: Listing): Promise<FileList> {
  return (await gitFileList(host, listing.root)) ?? walkFileList(host, listing)
}

/**
 * The file list git gives for the root: its tracked files, the untracked
 * ones it does not ignore, and what it ignores, an ignored folder as itself
 * alone. Paths are relative to the root, as git lists from its working
 * directory, and `/`-separated on every platform.
 *
 * @returns the list, or null where git is missing, the root is no work
 *   tree, or git lists nothing (a root inside an ignored folder)
 */
async function gitFileList(host: Host, root: string): Promise<FileList | null> {
  const git = (args: readonly string[]) => runGit(host, root, args)

  const [listed, deleted, ignored] = await Promise.all([
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(['ls-files', '-z', '--deleted']),
    git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
  ])

  if (listed === null) {
    return null
  }

  const list = gitFileListOf({
    listed: listed.stdout,
    deleted: deleted?.stdout ?? null,
    ignored: ignored?.stdout ?? null,
    isTruncated: listed.isStdoutTruncated || ignored?.isStdoutTruncated === true,
  })

  return list.entries.length === 0 ? null : list
}

/**
 * The file list a walk of the folders gives, shallowest first, `.git` left
 * out, up to `MAX_WALK_FOLDERS` folders and `MAX_WALK_ENTRIES` entries.
 * Every folder is read anew, as one the tree read before may have changed
 * since, into the listing, so the filtered tree draws from them at once.
 */
async function walkFileList(host: Host, listing: Listing): Promise<FileList> {
  const entries: FoundEntry[] = []
  let level = ['']
  let folders = 0
  let isPartial = false

  while (level.length > 0) {
    const batch = level.slice(0, Math.max(0, Limits.MAX_WALK_FOLDERS - folders))

    isPartial ||= batch.length < level.length
    folders += batch.length
    await readDirs(host, listing, batch)

    const next: string[] = []

    for (const dir of batch) {
      const read = listing.dirs.get(dir)

      if (read === undefined || 'error' in read) {
        continue
      }

      isPartial ||= read.truncated > 0

      for (const entry of read.entries) {
        if (entries.length >= Limits.MAX_WALK_ENTRIES) {
          return { entries, isPartial: true }
        }

        entries.push({ path: entry.path, kind: entry.kind === 'dir' ? 'dir' : 'file' })

        if (entry.kind === 'dir') {
          next.push(entry.path)
        }
      }
    }

    level = next
  }

  return { entries, isPartial }
}
