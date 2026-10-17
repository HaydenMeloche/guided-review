# Configuration

Model providers, GitHub access, and `~/.guided-review/config.json`. For per-repository rules that a team commits, see [Repository configuration](repo-config.md).

## First run and `gr config`

The first time you run `gr` (or `gr review`, or `gr preview`), it opens setup before anything else: a short introduction, then a few full-screen steps. When you save, it carries on with the command you ran. `gr config` opens the same steps any time, starting from your current settings. Nothing is saved until the last step, and `q` on the first screen or `Ctrl+C` at any step leaves without saving. To skip setup for one review, pass `--no-agent`.

1. **Color theme:** keep your terminal's colors or pick one of 65 themes, with a live preview. The rest of setup shows in the theme you pick. See [Color themes](#color-themes).
2. **Model provider:** the Anthropic API, the OpenAI API, or Cursor (all three recommended, see below), Codex, an OpenAI-compatible endpoint, Claude on Amazon Bedrock, Claude on Google Vertex AI, or no AI model. Claude Code is listed too, but setup can't choose it for now. Setup first checks what this machine already has and lists it at the top with a ✓: a signed-in Codex CLI, an `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CURSOR_API_KEY` variable, Ollama or LM Studio running on its default port, or Bedrock or Vertex turned on for Claude Code. A provider it didn't find says what it looked for, such as `$ANTHROPIC_API_KEY not set`, so you know what to set. When a provider is found with everything it needs, `Enter` picks it with the default models, and `c` opens its details instead.
3. **Details**, when something is missing or you press `c`:
   - **Endpoint:** for a compatible endpoint, its API base URL including `/v1`, and whether it supports function calling. A local server that was found fills these in, and its first model becomes the default.
   - **API key:** read from an environment variable by default (you can change the name), or paste it to save it in `config.json`; `←`/`→` switch between them. A local compatible server can use no key. A pasted key is hidden. Codex uses its own login, and Bedrock and Vertex use your AWS or Google Cloud credentials, so none of them asks for a key.
   - **Models:** one for the briefing and chapter narration, and one for Q&A, chosen from a list with `←`/`→`. The OpenAI API offers the GPT-6 models (`gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`) and the Anthropic API the Claude 5 models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1, Opus 5, Sonnet 5, Fable 5); these lists are built into `gr`. For Cursor and compatible endpoints, setup asks the service which models it offers once it has the key or URL; if it can't, you type the ID. A Cursor model with settings shows them under it, such as Effort, Fast, and Context, and you choose each with `←`/`→`; setup says when Cursor doesn't offer a combination, and marks values only Max Mode uses. To use a model the list doesn't show, set it with `gr config --edit`. Claude Code, Bedrock, and Vertex default to `haiku` and `opus`. The Anthropic API defaults to `claude-haiku-5-5` and `claude-opus-5-5`. Codex and OpenAI default to `gpt-6-luna` and `gpt-6.1-sol`. Cursor defaults to Grok 4.7: at low effort and Fast for summaries and narration, and at high effort and standard speed for Q&A, both with 256k context.
   
   `↑`/`↓` move between fields, `←`/`→` change an option, and `Enter` moves on.
