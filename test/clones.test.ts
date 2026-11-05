import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findClone, findRepos, loadClones, recordClone, remoteFor, scanClones, scanTargets } from '../src/git/clones.js';
import { cleanupRepos, cleanupWorktrees, ensureWorktree } from '../src/git/worktree.js';
import { rankTargets } from '../src/tui/ClonesStep.js';
import type { PRInfo } from '../src/types.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let home: string;
const previousHome = process.env.GR_HOME;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-clones-')));
  home = path.join(root, 'gr');
  fs.mkdirSync(home);
  process.env.GR_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.GR_HOME;
  else process.env.GR_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

// A clone at `dir` with one commit and the given remotes (name → GitHub repository).
function clone(dir: string, remotes: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '--quiet');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  run(dir, 'add', 'file.txt');
  run(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'one');
  for (const [name, repo] of Object.entries(remotes)) run(dir, 'remote', 'add', name, `git@github.com:${repo}.git`);
  return dir;
}

describe('the clone index', () => {
  it('records a clone under each repository its remotes name, from one of its worktrees too', async () => {
    const dir = clone(path.join(root, 'code', 'app'), { origin: 'me/App', upstream: 'org/App' });
    const linked = path.join(root, 'linked');
    run(dir, 'worktree', 'add', '--quiet', '--detach', linked);

    expect(await recordClone(linked, home)).toEqual(['me/app', 'org/app']);
    expect(loadClones(home)).toEqual({ 'me/app': dir, 'org/app': dir });
  });

  it('finds a recorded clone with the remote that points at the repository, ignoring case', async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'me/app', upstream: 'Org/App' });
    await recordClone(dir, home);
    expect(await findClone('org/app', home)).toEqual({ root: dir, remote: 'upstream' });
    expect(await remoteFor(dir, 'ME/APP')).toBe('origin');
  });

  it('reads the remotes of a partial clone, whose fetch line names its filter', async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    run(dir, 'config', 'remote.origin.promisor', 'true');
    run(dir, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    expect(run(dir, 'remote', '-v')).toContain('(fetch) [blob:none]');
    expect(await remoteFor(dir, 'org/app')).toBe('origin');
  });

  it('drops an entry whose clone moved or no longer points at the repository', async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    const other = clone(path.join(root, 'other'), { origin: 'org/other' });
    await recordClone(dir, home);
    await recordClone(other, home);
    run(dir, 'remote', 'set-url', 'origin', 'git@github.com:org/renamed.git');
    fs.rmSync(other, { recursive: true, force: true });

    expect(await findClone('org/app', home)).toBeUndefined();
    expect(await findClone('org/other', home)).toBeUndefined();
    expect(loadClones(home)).toEqual({});
  });
});

describe('scanning', () => {
  it('finds clones without walking into dependencies, hidden folders, or a clone found', async () => {
    const code = path.join(root, 'code');
    const app = clone(path.join(code, 'work', 'app'), { origin: 'org/app' });
    clone(path.join(app, 'nested'), { origin: 'org/nested' });
    clone(path.join(code, 'node_modules', 'dep'), { origin: 'org/dep' });
    clone(path.join(code, '.cache', 'hidden'), { origin: 'org/hidden' });
    clone(path.join(code, 'local'), {});
    const deep = clone(path.join(code, 'a', 'b', 'c', 'd', 'e'), { origin: 'org/deep' });

    expect((await findRepos(code)).sort()).toEqual([app, path.join(code, 'local')].sort());
    expect(await findRepos(code, { maxDepth: 5 })).toContain(deep);
    expect((await scanClones(code)).clones).toEqual({ 'org/app': app });
  });

  it('counts a linked worktree as its main clone', async () => {
    const app = clone(path.join(root, 'app'), { origin: 'org/app' });
    const linked = path.join(root, 'code', 'wt');
    run(app, 'worktree', 'add', '--quiet', '--detach', linked);
    expect(await findRepos(linked)).toEqual([app]);
    expect((await scanClones(path.join(root, 'code'))).clones).toEqual({ 'org/app': app });
  });

  it('offers folders under home to scan, not those inside a clone', async () => {
    clone(path.join(root, 'code', 'app'), { origin: 'org/app' });
    fs.mkdirSync(path.join(root, 'code', 'app', 'src'));
    fs.mkdirSync(path.join(root, 'notes', 'old'), { recursive: true });
    expect((await scanTargets(root)).sort()).toEqual(['code', 'code/app', 'gr', 'notes', 'notes/old']);
  });

  it('ranks folders fzf style, the shallowest first with nothing typed', () => {
    const targets = ['code/pine/evergreen', 'code', 'code/pine', 'notes/pinecones', 'code/guided-review'];
    expect(rankTargets(targets, '')).toEqual(['code', 'code/guided-review', 'code/pine', 'notes/pinecones', 'code/pine/evergreen']);
    expect(rankTargets(targets, 'pine')[0]).toBe('code/pine');
    expect(rankTargets(targets, 'cpe')).toContain('code/pine/evergreen');
    expect(rankTargets(targets, 'zzz')).toEqual([]);
  });
});

