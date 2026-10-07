# Using Guided Review

How to pick a PR, read a tour, ask questions, draft comments, review again after a push, and preview your own branch. For installation and setup, see the [README](../README.md).

## Pick a PR

The picker groups review requests by repository. Press `/` to filter by repo, title, author, or label; `j`/`k` to move; `Enter` to open; `o` to open the selected PR in a browser; or `r` to refresh. Press `Space` to select PRs, `a` to select all PRs shown by the filter, and `d` to download the selected tours before opening them. With no selection, `d` downloads the highlighted tour. Downloads run one at a time and show progress in the picker; completed tours are cached for later opening. On a wide terminal, the preview shows the description, changed files, checks, review decision, and whether a local tour or drafts already exist.

For a PR, Guided Review fetches metadata, the diff, and existing review threads through `gh`. It checks out the PR head in a detached worktree under `~/.guided-review/worktrees/`. Your own working checkout is left alone. If the current repository is not the PR's repository, it uses a cached clone under `~/.guided-review/repos/`.

Run `gr cleanup` to remove managed PR worktrees and prune old tours. Tours are also pruned as they are saved: each PR keeps the three heads you opened most recently. `gr cleanup` also deletes tours you have not opened in 90 days (`--days <n>` to change it), and for a PR left with no tour, its reading state, position, chapter moves, checklist confirmations, and posted drafts. Unposted drafts and cached repository clones are always kept. Git refuses to remove a worktree with local changes, so the command reports and skips it.

## Read the tour

The **briefing** opens once it is ready; chapter narration may continue in the background. It shows the PR's intent and author description, recent reviewer feedback, flagged gaps, an overview diagram, chapters with risk, and your progress. Press `V` to read all submitted reviews. The chapter heading names the current order. Press `f` to cycle **Guided** (recommended reading path), **Risk first**, **Small first** (fewest changed lines), and **File** (path order). Select a chapter with `j`/`k` and `Enter`, or press `n` to resume where you left off. Press `r` to read the full PR description, `d` for the overview diagram, or `?` to ask about the whole PR in a panel below the briefing.

<p align="center"><img src="images/briefing.webp" alt="The briefing screen: a summary of the PR, the author's description, flagged gaps, an overview diagram, chapters in reading order, and blast radius" width="900"></p>

A **chapter** shows an explanation, code hunk, risk and test status, existing review threads, and linked tests. Wide terminals put code and tests side by side; narrow terminals let `t` toggle between them. Generated, vendored, and mechanical changes start collapsed into summaries. Import-only changes form an optional chapter that normal `n`/`p` navigation skips.

<p align="center"><img src="images/ask.webp" alt="A question about a changed line, answered inline below the code with file and line references" width="900"></p>

Press `?` on a selected line or range to ask about it. The model can read the rest of the repository, so answers cover code outside the diff and cite the files and lines they come from. Above, it finds that cancelling an order twice restocks its items twice, by following `release` into a file the PR does not touch.

Typing `@` in a draft comment or thread reply suggests people with access to the repository, along with the PR author and existing reviewers. Press `Tab` to complete a suggested handle.

Static analysis finds entry points such as routes, commands, and handlers and links changed code through name-matched call references. These links are reading suggestions: the tool does not resolve imports, receivers, and scopes to prove a call target. Ambiguous changed targets are skipped. Shared code appears once and is linked from other chapters. The default Guided order ranks flows by the amount of changed code they reach, then the model can recommend a reading order; supporting and lower-priority changes follow. This is a reading path, not a strict risk ranking. If no entry point is found, the tour uses file order. TypeScript and JavaScript use the TypeScript compiler API; Python, Go, Kotlin, C, C++, Java, Ruby, and Rust use tree-sitter. Other source languages may use a lower-confidence regex fallback. JSON and YAML changes appear as configuration chapters. Test linking recognizes conventional Java, C/C++, and Ruby test cases as well as the existing JavaScript, Python, Go, and Kotlin cases. Press `f` on the briefing or in a chapter to change the order.

The diff viewer also highlights syntax for TypeScript, JavaScript, Python, Go, Kotlin, Rust, Ruby, Java, C#, Swift, C/C++, PHP, shell, JSON, YAML, TOML, CSS, HTML, and Lua using Shiki. It loads highlighting when a hunk opens and reads the old and new file versions so multiline strings and comments keep their color across hunks. Unknown file types remain readable as plain colored diff lines. Syntax highlighting does not change the language support of flow analysis.

### Change-aware chapters

