import fs from 'node:fs';
import path from 'node:path';
import { cleanupRepos, cleanupWorktrees } from './git/worktree.js';
import { grHome } from './paths.js';
import { AUTO_CLEANUP_DAYS, AUTO_CLEANUP_INTERVAL_MS, AUTO_WORKTREE_DAYS, REPO_MAX_AGE_DAYS } from './store/retention.js';

export interface CleanupResult {
  worktrees: Awaited<ReturnType<typeof cleanupWorktrees>>;
  repos: string[];
  tours: number;
  prs: number;
}

// What `gr cleanup` does: removes clean PR worktrees (with `worktreeDays`, only those unused that
// long), then cached clones unused in REPO_MAX_AGE_DAYS, keeps each PR's newest tours, then
// deletes tours not opened in `days` days and the state of PRs left without one.
export async function cleanup(days: number, home = grHome(), opts: { worktreeDays?: number; now?: number } = {}): Promise<CleanupResult> {
  const worktrees = await cleanupWorktrees(home, { unusedDays: opts.worktreeDays, now: opts.now });
  const repos = await cleanupRepos(home, { unusedDays: REPO_MAX_AGE_DAYS, now: opts.now });
  // Loaded here, not at the top, so node:sqlite loads after the CLI's warning filter.
  const { Store } = await import('./store/db.js');
  const store = new Store(path.join(home, 'gr.db'));
  try {
    const extra = store.pruneTours();
    const stale = store.pruneStale(days);
    return { worktrees, repos, tours: extra + stale.tours, prs: stale.prs };
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

// Run as a tour starts, at most once a day: `gr cleanup --days 30`, except that it keeps PR
// worktrees used in the last few days. Silent, and never fails the launch. The time is saved once
// it ends, failed or not, so a cleanup cut short by gr exiting runs again next launch, while one
// that fails is not retried on every launch.
export async function autoCleanup(home?: string, now = Date.now()): Promise<CleanupResult | undefined> {
  try {
    home ??= grHome();
    const file = path.join(home, 'cleanup.json');
    const ranAt = lastRun(file);
    if (ranAt !== undefined && ranAt <= now && now - ranAt < AUTO_CLEANUP_INTERVAL_MS) return undefined;
    try {
      return await cleanup(AUTO_CLEANUP_DAYS, home, { worktreeDays: AUTO_WORKTREE_DAYS, now });
    } finally {
      fs.writeFileSync(file, `${JSON.stringify({ ranAt: now })}\n`);
    }
  } catch {
    return undefined;
  }
}
