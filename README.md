# Guided Review

[![npm](https://img.shields.io/npm/v/@haydenmeloche/guided-review)](https://www.npmjs.com/package/@haydenmeloche/guided-review)
[![CI](https://github.com/HaydenMeloche/guided-review/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/HaydenMeloche/guided-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status:** Guided Review is early (0.x). Expect small bugs, and breaking changes between minor versions. 

Review pull requests as a guided tour, in your terminal.

A diff lists files alphabetically, but code runs from an entry point through the functions it calls. Guided Review (`gr`) reorders a PR to match: a briefing explains what the change is for, chapters follow each route, command, or handler through the changed code, and the tests for each hunk sit beside it. Migrations, API contracts, and dependency upgrades get chapters that explain their impact, not just the lines that changed. You mark what you've read, ask a model about any line, and submit your comments as one GitHub review.

The same tour works for learning a codebase: every PR becomes a walk through real code, with the tests that pin it down and answers that cite files and lines.

<p align="center"><img src="docs/images/chapter.webp" alt="A Guided Review chapter showing an explanation, the changed code, and linked tests side by side" width="900"></p>

## Features

- **A tour instead of a file list.** Chapters follow entry points such as routes, commands, and handlers through the changed code, in a recommended reading order. You can also sort by risk, size, or file.
- **Changes explained by what they mean.** Migrations, API contracts, dependency and runtime upgrades, lockfiles, infrastructure, and CI each get [their own chapter](docs/usage.md#change-aware-chapters) whose explanation covers impact rather than restating the diff: what a migration locks or drops, which API changes break clients, what an upgrade brings, what a workflow can now do.
- **Tests beside the code.** Linked test cases appear next to the hunks they exercise, and [possible test gaps](docs/usage.md#tests-risk-and-review-prompts) are flagged.
- **Track your progress.** Hunks are marked read, skipped, or deferred, and that state can survive a new push.
- **Draft, then submit once.** Comments stay local drafts until you [post them as a single GitHub review](docs/usage.md#draft-and-submit-comments), with code suggestions and `@` for both mentions and code references; a reference is written as inline code, such as `` `releaseInventory()` `` or `` `stock.ts:84-96` ``, and posts as a link to the exact lines. AI can draft a suggestion for you to accept.
- **Re-review after a push.** See only the hunks that changed since your last pass, and check whether your earlier comments were addressed. See [Review after a new push](docs/usage.md#review-after-a-new-push).
- **Ask questions.** Ask the model about a selected line, a chapter, or the whole PR without leaving the review. Follow-ups keep the thread, which makes it useful for learning as well as reviewing: "what calls this?", "why a mutex here?", "where is this tested?".
- **Author preview.** Tour your own branch before you open a PR, to see your change the way a reviewer will.
- **Bring your own model.** Claude Code (with your Claude Code login), the Anthropic API, Codex, Cursor, OpenAI, any OpenAI-compatible endpoint, Bedrock, or Vertex. Choose no model in `gr config` (or pass `--no-agent`) for a static-analysis-only tour with no model calls. See [Configuration](docs/configuration.md).
- **Color themes.** Keep your terminal's colors or choose from 65 themes, dark and light, that color the whole interface. `gr config` and `L` preview them live. See [Color themes](docs/configuration.md#color-themes).
- **Share tours from CI.** A GitHub Action builds the tour once and posts it to the PR, so reviewers open it without their own model calls. See [Share tours from CI](docs/ci.md).


## Quick start

```sh
npm install -g @haydenmeloche/guided-review
gr # first time launches a config walkthrugh
```

The package installs the command under two names, `gr` and `guided-review`. If `gr` runs something else, a shell alias is shadowing it; Oh My Zsh's git plugin defines `alias gr='git remote'`. Use `guided-review`, or add `unalias gr` to your shell config after the plugin loads.

## Install

### Requirements

- Node 22.13 or newer (Guided Review uses the built-in `node:sqlite`)
- `git`
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`), optional; the agent's `search_repo` tool needs it
- The [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`, or a GitHub [personal access token](docs/configuration.md#github-access)
- An OpenAI, Anthropic, Cursor or chat completions style AI subscription to support AI features
- An interactive terminal; `gr` does not run through a pipe
- macOS or Linux, including WSL. Native Windows is untested.

### From npm

```sh
npm install -g @haydenmeloche/guided-review
```

This puts `gr` and `guided-review` on your `PATH`.

### From source

```sh
git clone https://github.com/HaydenMeloche/guided-review.git
cd guided-review
pnpm install
pnpm build
pnpm add -g .
```

If pnpm's global binary directory is not on your `PATH`, run `pnpm setup` once and restart your shell.

### Configure a model

The first time you run `gr`, it introduces itself and walks you through setup: a color theme, a model provider, and GitHub access. It finds what your machine already has, such as a Codex login, an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or a local Ollama server, so a found provider is one `Enter`. Before saving, it sends each model a test request, and then it carries on with the command you ran. Run `gr config` to go through setup again. An Anthropic, OpenAI, or Cursor API key is recommended: `gr` calls those from its own process, so tours start faster than with Codex, which starts a CLI process for every request. Setup lists the current models to choose from, including each Cursor model's effort, speed, and context. Codex uses your Codex CLI login, so it needs no key. See [Configuration](docs/configuration.md) for the Anthropic and OpenAI APIs, compatible endpoints, Bedrock, Vertex, and GitHub tokens. To review without AI, choose **No AI model** in `gr config`: every feature but the briefing text, narration, Q&A, and AI suggestions still works. To skip model calls for one review (even without a config), pass `--no-agent`.

### Use from Claude Code or Codex

- **Claude Code:** `gr install-claude-command` installs a `/guided-review` command that previews your local changes: the current branch against its merge base with the default branch, uncommitted work included, with no PR needed. It runs `guided-review open --preview`, which opens `gr preview` in a new tmux window (inside tmux) or a new Terminal window (macOS), and otherwise prints the command to run. The command is only allowed to run `guided-review open --preview`. If `~/.claude/commands/guided-review.md` already exists with different content, the installer stops; pass `--force` to replace it.
- **Codex:** `gr install-codex-skill` copies a `guided-review` skill, which previews your local changes the same way, to `$CODEX_HOME/skills/` (or `~/.codex/skills/` when `CODEX_HOME` is unset); restart Codex afterwards. Running it again is safe. If that skill path contains different content, the installer stops so your edits are preserved; pass `--force` to replace it.

## Start a review

```sh
gr                            # choose from PRs awaiting your review
gr review 1234               # PR number in the current repository
gr review https://github.com/owner/repo/pull/1234
gr review owner/repo#1234
gr review                    # current branch's open PR
gr preview                   # tour the current branch before opening a PR
gr open 1234                 # open a tour in a new tmux or Terminal window
gr open --preview            # open gr preview in a new tmux or Terminal window
gr build 1234 --comment      # build a tour without the TUI and post it to the PR (for CI)
```

`gr` needs an interactive terminal on both stdin and stdout, and checks for one before contacting GitHub.

Guided Review checks out the PR head in a detached worktree under `~/.guided-review/worktrees/`, so your own working checkout is left alone. See [Using Guided Review](docs/usage.md) for the picker, the tour, every key, and commenting.

### CLI options

| Option | Purpose |
| --- | --- |
| `--no-agent` | Build a plain tour from static analysis, without model calls. Not for `build`, which needs a model. To always review without AI, choose **No AI model** in `gr config` instead. |
| `--fresh` | Rebuild the tour even if this head commit has a completed cached tour or a tour shared on the PR. |
| `--comment` | With `build`, post the tour to the PR as a comment. See [Share tours from CI](docs/ci.md). |
| `--out <file>` | With `build`, write the tour JSON to a file, or `-` for stdout (the default without `--comment`). |
| `--preview` | With `open`, open `gr preview` of your local changes instead of a PR's tour. |
| `--force` | With `install-claude-command` or `install-codex-skill`, replace an existing file that has different content. |

Set `GR_DEBUG=1` to print stack traces on errors.

Once a day, `gr` checks npm in the background for a newer version. Before a tour it opens an update screen with the release notes since your version: Enter installs the update and restarts `gr` where you were, `n` waits until tomorrow, and `s` skips that version. Other commands mention the update when they finish. It never checks in CI or for `gr build`. Set `GR_NO_UPDATE_CHECK=1` to turn it off.

Providers, models, endpoints, and keys are not CLI options; they live in `~/.guided-review/config.json`. See [Configuration](docs/configuration.md).

## A quick tour

The **briefing** opens first. It shows the PR's intent and author description, recent reviewer feedback, flagged gaps, an overview diagram, and chapters in a recommended reading order. Press `Enter` on a chapter, or `n` to start or resume.

<p align="center"><img src="docs/images/briefing.webp" alt="The briefing screen: a summary of the PR, the author's description, flagged gaps, an overview diagram, chapters in reading order, and blast radius" width="900"></p>

A **chapter** shows an explanation, the code hunk, risk and test status, existing review threads, and linked tests. Press `n`/`p` to move between hunks, `c` to draft a comment, and `s` to review and submit your drafts.

Press `?` on a selected line or range to ask about it. The model can read the rest of the repository, so answers cover code outside the diff and cite the files and lines they come from. Below, it finds that cancelling an order twice restocks its items twice, by following `release` into a file the PR does not touch.

<p align="center"><img src="docs/images/ask.webp" alt="A question about a changed line, answered inline below the code with file and line references" width="900"></p>

See [Using Guided Review](docs/usage.md) for the full key reference, change-aware chapters, test linking, and re-reviews.

## Team configuration

Run `gr config --repo` inside a repository to create or edit `.guided-review.json` at the repository root. It prints a reference of the keys before opening your editor, and afterwards lists any entries that will be ignored, such as an unknown kind. Commit it so everyone reviewing the repository gets the same rules:

```json
{
  "kinds": [{ "pattern": "src/gen/**", "kind": "generated" }],
  "testPatterns": ["**/*.it.ts"],
  "checklists": [{ "pattern": "db/**", "items": ["Migrations are reversible"] }]
}
```

`kinds` overrides file classification with `logic`, `test`, `config`, `mechanical`, `generated`, or `vendored`. `testPatterns` adds test-file globs. A checklist applies when a changed path matches its pattern. See [docs/repo-config.md](docs/repo-config.md) for the full reference and [docs/examples](docs/examples) for sample configs. Model settings live in `~/.guided-review/config.json`.

`.guided-review.json` and `.gitattributes` are read from the PR's merge base, not from the PR itself, so a PR cannot reclassify its own files (for example, marking a source file as generated to collapse it). If a PR changes either file, or changes committed coverage data, the briefing flags it, and coverage the PR changed is not trusted.

## Privacy and security

Guided Review has no telemetry and runs no server of its own. PR content and any files the agent reads go only to the model provider in your config (nothing, with no model configured or `--no-agent`), and it writes to GitHub only when you post a review, reply, or react. PR content is treated as untrusted: agent tools are read-only and confined to the PR worktree. See [Data, privacy, and security](docs/security.md) for the details, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Documentation

- [Using Guided Review](docs/usage.md): the picker, briefing, chapters, keys, comments, and re-reviews
- [Configuration](docs/configuration.md): model providers, GitHub access, and `config.json`
- [Share tours from CI](docs/ci.md): the GitHub Action and shared tours
- [Repository configuration](docs/repo-config.md): `.guided-review.json` for teams
- [Data, privacy, and security](docs/security.md): what is sent where, local data, and the security model
- [Architecture](ARCHITECTURE.md): how the code fits together

## Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach.

```sh
pnpm dev review 1234   # run TypeScript directly, with its own config and db in .gr-dev/ (pnpm reset:db clears it)
pnpm lint
pnpm format      # prettier --write
pnpm typecheck   # src and tests
pnpm test        # unit tests (pnpm test:coverage for coverage)
pnpm test:e2e    # builds, then drives bin/gr.js in a pseudo-terminal
pnpm build
```

Use the Node version in `.nvmrc` (22.13, the minimum supported).

The end-to-end tests in `test/e2e/` run the built `gr` against a throwaway git repo. Each test gets its own `GR_HOME` and `HOME`, plus a fake `gh` on `PATH` that logs its arguments and fails. They read the screen through a headless xterm, so assertions match what a user sees. No network access or model is needed.

CI runs lint, format check, typecheck, unit tests with coverage, and end-to-end tests on macOS and Linux, on Node 22.13, 22, 24, and 26. Please run them locally before opening a PR. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code fits together, and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