Some changes are easy to read in a diff but hard to judge from one. These get their own chapters, placed after the flow, supporting, and test chapters. With a model, the explanation for each hunk says what the change means instead of what it edits.

| Chapter | Files | The explanation covers |
| --- | --- | --- |
| Database migrations | `migrations/`, `migrate/`, `alembic/versions/`, Flyway `V1__*.sql`, `db/changelog/` | Table locks and rewrites, possible data loss, whether it can be rolled back, backfills, and whether code must deploy before or after it |
| API contracts | OpenAPI, Swagger, and AsyncAPI specs, `.proto`, GraphQL schemas, Avro `.avsc` | Which changes break existing clients and which are additive, and the clients in the repo that rely on them |
| Dependencies and runtimes | Dependency lines in `package.json`, `pom.xml`, Gradle, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements*.txt`, `Gemfile`, `composer.json`, `.csproj`, and similar manifests; runtime versions such as `.nvmrc`, `.tool-versions`, Docker `FROM` lines, `engines`, the `go` directive, `requires-python`, and the TypeScript `target` | For an upgrade or downgrade, `name old → new` and highlights of what changed between the versions: features, breaking changes, deprecations, security fixes, and end of life for runtimes. For a package that is new or removed, a short overview of what it is and, if new, where the PR uses it |
| Lockfile changes | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `bun.lock` | One summary of indirect changes: major version jumps, notable packages added or removed, and known security fixes. Starts collapsed |
| Infrastructure | Terraform, Terragrunt, and YAML under `k8s/`, `helm/`, `charts/`, `deploy/`, `infra/`, and similar; Helm `Chart.yaml` and `values*.yaml`, Kustomize, serverless, CloudFormation, and Pulumi files | Resources created, destroyed, or replaced, in-place edits that force a replacement or restart, and IAM, network, scaling, and secret changes |
| CI and workflows | `.github/workflows/`, `.github/actions/`, `action.yml`, GitLab CI, CircleCI, Jenkins, Buildkite, Azure Pipelines, Travis, and Bitbucket Pipelines | New triggers, jobs, permissions, and secrets, plus risky patterns such as `pull_request_target` checking out PR code, untrusted input in `run` scripts, and actions not pinned to a commit SHA |

Upgrade highlights and package overviews come from a changelog in the worktree when there is one, and otherwise from the model's own knowledge, because the model has no internet access. Those explanations are marked as inferred. Only hand-written logic and config files are moved into these chapters, so a test under `migrations/` stays with the tests. To move a file out of these chapters, classify it with a [`kinds` rule](repo-config.md#kinds). With `--no-agent` the chapters still appear, with the static file summary instead of an explanation.

### Chapter keys

| Key | Action |
| --- | --- |
| `n` / `p` | Next hunk, marking the current one read, or previous hunk. At the end, move to the next chapter. |
| `j` / `k`, `J` / `K` | Move the code cursor by one line or ten lines. |
| `v` | Start or end a line-range selection. |
| `]` / `[` | Next or previous chapter, including optional chapters. |
| `c` / `C` | Draft a comment on the selected line or range, or on the whole chapter. |
| `e` | Open review threads on the selected line inline. Scroll with `j`/`k` or `J`/`K`; use `Tab` to select a comment and `a` to add or remove a reaction; press `Esc` to close. |
| `y` | Reply to a review thread on the selected line in the inline panel. Replies post to GitHub when you press Enter. |
| `?` | Ask the agent about the selection in a panel below the selected line. Questions form a thread: press `Enter` again to ask a follow-up, and `↑`/`↓` to scroll. Press `Esc` to return to review. |
| `t` | Focus linked tests; narrow terminals toggle source and tests. Long code lines wrap in both panes. |
| `U` | Expand or collapse details about possible untested behavior and missing test links. |
| `d` | Open the chapter diagram. Select a node to jump to its code or comment on it. |
| `r` | Toggle the raw unified diff. |
| `w` | Hide or show whitespace-only changes (hidden by default; the choice is saved as `hideWhitespace` in your config). A line that was only reindented shows once, marked `~`. Either way, changed words within a line are highlighted, and a line that only gained words shows once with the additions in green. |
| `x` / `z` / `u` | Mark a hunk skipped, deferred, or unread. |
| `m` | Move the current hunk to another chapter. |
| `f` | Cycle Guided, Risk first, Small first, and File order. Your current hunk stays selected. |
| `D` | On a re-review, toggle between changed hunks and the whole tour. |
| `R` | Rebuild the tour on a newer PR head after the author pushes. |
| `i` | Open the team's checklist for this chapter. |
| `o` | Open the current review context in Claude Code. |
| `b` / `s` / `h` / `q` | Return to the briefing (description and overview diagram), open submit, show key help, or quit. `b` also works while the test pane has focus. |

A diagram can also open as SVG in your browser with `b`. Changed nodes are highlighted; selecting a node with `Tab` and pressing `Enter` jumps to its hunk when it has one.

### Tests, risk, and review prompts

Test links use available coverage data, symbol names found in test cases, and naming conventions. A symbol name in a test is a possible link, not proof that the test ran or called that specific declaration. Only execution coverage marks a hunk tested; name matches and filename guesses mark it partial. If a test changes without its subject code changing, the test-only chapter can show that unchanged code beside it.

When a linked test case is new or modified in the PR, the Tests pane shows its diff with `+` and `-` lines and a colored `new` or `modified` badge. An unchanged linked case still shows its current source.

Possible test gaps appear as a short line in the hunk explanation. Press `U` to see the full notes, including branches or behaviors the agent could not link to a test; press it again to collapse them. These are review leads, not proof that a test is absent.

Risk scores call attention to changes involving authentication, payments, migrations, public APIs, concurrency, command execution, error handling, and similar areas. The briefing may flag risky code without linked tests, possible generated-file or lockfile mismatches, and likely missing migrations, changesets, environment examples, translations, documentation, or feature flag checks. These are prompts to inspect, not conclusions that the PR is wrong. The model can raise a hunk's static risk score but never lower it, so text in a PR cannot talk the tour into downplaying a risky change.

Repo checklists are pre-checked by the agent as pass, fail, or unknown; use `i` to confirm each item yourself. Confirmations are saved locally and shown on the submit screen as a reminder; they are not posted to GitHub.

## Draft and submit comments

Select a line or range and press `c`, or press `C` for a chapter-level comment. Diagram nodes can also anchor comments. A comment remains a local draft until you submit a review.

In the comment editor:

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Complete an `@username` if suggestions appear; otherwise cycle through blocking, question, suggestion, and nit labels. |
| `Enter` / `Shift+Enter` | Save the draft or insert a newline. |
| `Ctrl+G` | For a line or range comment, edit a GitHub code suggestion in `$EDITOR`. |
| `Ctrl+D` | Remove a code suggestion. |
| `Esc` | Cancel the editor. |

Press `s` to review your drafts in a popup over the current briefing or chapter. It groups them by label, shows unread and deferred work, and proposes **Approve**, **Comment**, or **Request changes** from your drafts and progress. You can edit or delete drafts, change the verdict with `a`/`c`/`r`, and add a review summary with `b`. Press `P`, then confirm, to post all pending drafts as **one GitHub review**. Nothing posts while you are drafting or navigating.

If a draft's original line is no longer in the diff, Guided Review attaches it to the nearest available diff line or places it in the review body, then tells you what moved. Flow-level comments are summarized in the review body as well as anchored to a relevant changed line when one exists.

## Review after a new push

Guided Review checks for a new PR head while you review and offers `R` to rebuild on it. It keeps your drafts and reading state. A new tour can start in **delta-only** mode, showing hunks that are new or changed since the previous head; press `D` to show the whole tour.

The briefing also compares your posted comments and GitHub threads with the new diff. It reports whether the commented lines changed, the file was deleted, or a thread was resolved. A changed line is a reason to re-check the author's update, not proof that the concern is fixed. Drafts whose original hunk disappeared are flagged for review.

## Preview your own branch

Run `gr preview` on your branch before you open a PR to see the tour a reviewer would get. It compares your checkout, including uncommitted changes, with its merge base on the repository's default branch. The commit messages since that merge base stand in for the PR description. Preview works without `gh`.

To find the default branch, `gr preview` tries these in order and uses the first that exists:

1. `origin/HEAD`, which `git clone` records.
2. The repository's default branch on GitHub.
3. The branch origin's `HEAD` points to, asked with `git ls-remote`. This covers clones made with `git init` and `git remote add`, and remotes that aren't on GitHub. It gives up after a few seconds and never prompts for credentials.
4. `origin/main`, `origin/master`, local `main`, then local `master`.

For each name found in steps 1 to 3, origin's copy is preferred over your local branch. Your git `init.defaultBranch` setting is ignored, because it describes new repositories you create, not the repository you contribute to.

If the tour includes changes that aren't yours, your copy of the default branch is probably out of date: run `git fetch` and preview again. To make step 1 work offline, run `git remote set-head origin --auto`.
