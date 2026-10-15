import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { FUSE_GAP, parseTourDiff } from '../src/diff/fuse.js';
import { markMovedLines } from '../src/diff/moves.js';
import { buildReviewPayload } from '../src/review/submit.js';
import type { Draft } from '../src/types.js';
import { hunkKeys, stateOf } from '../src/review/hunkState.js';
import { computeReReview } from '../src/review/rereview.js';
import { applyMoves } from '../src/tui/nav.js';
import { hunkFromDiff, tour } from './fixtures/tour.js';

// A block moved up the file next to an unrelated edit, as GitHub diffs it: the add and the edit
// in one hunk, the remove in another.
const HEAD = [
  'line1();',
  'line2();',
  'line3();',
  '<Section entries={deducted}',
  '  title={DEDUCTED}',
  '  total={minusTotal} />',
  'line4();',
  'line5(changed);',
  ...Array.from({ length: 22 }, (_, i) => `line${i + 6}();`).filter((l) => !['line14();', 'line15();', 'line16();'].includes(l)),
].join('\n');

const MOVE_DIFF = `diff --git a/src/fees.tsx b/src/fees.tsx
index e0290c2..a989242 100644
--- a/src/fees.tsx
+++ b/src/fees.tsx
@@ -1,8 +1,11 @@
 line1();
 line2();
 line3();
+<Section entries={deducted}
+  title={DEDUCTED}
+  total={minusTotal} />
 line4();
-line5();
+line5(changed);
 line6();
 line7();
 line8();
@@ -11,9 +14,6 @@ line10();
 line11();
 line12();
 line13();
-<Section entries={deducted}
-  title={DEDUCTED}
-  total={minusTotal} />
 line17();
 line18();
 line19();
`;

const readHead = (path: string) => (path === 'src/fees.tsx' ? HEAD + '\n' : undefined);

describe('fusing nearby hunks', () => {
  it('shows a short move and the edit beside it as one hunk, with the gap read from the head', () => {
    expect(parseUnifiedDiff(MOVE_DIFF).hunks).toHaveLength(2);
    const { files, hunks } = parseTourDiff(MOVE_DIFF, readHead);
    expect(hunks).toHaveLength(1);
    const [h] = hunks;
    expect(files[0].hunkIds).toEqual([h.id]);
    expect(h.header).toBe('@@ -1,19 +1,19 @@');
    const gap = h.lines.filter((l) => l.expanded);
    expect(gap.map((l) => [l.oldLine, l.newLine, l.text])).toEqual([
      [9, 12, 'line9();'],
      [10, 13, 'line10();'],
    ]);
    expect(h.lines.filter((l) => l.kind === 'add')).toHaveLength(4);
    expect(h.lines.filter((l) => l.kind === 'del')).toHaveLength(4);
  });

  it('fuses against a checkout with CRLF line endings, keeping the diff’s LF text', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, () => HEAD.replace(/\n/g, '\r\n') + '\r\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.filter((l) => l.expanded).map((l) => l.text)).toEqual(['line9();', 'line10();']);
  });

  it('keeps hunks apart when they are far apart, or the head cannot be read or has changed', () => {
    const far = MOVE_DIFF.replace('@@ -11,9 +14,6 @@', `@@ -${11 + FUSE_GAP},9 +${14 + FUSE_GAP},6 @@`);
    expect(parseTourDiff(far, () => undefined).hunks).toHaveLength(2);
    expect(parseTourDiff(MOVE_DIFF, () => undefined).hunks).toHaveLength(2);
    expect(parseTourDiff(MOVE_DIFF, () => HEAD.replace('line7();', 'edited();')).hunks).toHaveLength(2);
  });
});

