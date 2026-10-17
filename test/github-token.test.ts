import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

import { run } from '../src/util/exec.js';
import { loadGitHubConfig, loadUserConfig, UserConfigError } from '../src/config.js';
import { gitAuthEnv, githubWebHost, readGitHubToken } from '../src/github/auth.js';
import { repoFromRemote } from '../src/git/git.js';
import { restPages } from '../src/github/api.js';
import { currentBranchPR, currentRepo, fetchDiff, fetchPR, parsePRArg, fetchPRPreview, ghHttpStatus, listReviewRequests, resetGhCaches, viewerLogin } from '../src/github/gh.js';
import { postSharedTour } from '../src/github/sharedTour.js';

const runMock = vi.mocked(run);
const fetchMock = vi.fn<typeof fetch>();
const originalHome = process.env.GR_HOME;
const roots: string[] = [];

function writeConfig(github: unknown): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-gh-token-'));
  roots.push(root);
  process.env.GR_HOME = root;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ provider: 'openai', github }));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });
}

const call = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i];
  return { url: url as string, method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined };
};

beforeEach(() => {
  runMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.GR_TEST_GH_TOKEN = 'ghp_test';
  resetGhCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GR_TEST_GH_TOKEN;
  process.env.GR_HOME = originalHome;
  resetGhCaches();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('github config', () => {
  it('reads tokenEnv, tokenFile and apiUrl', () => {
    writeConfig({ tokenEnv: '$GR_TEST_GH_TOKEN', apiUrl: 'https://ghe.example.com/api/v3/' });
    expect(loadGitHubConfig()).toEqual({ tokenEnv: 'GR_TEST_GH_TOKEN', apiUrl: 'https://ghe.example.com/api/v3' });
    expect(loadUserConfig().github).toEqual({ tokenEnv: 'GR_TEST_GH_TOKEN', apiUrl: 'https://ghe.example.com/api/v3' });
  });

  it('rejects a github section without a token source or with an http apiUrl', () => {
    writeConfig({});
    expect(() => loadGitHubConfig()).toThrow(UserConfigError);
    writeConfig({ tokenEnv: 'X', apiUrl: 'http://ghe.example.com/api/v3' });
    expect(() => loadGitHubConfig()).toThrow(/must use https/);
  });

  it('is undefined (use gh) without a github section', () => {
    writeConfig(undefined);
    expect(loadGitHubConfig()).toBeUndefined();
  });

  it('reads a token from a file and explains a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-token-file-'));
    roots.push(dir);
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, 'ghp_file\n');
    expect(readGitHubToken({ tokenFile: file })).toBe('ghp_file');
    expect(() => readGitHubToken({ tokenFile: path.join(dir, 'missing') })).toThrow(/could not read the GitHub token file/);
    expect(() => readGitHubToken({ tokenEnv: 'GR_TEST_UNSET_VAR' })).toThrow(/\$GR_TEST_UNSET_VAR is not set/);
  });
});

