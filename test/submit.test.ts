import { describe, expect, it } from 'vitest';
import { buildReviewPayload, suggestVerdict } from '../src/review/submit.js';
import type { CodeRef, Draft } from '../src/types.js';
import { hunk, tour } from './fixtures/tour.js';

const h1 = hunk('h1', 'src/a.ts', [
  { kind: 'ctx', text: 'a', oldLine: 10, newLine: 10 },
  { kind: 'del', text: 'b', oldLine: 11 },
  { kind: 'add', text: 'B', newLine: 11 },
  { kind: 'add', text: 'C', newLine: 12 },
]);
const h2 = hunk('h2', 'src/a.ts', [{ kind: 'add', text: 'z', newLine: 50 }]);
const t = tour([h1, h2], [{ id: 'c0', title: 'Checkout flow', hunkIds: ['h2', 'h1'], diagram: { kind: 'call', title: 'd', nodes: [{ id: 'n1', label: 'handler', hunkId: 'h1' }], edges: [] } }]);

const draft = (anchor: Draft['anchor'], extra: Partial<Draft> = {}): Draft => ({
  id: Math.random().toString(36).slice(2),
  repo: 'o/r',
  pr: 1,
  headSha: 'head',
  anchor,
  label: 'question',
  body: 'why?',
  posted: false,
  createdAt: '',
  ...extra,
});

