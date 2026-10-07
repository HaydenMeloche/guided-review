import { describe, expect, it } from 'vitest';
import { age, pickerRows } from '../src/tui/PickerScreen.js';
import type { ReviewRequest } from '../src/github/gh.js';

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
    expect(rows.map((r) => (r.kind === 'repo' ? `repo:${r.repo}:${r.count}` : `#${r.pr.number}`))).toEqual(['repo:b/new:1', '#2', 'repo:a/old:2', '#1', '#3']);
    expect(items.map((p) => p.number)).toEqual([2, 1, 3]);
  });

  it('filters on repo, title, author and labels', () => {
    expect(pickerRows(prs, 'sam').items.map((p) => p.number)).toEqual([3]);
    expect(pickerRows(prs, 'risk: high').items.map((p) => p.number)).toEqual([2]);
    expect(pickerRows(prs, 'a/old#1').items.map((p) => p.number)).toEqual([1]);
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
