# file-explorer

A file explorer pane for Claude Code. `/explorer` opens the project beside the
conversation as a tree you expand and collapse in place, and previews the file
you pick under it: Markdown rendered as Claude's replies are, CSV and TSV as
tables, source and text files with syntax colors and line numbers.

It is a [mod](https://code.claude.com/docs/en/plugins/mods/overview): a plugin
of function hooks that draws in Claude Code's own interface, in the terminal
and in the Desktop app's Code tab.

> **Status:** early spike (v0.1.0). Expect rough edges; see [Roadmap](#roadmap).

## Install

At the Claude Code prompt in a terminal:

```text
/plugin install file-explorer --marketplace floheissler/cc-file-explorer
```

Answer `y` to add the marketplace, then pick a scope. This repository is its
own marketplace, named `cc-file-explorer`, so `claude plugin update
file-explorer@cc-file-explorer` fetches later releases.

To run it from a local checkout for one session instead:

```sh
claude --plugin-dir /path/to/cc-file-explorer
```

## Use

Run `/explorer` to open the pane, and again to close it. In fullscreen
rendering (`/tui fullscreen`) the pane docks beside the transcript from 110
columns; otherwise it opens above the prompt and Esc closes it.

| Do this | To |
| --- | --- |
| Click a folder, or focus it and press Enter | Expand or collapse it |
| Click a file | Preview it under the tree |
| `c` | Collapse every open folder |
| Click the previewed file again, or press `x` | Close the preview |
| Wheel over the tree or the preview | Scroll that part alone; the header stays put |
| Tab, Up, Down | Walk the tree; the tree scrolls with the focus |
| `j` / `k`, Page Up / Page Down | Scroll the preview |
| `m` | Switch a Markdown preview between rendered and source |
| `r` | Re-read the tree and the previewed file |
| Ctrl+X then an arrow | Resize the pane |
| Esc | Return the keyboard to the prompt |

Keys work while the pane has the keyboard: click it, or press Ctrl+X then Tab.

### What the tree shows

- The session's project root, folders first, names sorted as people sort them
  (`file2` before `file10`).
- In a git repository, everything `git check-ignore` does not ignore: untracked
  files show, `node_modules/`, build output and the like do not. `.git` never
  shows. Outside a repository, everything shows.
- Up to 2,000 entries per folder; a note counts the rest.

The tree and the open preview refresh shortly after Claude edits a file or
runs a shell command. Press `r` after changes made outside the session.

### What the preview shows

| File | Preview |
| --- | --- |
| `.md`, `.markdown`, `.mdx` | Rendered Markdown, or its source with `m` |
| `.csv`, `.tsv` | A table under its header row; long cells are cut at 32 characters |
| Any other text | Source with syntax colors by extension, and line numbers |
| Binary, empty, over 2 MB | A notice in place of the text |

File names and text are drawn with control characters replaced, so a file
cannot send escape sequences to your terminal.

## How it works

`hooks/register.tsx` is the hooks module; the rest of `hooks/` is its parts.

| Event | What the hook does |
| --- | --- |
| `session.start` | Registers `/explorer` |
| `command.run` of `explorer` | Opens the pane, focused, or closes it when it is shown |
| `ui.render` of the `Pane` | Draws the header, the tree's window and, set off by a blank row and a rule with the file's name, the preview's window, each exactly as tall as its region; reads what the drawing needs but lacks |
| `ui.scroll` of the pane | Moves the tree's or the preview's own window by the region under the pointer; the engine's window over the pane stays still |
| `ui.focus` in the pane | Keeps the focused row and its neighbors in view, so the arrows always have a drawn row to move to |
| `tool.call` of `Write`, `Edit`, `NotebookEdit`, `Bash` | After the call, re-reads an open pane's tree and preview once Claude pauses |
| `classic.SessionStart` after `/clear`, `/resume`, `/branch` | Forgets what was read, as the session state resets |

It calls `$.session.root`, `$.fs.list`, `$.fs.stat`, `$.fs.read`,
`$.process.run` (`git rev-parse` and `git check-ignore`, read-only, with
`GIT_OPTIONAL_LOCKS=0`), `$.clock.after`, `$.command.register`, `$.ui.open`,
`$.ui.close`, `$.ui.panes`, `$.ui.resolve`, `$.ui.invalidate`, `$.ui.log` and
its own `$.state`. It makes no network calls and writes no files.
`claude plugin validate .` prints the same list from the source.

The person's view (open folders, the previewed file, where each window
stands) lives in `$.state`, so it survives a reload of the module; what was
read from disk lives in the module and is read again as needed.

## Develop

Install the working copy once, from the checkout as a local marketplace. A
local marketplace whose entry is a relative path is read in place, so every
session runs your working copy:

```sh
claude plugin marketplace add /path/to/cc-file-explorer
claude plugin install file-explorer@cc-file-explorer
```

After an edit, run `/reload-plugins` in a session to load it. For a session
that hot-reloads on every save instead, start it with
`claude --plugin-dir /path/to/cc-file-explorer`; that needs file watching,
which a WSL checkout under `/mnt/c` does not reliably get.

Before each commit:

```sh
claude plugin validate --strict .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .                # the tests under tests/
tsc -p .                            # type-check against this build's API
```

`tsc` reads the types Claude Code lays in `.claude-plugin/types/` (ignored by
git) when it loads the mod with `--plugin-dir`; start one such session after a
Claude Code update to refresh them.

The version lives in `.claude-plugin/plugin.json` alone; bump it with every
release, because users only receive a release whose version changed.

## Roadmap

- Reveal a file in the tree from a path (`/explorer src/main.ts`)
- Filter the tree by name
- A toggle that shows ignored files
- Remember open folders per project across sessions
- Image previews where the terminal draws images
- Wide-character aware truncation for CJK and emoji file names

## License

[MIT](LICENSE) © Flo Heissler
