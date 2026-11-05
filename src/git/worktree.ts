import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PRInfo } from '../types.js';
import { grHome, repoSlug } from '../paths.js';
import { gh } from '../github/gh.js';
import { githubAuth } from '../github/auth.js';
import { restJson, webHost } from '../github/api.js';
import { git } from './git.js';
import { findClone, remoteFor, remoteRepos } from './clones.js';

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

// The repo the worktree hangs off, and the remote to fetch the PR from: the clone gr runs in when
// one of its remotes is the PR's repository, then the user's clone recorded in clones.json,
// otherwise a cached bare, blobless clone under ~/.guided-review/repos/.
async function repoCache(repo: string, localRepo?: string, onOwnCopy?: (repo: string, downloading: boolean) => void): Promise<{ dir: string; remote: string }> {
  if (localRepo) {
    const root = await localRepoRoot(localRepo);
    const remote = root && (await remoteFor(root, repo));
    if (root && remote) return { dir: root, remote };
  }
  const own = await findClone(repo);
  if (own) return { dir: own.root, remote: own.remote };
  const dir = path.join(grHome(), 'repos', `${repoSlug(repo)}.git`);
  const downloading = !fs.existsSync(dir);
  onOwnCopy?.(repo, downloading);
  if (downloading) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(path.dirname(dir), ['clone', '--bare', '--filter=blob:none', await cloneUrl(repo), dir], { maxBuffer: 256 * 1024 * 1024 });
  }
  markUsed(dir);
  return { dir, remote: 'origin' };
}

