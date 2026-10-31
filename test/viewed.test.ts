import { describe, expect, it } from 'vitest';
import { hunksViewedOnGitHub, viewedChanges } from '../src/review/viewed.js';
import type { ViewedState } from '../src/github/gh.js';
import { filesFor, hunk } from './fixtures/tour.js';
import type { States } from '../src/review/hunkState.js';

const a1 = hunk('a1', 'src/a.ts', []);
const a2 = hunk('a2', 'src/a.ts', []);
const b1 = hunk('b1', 'src/b.ts', []);
const c1 = hunk('c1', 'src/c.ts', []);
const tour = { files: filesFor([a1, a2, b1, c1]), hunks: { a1, a2, b1, c1 } };
const viewed = (o: Record<string, ViewedState>) => new Map(Object.entries(o));

describe('Viewed sync', () => {
  it('reads the unread hunks of files viewed on GitHub, but not of dismissed ones', () => {
    const states: States = { [a1.contentHash]: 'skipped' };
    expect(hunksViewedOnGitHub(tour, states, viewed({ 'src/a.ts': 'VIEWED', 'src/b.ts': 'DISMISSED' })).map((h) => h.id)).toEqual(['a2']);
  });

  it('ticks a file once every hunk is read or skipped, and clears it when one is not', () => {
    const changed = [a2];
    const partway: States = { [a2.contentHash]: 'read' };
    expect(viewedChanges(tour, partway, viewed({}), changed)).toEqual([]);
    const through: States = { [a1.contentHash]: 'skipped', [a2.contentHash]: 'read' };
    expect(viewedChanges(tour, through, viewed({}), changed)).toEqual([{ path: 'src/a.ts', viewed: true }]);
    // Already viewed there: nothing to send.
    expect(viewedChanges(tour, through, viewed({ 'src/a.ts': 'VIEWED' }), changed)).toEqual([]);
    // u on a hunk of a viewed file clears it; a deferred hunk is still to do.
    expect(viewedChanges(tour, { [a1.contentHash]: 'read' }, viewed({ 'src/a.ts': 'VIEWED' }), [a2])).toEqual([{ path: 'src/a.ts', viewed: false }]);
    expect(viewedChanges(tour, { [a1.contentHash]: 'read', [a2.contentHash]: 'deferred' }, viewed({}), [a2])).toEqual([]);
  });

  it('only looks at the files of the hunks that changed', () => {
    const states: States = { [b1.contentHash]: 'read', [c1.contentHash]: 'read' };
    expect(viewedChanges(tour, states, viewed({}), [c1])).toEqual([{ path: 'src/c.ts', viewed: true }]);
  });
});