describe('buildReviewPayload', () => {
  it('maps line and range anchors with labels and suggestions', () => {
    const { payload, moved } = buildReviewPayload(
      t,
      [
        draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' }, { label: 'blocking', suggestion: 'fixed();' }),
        draft({ type: 'range', hunkId: 'h1', file: 'src/a.ts', startLine: 10, line: 12, side: 'RIGHT' }),
      ],
      'COMMENT',
      'Summary',
    );
    expect(moved).toEqual([]);
    expect(payload.commit_id).toBe('head');
    expect(payload.comments[0]).toMatchObject({ path: 'src/a.ts', line: 11, side: 'RIGHT' });
    expect(payload.comments[0].body).toBe('**[blocking]** why?\n\n```suggestion\nfixed();\n```');
    expect(payload.comments[1]).toMatchObject({ start_line: 10, line: 12, start_side: 'RIGHT' });
  });

  it('moves lines outside the diff to the nearest diff line, or into the body', () => {
    const { payload, moved } = buildReviewPayload(
      t,
      [draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 45, side: 'RIGHT' }), draft({ type: 'line', hunkId: 'h1', file: 'src/other.ts', line: 3, side: 'RIGHT' })],
      'COMMENT',
      '',
    );
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].line).toBe(50);
    expect(moved).toHaveLength(2);
    expect(payload.body).toContain('Comments on lines outside the diff');
    expect(payload.body).toContain('src/other.ts:3');
  });

  it('posts flow and node comments to the most relevant line', () => {
    const { payload } = buildReviewPayload(
      t,
      [draft({ type: 'chapter', chapterId: 'c0' }, { label: 'nit', body: 'naming' }), draft({ type: 'node', chapterId: 'c0', nodeId: 'n1' })],
      'COMMENT',
      'Sum',
    );
    expect(payload.comments[0]).toMatchObject({ line: 50, side: 'RIGHT' });
    expect(payload.comments[0].body).toContain('_On flow: Checkout flow_');
    expect(payload.comments[1]).toMatchObject({ line: 11 });
    expect(payload.body).toMatch(/Sum\n\n### Flow-level comments\n- \*\*\[question\]\*\* "handler"/);
  });

  it('posts comments as written, without a label, when labels are off', () => {
    const { payload } = buildReviewPayload(
      t,
      [draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' }, { label: 'nit', body: 'naming' }), draft({ type: 'node', chapterId: 'c0', nodeId: 'n1' })],
      'COMMENT',
      'Sum',
      { labels: false },
    );
    expect(payload.comments[0].body).toBe('naming');
    expect(payload.body).toMatch(/### Flow-level comments\n- "handler" in flow "Checkout flow": why\?/);
    expect(JSON.stringify(payload)).not.toContain('**[');
  });
});

describe('suggestVerdict', () => {
  it('requests changes on blocking comments', () => {
    const v = suggestVerdict(t, [draft({ type: 'chapter', chapterId: 'c0' }, { label: 'blocking' })], {});
    expect(v.event).toBe('REQUEST_CHANGES');
  });
  it('comments when logic is unread', () => {
    const v = suggestVerdict(t, [], { 'hash-h1': 'read' });
    expect(v.event).toBe('COMMENT');
    expect(v.reasons[0]).toBe('1 hand-written hunk not marked read.');
  });
  it('reads nothing into a draft when comments carry no label', () => {
    const v = suggestVerdict(t, [draft({ type: 'chapter', chapterId: 'c0' }, { label: 'blocking' })], { 'hash-h1': 'read', 'hash-h2': 'read' }, false);
    expect(v).toEqual({ event: 'COMMENT', reasons: ['1 comment for the author.'] });
  });
  it('approves when all read and nothing open', () => {
    expect(suggestVerdict(t, [], { 'hash-h1': 'read', 'hash-h2': 'read' }).event).toBe('APPROVE');
  });
});

describe('buildReviewPayload with references', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const legacy = (): Draft[] => [
    draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' }, { id: 'l1', label: 'blocking', body: '  why?\n', suggestion: 'a\nb\n' }),
    draft({ type: 'range', hunkId: 'h1', file: 'src/a.ts', startLine: 10, line: 12, side: 'RIGHT' }, { id: 'l2', body: 'pasted @@ -1,2 +1,3 @@ and `@@x` and @@stray' }),
    draft({ type: 'range', hunkId: 'h1', file: 'src/a.ts', startLine: 12, line: 50, side: 'RIGHT' }, { id: 'l3', suggestion: 'x' }),
    draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 45, side: 'RIGHT' }, { id: 'l4', suggestion: 'y' }),
    draft({ type: 'chapter', chapterId: 'c0' }, { id: 'l5', label: 'nit', body: 'naming\nmore' }),
    draft({ type: 'line', hunkId: 'h1', file: 'src/other.ts', line: 3, side: 'RIGHT' }, { id: 'l6', body: 'outside\nsecond' }),
  ];

  // Captured from the builder before refs existed: drafts without refs must post exactly as they did.
  it('posts drafts without refs exactly as before', () => {
    const { payload, moved } = buildReviewPayload(t, legacy(), 'COMMENT', 'Sum');
    expect(JSON.stringify({ payload, moved }, null, 1)).toMatchInlineSnapshot(`
      "{
       "payload": {
        "commit_id": "head",
        "body": "Sum\\n\\n### Flow-level comments\\n- **[nit]** flow \\"Checkout flow\\": naming\\n\\n### Comments on lines outside the diff\\n- \`src/other.ts:3\`\\n\\n  **[question]** outside\\n  second",
        "event": "COMMENT",
        "comments": [
         {
          "path": "src/a.ts",
          "body": "**[blocking]** why?\\n\\n\`\`\`suggestion\\na\\nb\\n\`\`\`",
          "line": 11,
          "side": "RIGHT"
         },
         {
          "path": "src/a.ts",
          "body": "**[question]** pasted @@ -1,2 +1,3 @@ and \`@@x\` and @@stray",
          "line": 12,
          "side": "RIGHT",
          "start_line": 10,
          "start_side": "RIGHT"
         },
         {
          "path": "src/a.ts",
          "body": "**[question]** why?\\n\\n\`\`\`\\nx\\n\`\`\`\\n\\n_Originally on lines 12-50, which GitHub cannot take as one range._",
          "line": 50,
          "side": "RIGHT"
         },
         {
          "path": "src/a.ts",
          "body": "**[question]** why?\\n\\n\`\`\`\\ny\\n\`\`\`\\n\\n_Originally on line 45, which is no longer in the diff._",
          "line": 50,
          "side": "RIGHT"
         },
         {
          "path": "src/a.ts",
          "body": "**[nit]** naming\\nmore\\n\\n_On flow: Checkout flow_",
          "line": 50,
          "side": "RIGHT"
         }
        ]
       },
       "moved": [
        {
         "draftId": "l3",
         "note": "lines 12-50 in src/a.ts span more than one GitHub hunk; posted on line 50, with the suggestion as plain code"
        },
        {
         "draftId": "l4",
         "note": "moved from line 45 to nearest diff line 50 in src/a.ts"
        },
        {
         "draftId": "l6",
         "note": "src/other.ts has no lines in the diff; posted in the review body"
        }
       ]
      }"
    `);
  });

  const refs: CodeRef[] = [
    { id: 'r1', kind: 'symbol', path: 'src/inventory/stock.ts', commitSha: SHA, startLine: 84, endLine: 96, symbol: 'releaseInventory', label: 'releaseInventory()' },
    { id: 'r2', kind: 'range', path: 'src/jobs/retries.ts', commitSha: SHA, startLine: 60, endLine: 66, label: 'retries.ts:60-66' },
    { id: 'r3', kind: 'thread', path: 'src/cart.ts', commitSha: SHA, startLine: 17, label: 'thread:cart.ts:17', threadUrl: 'https://ghe.example.com/o/r/pull/1#discussion_r99' },
  ];
  const at = (f: string, l: string) => `https://ghe.example.com/o/r/blob/${SHA}/${f}#${l}`;

  it('links every reference inline and appends nothing after the prose, before the suggestion', () => {
    const d = draft(
      { type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' },
      {
        label: 'blocking',
        body: 'Calls `releaseInventory()`; see `retries.ts:60-66`, as in `thread:cart.ts:17`.',
        suggestion: 'fixed();',
        refs,
        suggestionMeta: { source: 'manual', headSha: 'head', originalHash: 'h' },
      },
    );
    const { payload, demoted } = buildReviewPayload(t, [d], 'COMMENT', '', { host: 'ghe.example.com' });
    expect(demoted).toEqual([]);
    expect(payload.comments[0].body).toBe(
      [
        `**[blocking]** Calls [\`releaseInventory()\`](${at('src/inventory/stock.ts', 'L84-L96')}); see [\`retries.ts:60-66\`](${at('src/jobs/retries.ts', 'L60-L66')}), as in [\`thread:cart.ts:17\`](https://ghe.example.com/o/r/pull/1#discussion_r99).`,
        '',
        '```suggestion',
        'fixed();',
        '```',
      ].join('\n'),
    );
    expect(payload.comments[0].body).not.toContain('Evidence');
  });

  it('adds nothing for refs the body does not mention', () => {
    const d = draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' }, { body: 'plain `code` and `retries.ts`', refs });
    expect(buildReviewPayload(t, [d], 'COMMENT', '').payload.comments[0].body).toBe('**[question]** plain `code` and `retries.ts`');
  });

  it('defaults to github.com and links references in flow-level summaries', () => {
    const d = draft({ type: 'chapter', chapterId: 'c0' }, { body: 'See `retries.ts:60-66`\nmore', refs });
    const { payload } = buildReviewPayload(t, [d], 'COMMENT', '');
    expect(payload.body).toContain(`: See [\`retries.ts:60-66\`](https://github.com/o/r/blob/${SHA}/src/jobs/retries.ts#L60-L66)`);
    expect(payload.comments[0].body).toBe(`**[question]** See [\`retries.ts:60-66\`](https://github.com/o/r/blob/${SHA}/src/jobs/retries.ts#L60-L66)\nmore\n\n_On flow: Checkout flow_`);
  });

  it('posts a suggestion written on an earlier head as plain code unless the caller says it still applies', () => {
    const d = draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'RIGHT' }, { suggestion: 'x', suggestionMeta: { source: 'ai', headSha: 'old', originalHash: 'h' } });
    const stale = buildReviewPayload(t, [d], 'COMMENT', '');
    expect(stale.payload.comments[0].body).toBe('**[question]** why?\n\n```\nx\n```');
    expect(stale.demoted).toEqual([{ draftId: d.id, reason: 'head-changed' }]);
    const kept = buildReviewPayload(t, [d], 'COMMENT', '', { suggestionStillApplies: () => true });
    expect(kept.payload.comments[0].body).toContain('```suggestion');
    expect(kept.demoted).toEqual([]);
  });

  it('never offers a suggestion on removed lines', () => {
    const d = draft({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'LEFT' }, { suggestion: 'x' });
    const { payload, demoted } = buildReviewPayload(t, [d], 'COMMENT', '');
    expect(payload.comments[0]).toMatchObject({ side: 'LEFT', body: '**[question]** why?\n\n```\nx\n```' });
    expect(demoted).toEqual([{ draftId: d.id, reason: 'left-side' }]);
  });
});