describe('with a token', () => {
  beforeEach(() => writeConfig({ tokenEnv: 'GR_TEST_GH_TOKEN' }));

  it('calls api.github.com instead of gh', async () => {
    fetchMock.mockResolvedValueOnce(new Response('diff --git a/x b/x\n'));
    expect(await fetchDiff('o/r', 7)).toBe('diff --git a/x b/x\n');
    expect(runMock).not.toHaveBeenCalled();
    const { url, headers } = call(0);
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(headers.Authorization).toBe('Bearer ghp_test');
    expect(headers.Accept).toBe('application/vnd.github.v3.diff');
  });

  it('sends GraphQL to /api/graphql on GitHub Enterprise Server', async () => {
    writeConfig({ tokenEnv: 'GR_TEST_GH_TOKEN', apiUrl: 'https://ghe.example.com/api/v3' });
    resetGhCaches();
    fetchMock.mockResolvedValueOnce(
      json({
        data: {
          repository: {
            pullRequest: {
              headRefName: 'f',
              baseRefName: 'main',
              headRefOid: 'abc',
              additions: 1,
              deletions: 2,
              changedFiles: 1,
              isDraft: false,
              reviewDecision: null,
              mergeable: 'MERGEABLE',
              body: 'b',
              labels: { nodes: [{ name: 'bug' }] },
              files: { nodes: [{ path: 'x', additions: 1, deletions: 2 }] },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
                            { context: 'lint', state: 'SUCCESS' },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const preview = await fetchPRPreview('o/r', 7);
    expect(call(0).url).toBe('https://ghe.example.com/api/graphql');
    expect(preview).toMatchObject({ headSha: 'abc', reviewDecision: '', labels: ['bug'], checks: { passed: 1, failed: 1, pending: 0, failedNames: ['ci'] } });
  });

  it('lists review requests through the search API', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (!(input as string).includes('/search/issues')) return json({ message: 'Not Found' }, { status: 404 });
      return json({
        items: [
          {
            number: 1,
            title: 'old',
            html_url: 'u1',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'a' },
            repository_url: 'https://api.github.com/repos/o/r',
            draft: true,
            labels: [{ name: 'x' }],
          },
          { number: 2, title: 'new', html_url: 'u2', updated_at: '2026-02-01T00:00:00Z', user: null, repository_url: 'https://api.github.com/repos/o/s' },
        ],
      });
    });
    const rows = await listReviewRequests();
    expect(fetchMock.mock.calls.some(([u]) => decodeURIComponent(u as string).includes('review-requested:@me'))).toBe(true);
    expect(rows.map((r) => [r.repo, r.number, r.author, r.isDraft])).toEqual([
      ['o/s', 2, 'ghost', false],
      ['o/r', 1, 'a', true],
    ]);
  });

  it('adds team requests a teammate already reviewed, from the notifications inbox', async () => {
    const searchItem = { number: 1, title: 'asked', html_url: 'u1', updated_at: '2026-10-01T00:00:00Z', user: { login: 'a' }, repository_url: 'https://api.github.com/repos/o/r' };
    const thread = (n: number) => ({ subject: { type: 'PullRequest', url: `https://api.github.com/repos/o/r/pulls/${n}` } });
    const requested = (team: string) => ({ __typename: 'ReviewRequestedEvent', createdAt: '2026-10-02T00:00:00Z', requestedReviewer: { __typename: 'Team', combinedSlug: team } });
    const pr = (number: number, state: string, nodes: unknown[]) => ({
      pullRequest: {
        number,
        title: `pr ${number}`,
        url: `u${number}`,
        updatedAt: `2026-10-0${number}T00:00:00Z`,
        isDraft: false,
        state,
        author: { login: 'b' },
        labels: { nodes: [] },
        timelineItems: { nodes },
      },
    });
    const review = { __typename: 'PullRequestReview', submittedAt: '2026-10-03T00:00:00Z', state: 'APPROVED', author: { login: 'alice' } };
    const prs: Record<number, ReturnType<typeof pr>> = {
      1: pr(1, 'OPEN', [requested('o/backend')]),
      2: pr(2, 'OPEN', [requested('o/backend'), review]),
      3: pr(3, 'MERGED', [requested('o/backend'), review]),
      4: pr(4, 'OPEN', [requested('o/frontend'), review]),
    };
    const queried: number[][] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = decodeURIComponent(input as string);
      if (url.includes('/search/issues')) return json({ items: [searchItem] });
      if (url.includes('/notifications?all=true')) return json([thread(1), thread(2), thread(3), thread(4), thread(2), { subject: { type: 'Issue', url: 'x' } }]);
      if (url.includes('/user/teams')) return json([{ slug: 'backend', organization: { login: 'o' } }]);
      if (url.endsWith('/user')) return json({ login: 'me' });
      if (url.endsWith('/graphql')) {
        const { query } = JSON.parse(init?.body as string) as { query: string };
        const numbers = [...query.matchAll(/(p\d+): repository\(.*?pullRequest\(number: (\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
        queried.push(numbers.map(([, n]) => n));
        return json({ data: Object.fromEntries(numbers.map(([alias, n]) => [alias, prs[n]])) });
      }
      throw new Error(`unexpected ${url}`);
    });
    const early: number[] = [];
    const rows = await listReviewRequests((p) => early.push(...p.map((r) => r.number)));
    expect(early).toEqual([1]);
    expect(rows.map((r) => [r.number, r.team, r.reviewedBy])).toEqual([
      [2, 'o/backend', ['alice']],
      [1, 'o/backend', []],
    ]);
    // States first for the inbox's PRs, then timelines only for the open ones.
    expect(queried).toEqual([
      [2, 3, 4],
      [1, 2, 4],
    ]);
    const notifications = fetchMock.mock.calls.map(([u]) => decodeURIComponent(u as string)).find((u) => u.includes('/notifications'));
    expect(notifications).toMatch(/since=\d{4}-\d\d-\d\dT/);
  });

  it('lists only the search results when notifications are off limits', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = input as string;
      if (url.includes('/search/issues'))
        return json({ items: [{ number: 1, title: 't', html_url: 'u1', updated_at: '2026-10-01T00:00:00Z', user: { login: 'a' }, repository_url: 'https://api.github.com/repos/o/r' }] });
      if (url.includes('/notifications')) return json({ message: 'Resource not accessible by personal access token' }, { status: 403 });
      if (url.includes('/user/teams')) return json({ message: 'nope' }, { status: 403 });
      if (url.endsWith('/user')) return json({ login: 'me' });
      if (url.endsWith('/graphql')) return json({ data: { p0: null } });
      throw new Error(`unexpected ${url}`);
    });
    expect((await listReviewRequests()).map((r) => [r.number, r.team])).toEqual([[1, undefined]]);
  });

  it('finds the current branch PR by its pushed branch, preferring an open one', async () => {
    runMock.mockImplementation(async (_cmd, args) => {
      const a = args.join(' ');
      if (a.startsWith('config --get-regexp')) return 'remote.origin.url git@github.com:o/r.git\n';
      if (a.startsWith('symbolic-ref')) return 'feature\n';
      if (a === 'config --get branch.feature.remote') return 'fork\n';
      if (a === 'config --get branch.feature.merge') return 'refs/heads/remote-feature\n';
      if (a === 'remote get-url fork') return 'https://github.com/me/r.git\n';
      throw new Error(`unexpected git ${a}`);
    });
    fetchMock.mockResolvedValueOnce(
      json([
        { number: 3, state: 'closed' },
        { number: 4, state: 'open' },
      ]),
    );
    expect(await currentBranchPR('/repo')).toEqual({ repo: 'o/r', number: 4 });
    expect(decodeURIComponent(call(0).url)).toBe('https://api.github.com/repos/o/r/pulls?head=me:remote-feature&state=all&per_page=30');
    expect(runMock.mock.calls.every(([cmd]) => cmd === 'git')).toBe(true);
  });

  it('caches the viewer login', async () => {
    fetchMock.mockResolvedValue(json({ login: 'me' }));
    expect(await viewerLogin()).toBe('me');
    expect(await viewerLogin()).toBe('me');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the HTTP status of a failed request', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Bad credentials' }, { status: 401 }));
    const error = await fetchDiff('o/r', 7).catch((e: unknown) => e);
    expect(ghHttpStatus(error)).toBe(401);
    expect((error as Error).message).toMatch(/Bad credentials.*token was rejected/);
  });

  it('replaces the shared tour comment, posting a new one when the old is not ours', async () => {
    const marker = '<!-- guided-review:tour head=abc -->';
    fetchMock
      .mockResolvedValueOnce(
        json([
          { id: 5, body: marker, user: { login: 'github-actions[bot]' } },
          { id: 6, body: 'hi', user: { login: 'x' } },
        ]),
      )
      .mockResolvedValueOnce(json({ message: 'Forbidden' }, { status: 403 }))
      .mockResolvedValueOnce(json({ html_url: 'https://github.com/o/r/pull/7#c9' }));
    expect(await postSharedTour('o/r', 7, 'body')).toBe('https://github.com/o/r/pull/7#c9');
    expect([1, 2].map((i) => [call(i).method, new URL(call(i).url).pathname])).toEqual([
      ['PATCH', '/repos/o/r/issues/comments/5'],
      ['POST', '/repos/o/r/issues/7/comments'],
    ]);
    expect(call(2).body).toEqual({ body: 'body' });
  });

  it('passes the token to git as a header for the GitHub host only', () => {
    const env = gitAuthEnv()!;
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0.replace('AUTHORIZATION: basic ', ''), 'base64').toString()).toBe('x-access-token:ghp_test');
  });
});

