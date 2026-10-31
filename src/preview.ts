import path from 'node:path';
import { currentRepo } from './github/gh.js';
import { commitWorktree, defaultBaseRef, localRepoRoot, mergeBaseOf, prDiff } from './git/worktree.js';
import { git } from './git/git.js';
import type { PRInfo } from './types.js';

// A tour of a local branch: `gr preview`, or l on the PR list; or of any two points in its history: `gr diff`.
export interface LocalPreview {
  pr: PRInfo;
  diff: string;
  worktree: string;
  copy?: boolean; // the worktree is gr's checkout of a commit (gr diff a..b), not the reader's own
}

// What to compare. With nothing set, the working tree against its merge base with the default
// branch. `base` names another branch or commit to compare with; `mergeBase: false` compares with
// it exactly, as `git diff <base>` does. `head` compares two commits instead of the working tree.
export interface LocalTarget {
  base?: string;
  mergeBase?: boolean;
  head?: string;
}

// `gr diff` arguments: a revision (the working tree against it), `a..b` (two commits), or
// `a...b` (b against its merge base with a).
export function parseDiffTarget(spec: string): LocalTarget {
  const three = spec.split('...');
  if (three.length === 2) return { base: three[0] || 'HEAD', head: three[1] || 'HEAD' };
  const two = spec.split('..');
  if (two.length === 2) return { base: two[0] || 'HEAD', head: two[1] || 'HEAD', mergeBase: false };
  return { base: spec, mergeBase: false };
}

// A commit a ref names, or an error that says which ref was not found.
async function commitOf(root: string, ref: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim();
  } catch {
    throw new Error(`no commit named ${JSON.stringify(ref)} in this repository.`);
  }
}

// The target at `cwd` as a PR numbered 0: its commits since the base, and its diff. Without a
// head, the diff is of the working tree, so it includes uncommitted changes. Throws when `cwd` is
// not in a git repository or there is no base to compare with. `repo` names the repository
// instead of asking its remotes or gh.
export async function localPreview(cwd: string, repo?: string, target: LocalTarget = {}): Promise<LocalPreview> {
  const root = await localRepoRoot(cwd);
  if (!root) throw new Error('not inside a git repository.');
  const trim = (s: string) => s.trim();
  // Independent lookups run together; only the merge base waits for the base.
  // Preview works without gh: an unknown repo becomes local/<dir> below.
  const repoP = repo ? Promise.resolve(repo) : currentRepo(root).catch(() => undefined);
  const headRev = target.head ?? 'HEAD';
  const headP = commitOf(root, headRev);
  const branchP = target.head ? Promise.resolve(target.head) : git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then(trim);
  const base = target.base ? { name: target.base, ref: target.base } : await defaultBaseRef(root, () => repoP);
  if (!base) throw new Error('could not find the default branch to compare against (no origin/HEAD, no answer from origin, and no main or master).');
  const baseSha = target.mergeBase === false ? await commitOf(root, base.ref) : await mergeBaseOf(root, headRev, base.ref);
  if (!baseSha) throw new Error(`could not find the merge base with ${base.ref.replace(/^refs\/(remotes\/|heads\/)/, '')}.`);
  const [headSha, branch, currentRepoName] = await Promise.all([headP, branchP, repoP]);
  const name = currentRepoName ?? `local/${path.basename(root)}`;
  // Two commits are read from gr's own checkout of the second, so the working tree is left alone.
  const worktree = target.head ? await commitWorktree(root, name, headSha) : root;
  // The working tree is diffed as it is: the author is still shaping the branch.
  const [log, diff] = await Promise.all([git(root, ['log', '--format=%H%x00%B%x1e', `${baseSha}..${headSha}`]).then(trim), target.head ? prDiff(root, baseSha, headSha) : prDiff(root, baseSha)]);
  const commits = log
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, message] = c.split('\0');
      return { sha, message: message ?? '' };
    });
  const title = target.head
    ? `${base.name}${target.mergeBase === false ? '..' : '...'}${target.head}`
    : target.mergeBase === false
      ? base.name === 'HEAD'
        ? 'Uncommitted changes'
        : `Changes since ${base.name}`
      : target.base
        ? `${branch} (preview against ${base.name})`
        : `${branch} (preview)`;
  return {
    worktree,
    ...(target.head ? { copy: true } : {}),
    diff,
    pr: {
      repo: name,
      number: 0,
      title,
      body: commits.map((c) => c.message).join('\n\n'),
      url: '',
      author: 'you',
      baseRef: base.name,
      headRef: branch,
      baseSha,
      headSha,
      commits,
      linkedIssues: [],
    },
  };
}

// What l on the PR list would tour, read cheaply so the list can offer it only when there is
// something to see.
export interface LocalChanges {
  branch: string;
  base: string; // the default branch, as origin/main when it is origin's copy
  commits: number; // since the merge base
  files: number; // differing from the merge base, uncommitted and untracked ones included
  uncommitted: boolean;
}

// The default branch, looked up once per repository: the lookup can ask GitHub or origin.
const bases = new Map<string, Promise<{ name: string; ref: string } | undefined>>();

// Undefined when nothing differs from the default branch, or there is no base to compare with.
export async function localChanges(cwd: string): Promise<LocalChanges | undefined> {
  const root = await localRepoRoot(cwd);
  if (!root) return undefined;
  let base = bases.get(root);
  if (!base) bases.set(root, (base = defaultBaseRef(root, () => currentRepo(root).catch(() => undefined))));
  const ref = await base;
  if (!ref) return undefined;
  const mergeBase = await mergeBaseOf(root, 'HEAD', ref.ref);
  if (!mergeBase) return undefined;
  const [branch, commits, changed, status] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-list', '--count', `${mergeBase}..HEAD`]),
    git(root, ['diff', '--name-only', '-z', '--no-ext-diff', mergeBase, '--']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ]);
  const untracked = status
    .split('\0')
    .filter((e) => e.startsWith('?? '))
    .map((e) => e.slice(3));
  const files = new Set([...changed.split('\0').filter(Boolean), ...untracked]).size;
  if (!files) return undefined;
  return { branch: branch.trim(), base: ref.ref.replace(/^refs\/(remotes\/|heads\/)/, ''), commits: Number(commits.trim()) || 0, files, uncommitted: !!status };
}
