import type { DraftAnchor, Hunk, SuggestionMeta, Tour } from '../types.js';
import { lineOn, sameDiffHunk } from './submit.js';

// Whether a suggestion can be posted as one GitHub can apply, and checks on replacement code.
// GitHub replaces the selected RIGHT-side lines with the block, whatever its length, so line
// count is no check; side, hunk and head are.

export type ApplicabilityCode = 'left-side' | 'not-line-anchor' | 'crosses-hunks' | 'expanded-context' | 'not-in-diff' | 'head-changed';

export type Applicability = { ok: true; startLine: number; line: number } | { ok: false; reason: string; code: ApplicabilityCode };

type LineAnchor = Extract<DraftAnchor, { type: 'line' | 'range' }>;

const span = (a: LineAnchor) => {
  const start = a.type === 'range' ? a.startLine : a.line;
  return { startLine: Math.min(start, a.line), line: Math.max(start, a.line) };
};

export function suggestionApplicability(tour: Tour, anchor: DraftAnchor, meta?: SuggestionMeta, opts: { originalUnchanged?: boolean } = {}): Applicability {
  if (anchor.type !== 'line' && anchor.type !== 'range') return { ok: false, code: 'not-line-anchor', reason: 'Suggestions need a line or range anchor.' };
  if (anchor.side !== 'RIGHT') return { ok: false, code: 'left-side', reason: "GitHub can't apply suggestions to removed lines." };
  const { startLine, line } = span(anchor);
  const hunks = Object.values(tour.hunks).filter((h) => h.file === anchor.file);
  const where = (n: number) => {
    if (hunks.some((h) => h.lines.some((l) => lineOn(l, 'RIGHT') === n))) return 'diff';
    // Expanded context has a head line number but is not in GitHub's diff.
    if (hunks.some((h) => h.lines.some((l) => l.expanded && l.kind !== 'del' && l.newLine === n))) return 'expanded';
    return 'none';
  };
  const ends = [where(startLine), where(line)];
  if (ends.includes('expanded')) return { ok: false, code: 'expanded-context', reason: "The selection includes expanded context, which isn't in GitHub's diff. Narrow the range to changed lines." };
  if (ends.includes('none')) return { ok: false, code: 'not-in-diff', reason: `${startLine === line ? `Line ${line} is` : `Lines ${startLine}-${line} are`} not in the diff.` };
  if (!sameDiffHunk(tour, anchor.file, startLine, line, 'RIGHT')) return { ok: false, code: 'crosses-hunks', reason: `Lines ${startLine}-${line} span more than one GitHub hunk. Narrow the range.` };
  if (meta && meta.headSha !== tour.headSha && !opts.originalUnchanged)
    return { ok: false, code: 'head-changed', reason: `The suggestion was written on ${meta.headSha.slice(0, 7)} and the lines changed since.` };
  return { ok: true, startLine, line };
}

// The anchored lines' text on the anchor's side, as the suggestion would replace them.
export function originalLines(hunk: Hunk, anchor: LineAnchor): string {
  const { startLine, line } = span(anchor);
  const no = (l: Hunk['lines'][number]) => (anchor.side === 'RIGHT' ? (l.kind !== 'del' ? l.newLine : undefined) : l.kind !== 'add' ? l.oldLine : undefined);
  return hunk.lines
    .filter((l) => {
      const n = no(l);
      return n !== undefined && n >= startLine && n <= line;
    })
    .map((l) => l.text)
    .join('\n');
}

export type Normalized = { ok: true; code: string; notes: string[] } | { ok: false; reason: string };

const FENCE_OPEN = /^\s*(`{3,}|~{3,})[\w+-]*\s*$/;
const clean = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
const dropTrailingBlank = (lines: string[]) => {
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const indentOf = (lines: string[]) => /^\s*/.exec(lines.find((l) => l.trim()) ?? '')![0];

// Model (or pasted) replacement code, made safe to post as a GitHub suggestion block. Only
// structure is checked: the code is never compiled or run.
// `before`/`after`: the lines just outside the selection, to catch output that repeats them.
export function normalizeReplacement(original: string, raw: string, opts: { allowEmpty?: boolean; before?: string; after?: string } = {}): Normalized {
  const notes: string[] = [];
  let lines = dropTrailingBlank(clean(raw));
  while (lines.length && lines[0] === '') lines.shift();
  const open = FENCE_OPEN.exec(lines[0] ?? '');
  if (open && lines.length >= 2 && lines[lines.length - 1].trim() === open[1]) {
    lines = dropTrailingBlank(lines.slice(1, -1));
    notes.push('The code fence around the proposal was removed.');
  }
  // A fence inside would close the suggestion block early.
  if (lines.some((l) => /^\s*(```|~~~)/.test(l))) return { ok: false, reason: 'The proposal contains a code fence.' };

  const origLines = dropTrailingBlank(clean(original));
  const nonEmpty = lines.filter((l) => l.trim());
  const diffish = (ls: string[]) => ls.length > 0 && ls.every((l) => /^[+-]/.test(l));
  if (diffish(nonEmpty) && !diffish(origLines.filter((l) => l.trim()))) {
    if (!nonEmpty.every((l) => l.startsWith('+'))) return { ok: false, reason: 'The proposal looks like a diff (+/- lines), not replacement code.' };
    // `+code` (diff format) and `+ code` are both seen; the one that keeps the original's
    // indentation wins.
    const strip = (prefix: RegExp) => lines.map((l) => l.replace(prefix, ''));
    const spaced = nonEmpty.every((l) => l.startsWith('+ ')) ? strip(/^\+ /) : undefined;
    const bare = strip(/^\+/);
    lines = spaced && indentOf(bare) !== indentOf(origLines) ? spaced : bare;
    notes.push('Diff + markers were removed from the proposal.');
  }

  const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.trim() !== '' && a.trimEnd() === b.trimEnd();
  let bled = false;
  // Only when the selection does not itself start or end with that same line.
  if (lines.length > 1 && same(lines[0], opts.before) && !same(origLines[0], opts.before)) {
    lines = lines.slice(1);
    bled = true;
  }
  if (lines.length > 1 && same(lines[lines.length - 1], opts.after) && !same(origLines[origLines.length - 1], opts.after)) {
    lines = lines.slice(0, -1);
    bled = true;
  }
  if (bled) notes.push('The model included surrounding lines. They were removed from the proposal.');

  const code = dropTrailingBlank(lines).join('\n');
  if (!code.trim()) {
    if (!opts.allowEmpty) return { ok: false, reason: 'The proposal is empty.' };
    notes.push('The proposal deletes the selected lines.');
    return { ok: true, code: '', notes };
  }
  if (code === origLines.join('\n')) return { ok: false, reason: 'The proposal is identical to the selected code.' };
  if (origLines.some((l) => l.trim()) && indentOf(lines) !== indentOf(origLines)) notes.push("The proposal's indentation differs from the selected code.");
  return { ok: true, code, notes };
}
