# Using Guided Review

How to pick a PR, read a tour, ask questions, draft comments, review again after a push, and preview your own branch. For installation and setup, see the [README](../README.md).

## Pick a PR

The picker groups review requests by repository. Press `/` to filter by repo, title, author, or label; `j`/`k` to move; `Enter` to open; `o` to open the selected PR in a browser; `r` to refresh; or `L` to choose a [color theme](configuration.md#color-themes). The list also refreshes itself every two minutes, keeping your place. When the clipboard holds a PR link (for example, one copied from Slack), the picker offers it: `p` opens its tour and `x` dismisses it. Press `Space` to select PRs, `a` to select all PRs shown by the filter, and `d` to download the selected tours before opening them. With no selection, `d` downloads the highlighted tour. Downloads run one at a time and show progress in the picker; completed tours are cached for later opening. On a wide terminal, the preview shows the description, changed files, checks, review decision, and whether a local tour or drafts already exist.

For a PR, Guided Review fetches metadata, the diff, and existing review threads through `gh`. It checks out the PR head in a detached worktree under `~/.guided-review/worktrees/`. Your own working checkout is left alone. If the current repository is not the PR's repository, it uses a cached clone under `~/.guided-review/repos/`.

Run `gr cleanup` to remove managed PR worktrees and prune old tours. Tours are also pruned as they are saved: each PR keeps the three heads you opened most recently. `gr cleanup` also deletes tours you have not opened in 90 days (`--days <n>` to change it), and for a PR left with no tour, its reading state, position, chapter moves, checklist confirmations, and posted drafts. Unposted drafts and cached repository clones are always kept. Git refuses to remove a worktree with local changes, so the command reports and skips it.

## Read the tour

The **briefing** opens once it is ready; chapter narration may continue in the background. It shows the PR's intent and author description, recent reviewer feedback, flagged gaps, an overview diagram, chapters with risk, and your progress. Press `V` to read all submitted reviews. The chapter heading names the current order. Press `f` to cycle **Guided** (recommended reading path), **Risk first**, **Small first** (fewest changed lines), and **File** (path order). Select a chapter with `j`/`k` and `Enter`, or press `n` to resume where you left off. Press `r` to read the full PR description, `d` for the overview diagram, or `?` to ask about the whole PR in a panel below the briefing. On a re-review, press `D` to switch between only the changes and the full review.

The terminal's window title names the PR and where you are in it, such as `gr · acme/app#42 · chapter 3/7`, and goes back to your own title when you quit (in terminals that keep a title stack). In Ghostty, WezTerm, Windows Terminal, ConEmu, and iTerm2 3.6 or later, the tab or taskbar also shows progress while the tour builds and while chapter narration runs in the background, so you can work in another tab until it is done.

<p align="center"><img src="images/briefing.webp" alt="The briefing screen: a summary of the PR, the author's description, flagged gaps, an overview diagram, chapters in reading order, and blast radius" width="900"></p>

A **chapter** shows an explanation, code hunk, risk and test status, existing review threads, and linked tests. Wide terminals put code and tests side by side; narrow terminals let `t` toggle between them. Generated, vendored, and mechanical changes start collapsed into summaries. Import-only changes form an optional chapter that normal `n`/`p` navigation skips.

<p align="center"><img src="images/ask.webp" alt="A question about a changed line, answered inline below the code with file and line references" width="900"></p>

Press `?` on a selected line or range to ask about it. The model can read the rest of the repository, so answers cover code outside the diff and cite the files and lines they come from. Above, it finds that cancelling an order twice restocks its items twice, by following `release` into a file the PR does not touch.

Typing `@` in a draft comment or thread reply suggests people with access to the repository, along with the PR author and existing reviewers. Press `Tab` to complete a suggested handle.

Static analysis finds entry points such as routes, commands, and handlers and links changed code through name-matched call references. These links are reading suggestions: the tool does not resolve imports, receivers, and scopes to prove a call target. Ambiguous changed targets are skipped. Shared code appears once and is linked from other chapters. The default Guided order ranks flows by the amount of changed code they reach, then the model can recommend a reading order; supporting and lower-priority changes follow. This is a reading path, not a strict risk ranking. If no entry point is found, the tour uses file order. TypeScript and JavaScript use the TypeScript compiler API; Python, Go, Kotlin, C, C++, Java, Ruby, and Rust use tree-sitter. Other source languages may use a lower-confidence regex fallback. JSON and YAML changes appear as configuration chapters. Test linking recognizes conventional Java, C/C++, and Ruby test cases as well as the existing JavaScript, Python, Go, and Kotlin cases. Press `f` on the briefing or in a chapter to change the order.

The diff viewer also highlights syntax for TypeScript, JavaScript, Python, Go, Kotlin, Java, Scala, Rust, Ruby, C#, Swift, C/C++, Objective-C, PHP, Elixir, Clojure, Dart, Lua, shell, SQL, JSON, YAML, TOML, XML, Markdown, CSS, SCSS, Less, HTML, Vue, Svelte, GraphQL, Protobuf, Terraform/HCL, Dockerfiles, and Makefiles using Shiki. It loads highlighting when a hunk opens and reads the old and new file versions so multiline strings and comments keep their color across hunks. Unknown file types remain readable as plain colored diff lines. Syntax highlighting does not change the language support of flow analysis.

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

Upgrade highlights and package overviews come from a changelog in the worktree when there is one, and otherwise from the model's own knowledge, because the model has no internet access. Those explanations are marked as inferred. Only hand-written logic and config files are moved into these chapters, so a test under `migrations/` stays with the tests. To move a file out of these chapters, classify it with a [`kinds` rule](repo-config.md#kinds). Without a model the chapters still appear, with the static file summary instead of an explanation.

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
| `E` / `X` | Edit or delete your unposted draft on the selected line (`X` asks first). The submit screen does the same for every draft with `e` / `x`. |
| `?` | Ask the agent about the selection in a panel below the selected line. Questions form a thread: press `Enter` again to ask a follow-up, and `↑`/`↓` to scroll. Press `Esc` to return to review. Off, and left out of the key bar, with no AI model or `--no-agent`. |
| `t` | Focus linked tests; narrow terminals toggle source and tests. Long code lines wrap in both panes. When linked tests are not beside the code, a `◂ 2 tests · t` tab at the top right says so. |
| `T` | Hide or show the test pane beside the code, to give the diff the full width. `t` still opens the tests when the pane is hidden. |
| `U` | Expand or collapse details about possible untested behavior and missing test links. |
| `d` | Open the chapter diagram. Select a node to jump to its code or comment on it. |
| `r` | Toggle the raw unified diff. |
| `S` | Switch between inline and split view, with old code on the left and new code on the right. A removed line sits on the same row as the line that replaces it. The choice is saved as `splitDiff` in your config. When the terminal is too narrow for a split diff beside the tests, the tests move behind the `◂ tests · t` tab. In split view, a comment on a replaced line goes on its new side; switch to inline to comment on the removed line itself. |
| `+` / `-` | Show 10 more or 10 fewer lines of the file above and below the hunk, up to the file's edges and the neighbouring hunks. Added lines are dimmed: they are not part of the PR's diff, so GitHub cannot take a comment on them. |
| `w` | Hide or show whitespace-only changes (hidden by default; the choice is saved as `hideWhitespace` in your config). A line that was only reindented shows once, marked `~`. Either way, changed words within a line are highlighted, and a line that only gained words shows once with the additions in green. |
| `x` / `z` / `u` | Mark a hunk skipped, deferred, or unread. |
| `m` | Move the current hunk to another chapter. |
| `f` | Cycle Guided, Risk first, Small first, and File order. Your current hunk stays selected. |
| `D` | On a re-review, switch between only the new and changed hunks and the full review. The header shows which one you are in. |
| `R` | Rebuild the tour on a newer PR head after the author pushes. |
| `i` | Open the team's checklist for this chapter. |
| `o` | Open the current review context in Claude Code. |
| `b` / `s` / `h` | Return to the briefing (description and overview diagram), open submit, or show key help. `b` also works while the test pane has focus. |
| `L` | Choose a color theme. `/` searches the list by name. Moving through the list applies each theme as the cursor stops, so the screen behind it shows what it looks like; `Enter` keeps it and saves it as `theme` in your config, and `Esc` goes back to the one you had. The PR list and the briefing take `L` too. See [Color themes](configuration.md#color-themes). |
| `q` / `Q` | Go back to the PR list (progress is saved), or quit Guided Review. In an author preview of a local branch there is no list, so `q` quits. |

Hunks in a file that are at most six unchanged lines apart are shown as one hunk, with the lines between them read from the PR head and dimmed. GitHub's diff splits them, so code moved a short distance would otherwise appear as an unrelated addition and removal. A block of three or more lines removed in one place and added unchanged in another (indentation aside) is marked with where its other half is, for example `↕ 7 lines moved from line 66`. Marking errs toward leaving code unmarked: a block needs a line of real text that the PR removes or adds only once, so common lines such as `if err != nil {` never pair on their own, and text that a changed file keeps elsewhere is treated as boilerplate. Imports and license headers that follow a file being replaced or split are not marked. Between files, a block must be whole declarations or a longer run of code, unless the PR is already moving code between those two files. Lines removed from several places and added in one are marked `merged`, lines added in several places `copied`, and a block that only changed its indent where it was `re-indented in place`. A move split by a small edit gets one note, for example `↕ 13 lines merged into loanids.go:27, split by 2 other lines`.

A diagram can also open as SVG in your browser with `b`. Changed nodes are highlighted; selecting a node with `Tab` and pressing `Enter` jumps to its hunk when it has one.

### Tests, risk, and review prompts

Test links use available coverage data, symbol names found in test cases, and naming conventions. A symbol name in a test is a possible link, not proof that the test ran or called that specific declaration. Only execution coverage marks a hunk tested; name matches and filename guesses mark it partial. If a test changes without its subject code changing, the test-only chapter can show that unchanged code beside it.

When a linked test case is new or modified in the PR, the Tests pane shows its diff with `+` and `-` lines and a colored `new` or `modified` badge. An unchanged linked case still shows its current source.

Possible test gaps appear as a short line in the hunk explanation. Press `U` to see the full notes, including branches or behaviors the agent could not link to a test; press it again to collapse them. These are review leads, not proof that a test is absent.

Risk scores call attention to changes involving authentication, payments, migrations, public APIs, concurrency, command execution, error handling, and similar areas. Risky code without a linked test is marked on its hunk in the chapter. The briefing may flag possible generated-file or lockfile mismatches, and likely missing migrations, changesets, environment examples, translations, documentation, or feature flag checks. These are prompts to inspect, not conclusions that the PR is wrong. The model can raise a hunk's static risk score but never lower it, so text in a PR cannot talk the tour into downplaying a risky change.

Repo checklists are pre-checked by the agent as pass, fail, or unknown; use `i` to confirm each item yourself. Confirmations are saved locally and shown on the submit screen as a reminder; they are not posted to GitHub.

## Draft and submit comments

Select a line or range and press `c`, or press `C` for a chapter-level comment. Diagram nodes can also anchor comments. A comment remains a local draft until you submit a review.

In the comment editor:

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Complete a mention or code reference if suggestions appear; otherwise cycle through blocking, question, suggestion, and nit labels. |
| `Enter` / `Shift+Enter` | Save the draft or insert a newline. |
| `@` | Mention someone or reference code. One list shows **People** (matching usernames, at once) and then **Code** (matching symbols, then files, with a preview of the highlighted one). With nothing typed yet, it lists a few people, then places you recently visited, then declarations in the PR's changed files. Filters such as `@callers:` and `@tests:` narrow the list (see [References](#reference-code-in-a-comment)), and `@path:84-96` refers to lines of a file directly. A path (`@src/stock.ts`) or a name ending in a file extension (`@stock.ts`) lists files only; `@Owner.method` still finds symbols. A mention of someone the list knows (the author, a reviewer or commenter, or a collaborator) is drawn in blue in comments and thread replies; an `@name` it does not know stays plain, a hint that it may not be a real user, and nothing inside code is highlighted. See [References](#reference-code-in-a-comment). |
| `Ctrl+T` | Have AI propose a code change for the selected lines, shown as a GitHub suggestion you can accept, refine, or discard. The composer lists it as `ctrl+t suggest a code change with AI` (`ctrl+t suggest a fix with AI` when narrow). Works on line or range comments on new code; off with no AI model or `--no-agent`. See [AI code suggestions](#ai-code-suggestions). |
| `Ctrl+G` | For a line or range comment, edit a GitHub code suggestion in `$EDITOR`. |
| `Ctrl+D` | Remove a code suggestion. |
| `Esc` | Close the innermost layer: a suggestion list, the AI line, then the editor itself. |

A comment without references or a suggestion is stored and posted exactly as before.

### Reference code in a comment

A reference is an inline code span in your comment's text, such as `` `releaseInventory()` `` or `` `stock.ts:84-96` ``, that names a place you picked. It is drawn in cyan and points at a function, a declaration, a file, a range of lines, or an earlier review thread, pinned to the commit you saw, so the link keeps showing that code after the author pushes again. When the review is posted, each one becomes an inline link, for example ``[`releaseInventory()`](https://github.com/o/r/blob/<sha>/src/inventory/stock.ts#L84-L96)``; a thread reference links to its discussion. Nothing else is added to the comment. Other inline code, and anything in a fenced code block, is ordinary code and posts as you typed it. When the cursor is in or just after a reference, the line under the text says where it points (`→ src/inventory/stock.ts:84-96 @a1b2c3d`, `→ discussion on src/x.ts:12`). Delete the code span, or change its text, and the reference goes with it.

A reference's name depends on what it points at:

| Points at | Name |
| --- | --- |
| A function or method | `name()`, such as `releaseInventory()` |
| A class, type, interface, enum, or other declaration | `file#Name`, such as `stock.ts#RetryPolicy` |
| A file | its name, such as `stock.ts` |
| Lines of a file | `file:84-96`, or `file:84` for one line |
| A review thread | `thread:file:12` |

When two references in one comment would get the same name, the second names its file, then its full path, then a number: `stock.ts#releaseInventory()`, `src/legacy/stock.ts#releaseInventory()`, `src/legacy/stock.ts#releaseInventory()~2`. Names never contain spaces or backticks.

- **Type `@`** and part of a name. People come first and show at once; code results follow under **Code** as soon as the search returns (`searching…` until then). Code from files in the PR comes first, and a name that several declarations share is told apart by its kind, class, and path. While the list is open the comment takes the full width of the screen and most of its height (the tests pane steps aside until the list closes), so a highlighted code row shows a large preview beside the list (under it in a narrow terminal); a person shows none. `Tab` or `Enter` inserts `@username ` for a person, or the code span for the whole symbol or file. While the list is open, `←` and `→` belong to it rather than moving the text cursor: on a code row, `→` moves into the preview, where `j`/`k` (or `↑`/`↓`) and `J`/`K` move a line cursor, `v` starts or ends a range, and `Enter` inserts a reference to just those lines, such as `` `stock.ts:88-91` ``. `←` or `Esc` returns to the list; `Esc` again closes the list, and once more cancels the comment. Moving the text cursor onto an existing `@word` does not reopen the list. `@` opens the list only at the start of the text or after a space or `(`, so an email address does not.
- **Filters** narrow the list to one kind of place. A filter holds a colon, which no username can, so it never lists people:

  | Type | Lists |
  | --- | --- |
  | `@f:` or `@files:` | Files, matching the text after the colon. |
  | `@s:` or `@symbols:` | Declarations, matching the text after the colon. |
  | `@callers:` | Possible callers of the code you are commenting on: the call sites the tour found for the hunk's functions, or, when it found none, call sites of the declaration around the commented line. `@callers:name` lists call sites of `name`. Callers are found by name, not by resolving calls, so each is labelled "possible caller". |
  | `@tests:` | Tests linked to the commented change (name guesses last), and for a test, the code it covers. Text after the colon filters them. |
  | `@threads:` | Review threads already on the PR; text after the colon matches the path, author, or comments. A thread's comments show beside the list, and picking one references its discussion. |
  | `@recent:` | Places you stayed on for a second, commented on, asked about, or previewed during this session. |

  You don't need to remember them: typing the first two or more letters of a filter's name (`@thr`, `@ca`, `@te`) shows it in a **Filters** group at the top of the list, above people and code. `Tab` or `Enter` on it turns the query into the filter (`@threads:`) and keeps the list open on its results.
- **Under the list**, two dim lines say what you can do. The first lists the keys that work now: `tab insert · ↑↓ choose · → pick lines · esc close`, with `→ pick lines` only on a code row (and the `j`/`k`, `v`, `Enter`, `←` keys while you choose lines). The second lists the filters (`narrow with  f: files  s: symbols  callers:  tests:  threads:  recent:`, the filter names in cyan) until one is on, and then says what it shows, such as `possible callers of cancelOrder() · matched by name · backspace to clear filter`. A thread reply's `@` list mentions people only and shows just the first line.

### AI code suggestions

`Ctrl+T` asks the Q&A model to propose replacement code for the comment's lines. A `✦` line opens under the comment body, and the code above stays in view. Type an optional instruction and press `Enter`; while the model works the line shows its progress, and `Esc` stops it and returns to your instruction. The model sees the selected lines, the enclosing declaration, up to two linked tests, up to five possible callers, and the code your comment references.

The proposal appears in the composer as the anchored lines (`-`) and the replacement (`+`), marked **proposal · not verified**, with one line on why and a count of any assumptions, citations, and notes. It is checked for shape (no fences or diff markers, no surrounding lines, cited paths and lines exist in the checkout), but it is never compiled or run. Press `Enter` or `a` to accept it as the comment's suggestion, `r` to refine it (the instruction comes back for you to change, and the model sees its previous proposal), `e` to edit it in `$EDITOR` and accept, or `Esc` to discard it and keep whatever suggestion the comment had. After you accept, typing continues where your cursor was. The composer grows to show the proposal, up to most of the pane; a long one ends with how many more lines it has.

GitHub can apply a suggestion only to new-side lines within one diff hunk, so `Ctrl+T` explains on the same line why when the comment is on removed lines or a flow. Errors show there too: `Enter` retries and `Esc` returns to your instruction. With no AI model, `--no-agent`, or a plain tour, AI suggestions are off; `Ctrl+G` still lets you write one by hand.

Press `s` to review your drafts in a popup over the current briefing or chapter. It groups them by label, shows unread and deferred work, and proposes **Approve**, **Comment**, or **Request changes** from your drafts and progress. You can edit or delete drafts, change the verdict with `a`/`c`/`r`, add a review summary with `b`, and preview a draft exactly as it will be posted with `p`. Press `P`, then confirm, to post all pending drafts as **one GitHub review**. Nothing posts while you are drafting or navigating.

A draft that posting will change carries a dim note on its row in the submit screen: `moves to line 91` when its line is no longer in the diff, `posts on line 91 only` when its range spans more than one GitHub hunk, `suggestion posts as plain code` when GitHub could not apply it there (removed lines, a moved or split comment, or lines that changed since a new push), and `posts in the review body` when no line in the diff can take it. The note is computed the way posting builds the review, needs no key press, and never blocks posting. A suggestion written against an earlier head stays a suggestion when its lines read the same at the new head.

If a draft's original line is no longer in the diff, Guided Review attaches it to the nearest available diff line or places it in the review body, then tells you what moved. Flow-level comments are summarized in the review body as well as anchored to a relevant changed line when one exists.

## Review after a new push

Guided Review checks for a new PR head while you review and offers `R` to rebuild on it. It keeps your drafts and reading state. A new tour starts in **changes only** mode, showing hunks that are new or changed since the previous head. The briefing says so just above the chapter list, which still shows every chapter: the unchanged ones are greyed, and each changed one says how many of its hunks changed. In a chapter, the header says `changes only`, the chapter list greys unchanged chapters, and the title says how many unchanged hunks are hidden. Press `D` on the briefing or in a chapter to switch to the full review and back.

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
