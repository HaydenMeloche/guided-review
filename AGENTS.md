# Agent guide

Guided Review (`gr`) is a terminal app, built with TypeScript, Ink, and pnpm, that turns a diff into an interactive review tour. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the system map, repository layout, and where to make each kind of change.

## Checks

Run these before you call a change done. CI runs them all. `pnpm check` runs them in order and stops at the first failure.

```sh
pnpm check          # all of the below
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm typecheck
pnpm test           # unit tests; pnpm test -u accepts tour-corpus snapshot changes
pnpm test:e2e
```

The app and tests need Node 22.13 or newer and ripgrep (`rg`) on the PATH.

If a change alters how PRs split into tours, it shows up as a diff of the `.tour.txt` files in `test/fixtures/prs/`. Only accept that diff with `pnpm test -u` when the new shape is intended.

## Running the app

- Use `pnpm dev`. It keeps its config and database in `.gr-dev/`, and `pnpm reset:db` clears them. Don't read or write the user's real `~/.guided-review/`.
- `gr` and `pnpm dev review` / `preview` / `config` are full-screen and interactive, so they hang in a non-interactive shell. Don't run them yourself. Test behaviour through `test/`, or ask the user to run the command.

## Rules

- Edit `src/`, not `dist/`. `dist/` and `coverage/` are build output.
- Pass text that comes from GitHub or a model through `sanitizeTerminal` (or `renderMarkdown`) before it reaches `<Text>`.
- `claude/` and `codex/` are skills shipped to users of `gr`. Agent config for working on this repo lives in `.claude/`.
- When you change a command, flag, key, or config option, update `docs/` and the README to match.

## Commits and releases

- Write commit subjects as plain sentences that say what changed for the user, such as "Return to the PR list on q". If the change needs explaining, add a body.
- Don't tag, bump the version, or publish. Publishing a GitHub release runs `npm publish`, and the tag must match `package.json`. The user handles releases. `/release-notes` drafts the notes.
