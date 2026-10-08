import { describe, expect, test } from 'claude-code/testing'

import {
  ancestorsOf,
  extensionOf,
  foldKey,
  isSameKey,
  keyOf,
  nameOf,
  nativePathOf,
  rootLabelOf,
  rootOf,
  styleOf,
} from '../hooks/paths'

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

describe('keyOf', () => {
  test('a Windows path under the root, by either separator and in any case', async () => {
    expect(keyOf('C:\\Proj', 'C:/Proj/src/main.ts')).toBe('src/main.ts')
    expect(keyOf('C:\\Proj', 'c:\\proj\\SRC\\Main.ts')).toBe('SRC/Main.ts')
    expect(keyOf('C:\\Proj', 'C:\\Proj\\a\\..\\b')).toBe('b')
    expect(keyOf('C:\\Proj', 'C:\\Proj')).toBe('')
    expect(keyOf('C:\\Proj\\', '\\\\?\\C:\\Proj\\x.txt')).toBe('x.txt')
    expect(keyOf('C:\\', 'C:\\Windows\\win.ini')).toBe('Windows/win.ini')
  })

  test('a Windows path outside the root, or naming no place by itself, is null', async () => {
    for (const path of ['C:\\Project\\x', 'D:\\Proj\\x', 'C:a.txt', '\\a.txt', '\\\\.\\C:\\Proj\\x', 'C:\\Proj\\..\\x']) {
      expect(keyOf('C:\\Proj', path), path).toBe(null)
    }
  })

  test('a share, its server and share names in any case', async () => {
    expect(keyOf('\\\\server\\share\\proj', '\\\\SERVER\\Share\\proj\\a\\b.md')).toBe('a/b.md')
    expect(keyOf('\\\\server\\share\\proj', '\\\\?\\UNC\\server\\share\\proj\\c')).toBe('c')
    expect(keyOf('\\\\server\\share\\proj', '\\\\other\\share\\proj\\c')).toBe(null)
  })

  test('a relative path is read from the root, and may not climb out of it', async () => {
    expect(keyOf('C:\\Proj', 'src\\main.ts')).toBe('src/main.ts')
    expect(keyOf('/home/me/proj', 'src/./main.ts')).toBe('src/main.ts')
    expect(keyOf('/home/me/proj', '../other/x')).toBe(null)
  })

  test('POSIX compares case, and spellings rather than where links lead', async () => {
    expect(keyOf('/home/me/proj', '/home/me/proj/src/a.ts')).toBe('src/a.ts')
    expect(keyOf('/home/me/proj', '/home/me/Proj/src/a.ts')).toBe(null)
    expect(keyOf('/private/tmp/p', '/tmp/p/x')).toBe(null)
    expect(keyOf('/', '/etc/hosts')).toBe('etc/hosts')
    expect(keyOf('/home/me', '/home/me/a\\b')).toBe('a\\b')
  })

  test('composed and decomposed accents match, and keep their spelling below the root', async () => {
    expect(keyOf('/home/me/caf\u00e9', '/home/me/cafe\u0301/x.md')).toBe('x.md')
    expect(keyOf('/home/me', '/home/me/cafe\u0301.md')).toBe('cafe\u0301.md')
  })
})

describe('isSameKey', () => {
  test('folds case under Windows only, and composes accents everywhere', async () => {
    expect(isSameKey('SRC/Main.ts', 'src/main.ts', 'win32')).toBe(true)
    expect(isSameKey('SRC/Main.ts', 'src/main.ts', 'posix')).toBe(false)
    expect(isSameKey('cafe\u0301', 'caf\u00e9', 'posix')).toBe(true)
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

describe('ancestorsOf', () => {
  test('lists the folders that hold a key, outermost first', async () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('README.md')).toEqual([])
  })
})

describe('foldKey', () => {
  test('folds case under win32 only, and composes accents everywhere', async () => {
    expect(foldKey('Src/Main.ts', 'win32')).toBe('src/main.ts')
    expect(foldKey('Src/Main.ts', 'posix')).toBe('Src/Main.ts')
    expect(foldKey('café.md', 'posix')).toBe('café.md')
  })
})
