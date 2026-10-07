import { describe, expect, it } from 'vitest';
import { findIssueRefs, isValidRepoSlug, partitionIssueRefs } from '../src/github/gh.js';

describe('isValidRepoSlug', () => {
  it('accepts owner/name', () => {
    expect(isValidRepoSlug('acme/web-app')).toBe(true);
    expect(isValidRepoSlug('a-b/c.d_e')).toBe(true);
  });
  it('rejects traversal and junk', () => {
    for (const s of ['../x', 'acme/..', 'acme/.', 'a/b/c', 'a b/c', 'a/b?x=1', 'a_b/c', '/c', 'a/']) {
      expect(isValidRepoSlug(s)).toBe(false);
    }
  });
});

describe('partitionIssueRefs', () => {
  it('only fetches issues from the PR repo', () => {
    const refs = findIssueRefs('Fixes #3, fixes victim-org/private#12, closes Acme/Web#4', 'acme/web');
    const { fetch, linkOnly } = partitionIssueRefs(refs.github, 'acme/web');
    expect(fetch).toEqual([
      { repo: 'acme/web', number: 3 },
      { repo: 'Acme/Web', number: 4 },
    ]);
    expect(linkOnly).toEqual([{ repo: 'victim-org/private', number: 12 }]);
  });

  it('drops refs with invalid slugs entirely', () => {
    const refs = findIssueRefs('fixes ../..#1 and refs a.b/..#2', 'o/r');
    const { fetch, linkOnly } = partitionIssueRefs(refs.github, 'o/r');
    expect(fetch).toEqual([]);
    expect(linkOnly).toEqual([]);
  });
});
