import type { DiffLine, Hunk, MovedTo } from '../types.js';
import { looksGenerated } from '../analysis/kinds.js';
import { fileLines, headFor, headMatches } from './context.js';

// A moved block is at least this many lines with this much non-whitespace text, so a lone `}`
// or a repeated blank line never reads as a move.
const MIN_MOVED_LINES = 3;
const MIN_MOVED_CHARS = 20;
// A diff this large is mostly generated code; lockfiles and generated files, never moved code,
// do not count.
const MAX_CHANGED_LINES = 20_000;
// A move starts on a line with this much text, matched in at most this many places. Without
// both, lines like `}` repeated through a PR make matching quadratic: an author could stall it.
const MIN_START_CHARS = 4;
const MAX_START_MATCHES = 50;

interface Ref {
  hunk: Hunk;
  line: DiffLine;
  block: number; // the run of changed lines it belongs to
  pos: number; // its index among that run's lines of the same kind
}

interface Block {
  from: Ref[];
  to: Ref[];
  indent: number;
  seq: string[];
}

const key = (l: DiffLine) => l.text.trim();
const chars = (k: string) => k.replace(/\s+/g, '').length;

// Columns of leading whitespace, a tab counting as four.
function indentOf(text: string): number {
  let w = 0;
  for (const c of text) {
    if (c === ' ') w++;
    else if (c === '\t') w += 4;
    else break;
  }
  return w;
}

