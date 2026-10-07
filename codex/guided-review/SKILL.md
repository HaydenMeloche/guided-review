---
name: guided-review
description: Use the Guided Review terminal app to review a GitHub pull request or preview a branch when the user asks for a guided PR review.
---

# Guided Review

Use `gr` when the user wants an interactive tour of a pull request. Run it in a terminal with a TTY, from the relevant repository:

- `gr review <number-or-URL>` opens a specific PR.
- `gr review` opens the current branch's PR.
- `gr` lists PRs awaiting the user's review.
- `gr preview` tours the current branch before a PR is opened.

The tour needs the whole terminal. If your shell has no TTY, run `guided-review open [number-or-URL]` instead (the full name avoids a `gr` shell alias); it opens the tour in a new tmux or Terminal window, or prints the command for the user to run. Do not launch it through `osascript`, `open`, or other shell wrappers.

The app keeps draft comments local until the user submits a GitHub review in its submit screen. Follow the user's instructions about whether to draft or publish comments. If `gr` is unavailable, explain that the app must be installed first. If `gr` reports that no model provider is configured, or the user asks to configure one, tell them to run `gr config` in an interactive terminal; it prompts for input, so do not run it for them.
