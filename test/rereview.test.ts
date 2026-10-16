import { describe, expect, it } from 'vitest';
import { computeReReview } from '../src/review/rereview.js';
import type { Draft } from '../src/types.js';
import { hunk, tour } from './fixtures/tour.js';

const prev = tour([hunk('a', 'src/x.ts', [], { contentHash: 'same' }), hunk('b', 'src/x.ts', [], { contentHash: 'old' })]);
const next = tour([hunk('a2', 'src/x.ts', [], { contentHash: 'same' }), hunk('c', 'src/x.ts', [], { contentHash: 'new' })], [], { headSha: 'next' });

const delta = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -40,5 +40,5 @@ function f() {
 a
 b
-c
+C
 d
 e
`;

const posted = (line: number, body: string): Draft => ({
  id: body,
  repo: 'o/r',
  pr: 1,
  headSha: 'prev',
  label: 'blocking',
  body,
  posted: true,
  createdAt: '',
  anchor: { type: 'line', hunkId: 'b', file: 'src/x.ts', line, side: 'RIGHT' },
});

describe('computeReReview', () => {
  it('reports new hunks and whether comments were addressed', () => {
    const r = computeReReview(prev, next, {
      postedDrafts: [posted(42, 'fix c'), posted(10, 'other'), posted(41, 'resolved one')],
      threads: [
        { id: 't1', path: 'src/x.ts', line: 41, isResolved: true, isOutdated: false, comments: [{ author: 'me', body: '**[blocking]** resolved one', createdAt: '' }] },
        { id: 't2', path: 'src/x.ts', line: 5, isResolved: false, isOutdated: false, comments: [{ author: 'me', body: 'from github', createdAt: '' }] },
      ],
      diffPrevToNext: delta,
      viewer: 'me',
    });
    expect(r.previousHead).toBe('head');
    expect(r.newHunkIds).toEqual(['c']);
    expect(r.comments[0]).toMatchObject({ addressed: true, reason: 'line 42 changed since comment' });
    expect(r.comments[1]).toMatchObject({ addressed: false, reason: 'no change at commented line' });
    expect(r.comments[2]).toMatchObject({ addressed: true, reason: 'thread resolved' });
    expect(r.comments[3]).toMatchObject({ body: 'from github', addressed: false });
  });

  it('matches a posted draft whose references became links, and never changes it', () => {
    const ref = { id: 'r', kind: 'range' as const, path: 'src/y.ts', commitSha: 'prev', startLine: 1, endLine: 2, label: 'y.ts:1-2', linesHash: 'h' };
    const d: Draft = { ...posted(10, 'Same bug as `y.ts:1-2` here'), refs: [ref], suggestion: 'x', suggestionMeta: { source: 'manual', headSha: 'prev', originalHash: 'o' } };
    const before = structuredClone(d);
    const deepFreeze = (o: object) => {
      Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v as object));
      return Object.freeze(o);
    };
    deepFreeze(d);
    const r = computeReReview(prev, next, {
      postedDrafts: [d],
      threads: [
        {
          id: 't',
          path: 'src/x.ts',
          line: 10,
          isResolved: true,
          isOutdated: false,
          comments: [{ author: 'me', body: '**[blocking]** Same bug as [`y.ts:1-2`](https://github.com/o/r/blob/prev/src/y.ts#L1-L2) here', createdAt: '' }],
        },
      ],
      diffPrevToNext: delta,
      viewer: 'me',
    });
    expect(r.comments).toEqual([{ body: d.body, path: 'src/x.ts', line: 10, addressed: true, reason: 'thread resolved' }]);
    expect(d).toEqual(before);
  });

  it('matches a body that starts with a reference, and never matches another thread by its first word', () => {
    const ref = (label: string) => ({ id: label, kind: 'symbol' as const, path: 'src/y.ts', commitSha: 'prev', startLine: 1, endLine: 2, label });
    const thread = (id: string, line: number, body: string, isResolved: boolean) => ({ id, path: 'src/x.ts', line, isResolved, isOutdated: false, comments: [{ author: 'me', body, createdAt: '' }] });
    const link = (label: string) => `[\`${label}\`](https://ghe.example/o/r/blob/prev/src/y.ts#L1-L2)`;
    const r = computeReReview(prev, next, {
      postedDrafts: [
        { ...posted(10, '`foo()` returns early here'), refs: [ref('foo()')] },
        { ...posted(11, 'See `bar()` for the retry'), refs: [ref('bar()')] },
      ],
      threads: [
        // Another of the viewer's threads that merely starts with "See": it must stay unmatched.
        thread('other', 12, '**[blocking]** See the docs', false),
        thread('foo', 10, `**[blocking]** ${link('foo()')} returns early here`, true),
        thread('bar', 11, `**[blocking]** See ${link('bar()')} for the retry\n\n_Originally on line 9, which is no longer in the diff._`, true),
      ],
      diffPrevToNext: delta,
      viewer: 'me',
    });
    expect(r.comments.slice(0, 2)).toEqual([
      expect.objectContaining({ line: 10, addressed: true, reason: 'thread resolved' }),
      expect.objectContaining({ line: 11, addressed: true, reason: 'thread resolved' }),
    ]);
    // The unmatched thread is still reported as one of the viewer's own.
    expect(r.comments[2]).toMatchObject({ body: '**[blocking]** See the docs', addressed: false });
  });
});
