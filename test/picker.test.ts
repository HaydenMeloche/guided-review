import { describe, expect, it } from 'vitest';
import { age, authorBadges, needsAuthor, pickerRows } from '../src/tui/PickerScreen.js';
import type { AuthoredPR, ReviewRequest } from '../src/github/gh.js';

const pr = (repo: string, number: number, updatedAt: string, extra: Partial<ReviewRequest> = {}): ReviewRequest => ({
  repo,
  number,
  title: `PR ${number}`,
  author: 'dev',
  url: `https://github.com/${repo}/pull/${number}`,
  updatedAt,
  isDraft: false,
  labels: [],
  ...extra,
});

describe('pickerRows', () => {
  const prs = [pr('a/old', 1, '2026-09-01T00:00:00Z'), pr('b/new', 2, '2026-10-06T00:00:00Z', { labels: ['Risk: High'] }), pr('a/old', 3, '2026-08-01T00:00:00Z', { author: 'sam' })];

  it('groups by repo, most recently active repo first, items in display order', () => {
    const { rows, items } = pickerRows(prs, '');
    expect(rows.map((r) => (r.kind === 'repo' ? `repo:${r.repo}:${r.count}` : r.kind === 'pr' ? `#${r.pr.number}` : r.kind === 'section' ? `${r.title}:${r.count}` : r.text))).toEqual([
      'Review requests:3',
      'repo:b/new:1',
      '#2',
      'repo:a/old:2',
      '#1',
      '#3',
    ]);
    expect(items.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it('filters on repo, title, author and labels', () => {
    expect(pickerRows(prs, 'sam').items.map((p) => p.number)).toEqual([3]);
    expect(pickerRows(prs, 'risk: high').items.map((p) => p.number)).toEqual([2]);
    expect(pickerRows(prs, 'a/old#1').items.map((p) => p.number)).toEqual([1]);
  });
});

describe('the Review requests heading', () => {
  it('is there with no review requests, saying so, above your PRs', () => {
    const mineOnly = { ...pr('me/app', 9, '2026-10-01T00:00:00Z'), openThreads: 1, unresolvedThreads: 1, reviewDecision: '', mergeStateStatus: '', newReview: false, noReviewers: false, checks: '' };
    const { rows } = pickerRows([], '', [mineOnly]);
    expect(rows.slice(0, 3).map((r) => (r.kind === 'section' ? r.title : r.kind === 'note' ? 'note' : r.kind))).toEqual(['Review requests', 'note', 'Your PRs']);
    expect(pickerRows([], '').rows.map((r) => r.kind)).toEqual(['section', 'note']);
  });
});

describe('your PRs', () => {
  const mine = (number: number, extra: Partial<AuthoredPR> = {}): AuthoredPR => ({
    ...pr('me/app', number, '2026-10-01T00:00:00Z', { author: 'me' }),
    openThreads: 0,
    unresolvedThreads: 0,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'BLOCKED',
    newReview: false,
    noReviewers: false,
    checks: 'SUCCESS',
    ...extra,
  });

  it('list one nobody was asked to review, saying so', () => {
    const lonely = mine(8, { noReviewers: true });
    expect(needsAuthor(lonely)).toBe(true);
    expect(authorBadges(lonely)).toEqual([{ text: 'no reviewers requested', color: 'yellow' }]);
    expect(authorBadges(mine(9, { noReviewers: true, mergeStateStatus: 'CLEAN', reviewDecision: '' }))).toEqual([{ text: '✓ ready to merge', color: 'green', bold: true }]);
  });

  it('count the ones waiting on reviewers, and w shows them', () => {
    const waiting = [mine(1), mine(2)];
    const needs = mine(3, { unresolvedThreads: 1 });
    const hidden = pickerRows([], '', [...waiting, needs]);
    expect(hidden.items.map((p) => p.number)).toEqual([3]);
    expect(hidden.rows.at(-1)).toEqual({ kind: 'note', text: '2 more are waiting on reviewers · w shows them' });
    const shown = pickerRows([], '', [...waiting, needs], true);
    expect(shown.items.map((p) => p.number).sort()).toEqual([1, 2, 3]);
    expect(shown.rows.at(-1)).toEqual({ kind: 'note', text: '2 are waiting on reviewers · w hides them' });
    expect(authorBadges(mine(1))).toEqual([{ text: 'waiting on review' }]);
    // None needing you still heads the section, so the count has somewhere to go.
    const only = pickerRows([], '', [mine(1)]);
    expect(only.rows.slice(-2)).toEqual([
      { kind: 'section', title: 'Your PRs', count: 0 },
      { kind: 'note', text: 'None need you. 1 more is waiting on reviewers · w shows them' },
    ]);
  });

  it('say when only the first of many are listed, and when the thread counts are lower bounds', () => {
    expect(pickerRows([], '', [mine(1, { unresolvedThreads: 1 })], false, true).rows.at(-1)).toEqual({ kind: 'note', text: 'Showing the first 200 of your open PRs.' });
    expect(JSON.stringify(pickerRows([], '', [mine(1, { unresolvedThreads: 1 })]).rows)).not.toContain('first 200');
    expect(authorBadges(mine(2, { unresolvedThreads: 100, unresolvedThreadsAtLeast: true }))[0]).toEqual({ text: '100+ unresolved' });
    expect(authorBadges(mine(3, { unresolvedThreads: 100, openThreads: 100, unresolvedThreadsAtLeast: true }))[0]).toEqual({ text: '100+ open thread(s)', color: 'yellow' });
  });

  it('get their own section after the review requests', () => {
    const { rows, items } = pickerRows([pr('a/b', 1, '2026-10-01T00:00:00Z')], '', [mine(9, { openThreads: 2, unresolvedThreads: 2 })]);
    expect(rows.map((r) => (r.kind === 'section' ? `${r.title}:${r.count}` : r.kind === 'repo' ? `repo:${r.repo}` : r.kind === 'pr' ? `#${r.pr.number}` : r.text))).toEqual([
      'Review requests:1',
      'repo:a/b',
      '#1',
      'Your PRs:1',
      'repo:me/app',
      '#9',
    ]);
    expect(items.map((p) => p.number)).toEqual([1, 9]);
  });

  it('color what stands out: approved and ready to merge in green, changes requested in red', () => {
    expect(authorBadges(mine(1, { reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', openThreads: 1, unresolvedThreads: 1 }))).toEqual([
      { text: '1 open thread(s)', color: 'yellow' },
      { text: 'approved', color: 'green' },
      { text: '✓ ready to merge', color: 'green', bold: true },
    ]);
    expect(authorBadges(mine(2, { reviewDecision: 'CHANGES_REQUESTED' }))).toEqual([{ text: 'changes requested', color: 'red' }]);
  });

  it('say when checks fail or are still running', () => {
    expect(authorBadges(mine(3, { checks: 'FAILURE' }))).toEqual([{ text: '✗ checks failing', color: 'red' }, { text: 'waiting on review' }]);
    expect(authorBadges(mine(4, { checks: 'PENDING', unresolvedThreads: 1 }))).toEqual([{ text: '1 unresolved' }, { text: '● checks running', color: 'yellow' }]);
    expect(authorBadges(mine(5, { checks: 'SUCCESS' }))).toEqual([{ text: 'waiting on review' }]);
    // Failing checks alone don't list a PR: only feedback or a merge waiting on you does.
    expect(needsAuthor(mine(6, { checks: 'ERROR' }))).toBe(false);
  });

  it('list only the ones that need you', () => {
    expect(needsAuthor(mine(1))).toBe(false);
    expect(needsAuthor(mine(2, { unresolvedThreads: 1 }))).toBe(true);
    expect(needsAuthor(mine(3, { newReview: true }))).toBe(true);
    expect(needsAuthor(mine(4, { reviewDecision: 'CHANGES_REQUESTED' }))).toBe(true);
    expect(needsAuthor(mine(5, { mergeStateStatus: 'CLEAN' }))).toBe(true);
    expect(needsAuthor(mine(6, { mergeStateStatus: 'CLEAN', isDraft: true }))).toBe(false);
  });
});

describe('age', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  it('formats relative times', () => {
    expect(age('2026-10-07T11:57:00Z', now)).toBe('3m ago');
    expect(age('2026-10-07T07:00:00Z', now)).toBe('5h ago');
    expect(age('2026-09-23T12:00:00Z', now)).toBe('14d ago');
    expect(age('2024-08-07T12:00:00Z', now)).toBe('2y ago');
  });
});
