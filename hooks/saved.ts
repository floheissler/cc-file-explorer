import type { Host } from './host'
import Limits from './limits'
import { EXPANDED_KEY_PREFIX } from './names'
import { depthOf, rootIdOf } from './paths'

/**
 * Each project's open folders, kept in the store between sessions, so a
 * session's tree opens where the project's last one left it.
 *
 * Every session on the machine shares the store, and a `get` then a `set`
 * there is not atomic. So each project has a key of its own: sessions in
 * different projects never write over each other, and of two sessions in
 * one project the later change wins, as its view is the newer one.
 */

/**
 * What the store keeps under a project's key: its open folders as tree keys,
 * and when they were saved, by which the project saved longest ago is the
 * first dropped.
 */
export type SavedFolders = {
  readonly expanded: readonly string[]
  readonly savedAt: number
}

/**
 * A project's saved folders by store key, as the drop reads them.
 */
export type SavedStamp = {
  readonly key: string
  readonly savedAt: number
}

/**
 * The store key of a project's open folders, one for every spelling of its
 * root.
 *
 * @param root the session's project root, native
 * @returns the key
 */
export function savedKeyOf(root: string): string {
  return `${EXPANDED_KEY_PREFIX}${rootIdOf(root)}`
}

/**
 * Whether a stored value can be a folder's key: `/`-separated names, none
 * empty, `.` or `..`. Anything else names no row of the tree.
 */
function isFolderKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The open folders within a budget of JSON characters, each once and in the
 * order given. The shallowest are kept first, as a folder's row shows only
 * under its open parent: every folder kept is as shallow as any dropped.
 *
 * @param expanded the open folders
 * @param maxChars the characters their JSON array may take
 * @returns the folders kept
 */
export function cappedFolders(expanded: readonly string[], maxChars: number): string[] {
  const unique = [...new Set(expanded)]

  const byDepth = unique
    .map((key, at) => ({ key, at, depth: depthOf(key) }))
    .sort((a, b) => a.depth - b.depth || a.at - b.at)

  const kept = new Set<string>()
  let chars = '[]'.length

  for (const { key } of byDepth) {
    // The key's JSON string and the comma before it
    chars += JSON.stringify(key).length + (kept.size > 0 ? 1 : 0)

    if (chars > maxChars) {
      break
    }

    kept.add(key)
  }

  return unique.filter(key => kept.has(key))
}

/**
 * The record the store keeps for a project's open folders.
 *
 * @param expanded the open folders
 * @param savedAt when, in milliseconds since the epoch
 * @returns the record, its folders within `MAX_SAVED_CHARS`
 */
export function savedRecordOf(expanded: readonly string[], savedAt: number): SavedFolders {
  return { expanded: cappedFolders(expanded.filter(isFolderKey), Limits.MAX_SAVED_CHARS), savedAt }
}

/**
 * The open folders a stored value holds. An older version of the mod, a
 * person or another tool may have written the store's file: a value not
 * shaped as a record holds none, and entries that cannot be folder keys
 * are left out.
 *
 * @param value what the store holds under a project's key
 * @returns the folders, or null when the value holds none
 */
export function savedFoldersIn(value: unknown): string[] | null {
  if (!isObject(value) || !Array.isArray(value.expanded)) {
    return null
  }

  return cappedFolders(value.expanded.filter(isFolderKey), Limits.MAX_SAVED_CHARS)
}

/**
 * When a stored value was saved, or minus infinity when it does not say,
 * so a value that cannot be read is the first dropped.
 *
 * @param value what the store holds under a project's key
 * @returns milliseconds since the epoch
 */
export function savedAtIn(value: unknown): number {
  return isObject(value) && typeof value.savedAt === 'number' && Number.isFinite(value.savedAt)
    ? value.savedAt
    : Number.NEGATIVE_INFINITY
}

/**
 * The projects to drop so that at most `max` stay: those saved longest ago.
 *
 * @param saved the projects saved, by key
 * @param max how many may stay
 * @returns the keys to delete
 */
export function droppedKeysOf(saved: readonly SavedStamp[], max: number): string[] {
  const excess = saved.length - Math.max(0, max)

  if (excess <= 0) {
    return []
  }

  return [...saved]
    .sort((a, b) => a.savedAt - b.savedAt || 0)
    .slice(0, excess)
    .map(stamp => stamp.key)
}

/**
 * The open folders saved for the session's project.
 *
 * @param host the engine's calls
 * @returns the folders, or null when none are saved
 */
export async function loadFolders(host: Host): Promise<string[] | null> {
  return savedFoldersIn(await host.store.get(savedKeyOf(await host.root())))
}

/**
 * Saves the open folders for the session's project, then drops the projects
 * saved longest ago past `MAX_SAVED_PROJECTS`.
 *
 * Each project's own key keeps sessions in other projects from writing over
 * it. A drop can still race a session saving the dropped project at that
 * moment: that project's folders are lost, nothing else.
 *
 * @param host the engine's calls
 * @param expanded the open folders
 * @param savedAt when, in milliseconds since the epoch
 */
export async function saveFolders(
  host: Host,
  expanded: readonly string[],
  savedAt: number,
): Promise<void> {
  const key = savedKeyOf(await host.root())

  await host.store.set(key, savedRecordOf(expanded, savedAt))

  const others = (await host.store.keys()).filter(
    other => other.startsWith(EXPANDED_KEY_PREFIX) && other !== key,
  )

  if (others.length < Limits.MAX_SAVED_PROJECTS) {
    return
  }

  const saved = await Promise.all(
    others.map(async other => ({ key: other, savedAt: savedAtIn(await host.store.get(other)) })),
  )

  for (const dropped of droppedKeysOf(saved, Limits.MAX_SAVED_PROJECTS - 1)) {
    await host.store.delete(dropped)
  }
}
