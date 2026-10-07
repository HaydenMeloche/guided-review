import { describe, expect, it } from 'vitest';
import { findIssueRefs, parsePRArg } from '../src/github/gh.js';
import { repoFromRemote } from '../src/git/git.js';

describe('parsePRArg', () => {
  it('accepts bare and hash numbers with a cwd repo', () => {
    expect(parsePRArg('1234', 'o/r')).toEqual({ repo: 'o/r', number: 1234 });
    expect(parsePRArg('#12', 'o/r')).toEqual({ repo: 'o/r', number: 12 });
  });
  it('accepts owner/name#n', () => {
    expect(parsePRArg('cli/cli#9000')).toEqual({ repo: 'cli/cli', number: 9000 });
  });
  it('accepts PR URLs with trailing paths', () => {
    expect(parsePRArg('https://github.com/a-b/c.d/pull/7/files')).toEqual({ repo: 'a-b/c.d', number: 7 });
  });
  it('rejects bare numbers outside a repo and junk', () => {
    expect(() => parsePRArg('12')).toThrow(/needs a repository/);
    expect(() => parsePRArg('nope')).toThrow(/Not a PR/);
  });
});

describe('findIssueRefs', () => {
  it('finds GitHub refs and tracker URLs', () => {
    const r = findIssueRefs('Fixes #3, closes other/repo#9. See https://linear.app/acme/issue/ENG-1/x and https://acme.atlassian.net/browse/ABC-12', 'o/r');
    expect(r.github).toEqual([
      { repo: 'o/r', number: 3 },
      { repo: 'other/repo', number: 9 },
    ]);
    expect(r.urls).toHaveLength(2);
  });
});

describe('repoFromRemote', () => {
  it('parses ssh and https remotes', () => {
    expect(repoFromRemote('git@github.com:o/r.git')).toBe('o/r');
    expect(repoFromRemote('https://github.com/o/r')).toBe('o/r');
    expect(repoFromRemote('https://gitlab.com/o/r')).toBeUndefined();
  });
});
