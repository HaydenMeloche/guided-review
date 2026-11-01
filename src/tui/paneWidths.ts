const MIN_PANE_WIDTH = 40;

// The columns before a line's code. A diff line: the cursor, old and new line numbers, a quiet
// rule, the sign and a space (`▶  26   27 │ + code`). One side of a split diff: its line number,
// the rule, the sign and a space. A plain line (a test, the code a test covers): the cursor, its
// line number and the rule.
export const GUTTER = 15;
export const SPLIT_GUTTER = 9;
export const PLAIN_GUTTER = 8;
// A split diff narrower than this is two unreadable slivers: it shows inline instead.
export const MIN_SPLIT_WIDTH = 90;

function codeWidth(lines: string[], chrome: number): number {
  return Math.max(MIN_PANE_WIDTH, chrome + lines.reduce((longest, line) => Math.max(longest, line.replace(/\t/g, '  ').length), 0));
}

// The source pane always gets its longest line's width, so its code never wraps beside the tests;
// the test pane takes what is left, at least MIN_PANE_WIDTH. When that leaves the tests too
// little room, `stack` says to put them behind a tab (t opens them) instead of squeezing the
// code. With room for both, each pane gets its longest line's width. A split source pane needs
// room for each line twice, old beside new. `noteWidth`: the widest note under the source's
// lines, which wants room too.
export function codePaneWidths(available: number, sourceLines: string[], testLines: string[], split = false, noteWidth = 0): { source: number; test: number; stack: boolean } {
  const sourceNeed = Math.max(noteWidth + 1, split ? 2 * codeWidth(sourceLines, SPLIT_GUTTER + 1) + 2 : codeWidth(sourceLines, GUTTER));
  const testNeed = codeWidth(testLines, GUTTER + 2); // test border and padding, plus the same gutter
  if (sourceNeed + testNeed <= available) return { source: sourceNeed, test: testNeed, stack: false };
  if (available - sourceNeed >= MIN_PANE_WIDTH) return { source: sourceNeed, test: available - sourceNeed, stack: false };
  return { source: available, test: available, stack: true };
}
