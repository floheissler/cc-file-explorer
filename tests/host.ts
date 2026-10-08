/**
 * The path a test keys its stubbed disk by, from the one a `$.fs` hook is
 * handed.
 *
 * The test host makes every `$.fs` path absolute by its own platform's rules
 * before a hook sees it. The tests' POSIX root `/work` passes as it is on
 * Linux and macOS, but arrives as `D:\work` on Windows (the drive of the
 * working folder), and its files as `D:\work\src\main.ts`. Stubs key their
 * folders and files by the POSIX spelling and read what they are handed
 * through this, so the same tests run on every host. `tests/roots.test.ts`
 * covers roots spelled for each platform.
 *
 * @param path a path a `$.fs` hook was handed
 * @returns it as the tests spell it
 */
export function testPathOf(path: string): string {
  return /^[A-Za-z]:\\/.test(path) ? path.slice(2).replaceAll('\\', '/') : path
}
