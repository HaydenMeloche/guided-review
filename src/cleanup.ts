import fs from 'node:fs';
import path from 'node:path';
import { cleanupWorktrees } from './git/worktree.js';
import { grHome } from './paths.js';
import { AUTO_CLEANUP_DAYS, AUTO_CLEANUP_INTERVAL_MS } from './store/retention.js';

export interface CleanupResult {
  worktrees: Awaited<ReturnType<typeof cleanupWorktrees>>;
  tours: number;
  prs: number;
}

// What `gr cleanup` does: removes clean PR worktrees, keeps each PR's newest tours, then deletes
// tours not opened in `days` days and the state of PRs left without one.
export async function cleanup(days: number, home = grHome()): Promise<CleanupResult> {
  const worktrees = await cleanupWorktrees(home);
  // Loaded here, not at the top, so node:sqlite loads after the CLI's warning filter.
  const { Store } = await import('./store/db.js');
  const store = new Store(path.join(home, 'gr.db'));
  try {
    const extra = store.pruneTours();
    const stale = store.pruneStale(days);
    return { worktrees, tours: extra + stale.tours, prs: stale.prs };
  } finally {
    store.close();
  }
}

// When the last automatic cleanup started, or undefined if never or unreadable.
function lastRun(file: string): number | undefined {
  try {
    const ranAt = (JSON.parse(fs.readFileSync(file, 'utf8')) as { ranAt?: unknown }).ranAt;
    return typeof ranAt === 'number' ? ranAt : undefined;
  } catch {
    return undefined;
  }
}

// Run as a tour starts: the same cleanup as `gr cleanup --days 30`, at most once a week. Silent, and
// never fails the launch. The time is saved before it runs, so a cleanup that fails is not retried
// on every launch.
export async function autoCleanup(home?: string, now = Date.now()): Promise<CleanupResult | undefined> {
  try {
    home ??= grHome();
    const file = path.join(home, 'cleanup.json');
    const ranAt = lastRun(file);
    if (ranAt !== undefined && ranAt <= now && now - ranAt < AUTO_CLEANUP_INTERVAL_MS) return undefined;
    fs.writeFileSync(file, `${JSON.stringify({ ranAt: now })}\n`);
    return await cleanup(AUTO_CLEANUP_DAYS, home);
  } catch {
    return undefined;
  }
}
