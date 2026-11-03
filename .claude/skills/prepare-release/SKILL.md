---
name: prepare-release
description: Draft release notes for the next Guided Review release from the commits on master since the last tag, recommend a major, minor, or patch version bump, then offer to bump the version, push master and the tag, and create a draft GitHub release. Use when the user asks to prepare or cut a release, or for release notes, a changelog, or what the next version should be.
---

# Prepare a release

Draft the notes for the next GitHub release: everything on the HEAD of `master` since the last tag created. Leave out commits users won't notice. Recommend the version bump, then offer to bump the version, push master and the new tag to GitHub, and create a draft release.

## 1. Find the range

```sh
git fetch origin --tags
git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags   # <last-tag>, e.g. v0.4.0
git merge-base --is-ancestor <last-tag> master   # must succeed
git rev-list --left-right --count origin/master...master   # behind / ahead
git log --reverse --format='%h %s%n%b' <last-tag>..master
```

Always compare the HEAD of local `master` with `<last-tag>`, the most recently created tag. Don't pick a tag any other way (not `git describe`, not the highest version number, not the latest GitHub release), and use this same `<last-tag>` in every later step. If `<last-tag>` isn't an ancestor of `master`, report it and stop.

Use local `master`, since step 6 may push it. If local `master` is behind `origin/master`, tell the user to pull first and stop. If it is ahead, the unpushed commits belong in the notes; say how many there are in the report. If there are no tags, say so and stop.

If the range is empty, report that master has nothing new since the tag and stop.

## 2. Sort the commits

Read each commit's subject and body. If the purpose isn't clear from those, look at the diff (`git show --stat <sha>`, then `git show <sha>`). Put each commit in one bucket:

- **Feature**: a new command, flag, key binding, view, config option, or behaviour a user can try.
- **Improvement**: an existing feature that now works better, faster, or more clearly.
- **Fix**: a bug a user could have hit.
- **Skip**: anything a user won't notice. This includes CI and workflow files, formatting, lint, refactors that don't change behaviour, test-only changes, dependency bumps with no visible effect, docs-site and website changes, release plumbing, and reverts of commits that never shipped.

When you're unsure whether something is user-visible, check whether it changes `src/` behaviour, the CLI, `action.yml`, the `claude/` or `codex/` skills, or the published package. If it changes none of these, skip it.

Merge commits that describe one change. Split a commit that does several user-visible things into separate entries.

## 3. Write the notes

Follow the style of past releases (`gh release view <last-tag>` shows the last one):

```markdown
## Highlights

- **Short bold name** – one or two sentences on what the user can now do and how (key, command, flag).

## Improvements

- One line per change, written from the user's side.

## Fixes

- What was wrong, and that it no longer happens.
```

- Highlights are the features worth announcing. Smaller features go under Improvements.
- Write for users, not contributors. Describe behaviour, not code. Don't use commit hashes, file paths, or function names.
- Name the actual key, command, or option (`+` / `-`, `guided-review open --preview`).
- Leave out any section that has no entries.

## 4. Recommend the version

Read the current version from `package.json`. Base the bump on the most significant change you kept:

- **Major**: a breaking change, meaning existing usage stops working or behaves differently. Examples: a removed or renamed command, flag, or config key; a changed `action.yml` input or output; a raised minimum Node version; a changed config file format.
- **Minor**: at least one new feature, with nothing breaking.
- **Patch**: only fixes and small improvements.

While the version is `0.x`, follow the semver convention for initial development. Breaking changes bump the minor version (`0.2.0` → `0.3.0`), and everything else bumps the patch version. Mention that `1.0.0` is an option if the user thinks the project is stable, but don't recommend it on your own.

## 5. Report

Give the user:

1. The range covered (`<last-tag>..master`, N commits, M of them not yet pushed).
2. The release notes as a Markdown block they can paste into the GitHub release.
3. The recommended version (`0.2.0` → `0.3.0`) and one or two sentences on why, naming the change that decided it.
4. A short list of the commits you skipped, so they can check that nothing user-visible was left out.

## 6. Offer to bump and push

After the report, ask the user with AskUserQuestion whether to bump the version, push, and create a draft release. Name the exact version and the commands in the question, and offer the other bump levels as options too. Don't run anything until they say yes.

On yes:

1. Check that you are on `master` and the working tree is clean (`git status --porcelain`). If not, stop and tell the user.
2. Run `pnpm check`. If it fails, stop and show the failure.
3. `npm version <x.y.z>`. This commits `package.json` with the version as the subject (as past bumps did, e.g. `0.4.0`) and creates the annotated tag `v<x.y.z>`.
4. `git push origin master`, then `git push origin v<x.y.z>`. Push only the new tag, not `--tags`.
5. Create a draft release with the notes from step 3: write them to a temp file (`mktemp`), then `gh release create v<x.y.z> --draft --verify-tag --title v<x.y.z> --notes-file <file>`.
6. Report the commit, the tag, and the draft release's URL from `gh`'s output.

Always pass `--draft`, and never publish the release (no `gh release edit --draft=false`). Publishing triggers the npm publish workflow, and the Marketplace listing for `action.yml` can only be ticked in the GitHub web form, so the user reviews the draft and publishes it there. Pushing the tag and creating a draft don't publish anything.
