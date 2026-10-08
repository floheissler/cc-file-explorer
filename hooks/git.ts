import type { ProcessRunResult } from 'claude-code'

import type { Host } from './host'
import Limits from './limits'
import { nativePathOf, styleOf } from './paths'
import { parsePorcelain, repoPlaceOf, statusOf, type GitStatus } from './status'

/**
 * Every git run the mod makes, through the engine's calls: the filter's file
 * list (`listing.ts`), and the markers' view of the tree, where the root
 * sits in its repository and the status of everything under it.
 */

/**
 * Set over the session's environment for every git run: a read never takes
 * a lock a commit running beside it needs (so a status never writes the
 * index), and git speaks plain C, whatever the person's language.
 */
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

/**
 * Runs git in the root, under `GIT_ENV` and `GIT_TIMEOUT_MS`.
 *
 * @param host the engine's calls
 * @param root the session's project root, native
 * @param args git's arguments, the command first
 * @returns what it wrote, or null where it exited otherwise than 0, could
 *   not start (no git) or ran out of time
 */
export async function runGit(host: Host, root: string, args: readonly string[]): Promise<ProcessRunResult | null> {
  try {
    const run = await host.run(['git', ...args], {
      cwd: nativePathOf(root, ''),
      env: { ...GIT_ENV },
      timeoutMs: Limits.GIT_TIMEOUT_MS,
    })

    return run.exitCode === 0 ? run : null
  } catch {
    return null
  }
}

/**
 * The status of everything under the root, once per file: untracked files
 * one by one (`??`), a folder git ignores whole as the folder alone
 * (`!! node_modules/`). Plain `--ignored` would list every file inside
 * an ignored folder with `--untracked-files=all`, tens of thousands of
 * lines for a real `node_modules`.
 */
const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', '.'] as const

const PLACE_ARGS = ['rev-parse', '--show-prefix', '--absolute-git-dir'] as const

/**
 * Git's view of the tree as read once, and what tells the next read due.
 */
export type GitRead = {
  /**
   * The session root it was read for, native.
   */
  readonly root: string
  readonly status: GitStatus
  /**
   * What `git status` wrote: two reads that wrote the same say the same.
   */
  readonly output: string
  /**
   * The repository's index and HEAD, native, and their stamps taken just
   * before the status ran: a commit, a stage or a checkout made outside
   * Claude moves them, so a poll that finds them moved reads git again.
   */
  readonly stamps: ReadonlyMap<string, string | null>
}

/**
 * The stamps of files by native path, each its modification time and size
 * as one key, as the previewed file's stamp is.
 *
 * @param host the engine's calls
 * @param paths the files
 * @returns each file's stamp, null where it cannot be stat'ed
 */
export async function stampsOf(host: Host, paths: readonly string[]): Promise<Map<string, string | null>> {
  const read = await Promise.all(
    paths.map(path =>
      host.stat(path).then(
        stat => `${stat.mtimeMs}:${stat.size}`,
        () => null,
      ),
    ),
  )

  return new Map(paths.map((path, at) => [path, read[at] ?? null]))
}

/**
 * Whether any stamp differs from the one taken before.
 *
 * @param then the stamps as taken before
 * @param now the same files' stamps now
 * @returns whether one moved
 */
export function hasStampMoved(
  then: ReadonlyMap<string, string | null>,
  now: ReadonlyMap<string, string | null>,
): boolean {
  return [...then].some(([path, stamp]) => now.get(path) !== stamp)
}

/**
 * Reads git's view of the tree: where the root sits in its repository
 * (`git rev-parse`), the stamps of the repository's index and HEAD, then
 * the status. Never rejects.
 *
 * Git paths are `/`-separated and relative to the repository's top on
 * every platform, even when git runs in a folder below it, so they are
 * read against the root's prefix (`statusOf`). Output cut at the engine's
 * 4 MiB shows the markers of what was read.
 *
 * @param host the engine's calls
 * @param root the session's project root, native
 * @returns the read, or null where the root is in no work tree, git is not
 *   installed, failed or took too long (a share git cannot open, `\\wsl.localhost\…`
 *   from Windows, a repository git holds unsafe)
 */
export async function readGitStatus(host: Host, root: string): Promise<GitRead | null> {
  const where = await runGit(host, root, PLACE_ARGS)
  const place = where === null ? null : repoPlaceOf(where.stdout)

  if (place === null) {
    return null
  }

  // Git for Windows spells the folder `C:/…`, which `$.fs` takes as it is
  const stamps = await stampsOf(host, ['index', 'HEAD'].map(name => nativePathOf(place.gitDir, name)))
  const listed = await runGit(host, root, STATUS_ARGS)

  if (listed === null) {
    return null
  }

  return {
    root,
    status: statusOf(parsePorcelain(listed.stdout), place.prefix, styleOf(root)),
    output: listed.stdout,
    stamps,
  }
}

/**
 * Whether two reads draw the same markers: none and none, or the same
 * status of the same root.
 *
 * @param a a read, or null for none
 * @param b another
 * @returns whether they say the same
 */
export function isSameRead(a: GitRead | null, b: GitRead | null): boolean {
  if (a === null || b === null) {
    return a === b
  }

  return a.root === b.root && a.output === b.output
}
