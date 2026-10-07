import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PRInfo } from '../types.js';
import { grHome, repoSlug } from '../paths.js';
import { gh } from '../github/gh.js';
import { gitAuthEnv, githubAuth } from '../github/auth.js';
import { restJson, webHost } from '../github/api.js';
import { git, repoFromRemote } from './git.js';

// The PR's repo can set diff/textconv drivers in .gitattributes that resolve to commands in the
// user's git config; never run them on reviewed content.
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

export async function localRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
}

async function originMatches(root: string, repo: string): Promise<boolean> {
  try {
    const url = await git(root, ['remote', 'get-url', 'origin']);
    return repoFromRemote(url)?.toLowerCase() === repo.toLowerCase();
  } catch {
    return false;
  }
}

async function cloneUrl(repo: string): Promise<string> {
  // With a token, clone over HTTPS so gitAuthEnv's header authenticates it.
  const auth = githubAuth();
  if (auth) return `https://${webHost(auth.apiUrl)}/${repo}.git`;
  let protocol = 'https';
  try {
    protocol = (await gh(['config', 'get', 'git_protocol', '-h', 'github.com'])).trim() || 'https';
  } catch {
    // gh not configured: default to https
  }
  try {
    const out = await gh(['repo', 'view', repo, '--json', 'sshUrl,url']);
    const { sshUrl, url } = JSON.parse(out) as { sshUrl: string; url: string };
    return protocol === 'ssh' ? sshUrl : `${url}.git`;
  } catch {
    return protocol === 'ssh' ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
  }
}

// The repo the worktree hangs off: the user's own clone when it matches,
// otherwise a cached bare, blobless clone under ~/.guided-review/repos/.
async function repoCache(repo: string, localRepo?: string): Promise<string> {
  if (localRepo) {
    const root = await localRepoRoot(localRepo);
    if (root && (await originMatches(root, repo))) return root;
  }
  const dir = path.join(grHome(), 'repos', `${repoSlug(repo)}.git`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), ['clone', '--bare', '--filter=blob:none', await cloneUrl(repo), dir], { maxBuffer: 256 * 1024 * 1024, env: gitAuthEnv() });
  }
  return dir;
}

