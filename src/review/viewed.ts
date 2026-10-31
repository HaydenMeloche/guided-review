import type { Hunk, Tour } from '../types.js';
import type { ViewedState } from '../github/gh.js';
import { stateOf, type States } from './hunkState.js';

// gr's read state mirrored to GitHub's Viewed checkboxes, a file at a time: a file is viewed once
// every hunk of it is read or skipped. A deferred hunk is still to do, so its file is not.

const hunksOf = (tour: Pick<Tour, 'files' | 'hunks'>, path: string): Hunk[] => (tour.files.find((f) => f.path === path)?.hunkIds ?? []).map((id) => tour.hunks[id]).filter((h) => h !== undefined);

const done = (states: States, hunks: Hunk[]) => hunks.length > 0 && hunks.every((h) => ['read', 'skipped'].includes(stateOf(states, h)));

// Opening a tour: the unread hunks of files viewed on GitHub, to mark read. A file GitHub
// dismissed (viewed, then changed) is left as it is.
export function hunksViewedOnGitHub(tour: Pick<Tour, 'files' | 'hunks'>, states: States, viewed: ReadonlyMap<string, ViewedState>): Hunk[] {
  return tour.files.filter((f) => viewed.get(f.path) === 'VIEWED').flatMap((f) => hunksOf(tour, f.path).filter((h) => stateOf(states, h) === 'unread'));
}

// After reading state changes for `changed` hunks: the files whose checkbox should now be ticked
// (every hunk done) or cleared (one is not). Only the files of the changed hunks are looked at,
// so a file read before is never ticked behind the reader's back.
export function viewedChanges(tour: Pick<Tour, 'files' | 'hunks'>, states: States, viewed: ReadonlyMap<string, ViewedState>, changed: Hunk[]): { path: string; viewed: boolean }[] {
  const paths = [...new Set(changed.map((h) => h.file))];
  return paths.flatMap((path) => {
    const now = done(states, hunksOf(tour, path));
    const was = viewed.get(path) === 'VIEWED';
    return now === was ? [] : [{ path, viewed: now }];
  });
}
