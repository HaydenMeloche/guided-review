import type { Chapter, ChapterOrder, Hunk, ReadState, Tour } from '../types.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { hunkKeys, stateOf, type States } from '../review/hunkState.js';

export const ORDER_SEQUENCE: ChapterOrder[] = ['flow', 'risk', 'size', 'file'];
export const ORDER_LABEL: Record<ChapterOrder, string> = { flow: 'Guided', risk: 'Risk first', size: 'Small first', file: 'File' };

export function sortChapters(chapters: Chapter[], tour: Tour, order: ChapterOrder): Chapter[] {
  if (order === 'flow' || order === 'file') return chapters;
  const size = (c: Chapter) => c.hunkIds.reduce((n, id) => n + (tour.hunks[id] ? changedLineCount(tour.hunks[id]) : 0), 0);
  const risk = (c: Chapter) => Math.max(0, ...c.hunkIds.map((id) => tour.hunks[id]?.risk ?? 0));
  return chapters
    .map((chapter, index) => ({ chapter, index }))
    .sort((a, b) => Number(!!a.chapter.optional) - Number(!!b.chapter.optional) || (order === 'risk' ? risk(b.chapter) - risk(a.chapter) : size(a.chapter) - size(b.chapter)) || a.index - b.index)
    .map(({ chapter }) => chapter);
}

export function positionAfterOrderChange(previous: Chapter[], position: { ci: number; hi: number }, next: Chapter[]): { ci: number; hi: number } {
  const currentChapter = previous[position.ci];
  const currentHunk = currentChapter?.hunkIds[position.hi >= 0 ? position.hi : 0];
  const ci = Math.max(
    0,
    next.findIndex((c) => (currentHunk && c.hunkIds.includes(currentHunk)) || c.id === currentChapter?.id),
  );
  const chapter = next[ci];
  const hi = currentHunk && chapter?.hunkIds.includes(currentHunk) ? chapter.hunkIds.indexOf(currentHunk) : chapter?.collapsed ? -1 : 0;
  return { ci, hi };
}

export { stateOf, type States };

export function changedLineCount(h: Hunk): number {
  let n = 0;
  for (const l of h.lines) if (l.kind !== 'ctx') n++;
  return n;
}

// Hunks the reviewer dragged to another chapter. Moves are keyed by content hash (each part
// of a fused hunk) so they survive a re-analysis of the same change.
export function applyMoves(chapters: Chapter[], tour: Tour, moves: Record<string, string>): Chapter[] {
  if (!Object.keys(moves).length) return chapters;
  const out = chapters.map((c) => ({ ...c, hunkIds: [...c.hunkIds] }));
  for (const [hash, target] of Object.entries(moves)) {
    const hunk = Object.values(tour.hunks).find((h) => hunkKeys(h).includes(hash));
    const dest = out.find((c) => c.id === target);
    if (!hunk || !dest) continue;
    for (const c of out) c.hunkIds = c.hunkIds.filter((id) => id !== hunk.id);
    dest.hunkIds.push(hunk.id);
  }
  return out;
}

export interface Progress {
  readLines: number;
  totalLines: number;
  read: number;
  skipped: number;
  deferred: number;
  unread: number;
  total: number;
}

// Collapsed hunks count as unread until opened or explicitly skipped. Import-only
// hunks are optional, so they never count.
export function progress(tour: Tour, states: States, only?: string[]): Progress {
  const p: Progress = { readLines: 0, totalLines: 0, read: 0, skipped: 0, deferred: 0, unread: 0, total: 0 };
  const hunks = only ? only.map((id) => tour.hunks[id]).filter(Boolean) : Object.values(tour.hunks);
  for (const h of hunks) {
    if (h.importOnly) continue;
    const n = changedLineCount(h);
    const s = stateOf(states, h);
    p.total++;
    p.totalLines += n;
    p[s]++;
    if (s === 'read' || s === 'skipped') p.readLines += n;
  }
  return p;
}

export function riskMark(risk: number): { mark: string; color: string } {
  if (risk >= 3) return { mark: '▲', color: 'red' };
  if (risk === 2) return { mark: '▲', color: 'yellow' };
  if (risk === 1) return { mark: '△', color: 'gray' };
  return { mark: ' ', color: 'gray' };
}

export function stateMark(s: ReadState): { mark: string; color: string } {
  switch (s) {
    case 'read':
      return { mark: '✓', color: 'green' };
    case 'skipped':
      return { mark: '⤼', color: 'gray' };
    case 'deferred':
      return { mark: '◷', color: 'yellow' };
    default:
      return { mark: '·', color: 'gray' };
  }
}

export function chapterState(tour: Tour, c: Chapter, states: States): ReadState {
  const hs = c.hunkIds.map((id) => tour.hunks[id]).filter((h) => h && !h.importOnly);
  if (!hs.length) return 'read';
  const ss = hs.map((h) => stateOf(states, h));
  if (ss.every((s) => s === 'read')) return 'read';
  if (ss.every((s) => s === 'read' || s === 'skipped')) return 'skipped';
  if (ss.some((s) => s === 'deferred')) return 'deferred';
  return 'unread';
}

// truncate and pad strip terminal controls, since most of what they fit is GitHub or
// model text. wrap does not: TextInput threads a \u0000 cursor marker through it.
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  const t = sanitizeTerminal(s.replace(/\t/g, '  '));
  return t.length > width ? t.slice(0, Math.max(0, width - 1)) + '…' : t;
}

export function pad(s: string, width: number): string {
  const t = truncate(s, width);
  return t + ' '.repeat(Math.max(0, width - t.length));
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}
