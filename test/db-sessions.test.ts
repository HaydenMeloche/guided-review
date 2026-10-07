import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_SIZE_LIMIT, KEEP_TOURS_PER_PR, Store } from '../src/store/db.js';
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

describe('agent session table', () => {
  it('stores sessions per head and role without rewriting the tour', () => {
    const store = open();
    const t = tour([], [], { headSha: 'h1' });
    store.saveTour(t);
    store.saveSession('o/r', 1, 'h1', 'qa', 's1');
    store.saveSession('o/r', 1, 'h1', 'qa', 's2'); // replaces
    store.saveSession('o/r', 1, 'h2', 'qa', 'other-head');
    expect(store.loadSessions('o/r', 1, 'h1')).toEqual({ qa: 's2' });
    expect(store.loadSessions('o/r', 2, 'h1')).toEqual({});
    expect(store.loadTour('o/r', 1, 'h1')?.agentSessions).toBeUndefined();
  });

  it('drops sessions whose tour was pruned', () => {
    const store = open();
    for (let day = 1; day <= KEEP_TOURS_PER_PR; day++) {
      store.saveTour(tour([], [], { headSha: `a${day}`, createdAt: at(day) }));
      store.saveSession('o/r', 1, `a${day}`, 'qa', `s${day}`);
    }
    store.saveTour(tour([], [], { headSha: 'a9', createdAt: at(9) }));
    expect(store.loadSessions('o/r', 1, 'a1')).toEqual({});
    expect(store.loadSessions('o/r', 1, 'a2')).toEqual({ qa: 's2' });
  });
});

describe('store tuning', () => {
  it('prunes a PR’s older tours on save and keeps the one just saved', () => {
    const store = open();
    for (let day = 1; day <= 5; day++) store.saveTour(tour([], [], { headSha: `a${day}`, createdAt: at(day) }));
    store.saveTour(tour([], [], { pr: 2, headSha: 'b1', createdAt: at(1) }));
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toEqual(['a5', 'a4', 'a3']);
    expect(store.listTours('o/r', 2).map((t) => t.headSha)).toEqual(['b1']);

    // Re-saving an older head (opening it again) keeps it, even though newer tours exist.
    store.saveTour(tour([], [], { headSha: 'a1', createdAt: at(1) }));
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toContain('a1');
    expect(store.listTours('o/r', 1)).toHaveLength(KEEP_TOURS_PER_PR);
  });

  it('runs in WAL mode with synchronous=NORMAL, a WAL size limit and incremental vacuum', () => {
    const store = open();
    expect(store.pragmas()).toEqual({ journalMode: 'wal', synchronous: 1, autoVacuum: 2, journalSizeLimit: JOURNAL_SIZE_LIMIT });
  });

  it('stores tours compressed', () => {
    const store = open();
    const big = 'x'.repeat(200_000);
    store.saveTour(tour([], [], { headSha: 'h1', intent: big }));
    const raw = new DatabaseSync(path.join(home, 'gr.db'));
    const { size } = raw.prepare('SELECT length(tour) AS size FROM tours').get() as { size: number };
    raw.close();
    expect(size).toBeLessThan(big.length / 10);
    expect(store.loadTour('o/r', 1, 'h1')?.intent).toBe(big);
  });

  it('prunes tours another gr process wrote beyond the limit', () => {
    const store = open();
    for (let day = 1; day <= 3; day++) store.saveTour(tour([], [], { headSha: `a${day}`, createdAt: at(day) }));
    const raw = new DatabaseSync(path.join(home, 'gr.db'));
    raw.exec("INSERT INTO tours (repo, pr, head, created_at, tour) VALUES ('o/r', 1, 'extra', '2025-01-01', x'00')");
    raw.close();
    expect(store.pruneTours()).toBe(1);
    expect(store.listTours('o/r', 1).map((t) => t.headSha)).toEqual(['a3', 'a2', 'a1']);
  });

  it('reuses prepared statements', () => {
    const store = open();
    store.getReadStates('o/r', 1);
    const count = (store as unknown as { statements: Map<string, unknown> }).statements.size;
    for (let i = 0; i < 5; i++) store.getReadStates('o/r', 1);
    expect((store as unknown as { statements: Map<string, unknown> }).statements.size).toBe(count);
  });
});
