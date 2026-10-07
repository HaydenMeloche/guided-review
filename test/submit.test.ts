import { describe, expect, it } from 'vitest';
import { buildReviewPayload, suggestVerdict } from '../src/review/submit.js';
import type { Draft } from '../src/types.js';
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
  it('approves when all read and nothing open', () => {
    expect(suggestVerdict(t, [], { 'hash-h1': 'read', 'hash-h2': 'read' }).event).toBe('APPROVE');
  });
});
