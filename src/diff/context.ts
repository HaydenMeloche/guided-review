import type { DiffLine, Hunk } from '../types.js';

// A file's lines as the diff numbers them (line n is lines[n - 1]), without the empty string a
// trailing newline leaves.
export function fileLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Whether `head` is the file this hunk's head side came from. A preview reads the live checkout,
// which can have changed since the diff was taken.
export function headMatches(hunk: Hunk, head: string[]): boolean {
  return hunk.lines.every((l) => l.kind === 'del' || (l.newLine !== undefined && head[l.newLine - 1] === l.text));
}

// The hunk with up to `above` and `below` more lines of the head around it, marked expanded.
// Context stops at the file's edges and at its neighbouring hunks: `prevEnd` is the last head line
// of the hunk before it in the file and `nextStart` the first of the one after. It only grows at an
// edge that is context: a change at an edge is the file's first or last line. Also returns how many
// lines each side gained.
export function withContext(hunk: Hunk, head: string[], above: number, below: number, bounds: { prevEnd?: number; nextStart?: number } = {}): { hunk: Hunk; above: number; below: number } {
  const first = hunk.lines[0];
  const last = hunk.lines[hunk.lines.length - 1];
  const ctxLine = (newLine: number, offset: number): DiffLine => ({ kind: 'ctx', text: head[newLine - 1], oldLine: newLine + offset, newLine, expanded: true });
  const before: DiffLine[] = [];
  if (above > 0 && first?.kind === 'ctx' && first.newLine !== undefined && first.oldLine !== undefined) {
    const from = Math.max(1, (bounds.prevEnd ?? 0) + 1, first.newLine - above);
    for (let n = from; n < first.newLine; n++) before.push(ctxLine(n, first.oldLine - first.newLine));
  }
  const after: DiffLine[] = [];
  if (below > 0 && last?.kind === 'ctx' && last.newLine !== undefined && last.oldLine !== undefined) {
    const to = Math.min(head.length, (bounds.nextStart ?? Infinity) - 1, last.newLine + below);
    for (let n = last.newLine + 1; n <= to; n++) after.push(ctxLine(n, last.oldLine - last.newLine));
  }
  if (!before.length && !after.length) return { hunk, above: 0, below: 0 };
  return { hunk: { ...hunk, lines: [...before, ...hunk.lines, ...after] }, above: before.length, below: after.length };
}
