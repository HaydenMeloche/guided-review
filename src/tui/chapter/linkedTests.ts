import type { DiffLine, Hunk } from '../../types.js';

// The tests linked to a hunk (name guesses only get a hint), and the code the test pane shows for
// the `idx`th: the test's diff, its lines, or for a hunk of tests, the code it covers.
export function linkedTests(hunk: Hunk | undefined, idx: number) {
  const tests = hunk?.tests.filter((t) => t.source !== 'naming') ?? [];
  const selected = tests[idx];
  const lines: DiffLine[] = hunk?.covers
    ? hunk.covers.lines.map((text, i) => ({ kind: 'ctx', text, newLine: hunk.covers!.startLine + i }))
    : selected?.diffHunks?.length
      ? selected.diffHunks.flatMap((diff) => diff.lines)
      : (selected?.lines.map((text, i) => ({ kind: 'ctx', text, newLine: selected.startLine + i })) ?? []);
  return { tests, selected, file: hunk?.covers?.file ?? selected?.testFile, lines, any: !!hunk && (tests.length > 0 || !!hunk.covers) };
}
