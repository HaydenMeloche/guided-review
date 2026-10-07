// Shared builders for Hunk, DiffFile, Chapter and Tour test fixtures.
import type { Chapter, DiffFile, DiffLine, Hunk, Tour } from '../../src/types.js';

// A hunk from explicit lines. Start lines come from the first numbered line; counts stay 0.
export function hunk(id: string, file: string, lines: Hunk['lines'], extra: Partial<Hunk> = {}): Hunk {
  return {
    id,
    contentHash: `hash-${id}`,
    file,
    header: '@@',
    oldStart: lines.find((l) => l.oldLine)?.oldLine ?? 0,
    oldLines: 0,
    newStart: lines.find((l) => l.newLine)?.newLine ?? 0,
    newLines: 0,
    lines,
    symbols: [],
    risk: 0,
    riskReasons: [],
    tests: [],
    coverage: 'n/a',
    ...extra,
  };
}

// Diff lines from source lines prefixed '+' (add), '-' (del) or ' ' (context), numbered from `start` on each side.
export function diffLines(src: string[], start = 1): DiffLine[] {
  let o = start;
  let n = start;
  return src.map((s) => {
    const kind = s[0] === '+' ? 'add' : s[0] === '-' ? 'del' : 'ctx';
    const l: DiffLine = { kind, text: s.slice(1) };
    if (kind !== 'add') l.oldLine = o++;
    if (kind !== 'del') l.newLine = n++;
    return l;
  });
}

let seq = 0;
// A hunk parsed from prefixed source lines (see diffLines), with a sequential id (h_diff1, h_diff2, ...)
// and a header and line counts that match its lines.
export function hunkFromDiff(file: string, ...src: string[]): Hunk {
  const lines = diffLines(src);
  const oldLines = lines.filter((l) => l.kind !== 'add').length;
  const newLines = lines.filter((l) => l.kind !== 'del').length;
  return hunk(`h_diff${++seq}`, file, lines, {
    header: `@@ -1,${oldLines} +1,${newLines} @@`,
    oldStart: 1,
    oldLines,
    newStart: 1,
    newLines,
  });
}

// One DiffFile per file the hunks touch, in first-seen order, with additions and deletions counted
// from the hunks. `kinds` and `status` override per path; `extra` applies to every file.
export function filesFor(hunks: Hunk[], kinds: Record<string, DiffFile['kind']> = {}, status: Record<string, DiffFile['status']> = {}, extra: Partial<DiffFile> = {}): DiffFile[] {
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  const count = (hs: Hunk[], kind: DiffLine['kind']) => hs.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind).length, 0);
  return [...byFile].map(([path, hs]) => {
    const base = { binary: false, kind: 'logic' as DiffFile['kind'], kindReason: '', status: 'modified' as DiffFile['status'], ...extra };
    return {
      ...base,
      path,
      kind: kinds[path] ?? base.kind,
      status: status[path] ?? base.status,
      additions: count(hs, 'add'),
      deletions: count(hs, 'del'),
      hunkIds: hs.map((h) => h.id),
    };
  });
}

export function chapter(id: string, hunkIds: string[], extra: Partial<Chapter> = {}): Chapter {
  return { id, kind: 'flow', title: id, risk: 0, hunkIds, linkedHunkIds: [], orphanReasons: {}, untestedBranches: [], collapsed: false, ...extra };
}

// A tour over `hunks`. Chapters default to ids c0, c1, ... and titles "Chapter N".
// `files` defaults to [] (tests that need files pass them, e.g. `{ files: filesFor(hunks) }`).
export function tour(hunks: Hunk[], chapters: Partial<Chapter>[] = [], extra: Partial<Tour> = {}): Tour {
  return {
    version: 1,
    repo: 'o/r',
    pr: 1,
    title: 't',
    url: 'u',
    author: 'a',
    baseSha: 'base',
    headSha: 'head',
    createdAt: '2026-01-01T00:00:00Z',
    mode: 'plain',
    intent: '',
    flags: [],
    notes: [],
    chapters: chapters.map((c, i) => chapter(`c${i}`, [], { title: `Chapter ${i}`, ...c })),
    files: [],
    hunks: Object.fromEntries(hunks.map((h) => [h.id, h])),
    blastRadius: [],
    existingThreads: [],
    ...extra,
  };
}
