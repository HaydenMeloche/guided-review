---
name: release-notes
description: Draft release notes for the next Guided Review release from the commits on master since the last tag, and recommend a major, minor, or patch version bump. Use when the user asks for release notes, a changelog, or what the next version should be.
---

# Release notes

Draft the notes for the next GitHub release: everything on the latest master since the most recent tag. Leave out commits users won't notice. Recommend the version bump at the end.

## 1. Find the range

```sh
git fetch origin --tags
git describe --tags --abbrev=0 origin/master   # last tag, e.g. v0.2.0
git log --reverse --format='%h %s%n%b' <tag>..origin/master
```

Use `origin/master` so the notes cover what has been pushed, not just the local checkout. If there is no remote, use `master`. If no tag exists, say so and stop.

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

Follow the style of past releases (`gh release view <tag>` shows the last one):

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

1. The range covered (`v0.2.0..origin/master`, N commits).
2. The release notes as a Markdown block they can paste into the GitHub release.
3. The recommended version (`0.2.0` → `0.3.0`) and one or two sentences on why, naming the change that decided it.
4. A short list of the commits you skipped, so they can check that nothing user-visible was left out.

Don't tag, bump `package.json`, or create the release. Publishing a GitHub release triggers the npm publish workflow, so the user does those steps themselves.
