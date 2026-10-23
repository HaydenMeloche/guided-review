import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { findFileLinks, readLinkedFile } from '../src/review/fileLinks.js';
import { linkWindow } from '../src/tui/FilePreview.js';

describe('findFileLinks', () => {
  const opts = { host: 'github.com', repo: 'acme/pay' };

  it('finds permalinks and blob links to this repository, with their lines', () => {
    const body = [
      'Same bug as [`retry.ts:10-14`](https://github.com/acme/pay/blob/abc1234/src/retry.ts#L10-L14).',
      'See https://github.com/acme/pay/blob/main/docs/limits.md#L3, and again https://github.com/acme/pay/blob/main/docs/limits.md#L3.',
      'Whole file: <https://github.com/Acme/Pay/blob/abc1234/src/a%20b.ts>',
    ].join('\n');
    expect(findFileLinks(body, opts)).toEqual([
      { url: 'https://github.com/acme/pay/blob/abc1234/src/retry.ts#L10-L14', ref: 'abc1234', path: 'src/retry.ts', startLine: 10, endLine: 14 },
      { url: 'https://github.com/acme/pay/blob/main/docs/limits.md#L3', ref: 'main', path: 'docs/limits.md', startLine: 3 },
      { url: 'https://github.com/Acme/Pay/blob/abc1234/src/a%20b.ts', ref: 'abc1234', path: 'src/a b.ts' },
    ]);
  });

  it('leaves other repositories, other hosts and path tricks alone', () => {
    const body = 'https://github.com/other/repo/blob/main/x.ts https://gitlab.com/acme/pay/blob/main/x.ts https://github.com/acme/pay/blob/main/../secret';
    expect(findFileLinks(body, opts)).toEqual([]);
  });
});

describe('readLinkedFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-links-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'old\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'new\n');
  git('commit', '-qam', 'two');
  const head = git('rev-parse', 'HEAD');

  it('reads the file at the commit the link names', async () => {
    expect(await readLinkedFile(dir, { url: 'u', ref: first, path: 'a.ts' }, head)).toEqual({ text: 'old\n', at: first });
  });

  it('falls back to the PR head for a branch name, and says so', async () => {
    const r = await readLinkedFile(dir, { url: 'u', ref: 'feature', path: 'a.ts' }, head);
    expect(r).toMatchObject({ text: 'new\n', at: head, note: 'the link names feature; shown at the PR head' });
  });
});

describe('linkWindow', () => {
  it('shows ten lines on each side of the linked lines, within the file', () => {
    expect(linkWindow({ startLine: 40, endLine: 44 }, 100)).toEqual({ from: 30, to: 54 });
    expect(linkWindow({ startLine: 3 }, 100)).toEqual({ from: 1, to: 13 });
    expect(linkWindow({ startLine: 95 }, 100)).toEqual({ from: 85, to: 100 });
    expect(linkWindow({}, 100)).toEqual({ from: 1, to: 21 });
  });
});
