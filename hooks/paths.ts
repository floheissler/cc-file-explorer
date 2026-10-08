/**
 * Paths in the tree are relative to the project root, `/`-separated, and
 * `''` is the root itself.
 */

/**
 * The path of a folder's entry.
 *
 * @param dir the folder, relative to the root
 * @param name the entry's name
 * @returns the entry's path, relative to the root
 */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * The absolute path of a path in the tree.
 *
 * @param root the project root, absolute
 * @param path a path relative to it
 * @returns the absolute path
 */
export function absolutePath(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '')

  return path === '' ? base : `${base}/${path}`
}

/**
 * The last part of a path.
 *
 * @param path a path, `/` or `\` separated
 * @returns its last part, or the path when it has one part
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))

  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * A file's extension, lowercase and without its dot.
 *
 * @param path a path
 * @returns the extension, or `''` for none (a dotfile such as `.env` has none)
 */
export function extensionOf(path: string): string {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? '' : name.slice(dot + 1)
}

/**
 * How deep a path sits: 0 for an entry of the root.
 *
 * @param path a path relative to the root
 * @returns the number of folders above it
 */
export function depthOf(path: string): number {
  return path === '' ? -1 : path.split('/').length - 1
}

/**
 * The folder that holds a path.
 *
 * @param path a path relative to the root
 * @returns its folder, `''` for an entry of the root
 */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut < 0 ? '' : path.slice(0, cut)
}
