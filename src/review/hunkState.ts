import type { Hunk, ReadState } from '../types.js';

export type States = Record<string, ReadState>; // content hash -> state

// The keys a hunk's read state and moves are stored under. A fused hunk uses those of the
// GitHub hunks it joins, so they survive the fusing changing between heads (a push that moves
// two changes apart, or closer), and carry over from tours built before hunks were fused.
export const hunkKeys = (h: Hunk): string[] => h.parts ?? [h.contentHash];

// Least reviewed first: a fused hunk is only as far along as its least reviewed part.
const PROGRESS: ReadState[] = ['unread', 'deferred', 'skipped', 'read'];

export function stateOf(states: States, h: Hunk | undefined): ReadState {
  if (!h) return 'unread';
  return hunkKeys(h)
    .map((k) => states[k] ?? 'unread')
    .reduce((least, s) => (PROGRESS.indexOf(s) < PROGRESS.indexOf(least) ? s : least), 'read');
}