describe('PR worktrees from the user clone', () => {
  const pr = (dir: string): PRInfo => {
    const sha = run(dir, 'rev-parse', 'HEAD');
    return { repo: 'org/app', number: 7, headSha: sha, baseSha: sha } as PRInfo;
  };

  it('checks a PR out from the recorded clone, without its hooks and without a clone of its own', async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    const marker = path.join(root, 'hook-ran');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await recordClone(dir, home);

    const worktree = await ensureWorktree(pr(dir));
    expect(worktree).toBe(path.join(home, 'worktrees', 'org__app', `pr-7-${pr(dir).headSha.slice(0, 8)}`));
    expect(fs.readFileSync(path.join(worktree, 'file.txt'), 'utf8')).toBe('one\n');
    expect(run(dir, 'worktree', 'list')).toContain(worktree);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(home, 'repos'))).toBe(false);
  });

  it("says when a PR comes from gr's own copy, and not when it comes from the user's clone", async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    const cached = path.join(home, 'repos', 'org__app.git');
    run(root, 'clone', '--quiet', '--bare', dir, cached);
    run(cached, 'remote', 'set-url', 'origin', 'https://github.com/org/app.git');
    const seen: [string, boolean][] = [];
    const onOwnCopy = (repo: string, downloading: boolean) => void seen.push([repo, downloading]);

    await ensureWorktree(pr(dir), { onOwnCopy });
    expect(seen).toEqual([['org/app', false]]);
    await recordClone(dir, home);
    await ensureWorktree({ ...pr(dir), number: 8 }, { onOwnCopy });
    expect(seen).toHaveLength(1);
  });

  it("deletes the PR's ref with its last worktree", async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    await recordClone(dir, home);
    const worktree = await ensureWorktree(pr(dir));
    run(dir, 'update-ref', 'refs/gr/pr-7', 'HEAD');

    expect((await cleanupWorktrees(home)).removed).toEqual([worktree]);
    expect(run(dir, 'for-each-ref', 'refs/gr/')).toBe('');
  });

  it("deletes gr's own clone once the user's clone replaces it", async () => {
    const dir = clone(path.join(root, 'app'), { origin: 'org/app' });
    const cached = path.join(home, 'repos', 'org__app.git');
    run(root, 'clone', '--quiet', '--bare', dir, cached);
    run(cached, 'remote', 'set-url', 'origin', 'https://github.com/org/app.git');
    const other = path.join(home, 'repos', 'org__other.git');
    run(root, 'clone', '--quiet', '--bare', dir, other);
    run(other, 'remote', 'set-url', 'origin', 'https://github.com/org/other.git');

    // Both used today: kept while no clone of the user's replaces them.
    expect(await cleanupRepos(home, { unusedDays: 30 })).toEqual([]);
    await recordClone(dir, home);
    expect(await cleanupRepos(home, { unusedDays: 30 })).toEqual([cached]);
    expect(fs.existsSync(other)).toBe(true);
  });
});
