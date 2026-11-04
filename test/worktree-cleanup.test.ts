import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { cleanupRepos, cleanupWorktrees } from '../src/git/worktree.js';

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A gr home with a source repository holding one commit; returns the commit's short id.
function setup(): { home: string; repo: string; sha: string; folder: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cleanup-'));
  roots.push(home);
  const repo = path.join(home, 'source');
  fs.mkdirSync(repo);
  run(repo, 'init');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n');
  run(repo, 'add', 'file.txt');
  run(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  const folder = path.join(home, 'worktrees', 'owner__repo');
  fs.mkdirSync(folder, { recursive: true });
  return { home, repo, sha: run(repo, 'rev-parse', 'HEAD').slice(0, 8), folder };
}

const age = (p: string, days: number) => {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
};

it('removes clean managed worktrees and skips worktrees with local changes', async () => {
  const { home, repo, sha, folder } = setup();
  const clean = path.join(folder, `pr-1-${sha}`);
  const dirty = path.join(folder, `pr-2-${sha}`);
  run(repo, 'worktree', 'add', '--detach', clean);
  run(repo, 'worktree', 'add', '--detach', dirty);
  fs.writeFileSync(path.join(dirty, 'file.txt'), 'modified\n');

  const result = await cleanupWorktrees(home);
  expect(result.removed).toEqual([clean]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0].path).toBe(dirty);
  expect(fs.existsSync(clean)).toBe(false);
  expect(fs.existsSync(dirty)).toBe(true);
});

it('with unusedDays, keeps worktrees used more recently', async () => {
  const { home, repo, sha, folder } = setup();
  const recent = path.join(folder, `pr-1-${sha}`);
  const stale = path.join(folder, `pr-2-${sha}`);
  run(repo, 'worktree', 'add', '--detach', recent);
  run(repo, 'worktree', 'add', '--detach', stale);
  age(recent, 2);
  age(stale, 4);

  const result = await cleanupWorktrees(home, { unusedDays: 3 });
  expect(result).toEqual({ removed: [stale], skipped: [] });
  expect(fs.existsSync(recent)).toBe(true);
});

it('deletes a worktree whose repository is gone', async () => {
  const { home, repo, sha, folder } = setup();
  const orphan = path.join(folder, `pr-1-${sha}`);
  run(repo, 'worktree', 'add', '--detach', orphan);
  fs.rmSync(repo, { recursive: true, force: true });

  // Even when recent: nothing can use it.
  const result = await cleanupWorktrees(home, { unusedDays: 3 });
  expect(result).toEqual({ removed: [orphan], skipped: [] });
  expect(fs.existsSync(path.join(home, 'worktrees'))).toBe(false);
});

it('keeps a worktree whose link to its repository is relative', async () => {
  const { home, repo, sha, folder } = setup();
  const linked = path.join(folder, `pr-1-${sha}`);
  run(repo, 'worktree', 'add', '--detach', linked);
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.relative(linked, path.join(repo, '.git', 'worktrees', `pr-1-${sha}`))}\n`);

  expect(await cleanupWorktrees(home, { unusedDays: 3 })).toEqual({ removed: [], skipped: [] });
  expect(fs.existsSync(linked)).toBe(true);
});

it('deletes cached clones unused for the cutoff and with no worktree left', async () => {
  const { home, repo, sha, folder } = setup();
  const clones = path.join(home, 'repos');
  fs.mkdirSync(clones);
  const clone = (name: string) => {
    const dir = path.join(clones, `${name}.git`);
    run(home, 'clone', '--quiet', '--bare', repo, dir);
    return dir;
  };
  const stale = clone('stale');
  const recent = clone('recent');
  const inUse = clone('in-use');
  const pruned = clone('pruned');
  run(home, '--git-dir', inUse, 'worktree', 'add', '--detach', path.join(folder, `pr-1-${sha}`));
  // A worktree whose folder was deleted without Git: pruned, so it no longer holds the clone.
  const gone = path.join(folder, `pr-2-${sha}`);
  run(home, '--git-dir', pruned, 'worktree', 'add', '--detach', gone);
  fs.rmSync(gone, { recursive: true, force: true });
  fs.writeFileSync(path.join(recent, 'gr-last-used'), '');
  age(path.join(recent, 'gr-last-used'), 10);
  for (const dir of [stale, inUse, pruned]) age(path.join(dir, 'HEAD'), 40);

  const removed = await cleanupRepos(home, { unusedDays: 30 });
  expect(removed.sort()).toEqual([pruned, stale].sort());
  expect(fs.existsSync(recent)).toBe(true);
  expect(fs.existsSync(inUse)).toBe(true);
});
