import type { DiffFile, DiffLine, Hunk } from '../types.js';
import { makeContentHash, makeHunkId, parseUnifiedDiff } from './parse.js';
import { markMovedLines } from './moves.js';
import { fileLines, headFor, headMatches } from './context.js';

// GitHub's diff keeps three lines of context, so changes more than six lines apart land in
// separate hunks, and code moved a short way reads as an unrelated add and remove. Hunks of one
// file with at most this many unchanged lines between them are shown as one.
export const FUSE_GAP = 6;

const HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

const firstOf = (lines: DiffLine[], side: 'oldLine' | 'newLine') => lines.find((l) => l[side] !== undefined)?.[side];
const lastOf = (lines: DiffLine[], side: 'oldLine' | 'newLine') => lines.findLast((l) => l[side] !== undefined)?.[side];

// The unchanged lines between `a` and `b` (in that order in one file), read from the head, or
// undefined when they should stay apart: too far, overlapping, or a head that does not match the
// diff (a preview reads the live checkout, which can have moved on).
function gapLines(a: Hunk, b: Hunk, head: string[]): DiffLine[] | undefined {
  const [oldEnd, newEnd] = [lastOf(a.lines, 'oldLine'), lastOf(a.lines, 'newLine')];
  const [oldStart, newStart] = [firstOf(b.lines, 'oldLine'), firstOf(b.lines, 'newLine')];
  if (oldEnd === undefined || newEnd === undefined || oldStart === undefined || newStart === undefined) return undefined;
  const gap = newStart - newEnd - 1;
  if (gap < 0 || gap > FUSE_GAP || oldStart - oldEnd - 1 !== gap) return undefined;
  if (!headMatches(a, head) || !headMatches(b, head)) return undefined;
  return Array.from({ length: gap }, (_, k) => ({ kind: 'ctx', text: head[newEnd + k], oldLine: oldEnd + 1 + k, newLine: newEnd + 1 + k, expanded: true }));
}

function fuse(a: Hunk, gap: DiffLine[], b: Hunk): Hunk {
  const lines = [...a.lines, ...gap, ...b.lines];
  const oldLines = lines.filter((l) => l.kind !== 'add').length;
  const newLines = lines.filter((l) => l.kind !== 'del').length;
  const header = `@@ -${a.oldStart},${oldLines} +${a.newStart},${newLines} @@${a.header.replace(HEADER_RE, '')}`;
  return { ...a, id: makeHunkId(a.file, header), contentHash: makeContentHash(a.file, lines), header, oldLines, newLines, lines };
}

// Joins nearby hunks of each file (see FUSE_GAP), filling the lines between from the head.
// Updates each file's hunkIds and returns the resulting hunks. Run on freshly parsed hunks.
export function fuseNearbyHunks(files: DiffFile[], hunks: Hunk[], readHead: (path: string) => string | undefined): Hunk[] {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const fused = new Map<string, Hunk[]>();
  for (const f of files) {
    const own = f.hunkIds.map((id) => byId.get(id)!);
    const text = own.length > 1 && f.status !== 'added' && f.status !== 'deleted' && !f.binary ? readHead(f.path) : undefined;
    if (text === undefined) continue;
    // Line endings as the diff writes them, judged on the file's first hunk.
    const lines = fileLines(text);
    const head = headFor(own[0], lines) ?? lines;
    const out: Hunk[] = [own[0]];
    for (const h of own.slice(1)) {
      const prev = out[out.length - 1];
      const gap = gapLines(prev, h, head);
      if (gap) out[out.length - 1] = fuse(prev, gap, h);
      else out.push(h);
    }
    if (out.length === own.length) continue;
    fused.set(f.path, out);
    f.hunkIds = out.map((h) => h.id);
  }
  if (!fused.size) return hunks;
  // Keep diff order: each file's hunks replace its first original hunk.
  const replaced = new Set(files.filter((f) => fused.has(f.path)).map((f) => f.path));
  return hunks.flatMap((h) => {
    if (!replaced.has(h.file)) return [h];
    const out = fused.get(h.file);
    fused.delete(h.file);
    return out ?? [];
  });
}

// The PR diff as a tour shows it: parsed, nearby hunks fused, and moved blocks marked. Shared
// tours are checked against this same view of the reader's diff.
export function parseTourDiff(diff: string, readHead: (path: string) => string | undefined): { files: DiffFile[]; hunks: Hunk[] } {
  const { files, hunks } = parseUnifiedDiff(diff);
  const fused = fuseNearbyHunks(files, hunks, readHead);
  markMovedLines(fused);
  return { files, hunks: fused };
}
