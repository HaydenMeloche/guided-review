import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffFile, Hunk, Tour } from '../../types.js';
import { foldedLines, pairChangedLines, type Fold } from '../../diff/lines.js';
import { safeReadFile } from '../../analysis/safeRead.js';
import { importRuns, type ImportRun } from '../../analysis/imports.js';
import { fileLines, headFor, withContext } from '../../diff/context.js';

export const CONTEXT_STEP = 10; // lines + and - add or remove on each side of a hunk

// The head's lines of a hunk's file, for expanding its context, or why there are none to show.
function headOf(hunk: Hunk, files: DiffFile[], root?: string): { lines: string[] } | { reason: string } {
  const file = files.find((f) => f.path === hunk.file);
  if (!file || file.status === 'added') return { reason: 'No context to add: this file is new, so the hunk already shows all of it.' };
  if (file.status === 'deleted') return { reason: 'No context to add: this file is deleted in the PR.' };
  if (file.binary) return { reason: 'No context to add: this is a binary file.' };
  if (!root) return { reason: 'Context can be expanded once the checkout is ready.' };
  const text = safeReadFile(root, hunk.file);
  if (text === undefined) return { reason: 'Can’t read more of this file: it is over 1 MB, or not a plain file in the checkout.' };
  const lines = headFor(hunk, fileLines(text));
  return lines ? { lines } : { reason: 'No context to add: the file has changed since the diff was taken.' };
}

export type HunkView = ReturnType<typeof useHunkView>;

// How the reader is looking at one hunk: the code cursor and range, scroll, raw diff, expanded
// context, and the linked test pane. `useFoldedCursor` resets it when the hunk changes.
export function useHunkView(diffHunk: Hunk | undefined, tour: Pick<Tour, 'files' | 'hunks'>, root: string | undefined, flash: (message: string) => void) {
  // Context the reader expanded around the hunk (+ and -), read from the checkout's head. Keyed
  // on the hunk, so moving to another hunk starts it unexpanded.
  const [expand, setExpand] = useState({ id: '', above: 0, below: 0 });
  const headLines = useMemo(() => {
    const head = diffHunk && expand.id === diffHunk.id ? headOf(diffHunk, tour.files, root) : undefined;
    return head && 'lines' in head ? head.lines : undefined;
  }, [diffHunk, tour.files, root, expand.id]);
  const neighbours = useMemo(() => {
    const ids = diffHunk ? (tour.files.find((f) => f.path === diffHunk.file)?.hunkIds ?? []) : [];
    const at = diffHunk ? ids.indexOf(diffHunk.id) : -1;
    const prev = at > 0 ? tour.hunks[ids[at - 1]] : undefined;
    const next = at >= 0 ? tour.hunks[ids[at + 1]] : undefined;
    return { prevEnd: prev?.lines.findLast((l) => l.newLine !== undefined)?.newLine, nextStart: next?.lines.find((l) => l.newLine !== undefined)?.newLine };
  }, [diffHunk, tour.files, tour.hunks]);
  // The hunk as shown: the diff's hunk plus any expanded context, with the same id and content hash.
  const hunk = useMemo(() => (diffHunk && headLines ? withContext(diffHunk, headLines, expand.above, expand.below, neighbours).hunk : diffHunk), [diffHunk, headLines, expand, neighbours]);
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [scroll, setScroll] = useState(0);
  const [raw, setRaw] = useState(false);
  const [testFocus, setTestFocus] = useState(false);
  const [testIdx, setTestIdx] = useState(0);
  const [testCursor, setTestCursor] = useState(0);
  const [testScroll, setTestScroll] = useState(0);

  // Shows `by` more lines of context on each side of the hunk, or fewer when negative, keeping the
  // cursor on its line.
  const growContext = (by: number) => {
    if (!diffHunk) return;
    const head = headLines ? { lines: headLines } : headOf(diffHunk, tour.files, root);
    if ('reason' in head) return flash(head.reason);
    const { lines } = head;
    const now = expand.id === diffHunk.id ? expand : { above: 0, below: 0 };
    const before = withContext(diffHunk, lines, now.above, now.below, neighbours);
    const after = withContext(diffHunk, lines, Math.max(0, now.above + by), Math.max(0, now.below + by), neighbours);
    if (by > 0 && after.above === before.above && after.below === before.below) return flash('No more context: the hunk reaches the file’s edges or its neighbouring hunks.');
    const shift = after.above - before.above;
    const last = after.hunk.lines.length - 1;
    setCursor((c) => Math.max(0, Math.min(last, c + shift)));
    setAnchor((a) => (a === null ? null : Math.max(0, Math.min(last, a + shift))));
    setExpand({ id: diffHunk.id, above: after.above, below: after.below });
  };

  return {
    hunk,
    cursor,
    setCursor,
    anchor,
    setAnchor,
    scroll,
    setScroll,
    raw,
    setRaw,
    testFocus,
    setTestFocus,
    testIdx,
    setTestIdx,
    testCursor,
    setTestCursor,
    testScroll,
    setTestScroll,
    growContext,
  };
}

