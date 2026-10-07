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
});
