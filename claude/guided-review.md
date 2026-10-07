---
description: Open a Guided Review tour of the current branch's PR (or a given PR) in a new terminal
argument-hint: "[PR number or URL]"
allowed-tools: Bash(guided-review open:*)
---

Launch Guided Review (`gr`), a full-screen terminal app, for this pull request: $ARGUMENTS

gr needs the whole terminal, so do not run `gr review` inside this session. Instead:

1. Run `guided-review open` from the repository (use this full name, not `gr`, which a shell alias may shadow), adding the PR only if one was given above. Pass it as a single quoted argument, for example `guided-review open '123'` or `guided-review open 'https://github.com/owner/repo/pull/123'`. With no PR, `guided-review open` uses the current branch's PR.
2. `guided-review open` opens a new tmux window or Terminal window running the tour. If it cannot open one, it prints the command to run; pass that command on to the user.
3. Reply with one line saying which PR was opened, using the PR that `guided-review open` printed.

Do not run any other commands. If `guided-review open` fails, report its error message as-is.
