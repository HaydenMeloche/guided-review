import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { localChanges } from '../src/preview.js';
import { PickerScreen } from '../src/tui/PickerScreen.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', async (orig) => ({
  parsePRArg: (await orig<typeof import('../src/github/gh.js')>()).parsePRArg,
  currentRepo: vi.fn(async () => {
    throw new Error('no gh');
  }),
  listReviewRequests: vi.fn(async () => []),
  listAuthoredPRs: vi.fn(async () => ({ prs: [], truncated: false })),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
  viewerLogin: vi.fn(async () => 'me'),
}));

// Real git on a temp repo with no remote, so the default branch is main.
let dir: string;
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-local-')));
  git('init', '-q', '-b', 'main');
  write('a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('localChanges', () => {
  it('is undefined while the checked-out branch matches the default branch', async () => {
    expect(await localChanges(dir)).toBeUndefined();
    git('checkout', '-qb', 'feature');
    expect(await localChanges(dir)).toBeUndefined();
  });

  it('counts commits, changed and untracked files, and uncommitted work', async () => {
    git('checkout', '-qb', 'feature');
    write('a.ts', 'export const a = 2;\n');
    git('commit', '-qam', 'change a');
    expect(await localChanges(dir)).toEqual({ branch: 'feature', base: 'main', commits: 1, files: 1, uncommitted: false });
    write('a.ts', 'export const a = 3;\n');
    write('b.ts', 'export const b = 1;\n');
    expect(await localChanges(dir)).toEqual({ branch: 'feature', base: 'main', commits: 1, files: 2, uncommitted: true });
  });

  it('sees uncommitted work on the default branch itself', async () => {
    write('a.ts', 'export const a = 2;\n');
    expect(await localChanges(dir)).toEqual({ branch: 'main', base: 'main', commits: 0, files: 1, uncommitted: true });
  });
});

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;

describe('local changes on the PR list', () => {
  const props = { store, width: 100, height: 24, onPick: () => {}, onQuit: () => {}, readClipboard: async () => undefined, downloads: {}, onDownload: () => {} };

  it('pins the checked-out branch above the list, and l opens its tour', async () => {
    const onLocal = vi.fn();
    const changes = { branch: 'feature/discount', base: 'main', commits: 2, files: 3, uncommitted: true };
    const ui = render(<PickerScreen {...props} onLocal={onLocal} readLocalChanges={async () => changes} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Local changes'));
    expect(ui.lastFrame()).toContain('feature/discount');
    expect(ui.lastFrame()).toContain('Local changes  l open tour');
    expect(ui.lastFrame()).toContain('3 files · 2 commits ahead of main · uncommitted work');
    ui.stdin.write('l');
    await waitFor(() => expect(onLocal).toHaveBeenCalled());
    ui.unmount();
  });

  it('offers nothing with no local changes, and l says why', async () => {
    const onLocal = vi.fn();
    const read = vi.fn(async () => undefined);
    const ui = render(<PickerScreen {...props} onLocal={onLocal} readLocalChanges={read} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Nothing is waiting on your review.'));
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(ui.lastFrame()).not.toContain('Local changes');
    expect(ui.lastFrame()).not.toContain('gr preview');
    ui.stdin.write('l');
    await waitFor(() => expect(ui.lastFrame()).toContain('No local changes to tour'));
    expect(onLocal).not.toHaveBeenCalled();
    ui.unmount();
  });
});
