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

// Give each pane its longest line's width when possible. Otherwise share the
// available columns in proportion to those widths; code wraps within each pane.
// The focused pane is expanded to its longest line, squeezing the other down to the minimum.
// A split source pane needs room for each line twice, old beside new.
export function codePaneWidths(available: number, sourceLines: string[], testLines: string[], focus: 'source' | 'test' = 'source', split = false): { source: number; test: number } {
  const sourceNeed = split ? 2 * codeWidth(sourceLines, SPLIT_GUTTER + 1) + 2 : codeWidth(sourceLines, GUTTER);
  const testNeed = codeWidth(testLines, GUTTER + 2); // test border and padding, plus the same gutter
  if (sourceNeed + testNeed <= available) return { source: sourceNeed, test: testNeed };
  const minimum = Math.min(MIN_PANE_WIDTH, Math.floor(available / 2));
  const clamp = (n: number) => Math.max(minimum, Math.min(available - minimum, n));
  if (focus === 'test') {
    const test = clamp(Math.max(testNeed, Math.round((available * testNeed) / (sourceNeed + testNeed))));
    return { source: available - test, test };
  }
  const source = clamp(Math.round((available * sourceNeed) / (sourceNeed + testNeed)));
  return { source, test: available - source };
}
