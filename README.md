# Guided Review

[![npm](https://img.shields.io/npm/v/@haydenmeloche/guided-review)](https://www.npmjs.com/package/@haydenmeloche/guided-review)
[![CI](https://github.com/HaydenMeloche/guided-review/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/HaydenMeloche/guided-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Status:** Guided Review is early (0.x). Expect small bugs, and breaking changes between minor versions.

Read a code change the way the code runs, in your terminal.

A diff lists files alphabetically. Code runs from an entry point through the functions it calls. Guided Review (`gr`) turns a change into a tour that follows that path: a briefing says what the change is for, chapters walk each route, command, or handler through the changed code, and the tests for each hunk sit beside it. It works on a pull request, on your own branch before you open one, or on uncommitted work. Mark what you've read, ask a model about any line, and post your comments as one GitHub review. On your own PR, `gr feedback` turns the review into a work list you can answer in one go.

A model is optional. Without one, the tour is built from static analysis alone and nothing leaves your machine.

<p align="center"><img src="docs/images/chapter.webp" alt="A Guided Review chapter: the chapter list, an explanation of the hunk, the changed code with review threads, and linked tests side by side" width="900"></p>

## Quick start

```sh
npm install -g @haydenmeloche/guided-review
gr   # the first run walks you through setup, then lists PRs awaiting your review
```

You need Node 22.13 or newer, `git`, and the [GitHub CLI](https://cli.github.com/) signed in with `gh auth login`.

## Documentation

The full documentation is at **[haydenmeloche.github.io/guided-review](https://haydenmeloche.github.io/guided-review/)**:

- [Install and set up](https://haydenmeloche.github.io/guided-review/install.html)
- [Using Guided Review](https://haydenmeloche.github.io/guided-review/usage.html): every screen, key, command, and option
- [Configuration](https://haydenmeloche.github.io/guided-review/configuration.html): model providers, GitHub access, and themes
- [Team configuration](https://haydenmeloche.github.io/guided-review/repo-config.html), [Share tours from CI](https://haydenmeloche.github.io/guided-review/ci.html), [Privacy and security](https://haydenmeloche.github.io/guided-review/security.html), and [Terminals](https://haydenmeloche.github.io/guided-review/terminals.html)

## Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach.

```sh
pnpm dev review 1234   # run TypeScript directly, with its own config and db in .gr-dev/
pnpm check             # lint, format check, typecheck, unit tests, and end-to-end tests
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code fits together, and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
