import { describe, expect, it } from 'vitest';
import type { Chapter } from '../src/types.js';
import { firstHunk, hunkPosition, lockPairOfHunk, nextPos, pageOf, prevPos, summaryHunkIds } from '../src/tui/nav.js';

const ch = (id: string, hunks: number, extra: Partial<Chapter> = {}) => ({ id, hunkIds: Array.from({ length: hunks }, (_, i) => `${id}${i}`), ...extra }) as Chapter;
const chapters = [ch('a', 2), ch('imports', 1, { optional: true }), ch('lock', 3, { collapsed: true }), ch('b', 1)];

describe('nextPos and prevPos', () => {
  it('steps through hunks, then to the next chapter that is not optional', () => {
    expect(nextPos(chapters, 0, 0)).toEqual({ ci: 0, hi: 1 });
    expect(nextPos(chapters, 0, 1)).toEqual({ ci: 2, hi: -1 });
    expect(nextPos(chapters, 2, -1)).toEqual({ ci: 3, hi: 0 });
    expect(nextPos(chapters, 2, 1)).toEqual({ ci: 2, hi: 2 });
    expect(nextPos(chapters, 3, 0)).toBeUndefined();
  });

  it('steps back through hunks, a collapsed summary, and the end of the previous chapter', () => {
    expect(prevPos(chapters, 3, 0)).toEqual({ ci: 2, hi: -1 });
    expect(prevPos(chapters, 2, 0)).toEqual({ ci: 2, hi: -1 });
    expect(prevPos(chapters, 2, -1)).toEqual({ ci: 0, hi: 1 });
    expect(prevPos(chapters, 0, 0)).toBeUndefined();
  });

  it('starts a collapsed chapter on its summary', () => {
    expect(firstHunk(chapters, 2)).toBe(-1);
    expect(firstHunk(chapters, 0)).toBe(0);
    expect(firstHunk(chapters, 9)).toBe(0);
  });
});

describe('a chapter with folded hunks', () => {
  // Two manifest hunks, then two lockfile hunks behind the summary page.
  const deps = ch('deps', 4, { folded: ['deps2', 'deps3'] });
  const list = [ch('a', 1), deps, ch('b', 1)];

  it('opens on the summary, then steps through the other hunks and leaves', () => {
    expect(nextPos(list, 0, 0)).toEqual({ ci: 1, hi: -1 });
    expect(nextPos(list, 1, -1)).toEqual({ ci: 1, hi: 0 });
    expect(nextPos(list, 1, 0)).toEqual({ ci: 1, hi: 1 });
    expect(nextPos(list, 1, 1)).toEqual({ ci: 2, hi: 0 });
  });

  it('steps through folded hunks opened from the summary on their own', () => {
    expect(nextPos(list, 1, 2)).toEqual({ ci: 1, hi: 3 });
    expect(nextPos(list, 1, 3)).toEqual({ ci: 2, hi: 0 });
    expect(prevPos(list, 1, 2)).toEqual({ ci: 1, hi: -1 });
  });

  it('steps back to the summary, and from the next chapter to the last hunk that is not folded', () => {
    expect(prevPos(list, 2, 0)).toEqual({ ci: 1, hi: 1 });
    expect(prevPos(list, 1, 1)).toEqual({ ci: 1, hi: 0 });
    expect(prevPos(list, 1, 0)).toEqual({ ci: 1, hi: -1 });
    expect(prevPos(list, 1, -1)).toEqual({ ci: 0, hi: 0 });
  });

  it('lists the folded hunks on the summary page', () => {
    expect(summaryHunkIds(deps)).toEqual(['deps2', 'deps3']);
    expect(summaryHunkIds(chapters[2])).toEqual(['lock0', 'lock1', 'lock2']);
  });
});

describe('a chapter with lockfile pairs', () => {
  // A Dockerfile hunk, two manifest hunks locked by one lockfile (two hunks), and a folded lockfile.
  const deps = ch('deps', 6, {
    hunkIds: ['docker', 'web', 'api', 'folded', 'lock1', 'lock2'],
    folded: ['folded'],
    lockPairs: [{ lockfile: 'pnpm-lock.yaml', hunkIds: ['web', 'api'], lockHunkIds: ['lock1', 'lock2'] }],
  });
  const list = [ch('a', 1), deps, ch('b', 1)];

  it('steps through the manifest pages and never onto the paired lockfile hunks', () => {
    expect(nextPos(list, 1, -1)).toEqual({ ci: 1, hi: 0 });
    expect(nextPos(list, 1, 1)).toEqual({ ci: 1, hi: 2 });
    expect(nextPos(list, 1, 2)).toEqual({ ci: 2, hi: 0 });
    expect(prevPos(list, 2, 0)).toEqual({ ci: 1, hi: 2 });
    expect(prevPos(list, 1, 0)).toEqual({ ci: 1, hi: -1 });
  });

  it('opens on its summary only for a lockfile with no pair', () => {
    const pairedOnly = { ...deps, folded: undefined, hunkIds: ['web', 'api', 'lock1', 'lock2'] };
    expect(firstHunk([pairedOnly], 0)).toBe(0);
    expect(nextPos([pairedOnly, ch('b', 1)], 0, 1)).toEqual({ ci: 1, hi: 0 });
    expect(prevPos([ch('a', 1), pairedOnly], 1, 0)).toEqual({ ci: 0, hi: 0 });
    expect(prevPos([pairedOnly, ch('b', 1)], 1, 0)).toEqual({ ci: 0, hi: 1 });
  });

  it('reads a paired lockfile hunk on its first manifest page, and a folded one on the summary', () => {
    expect(pageOf(deps, 4)).toBe(1);
    expect(pageOf(deps, 5)).toBe(1);
    expect(pageOf(deps, 3)).toBe(-1);
    expect(pageOf(deps, 2)).toBe(2);
    expect(lockPairOfHunk(deps, 'api')?.lockfile).toBe('pnpm-lock.yaml');
    expect(lockPairOfHunk(deps, 'lock1')).toBeUndefined();
  });

  it('numbers the pages without the lockfile hunks read on them or on the summary', () => {
    expect(hunkPosition(deps, 0)).toEqual({ n: 1, total: 3 });
    expect(hunkPosition(deps, 2)).toEqual({ n: 3, total: 3 });
    expect(hunkPosition(deps, 3)).toEqual({ n: 1, total: 1 });
    expect(hunkPosition(deps, 5)).toEqual({ n: 2, total: 2 });
  });
});
