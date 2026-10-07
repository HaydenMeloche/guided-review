import type { DiffLine, Hunk, Risk } from '../types.js';

// Added plus removed lines; context lines are not changes.
export function changedCount(h: Hunk): number {
  let n = 0;
  for (const l of h.lines) if (l.kind !== 'ctx') n++;
  return n;
}

export const addedText = (h: Hunk): string[] => h.lines.filter((l) => l.kind === 'add').map((l) => l.text);
export const removedText = (h: Hunk): string[] => h.lines.filter((l) => l.kind === 'del').map((l) => l.text);
export const changedText = (h: Hunk): string[] => h.lines.filter((l) => l.kind !== 'ctx').map((l) => l.text);

// Ids missing from `hunks` count as risk 0.
export function maxRisk(ids: string[], hunks: Record<string, Hunk>): Risk {
  let r = 0;
  for (const id of ids) r = Math.max(r, hunks[id]?.risk ?? 0);
  return r as Risk;
}

// A character range [start, end) within a line.
export type CharRange = [number, number];

const squashWhitespace = (s: string) => s.replace(/\s+/g, '');

// For each line, the index of the line on the other side it replaces, or -1. Within a run of
// changes, lines equal up to whitespace pair first, in order; the lines between those anchors
// pair by position. Blank lines never anchor, so they cannot pull a pairing out of line.
export function pairChangedLines(lines: DiffLine[]): number[] {
  const partner = lines.map(() => -1);
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'ctx') {
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    for (; i < lines.length && lines[i].kind !== 'ctx'; i++) (lines[i].kind === 'del' ? dels : adds).push(i);
    const anchors: CharRange[] = [];
    let from = 0;
    for (let d = 0; d < dels.length; d++) {
      const key = squashWhitespace(lines[dels[d]].text);
      if (!key) continue;
      const a = adds.findIndex((x, k) => k >= from && squashWhitespace(lines[x].text) === key);
      if (a < 0) continue;
      anchors.push([d, a]);
      from = a + 1;
    }
    let prevD = 0;
    let prevA = 0;
    for (const [d, a] of [...anchors, [dels.length, adds.length]]) {
      for (let k = 0; k < Math.min(d - prevD, a - prevA); k++) {
        partner[dels[prevD + k]] = adds[prevA + k];
        partner[adds[prevA + k]] = dels[prevD + k];
      }
      if (d < dels.length) {
        partner[dels[d]] = adds[a];
        partner[adds[a]] = dels[d];
      }
      prevD = d + 1;
      prevA = a + 1;
    }
  }
  return partner;
}

// Why a removed line is folded into the added line that replaces it: that line differs only in
// whitespace (folded only while whitespace is ignored), or keeps every word and adds some.
export type Fold = 'whitespace' | 'insertion';

// Removed lines to show folded into their partner rather than as their own line.
export function foldedLines(lines: DiffLine[], partner: number[], ignoreWhitespace: boolean): Map<number, Fold> {
  const folded = new Map<number, Fold>();
  lines.forEach((l, i) => {
    const p = partner[i];
    if (l.kind !== 'del' || p < 0) return;
    const added = lines[p].text;
    if (ignoreWhitespace && squashWhitespace(l.text) === squashWhitespace(added)) folded.set(i, 'whitespace');
    else if (isInsertion(l.text, added, ignoreWhitespace)) folded.set(i, 'insertion');
  });
  return folded;
}

// `b` is `a` with words added: nothing of `a` removed (bar whitespace, when ignored), and more
// than whitespace added. A blank `a` never qualifies; it would fold into any line.
function isInsertion(a: string, b: string, ignoreWhitespace: boolean): boolean {
  if (!a.trim()) return false;
  const d = wordDiff(a, b);
  const blank =
    (text: string) =>
    ([s, e]: CharRange) =>
      !text.slice(s, e).trim();
  return !!d && d.a.every((r) => ignoreWhitespace && blank(a)(r)) && d.b.some((r) => !blank(b)(r));
}

const TOKEN_RE = /\w+|\s+|[^\w\s]/g;
const MAX_WORD_DIFF_CELLS = 40_000;

// The character ranges of `a` and `b` outside their longest common token subsequence, with
// ranges separated only by whitespace merged. Undefined when both sides changed but share so
// little that emphasizing words would only add noise, or the lines are too long to compare.
export function wordDiff(a: string, b: string): { a: CharRange[]; b: CharRange[] } | undefined {
  const ta = [...a.matchAll(TOKEN_RE)];
  const tb = [...b.matchAll(TOKEN_RE)];
  if (ta.length * tb.length > MAX_WORD_DIFF_CELLS) return undefined;
  // lcs[i][j]: common tokens of ta[i..] and tb[j..].
  const lcs = Array.from({ length: ta.length + 1 }, () => new Uint16Array(tb.length + 1));
  for (let i = ta.length - 1; i >= 0; i--) for (let j = tb.length - 1; j >= 0; j--) lcs[i][j] = ta[i][0] === tb[j][0] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const keepA = new Set<number>();
  const keepB = new Set<number>();
  let common = 0;
  for (let i = 0, j = 0; i < ta.length && j < tb.length;) {
    if (ta[i][0] === tb[j][0]) {
      keepA.add(i++);
      keepB.add(j++);
      common += ta[i - 1][0].length;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  const ranges = (tokens: RegExpExecArray[], keep: Set<number>, text: string): CharRange[] => {
    const out: CharRange[] = [];
    tokens.forEach((t, k) => {
      if (keep.has(k)) return;
      const start = t.index;
      const end = start + t[0].length;
      const last = out[out.length - 1];
      if (last && !text.slice(last[1], start).trim()) last[1] = end;
      else out.push([start, end]);
    });
    return out;
  };
  const out = { a: ranges(ta, keepA, a), b: ranges(tb, keepB, b) };
  // A pure insertion or deletion always reads well; a rewrite only when enough is shared.
  if (out.a.length && out.b.length && common * 2 < (a.length + b.length) * 0.5) return undefined;
  return out;
}
