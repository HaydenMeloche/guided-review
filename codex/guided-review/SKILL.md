---
name: guided-review
description: Use the Guided Review terminal app to tour the local changes on the current branch when the user asks for a guided review.
---

# Guided Review

Guided Review (`gr`) turns a diff into an interactive tour. Use it to preview the local changes in this repository: everything on the current branch since its merge base with the default branch, including staged, unstaged, and untracked files. It does not need a commit, a push, or a PR.

The tour needs the whole terminal, so do not run `gr preview` in your own shell. Run `guided-review open --preview` from the repository instead (the full name avoids a `gr` shell alias). It takes no other arguments. It opens the tour in a new tmux or Terminal window, or prints the command for the user to run; pass that command on. Do not launch the tour any other way, such as through `osascript` or macOS `open`.

If `guided-review` is unavailable, explain that the app must be installed first. If it reports that no model provider is configured, or the user asks to configure one, tell them to run `gr config` in an interactive terminal; it prompts for input, so do not run it for them.