// How many of `xs` (sorted) are below `x`.
function below(xs: number[], x: number): number {
  let [lo, hi] = [0, xs.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// One file's view of the diff: its head and base text (the base rebuilt from the head and the
// hunks, so it needs no base checkout) and where its unchanged lines sit.
class FileView {
  private ups: number[] = []; // an add after old line t moves every later old line down one
  private downs: number[] = []; // a del of old line t moves every later old line up one
  private added: number[] = []; // new line numbers of added lines
  private texts = new Map<'head' | 'base', { lines: string[]; at: Map<string, number[]> } | undefined>();

  constructor(
    private hunks: Hunk[],
    private readHead: () => string | undefined,
  ) {
    for (const h of hunks) {
      let lastOld = h.oldStart - 1;
      for (const l of h.lines) {
        if (l.kind === 'add') {
          this.ups.push(lastOld);
          this.added.push(l.newLine!);
        } else {
          lastOld = l.oldLine!;
          if (l.kind === 'del') this.downs.push(l.oldLine!);
        }
      }
    }
    for (const xs of [this.ups, this.downs, this.added]) xs.sort((a, b) => a - b);
  }

  // Where an old line would be in the head if only the edits above it moved it.
  newLineOf(oldLine: number): number {
    return oldLine + below(this.ups, oldLine) - below(this.downs, oldLine);
  }

  // Unchanged head lines from `a` up to `b`.
  unchangedBetween(a: number, b: number): number {
    return Math.max(0, b - a - (below(this.added, b) - below(this.added, a)));
  }

  // How many times the trimmed lines `seq` (at least MIN_MOVED_LINES of them) appear in a row in
  // the file's head or base.
  occurrences(side: 'head' | 'base', seq: string[]): number {
    if (!this.texts.has(side)) this.texts.set(side, this.index(side));
    const text = this.texts.get(side);
    if (!text) return 0;
    return (text.at.get(seq.slice(0, MIN_MOVED_LINES).join('\n')) ?? []).filter((s) => seq.every((k, j) => text.lines[s + j] === k)).length;
  }

  private lines(side: 'head' | 'base'): string[] | undefined {
    const text = this.readHead();
    const head = text === undefined ? undefined : headFor(this.hunks[0], fileLines(text));
    if (!head || !this.hunks.every((h) => headMatches(h, head))) return undefined;
    if (side === 'head') return head;
    // Every hunk's new-side lines swapped for its old-side lines.
    const base: string[] = [];
    let at = 1;
    for (const h of [...this.hunks].sort((x, y) => x.newStart - y.newStart)) {
      const start = h.lines.find((l) => l.newLine !== undefined)?.newLine ?? h.newStart + 1;
      while (at < start) base.push(head[at++ - 1]);
      for (const l of h.lines) {
        if (l.kind !== 'add') base.push(l.text);
        if (l.kind !== 'del') at++;
      }
    }
    while (at <= head.length) base.push(head[at++ - 1]);
    return base;
  }

  // Where each run of MIN_MOVED_LINES trimmed lines starts, so a block is looked up by its first
  // lines and confirmed line by line.
  private index(side: 'head' | 'base'): { lines: string[]; at: Map<string, number[]> } | undefined {
    const lines = this.lines(side)?.map((l) => l.trim());
    if (!lines) return undefined;
    const at = new Map<string, number[]>();
    for (let s = 0; s + MIN_MOVED_LINES <= lines.length; s++) {
      const k = lines.slice(s, s + MIN_MOVED_LINES).join('\n');
      const list = at.get(k);
      if (list) list.push(s);
      else at.set(k, [s]);
    }
    return { lines, at };
  }
}

// Marks lines removed in one place and added in another (anywhere in the PR) with where the
// other side is, comparing lines with their indentation stripped but requiring the whole block
// to shift by one amount. A line removed and added again in the same run of changes is a
// rewrite or a reindent, not a move. Text still in the file it was removed from, or already in
// the file it was added to, is matching boilerplate, not a move. Generated files are left out.
export function markMovedLines(hunks: Hunk[], readHead: (path: string) => string | undefined): void {
  const byFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) byFile.set(hunk.file, [...(byFile.get(hunk.file) ?? []), hunk]);
  const heads = new Map<string, string | undefined>();
  const headOf = (p: string) => {
    if (!heads.has(p)) heads.set(p, readHead(p));
    return heads.get(p);
  };
  const views = new Map<string, FileView>();
  const view = (p: string) => {
    if (!views.has(p)) views.set(p, new FileView(byFile.get(p)!, () => headOf(p)));
    return views.get(p)!;
  };
  const generated = new Set([...byFile].filter(([p, hs]) => looksGenerated(p, firstLines(headOf(p), hs))).map(([p]) => p));

  const dels: Ref[][] = [];
  const adds: Ref[][] = [];
  let changed = 0;
  for (const hunk of hunks) {
    if (generated.has(hunk.file)) continue;
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

  const startsOf = (runs: Ref[][]) => {
    const starts = new Map<string, Ref[]>();
    for (const run of runs) {
      for (const r of run) {
        const k = key(r.line);
        if (chars(k) < MIN_START_CHARS) continue;
        const at = starts.get(k);
        if (at) at.push(r);
        else starts.set(k, [r]);
      }
    }
    for (const [k, at] of starts) if (at.length > MAX_START_MATCHES) starts.delete(k);
    return starts;
  };
  const addStarts = startsOf(adds);
  const delStarts = startsOf(dels);
  const paired = new Set<DiffLine>();

  // How many lines from run[i] match the added lines from `at` on, each shifted by one indent.
  const extend = (run: Ref[], i: number, at: Ref) => {
    const target = adds[at.block];
    let indent: number | undefined;
    let n = 0;
    for (; i + n < run.length && at.pos + n < target.length; n++) {
      const [d, a] = [run[i + n].line, target[at.pos + n].line];
      if (paired.has(d) || paired.has(a) || key(d) !== key(a)) break;
      if (!key(d)) continue; // a blank line fits any indent
      const shift = indentOf(a.text) - indentOf(d.text);
      if (indent === undefined) indent = shift;
      else if (shift !== indent) break;
    }
    return { n, indent: indent ?? 0 };
  };

  // Same-file pairs first, so text edited alike in two files pairs within each file.
  const blocks: Block[] = [];
  for (const sameFileOnly of [true, false]) {
    for (const run of dels) {
      for (let i = 0; i < run.length;) {
        const from = run[i];
        let best: { at: Ref; n: number; indent: number; distance: number } | undefined;
        if (!paired.has(from.line)) {
          const near = from.line.oldLine === undefined ? 0 : view(from.hunk.file).newLineOf(from.line.oldLine);
          for (const at of addStarts.get(key(from.line)) ?? []) {
            if (at.block === from.block || paired.has(at.line)) continue;
            const sameFile = at.hunk.file === from.hunk.file;
            if (sameFileOnly && !sameFile) continue;
            const { n, indent } = extend(run, i, at);
            // Of the longest matches, the nearest one.
            const distance = sameFile ? Math.abs(at.line.newLine! - near) : Infinity;
            if (!best || n > best.n || (n === best.n && distance < best.distance)) best = { at, n, indent, distance };
          }
        }
        const moved = best ? run.slice(i, i + best.n) : [];
        const seq = moved.map((r) => key(r.line));
        if (!best || moved.length < MIN_MOVED_LINES || seq.reduce((n, k) => n + chars(k), 0) < MIN_MOVED_CHARS) {
          i++;
          continue;
        }
        const to = adds[best.at.block].slice(best.at.pos, best.at.pos + best.n);
        const [src, dst] = [from.hunk.file, best.at.hunk.file];
        const own = src === dst ? 1 : 0; // a move within a file leaves the block in its head and base once
        if (view(src).occurrences('head', seq) > own || view(dst).occurrences('base', seq) > own) {
          i++;
          continue;
        }
        for (const r of [...moved, ...to]) paired.add(r.line);
        blocks.push({ from: moved, to, indent: best.indent, seq });
        i += moved.length;
      }
    }
  }

  // The first unpaired place each run holds `seq`.
  const unpaired = (starts: Map<string, Ref[]>, runs: Ref[][], seq: string[]) => {
    const found = new Map<number, Ref>();
    for (const s of starts.get(seq[0]) ?? []) {
      const run = runs[s.block];
      if (found.has(s.block) || s.pos + seq.length > run.length) continue;
      if (seq.every((k, j) => !paired.has(run[s.pos + j].line) && key(run[s.pos + j].line) === k)) found.set(s.block, s);
    }
    return [...found.values()];
  };
  for (const b of blocks) {
    // The same lines added or removed somewhere else too: copied, or copies merged.
    const also = [
      ...unpaired(addStarts, adds, b.seq).map((r) => ({ file: r.hunk.file, line: r.line.newLine!, side: 'add' as const })),
      ...unpaired(delStarts, dels, b.seq).map((r) => ({ file: r.hunk.oldFile ?? r.hunk.file, line: r.line.oldLine!, side: 'del' as const })),
    ];
    // A block that skipped at most one unchanged line stayed put and was re-indented around.
    const [first, dest] = [b.from[0], b.to[0]];
    let reindented = false;
    if (first.hunk.file === dest.hunk.file) {
      const v = view(first.hunk.file);
      const was = v.newLineOf(first.line.oldLine!);
      const now = dest.line.newLine!;
      reindented = (was <= now ? v.unchangedBetween(was, now) : v.unchangedBetween(now + b.to.length, was)) <= 1;
    }
    const extra: Omit<MovedTo, 'file' | 'line'> = { kind: also.length ? 'copied' : reindented ? 'reindented' : 'moved', indent: b.indent, also };
    b.from.forEach((f, k) => {
      const t = b.to[k];
      f.line.moved = { file: t.hunk.file, line: t.line.newLine!, ...extra };
      // An old line number goes with the old path, for a block moved out of a renamed file.
      t.line.moved = { file: f.hunk.oldFile ?? f.hunk.file, line: f.line.oldLine!, ...extra };
    });
  }
}

// The first lines of a file, from the head or, for a deleted file, the diff, to look for a
// generated-code header.
function firstLines(head: string | undefined, hunks: Hunk[]): string {
  if (head !== undefined) return head.split('\n', 5).join('\n');
  const first = hunks.find((h) => h.oldStart <= 1 || h.newStart <= 1);
  return (first?.lines ?? [])
    .slice(0, 5)
    .map((l) => l.text)
    .join('\n');
}