4. **GitHub access:** only when `gh` is missing or not signed in, or when your config already uses a token. See [GitHub access](#github-access).
5. **Finish:** a summary of what will be saved. Setup sends one short test request to each model and shows how long it took to answer, so a wrong key or model name shows up here instead of during your first review. With a token, it also signs in to GitHub once. `Enter` saves, even if a check failed; `b` goes back to fix it, and `r` checks again.

**Which provider to choose:** an Anthropic, OpenAI, or Cursor API key is recommended, and setup marks all three. `gr` calls these from its own process, and the Anthropic and OpenAI APIs stream their answers, so the briefing starts sooner and Q&A answers appear as they are written. Codex starts a separate `codex exec` process for every request, which adds startup time to each of the many requests a tour makes, and its answers arrive a whole message at a time. Codex is still a good choice if you'd rather use your ChatGPT plan than pay for API usage. The finish step shows how long each model took to answer, which gives a rough comparison.

Setup does not ask for the chapter order. A new config uses the guided order, and an existing one keeps its own; set `chapterOrder` in the file to change the default, or press `f` during a tour. Run `gr config --edit` to open the file in `$VISUAL`, `$EDITOR`, or `vi`, for example to set per-task overrides. `e` on setup's first screen does the same. `gr setup` is an alias for `gr config`.

Before a review starts, `gr` checks the config. If the file is invalid, it names the problem and tells you to run `gr config`. It also stops when a key it needs is missing, such as an unset variable named in `apiKeyEnv`.

## Reviewing without AI

Choose **No AI model** in `gr config` (it saves `"provider": "none"`) to review with static analysis only, without passing `--no-agent` each time. Every tour is a plain tour: files are classified, flows and chapters come from the code, tests are paired, risk and missing changes are flagged, and diagrams, comments, threads, re-review, and submitting all work as usual. Only the AI features are off: the briefing's written intent, chapter narration, Q&A (`?`), and AI code suggestions (`Ctrl+T`). Their keys are left out of the key bars and the help. Nothing is sent to a model. [`gr build`](ci.md) needs a model, so it stops with an error.

Your model, key, and per-task settings stay in `config.json`, with the provider they were for in `lastProvider`. To turn AI on again, run `gr config` and choose a provider: choosing the one you had starts from those settings.

## GitHub access

By default `gr` talks to GitHub through the GitHub CLI and your `gh auth login`. If `gh` is not installed or not signed in, setup explains the choice: install `gh` and sign in, or use a personal access token. With a token, `gr` calls the GitHub API over HTTPS itself and needs no `gh`.

- **Token:** create one at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens). A fine-grained token needs read access to Contents and Metadata and read and write access to Pull requests and Issues. A classic token needs the `repo` scope (and `read:org` for private organizations).
- **Team review requests:** when a PR asks one of your teams for review and a teammate reviews it first, GitHub drops the team's request, so the PR leaves GitHub's review-requested search. `gr` finds these PRs in your notifications from the last 14 days and keeps them in the [picker](usage.md#pick-a-pr) until you review them. That needs the notifications API, which `gh` and classic tokens can use but fine-grained tokens cannot, and your team list, which needs `read:org`. With a fine-grained token, the picker shows only what the search returns.
- **Where it lives:** an environment variable (default `GITHUB_TOKEN`) or a file, such as `~/.config/guided-review/github-token` with mode `600`. `config.json` records only the variable name or the path. Setup signs in once to check the token.
- **API URL:** defaults to `https://api.github.com`. For GitHub Enterprise Server, use `https://<host>/api/v3`. `gr` then reads remotes, PR URLs, and issue links on that host instead of `github.com`, so `gr review https://<host>/owner/name/pull/12` and a bare `gr` inside a clone both work.

With a token, `gr` also sends it to git as an HTTP header when it clones or fetches PR commits over HTTPS, through environment variables, so it never appears on a command line or in a clone's config.

The OpenAI provider uses the Responses API, which supports read-only repository tools. OpenAI-compatible endpoints use Chat Completions. Both need an API key from the OpenAI platform.

## Codex

The `codex` provider runs the [Codex CLI](https://github.com/openai/codex) (`codex exec`), so it uses whatever `codex login` set up: a ChatGPT plan or an API key. Setup lists Codex as found when `codex login status` says it is logged in.

Each run uses a Codex permission profile that can read only the PR worktree and its git directory, the Codex installation, common developer-tool locations (Homebrew, `/usr/local`, Xcode Command Line Tools), and the system paths Codex needs. It cannot write files or reach the network, your home directory is not readable, and git runs without your global or system git config. Approvals are off, and your `~/.codex/config.toml` and rules are ignored. This needs a Codex CLI with permission profiles; older versions refuse to start instead of running unconfined. That keeps your Codex MCP servers and hooks out of reviews, but it also means Codex's own model and provider settings don't apply. Set models in Guided Review's config; if you leave `model` out, Codex uses its default model. Q&A follow-ups resume the same Codex session. Answers appear one message at a time rather than streaming token by token.

## Cursor

The `cursor` provider runs a local agent through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): the agent loop runs inside `gr` against the PR worktree, and the models are Cursor's hosted ones. It needs a Cursor API key (Cursor Dashboard → API Keys), read from `$CURSOR_API_KEY` by default; without one, it falls back to a login stored by the Cursor SDK. Model IDs are the ones your Cursor account offers, such as `grok-4.7`, `composer-2.5`, or `default`. Most models also take settings (effort, speed, context), which `gr` sends as `modelParams`; setup lists them, and changing them rebuilds a cached tour.

All of Cursor's built-in tools (shell, edit, web, subagents) are turned off. The agent gets only `read_file`, `search_repo`, and `git_history`, the same worktree-confined tools as the API providers, and none of your `.cursor` rules, hooks, or MCP servers load. Q&A follow-ups resume the same Cursor agent.

## Color themes

By default `gr` uses your terminal's own colors, with the `rose-pine-moon` theme for code. It also offers every theme that ships with [shiki](https://shiki.style/themes), 65 in all, 21 of them light. A theme colors the whole interface, not only the code. It paints its own background behind the screen, so a light theme looks right in a dark terminal, and the other way round. Accents such as risk marks, the test status, and the added and removed line backgrounds take the theme's own code colors: a red mark uses the theme's red, from its keywords or wherever it uses one. Where the theme has no code color of that hue, the accent falls back to its terminal colors. Secondary text uses the theme's comment color. Section headings use its heading color, PR and chapter titles its function-name color, and a selected row its selection background. Diagrams follow the same colors. A box the PR changes is bold, with its frame in the heading color and its name in the title color. Unchanged boxes and arrows use the comment color. A diagram opened in the browser with `b` uses the theme too. With your terminal's colors it follows the browser's light or dark setting. All of them are adjusted where needed so they stay readable against the background.

Pick a theme in either of these places. Both show the list beside a sample of the briefing and a chapter with highlighted code, in the theme the cursor is on:

- **Setup:** its first step, full screen. The rest of setup then shows in the theme you chose.
- **`L` during a tour:** on the PR list, the briefing, or a chapter, as a popup. The real screen around it changes too. `Enter` saves your choice to `config.json`, and `Esc` restores the theme you had.

In the list, `j`/`k` (or the arrow keys) move and preview, and `Enter` chooses. Press `/` or `i` to search: typing filters the list by name, and `light` or `dark` keeps only those themes. Every word you type must match, so `git light` finds GitHub Light. While searching, `Esc` stops the search; otherwise it cancels.

Without a config file, a theme chosen with `L` lasts until you quit. Themes need a terminal with 24-bit color for the best match; on other terminals the colors are approximated.

## Config file

`~/.guided-review/config.json` is written with owner-only permissions (`0600`). Here is the default config, which uses Codex:

```json
{
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "chapterOrder": "guide",
  "roles": {
    "briefing": { "model": "gpt-6-luna" },
    "narration": { "model": "gpt-6-luna" },
    "qa": { "model": "gpt-6.1-sol" }
  }
}
```

| Field | Purpose |
| --- | --- |
| `provider` | Required: `claude-code`, `anthropic`, `codex`, `cursor`, `openai`, `openai-compatible`, `bedrock`, `vertex`, or `none` for [no AI model](#reviewing-without-ai). With `none`, the model, key, and role fields are kept for later but not used. |
| `lastProvider` | With `"provider": "none"`, the provider the kept model fields are for. `gr config` sets it. |
| `model` | The fallback model, used when a role sets none or a role override fails. |
| `baseUrl` | API base URL for `openai-compatible` (including `/v1`) or `anthropic`. Remote endpoints must use HTTPS; HTTP is allowed on localhost. |
| `apiKeyEnv` | Name of the environment variable holding the key. Defaults: `OPENAI_API_KEY` for OpenAI and compatible endpoints, `ANTHROPIC_API_KEY` for the Anthropic API. |
| `apiKey` | The key itself. It takes precedence over `apiKeyEnv`. Use it when an environment variable is impractical. |
| `modelParams` | Cursor only: the model's variant, as the parameter IDs and values Cursor lists, such as `{ "reasoning_effort": "low", "fast": "true", "context": "256k" }`. Without it, Cursor uses the model's default variant, which for some models is Max Mode, the most expensive. Set it beside `model`, at the top level or in a role; a role that names a different model doesn't inherit the top-level one. Setup writes it. |
| `maxOutputTokens` | Maximum output tokens per model response for the Anthropic API (default 16000). Lower it for models with smaller output limits. |
| `toolCalling` | Set `false` for a compatible endpoint that cannot call functions. Generation still receives the supplied diff, but Q&A is limited to the selected code. |
| `chapterOrder` | The chapter order a tour opens in: `guide` (default), `risk`, `size` (small first), or `file`. Also read with `--no-agent`. Press `f` during a tour to switch; a PR you have already opened reopens in the order you last used there. |
| `hideWhitespace` | Whether diffs hide whitespace-only changes (default `true`). Pressing `w` during a tour switches it and saves the choice here, so the next tour opens the same way. Also read with `--no-agent`. |
| `splitDiff` | Whether diffs show old and new code side by side (default `false`). Pressing `S` during a tour switches it and saves the choice here. Also read with `--no-agent`. |
| `theme` | The color theme: `terminal` (default, your terminal's own colors) or the name of one of [shiki's themes](https://shiki.style/themes), such as `nord`, `github-light`, or `catppuccin-mocha`. `gr config` and `L` during a tour pick it with a live preview. Also read with `--no-agent`. |
| `github` | Use a personal access token instead of `gh`: `{ "tokenEnv": "GITHUB_TOKEN" }` or `{ "tokenFile": "~/.config/guided-review/github-token" }`, plus an optional `"apiUrl"` (default `https://api.github.com`). Leave it out to use `gh`. See [GitHub access](#github-access). |
| `roles` | Per-task overrides for `briefing` (PR summary, chapter titles, overview), `narration` (each chapter's hunks), and `qa`. |

An OpenAI config that reads its key from a custom variable:

```json
{
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "apiKeyEnv": "WORK_OPENAI_KEY",
  "roles": {
    "briefing": { "model": "gpt-6-luna" },
    "narration": { "model": "gpt-6-luna" },
    "qa": { "model": "gpt-6.1-sol" }
  }
}
```

A local compatible server without a key:

```json
{ "provider": "openai-compatible", "model": "llama3", "baseUrl": "http://localhost:11434/v1" }
```

With function calling, compatible endpoints get read-only repository lookups: `read_file`, `search_repo`, and `git_history`. `search_repo` needs [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`. Q&A streams when the endpoint supports server-sent events.

## Choose models by task

A role override can set just a model, or another provider with its own connection and key. For example, this keeps Claude Code for summaries and narration, and uses OpenAI for Q&A:

```json
{
  "provider": "claude-code",
  "model": "opus",
  "roles": {
    "briefing": { "model": "haiku" },
    "narration": { "model": "haiku" },
    "qa": { "provider": "openai", "model": "gpt-6.1-sol", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

If a role override fails, that task falls back to the top-level provider and model. If you change the effective model or endpoint, the cached tour is rebuilt. Claude Code, Bedrock, and Vertex can't be mixed with one another in one run; each can be combined with the Anthropic API, Codex, Cursor, OpenAI, or a compatible endpoint. Agent repository tools are read-only. If the model is unavailable, the app falls back to a plain tour; `--no-agent` requests one directly, and `"provider": "none"` requests one every time.

## Cost

A tour makes one briefing call, then narrates chapters with up to six model calls in flight. Q&A makes one call per question. Cost grows with PR size, so to keep large PRs affordable:

- the briefing prompt is capped, listing a sample of each chapter's hunks;
- small, import-only, and low-risk supporting hunks get one shared chapter summary instead of a note each;
- lockfiles are sent as a list of parsed package changes, not as their diffs, and get one summary for the whole chapter;
- an interrupted tour resumes from the chapters it was missing.

With the Anthropic API, the system prompt, tools, and conversation so far are sent with prompt caching, so later turns of a narration are billed mostly at the cached-input rate. Claude Code, Bedrock, Vertex, and OpenAI cache automatically. Claude Code, Codex, and Cursor plans count tours against your plan's usage limits.
