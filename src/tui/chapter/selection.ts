import type { Chapter, DiffLine, Draft, DraftAnchor, Hunk, Tour } from '../../types.js';

// Line indexes into a hunk, first to last: the cursor alone, or the cursor and the range anchor.
export type Selection = [number, number];

export const selRange = (cursor: number, anchor: number | null): Selection => (anchor === null ? [cursor, cursor] : [Math.min(anchor, cursor), Math.max(anchor, cursor)]);

// The selected lines a comment can attach to: expanded context at the ends is left out.
export const anchorLines = (h: Hunk, [a, b]: Selection): DiffLine[] => h.lines.slice(a, b + 1).filter((l) => !l.expanded);

// A selection with expanded context between commentable lines spans two of GitHub's hunks,
// which GitHub will not take one comment across.
export function crossesContext(h: Hunk, [a, b]: Selection): boolean {
  const sel = h.lines.slice(a, b + 1);
  const first = sel.findIndex((l) => !l.expanded);
  const last = sel.findLastIndex((l) => !l.expanded);
  return first >= 0 && sel.slice(first, last + 1).some((l) => l.expanded);
}

// The code under the selection, prefilled as a suggestion: exactly the lines it replaces.
export const selectedCode = (h: Hunk, sel: Selection): string =>
  anchorLines(h, sel)
    .filter((l) => l.kind !== 'del')
    .map((l) => l.text)
    .join('\n');

// New code when the selection has any, else the removed lines it covers.
export function lineAnchor(h: Hunk, sel: Selection): DraftAnchor | undefined {
  const lines = anchorLines(h, sel);
  const right = lines.filter((l) => l.newLine !== undefined && l.kind !== 'del');
  const side: 'LEFT' | 'RIGHT' = right.length ? 'RIGHT' : 'LEFT';
  const nums = side === 'RIGHT' ? right.map((l) => l.newLine!) : lines.map((l) => l.oldLine!).filter((n) => n !== undefined);
  if (!nums.length) return undefined;
  const start = Math.min(...nums);
  const end = Math.max(...nums);
  return start === end ? { type: 'line', hunkId: h.id, file: h.file, line: end, side } : { type: 'range', hunkId: h.id, file: h.file, startLine: start, line: end, side };
}

// A line of a linked test can take a comment only where some tour hunk of the test's file shows
// it as part of the diff.
export function testLineAnchor(hunks: Tour['hunks'], file: string | undefined, line: DiffLine | undefined): DraftAnchor | undefined {
  const side = line?.kind === 'del' ? 'LEFT' : 'RIGHT';
  const lineNo = side === 'LEFT' ? line?.oldLine : line?.newLine;
  const target = Object.values(hunks).find(
    (candidate) => candidate.file === file && candidate.lines.some((l) => !l.expanded && (side === 'LEFT' ? l.kind !== 'add' && l.oldLine === lineNo : l.kind !== 'del' && l.newLine === lineNo)),
  );
  if (!target || lineNo === undefined || !file) return undefined;
  return { type: 'line', hunkId: target.id, file, line: lineNo, side };
}

export const newDraft = (tour: Pick<Tour, 'repo' | 'pr' | 'headSha'>, a: DraftAnchor): Draft => ({
  id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  repo: tour.repo,
  pr: tour.pr,
  headSha: tour.headSha,
  anchor: a,
  label: 'question',
  body: '',
  posted: false,
  createdAt: new Date().toISOString(),
});

// A diagram node is looked up in `chapter`'s diagram, the one a node comment is made from.
export function describeAnchor(a: DraftAnchor, chapters: Chapter[], chapter?: Chapter): string {
  if (a.type === 'line') return `${a.file}:${a.line}`;
  if (a.type === 'range') return `${a.file}:${a.startLine}-${a.line}`;
  if (a.type === 'chapter') return `flow "${chapters.find((c) => c.id === a.chapterId)?.title ?? a.chapterId}"`;
  return `diagram node "${chapter?.diagram?.nodes.find((n) => n.id === a.nodeId)?.label ?? a.nodeId}"`;
}
