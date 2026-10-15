import type { DiffLine, Hunk } from '../types.js';

// A moved block is at least this many lines with this much non-whitespace text, so a lone `}`
// or a repeated blank line never reads as a move.
const MIN_MOVED_LINES = 3;
const MIN_MOVED_CHARS = 20;
// Matching is quadratic in the worst case; a diff this large is mostly generated code.
const MAX_CHANGED_LINES = 20_000;

interface Ref {
  hunk: Hunk;
  line: DiffLine;
  block: number; // the run of changed lines it belongs to
  pos: number; // its index among that run's lines of the same kind
}

const key = (l: DiffLine) => l.text.trim();

// Marks lines removed in one place and added in another (anywhere in the PR) with where the
// other side is, comparing lines with their indentation stripped. A line removed and added again
// in the same run of changes is a rewrite or a reindent, not a move.
export function markMovedLines(hunks: Hunk[]): void {
  const dels: Ref[][] = [];
  const adds: Ref[][] = [];
  let changed = 0;
  for (const hunk of hunks) {
    for (let i = 0; i < hunk.lines.length;) {
      if (hunk.lines[i].kind === 'ctx') {
        i++;
        continue;
      }
      const block = dels.length;
      const d: Ref[] = [];
      const a: Ref[] = [];
      for (; i < hunk.lines.length && hunk.lines[i].kind !== 'ctx'; i++) {
        const line = hunk.lines[i];
        const run = line.kind === 'del' ? d : a;
        run.push({ hunk, line, block, pos: run.length });
      }
      dels.push(d);
      adds.push(a);
      changed += d.length + a.length;
    }
  }
  if (changed > MAX_CHANGED_LINES) return;

  const starts = new Map<string, Ref[]>();
  for (const run of adds) for (const r of run) if (key(r.line)) starts.set(key(r.line), [...(starts.get(key(r.line)) ?? []), r]);

  for (const run of dels) {
    for (let i = 0; i < run.length;) {
      let best: { at: Ref; length: number } | undefined;
      for (const at of key(run[i].line) ? (starts.get(key(run[i].line)) ?? []) : []) {
        if (at.block === run[i].block || at.line.moved) continue;
        const target = adds[at.block];
        let n = 0;
        while (i + n < run.length && at.pos + n < target.length && !target[at.pos + n].line.moved && key(run[i + n].line) === key(target[at.pos + n].line)) n++;
        if (!best || n > best.length) best = { at, length: n };
      }
      const moved = best ? run.slice(i, i + best.length) : [];
      if (!best || moved.length < MIN_MOVED_LINES || moved.reduce((n, r) => n + key(r.line).replace(/\s+/g, '').length, 0) < MIN_MOVED_CHARS) {
        i++;
        continue;
      }
      const { at } = best;
      moved.forEach((from, k) => {
        const to = adds[at.block][at.pos + k];
        from.line.moved = { file: to.hunk.file, line: to.line.newLine! };
        to.line.moved = { file: from.hunk.file, line: from.line.oldLine! };
      });
      i += moved.length;
    }
  }
}