describe('on GitHub Enterprise Server', () => {
  beforeEach(() => {
    writeConfig({ tokenEnv: 'GR_TEST_GH_TOKEN', apiUrl: 'https://ghe.example.com/api/v3' });
    resetGhCaches();
  });

  it('reads remotes and PR URLs on the Enterprise host only', () => {
    expect(githubWebHost()).toBe('ghe.example.com');
    expect(repoFromRemote('git@ghe.example.com:o/r.git')).toBe('o/r');
    expect(repoFromRemote('https://ghe.example.com/o/r')).toBe('o/r');
    expect(repoFromRemote('ssh://git@ghe.example.com:2222/o/r.git')).toBe('o/r');
    expect(repoFromRemote('git@github.com:o/r.git')).toBeUndefined();
    expect(repoFromRemote('https://notghe.example.com/o/r')).toBeUndefined();
    expect(parsePRArg('https://ghe.example.com/o/r/pull/12/files')).toEqual({ repo: 'o/r', number: 12 });
    expect(() => parsePRArg('https://github.com/o/r/pull/12')).toThrow(/Not a PR number or URL/);
  });

  it('finds the repo from an Enterprise remote', async () => {
    runMock.mockResolvedValueOnce('remote.origin.url git@ghe.example.com:o/r.git\n');
    expect(await currentRepo('/repo')).toBe('o/r');
  });

  it('links body issue refs on the Enterprise host and clones with the token there', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          data: {
            repository: {
              pullRequest: {
                title: 't',
                body: 'Fixes #3, refs other/repo#4',
                url: 'https://ghe.example.com/o/r/pull/7',
                author: { login: 'a' },
                baseRefName: 'main',
                headRefName: 'f',
                baseRefOid: 'b',
                headRefOid: 'h',
                commits: { nodes: [] },
                closingIssuesReferences: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(json({ title: 'Bug', body: 'x', html_url: 'https://ghe.example.com/o/r/issues/3' }));
    const pr = await fetchPR('o/r', 7);
    expect(call(1).url).toBe('https://ghe.example.com/api/v3/repos/o/r/issues/3');
    expect(pr.linkedIssues.map((i) => i.url)).toEqual(['https://ghe.example.com/o/r/issues/3', 'https://ghe.example.com/other/repo/issues/4']);
    expect(gitAuthEnv()!.GIT_CONFIG_KEY_0).toBe('http.https://ghe.example.com/.extraheader');
  });
});

describe('restPages', () => {
  const auth = { token: 't', apiUrl: 'https://api.github.com' };

  it('follows Link headers on the API host', async () => {
    fetchMock.mockResolvedValueOnce(json([1], { headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' } })).mockResolvedValueOnce(json([2]));
    expect(await restPages(auth, 'x')).toEqual([[1], [2]]);
  });

  it('never sends the token to another host', async () => {
    fetchMock.mockResolvedValueOnce(json([1], { headers: { link: '<https://evil.example.com/x?page=2>; rel="next"' } }));
    expect(await restPages(auth, 'x')).toEqual([[1]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('without a token', () => {
  it('still uses gh', async () => {
    writeConfig(undefined);
    runMock.mockResolvedValueOnce('diff');
    expect(await fetchDiff('o/r', 7)).toBe('diff');
    expect(runMock.mock.calls[0][0]).toBe('gh');
    expect(gitAuthEnv()).toBeUndefined();
  });
});
