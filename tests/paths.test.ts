import { describe, expect, test } from 'claude-code/testing'

import { extensionOf, nameOf, nativePathOf, rootLabelOf, rootOf, styleOf } from '../hooks/paths'

describe('styleOf', () => {
  test('reads Windows off a drive or a backslash network spelling', async () => {
    expect(['C:\\proj', 'c:/proj', '\\\\server\\share', '\\\\wsl.localhost\\Ubuntu\\home', '\\\\?\\C:\\p'].map(styleOf))
      .toEqual(['win32', 'win32', 'win32', 'win32', 'win32'])
  })

  test('a POSIX root stays POSIX, a backslash in a folder name too', async () => {
    expect(['/', '/home/me', '/home/we\\ird', '/Volumes/My Disk'].map(styleOf)).toEqual(['posix', 'posix', 'posix', 'posix'])
  })
})

describe('rootOf', () => {
  test('keeps the separator that makes a root a root', async () => {
    expect(rootOf('C:\\')).toBe('C:\\')
    expect(rootOf('c:/')).toBe('c:\\')
    expect(rootOf('/')).toBe('/')
    expect(rootOf('/tmp//')).toBe('/tmp')
    expect(rootOf('C:\\proj\\')).toBe('C:\\proj')
    expect(rootOf('\\\\server\\share\\')).toBe('\\\\server\\share')
  })

  test('drops a \\\\?\\ prefix, which $.fs refuses', async () => {
    expect(rootOf('\\\\?\\C:\\proj')).toBe('C:\\proj')
    expect(rootOf('\\\\?\\UNC\\server\\share\\proj')).toBe('\\\\server\\share\\proj')
  })
})

describe('nativePathOf', () => {
  test('joins with the root\'s own separator', async () => {
    expect(nativePathOf('C:\\proj', '')).toBe('C:\\proj')
    expect(nativePathOf('C:\\proj', 'src/main.ts')).toBe('C:\\proj\\src\\main.ts')
    expect(nativePathOf('\\\\server\\share', 'a/b')).toBe('\\\\server\\share\\a\\b')
    expect(nativePathOf('\\\\wsl.localhost\\Ubuntu\\home\\me\\p', 'src')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\p\\src')
    expect(nativePathOf('/home/me/proj/', 'src/a.ts')).toBe('/home/me/proj/src/a.ts')
  })

  test('a drive root and / never turn into a drive-relative or empty path', async () => {
    expect(nativePathOf('C:\\', '')).toBe('C:\\')
    expect(nativePathOf('C:\\', 'src')).toBe('C:\\src')
    expect(nativePathOf('/', '')).toBe('/')
    expect(nativePathOf('/', 'etc')).toBe('/etc')
  })

  test('a backslash in a Linux name is part of the name', async () => {
    expect(nativePathOf('/home/me', 'a\\b')).toBe('/home/me/a\\b')
  })
})

describe('rootLabelOf', () => {
  test('names the root\'s folder, or the whole root for a drive, a share or /', async () => {
    expect(rootLabelOf('C:\\Users\\flo\\proj')).toBe('proj')
    expect(rootLabelOf('C:\\')).toBe('C:\\')
    expect(rootLabelOf('\\\\server\\share')).toBe('\\\\server\\share')
    expect(rootLabelOf('\\\\server\\share\\proj\\')).toBe('proj')
    expect(rootLabelOf('/')).toBe('/')
    expect(rootLabelOf('/home/me/proj/')).toBe('proj')
    expect(rootLabelOf('/home/me/we\\ird')).toBe('we\\ird')
  })
})

describe('nameOf and extensionOf', () => {
  test('split keys on / alone', async () => {
    expect(nameOf('src/main.ts')).toBe('main.ts')
    expect(nameOf('README.md')).toBe('README.md')
    expect(nameOf('dir/a\\b.md')).toBe('a\\b.md')
    expect(extensionOf('dir/a\\b.MD')).toBe('md')
  })
})
