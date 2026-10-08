/**
 * Two kinds of path, and this module alone turns one into the other.
 *
 * A *key* names an entry of the tree: relative to the project root,
 * `/`-separated, each part spelled exactly as `$.fs.list` named the entry,
 * and `''` for the root itself. Keys are the tree's identity on every
 * platform: open folders, the previewed file, `row:<key>` Buttons.
 *
 * A *native* path is what the engine takes and gives: the session root and
 * every path handed to `$.fs`, `C:\proj\src` under Windows and
 * `/home/me/proj/src` elsewhere.
 */

/**
 * How a root spells paths: `win32` for a drive (`C:\`, `C:/`) or a
 * backslash network or device spelling (`\\server\share`), else `posix`.
 * Read off the spelling, as the engine offers no platform call. A backslash
 * further in (`/home/we\ird`) is part of a Linux name.
 */
export type PathStyle = 'win32' | 'posix'

/**
 * The style a root spells paths in.
 *
 * @param root the session's project root, native
 * @returns `win32` or `posix`
 */
export function styleOf(root: string): PathStyle {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? 'win32' : 'posix'
}

/**
 * The root as `$.fs` is handed it: no trailing separator, but the one that
 * makes a drive or the file system root a root (`C:` alone is the drive's
 * current folder, `''` the session's), and without a `\\?\` prefix, which
 * `$.fs` refuses as a network location.
 *
 * @param root the session's project root, native
 * @returns the root, ready to join keys to
 */
export function rootOf(root: string): string {
  if (styleOf(root) === 'posix') {
    return root.replace(/\/+$/, '') || '/'
  }

  const plain = root.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:)/, '')
  const bare = plain.replace(/[\\/]+$/, '')

  return /^[A-Za-z]:$/.test(bare) ? `${bare}\\` : bare
}

/**
 * The native path of a key, joined with the root's own separator.
 *
 * @param root the session's project root, native
 * @param key a path in the tree
 * @returns the path to hand `$.fs`
 */
export function nativePathOf(root: string, key: string): string {
  const base = rootOf(root)

  if (key === '') {
    return base
  }

  if (styleOf(base) === 'posix') {
    return base.endsWith('/') ? `${base}${key}` : `${base}/${key}`
  }

  // A Windows name holds no `/` or `\`, so every `/` of a key separates
  const rest = key.replaceAll('/', '\\')

  return base.endsWith('\\') ? `${base}${rest}` : `${base}\\${rest}`
}

/**
 * The root's name for the header: its last folder, or the whole root when it
 * is a drive (`C:\`), a share (`\\server\share`) or `/`.
 *
 * @param root the session's project root, native
 * @returns the name
 */
export function rootLabelOf(root: string): string {
  const base = rootOf(root)

  if (styleOf(base) === 'posix') {
    return base.split('/').filter(part => part !== '').at(-1) ?? '/'
  }

  const parts = base.split(/[\\/]+/).filter(part => part !== '')
  const rootParts = base.startsWith('\\\\') ? 2 : 1

  return parts.length > rootParts ? (parts.at(-1) ?? base) : base
}

/**
 * The key of a folder's entry.
 *
 * @param dir the folder's key
 * @param name the entry's name
 * @returns the entry's key
 */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * The last part of a key: the entry's own name. Keys split on `/` alone, so
 * a backslash in a Linux name stays in it.
 *
 * @param key a key
 * @returns the entry's name
 */
export function nameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

/**
 * A file's extension, lowercase and without its dot.
 *
 * @param key a key
 * @returns the extension, or `''` for none (a dotfile such as `.env` has none)
 */
export function extensionOf(key: string): string {
  const name = nameOf(key).toLowerCase()
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? '' : name.slice(dot + 1)
}

/**
 * How deep a key sits: 0 for an entry of the root.
 *
 * @param key a key
 * @returns the number of folders above it
 */
export function depthOf(key: string): number {
  return key === '' ? -1 : key.split('/').length - 1
}

/**
 * The folder that holds a key.
 *
 * @param key a key
 * @returns its folder's key, `''` for an entry of the root
 */
export function parentOf(key: string): string {
  const cut = key.lastIndexOf('/')

  return cut < 0 ? '' : key.slice(0, cut)
}
