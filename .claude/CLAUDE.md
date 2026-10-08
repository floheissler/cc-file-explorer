# cc-file-explorer

A Claude Code mod (a plugin of function hooks) that adds `/tree`: a pane
with the project as a collapsible tree and a preview of the picked file. The
repository is the plugin and its own marketplace (`cc-file-explorer`, one
entry with `"source": "./"`). README.md has the user-facing behavior.

## Layout

- `.claude-plugin/plugin.json`: the manifest. `types` names the state contract.
- `.claude/CLAUDE.md`: this file. It lives under `.claude/` because a
  `CLAUDE.md` at the plugin root fails `claude plugin validate --strict`.
- `.claude-plugin/marketplace.json`: makes the repo installable with
  `/plugin install file-explorer --marketplace floheissler/cc-file-explorer`.
- `hooks/register.tsx`: the hooks module and the only file that touches `$`.
- `hooks/host.ts`: the `Host` record the rest of the code takes instead of `$`.
- `hooks/listing.ts`: reads folders (`$.fs.list` + `git check-ignore`) and files.
- `hooks/tree.ts`, `levels.ts`, `layout.ts`, `preview.ts`, `text.ts`,
  `paths.ts`: pure logic. `levels.ts` holds the `e`/`c`/digit steps.
- `hooks/view.tsx`: draws the pane from a `PaneModel`.
- `types/index.d.ts`: the `$.state` contract (`PluginState['file-explorer']`).
- `tests/`: `claude plugin test` suites; `pane.test.ts` mounts the pane on the
  terminal and desktop surfaces with stubbed fs and git.

## Rules the engine's static scan enforces

`claude plugin validate` reads the source the way the engine does and refuses
the module otherwise:

- Pass `$` only to functions declared at the top level of `register.tsx`.
  Everything else gets the `Host` that `hostOf($)` builds, where every engine
  call is spelled `$.noun.method(...)`.
- `read`/`update` take atoms that are `const`s of `register.tsx`, built with
  `atom({ plugin: 'file-explorer', key: '…' } as const, …)` from literals, and
  every key must be declared in `types/index.d.ts`.
- Write hook matchers as literals (`{ command: 'tree' }`), so validation and
  an administrator's review read exactly what each hook matches.
- A `ui.render` hook never writes state; write from a handler or another hook.

## Conventions

- The command is `/tree`: it tops the `/` menu as soon as `/tr` is typed (no
  built-in starts with `tr`), where `/explorer` ranked below `/export`. It must
  not start with `file-`: Claude Code 2.1.293's command menu draws any such
  name as a one-line `+ /name – description` row.
- Every drawn region is exactly as tall as `layout.ts` says, so the drawing fits
  the body: Up/Down then walk the controls, and the `ui.scroll` hook moves the
  tree's and the preview's own windows under a fixed header.
- Untrusted text (file names, file contents, error messages) goes through
  `sanitize` before it is drawn.
- Hotkeys are one lowercase letter or digit: the engine reads Shift+e as `e`,
  `?` cannot be one, and a mod cannot bind Ctrl or Alt chords of its own.
  The digit keys, listed only in the help view, are Buttons in a
  `display: 'none'` box, whose hotkeys stay armed (checked on 2.1.293; check
  again after Claude Code updates). Never give two drawn Buttons one hotkey:
  the later wins.
- A tree row is a dim `Text` of branch lines (`branchPrefixOf`, from the
  `guides`/`isLast` that `flattenTree` computes) beside a `Button` keyed
  `row:<path>` for the glyph and name; the `ui.focus` hook relies on the key.
- The version lives in `.claude-plugin/plugin.json` alone; the pane shows none.
  Bump it per release, or `claude plugin update` delivers nothing.

## Develop

Installed for daily use from this folder as a local marketplace
(`file-explorer@cc-file-explorer`), read in place: after an edit, run
`/reload-plugins`. File watching is unreliable under `/mnt/c`, so do not count
on `--plugin-dir` hot reloading here.

Before every commit, from the repo root:

```sh
claude plugin validate --strict .
claude plugin test .
tsc -p .
```

`tsc` needs `.claude-plugin/types/` (git-ignored), which Claude Code writes
when it loads the mod with `claude --plugin-dir .`; start one such session
after a Claude Code update to refresh the types. The types file is the API
reference for the running build: grep it for an event or method name.

Docs: https://code.claude.com/docs/en/plugins/mods/overview (create, interface,
events, api, test, reference pages). Anthropic's own mods, including `/diff`,
are at https://github.com/anthropics/claude-code/tree/main/mods.
