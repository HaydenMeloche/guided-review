import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffPath } from '../src/git/worktree.js';
import { mapLine, spanChanged } from '../src/review/feedback.js';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-rename-'));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('diffPath', () => {
  it('follows a file renamed after the comment instead of reading it as deleted', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'src/old.ts'), body);
    git('add', '.');
    git('commit', '-qm', 'one');
    const before = git('rev-parse', 'HEAD');
    git('mv', 'src/old.ts', 'src/new.ts');
    fs.writeFileSync(path.join(dir, 'src/new.ts'), body.replace('line 3\n', 'line 3\nadded\n'));
    git('add', '.');
    git('commit', '-qm', 'two');
    const diff = await diffPath(dir, before, git('rev-parse', 'HEAD'), 'src/old.ts');
    expect(diff).toContain('rename from src/old.ts');
    expect(mapLine(diff, 'src/old.ts', 2)).toEqual({ path: 'src/new.ts', line: 2, how: 'mapped' });
    expect(mapLine(diff, 'src/old.ts', 9)).toEqual({ path: 'src/new.ts', line: 10, how: 'mapped' });
    expect(spanChanged(diff, 'src/old.ts', { start: 2, end: 2 })).toBeUndefined();
    expect(spanChanged(diff, 'src/old.ts', { start: 3, end: 4 })).toBeDefined();
  });

  it('still returns a plain diff for a file that was not renamed, and nothing for one that did not change', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const before = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
    git('commit', '-qam', 'two');
    const head = git('rev-parse', 'HEAD');
    expect(await diffPath(dir, before, head, 'a.txt')).toContain('+A');
    expect(await diffPath(dir, before, head, 'b.txt')).toBe('');
  });
});
