import { describe, expect, it } from 'vitest';
import {
  CONVERSATION,
  buildFeedback,
  conversationSources,
  quoteReply,
  groupFeedback,
  labelClass,
  mapLine,
  placedThreads,
  placeThread,
  rerequestByDefault,
  rerequestCandidates,
  rerequestFirst,
  TRIAGE_CYCLE,
  reviewerStatus,
  sendPlan,
  silentWontDo,
  snippetLines,
  spanChanged,
  stateCounts,
  threadDiffKey,
  type ThreadDiffs,
} from '../src/review/feedback.js';
import type { ExistingReview, ExistingThread } from '../src/types.js';
import { threadAt } from '../src/tui/chapter/lineNotes.js';
import { hunk, tour } from './fixtures/tour.js';

// Old lines 1-20 of src/x.ts; the push replaced line 5, inserted two lines after 10, and removed 15-16.
const push = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -5 +5 @@
-five
+FIVE
@@ -10,0 +11,2 @@
+new a
+new b
@@ -15,2 +16,0 @@
-fifteen
-sixteen
`;

describe('mapLine', () => {
  it('follows unchanged lines past insertions and removals', () => {
    expect(mapLine(push, 'src/x.ts', 3)).toEqual({ path: 'src/x.ts', line: 3, how: 'mapped' });
    expect(mapLine(push, 'src/x.ts', 10)).toEqual({ path: 'src/x.ts', line: 10, how: 'mapped' });
    expect(mapLine(push, 'src/x.ts', 11)).toEqual({ path: 'src/x.ts', line: 13, how: 'mapped' });
    expect(mapLine(push, 'src/x.ts', 17)).toEqual({ path: 'src/x.ts', line: 17, how: 'mapped' });
  });

  it('puts a rewritten line on the nearest line that survived', () => {
    expect(mapLine(push, 'src/x.ts', 5)).toEqual({ path: 'src/x.ts', line: 5, how: 'nearest' });
  });

  it('leaves files the diff does not touch alone and reports deleted ones', () => {
    expect(mapLine(push, 'src/other.ts', 7)).toEqual({ path: 'src/other.ts', line: 7, how: 'mapped' });
    expect(mapLine('', 'src/x.ts', 7)).toEqual({ path: 'src/x.ts', line: 7, how: 'mapped' });
    const deleted = 'diff --git a/src/x.ts b/src/x.ts\ndeleted file mode 100644\nindex 111..000\n--- a/src/x.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n';
    expect(mapLine(deleted, 'src/x.ts', 1)).toHaveProperty('gone');
  });
});

describe('a file renamed since the comment', () => {
  const renamed =
    'diff --git a/src/old.ts b/src/y.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/y.ts\nindex 111..222 100644\n--- a/src/old.ts\n+++ b/src/y.ts\n@@ -8 +8 @@\n-eight\n+EIGHT\n';
  it('maps lines to the new path instead of reporting the file deleted', () => {
    expect(mapLine(renamed, 'src/old.ts', 1)).toEqual({ path: 'src/y.ts', line: 1, how: 'mapped' });
    expect(mapLine(renamed, 'src/old.ts', 5)).toEqual({ path: 'src/y.ts', line: 5, how: 'mapped' });
    expect(mapLine(renamed, 'src/old.ts', 8)).toEqual({ path: 'src/y.ts', line: 8, how: 'nearest' });
    expect(spanChanged(renamed, 'src/old.ts', { start: 1, end: 1 })).toBeUndefined();
    expect(spanChanged(renamed, 'src/old.ts', { start: 8, end: 8 })).toBe('line 8 changed since the comment');
  });
});

describe('spanChanged', () => {
  it('reports a change under the commented lines only', () => {
    expect(spanChanged(push, 'src/x.ts', { start: 4, end: 6 })).toBe('line 5 changed since the comment');
    expect(spanChanged(push, 'src/x.ts', { start: 1, end: 3 })).toBeUndefined();
    expect(spanChanged(push, 'src/x.ts', undefined)).toBe('src/x.ts changed since the comment');
  });
});

const thread = (id: string, extra: Partial<ExistingThread> = {}): ExistingThread => ({
  id,
  path: 'src/x.ts',
  isResolved: false,
  isOutdated: false,
  originalCommit: 'old',
  comments: [{ author: 'rev', body: 'please change', createdAt: '2026-01-01T00:00:00Z', id: `${id}-c` }],
  ...extra,
  originalLine: extra.originalLine ?? extra.line,
});

// The head's view of src/x.ts: one hunk around new lines 11-13.
const h = hunk('h1', 'src/x.ts', [
  { kind: 'ctx', text: 'ten', oldLine: 10, newLine: 10 },
  { kind: 'add', text: 'new a', newLine: 11 },
  { kind: 'add', text: 'new b', newLine: 12 },
  { kind: 'ctx', text: 'eleven', oldLine: 11, newLine: 13 },
]);
const h2 = hunk('h2', 'src/y.ts', [{ kind: 'add', text: 'y', newLine: 3 }]);
// The PR's own rewrite of line 5, which the push above also touched.
const h3 = hunk('h3', 'src/x.ts', [
  { kind: 'ctx', text: 'four', oldLine: 4, newLine: 4 },
  { kind: 'add', text: 'FIVE', newLine: 5 },
  { kind: 'ctx', text: 'six', oldLine: 6, newLine: 6 },
]);
const t = tour(
  [h, h2, h3],
  [
    { id: 'c0', title: 'Y first', hunkIds: ['h2'] },
    { id: 'c1', title: 'X', hunkIds: ['h3', 'h1'] },
  ],
);
const diffs: ThreadDiffs = new Map([[threadDiffKey('old', 'src/x.ts'), push]]);

describe('placeThread', () => {
  it('places a current thread on its hunk', () => {
    expect(placeThread(thread('a', { line: 12 }), t, diffs)).toMatchObject({ hunkId: 'h1', line: 12, how: 'current' });
  });

  it('follows an outdated thread from the commit it was written on', () => {
    const p = placeThread(thread('b', { isOutdated: true, originalLine: 11 }), t, diffs);
    expect(p).toMatchObject({ hunkId: 'h1', line: 13, how: 'mapped' });
  });

  it('falls back to the comment snippet when the line left the diff or the commit is gone', () => {
    expect(placeThread(thread('c', { isOutdated: true, originalLine: 3 }), t, diffs)).toMatchObject({ how: 'snippet', line: 3 });
    const gone: ThreadDiffs = new Map([[threadDiffKey('old', 'src/x.ts'), null]]);
    expect(placeThread(thread('d', { isOutdated: true, originalLine: 11 }), t, gone).how).toBe('snippet');
  });

  it('treats a thread on the whole file as a file thread', () => {
    expect(placeThread(thread('e', { subjectType: 'FILE' }), t, diffs).how).toBe('file');
  });

  it('gives the review tour the outdated thread on its new line', () => {
    const [placed] = placedThreads(t, [thread('b', { isOutdated: true, originalLine: 11 })], diffs);
    expect(threadAt([placed], 'src/x.ts', 13, 'RIGHT')).toHaveLength(1);
    expect(threadAt([placed], 'src/x.ts', 11, 'LEFT')).toHaveLength(0);
  });
});

describe('buildFeedback and groupFeedback', () => {
  const threads = [
    thread('nit', { line: 3, path: 'src/y.ts', comments: [{ author: 'rev', body: '**[nit]** naming', createdAt: '2026-01-01T00:00:00Z' }] }),
    thread('replied', {
      line: 11,
      comments: [
        { author: 'rev', body: 'why?', createdAt: '2026-01-01T00:00:00Z' },
        { author: 'a', body: 'because', createdAt: '2026-01-02T00:00:00Z' },
      ],
    }),
    thread('addressed', { isOutdated: true, originalLine: 5, line: undefined }),
    thread('blocking', { line: 13 }),
    thread('done', { line: 12, isResolved: true }),
    thread('file', { subjectType: 'FILE', path: 'src/z.ts' }),
  ];
  const items = buildFeedback(t, threads, { author: 'a', diffs, triage: { blocking: 'will' }, classes: { replied: 'question', nit: 'praise' } });
  const byId = Object.fromEntries(items.map((i) => [i.thread.id, i]));

  it('cycles triage through will do, done, won’t do, discuss and none', () => {
    expect(TRIAGE_CYCLE).toEqual(['will', 'done', 'wont', 'discuss', undefined]);
  });

  it('works out each thread’s state, class and triage', () => {
    expect(byId.replied).toMatchObject({ state: 'replied', cls: 'question', clsSource: 'model' });
    expect(byId.addressed).toMatchObject({ state: 'addressed', addressedReason: 'line 5 changed since the comment' });
    expect(byId.blocking).toMatchObject({ state: 'open', cls: 'change', clsSource: 'default', triage: 'will' });
    expect(byId.nit).toMatchObject({ cls: 'nit', clsSource: 'label' });
    expect(byId.done.state).toBe('resolved');
    expect(stateCounts(items)).toEqual({ open: 3, replied: 1, addressed: 1, resolved: 1 });
  });

  it('does not count a thread as addressed when a reviewer wrote after the latest commit', () => {
    const later = buildFeedback(t, [threads[2]], { author: 'a', diffs, latestCommitAt: '2025-12-01T00:00:00Z' });
    expect(later[0].state).toBe('open');
  });

  it('puts chapters with change requests first, addressed threads after the others, and hides resolved ones', () => {
    const groups = groupFeedback(items, t.chapters);
    expect(groups.map((g) => g.title)).toEqual(['X · x.ts', 'Elsewhere in the PR', 'Y first · y.ts']);
    expect(groups[0].items.map((i) => i.thread.id)).toEqual(['blocking', 'replied', 'addressed']);
    expect(groups.flatMap((g) => g.items.map((i) => i.thread.id))).not.toContain('done');
    const all = groupFeedback(items, t.chapters, { showHidden: true });
    expect(all.flatMap((g) => g.items.map((i) => i.thread.id))).toContain('done');
    expect(all[0].items.map((i) => i.thread.id).slice(-2)).toEqual(['addressed', 'done']);
  });

  it('does not call a thread addressed when only the base branch changed its lines', () => {
    // Line 2 changed between the commit and the head, but no tour hunk is there: it came in with a merge.
    const upstream = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -2 +2 @@\n-two\n+TWO\n';
    const merged: ThreadDiffs = new Map([[threadDiffKey('old', 'src/x.ts'), upstream]]);
    expect(spanChanged(upstream, 'src/x.ts', { start: 2, end: 2 })).toBeDefined();
    const [item] = buildFeedback(t, [thread('up', { isOutdated: true, originalLine: 2, line: undefined })], { author: 'a', diffs: merged });
    expect(item.state).toBe('open');
    expect(item.addressedReason).toBeUndefined();
  });

  it('calls a thread addressed when the PR rewrote its lines in a tour hunk', () => {
    const [item] = buildFeedback(t, [thread('own', { isOutdated: true, originalLine: 5, line: undefined })], { author: 'a', diffs });
    expect(item.state).toBe('addressed');
  });

  it('plans replies before resolves and leaves out threads that are gone', () => {
    const plan = sendPlan(
      items,
      [
        { threadId: 'blocking', body: ' Fixed in abc ', resolve: true, updatedAt: '' },
        { threadId: 'vanished', body: 'x', resolve: true, updatedAt: '' },
        { threadId: 'done', body: 'thanks', resolve: true, updatedAt: '' },
      ],
      ['rev'],
    );
    expect(plan.replies).toEqual([
      { threadId: 'blocking', commentId: 'blocking-c', body: 'Fixed in abc' },
      { threadId: 'done', commentId: 'done-c', body: 'thanks' },
    ]);
    expect(plan.resolves).toEqual(['blocking']);
  });

  it('checks re-request once every change request has an answer', () => {
    expect(rerequestByDefault(items, [])).toBe(false);
    const answered = items.filter((i) => i.cls === 'change' && i.state === 'open').map((i) => ({ threadId: i.thread.id, body: 'ok', resolve: false, updatedAt: '' }));
    expect(rerequestByDefault(items, answered)).toBe(true);
  });

  it('flags won’t-do threads with no reply', () => {
    const wont = buildFeedback(t, [threads[3]], { author: 'a', diffs, triage: { blocking: 'wont' } });
    expect(silentWontDo(wont, [])).toHaveLength(1);
    expect(silentWontDo(wont, [{ threadId: 'blocking', body: 'not now', resolve: false, updatedAt: '' }])).toHaveLength(0);
  });
});

describe('reviewerStatus', () => {
  const review = (author: string, state: string, at: string): ExistingReview => ({ id: 1, author, state, body: '', submittedAt: at, url: 'u' });
  it('keeps an approval through later comments and compares with the latest commit', () => {
    const s = reviewerStatus(
      [review('ann', 'APPROVED', '2026-01-01'), review('ann', 'COMMENTED', '2026-01-03'), review('bob', 'CHANGES_REQUESTED', '2026-01-02'), review('a', 'COMMENTED', '2026-01-04')],
      'a',
      '2026-01-02T12:00:00Z',
    );
    expect(s).toEqual([
      { login: 'ann', verdict: 'APPROVED', at: '2026-01-03', url: 'u', beforeLatestCommit: false },
      { login: 'bob', verdict: 'CHANGES_REQUESTED', at: '2026-01-02', url: 'u', beforeLatestCommit: true },
    ]);
    expect(rerequestCandidates([...s, { login: 'ghost', verdict: 'COMMENTED', at: '2026-01-05', url: 'u' }]).map((c) => c.login)).toEqual(['ann', 'bob']);
    expect(rerequestFirst(s)).toEqual(['bob']);
  });
});

describe('labelClass and snippetLines', () => {
  it('reads labels gr posts', () => {
    expect(labelClass('**[blocking]** fix this')).toBe('change');
    expect(labelClass('**[Question]** why')).toBe('question');
    expect(labelClass('plain')).toBeUndefined();
  });
  it('numbers a comment’s diff hunk', () => {
    expect(snippetLines('@@ -3,2 +3,2 @@\n a\n-b\n+B')).toEqual([
      { kind: 'ctx', text: 'a', oldLine: 3, newLine: 3 },
      { kind: 'del', text: 'b', oldLine: 4 },
      { kind: 'add', text: 'B', newLine: 4 },
    ]);
  });
});

describe('the conversation comment', () => {
  const review = (author: string, body: string, at: string, state = 'COMMENTED'): ExistingReview => ({ id: 1, author, state, body, submittedAt: at, url: `r:${author}` });
  it('answers other people’s review summaries and comments, newest first', () => {
    const sources = conversationSources(
      [review('ann', 'Please split this up.', '2026-10-02T00:00:00Z', 'CHANGES_REQUESTED'), review('ann', '   ', '2026-10-03T00:00:00Z'), review('dev', 'Mine.', '2026-10-04T00:00:00Z')],
      [
        { id: 7, author: 'bob', body: 'Any update?', createdAt: '2026-10-05T00:00:00Z', url: 'c:7' },
        { id: 8, author: 'dev', body: 'Working on it.', createdAt: '2026-10-06T00:00:00Z', url: 'c:8' },
      ],
      'dev',
    );
    expect(sources.map((x) => [x.kind, x.author, x.state])).toEqual([
      ['comment', 'bob', undefined],
      ['review', 'ann', 'CHANGES_REQUESTED'],
    ]);
  });

  it('quotes the first lines and mentions the author, after anything already written', () => {
    expect(quoteReply({ author: 'ann', body: 'Split this.\n\nAlso naming.' })).toBe('> Split this.\n>\n> Also naming.\n\n@ann ');
    const long = quoteReply({ author: 'bob', body: 'a\nb\nc\nd\ne\nf\ng' });
    expect(long).toBe('> a\n> b\n> c\n> d\n> e\n> f\n> …\n\n@bob ');
    expect(quoteReply({ author: 'bob', body: 'Any update?' }, '@ann Done. ')).toBe('@ann Done.\n\n> Any update?\n\n@bob ');
  });

  it('sends the queued comment with the replies, and never as a thread reply', () => {
    const plan = sendPlan([], [{ threadId: CONVERSATION, body: ' Thanks all. ', resolve: true, updatedAt: '' }], []);
    expect(plan).toEqual({ replies: [], comment: 'Thanks all.', resolves: [], rerequest: [] });
    expect(sendPlan([], [{ threadId: CONVERSATION, body: '  ', resolve: false, updatedAt: '' }], []).comment).toBeUndefined();
  });
});
