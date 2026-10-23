# Data, privacy, and security

What Guided Review sends where, what it stores locally, and how it limits what a model can do with untrusted PR content.

## Data and privacy

Guided Review has no telemetry and runs no server of its own. It sends data to these places only:

- **Your model provider.** The PR description, diff, review threads, linked issues from the PR's own repository, and any repository files the agent reads go to the provider in your config (Anthropic, OpenAI, Codex, Cursor, Bedrock, Vertex, or your compatible endpoint). With no AI model chosen in `gr config`, or with `--no-agent`, nothing goes to a model.
- **GitHub, through `gh` or your personal access token.** It reads PR data, and it writes only when you act: posting a review (`P` on the submit popup), replying to a thread, adding a reaction, resolving a thread (`Z`), sending queued replies, a comment on the PR's conversation, resolves, and a re-request for review (`P` on the send screen), asking for or withdrawing a review request (`A`), marking a draft ready for review (`r` in the merge dialog), updating a PR's branch from its base (`u` in the merge dialog), or merging a PR (`P` in the merge dialog).
- **Your `origin` remote, for `gr preview` only.** When your clone doesn't already record origin's default branch, `gr preview` asks origin for it with `git ls-remote`, using your usual git credentials. It never prompts for a password or passphrase, and it sends nothing else (see [Preview your own branch](usage.md#preview-your-own-branch)).

`gr preview` tours your real checkout, so your uncommitted changes go to the model, and the agent can read any file in that checkout, including gitignored ones such as `.env`. Linked issues in other repositories are shown as links but never fetched.

Local data:

- `~/.guided-review/` holds drafts, reading state, cached tours and model output, worktrees, and cached clones. The directory is kept owner-only (`0700`).
- For Q&A, the Claude Code provider saves session transcripts where Claude Code normally does (`~/.claude/projects/`), so follow-up questions can resume them; briefing and narration runs are not saved there. The Codex provider saves its sessions under `~/.codex/sessions/`, and the Cursor provider saves its agents in the Cursor SDK's local store.

## Security model

PR content is untrusted: a diff, description, or comment can contain text aimed at the model. Guided Review limits what a model can do with it:

- **Claude Code provider.** A `PreToolUse` hook checks every tool call, including ones Claude Code would approve on its own. `Read`, `Grep`, and `Glob` are denied outside the worktree, after resolving symlinks, so a symlink committed in the PR cannot point the agent at your files. The shell is limited to an allowlist of read-only `git` and `gh` commands. Flags that write files, run programs, or take a file path outside the worktree are refused. `gh` is pinned to the PR's own repository, and git runs without external diff or textconv drivers.
- **Codex provider.** Runs under a permission profile that cannot read your home directory, write files, or reach the network (see [Codex](configuration.md#codex)).
- **Anthropic API, Cursor, OpenAI, and compatible endpoints.** These get `read_file`, `search_repo`, and `git_history`, which resolve paths inside the worktree. Remote endpoints must use HTTPS.
- **Files from the PR.** Static analysis reads only regular files inside the worktree, up to a size limit, and never follows symlinks. Review configuration comes from the merge base (see [Team configuration](../README.md#team-configuration)).
- **Terminal output.** Control characters and escape sequences are stripped from PR text, CI job logs, and model output before they reach your terminal, so a PR title cannot write to your clipboard or redraw the screen. Image links show their host.
- **Shared tours.** A tour posted to the PR is imported only from `github-actions[bot]`, and only when its code matches the PR's diff (see [Share tours from CI](ci.md)). Its narration was written by the CI job's model and goes through the same terminal sanitizing as local model output.
- **GitHub writes.** A review posts only after you press `P` and confirm. Thread replies in a review tour post when you press Enter in the reply editor, and reactions post when you choose one. In `gr feedback`, replies are queued locally and post only from the send screen after `P` and a confirmation; `Z` resolves a thread only after its own confirmation. A merge happens only after `P` and a confirmation in the merge dialog, and names the head commit it showed you, so a later push makes GitHub refuse it. Updating a branch works the same way: only after `u` and a confirmation, naming the head it showed you. In the reviewers popup (`A`), a review request goes out when you press `Enter` on the names you typed or `r` on a reviewer, and `x` withdraws one, each without a further confirmation, as on GitHub. Nothing posts on its own, and no thread is ever resolved automatically.
- **Review comments and your coding agent.** A review comment is text from someone else. `o` in `gr feedback` writes a prompt for your coding agent that quotes the reviewer's text under a header marking it as untrusted, shows it to you, and copies it to the clipboard when you press `Enter`. gr never starts an agent from `gr feedback`: you paste the prompt into your own agent, in your own checkout, where it runs with its own permissions, so read the prompt first.
- **Model prompts in `gr feedback`.** Themes, thread classes, drafted replies, and merge commit messages are written by your configured model with the same read-only tools as the tour, and their prompts mark review comments, descriptions, and commit messages as untrusted data. A drafted reply or commit message is shown as a proposal and posts only as part of a send or merge you confirm.
- `~/.guided-review/config.json` is written with owner-only permissions. Prefer `apiKeyEnv` over storing `apiKey` in the file.

Model output is still text from a model that has read untrusted input. Treat narration as a reading aid, not a verdict.

## Saved data

Tours, read/skipped/deferred state, drafts, position, chapter moves, checklist confirmations, and for `gr feedback` your thread triage, queued replies, what your last visit saw, and the model's themes and classes are saved in SQLite at `~/.guided-review/gr.db`. Read state uses hunk content rather than line number, so it can survive a new push. A completed tour is cached by PR head and model routing and opens immediately, while review threads refresh in the background; use `--fresh` to rebuild it. If narration stopped partway (for example, you quit or the model was unavailable), reopening the PR narrates only the chapters that are missing.
