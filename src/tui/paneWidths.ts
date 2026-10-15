const MIN_PANE_WIDTH = 40;
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
  const sourceNeed = split ? 2 * codeWidth(sourceLines, 7) + 2 : codeWidth(sourceLines, 12); // cursor, line numbers, and diff sign
  const testNeed = codeWidth(testLines, 14); // test border/padding plus the same gutter
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
