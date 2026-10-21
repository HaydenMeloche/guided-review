---
name: dependabot-rollup
description: Combine all open Dependabot PRs into one commit on master, push it, comment on each PR with a link to the commit, and close them. Use when the user asks to roll up, combine, batch, or merge the Dependabot PRs.
---

# Dependabot rollup

Fold every open Dependabot PR into a single commit on master, then close the PRs. Commit on master directly; don't make a branch.

## 1. Check the starting state

```sh
git status -sb
git fetch origin
gh pr list --author app/dependabot --json number,title,headRefName,files \
  --jq '.[] | "\(.number)\t\(.title)\t\([.files[].path]|join(","))"'
```

The working tree must be clean apart from untracked files. If `package.json`, `pnpm-lock.yaml`, or `.github/` have uncommitted changes, stop and ask. If no PRs are open, say so and stop.

Local master may be ahead of `origin/master`. That's fine, but tell the user in step 6 that the push sends those commits too.

## 2. Collect the target versions

For each PR, note what it changes:

```sh
git diff origin/master...origin/<headRefName> -- package.json .github
```

- Workflow PRs change an action version in `.github/workflows/`.
- npm PRs change `pnpm-lock.yaml`, and sometimes a specifier in `package.json`.
- Group PRs (for example "Bump the dev-dependencies group with 4 updates") list every package and version in the body: `gh pr view <n> --json body --jq .body | grep '^Updates \`'`.

Write down each package's target version and which specifiers Dependabot changed in `package.json`.

## 3. Apply the updates

Don't merge the PR branches. Their lockfile changes conflict with each other. Make the changes yourself:

1. Edit the workflow files to the new action versions.
2. Save a copy of `package.json` in the scratchpad. Temporarily set every bumped package to its exact target version (no `^`) and run `pnpm install`. This resolves the lockfile to the versions Dependabot picked.
3. Restore the saved `package.json`, then apply only the specifier changes Dependabot made in `package.json`. Run `pnpm install` again. pnpm keeps the resolved versions because they still satisfy the ranges.

Check the result. `git diff package.json` should match Dependabot's `package.json` changes exactly. `git diff pnpm-lock.yaml` should show each package moving to its target version and nothing else unexpected. Mention any new transitive packages to the user.

## 4. Run the checks

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:e2e
```

If a check fails, stop and report the failure with its output. Don't commit, and don't edit `src/` to make a bump pass unless the user asks. Name the bump that most likely caused the failure.

## 5. Commit

Stage only `package.json`, `pnpm-lock.yaml`, and the changed workflow files. Use a plain subject and list the bumps in the body:

```
Update dependencies and GitHub Actions

Combines Dependabot PRs #12–#19:
- react 19.3.0 → 19.3.1
- actions/checkout v4 → v7
```

Leave "and GitHub Actions" out of the subject if no workflow changed. If only actions changed, say "Update GitHub Actions".

## 6. Push, comment, and close

Ask the user before pushing unless they've already said to push. Then:

```sh
git push origin master
URL="$(gh repo view --json url --jq .url)/commit/$(git rev-parse HEAD)"
for n in <pr numbers>; do
  gh pr comment "$n" --body "Included in $URL, which combines all the open Dependabot updates into one commit on master."
  gh pr close "$n"
done
```

Skip any PR that's no longer open. Report the commit link, the PRs you closed, and any other commits the push sent.
