import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

import { run } from '../src/util/exec.js';
import { currentBranchPR, currentRepo, fetchPR, getMentionUsers, repoFromRemotes, resetGhCaches, viewerLogin } from '../src/github/gh.js';

const runMock = vi.mocked(run);

beforeEach(() => {
  vi.clearAllMocks();
  resetGhCaches();
});

describe('viewerLogin', () => {
  it('asks gh once per process', async () => {
    runMock.mockResolvedValue('me\n');
    expect(await Promise.all([viewerLogin(), viewerLogin(new AbortController().signal)])).toEqual(['me', 'me']);
    expect(await viewerLogin()).toBe('me');
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure', async () => {
    runMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue('me\n');
    await expect(viewerLogin()).rejects.toThrow('offline');
    expect(await viewerLogin()).toBe('me');
  });
});

describe('getMentionUsers', () => {
  it('memoizes per repo', async () => {
    runMock.mockResolvedValue(JSON.stringify([[{ login: 'b' }, { login: 'a' }]]));
    expect(await getMentionUsers('o/r')).toEqual(['a', 'b']);
    expect(await getMentionUsers('O/R')).toEqual(['a', 'b']);
    expect(runMock).toHaveBeenCalledTimes(1);
    await getMentionUsers('o/other');
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});

describe('currentRepo', () => {
  it('reads the only GitHub remote without calling gh', async () => {
    runMock.mockResolvedValueOnce('remote.origin.url git@github.com:o/r.git\n');
    expect(await currentRepo('/x')).toBe('o/r');
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0]).toBe('git');
  });

  it('honors gh repo set-default', async () => {
    runMock.mockResolvedValueOnce('remote.origin.url https://github.com/me/r.git\nremote.upstream.url https://github.com/o/r.git\nremote.upstream.gh-resolved base\n');
    expect(await repoFromRemotes('/x')).toBe('o/r');
  });

  it('defers to gh for a fork with several remotes', async () => {
    runMock.mockResolvedValueOnce('remote.origin.url https://github.com/me/r.git\nremote.upstream.url https://github.com/o/r.git\n').mockResolvedValueOnce(JSON.stringify({ nameWithOwner: 'o/r' }));
    expect(await currentRepo('/x')).toBe('o/r');
    expect(runMock.mock.calls[1][0]).toBe('gh');
  });
});

describe('currentBranchPR', () => {
  const failure = (fields: { code?: number | string; stderr?: string }) => Object.assign(new Error('gh pr view failed'), { stderr: '', ...fields });

  it('reads "no PR for this branch" as undefined', async () => {
    runMock.mockRejectedValueOnce(failure({ code: 1, stderr: 'no pull requests found for branch "x"\n' }));
    expect(await currentBranchPR('/x')).toBeUndefined();
  });

  it('reports a missing or signed-out gh instead of "no PR"', async () => {
    runMock.mockRejectedValueOnce(failure({ code: 'ENOENT' }));
    await expect(currentBranchPR('/x')).rejects.toThrow('GitHub CLI (gh) is not installed');
    runMock.mockRejectedValueOnce(failure({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }));
    await expect(currentBranchPR('/x')).rejects.toThrow('gh pr view failed');
  });
});

describe('fetchPR', () => {
  it('fetches body-linked issues concurrently and keeps their order', async () => {
    const pr = {
      title: 't',
      body: 'Fixes #1, fixes #2, fixes #3',
      url: 'u',
      author: { login: 'a' },
      baseRefName: 'main',
      headRefName: 'f',
      baseRefOid: 'b',
      headRefOid: 'h',
      commits: { nodes: [] },
      closingIssuesReferences: { nodes: [] },
    };
    let inFlight = 0;
    let peak = 0;
    runMock.mockImplementation(async (_cmd, args) => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: pr } } });
      inFlight++;
      peak = Math.max(peak, inFlight);
      const n = Number(args[1].split('/').pop());
      await new Promise((r) => setTimeout(r, (4 - n) * 5)); // later issues answer first
      inFlight--;
      return JSON.stringify({ title: `issue ${n}`, body: null, html_url: `https://github.com/o/r/issues/${n}` });
    });
    const info = await fetchPR('o/r', 9);
    expect(info.linkedIssues.map((i) => i.title)).toEqual(['issue 1', 'issue 2', 'issue 3']);
    expect(peak).toBe(3);
  });
});
