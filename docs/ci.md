# Share tours from CI

A CI job can build the tour once and post it to the PR, so reviewers open it without spending their own model calls or waiting for narration. When `gr review` finds no cached tour for the PR head, it looks for one on the PR and uses it if it qualifies.

```yaml
# .github/workflows/guided-review.yml
name: Guided Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: guided-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  tour:
    # Fork PRs get no secrets and a read-only token.
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: HaydenMeloche/guided-review@v0.1.0
        with:
          provider: anthropic
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action has no default provider: set `provider` (or `config`, below) and pass the matching key. The example above uses the Anthropic API, where the model defaults to `claude-haiku-5-5`. To use OpenAI, set `provider: openai` and pass `OPENAI_API_KEY` instead:

```yaml
      - uses: HaydenMeloche/guided-review@v0.1.0
        with:
          provider: openai
          # model: gpt-6.1-sol  # optional; defaults to gpt-6-luna
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

To use Cursor, set `provider: cursor` and pass a Cursor API key (Cursor Dashboard → API Keys) as `CURSOR_API_KEY`. The model defaults to `grok-4.7` at low effort, Fast, with 256k context (Cursor's own default for it is Max Mode). Naming another `model` uses that model's default variant; for a specific one, pass the `config` input with `modelParams`:

```yaml
      - uses: HaydenMeloche/guided-review@v0.1.0
        with:
          provider: cursor
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
```

For any other setup, pass the `config` input (the contents of a `config.json`), which overrides `provider` and `model`. Claude Code and Codex logins aren't available in CI, so use an API-key provider, Bedrock, or Vertex there. Outside GitHub Actions, run `gr build <pr> --comment` with `GH_TOKEN` set and a config under `$GR_HOME`. `gr build` needs a model: with `--no-agent` or `"provider": "none"` it stops, because a tour without AI is the one each reviewer's `gr` builds for itself.

The tour travels gzipped inside a hidden part of one comment, which the job updates on each push. The comment leaves out the code: the reader fills in the diff lines from its own diff, and test and covered-code snippets from its own checkout of the head. A tour whose encoded size exceeds GitHub's 65,536-character comment limit is not posted: the job logs a warning and still succeeds, and reviewers build the tour locally as usual. A reader uses a shared tour only when all of these hold:

- the comment was written by `github-actions[bot]`, which only the repository's own workflows can post as;
- the tour is complete and was built for the PR's current head commit; and
- every file and hunk in it matches, line for line, the diff the reader fetched, so the code shown is the PR's code.

Otherwise the reader builds the tour itself. Review threads, reviews, and re-review deltas are still fetched and computed locally. Q&A runs on the reader's own model. `--fresh` ignores a shared tour.
