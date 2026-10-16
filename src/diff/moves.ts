import type { DiffFile, DiffLine, Hunk, MovedTo } from '../types.js';
import { fileLines, headFor, headMatches } from './context.js';

// Files whose changes are never moved code: generated and vendored ones (lockfiles included), as
// classified with the repo's rules and .gitattributes.
export function unmovedFiles(files: DiffFile[]): Set<string> {
  return new Set(files.filter((f) => f.kind === 'generated' || f.kind === 'vendored').map((f) => f.path));
}

// A moved block is at least this many lines with this much non-whitespace text, so a lone `}`
// or a repeated blank line never reads as a move. It gets a note of its own only with this many
// lines with a word in them: one statement and the brackets closing it say nothing, though they
// still count toward the move they belong to.
const MIN_MOVED_LINES = 3;
const MIN_MOVED_CHARS = 20;
const MIN_WORD_LINES = 2;
// A move is better missed than made up. Each block holds an anchor: a line with this much text
// removed, or added, just once (in its file, for a move within one), so common lines alone never
// pair.
const MIN_ANCHOR_CHARS = 15;
// Between files a few lines in common happen by chance, so a move there needs to be whole
// declarations of at least MIN_DECLARATION_LINES non-blank lines, or at least
// MIN_CROSS_FILE_LINES non-blank lines with MIN_CROSS_FILE_CHARS of text, counting blocks moved
// alongside it: ones between the same two files at most CROSS_FILE_GAP lines apart on both
// sides, split by a small edit. Once one move between two files clears that bar, smaller ones
// between them are more of the same move and pass, as does a piece with no anchor of its own
// right beside one.
const MIN_DECLARATION_LINES = 4;
const MIN_CROSS_FILE_LINES = 6;
const MIN_CROSS_FILE_CHARS = 100;
const CROSS_FILE_GAP = 5;
// How far up to look for the `/*` of a comment a block may sit in, in languages with such comments.
const COMMENT_REACH = 500;
const BLOCK_COMMENTS = /\.(?:c|h|cc|cpp|cxx|hpp|cs|java|kt|kts|scala|groovy|go|rs|swift|dart|php|js|jsx|mjs|cjs|ts|tsx|mts|cts|css|scss|less|m|mm)$/i;
// A block shifted exactly as one at most this many lines away that stayed in place stayed too.
const NEAR_IN_PLACE = 50;
// A diff this large is mostly generated code; skipped files do not count.
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

// A line that starts a declaration: a keyword that declares, or a method's signature opening its
// body. Control flow (`if (x) {`) is neither.
const DECLARES =
  /^(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|pub(?:\([^)]*\))?|unsafe|virtual|sealed|data|open|suspend|inline)\s+)*(?:function\*?|func|def|fn|fun|class|struct|interface|type|enum|trait|impl|module|object|record|const|let|var|val)\b/;
const SIGNATURE = /^[\w$<>[\],.?\s]*?\b([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{=;]+)?\{\s*$/;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'foreach', 'elseif', 'until', 'unless']);
const CLOSER = /^(?:[)\]}]+[;,)]*|end)$/;

