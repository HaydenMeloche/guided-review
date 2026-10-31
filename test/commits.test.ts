import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitChapters, commitHunks, parsePatches, readCommitHunks, WORKING_TREE } from '../src/review/commits.js';
import { diffLines, hunk } from './fixtures/tour.js';
import type { Chapter } from '../src/types.js';

let root: string;
let base: string;
let head: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
const write = (f: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), text);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-commits-'));
  git('init', '-q', '-b', 'main');
  write('src/a.ts', 'export const one = 1;\nexport const two = 2;\nexport const old = 0;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  write('src/a.ts', 'export const one = 1;\nexport const two = 22;\nexport const old = 0;\n');
  git('commit', '-qam', 'Change two');
  write('src/b.ts', 'export const fresh = true;\n');
  git('add', '-A');
  git('commit', '-qm', 'Add b');
  write('src/a.ts', 'export const one = 1;\nexport const two = 22;\n');
  git('commit', '-qam', 'Drop old');
  head = git('rev-parse', 'HEAD');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// The tour's hunks of base..head: one in a.ts (two changed, old dropped), one adding b.ts.
const a = hunk('ha', 'src/a.ts', diffLines([' export const one = 1;', '-export const two = 2;', '-export const old = 0;', '+export const two = 22;']));
const b = hunk('hb', 'src/b.ts', diffLines(['+export const fresh = true;']));
const chapters = [{ id: 'c1', hunkIds: ['hb', 'ha'] }] as Chapter[];
const tour = () => ({ hunks: { ha: a, hb: b }, chapters, baseSha: base, headSha: head });

describe('commit hunks', () => {
  it('finds the hunks each commit made, oldest first, by the lines it added or removed', async () => {
    const list = await readCommitHunks(root, tour(), false);
    expect(list.map((c) => [c.subject, c.hunkIds])).toEqual([
      ['Change two', ['ha']],
      ['Add b', ['hb']],
      // A commit that only removes lines is found by them.
      ['Drop old', ['ha']],
    ]);
    expect(list[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('puts uncommitted and untracked changes under the working tree', async () => {
    write('src/c.ts', 'export const untracked = 1;\n');
    const c = hunk('hc', 'src/c.ts', diffLines(['+export const untracked = 1;']));
    const list = await readCommitHunks(root, { ...tour(), hunks: { ha: a, hb: b, hc: c }, chapters: [{ id: 'c1', hunkIds: ['hb', 'ha', 'hc'] }] as Chapter[] }, true);
    expect(list.at(-1)).toMatchObject({ sha: WORKING_TREE, subject: 'Uncommitted changes', hunkIds: ['hc'] });
    fs.rmSync(path.join(root, 'src/c.ts'));
  });

  it('gives a hunk with no line it can match to every commit that touched its file', () => {
    const braces = hunk('hx', 'src/x.ts', diffLines(['+}']));
    const patches = parsePatches('diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+}\n', 'abc', 'Close it');
    expect(commitHunks({ hunks: { hx: braces }, chapters: [{ id: 'c', hunkIds: ['hx'] }] as Chapter[] }, patches)[0].hunkIds).toEqual(['hx']);
  });

  it('reads a removed line that starts with dashes as a change, not a file header', () => {
    const [p] = parsePatches('diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1 @@\n--- drop the old view\n select 1;\n', 'abc');
    expect([...p.files.keys()]).toEqual(['q.sql']);
    expect([...p.files.get('q.sql')!.del]).toEqual(['-- drop the old view']);
  });
});

describe('commit order', () => {
  it('makes a chapter per commit, oldest first, each hunk under the first commit that made it', async () => {
    const t = tour();
    const chapters = commitChapters(t, await readCommitHunks(root, t, false));
    expect(chapters.map((c) => [c.title, c.hunkIds])).toEqual([
      ['Change two', ['ha']],
      ['Add b', ['hb']],
    ]);
    expect(chapters[0].summary).toMatch(/^Commit 1 of 3 · [0-9a-f]{7} · \+1 −1$/);
  });

  it('keeps hunks no commit claims in a chapter of their own', () => {
    const t = tour();
    expect(commitChapters(t, [{ sha: 'a'.repeat(40), subject: 'Only a', additions: 1, deletions: 0, hunkIds: ['ha'] }]).map((c) => [c.title, c.hunkIds])).toEqual([
      ['Only a', ['ha']],
      ['Other changes', ['hb']],
    ]);
  });
});
