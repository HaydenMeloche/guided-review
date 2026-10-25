import type { Chapter, ChapterOrder, Hunk, ReadState, Tour } from '../types.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { hunkKeys, stateOf, type States } from '../review/hunkState.js';
import { G } from './glyphs.js';

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
  const hi = currentHunk && chapter?.hunkIds.includes(currentHunk) ? chapter.hunkIds.indexOf(currentHunk) : opensOnSummary(chapter) ? -1 : 0;
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

// A thin progress meter, `cells` wide: filled ▰ for what is done, ▱ for the rest.
export function meter(done: number, total: number, cells: number): { filled: string; rest: string; percent: number } {
  const fraction = total ? Math.min(1, done / total) : 1;
  const n = Math.round(fraction * cells);
  return { filled: G.meterOn.repeat(n), rest: G.meterOff.repeat(cells - n), percent: Math.round(fraction * 100) };
}

export function riskMark(risk: number): { mark: string; color: string } {
  if (risk >= 3) return { mark: G.risk, color: 'red' };
  if (risk === 2) return { mark: G.risk, color: 'yellow' };
  if (risk === 1) return { mark: G.lowRisk, color: 'gray' };
  return { mark: ' ', color: 'gray' };
}

export function stateMark(s: ReadState): { mark: string; color: string } {
  switch (s) {
    case 'read':
      return { mark: G.read, color: 'green' };
    case 'skipped':
      return { mark: G.skipped, color: 'gray' };
    case 'deferred':
      return { mark: G.deferred, color: 'yellow' };
    default:
      return { mark: G.unread, color: 'gray' };
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

// Positions are a chapter and a hunk in it; hunk -1 is the summary page a chapter opens on when
// it is collapsed or has folded hunks.
export const opensOnSummary = (c: Chapter | undefined): boolean => !!c && (c.collapsed || !!c.folded?.length);
export const firstHunk = (chapters: Chapter[], ci: number) => (opensOnSummary(chapters[ci]) ? -1 : 0);

// The hunks a chapter's summary page lists: its folded ones, or all of a collapsed chapter's.
export function summaryHunkIds(c: Chapter): string[] {
  if (!c.folded?.length) return c.hunkIds;
  const folded = new Set(c.folded);
  return c.hunkIds.filter((id) => folded.has(id));
}

// Hunks n and p do not step onto from the chapter's pages: folded ones (read on the summary
// page, or opened from it) and the lockfile hunks of a pair (read on its manifest pages).
export function asideHunkIds(c: Chapter): Map<string, 'folded' | 'paired'> {
  const out = new Map<string, 'folded' | 'paired'>();
  for (const p of c.lockPairs ?? []) for (const id of p.lockHunkIds) out.set(id, 'paired');
  for (const id of c.folded ?? []) out.set(id, 'folded');
  return out;
}

// The lockfile pair whose page a hunk is: one of its manifest hunks.
export function lockPairOfHunk(c: Chapter | undefined, hunkId: string | undefined) {
  return hunkId ? c?.lockPairs?.find((p) => p.hunkIds.includes(hunkId)) : undefined;
}

// Where hunk `hi` of a chapter is read: the summary page (-1) for a collapsed chapter or a folded
// hunk, its pair's first manifest page for a paired lockfile hunk, else its own page.
export function pageOf(c: Chapter, hi: number): number {
  const id = c.hunkIds[hi];
  if (c.collapsed || c.folded?.includes(id)) return -1;
  const pair = c.lockPairs?.find((p) => p.lockHunkIds.includes(id));
  if (!pair) return hi;
  const first = c.hunkIds.findIndex((h) => pair.hunkIds.includes(h));
  return first >= 0 ? first : hi;
}

// n and p step through the folded hunks, opened from the summary, apart from the rest.
const sameSide = (aside: Map<string, string>, c: Chapter, a: number, b: number) => aside.get(c.hunkIds[a]) === aside.get(c.hunkIds[b]);

// Where hunk `hi` is among the hunks n and p step through with it, for "hunk 2/3": the chapter's
// pages, not counting the lockfile hunks read on a summary or a manifest's page.
export function hunkPosition(c: Chapter, hi: number): { n: number; total: number } {
  const aside = asideHunkIds(c);
  const peers = c.hunkIds.map((_, j) => j).filter((j) => sameSide(aside, c, hi, j));
  return { n: peers.indexOf(hi) + 1, total: peers.length };
}

// Where n goes: the next hunk, else the start of the next chapter; undefined at the end of the
// tour. From a summary page, a chapter with folded hunks goes on to the others. n and p never
// step into optional chapters (import-only changes); ] and [ and the chapter list still reach them.
export function nextPos(chapters: Chapter[], ci: number, hi: number): { ci: number; hi: number } | undefined {
  const chapter = chapters[ci];
  const aside = asideHunkIds(chapter);
  if (hi < 0 && !chapter.collapsed) {
    const first = chapter.hunkIds.findIndex((id) => !aside.has(id));
    if (first >= 0) return { ci, hi: first };
  } else if (hi >= 0) {
    const i = chapter.hunkIds.findIndex((_, j) => j > hi && sameSide(aside, chapter, hi, j));
    if (i >= 0) return { ci, hi: i };
  }
  const nc = chapters.findIndex((c, i) => i > ci && !c.optional);
  return nc >= 0 ? { ci: nc, hi: firstHunk(chapters, nc) } : undefined;
}

// Where p goes: the previous hunk, the chapter's summary page, else the end of the previous chapter.
export function prevPos(chapters: Chapter[], ci: number, hi: number): { ci: number; hi: number } | undefined {
  const chapter = chapters[ci];
  const aside = asideHunkIds(chapter);
  const prev = hi > 0 ? chapter.hunkIds.findLastIndex((_, j) => j < hi && sameSide(aside, chapter, hi, j)) : -1;
  if (prev >= 0) return { ci, hi: prev };
  if (hi >= 0 && opensOnSummary(chapter)) return { ci, hi: -1 };
  const pci = chapters.findLastIndex((c, i) => i < ci && !c.optional);
  if (pci < 0) return undefined;
  const pc = chapters[pci];
  const pAside = asideHunkIds(pc);
  return { ci: pci, hi: pc.collapsed ? -1 : pc.hunkIds.findLastIndex((id) => !pAside.has(id)) };
}
