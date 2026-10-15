---
description: Open a Guided Review tour of your local changes against the base branch in a new terminal
allowed-tools: Bash(guided-review open --preview)
---

Launch Guided Review (`gr`), a full-screen terminal app, to preview the local changes in this repository: everything on the current branch since its merge base with the default branch, including staged, unstaged, and untracked files. It does not need a commit, a push, or a PR.

gr needs the whole terminal, so do not run `gr preview` inside this session. Instead:

1. Run `guided-review open --preview` from the repository, exactly as written (use this full name, not `gr`, which a shell alias may shadow). It takes no other arguments.
2. `guided-review open --preview` opens a new tmux window or Terminal window running the tour. If it cannot open one, it prints the command to run; pass that command on to the user.
3. Reply with one line saying the preview was opened.

Do not run any other commands. If `guided-review open --preview` fails, report its error message as-is.
