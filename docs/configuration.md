# Configuration

Model providers, GitHub access, and `~/.guided-review/config.json`. For per-repository rules that a team commits, see [Repository configuration](repo-config.md).

## Run `gr config`

`gr config` walks you through setup in an interactive terminal:

1. **Provider:** Claude Code, the Anthropic API, Codex, Cursor, the OpenAI API, an OpenAI-compatible endpoint, Claude on Amazon Bedrock, or Claude on Google Vertex AI. You can instead open `config.json` in your editor.
2. **Endpoint:** for a compatible endpoint, its API base URL including `/v1`, and whether it supports function calling.
3. **Models:** one for the briefing and chapter narration, and one for Q&A. Claude Code, Bedrock, and Vertex default to `haiku` and `opus`. The Anthropic API defaults to `claude-haiku-5-5` and `claude-opus-5-5`. Codex and OpenAI default to `gpt-6-luna` and `gpt-6.1-sol`. Cursor defaults to `composer-2.5` for both.
4. **API key:** read it from an environment variable (you choose the name), or save it in `config.json`. A local compatible server can use no key. When you type a key, it is hidden. Claude Code and Codex use their own logins, and Bedrock and Vertex use your AWS or Google Cloud credentials, so none of them asks for a key.
5. **GitHub access:** asked only when `gh` is not installed, or when your config already uses a token. See [GitHub access](#github-access).

Run `gr config` again to change your setup. With an existing config, it shows your current settings and offers them as defaults. Run `gr config --edit` to open the file in `$VISUAL`, `$EDITOR`, or `vi`, for example to set per-task overrides. `gr setup` is an alias for `gr config`.

Before a review starts, `gr` checks the config. If the file is missing or invalid, it names the problem and tells you to run `gr config`. It also stops when a key it needs is missing, such as an unset variable named in `apiKeyEnv`.

## GitHub access

By default `gr` talks to GitHub through the GitHub CLI and your `gh auth login`. If `gh` is not installed, `gr config` explains the choice: install `gh`, or use a personal access token. With a token, `gr` calls the GitHub API over HTTPS itself and needs no `gh`.

- **Token:** create one at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens). A fine-grained token needs read access to Contents and Metadata and read and write access to Pull requests and Issues. A classic token needs the `repo` scope (and `read:org` for private organizations).
- **Where it lives:** an environment variable (default `GITHUB_TOKEN`) or a file, such as `~/.config/guided-review/github-token` with mode `600`. `config.json` records only the variable name or the path. `gr config` signs in once to check the token.
- **API URL:** defaults to `https://api.github.com`. For GitHub Enterprise Server, use `https://<host>/api/v3`. `gr` then reads remotes, PR URLs, and issue links on that host instead of `github.com`, so `gr review https://<host>/owner/name/pull/12` and a bare `gr` inside a clone both work.

With a token, `gr` also sends it to git as an HTTP header when it clones or fetches PR commits over HTTPS, through environment variables, so it never appears on a command line or in a clone's config.

The OpenAI provider uses the Responses API, which supports read-only repository tools. OpenAI-compatible endpoints use Chat Completions. Both need an API key from the OpenAI platform.

## Codex

The `codex` provider runs the [Codex CLI](https://github.com/openai/codex) (`codex exec`), so it uses whatever `codex login` set up: a ChatGPT plan or an API key. During setup, `gr config` checks that `codex` is installed and logged in.

Each run uses a Codex permission profile that can read only the PR worktree and its git directory, the Codex installation, common developer-tool locations (Homebrew, `/usr/local`, Xcode Command Line Tools), and the system paths Codex needs. It cannot write files or reach the network, your home directory is not readable, and git runs without your global or system git config. Approvals are off, and your `~/.codex/config.toml` and rules are ignored. This needs a Codex CLI with permission profiles; older versions refuse to start instead of running unconfined. That keeps your Codex MCP servers and hooks out of reviews, but it also means Codex's own model and provider settings don't apply. Set models in Guided Review's config; if you leave `model` out, Codex uses its default model. Q&A follow-ups resume the same Codex session. Answers appear one message at a time rather than streaming token by token.

## Cursor

The `cursor` provider runs a local agent through the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript): the agent loop runs inside `gr` against the PR worktree, and the models are Cursor's hosted ones. It needs a Cursor API key (Cursor Dashboard → API Keys), read from `$CURSOR_API_KEY` by default; without one, it falls back to a login stored by the Cursor SDK. Model IDs are the ones your Cursor account offers, such as `composer-2.5` or `auto`.

All of Cursor's built-in tools (shell, edit, web, subagents) are turned off. The agent gets only `read_file`, `search_repo`, and `git_history`, the same worktree-confined tools as the API providers, and none of your `.cursor` rules, hooks, or MCP servers load. Q&A follow-ups resume the same Cursor agent.

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
| `provider` | Required: `claude-code`, `anthropic`, `codex`, `cursor`, `openai`, `openai-compatible`, `bedrock`, or `vertex`. |
| `model` | The fallback model, used when a role sets none or a role override fails. |
| `baseUrl` | API base URL for `openai-compatible` (including `/v1`) or `anthropic`. Remote endpoints must use HTTPS; HTTP is allowed on localhost. |
| `apiKeyEnv` | Name of the environment variable holding the key. Defaults: `OPENAI_API_KEY` for OpenAI and compatible endpoints, `ANTHROPIC_API_KEY` for the Anthropic API. |
| `apiKey` | The key itself. It takes precedence over `apiKeyEnv`. Use it when an environment variable is impractical. |
| `maxOutputTokens` | Maximum output tokens per model response for the Anthropic API (default 16000). Lower it for models with smaller output limits. |
| `toolCalling` | Set `false` for a compatible endpoint that cannot call functions. Generation still receives the supplied diff, but Q&A is limited to the selected code. |
| `chapterOrder` | The chapter order a tour opens in: `guide` (default), `risk`, `size` (small first), or `file`. Also read with `--no-agent`. `gr config` asks for it. Press `f` during a tour to switch; a PR you have already opened reopens in the order you last used there. |
| `hideWhitespace` | Whether diffs hide whitespace-only changes (default `true`). Pressing `w` during a tour switches it and saves the choice here, so the next tour opens the same way. Also read with `--no-agent`. |
| `splitDiff` | Whether diffs show old and new code side by side (default `false`). Pressing `S` during a tour switches it and saves the choice here. Also read with `--no-agent`. |
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

If a role override fails, that task falls back to the top-level provider and model. If you change the effective model or endpoint, the cached tour is rebuilt. Claude Code, Bedrock, and Vertex can't be mixed with one another in one run; each can be combined with the Anthropic API, Codex, Cursor, OpenAI, or a compatible endpoint. Agent repository tools are read-only. If the model is unavailable, the app falls back to a plain tour; `--no-agent` requests one directly.

## Cost

A tour makes one briefing call, then narrates chapters with up to six model calls in flight. Q&A makes one call per question. Cost grows with PR size, so to keep large PRs affordable:

- the briefing prompt is capped, listing a sample of each chapter's hunks;
- small, import-only, and low-risk supporting hunks get one shared chapter summary instead of a note each;
- lockfiles are sent as a list of parsed package changes, not as their diffs, and get one summary for the whole chapter;
- an interrupted tour resumes from the chapters it was missing.

With the Anthropic API, the system prompt, tools, and conversation so far are sent with prompt caching, so later turns of a narration are billed mostly at the cached-input rate. Claude Code, Bedrock, Vertex, and OpenAI cache automatically. Claude Code, Codex, and Cursor plans count tours against your plan's usage limits.
