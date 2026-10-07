import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import type { Draft } from '../src/types.js';
import { tour } from './fixtures/tour.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-store-'));
  store = new Store(path.join(dir, 'test.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Store', () => {
  it('saves and loads tours by head', () => {
    store.saveTour(tour([], [], { headSha: 'h1', createdAt: '2026-01-01T00:00:00Z' }));
    store.saveTour(tour([], [], { headSha: 'h2', createdAt: '2026-01-02T00:00:00Z' }));
    expect(store.loadTour('o/r', 1, 'h1')?.headSha).toBe('h1');
    expect(store.latestTour('o/r', 1)?.headSha).toBe('h2');
    expect(store.latestTour('o/r', 1, 'h2')?.headSha).toBe('h1');
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toEqual(['h2', 'h1']);
  });

  it('tracks read state, positions and moves', () => {
    store.setReadState('o/r', 1, 'abc', 'read');
    store.setReadState('o/r', 1, 'def', 'skipped');
    store.setReadState('o/r', 1, 'def', 'unread');
    expect(store.getReadStates('o/r', 1)).toEqual({ abc: 'read' });
    store.setPosition('o/r', 1, { chapterId: 'c1', hunkId: 'h', order: 'flow' });
    expect(store.getPosition('o/r', 1)).toEqual({ chapterId: 'c1', hunkId: 'h', order: 'flow' });
    store.setMove('o/r', 1, 'abc', 'c2');
    expect(store.getMoves('o/r', 1)).toEqual({ abc: 'c2' });
  });

  it('upserts drafts and marks them posted', () => {
    const d: Draft = {
      id: 'd1',
      repo: 'o/r',
      pr: 1,
      headSha: 'h',
      label: 'nit',
      body: 'x',
      posted: false,
      createdAt: '2026-01-01T00:00:00Z',
      anchor: { type: 'chapter', chapterId: 'c0' },
    };
    store.saveDraft(d);
    store.saveDraft({ ...d, body: 'y' });
    expect(store.listDrafts('o/r', 1).map((x) => x.body)).toEqual(['y']);
    store.saveDraft({ ...d, id: 'd2', createdAt: '2026-01-02T00:00:00Z' });
    store.markPosted(['d1', 'missing']);
    expect(store.listDrafts('o/r', 1).map((x) => [x.id, x.posted, x.body])).toEqual([
      ['d1', true, 'y'],
      ['d2', false, 'x'],
    ]);
    store.deleteDraft('d2');
    store.deleteDraft('d1');
    expect(store.listDrafts('o/r', 1)).toEqual([]);
  });
});