// A file's preamble: its license header and other comments, the package line, and imports. Only
// imports, or comments at the top of both files, that turn up elsewhere followed a file being
// replaced or split, and say nothing about the code; a comment moved with code in the middle of a
// file belongs to it. Prose files are left out, where `#` starts a heading.
const IMPORT = /^(?:package\b|import\b|from\s+\S+\s+import\b|use\s|require\b|#include\b|using\s|(?:[\w.]+\s+)?"[^"]*"$)/;
const PREAMBLE = /^(?:\/\/|\/\*|\*|#(?:\s|!|$)|--|\)$)/;
const PROSE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
const TOP_LINES = 5;
function preambleOnly(file: string, seq: string[], oldLine: number, newLine: number): boolean {
  if (PROSE.test(file) || !seq.every((k) => !k || IMPORT.test(k) || PREAMBLE.test(k))) return false;
  return seq.some((k) => IMPORT.test(k)) || (oldLine <= TOP_LINES && newLine <= TOP_LINES);
}

// Whether `lines` are whole declarations, each from its signature to its closing line: every
// line past a start is deeper than it, or closes it at its indent, and brackets balance.
function wholeDeclarations(lines: DiffLine[]): boolean {
  const body = lines.filter((l) => key(l));
  let open: number | undefined; // indent of the declaration being read
  let depth = 0;
  for (const l of body) {
    const [k, indent] = [key(l), indentOf(l.text)];
    if (open === undefined || indent <= open) {
      if (open !== undefined && indent === open && CLOSER.test(k)) {
        open = undefined;
      } else {
        if (depth !== 0 || (open !== undefined && indent < open)) return false;
        const sig = SIGNATURE.exec(k);
        if (!DECLARES.test(k) && !(sig && !CONTROL.has(sig[1]))) return false;
        open = indent;
      }
    }
    for (const c of k) depth += '([{'.includes(c) ? 1 : ')]}'.includes(c) ? -1 : 0;
  }
  return body.length > 0 && depth === 0;
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
  private kept: string[] | undefined; // the head's kept lines, trimmed
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

  // How many lines the PR kept come before old line `oldLine`, or before new line `newLine`. Kept
  // lines keep their order, so a block with as many before it on both sides did not move past any.
  keptBeforeOld(oldLine: number): number {
    return oldLine - 1 - below(this.downs, oldLine);
  }
  keptBeforeNew(newLine: number): number {
    return newLine - 1 - below(this.added, newLine);
  }

  // Whether line `line` of the file's head or base is inside a `/* */` comment opened above it,
  // looking at most COMMENT_REACH lines up. False without the text.
  inComment(side: 'head' | 'base', line: number): boolean {
    if (!this.texts.has(side)) this.texts.set(side, this.index(side));
    const text = this.texts.get(side);
    for (let k = line - 2; text && k >= 0 && k >= line - 1 - COMMENT_REACH; k--) {
      // A `/*` right after a `*` is a glob such as `src/**/*.ts`, not a comment.
      const line = text.lines[k].replaceAll('**/*', '');
      const [open, close] = [line.lastIndexOf('/*'), line.lastIndexOf('*/')];
      if (open >= 0 || close >= 0) return open > close;
    }
    return false;
  }

  // How many of the kept lines from index `a` up to `b` hold a word: blank lines and lone brackets
  // are layout a diff aligns as it likes. Undefined without the head.
  keptWithWords(a: number, b: number): number | undefined {
    if (!this.texts.has('head')) this.texts.set('head', this.index('head'));
    const text = this.texts.get('head');
    if (!text) return undefined;
    if (!this.kept) {
      const added = new Set(this.added);
      this.kept = text.lines.filter((_, i) => !added.has(i + 1));
    }
    return this.kept.slice(a, b).filter((k) => /\w/.test(k)).length;
  }

  // Whether the trimmed lines `seq` (at least MIN_MOVED_LINES of them) appear in a row in the
  // file's head or base somewhere other than lines the PR added (head) or removed (base).
  holdsUnchanged(side: 'head' | 'base', seq: string[]): boolean {
    if (!this.texts.has(side)) this.texts.set(side, this.index(side));
    const text = this.texts.get(side);
    if (!text) return false;
    const changed = side === 'head' ? this.added : this.downs;
    return (text.at.get(seq.slice(0, MIN_MOVED_LINES).join('\n')) ?? []).some(
      (s) => seq.every((k, j) => text.lines[s + j] === k) && below(changed, s + seq.length + 1) - below(changed, s + 1) < seq.length,
    );
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
      if (start - 1 > head.length) return undefined; // a hunk past the head's end: not this file
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
// rewrite or a reindent, not a move. Text a changed file holds outside the PR's changes is
// matching boilerplate, not a move. Files in `skip` are left out.
export function markMovedLines(hunks: Hunk[], readHead: (path: string) => string | undefined, skip: ReadonlySet<string>): void {
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

  const dels: Ref[][] = [];
  const adds: Ref[][] = [];
  let changed = 0;
  for (const hunk of hunks) {
    if (skip.has(hunk.file)) continue;
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
  // How many times each line is removed, and added, in the PR and in each file.
  const counts = (runs: Ref[][]) => {
    const all = new Map<string, number>();
    for (const run of runs) for (const r of run) for (const k of [key(r.line), `${r.hunk.file}\0${key(r.line)}`]) all.set(k, (all.get(k) ?? 0) + 1);
    return all;
  };
  const [delCount, addCount] = [counts(dels), counts(adds)];
  const anchored = (moved: Ref[], file: string | undefined) =>
    moved.some((r) => {
      const k = key(r.line);
      const scoped = file === undefined ? k : `${file}\0${k}`;
      return chars(k) >= MIN_ANCHOR_CHARS && (delCount.get(scoped) === 1 || addCount.get(scoped) === 1);
    });
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

  // Text some changed file holds outside the PR's changes, before or after it, is boilerplate.
  // Checking every changed file, not just the two ends of the move, catches it when one end is a
  // new or deleted file.
  const unskipped = [...byFile.keys()].filter((p) => !skip.has(p));
  const boilerplate = (seq: string[]) => unskipped.some((p) => view(p).holdsUnchanged('head', seq) || view(p).holdsUnchanged('base', seq));

  // Same-file pairs first, so text edited alike in two files pairs within each file.
  const blocks: Block[] = [];
  const loose: Block[] = []; // cross-file matches with no anchor, kept in case they sit by a move
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
        if (preambleOnly(from.hunk.file, seq, from.line.oldLine!, to[0].line.newLine!)) {
          i += moved.length; // its tail is preamble too
          continue;
        }
        const between = to[0].hunk.file !== from.hunk.file;
        const isAnchored = anchored(moved, between ? undefined : from.hunk.file);
        if (!isAnchored || boilerplate(seq)) {
          if (!isAnchored && between && !boilerplate(seq)) loose.push({ from: moved, to, indent: best.indent, seq });
          i++;
          continue;
        }
        for (const r of [...moved, ...to]) paired.add(r.line);
        blocks.push({ from: moved, to, indent: best.indent, seq });
        i += moved.length;
      }
    }
  }

  // Cross-file blocks too small, with their neighbours, to tell from chance are let go.
  const crossFile = new Map<string, Block[]>();
  for (const b of blocks) {
    const [src, dst] = [b.from[0].hunk.file, b.to[0].hunk.file];
    if (src === dst) continue;
    const k = `${src}\0${dst}`;
    crossFile.set(k, [...(crossFile.get(k) ?? []), b]);
  }
  // Whether blocks moved together are enough to tell from chance between files.
  const lines = (seq: string[]) => seq.filter((k) => k).length;
  const clears = (g: Block[]) => {
    const seq = g.flatMap((b) => b.seq);
    const declares = g.some((b) => lines(b.seq) >= MIN_DECLARATION_LINES && wholeDeclarations(b.from.map((r) => r.line)));
    return declares || (lines(seq) >= MIN_CROSS_FILE_LINES && seq.reduce((n, k) => n + chars(k), 0) >= MIN_CROSS_FILE_CHARS);
  };
  const small = new Set<Block>();
  const cleared = new Set<Block>(); // in a group that clears the bar itself
  const passed = new Set<Block>(); // let through between its two files, cleared or not
  for (const list of crossFile.values()) {
    list.sort((x, y) => x.from[0].line.oldLine! - y.from[0].line.oldLine!);
    const groups: Block[][] = [];
    for (const b of list) {
      const prev = groups.at(-1)?.at(-1);
      const gap = (a: number, z: number) => z - a - 1 >= 0 && z - a - 1 <= CROSS_FILE_GAP;
      const near = prev && gap(prev.from.at(-1)!.line.oldLine!, b.from[0].line.oldLine!) && gap(prev.to.at(-1)!.line.newLine!, b.to[0].line.newLine!);
      if (near) groups.at(-1)!.push(b);
      else groups.push([b]);
    }
    // A small group is let through when a group between the same two files clears the bar: the
    // PR is moving code from one to the other, and this is more of it.
    const corroborated = groups.some(clears);
    for (const g of groups) for (const b of g) (corroborated ? passed : small).add(b);
    for (const g of groups.filter(clears)) for (const b of g) cleared.add(b);
  }
  for (const b of small) for (const r of [...b.from, ...b.to]) paired.delete(r.line);
  blocks.splice(0, blocks.length, ...blocks.filter((b) => !small.has(b)));

  // A match with no anchor of its own is let through beside an accepted move between the same two
  // files, at most CROSS_FILE_GAP lines from it on both sides: a piece of that move split off by
  // an edit, like a method's tail past a changed line. Each piece let in can bring in the next.
  const near = (a: Ref[], b: Ref[], at: (r: Ref) => number) => {
    const [a0, a1, b0, b1] = [at(a[0]), at(a.at(-1)!), at(b[0]), at(b.at(-1)!)];
    return Math.max(a0, b0) - Math.min(a1, b1) - 1 <= CROSS_FILE_GAP;
  };
  const [oldAt, newAt] = [(r: Ref) => r.line.oldLine!, (r: Ref) => r.line.newLine!];
  // From each accepted move, its pair's candidates beside it, longest first; each one let in is
  // checked in turn, so a chain of pieces costs one pass per piece.
  const pairOf = (b: Block) => `${b.from[0].hunk.file}\0${b.to[0].hunk.file}`;
  const candidates = new Map<string, Block[]>();
  for (const c of [...loose].sort((x, y) => y.from.length - x.from.length)) candidates.set(pairOf(c), [...(candidates.get(pairOf(c)) ?? []), c]);
  const todo = blocks.filter((b) => passed.has(b));
  for (let b = todo.pop(); b; b = todo.pop()) {
    for (const c of candidates.get(pairOf(b)) ?? []) {
      if (!near(b.from, c.from, oldAt) || !near(b.to, c.to, newAt) || [...c.from, ...c.to].some((r) => paired.has(r.line))) continue;
      for (const r of [...c.from, ...c.to]) paired.add(r.line);
      blocks.push(c);
      passed.add(c);
      todo.push(c);
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
  // Where a run of lines is, as `also` names it: an old line number goes with the old path, for a
  // block moved out of a renamed file.
  const placeOf = (side: 'add' | 'del', lines: Ref[]) => {
    const r = lines[0];
    return side === 'add' ? { file: r.hunk.file, line: r.line.newLine!, side } : { file: r.hunk.oldFile ?? r.hunk.file, line: r.line.oldLine!, side };
  };
  // Columns `added` sits right of `removed`, from their first non-blank line.
  const shiftOf = (removed: Ref[], added: Ref[]) => {
    const k = removed.findIndex((r) => key(r.line));
    return k < 0 ? 0 : indentOf(added[k].line.text) - indentOf(removed[k].line.text);
  };
  // Marks `lines` as the `side` of a block whose other side is `other`.
  const mark = (side: 'add' | 'del', lines: Ref[], other: Ref[], extra: Omit<MovedTo, 'file' | 'line' | 'indent'>) => {
    const indent = side === 'del' ? shiftOf(lines, other) : shiftOf(other, lines);
    lines.forEach((r, k) => {
      const { file, line } = placeOf(side === 'del' ? 'add' : 'del', [other[k]]);
      r.line.moved = { file, line, indent, ...extra };
    });
  };
  // A block that passed no kept line with a word, only blank lines and brackets, is where it was:
  // re-indented if code around it changed its indent, and otherwise not moved at all, just diffed
  // that way. So is one shifted exactly as a block near it that stayed: it kept its place beside
  // that block, though a line the diff kept between them says otherwise.
  const lineShift = (b: Block) => b.to[0].line.newLine! - b.from[0].line.oldLine!;
  const stayed = blocks.filter((b) => {
    if (b.from[0].hunk.file !== b.to[0].hunk.file) return false;
    const v = view(b.from[0].hunk.file);
    const [was, now] = [v.keptBeforeOld(b.from[0].line.oldLine!), v.keptBeforeNew(b.to[0].line.newLine!)];
    return (v.keptWithWords(Math.min(was, now), Math.max(was, now)) ?? Math.abs(was - now)) === 0;
  });
  const inPlaceOf = (b: Block) =>
    stayed.includes(b) ||
    stayed.some(
      (s) =>
        s.from[0].hunk.file === b.from[0].hunk.file &&
        b.to[0].hunk.file === b.from[0].hunk.file &&
        lineShift(s) === lineShift(b) &&
        s.indent === b.indent &&
        Math.abs(s.from[0].line.oldLine! - b.from[0].line.oldLine!) <= NEAR_IN_PLACE,
    );
  for (const b of blocks) {
    const inPlace = inPlaceOf(b);
    if ((inPlace && !b.indent) || b.seq.filter((k) => /\w/.test(k)).length < MIN_WORD_LINES) continue;
    // Code put in a `/* */` comment, or taken out of one, was disabled or enabled, not moved.
    const [src, dst] = [b.from[0], b.to[0]];
    if (
      BLOCK_COMMENTS.test(src.hunk.file) &&
      BLOCK_COMMENTS.test(dst.hunk.file) &&
      view(src.hunk.file).inComment('base', src.line.oldLine!) !== view(dst.hunk.file).inComment('head', dst.line.newLine!)
    )
      continue;
    // The same lines added or removed somewhere else too: copied, or copies merged. Each such
    // place is marked as part of the block, so a reader of any of its files sees where it went.
    const sites = [
      ...unpaired(addStarts, adds, b.seq).map((r) => ({ side: 'add' as const, lines: adds[r.block].slice(r.pos, r.pos + b.seq.length) })),
      ...unpaired(delStarts, dels, b.seq).map((r) => ({ side: 'del' as const, lines: dels[r.block].slice(r.pos, r.pos + b.seq.length) })),
    ];
    // A place in a third file is held to the bar between files, which a block let through only by
    // the moves beside it has not met.
    const ends = new Set([b.from[0].hunk.file, b.to[0].hunk.file]);
    const strong = cleared.has(b) || clears([b]);
    sites.splice(0, sites.length, ...sites.filter((s) => strong || ends.has(s.lines[0].hunk.file)));
    for (const s of sites) for (const r of s.lines) paired.add(r.line);
    const kind = sites.some((s) => s.side === 'add') ? 'copied' : sites.length ? 'merged' : inPlace ? 'reindented' : 'moved';
    // Every place holding the block, each naming the one it pairs with and the rest as `also`.
    const places = [{ side: 'del' as const, lines: b.from }, { side: 'add' as const, lines: b.to }, ...sites];
    for (const p of places) {
      const other = p.side === 'del' ? b.to : b.from;
      const also = places.filter((q) => q !== p && q.lines !== other).map((q) => placeOf(q.side, q.lines));
      mark(p.side, p.lines, other, { kind, also });
    }
  }
}
