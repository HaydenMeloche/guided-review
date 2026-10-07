import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_TOURS_PER_PR, SCHEMA_VERSION, Store } from '../src/store/db.js';
import type { Draft } from '../src/types.js';
import { tour } from './fixtures/tour.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let home: string;
let previousHome: string | undefined;
const stores: Store[] = [];

function open(): Store {
  const store = new Store();
  stores.push(store);
  return store;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-db-'));
  previousHome = process.env.GR_HOME;
  process.env.GR_HOME = home;
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (previousHome === undefined) delete process.env.GR_HOME;
  else process.env.GR_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;

describe('Store schema versioning', () => {
  it('creates a fresh database in GR_HOME at the latest version', () => {
    const store = open();
    expect(fs.existsSync(path.join(home, 'gr.db'))).toBe(true);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    store.saveTour(tour([], [], { headSha: 'h1' }));
    expect(store.loadTour('o/r', 1, 'h1')?.headSha).toBe('h1');
  });

  it('is idempotent across reopen', () => {
    open().saveTour(tour([], [], { headSha: 'h1' }));
    const again = open();
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(again.listTours('o/r', 1)).toHaveLength(1);
  });

  it('refuses a database from a newer gr', () => {
    const raw = new DatabaseSync(path.join(home, 'gr.db'));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => open()).toThrow('newer version of gr');
  });
});

describe('Store.pruneTours', () => {
  it(`keeps the newest ${KEEP_TOURS_PER_PR} tours per PR`, () => {
    const store = open();
    for (let day = 1; day <= 5; day++) store.saveTour(tour([], [], { headSha: `a${day}`, createdAt: at(day) }));
    store.saveTour(tour([], [], { pr: 2, headSha: 'b1', createdAt: at(1) }));
    store.saveTour(tour([], [], { repo: 'o/other', headSha: 'c1', createdAt: at(1) }));

    // saveTour already prunes per PR; an explicit prune finds nothing more to remove.
    expect(store.pruneTours()).toBe(0);
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toEqual(['a5', 'a4', 'a3']);
    expect(store.listTours('o/r', 2).map((t) => t.headSha)).toEqual(['b1']);
    expect(store.listTours('o/other', 1).map((t) => t.headSha)).toEqual(['c1']);
    expect(store.pruneTours(1)).toBe(2);
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toEqual(['a5']);
  });

  it('keeps a reopened older head over newer heads that were not opened since', () => {
    vi.useFakeTimers();
    try {
      const store = open();
      for (let day = 1; day <= 3; day++) {
        vi.setSystemTime(new Date(at(day)));
        store.saveTour(tour([], [], { headSha: `a${day}`, createdAt: at(day) }));
      }
      vi.setSystemTime(new Date(at(9)));
      expect(store.loadTour('o/r', 1, 'a1')?.headSha).toBe('a1');
      expect(store.pruneTours(2)).toBe(1);
      expect(
        store
          .listTours('o/r', 1)
          .map((t) => t.headSha)
          .sort(),
      ).toEqual(['a1', 'a3']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Store.pruneStale', () => {
  const draft = (id: string, pr: number, posted: boolean): Draft => ({
    id,
    repo: 'o/r',
    pr,
    headSha: 'h',
    label: 'nit',
    body: id,
    posted,
    createdAt: at(1),
    anchor: { type: 'chapter', chapterId: 'c0' },
  });

  it('deletes tours not opened within the window and the state of PRs left without one, keeping unposted drafts', () => {
    vi.useFakeTimers();
    try {
      const store = open();
      vi.setSystemTime(new Date(at(1)));
      store.saveTour(tour([], [], { pr: 1, headSha: 'old', createdAt: at(1) }));
      store.saveTour(tour([], [], { pr: 2, headSha: 'kept', createdAt: at(1) }));
      for (const pr of [1, 2]) {
        store.setReadState('o/r', pr, 'abc', 'read');
        store.setPosition('o/r', pr, { chapterId: 'c1', order: 'flow' });
        store.saveSession('o/r', pr, pr === 1 ? 'old' : 'kept', 'qa', 's');
      }
      store.saveDrafts([draft('posted', 1, true), draft('unposted', 1, false), draft('other', 2, true)]);

      vi.setSystemTime(new Date(at(20)));
      store.loadTour('o/r', 2, 'kept'); // opened recently
      expect(store.pruneStale(10, new Date(at(20)))).toEqual({ tours: 1, prs: 1 });

      expect(store.listTours('o/r', 1)).toEqual([]);
      expect(store.getReadStates('o/r', 1)).toEqual({});
      expect(store.getPosition('o/r', 1)).toBeUndefined();
      expect(store.loadSessions('o/r', 1, 'old')).toEqual({});
      expect(store.listDrafts('o/r', 1).map((d) => d.id)).toEqual(['unposted']);

      expect(store.listTours('o/r', 2)).toHaveLength(1);
      expect(store.getReadStates('o/r', 2)).toEqual({ abc: 'read' });
      expect(store.loadSessions('o/r', 2, 'kept')).toEqual({ qa: 's' });
      expect(store.listDrafts('o/r', 2)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