describe('marking moved lines', () => {
  it('links each side of a moved block to the other', () => {
    const { hunks } = parseUnifiedDiff(MOVE_DIFF);
    markMovedLines(hunks);
    const added = hunks[0].lines.filter((l) => l.moved);
    const removed = hunks[1].lines.filter((l) => l.moved);
    expect(added.map((l) => l.moved)).toEqual([14, 15, 16].map((line) => ({ file: 'src/fees.tsx', line })));
    expect(removed.map((l) => l.moved)).toEqual([4, 5, 6].map((line) => ({ file: 'src/fees.tsx', line })));
    // The one-line edit is not part of it.
    expect(hunks[0].lines.find((l) => l.text === 'line5(changed);')?.moved).toBeUndefined();
  });

  it('stays fast when a PR repeats short lines on both sides', () => {
    const N = 10_000;
    const side = (sign: string, tag: string) => Array.from({ length: N }, (_, i) => (i % 20 ? `${sign}}` : `${sign}${tag}${i}();`));
    const del = hunkFromDiff('src/a.c', ...side('-', 'a'));
    const add = hunkFromDiff('src/b.c', ...side('+', 'b'));
    const started = performance.now();
    markMovedLines([del, add]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('leaves lockfiles out', () => {
    const block = ['  resolved "https://registry.example/pkg-1.0.0.tgz"', '  integrity sha512-abcdef', '  dependencies:'];
    const hunks = [hunkFromDiff('yarn.lock', ...block.map((l) => `-${l}`)), hunkFromDiff('yarn.lock', ...block.map((l) => `+${l}`))];
    markMovedLines(hunks);
    expect(hunks.flatMap((h) => h.lines).some((l) => l.moved)).toBe(false);
  });

  it('points a block moved out of a renamed file at its old path', () => {
    const block = ['export function total(items) {', '  return items.reduce(sum, 0);', '}'];
    const from = hunkFromDiff('src/new-name.ts', ...block.map((l) => `-${l}`));
    from.oldFile = 'src/old-name.ts';
    const to = hunkFromDiff('src/other.ts', ...block.map((l) => `+${l}`));
    markMovedLines([from, to]);
    expect(to.lines[0].moved).toEqual({ file: 'src/old-name.ts', line: 1 });
    expect(from.lines[0].moved).toEqual({ file: 'src/other.ts', line: 1 });
  });

  it('does not call a reindent, or a few short lines, a move', () => {
    const reindent = hunkFromDiff('src/a.ts', '-if (a) {', '-  go(everything);', '-}', '+  if (a) {', '+    go(everything);', '+  }');
    const short = [hunkFromDiff('src/b.ts', '-}', '-}', '-}'), hunkFromDiff('src/c.ts', '+}', '+}', '+}')];
    markMovedLines([reindent, ...short]);
    expect([reindent, ...short].flatMap((h) => h.lines).some((l) => l.moved)).toBe(false);
  });
});

describe('review comments on fused hunks', () => {
  const draft = (anchor: Draft['anchor']): Draft => ({ id: 'd', repo: 'o/r', pr: 1, headSha: 'head', anchor, label: 'nit', body: 'x', posted: false, createdAt: '' });

  it('never attaches to expanded context, and keeps a range only inside one of GitHub’s hunks', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, readHead);
    const t = tour(hunks, [{ hunkIds: [hunks[0].id] }]);
    const id = hunks[0].id;
    const onGap = buildReviewPayload(t, [draft({ type: 'line', hunkId: id, file: 'src/fees.tsx', line: 12, side: 'RIGHT' })], 'COMMENT', '');
    expect(onGap.payload.comments[0].line).not.toBe(12);
    expect(onGap.moved).toHaveLength(1);
    const across = buildReviewPayload(t, [draft({ type: 'range', hunkId: id, file: 'src/fees.tsx', startLine: 8, line: 15, side: 'RIGHT' })], 'COMMENT', '');
    expect(across.payload.comments[0]).toMatchObject({ line: 15 });
    expect(across.payload.comments[0].start_line).toBeUndefined();
    const within = buildReviewPayload(t, [draft({ type: 'range', hunkId: id, file: 'src/fees.tsx', startLine: 4, line: 8, side: 'RIGHT' })], 'COMMENT', '');
    expect(within.payload.comments[0]).toMatchObject({ start_line: 4, line: 8 });
  });

  it('says so when a range is cut to one line, and never posts its suggestion as one GitHub can apply', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, readHead);
    const t = tour(hunks, [{ hunkIds: [hunks[0].id] }]);
    const d = { ...draft({ type: 'range', hunkId: hunks[0].id, file: 'src/fees.tsx', startLine: 8, line: 15, side: 'RIGHT' }), suggestion: 'a\nb\nc' };
    const { payload, moved } = buildReviewPayload(t, [d], 'COMMENT', '');
    expect(payload.comments[0].start_line).toBeUndefined();
    expect(payload.comments[0].body).not.toContain('```suggestion');
    expect(payload.comments[0].body).toContain('```\na\nb\nc\n```');
    expect(payload.comments[0].body).toContain('Originally on lines 8-15');
    expect(moved).toEqual([expect.objectContaining({ draftId: 'd', note: expect.stringContaining('with the suggestion as plain code') })]);
    // A suggestion moved to the nearest line would replace the wrong code, too.
    const gone = buildReviewPayload(t, [{ ...draft({ type: 'line', hunkId: hunks[0].id, file: 'src/fees.tsx', line: 12, side: 'RIGHT' }), suggestion: 'x' }], 'COMMENT', '');
    expect(gone.payload.comments[0].body).not.toContain('```suggestion');
  });
});

