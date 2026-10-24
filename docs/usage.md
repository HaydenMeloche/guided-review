# Using Guided Review

How to pick a PR, read a tour, ask questions, draft comments, review again after a push, respond to the review on your own PR, merge, and preview your own branch. For installation and setup, see the [README](../README.md).

## Moving around

The same three keys move you back on every screen:

- `Esc` closes the innermost thing that is open: a range selection, a filter, a popup. With nothing open it goes up one level, from a chapter to the briefing and from the briefing to the PR list. It never quits.
- `q` goes up one level, like `Esc` with nothing open. On the PR list, and on the briefing of an author preview (which has no list), it quits.
- `Q` quits from anywhere. If you have unposted drafts or queued replies, gr asks first; they stay saved for next time either way.

`?` lists the keys of the screen you are on, grouped by what they do (`h` works too, outside the diagram). The list scrolls with `j`/`k` on a short terminal. On the briefing and in a chapter, `Tab` turns to a second page that explains the marks: reading state, risk, test coverage, drafts, threads, and moved code. `Esc` closes it.

`?` used to ask the model; asking is now `a`, and reacting to a comment in a thread is `+`.

## Pick a PR

The picker lists your review requests under **Review requests**, grouped by repository. Press `/` to filter by repo, title, author, or label (`Esc` clears the filter, then the selection); `j`/`k` to move (`g`/`G` to the first or last PR); `Enter` to open; `o` to open the selected PR in a browser; `r` to refresh; or `L` to choose a [color theme](configuration.md#color-themes); `?` lists every key and `q` quits. The list also refreshes itself every two minutes, keeping your place. When the clipboard holds a PR link (for example, one copied from Slack), the picker offers it: `p` opens its tour (or, for your own PR, its [feedback](#respond-to-a-review)) and `x` dismisses it. Press `Space` to select PRs, `a` to select all PRs shown by the filter, and `d` to download the selected tours before opening them. With no selection, `d` downloads the highlighted tour. Downloads run one at a time and show progress in the picker; completed tours are cached for later opening. On a wide terminal, the preview shows the description, changed files, checks (failing and running ones by name), review decision, whether the PR is ready to merge, and whether a local tour or drafts already exist.

Below the review requests, **Your PRs** lists your own open PRs that need you: ones with unresolved threads, a review submitted since your latest commit, changes requested, ready to merge, or ready for review with nobody asked to review them (`no reviewers requested`; this applies only to repositories you don't own, so it stays quiet on your own). A line under them counts the rest, which wait on reviewers (drafts included); `w` shows them too, marked `waiting on review`, and hides them again. Each row says which, such as `2 open thread(s) · new review` or `✓ ready to merge`, colored so the state stands out: approved and ready to merge in green, changes requested in red, open threads in yellow. The row also says `✗ checks failing` or `● checks running`. gr reads up to 200 of your open PRs and says `Showing the first 200 of your open PRs.` when there are more. It reads the first 100 review threads of each PR, so a PR with more shows a count like `100+ unresolved`. `Enter` on one opens its feedback (see [Respond to a review](#respond-to-a-review)). `M` on any PR opens the [merge dialog](#merge-a-pr), and `c` its [checks](#checks). `A` on one of your PRs shows [who is asked to review it](#ask-for-reviews) and asks more people.

With nothing waiting on your review and no PRs of your own, the picker lists what you can run instead: `gr preview`, `gr review <number>`, and `gr feedback`. When the list can't load, it says what went wrong (gh not signed in, GitHub unreachable, a PR not found) and the step to take, such as `gh auth login`, with gh's own message under it.

For a PR, Guided Review fetches metadata, the diff, and existing review threads through `gh`. It checks out the PR head in a detached worktree under `~/.guided-review/worktrees/`. Your own working checkout is left alone. If the current repository is not the PR's repository, it uses a cached clone under `~/.guided-review/repos/`.

Run `gr cleanup` to remove managed PR worktrees and prune old tours. Tours are also pruned as they are saved: each PR keeps the three heads you opened most recently. `gr cleanup` also deletes tours you have not opened in 90 days (`--days <n>` to change it), and for a PR left with no tour, its reading state, position, chapter moves, checklist confirmations, thread triage, and posted drafts. Unposted drafts, queued replies, and cached repository clones are always kept. Git refuses to remove a worktree with local changes, so the command reports and skips it.

## Read the tour

The **briefing** opens once it is ready; chapter narration may continue in the background, shown as a quiet spinner and count (`narrating 3/7`) at the right of the header. An explanation that arrives while you are on its hunk is marked `updated` for a moment. It shows the PR's intent and author description, recent reviewer feedback, flagged gaps, an overview diagram, chapters with risk, and your progress. Press `V` to read all submitted reviews. The chapter heading names the current order. Press `f` to cycle **Guided** (recommended reading path), **Risk first**, **Small first** (fewest changed lines), and **File** (path order). Select a chapter with `j`/`k` and `Enter`, or press `n` to resume where you left off (the key bar says where, such as `n resume · chapter 3, hunk 2/8`). Press `r` to read the full PR description, `d` for the overview diagram, or `a` to ask about the whole PR in a panel below the briefing. On a re-review, press `D` to switch between only the changes and the full review. Above the summary, a line says whether the PR is ready to merge and, if not, why; press `M` to [merge it](#merge-a-pr). Press `c` for the PR's [checks](#checks) and their logs. On your own PR, press `t` to switch to [its feedback](#respond-to-a-review). Press `s` for the [submit screen](#draft-and-submit-comments), `L` for a color theme, `?` for every key, and `q` to go back to the PR list.

An outdated review thread, one on lines a later push changed, shows where those lines are now: Guided Review follows the line from the commit the comment was written on to the current head.

The terminal's window title names the PR and where you are in it, such as `gr · acme/app#42 · chapter 3/7`, and goes back to your own title when you quit (in terminals that keep a title stack). In Ghostty, WezTerm, Windows Terminal, ConEmu, and iTerm2 3.6 or later, the tab or taskbar also shows progress while the tour builds and while chapter narration runs in the background, so you can work in another tab until it is done.

<p align="center"><img src="images/briefing.webp" alt="The briefing screen: a summary of the PR, the author's description, flagged gaps, an overview diagram, chapters in reading order, and blast radius" width="900"></p>

A **chapter** shows an explanation, code hunk, risk and test status, existing review threads, and linked tests. Wide terminals put code and tests side by side; narrow terminals let `t` toggle between them. Generated, vendored, and mechanical changes start collapsed into summaries. Import-only changes form an optional chapter that normal `n`/`p` navigation skips.

<p align="center"><img src="images/ask.webp" alt="A question about a changed line, answered inline below the code with file and line references" width="900"></p>

Press `a` on a selected line or range to ask about it. The model can read the rest of the repository, so answers cover code outside the diff and cite the files and lines they come from. Above, it finds that cancelling an order twice restocks its items twice, by following `release` into a file the PR does not touch.

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
| `e` | Open review threads on the selected line inline. Scroll with `j`/`k` or `J`/`K`; use `Tab` to select a comment and `+` to add or remove a reaction; press `Esc` to close. |
| `y` | Reply to a review thread on the selected line in the inline panel. `Enter` asks before posting to GitHub (`y` or `Enter` posts, any other key goes back to the reply), then says where the reply landed. `Ctrl+J` adds a line. |
| `E` / `X` | Edit or delete your unposted draft on the selected line (`X` asks first). The submit screen does the same for every draft with `e` / `x`. |
| `a` | Ask the agent about the selection in a panel below the selected line. Questions form a thread: press `Enter` again to ask a follow-up, and `↑`/`↓` to scroll. Press `Esc` to return to review. Off, and left out of the key bar, with no AI model or `--no-agent`. |
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
| `o` | Open your coding agent in the PR's checkout, with the hunk, your draft comments on its file, and the file's review threads as its first prompt. Choose the agent in `gr config` (Claude Code by default). |
| `b` / `s` | Return to the briefing (description and overview diagram), or open submit. `b` also works while the test pane has focus. |
| `?` / `h` | List every key, and on a second page (`Tab`) the marks. |
| `L` | Choose a color theme. `/` searches the list by name. Moving through the list applies each theme as the cursor stops, so the screen behind it shows what it looks like; `Enter` keeps it and saves it as `theme` in your config, and `Esc` goes back to the one you had. The PR list and the briefing take `L` too. See [Color themes](configuration.md#color-themes). |
| `Esc` / `q` / `Q` | Go back to the briefing (progress is saved), or quit Guided Review. `Esc` first clears a range selection. |

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
| `Tab` / `Shift+Tab` | Complete a mention or code reference if suggestions appear; otherwise cycle through blocking, question, suggestion, and nit labels. A label posts as a bold tag such as `**[nit]**` and groups the review; the label row says so. |
| `Enter` / `Ctrl+J` | Save the draft or insert a newline. `Shift+Enter` also inserts a newline in terminals that report it. |
| `@` | Mention someone or reference code. One list shows **People** (matching usernames, at once) and then **Code** (matching symbols, then files, with a preview of the highlighted one). With nothing typed yet, it lists a few people, then places you recently visited, then declarations in the PR's changed files. Filters such as `@callers:` and `@tests:` narrow the list (see [References](#reference-code-in-a-comment)), and `@path:84-96` refers to lines of a file directly. A path (`@src/stock.ts`) or a name ending in a file extension (`@stock.ts`) lists files only; `@Owner.method` still finds symbols. A mention of someone the list knows (the author, a reviewer or commenter, or a collaborator) is drawn in blue in comments and thread replies; an `@name` it does not know stays plain, a hint that it may not be a real user, and nothing inside code is highlighted. See [References](#reference-code-in-a-comment). |
| `Ctrl+T` | Have AI propose a code change for the selected lines, shown as a GitHub suggestion you can accept, refine, or discard. The composer lists it as `ctrl+t suggest a code change with AI` (`ctrl+t suggest a fix with AI`, or `ctrl+t AI fix`, when narrow). Works on line or range comments on new code; off with no AI model or `--no-agent`. See [AI code suggestions](#ai-code-suggestions). |
| `Ctrl+G` | For a line or range comment, edit a GitHub code suggestion in `$EDITOR`. On a chapter or diagram comment it says why it can't. |
| `Ctrl+D` | Remove a code suggestion. |
| `Esc` | Close the innermost layer: a suggestion list, the AI line, then the editor itself. If you have typed something, the editor first asks (`esc again to discard · enter to save`) and a second `Esc` within two seconds discards it. |

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

- **Type `@`** and part of a name. People come first and show at once; code results follow under **Code** as soon as the search returns (`searching…` until then). Code from files in the PR comes first, and a name that several declarations share is told apart by its kind, class, and path. While the list is open the comment takes the full width of the screen and most of its height (the tests pane steps aside until the list closes), so a highlighted code row shows a large preview beside the list (under it in a narrow terminal); a person shows none. `Tab` or `Enter` inserts `@username ` for a person, or the code span for the whole symbol or file. While the list is open, `←` and `→` belong to it rather than moving the text cursor: on a code row, `→` moves into the preview, where `j`/`k` (or `↑`/`↓`) and `J`/`K` move a line cursor, `v` starts or ends a range, and `Enter` inserts a reference to just those lines, such as `` `stock.ts:88-91` ``. `←` or `Esc` returns to the list; `Esc` again closes the list, and twice more discards the comment. Moving the text cursor onto an existing `@word` does not reopen the list. `@` opens the list only at the start of the text or after a space or `(`, so an email address does not.
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

Press `s` to review your drafts in a popup over the current briefing or chapter. It groups them by label, shows unread and deferred work, and proposes **Approve**, **Comment**, or **Request changes** from your drafts and progress. You can edit (`e`) or delete (`x`) drafts, change the verdict with `a`/`c`/`r`, add a review summary with `w`, and preview a draft exactly as it will be posted with `p`. Press `P`, then confirm, to post all pending drafts as **one GitHub review**. Nothing posts while you are drafting or navigating. `?` lists the screen's keys.

A draft that posting will change carries a dim note on its row in the submit screen: `moves to line 91` when its line is no longer in the diff, `posts on line 91 only` when its range spans more than one GitHub hunk, `suggestion posts as plain code` when GitHub could not apply it there (removed lines, a moved or split comment, or lines that changed since a new push), and `posts in the review body` when no line in the diff can take it. The note is computed the way posting builds the review, needs no key press, and never blocks posting. A suggestion written against an earlier head stays a suggestion when its lines read the same at the new head.

If a draft's original line is no longer in the diff, Guided Review attaches it to the nearest available diff line or places it in the review body, then tells you what moved. Flow-level comments are summarized in the review body as well as anchored to a relevant changed line when one exists.

## Review after a new push

Guided Review checks for a new PR head while you review and offers `R` to rebuild on it, in a yellow bar across the chapter screen. `Esc` folds the bar into a `↑ new head · R` tag in the header. Rebuilding keeps your drafts and reading state. A new tour starts in **changes only** mode, showing hunks that are new or changed since the previous head. The briefing says so just above the chapter list, which still shows every chapter: the unchanged ones are greyed, and each changed one says how many of its hunks changed. In a chapter, the header says `changes only`, the chapter list greys unchanged chapters, and the title says how many unchanged hunks are hidden. Press `D` on the briefing or in a chapter to switch to the full review and back.

The briefing also compares your posted comments and GitHub threads with the new diff. It reports whether the commented lines changed, the file was deleted, or a thread was resolved. A changed line is a reason to re-check the author's update, not proof that the concern is fixed. Drafts whose original hunk disappeared are flagged for review.

## Respond to a review

Run `gr feedback` on your branch (or `gr feedback 1234`, a URL, or `owner/repo#1234`) once reviews come in. It opens the feedback on your PR rather than a tour of your own code. `gr review` on your own PR asks which you want, and `Enter` on a PR under **Your PRs** in the picker opens it too. `gr feedback` needs no narrated tour: it uses one already built for this head (by you, a reviewer's `gr review`, or [CI](ci.md)), or builds a static one and opens on it at once. With a model configured, it then writes the tour's briefing (the summary of the PR and its chapter titles) behind the screen, which updates when it arrives; narrating each chapter is left for a later `gr review`.

### The feedback briefing

The first screen is laid out like the review briefing. On the left is the PR: whether it can merge and what blocks it (`M` merges), what it does, your description (`r` reads it all), and the feedback chapters. On the right is the feedback:

- since your last visit: threads your commits probably addressed, and new comments and who wrote them;
- each reviewer's standing verdict (an approval stays an approval after a later comment-only review), when they gave it, and whether that was before or after your latest commit, then who is asked to review and has not answered yet; `V` reads their review summaries, and `A` asks more people;
- the head commit's checks: failing and running ones by name, the rest as a count; `c` opens [the checks](#checks), and while any is running the list updates every 20 seconds;
- how many threads are open, replied (you have the last word, so it waits on a reviewer), probably addressed, and resolved, how many replies you have queued, and `g` to read the PR's general comments;
- with a model, three to six themes that group related comments across threads and reviewers.

On a terminal narrower than 120 columns, the feedback sits above the PR instead.

A feedback chapter is the tour chapter whose code the threads are on, so related threads stay together; its title also names the files its threads are on. Chapters with an open change request come first, then the tour's reading order; threads with no line in the diff go in **Elsewhere in the PR**. Inside a chapter, change requests come first. A thread's class comes from the label a `gr` reviewer posted (`**[blocking]**`, `**[nit]**`, …), or else from the model (change request, question, suggestion, nit, or praise); without either it counts as a change request. Probably addressed threads stay in their chapter, marked and listed after the others; resolved threads are hidden, and `H` shows them.

**Probably addressed** means the lines under the thread changed in a commit after it was written, the change is your PR's own (an update that only merged the base branch in does not count), and no reviewer has written in it since your latest commit. It is a prompt to check, not proof, and Guided Review never resolves a thread on its own.

Press `n` to start or resume, `Enter` to open the selected chapter (with no feedback to open, either says why: no reviews yet, reviews with no threads, or every thread resolved), `s` to send, `y` to [comment on the PR](#comment-on-the-pr), `t` for the full tour of the PR, `A` to [ask for reviews](#ask-for-reviews), `Y` to copy the PR's link, and `R` to read the feedback again. In the tour, `b` returns to its briefing, and `t` there brings you back to the feedback.

### Feedback keys

Each thread shows its state, class, your triage, the reviewers in it, where it is, the code it is on with the commented line marked, and the discussion. An outdated thread is followed to its line at the current head; if those lines were rewritten it goes to the nearest line that survived, and if they left the diff (or the commit it was written on is gone after a force push), the comment's own diff hunk is shown as it was.

When a comment links to a file in the PR's repository, such as the code references `gr` posts (`https://github.com/o/r/blob/<sha>/src/retry.ts#L10-L14`), the file shows on the right, read at the commit the link names: the linked lines, marked, with ten lines on each side (the top of the file for a link to the whole file). Several linked files stack one under another while they fit; when space runs short, the context around the last one shrinks so its linked lines still show. A link to a branch, or to a commit that is gone after a force push, shows the file at the PR head and says so. Links to other repositories are not previewed. Code a comment names without linking shows the same way: a class or function name (`PaymentsUtils`, `retryPolicy`, `PaymentsUtils.findBorrowers`), a name in backticks, or a source file name (`FacilitiesService.kt`). Each name is looked up in the PR's checkout at its head, and only an exact match shows, headed by the name that found it (`PaymentsUtils → src/…/PaymentsUtils.kt:76`); a class shows its declaration line, a function its first lines. Names in code blocks and URLs are not looked up, and a match on the thread's own lines is left out. The preview needs a terminal at least 110 columns wide; narrower, the status line counts the linked files instead.

| Key | Action |
| --- | --- |
| `n` / `p` | Next or previous thread, on into the next chapter. |
| `]` / `[` | Next or previous feedback chapter. |
| `j` / `k`, `J` / `K` | Scroll the discussion by a line or a page. `Tab` selects the next comment. |
| `y` | Write a reply. Replies are queued, not posted: `Enter` queues it, `Ctrl+R` marks the thread to resolve once the reply is sent, and `Esc` cancels. Press `y` again to edit a queued reply; an empty reply removes it. |
| `Ctrl+T` | In the reply editor, have the model draft a reply, shown as a proposal: `Enter` puts it in the editor for you to change and queue, `r` asks for changes, `Esc` discards it. What you have typed guides the draft. Off with no AI model or `--no-agent`. |
| `Space` | Cycle your triage: will do, done (fixed by hand, before the push that will mark it probably addressed), won't do, discuss, none. Triage stays on your machine and is never posted. Marking a thread won't do without a reply gets a reminder, since a dismissal with no reason usually brings a second round. |
| `Z` | Resolve or unresolve the thread on GitHub now, after you confirm. |
| `+` | React to the selected comment (`1`–`8` toggle a reaction). |
| `a` | Ask the model about the thread: "is this concern valid?", "what would the change look like?", "is this handled elsewhere?". The question includes the thread and its code. |
| `o` | Show the prompt for your coding agent to make the fix: the thread, the code it is on, and what to change, with the reviewer's text quoted as untrusted. `Enter` copies it to the clipboard (as `Y` does) for you to paste into your agent in your own checkout of the branch. gr never starts an agent from here: its PR worktree is a detached copy, so a fix made there would not be on your branch. |
| `e` | Give the discussion more of the screen, or the code back. |
| `l` | When the thread links to more files than fit beside it, move the preview on to the next. `Tab` to a comment starts the preview at the first file it links to. |
| `H` | Show or hide resolved threads. |
| `s` | Open the send screen. |
| `M` | Merge the PR. |
| `Y` | Copy the PR's link to the clipboard, here and on the feedback briefing. Without a clipboard tool (`pbcopy`, `wl-copy` or `xclip`, `clip.exe`), as over SSH, gr asks the terminal to copy it (OSC 52), which most terminals allow. |
| `L` | Change the color theme. |
| `R` | Read the feedback again, or after you push (gr notices within a minute), rebuild on the new head. Triage and queued replies are kept: they belong to the thread, not the commit. |
| `b`, `q`, `Esc` / `Q` | Return to the feedback briefing, or quit. |
| `?` / `h` | List the keys of the screen you are on: the feedback briefing, a thread, or the send screen. |

### Send

The send screen lists your queued replies and comment, which threads each reply will resolve, and a re-request for review. Nothing goes to GitHub until you press `P` and confirm. Then:

1. The replies post together as one comment review on your PR, so each reviewer gets one notification instead of one per reply. If you already have a pending review of your own on GitHub (one you started in the browser), GitHub takes no replies at all until you submit or discard it there, so gr says so and sends nothing. If any step of the batching fails, gr deletes its pending review and posts the replies one by one, and tells you why. The one exception is when the final submit step fails and the pending review turns out to be gone, which means it was submitted and only GitHub's answer was lost: then nothing is sent again, the replies stay queued, and gr asks you to check the PR (`Y` copies its link) before sending again. If a one-by-one send stops partway, the replies that did post leave the queue and the rest stay queued, so pressing `P` again never posts a reply twice.
2. Your queued [comment](#comment-on-the-pr) posts on the PR's conversation.
3. The threads marked resolve are resolved, after their replies, so no reviewer sees a thread resolved before its answer.
4. The reviewers ticked under **Re-request review** are asked to review again. Everyone who has reviewed is listed; the ones whose verdict asks for changes start ticked once every change request is resolved, replied to, probably addressed, or has a reply queued. Move onto a reviewer with `j`/`k` and press `r` to tick or untick them; `r` on a reply ticks everyone or no one.

On the send screen, `Esc` goes back to where you came from, `j`/`k` move through the replies and then the reviewers, `e` edits the selected reply or comment, `z` switches resolve after sending, `x` deletes it, and `r` ticks or unticks re-request. After you push, gr notices within a minute and `P` refuses to send until `R` reads the feedback again on the new head, so the replies go out as a review of the commit you see.

### Comment on the PR

A review summary has no thread to reply in, so on GitHub you answer one in the PR's conversation. Press `y` on the feedback briefing to write that comment. It lists the review summaries and conversation comments others wrote, newest first: pick one with `j`/`k` and `Enter`, and the comment starts by quoting it (its first lines) and mentioning its author, or pick **New comment** to start from nothing. `@` completes usernames as in a reply. `Enter` queues the comment, `Shift+Enter` adds a line, and `Esc` cancels.

One comment is queued per PR, so it can answer several reviewers: `y` again and another pick adds its quote below what you wrote. The comment posts with your replies when you send (`s`), and like them nothing goes to GitHub before `P` and a confirmation. An empty comment removes it from the queue.

### Ask for reviews

Press `A` on the feedback briefing, or on one of your PRs under **Your PRs** in the picker, to see who is asked to review the PR and has not answered yet, and each reviewer's standing verdict. Each change goes to GitHub as soon as you make it, and GitHub notifies whoever is asked:

- `a` (or `Enter`) asks more people. Type their usernames, with or without `@`, apart by spaces or commas; the list completes from the repository's collaborators and its past reviewers (listing collaborators needs push access, so on a fork you may have to type names in full). `@org/team` asks a team in the repository's organization; the list completes the organization's teams you can see as well, after `@` or once you type `org/`. `Enter` sends, `Esc` goes back.
- `x` withdraws the selected request, while it is still unanswered.
- `r` asks the selected reviewer to review again.

`j`/`k` select, and `Esc` closes. GitHub refuses people without access to the repository, and the PR's author; gr shows its answer.

## Checks

Press `c` in the picker, on a review briefing, or on the feedback briefing to see the PR head's checks: GitHub Actions jobs, other apps' check runs, and commit statuses. Failures come first, then checks still running, then the rest, each with how long it ran and whether it is required. As on GitHub, only each check's latest run counts: a job that failed and then passed on a re-run, or on a later run of its workflow, shows as passed. A workflow that runs on both `push` and `pull_request` lists each job twice, so those name the event. While any check is running, the list is read again every 20 seconds; `R` reads it now, and `?` lists the keys.

`Enter` on a GitHub Actions job reads its log in place. The log opens at its first error, with the output that led to it above, and the line above the log names the step you are in. `j`/`k` scroll, `d`/`u` move half a page (`PgDn`/`PgUp` a whole one), `g`/`G` go to the top or end, `n`/`N` jump to the next or previous error, `R` reads a running job's log again, and `Esc` returns to the list. Timestamps and colours are dropped from the log. Other checks have no log to read: `Enter` opens their page in the browser, and `o` opens any check's page.

## Merge a PR

Press `M` in the picker, on a review briefing, or anywhere in the feedback. The dialog shows whether the PR can merge, taken from GitHub (which knows the branch protection rules), with what blocks it: a draft, conflicts, a branch behind its base, changes requested, a missing approval, or required checks failing or still running. Failing optional checks, checks still running, and unresolved threads are warnings that don't block. You need write access to the repository to merge.

When the repository requires branches to be up to date and the PR's branch is behind its base, press `u` in the dialog to update it, if GitHub says you may (you can push to the branch). `Enter` merges the base into the branch, as GitHub's **Update branch** button does; `r` rebases the branch onto the base instead, which rewrites it, so anyone with it checked out has to reset to the new head. The update names the head the dialog read, so GitHub refuses it if someone pushed in the meantime. The dialog then reads the PR again, and its checks run again on the new head. On a branch that is behind, the briefing's readiness line says `M to update the branch`.

A draft PR can't merge. If it's yours, or you have write access, press `r` in the dialog to mark it ready for review after you confirm; GitHub notifies its requested reviewers, and the dialog reads the PR's state again. On a draft, the briefing's readiness line says `M to mark it ready for review`.

Choose the method with `m`, from those the repository allows: squash and merge, a merge commit, or rebase and merge. With a model, squash and merge-commit messages are drafted from the PR's title, description, commits, and (when its tour is open) the tour's summary; the dialog says the message is a draft, and `g` drafts it again. While the model writes it, the dialog shows no message and `P` waits for it; `x` stops the draft and uses GitHub's default message instead. Without a model, the message is GitHub's default. Edit the title with `e` and the body with `b`. Rebase and merge replays the PR's commits as they are, and GitHub takes no message for it, so none is shown. When the head branch is in the same repository and the repository doesn't delete merged branches itself, `d` deletes it after the merge. `?` lists the dialog's keys.

`P` merges after you confirm. The merge names the head commit the dialog read, so if someone pushes in the meantime, GitHub refuses it rather than merging code you haven't seen. Once merged, you're back on the PR list, and the PR is gone from it straight away.

## Preview your own branch

Run `gr preview` on your branch before you open a PR to see the tour a reviewer would get. It compares your checkout, including uncommitted changes, with its merge base on the repository's default branch. The commit messages since that merge base stand in for the PR description. Preview works without `gh`.

To find the default branch, `gr preview` tries these in order and uses the first that exists:

1. `origin/HEAD`, which `git clone` records.
2. The repository's default branch on GitHub.
3. The branch origin's `HEAD` points to, asked with `git ls-remote`. This covers clones made with `git init` and `git remote add`, and remotes that aren't on GitHub. It gives up after a few seconds and never prompts for credentials.
4. `origin/main`, `origin/master`, local `main`, then local `master`.

For each name found in steps 1 to 3, origin's copy is preferred over your local branch. Your git `init.defaultBranch` setting is ignored, because it describes new repositories you create, not the repository you contribute to.

If the tour includes changes that aren't yours, your copy of the default branch is probably out of date: run `git fetch` and preview again. To make step 1 work offline, run `git remote set-head origin --auto`.

## Commands and options

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
gr config                    # set up or change the model, GitHub access, and theme
gr cleanup                   # remove managed worktrees and prune old tours
```

`gr` needs an interactive terminal on both stdin and stdout, and checks for one before contacting GitHub. `gr open` opens the tour in a new tmux window (inside tmux) or a new Terminal window (macOS), and otherwise prints the command to run.

| Option | Purpose |
| --- | --- |
| `--no-agent` | Build a plain tour from static analysis, without model calls. Not for `build`, which needs a model. To always review without AI, choose **No AI model** in `gr config` instead. |
| `--fresh` | Rebuild the tour even if this head commit has a completed cached tour or a tour shared on the PR. |
| `--comment` | With `build`, post the tour to the PR as a comment. See [Share tours from CI](ci.md). |
| `--out <file>` | With `build`, write the tour JSON to a file, or `-` for stdout (the default without `--comment`). |
| `--preview` | With `open`, open `gr preview` of your local changes instead of a PR's tour. |
| `--days <n>` | With `cleanup`, delete tours not opened in this many days (default 90). |
| `--force` | With `install-claude-command` or `install-codex-skill`, replace an existing file that has different content. |

Providers, models, endpoints, and keys are not CLI options; they live in `~/.guided-review/config.json`. See [Configuration](configuration.md).

Set `GR_DEBUG=1` to print stack traces on errors, and `GR_DEBUG_MODEL` to log every model call (see [Debugging model calls](configuration.md#debugging-model-calls)).

Once a day, `gr` checks npm in the background for a newer version. Before a tour it opens an update screen with the release notes since your version: `Enter` installs the update and restarts `gr` where you were, `n` waits until tomorrow, and `s` skips that version. Other commands mention the update when they finish. It never checks in CI or for `gr build`. Set `GR_NO_UPDATE_CHECK=1` to turn it off.

What gr needs from your terminal, and what to set in tmux, is in [Terminals](terminals.md).

### Use from Claude Code or Codex

- **Claude Code:** `gr install-claude-command` installs a `/guided-review` command that previews your local changes: the current branch against its merge base with the default branch, uncommitted work included, with no PR needed. It runs `guided-review open --preview`, which opens `gr preview` in a new tmux window (inside tmux) or a new Terminal window (macOS), and otherwise prints the command to run. The command is only allowed to run `guided-review open --preview`. If `~/.claude/commands/guided-review.md` already exists with different content, the installer stops; pass `--force` to replace it.
- **Codex:** `gr install-codex-skill` copies a `guided-review` skill, which previews your local changes the same way, to `$CODEX_HOME/skills/` (or `~/.codex/skills/` when `CODEX_HOME` is unset); restart Codex afterwards. Running it again is safe. If that skill path contains different content, the installer stops so your edits are preserved; pass `--force` to replace it.