export async function hasCommit(root: string, sha: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`], { signal });
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

// Fetches one commit by id from origin, e.g. a PR's earlier head for a re-review diff.
export async function fetchCommit(root: string, sha: string, signal?: AbortSignal): Promise<void> {
  await git(root, ['fetch', '--quiet', 'origin', sha], { signal, env: gitAuthEnv() });
}

export async function ensureWorktree(pr: PRInfo, opts: { localRepo?: string } = {}): Promise<string> {
  const repoDir = await repoCache(pr.repo, opts.localRepo);
  const prDir = path.join(grHome(), 'worktrees', repoSlug(pr.repo));
  const target = path.join(prDir, `pr-${pr.number}-${pr.headSha.slice(0, 8)}`);

  if (!(await hasCommit(repoDir, pr.headSha)) || !(await hasCommit(repoDir, pr.baseSha))) {
    // Refs live under refs/gr/ so the user's branches are never touched.
    await git(repoDir, ['fetch', 'origin', pr.baseSha, `+refs/pull/${pr.number}/head:refs/gr/pr-${pr.number}`], { maxBuffer: 256 * 1024 * 1024, env: gitAuthEnv() });
  }

  if (fs.existsSync(path.join(target, '.git'))) return target;

  // Drop worktrees left from earlier heads of this PR.
  fs.mkdirSync(prDir, { recursive: true });
  for (const entry of fs.readdirSync(prDir)) {
    if (entry.startsWith(`pr-${pr.number}-`) && path.join(prDir, entry) !== target) {
      // Keep a worktree that Git considers dirty, even after a new PR push.
      await git(repoDir, ['worktree', 'remove', path.join(prDir, entry)]).catch(() => undefined);
    }
  }
  await git(repoDir, ['worktree', 'prune']).catch(() => undefined);
  await git(repoDir, ['worktree', 'add', '--detach', target, pr.headSha], { maxBuffer: 256 * 1024 * 1024 });
  return target;
}

export async function cleanupWorktrees(home = grHome()): Promise<{ removed: string[]; skipped: { path: string; reason: string }[] }> {
  const root = path.join(home, 'worktrees');
  const removed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  if (!fs.existsSync(root)) return { removed, skipped };
  for (const repo of fs.readdirSync(root, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    const repoDir = path.join(root, repo.name);
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^pr-\d+-[0-9a-f]{8}$/.test(entry.name)) continue;
      const target = path.join(repoDir, entry.name);
      if (!fs.existsSync(path.join(target, '.git'))) {
        skipped.push({ path: target, reason: 'not a registered Git worktree' });
        continue;
      }
      try {
        const common = (await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        await git(root, ['--git-dir', common, 'worktree', 'remove', target]);
        removed.push(target);
      } catch (error) {
        skipped.push({ path: target, reason: (error as Error).message });
      }
    }
    if (!fs.readdirSync(repoDir).length) fs.rmdirSync(repoDir);
  }
  if (!fs.readdirSync(root).length) fs.rmdirSync(root);
  return { removed, skipped };
}

// Tracked files plus untracked ones that are not ignored: a preview's new files are not committed yet.
export async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, signal });
  return out.split('\n').filter(Boolean);
}

export async function diffBetween(root: string, a: string, b: string, signal?: AbortSignal): Promise<string> {
  return git(root, ['diff', ...NO_DRIVERS, a, b], { maxBuffer: 200 * 1024 * 1024, signal });
}

// The PR diff as GitHub shows it (the three-dot diff from the merge base), computed locally.
// Every option that user or repo config could change is pinned, so the output matches
// GitHub's byte for byte except for the abbreviated blob ids on `index` lines. Without a head,
// diffs against the working tree, uncommitted changes included (gr preview).
export async function prDiff(root: string, mergeBase: string, head?: string, signal?: AbortSignal): Promise<string> {
  if (!head) return withUntrackedIndex(root, signal, (env) => pinnedDiff(root, [mergeBase], signal, env));
  return pinnedDiff(root, [mergeBase, head], signal);
}

// Runs fn against a copy of the index in which untracked files (not ignored ones) are added with
// --intent-to-add, so a working-tree diff shows new files the author has not staged yet. The
// real index is never written.
async function withUntrackedIndex<T>(root: string, signal: AbortSignal | undefined, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const untracked = (await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], { signal })).split('\0').filter(Boolean);
  if (!untracked.length) return fn({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-index-'));
  try {
    const index = path.join(dir, 'index');
    const real = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'], { signal })).trim());
    if (fs.existsSync(real)) fs.copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await git(root, ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: untracked.join('\0'), env, signal });
    return await fn(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function pinnedDiff(root: string, revs: string[], signal?: AbortSignal, env?: Record<string, string>): Promise<string> {
  const pinned = ['diff.noprefix=false', 'diff.mnemonicPrefix=false', 'diff.relative=false', 'diff.renames=true', 'diff.interHunkContext=0', 'diff.suppressBlankEmpty=false'];
  return git(
    root,
    [
      ...pinned.flatMap((c) => ['-c', c]),
      'diff',
      ...NO_DRIVERS,
      '--no-color',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--unified=3',
      '--diff-algorithm=myers',
      '-O/dev/null', // ignore diff.orderFile
      '--abbrev=11',
      '--ignore-submodules=none',
      '--submodule=short',
      ...revs,
      '--',
    ],
    { maxBuffer: 200 * 1024 * 1024, signal, env },
  );
}

async function githubDefaultBranch(repo: string): Promise<string> {
  const auth = githubAuth();
  if (auth) return (await restJson<{ default_branch: string }>(auth, `repos/${repo}`)).default_branch;
  return gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
}

// Asks origin itself which branch its HEAD points at, for clones whose origin/HEAD was never set
// (git init + remote add, or a host other than GitHub). Never prompts: a remote that needs a
// password or a passphrase fails fast instead of hanging the preview.
async function originDefaultBranch(root: string): Promise<string> {
  const out = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD'], {
    timeout: 5000,
    env: { ...gitAuthEnv(), GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
  });
  return out.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m)?.[1] ?? '';
}

// The branch a preview is compared against: the repository's default branch, read from origin/HEAD,
// then GitHub, then origin itself. Each name prefers origin's copy and
// falls back to the local branch, so repositories without a remote (or not yet fetched) still work.
// git's init.defaultBranch is deliberately not consulted: it is the user's preference for new repos,
// not the default of the repo they contribute to. With no name to go on, main and master are
// equals: origin's copy of either beats a local one.
export async function defaultBaseRef(root: string, repo: () => Promise<string | undefined>): Promise<{ name: string; ref: string } | undefined> {
  const quiet = (p: Promise<string>) =>
    p.then(
      (s) => s.trim(),
      () => '',
    );
  const exists = (ref: string) =>
    git(root, ['show-ref', '--verify', '--quiet', ref]).then(
      () => true,
      () => false,
    );
  const lookups = [
    () => quiet(git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).then((s) => s.replace(/^origin\//, '')),
    async () => {
      const name = await repo();
      return name ? quiet(githubDefaultBranch(name)) : '';
    },
    () => quiet(originDefaultBranch(root)),
  ];
  const tried = new Set<string>();
  for (const lookup of lookups) {
    const name = await lookup();
    if (!name || tried.has(name)) continue;
    tried.add(name);
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (await exists(ref)) return { name, ref };
    }
  }
  const fallbacks = ['main', 'master'].filter((name) => !tried.has(name));
  for (const prefix of ['refs/remotes/origin/', 'refs/heads/']) {
    for (const name of fallbacks) {
      if (await exists(prefix + name)) return { name, ref: prefix + name };
    }
  }
  return undefined;
}

export async function mergeBaseOf(root: string, a: string, b: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return (await git(root, ['merge-base', a, b], { signal })).trim() || undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
