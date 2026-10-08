import type { MarkdownMode } from '../types'
import type { Host } from './host'
import Limits from './limits'
import { SAVED_KEY_PREFIX } from './names'
import { depthOf, keyOf, nativePathOf, rootIdOf } from './paths'

/**
 * Each project's view of the pane, kept in the store between sessions, so a
 * session's pane opens where the project's last one left it: the open
 * folders, and the file the preview showed, its pin and its Markdown mode.
 *
 * Every session on the machine shares the store, and a `get` then a `set`
 * there is not atomic. So each project has a key of its own: sessions in
 * different projects never write over each other, and of two sessions in
 * one project the later change wins, as its view is the newer one.
 */

/**
 * The view a project keeps: its open folders as tree keys; the file the
 * preview shows, null while it is closed; whether the preview is pinned to
 * that file; how the preview shows Markdown.
 */
export type SavedView = {
  readonly expanded: readonly string[]
  readonly selected: string | null
  readonly pinned: boolean
  readonly markdownMode: MarkdownMode
}

/**
 * What the store keeps under a project's key: its view, and when it was
 * saved, by which the project saved longest ago is the first dropped.
 */
export type SavedRecord = SavedView & {
  readonly savedAt: number
}

/**
 * A project's saved view by store key, as the drop reads them.
 */
export type SavedStamp = {
  readonly key: string
  readonly savedAt: number
}

/**
 * The store key of a project's view, one for every spelling of its root.
 *
 * @param root the session's project root, native
 * @returns the key
 */
export function savedKeyOf(root: string): string {
  return `${SAVED_KEY_PREFIX}${rootIdOf(root)}`
}

/**
 * Whether a stored value can be an entry's key: `/`-separated names, none
 * empty, `.` or `..`. Anything else names no row of the tree.
 */
function isEntryKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

/**
 * Whether a stored value can be the key of a file under the root: an
 * entry's key that names the same entry once joined to the root, so none
 * that leads out of it, as `..\` under Windows would. The preview reads
 * the file the key names; a folder's key only opens a row the tree lists.
 */
function isKeyUnder(root: string, value: unknown): value is string {
  return isEntryKey(value) && keyOf(root, nativePathOf(root, value)) === value
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
 * The previewed file and the open folders within `MAX_SAVED_CHARS` of JSON:
 * the file first, as one key that shows whole, then the shallowest folders.
 *
 * @param expanded the open folders, each an entry's key
 * @param selected the previewed file, an entry's key, or null
 * @returns what is kept of both
 */
function budgetedOf(
  expanded: readonly string[],
  selected: string | null,
): Pick<SavedView, 'expanded' | 'selected'> {
  const fileChars = selected === null ? 0 : JSON.stringify(selected).length
  const kept = fileChars <= Limits.MAX_SAVED_CHARS ? selected : null

  return {
    expanded: cappedFolders(expanded, Limits.MAX_SAVED_CHARS - (kept === null ? 0 : fileChars)),
    selected: kept,
  }
}

/**
 * The record the store keeps for a project's view. A pin outlives no
 * preview, as closing the preview lets go of it.
 *
 * @param view the pane's view
 * @param savedAt when, in milliseconds since the epoch
 * @returns the record, its folders and file within `MAX_SAVED_CHARS`
 */
export function savedRecordOf(view: SavedView, savedAt: number): SavedRecord {
  const { expanded, selected } = budgetedOf(
    view.expanded.filter(isEntryKey),
    isEntryKey(view.selected) ? view.selected : null,
  )

  return {
    expanded,
    selected,
    pinned: selected !== null && view.pinned,
    markdownMode: view.markdownMode,
    savedAt,
  }
}

/**
 * The view a stored value holds. An older version of the mod, a person or
 * another tool may have written the store's file: a value not shaped as a
 * record holds none, entries that cannot be folder keys are left out, a
 * file that cannot be one under the root is not previewed, and what an
 * older record does not say stands at its default (no preview, unpinned,
 * Markdown rendered).
 *
 * @param value what the store holds under a project's key
 * @param root the session's project root, native
 * @returns the view, or null when the value holds none
 */
export function savedViewIn(value: unknown, root: string): SavedView | null {
  if (!isObject(value) || !Array.isArray(value.expanded)) {
    return null
  }

  const { expanded, selected } = budgetedOf(
    value.expanded.filter(isEntryKey),
    isKeyUnder(root, value.selected) ? value.selected : null,
  )

  return {
    expanded,
    selected,
    pinned: selected !== null && value.pinned === true,
    markdownMode: value.markdownMode === 'source' ? 'source' : 'rendered',
  }
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
 * The view saved for the session's project. A file no longer there, or no
 * longer a file, is not previewed: its pin goes with it.
 *
 * @param host the engine's calls
 * @returns the view, or null when none is saved
 */
export async function loadView(host: Host): Promise<SavedView | null> {
  const root = await host.root()
  const view = savedViewIn(await host.store.get(savedKeyOf(root)), root)

  if (view === null || view.selected === null) {
    return view
  }

  const isFile = await host.stat(nativePathOf(root, view.selected)).then(
    stat => stat.kind === 'file',
    () => false,
  )

  return isFile ? view : { ...view, selected: null, pinned: false }
}

/**
 * Saves the pane's view, as the session state holds it now, for the
 * session's project, then drops the projects saved longest ago past
 * `MAX_SAVED_PROJECTS`.
 *
 * Each project's own key keeps sessions in other projects from writing over
 * it. A drop can still race a session saving the dropped project at that
 * moment: that project's view is lost, nothing else.
 *
 * @param host the engine's calls
 * @param savedAt when, in milliseconds since the epoch
 */
export async function saveView(host: Host, savedAt: number): Promise<void> {
  const [root, expanded, selected, pinned, markdownMode] = await Promise.all([
    host.root(),
    host.state.expanded.get(),
    host.state.selected.get(),
    host.state.pinned.get(),
    host.state.markdownMode.get(),
  ])

  const key = savedKeyOf(root)

  await host.store.set(key, savedRecordOf({ expanded, selected, pinned, markdownMode }, savedAt))

  const others = (await host.store.keys()).filter(
    other => other.startsWith(SAVED_KEY_PREFIX) && other !== key,
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
