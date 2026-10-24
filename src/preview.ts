import path from 'node:path';
import { currentRepo } from './github/gh.js';
import { defaultBaseRef, localRepoRoot, mergeBaseOf, prDiff } from './git/worktree.js';
import { git } from './git/git.js';
import type { PRInfo } from './types.js';

// A tour of a local branch: `gr preview`, or l on the PR list.
export interface LocalPreview {
  pr: PRInfo;
  diff: string;
  worktree: string;
}

// The branch checked out at `cwd` as a PR numbered 0: its commits since the merge base with the
// default branch, and a diff of the working tree against that base. Throws when `cwd` is not in
// a git repository or there is no base to compare with.
export async function localPreview(cwd: string): Promise<LocalPreview> {
  const root = await localRepoRoot(cwd);
  if (!root) throw new Error('not inside a git repository.');
  const trim = (s: string) => s.trim();
  // Independent lookups run together; only the merge base waits for the default branch.
  // Preview works without gh: an unknown repo becomes local/<dir> below.
  const repoP = currentRepo(root).catch(() => undefined);
  const headP = git(root, ['rev-parse', 'HEAD']).then(trim);
  const branchP = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then(trim);
  const base = await defaultBaseRef(root, () => repoP);
  if (!base) throw new Error('could not find the default branch to compare against (no origin/HEAD, no answer from origin, and no main or master).');
  const baseSha = await mergeBaseOf(root, 'HEAD', base.ref);
  if (!baseSha) throw new Error(`could not find the merge base with ${base.ref.replace(/^refs\/(remotes\/|heads\/)/, '')}.`);
  // Diffs against the working tree, so it includes uncommitted work: the author is still shaping the branch.
  const [headSha, branch, log, diff, currentRepoName] = await Promise.all([headP, branchP, git(root, ['log', '--format=%H%x00%B%x1e', `${baseSha}..HEAD`]).then(trim), prDiff(root, baseSha), repoP]);
  const commits = log
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, message] = c.split('\0');
      return { sha, message: message ?? '' };
    });
  const repo = currentRepoName ?? `local/${path.basename(root)}`;
  return {
    worktree: root,
    diff,
    pr: {
      repo,
      number: 0,
      title: `${branch} (preview)`,
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
