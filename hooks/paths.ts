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

/**
 * The folders that hold a key, outermost first, the root left out.
 *
 * @param key a key
 * @returns their keys: `['a', 'a/b']` for `a/b/c.ts`
 */
export function ancestorsOf(key: string): string[] {
  const parts = key.split('/').slice(0, -1)

  return parts.map((_, at) => parts.slice(0, at + 1).join('/'))
}

/**
 * A key as the root's file system compares it: composed (NFC) everywhere,
 * as macOS and git there spell an accent either way, and lowercase too under
 * win32, whose names ignore case. Two spellings of one entry fold alike, so
 * a path another program spelled (git) finds the entry `$.fs.list` named.
 *
 * @param key a key
 * @param style the root's style
 * @returns the folded key, for comparing only: never a key itself
 */
export function foldKey(key: string, style: PathStyle): string {
  const composed = key.normalize('NFC')

  return style === 'win32' ? composed.toLowerCase() : composed
}

/**
 * Whether two keys name one entry, by `foldKey`.
 *
 * @param a a key
 * @param b another key
 * @param style the root's style
 * @returns whether they fold alike
 */
export function isSameKey(a: string, b: string, style: PathStyle): boolean {
  return foldKey(a, style) === foldKey(b, style)
}

/**
 * A path split into the volume it starts from and its parts: `''` for the
 * POSIX root, `C:` for a drive, `\\server\share` for a share; null for a
 * relative path, which starts from the root it is read against.
 */
type SplitPath = {
  readonly volume: string | null
  readonly parts: readonly string[]
}

/**
 * Splits a path in a style, or null for a spelling that names no place
 * under a root on its own: a drive-relative `C:x`, a rooted `\x` with no
 * drive, a device or namespace path (`\\.\`, `\\?\` but a drive or a
 * share), or a share with no share name.
 */
function splitPath(path: string, style: PathStyle): SplitPath | null {
  if (style === 'posix') {
    return { volume: path.startsWith('/') ? '' : null, parts: path.split('/') }
  }

  const plain = path.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}\?[\\/](?=[A-Za-z]:)/, '')

  if (/^[\\/]{2}[?.][\\/]/.test(plain)) {
    return null
  }

  const drive = /^([A-Za-z]:)[\\/]/.exec(plain)

  if (drive !== null) {
    return { volume: drive[1] ?? '', parts: plain.slice(drive[0].length).split(/[\\/]/) }
  }

  if (/^[A-Za-z]:/.test(plain)) {
    return null
  }

  const share = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(plain)

  if (share !== null) {
    return { volume: `\\\\${share[1]}\\${share[2]}`, parts: plain.slice(share[0].length).split(/[\\/]/) }
  }

  if (/^[\\/]/.test(plain)) {
    return null
  }

  return { volume: null, parts: plain.split(/[\\/]/) }
}

/**
 * Parts with `.` and empty parts dropped and each `..` taking the part
 * before it, as a path resolves: `..` at the volume's root stays there.
 */
function resolvedParts(parts: readonly string[]): string[] {
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '..') {
      resolved.pop()
    } else if (part !== '' && part !== '.') {
      resolved.push(part)
    }
  }

  return resolved
}

/**
 * Whether a path names its place by itself, from a volume (`/`, a drive, a
 * share), rather than counting from a root it is read against.
 *
 * @param path the path
 * @param style the root's style
 * @returns whether it is absolute; false too for one that names no place by
 *   its spelling (see `splitPath`)
 */
export function isAbsolute(path: string, style: PathStyle): boolean {
  return splitPath(path, style)?.volume != null
}

/**
 * The key of a path from outside the tree: a tool's `file_path`, a path a
 * person typed, git's view of the repository. Absolute, or relative to the
 * root; read in the root's style, so either separator under Windows.
 *
 * The root's own parts are matched by `isSameKey`, so `c:\proj` finds
 * `C:\Proj` and a decomposed name its composed twin; the parts below keep
 * their spelling, to be matched against the tree's keys by `isSameKey`
 * too. Spellings are compared, never resolved: a path through a link is
 * not under the root it leads to (`$.fs.stat`'s `realPath` is).
 *
 * @param root the session's project root, native
 * @param path the path
 * @returns its key, `''` for the root itself, or null for a path outside
 *   the root or one that names no place by its spelling (see `splitPath`)
 */
export function keyOf(root: string, path: string): string | null {
  const style = styleOf(root)
  const base = splitPath(rootOf(root), style)
  const given = splitPath(path, style)

  if (base === null || base.volume === null || given === null) {
    return null
  }

  const volume = given.volume ?? base.volume
  const rootParts = resolvedParts(base.parts)
  const parts = resolvedParts(given.volume === null ? [...base.parts, ...given.parts] : given.parts)

  const isUnderRoot =
    isSameKey(volume, base.volume, style) &&
    parts.length >= rootParts.length &&
    rootParts.every((part, at) => isSameKey(part, parts[at] ?? '', style))

  return isUnderRoot ? parts.slice(rootParts.length).join('/') : null
}