// Adds a detached worktree without the repository's hooks or Git LFS downloads: in the user's own
// clone, a post-checkout hook (husky, LFS) would otherwise run for every PR gr opens.
async function addWorktree(repoDir: string, target: string, sha: string): Promise<void> {
  await git(repoDir, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', target, sha], { maxBuffer: 256 * 1024 * 1024, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
}

// A file in each cached clone whose time is when a tour last used it. The clone's own time is no
// guide: removing its last worktree changes it.
const USED_MARK = 'gr-last-used';

function markUsed(clone: string): void {
  try {
    fs.writeFileSync(path.join(clone, USED_MARK), '');
  } catch {
    // gone, or not ours to write: cleanup falls back to the clone's HEAD
  }
}

// When a cached clone was last used: its mark, or for a clone made before marks, its last fetch.
function lastUsed(clone: string): number {
  for (const file of [USED_MARK, 'FETCH_HEAD', 'HEAD']) {
    try {
      return fs.statSync(path.join(clone, file)).mtimeMs;
    } catch {
      // try the next
    }
  }
  return fs.statSync(clone).mtimeMs;
}

// Marks a worktree as used now, so the automatic cleanup keeps it.
function touch(dir: string): void {
  const now = new Date();
  try {
    fs.utimesSync(dir, now, now);
  } catch {
    // gone: whoever needs it next makes it again
  }
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

// Fetches one commit by id, e.g. a PR's earlier head for a re-review diff: from origin, then
// upstream, then any other GitHub remote, since the user's clone may have its fork as origin.
export async function fetchCommit(root: string, sha: string, signal?: AbortSignal): Promise<void> {
  const remotes = (await remoteRepos(root)).map((r) => r.remote);
  const order = [...['origin', 'upstream'].filter((r) => remotes.includes(r)), ...remotes.filter((r) => r !== 'origin' && r !== 'upstream')];
  let failure: unknown = new Error('no GitHub remote to fetch from');
  for (const remote of order.length ? order : ['origin']) {
    try {
      await git(root, ['fetch', '--quiet', remote, sha], { signal });
      return;
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
  }
  throw failure;
}

// `onOwnCopy` hears when the PR comes from gr's own clone of the repository rather than the user's,
// and whether gr must download that clone first (the one slow case).
export async function ensureWorktree(pr: PRInfo, opts: { localRepo?: string; onOwnCopy?: (repo: string, downloading: boolean) => void } = {}): Promise<string> {
  const { dir: repoDir, remote } = await repoCache(pr.repo, opts.localRepo, opts.onOwnCopy);
  const prDir = path.join(grHome(), 'worktrees', repoSlug(pr.repo));
  const target = path.join(prDir, `pr-${pr.number}-${pr.headSha.slice(0, 8)}`);

  if (!(await hasCommit(repoDir, pr.headSha)) || !(await hasCommit(repoDir, pr.baseSha))) {
    // Refs live under refs/gr/ so the user's branches are never touched.
    await git(repoDir, ['fetch', remote, pr.baseSha, `+refs/pull/${pr.number}/head:refs/gr/pr-${pr.number}`], { maxBuffer: 256 * 1024 * 1024 });
  }

  if (fs.existsSync(path.join(target, '.git'))) {
    touch(target);
    return target;
  }

  // Drop worktrees left from earlier heads of this PR.
  fs.mkdirSync(prDir, { recursive: true });
  for (const entry of fs.readdirSync(prDir)) {
    if (entry.startsWith(`pr-${pr.number}-`) && path.join(prDir, entry) !== target) {
      // Keep a worktree that Git considers dirty, even after a new PR push.
      await git(repoDir, ['worktree', 'remove', path.join(prDir, entry)]).catch(() => undefined);
    }
  }
  await git(repoDir, ['worktree', 'prune']).catch(() => undefined);
  await addWorktree(repoDir, target, pr.headSha);
  return target;
}

// A detached checkout of one commit of the repository at `root`, for touring a range of commits
// without touching the user's working tree. Named as a PR worktree numbered 0, so gr cleanup
// removes it like the others.
export async function commitWorktree(root: string, repo: string, sha: string): Promise<string> {
  const dir = path.join(grHome(), 'worktrees', repoSlug(repo));
  const target = path.join(dir, `pr-0-${sha.slice(0, 8)}`);
  if (fs.existsSync(path.join(target, '.git'))) {
    touch(target);
    return target;
  }
  fs.mkdirSync(dir, { recursive: true });
  await git(root, ['worktree', 'prune']).catch(() => undefined);
  await addWorktree(root, target, sha);
  return target;
}

const DAY = 86_400_000;

// The repository a worktree's .git file points into, or undefined when it is not a file.
function linkedGitDir(worktree: string): string | undefined {
  try {
    return fs
      .readFileSync(path.join(worktree, '.git'), 'utf8')
      .match(/^gitdir: (.+)$/m)?.[1]
      .trim();
  } catch {
    return undefined;
  }
}

// Removes managed PR worktrees: all of them, or with `unusedDays`, those not used for that long.
// Git refuses one with local changes, which is reported. A worktree whose repository is gone (a
// deleted clone or temporary repo) cannot be removed through Git, so its folder is deleted.
export async function cleanupWorktrees(home = grHome(), opts: { unusedDays?: number; now?: number } = {}): Promise<{ removed: string[]; skipped: { path: string; reason: string }[] }> {
  const root = path.join(home, 'worktrees');
  const removed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  if (!fs.existsSync(root)) return { removed, skipped };
  const cutoff = opts.unusedDays === undefined ? Infinity : (opts.now ?? Date.now()) - opts.unusedDays * DAY;
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
      // Git writes the link relative to the worktree under worktree.useRelativePaths.
      const gitDir = linkedGitDir(target);
      if (gitDir && !fs.existsSync(path.resolve(target, gitDir))) {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
        continue;
      }
      if (fs.statSync(target).mtimeMs >= cutoff) continue;
      try {
        const common = (await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
        await git(root, ['--git-dir', common, 'worktree', 'remove', target]);
        removed.push(target);
        // The PR's ref goes with its last worktree, so the user's own clone doesn't collect them.
        const pr = entry.name.match(/^pr-(\d+)-/)![1];
        if (pr !== '0' && !fs.readdirSync(repoDir).some((e) => e.startsWith(`pr-${pr}-`))) {
          await git(root, ['--git-dir', common, 'update-ref', '-d', `refs/gr/pr-${pr}`]).catch(() => undefined);
        }
      } catch (error) {
        skipped.push({ path: target, reason: (error as Error).message });
      }
    }
    if (!fs.readdirSync(repoDir).length) fs.rmdirSync(repoDir);
  }
  if (!fs.readdirSync(root).length) fs.rmdirSync(root);
  return { removed, skipped };
}

// Deletes cached clones under repos/ that no worktree still uses and that either no tour has used in
// `unusedDays` or that the user's own clone (in clones.json) has replaced. Each clone first forgets
// worktrees whose folders are gone.
export async function cleanupRepos(home = grHome(), opts: { unusedDays: number; now?: number }): Promise<string[]> {
  const root = path.join(home, 'repos');
  const removed: string[] = [];
  if (!fs.existsSync(root)) return removed;
  const cutoff = (opts.now ?? Date.now()) - opts.unusedDays * DAY;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
    const clone = path.join(root, entry.name);
    try {
      await git(root, ['--git-dir', clone, 'worktree', 'prune']);
      const worktrees = (await git(root, ['--git-dir', clone, 'worktree', 'list', '--porcelain'])).split('\n').filter((l) => l.startsWith('worktree ')).length;
      // The first entry is the bare clone itself.
      if (worktrees > 1) continue;
      if (lastUsed(clone) >= cutoff) {
        const repo = (await remoteRepos(clone)).find((r) => r.remote === 'origin')?.repo;
        if (!repo || !(await findClone(repo, home))) continue;
      }
      fs.rmSync(clone, { recursive: true, force: true });
      removed.push(clone);
    } catch {
      // not a clone Git can read: leave it
    }
  }
  return removed;
}

// Tracked files plus untracked ones that are not ignored: a preview's new files are not committed yet.
export async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024, signal });
  return out.split('\n').filter(Boolean);
}

export async function diffBetween(root: string, a: string, b: string, signal?: AbortSignal): Promise<string> {
  return git(root, ['diff', ...NO_DRIVERS, a, b], { maxBuffer: 200 * 1024 * 1024, signal });
}

// One file's diff between two commits, following a rename: a file renamed in between comes back
// as a rename diff (its old path in `oldPath`), not as a deletion. Git only detects a rename when
// both paths are in the diff, so the new path is found from the (small) name-status list first.
export async function diffPath(root: string, a: string, b: string, file: string, signal?: AbortSignal): Promise<string> {
  const names = (await git(root, ['diff', ...NO_DRIVERS, '--name-status', '-z', '-M', a, b], { maxBuffer: 64 * 1024 * 1024, signal })).split('\0');
  let renamedTo: string | undefined;
  for (let i = 0; i < names.length;) {
    const code = names[i];
    if (!code) break;
    const paths = code[0] === 'R' || code[0] === 'C' ? 2 : 1;
    if (code[0] === 'R' && names[i + 1] === file) renamedTo = names[i + 2];
    i += 1 + paths;
  }
  return git(root, ['diff', ...NO_DRIVERS, '-M', a, b, '--', file, ...(renamedTo ? [renamedTo] : [])], { maxBuffer: 64 * 1024 * 1024, signal });
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
  const out = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: 5000 });
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
