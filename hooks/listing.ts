import type { Host } from './host'
import Limits from './limits'
import { absolutePath, depthOf, joinPath } from './paths'
import { isKnownBinary, noticeOf, previewOf, type Preview } from './preview'
import { formatBytes, messageOf } from './text'
import { compareEntries, type DirListing, type Entry } from './tree'

/**
 * The project's folders as read: the root they hang from, whether git
 * decides what is ignored there, and each folder read so far by its path.
 */
export type Listing = {
  readonly root: string
  readonly isGitRepo: boolean
  readonly dirs: Map<string, DirListing>
}

/**
 * Set over the session's environment for every git call: a read never takes
 * the index lock a commit running beside it needs.
 */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

/**
 * The folder git keeps its repository in: never listed.
 */
const GIT_DIR_NAME = '.git'

/**
 * Starts a listing at the session's project root, nothing read yet.
 *
 * @param host the engine's calls
 * @returns the listing
 */
export async function openListing(host: Host): Promise<Listing> {
  const root = await host.root()

  return { root, isGitRepo: await isGitWorkTree(host, root), dirs: new Map() }
}

async function isGitWorkTree(host: Host, root: string): Promise<boolean> {
  try {
    const run = await host.run(['git', 'rev-parse', '--is-inside-work-tree'], {
      cwd: root,
      env: GIT_ENV,
      timeoutMs: Limits.GIT_TIMEOUT_MS,
    })

    return run.exitCode === 0 && run.stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * The paths among `paths` that git ignores. Tracked files are never
 * reported, as git treats them; where git cannot answer, none are.
 */
async function ignoredAmong(
  host: Host,
  root: string,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) {
    return new Set()
  }

  try {
    const run = await host.run(['git', 'check-ignore', '-z', '--stdin'], {
      cwd: root,
      env: GIT_ENV,
      stdin: `${paths.join('\0')}\0`,
      timeoutMs: Limits.GIT_TIMEOUT_MS,
    })

    // 0: some are ignored; 1: none are; anything else: git could not tell.
    return run.exitCode === 0
      ? new Set(run.stdout.split('\0').filter(path => path !== ''))
      : new Set()
  } catch {
    return new Set()
  }
}

/**
 * Reads one folder: its entries less `.git` and what git ignores, in tree
 * order, up to the entry cap.
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

    const ignored = listing.isGitRepo
      ? await ignoredAmong(host, listing.root, entries.map(entry => entry.path))
      : new Set<string>()

    const kept = entries.filter(entry => !ignored.has(entry.path)).sort(compareEntries)

    return {
      entries: kept.slice(0, Limits.MAX_DIR_ENTRIES),
      truncated: Math.max(0, kept.length - Limits.MAX_DIR_ENTRIES),
    }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

/**
 * Reads folders into a listing, all at once.
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
  const read = await Promise.all(dirs.map(dir => readDir(host, listing, dir)))

  dirs.forEach((dir, at) => {
    const found = read[at]

    if (found !== undefined) {
      listing.dirs.set(dir, found)
    }
  })
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
