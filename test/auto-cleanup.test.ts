import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { autoCleanup } from '../src/cleanup.js';
import { Store } from '../src/store/db.js';
import { tour } from './fixtures/tour.js';

const DAY = 86_400_000;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-auto-cleanup-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

const stamp = () => JSON.parse(fs.readFileSync(path.join(home, 'cleanup.json'), 'utf8')) as { ranAt: number };

it('deletes tours not opened in 30 days, at most once a day', async () => {
  const now = Date.now();
  const store = new Store(path.join(home, 'gr.db'));
  vi.useFakeTimers();
  vi.setSystemTime(now - 40 * DAY);
  store.saveTour(tour([], [], { pr: 1, headSha: 'old' }));
  vi.setSystemTime(now - 10 * DAY);
  store.saveTour(tour([], [], { pr: 2, headSha: 'recent' }));
  vi.useRealTimers();

  const first = await autoCleanup(home, now);
  expect(first).toMatchObject({ tours: 1, repos: [], worktrees: { removed: [], skipped: [] } });
  expect(stamp().ranAt).toBe(now);
  expect(store.listTours('o/r', 1)).toEqual([]);
  expect(store.listTours('o/r', 2).map((t) => t.headSha)).toEqual(['recent']);

  expect(await autoCleanup(home, now + DAY - 1)).toBeUndefined();
  expect(stamp().ranAt).toBe(now);
  expect(await autoCleanup(home, now + DAY)).toBeDefined();
  expect(stamp().ranAt).toBe(now + DAY);
  store.close();
});

it('runs when the saved time is unreadable or in the future', async () => {
  const now = Date.now();
  fs.writeFileSync(path.join(home, 'cleanup.json'), 'not json');
  expect(await autoCleanup(home, now)).toBeDefined();
  fs.writeFileSync(path.join(home, 'cleanup.json'), JSON.stringify({ ranAt: now + DAY }));
  expect(await autoCleanup(home, now)).toBeDefined();
});

it('saves the time only once the cleanup has run, so one cut short runs again', async () => {
  const now = Date.now();
  const run = autoCleanup(home, now);
  expect(fs.existsSync(path.join(home, 'cleanup.json'))).toBe(false);
  await run;
  expect(stamp().ranAt).toBe(now);
});
