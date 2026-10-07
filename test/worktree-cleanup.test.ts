import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { cleanupWorktrees } from '../src/git/worktree.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('removes clean managed worktrees and skips worktrees with local changes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cleanup-'));
  roots.push(home);
  const repo = path.join(home, 'source');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n');
  git('add', 'file.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  const sha = git('rev-parse', 'HEAD').slice(0, 8);
  const folder = path.join(home, 'worktrees', 'owner__repo');
  fs.mkdirSync(folder, { recursive: true });
  const clean = path.join(folder, `pr-1-${sha}`);
  const dirty = path.join(folder, `pr-2-${sha}`);
  git('worktree', 'add', '--detach', clean);
  git('worktree', 'add', '--detach', dirty);
  fs.writeFileSync(path.join(dirty, 'file.txt'), 'modified\n');

  const result = await cleanupWorktrees(home);
  expect(result.removed).toEqual([clean]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0].path).toBe(dirty);
  expect(fs.existsSync(clean)).toBe(false);
  expect(fs.existsSync(dirty)).toBe(true);
});