describe('progress on fused hunks', () => {
  // The same two edits, 3 unchanged lines apart (fused), then 8 apart after the base gained
  // five lines between them (a rebase): two hunks.
  const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`);
  const ctx = (from: number, to: number, name = (n: number) => `l${n}`) => Array.from({ length: to - from + 1 }, (_, i) => ` ${name(from + i)}`);
  const file = (hunks: string[][]) => `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${hunks.map((h) => h.join('\n')).join('\n')}\n`;
  const near = file([
    ['@@ -7,7 +7,7 @@', ...ctx(7, 9), '-l10', '+L10', ...ctx(11, 13)],
    ['@@ -17,7 +17,7 @@', ...ctx(17, 19), '-l20', '+L20', ...ctx(21, 23)],
  ]);
  const nearHead = lines(30, { 10: 'L10', 20: 'L20' }).join('\n') + '\n';
  // l1..l15, five new lines, l16..l30: l20 is now line 25.
  const farName = (n: number) => (n <= 15 ? `l${n}` : n <= 20 ? `x${n - 15}` : `l${n - 5}`);
  const far = file([
    ['@@ -7,7 +7,7 @@', ...ctx(7, 9), '-l10', '+L10', ...ctx(11, 13)],
    ['@@ -22,7 +22,7 @@', ...ctx(22, 24, farName), '-l20', '+L20', ...ctx(26, 28, farName)],
  ]);
  const farHead = Array.from({ length: 35 }, (_, i) => (i + 1 === 10 ? 'L10' : i + 1 === 25 ? 'L20' : farName(i + 1))).join('\n') + '\n';
  const fused = parseTourDiff(near, () => nearHead).hunks;
  const apart = parseTourDiff(far, () => farHead).hunks;

  it('keys a fused hunk by the GitHub hunks it joins', () => {
    expect(fused).toHaveLength(1);
    expect(apart).toHaveLength(2);
    expect(fused[0].parts).toEqual(apart.map((h) => h.contentHash));
  });

  it('keeps read state when the same changes fuse, or stop fusing, on another head', () => {
    const states = Object.fromEntries(hunkKeys(fused[0]).map((k) => [k, 'read' as const]));
    expect(apart.map((h) => stateOf(states, h))).toEqual(['read', 'read']);
    const one = { [apart[0].contentHash]: 'read' as const };
    expect(stateOf(one, fused[0])).toBe('unread');
    expect(stateOf({ ...one, [apart[1].contentHash]: 'skipped' }, fused[0])).toBe('skipped');
  });

  it('does not call a hunk new on re-review just because it fused differently', () => {
    const ctxNone = { postedDrafts: [], threads: [], diffPrevToNext: '' };
    expect(computeReReview(tour(fused), tour(apart), ctxNone).newHunkIds).toEqual([]);
    expect(computeReReview(tour(apart), tour(fused), ctxNone).newHunkIds).toEqual([]);
    expect(computeReReview(tour(apart.slice(0, 1)), tour(fused), ctxNone).newHunkIds).toEqual([fused[0].id]);
  });

  it('applies a move saved for one part to the fused hunk', () => {
    const t = tour(fused, [{ id: 'a', hunkIds: [fused[0].id] }, { id: 'b' }]);
    const moved = applyMoves(t.chapters, t, { [apart[1].contentHash]: 'b' });
    expect(moved.find((c) => c.id === 'b')?.hunkIds).toEqual([fused[0].id]);
  });
});