// Folds depend on the layout (a split diff folds every replaced line), which depends on the view,
// so they come in after it: this resets the view when the hunk changes, keeps the cursor and range
// ends off folded lines, and returns how j/k move the cursor over them.
export function useFoldedCursor(view: HunkView, hidden: ReadonlyMap<number, Fold>, partner: number[], land: (i: number) => number) {
  const { hunk, setCursor, setAnchor } = view;
  // Reset per-hunk view state when the hunk changes; the test side jumps to the matching case.
  useEffect(() => {
    // The first real change: not a folded line, nor a line that only changed whitespace.
    const first = hunk
      ? Math.max(
          0,
          hunk.lines.findIndex((l, i) => l.kind !== 'ctx' && !hidden.has(i) && hidden.get(partner[i]) !== 'whitespace'),
          hunk.lines.findIndex((l, i) => l.kind !== 'ctx' && !hidden.has(i)),
        )
      : 0;
    setCursor(first);
    setAnchor(null);
    view.setScroll(0);
    view.setTestIdx(0);
    view.setTestCursor(0);
    view.setTestScroll(0);
    view.setTestFocus(false);
    view.setRaw(false);
    // Keyed on the id: the hunk object is replaced as narration streams in, and folds changing
    // are handled by the effect below, neither of which should reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunk?.id]);
  // Folding a line moves a cursor or range end off it onto its replacement. Updaters, so a
  // cursor the hunk reset just placed is the one checked.
  useEffect(() => {
    setCursor((c) => (hidden.has(c) ? land(c) : c));
    setAnchor((a) => (a !== null && hidden.has(a) ? land(a) : a));
  }, [hidden, land, setCursor, setAnchor]);

  const visibleLine = (i: number, dir: 1 | -1) => {
    const n = hunk?.lines.length ?? 0;
    for (let j = i; j >= 0 && j < n; j += dir) if (!hidden.has(j)) return j;
    for (let j = i; j >= 0 && j < n; j -= dir) if (!hidden.has(j)) return j;
    return i;
  };
  return (by: number) => setCursor((c) => visibleLine(Math.max(0, Math.min((hunk?.lines.length ?? 1) - 1, c + by)), by > 0 ? 1 : -1));
}

// Removed lines folded into the line replacing them; the cursor steps over them. Split, every
// removed line with a replacement sits beside it, on the replacement's row. With `foldImports`,
// the imports a hunk that changes code too adds or removes fold to one row, on the run's first
// line (`runs`, by that line); `land` is where a cursor on a folded line goes.
export function useFolds(hunk: Hunk | undefined, ignoreWhitespace: boolean, split: boolean, foldImports = false) {
  const partner = useMemo(() => (hunk ? pairChangedLines(hunk.lines) : []), [hunk]);
  const runs = useMemo(() => new Map<number, ImportRun>(hunk && foldImports && !hunk.importOnly ? importRuns(hunk).map((r) => [r.start, r]) : []), [hunk, foldImports]);
  const hidden = useMemo(() => {
    const folds = hunk ? foldedLines(hunk.lines, partner, ignoreWhitespace) : new Map<number, Fold>();
    if (split && hunk) for (const [i, p] of partner.entries()) if (p >= 0 && hunk.lines[i].kind === 'del' && !folds.has(i)) folds.set(i, 'beside');
    for (const r of runs.values()) {
      folds.delete(r.start);
      for (let i = r.start + 1; i <= r.end; i++) folds.set(i, 'imports');
    }
    return folds;
  }, [hunk, partner, ignoreWhitespace, split, runs]);
  const land = useCallback(
    (i: number) => {
      if (hidden.get(i) !== 'imports') return partner[i];
      for (const r of runs.values()) if (i >= r.start && i <= r.end) return r.start;
      return i;
    },
    [hidden, partner, runs],
  );
  return { partner, hidden, runs, land };
}
