import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grHome } from '../paths.js';
import { git, repoFromRemote } from './git.js';

// The user's own clones, so a PR worktree can hang off one instead of a clone gr downloads. Kept in
// clones.json as { "owner/repo": "/path/to/clone" }, keyed in lower case. gr config fills it by
// scanning folders, and every gr run inside a repository records that one.

const FILE = 'clones.json';

export type CloneIndex = Record<string, string>;

const key = (repo: string) => repo.toLowerCase();

export function loadClones(home = grHome()): CloneIndex {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(home, FILE), 'utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

// Written whole and renamed into place: a run recording its clone may exit while it writes.
export function saveClones(index: CloneIndex, home = grHome()): void {
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  const file = path.join(home, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Each remote of the repository at `root` with the GitHub repository it points at. `git remote -v`
// applies url.insteadOf, so a shorthand remote still names its repository.
export async function remoteRepos(root: string): Promise<{ remote: string; repo: string }[]> {
  let out: string;
  try {
    out = await git(root, ['remote', '-v'], { timeout: 5000 });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const found: { remote: string; repo: string }[] = [];
  for (const line of out.split('\n')) {
    // A partial clone's fetch line ends with its filter: "(fetch) [blob:none]".
    const m = line.match(/^(\S+)\t(\S+) \(fetch\)/);
    const repo = m && repoFromRemote(m[2]);
    if (!m || !repo || seen.has(m[1])) continue;
    seen.add(m[1]);
    found.push({ remote: m[1], repo });
  }
  return found;
}

// The remote of `root` that points at `repo`: origin first, then upstream, then any other.
export async function remoteFor(root: string, repo: string): Promise<string | undefined> {
  const matches = (await remoteRepos(root)).filter((r) => key(r.repo) === key(repo)).map((r) => r.remote);
  return ['origin', 'upstream'].find((r) => matches.includes(r)) ?? matches[0];
}

// The main clone of the repository at `root`, which may be one of its linked worktrees: those come
// and go, while the clone stays. A bare repository has no folder to record.
async function mainClone(root: string): Promise<string | undefined> {
  try {
    const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5000 })).trim();
    return path.basename(common) === '.git' ? path.dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

// Records the clone at `root` (or the main clone of a worktree there) under every repository its
// remotes point at, replacing an earlier clone of the same repository: the one used last wins.
// Returns what it recorded.
export async function recordClone(at: string, home = grHome()): Promise<string[]> {
  const root = await mainClone(at);
  if (!root) return [];
  const repos = [...new Set((await remoteRepos(root)).map((r) => key(r.repo)))];
  if (!repos.length) return repos;
  const index = loadClones(home);
  if (repos.every((r) => index[r] === root)) return repos;
  for (const r of repos) index[r] = root;
  saveClones(index, home);
  return repos;
}

// The user's clone of `repo` and the remote to fetch it from, when one is recorded and still points
// at it. An entry whose folder moved or whose remotes changed is dropped.
export async function findClone(repo: string, home = grHome()): Promise<{ root: string; remote: string } | undefined> {
  const index = loadClones(home);
  const root = index[key(repo)];
  if (!root) return undefined;
  const remote = fs.existsSync(path.join(root, '.git')) ? await remoteFor(root, repo) : undefined;
  if (remote) return { root, remote };
  delete index[key(repo)];
  saveClones(index, home);
  return undefined;
}

// Folders never worth walking into: dependencies, build output, caches, and macOS's own.
const SKIP = new Set(['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'venv', 'Library', 'Applications', 'Movies', 'Music', 'Pictures']);

const walkable = (e: fs.Dirent) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name);

export interface ScanOptions {
  maxDepth?: number;
  deadline?: number; // Date.now() value after which the scan stops where it is
  signal?: AbortSignal;
}

// The git repositories under `start`, down to `maxDepth` levels, not looking inside one once found.
// A linked worktree (.git is a file) counts as its main clone.
export async function findRepos(start: string, opts: ScanOptions = {}): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 4;
  const deadline = opts.deadline ?? Date.now() + 5000;
  const found: string[] = [];
  let level = [path.resolve(start)];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (opts.signal?.aborted || Date.now() > deadline) return found;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const dotGit = entries.find((e) => e.name === '.git');
      if (dotGit?.isDirectory()) {
        found.push(dir);
        continue;
      }
      // A linked worktree: its main clone, which may be anywhere, is the one to record.
      if (dotGit) {
        const main = await mainClone(dir);
        if (main && !found.includes(main)) found.push(main);
        continue;
      }
      for (const e of entries) if (walkable(e)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  return found;
}

export interface ScanResult {
  folder: string;
  clones: CloneIndex; // what was found, to merge into the index
}

// Scans `folder` for clones of GitHub repositories. Where two clones share a repository, the first
// found (the shallower) is kept.
export async function scanClones(folder: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const roots = await findRepos(folder, opts);
  const clones: CloneIndex = {};
  const remotes = await Promise.all(roots.map((root) => remoteRepos(root)));
  roots.forEach((root, i) => {
    for (const { repo } of remotes[i]) clones[key(repo)] ??= root;
  });
  return { folder, clones };
}

// Folders under `home` to offer as places to scan, down to `maxDepth` levels, as paths relative to
// it. A repository is offered but not walked into.
export async function scanTargets(home = os.homedir(), opts: ScanOptions = {}): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const deadline = opts.deadline ?? Date.now() + 2000;
  const found: string[] = [];
  let level = [home];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (opts.signal?.aborted || Date.now() > deadline || found.length >= 20_000) return found;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!walkable(e)) continue;
        const child = path.join(dir, e.name);
        found.push(path.relative(home, child));
        if (!fs.existsSync(path.join(child, '.git'))) next.push(child);
      }
    }
    level = next;
  }
  return found;
}

// A path with the home folder written as ~.
export function tildify(p: string, home = os.homedir()): string {
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
