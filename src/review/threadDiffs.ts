import type { ExistingThread } from '../types.js';
import { diffPath, fetchCommit, hasCommit } from '../git/worktree.js';
import { threadDiffKey, type ThreadDiffs } from './feedback.js';

const DIFF_CONCURRENCY = 4;

// The diff from the commit each thread was written on to the head, one per commit and path.
// `all` reads one for every unresolved thread (author mode, for "probably addressed"); otherwise
// only for outdated threads, whose line has to be followed. A commit gone after a force push
// maps to null.
export async function loadThreadDiffs(worktree: string, headSha: string, threads: ExistingThread[], opts: { all?: boolean; signal?: AbortSignal } = {}): Promise<ThreadDiffs> {
  const out: ThreadDiffs = new Map();
  const wanted = threads.filter((t) => t.originalCommit && t.originalCommit !== headSha && !t.isResolved && (opts.all || t.isOutdated));
  const pairs = [...new Map(wanted.map((t) => [threadDiffKey(t.originalCommit!, t.path), { commit: t.originalCommit!, path: t.path }])).entries()];
  const commits = new Map<string, Promise<boolean>>();
  const available = (sha: string) => {
    let p = commits.get(sha);
    if (!p) {
      p = hasCommit(worktree, sha, opts.signal).then(async (has) => {
        if (has) return true;
        await fetchCommit(worktree, sha, opts.signal).catch(() => undefined);
        return hasCommit(worktree, sha, opts.signal);
      });
      commits.set(sha, p);
    }
    return p;
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(DIFF_CONCURRENCY, pairs.length) }, async () => {
      while (next < pairs.length) {
        const [key, { commit, path }] = pairs[next++];
        opts.signal?.throwIfAborted();
        if (!(await available(commit))) {
          out.set(key, null);
          continue;
        }
        out.set(key, await diffPath(worktree, commit, headSha, path, opts.signal).catch(() => null));
      }
    }),
  );
  return out;
}
