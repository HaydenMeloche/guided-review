import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

import { run } from '../src/util/exec.js';
import { AUTHORED_LIMIT, fetchMergeStatus, listAuthoredPRs, PartialSendError, PendingReviewError, postThreadReplies, resetGhCaches, UncertainSendError } from '../src/github/gh.js';

const runMock = vi.mocked(run);

// Answers `gh api` calls: GraphQL by the name of the mutation or query, REST by its path.
type Handler = (args: string[], vars: Record<string, string>) => unknown;
function fakeGh(handlers: Record<string, Handler>): string[] {
  const seen: string[] = [];
  runMock.mockImplementation(async (_cmd, args) => {
    const a = args;
    const q = a.find((x) => x.startsWith('query='));
    const vars: Record<string, string> = {};
    for (let i = 0; i < a.length; i++) if ((a[i] === '-f' || a[i] === '-F') && !a[i + 1].startsWith('query=')) vars[a[i + 1].split('=')[0]] = a[i + 1].slice(a[i + 1].indexOf('=') + 1);
    const key = q
      ? (/(viewerPermission|search\(query|addPullRequestReviewThreadReply|addPullRequestReview|submitPullRequestReview|deletePullRequestReview|reviews\(states)/.exec(q)?.[1] ?? 'graphql')
      : (a.find((x) => x.startsWith('repos/')) ?? 'api');
    seen.push(key);
    const h = Object.entries(handlers).find(([k]) => key === k || (!q && key.endsWith(k)));
    if (!h) throw new Error(`unexpected call ${key}`);
    const out = h[1](a, vars);
    return typeof out === 'string' ? out : JSON.stringify({ data: out });
  });
  return seen;
}

const pending = (viewerDidAuthor: boolean) => () => ({ repository: { pullRequest: { id: 'PR1', reviews: { nodes: viewerDidAuthor ? [{ id: 'R0', viewerDidAuthor: true }] : [] } } } });
const replies = [
  { threadId: 'T1', commentId: '11', body: 'one' },
  { threadId: 'T2', commentId: '12', body: 'two' },
  { threadId: 'T3', commentId: '13', body: 'three' },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetGhCaches();
});

describe('postThreadReplies', () => {
  it('batches the replies into one submitted review', async () => {
    const seen = fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => ({ addPullRequestReview: { pullRequestReview: { id: 'R1' } } }),
      addPullRequestReviewThreadReply: () => ({ addPullRequestReviewThreadReply: { comment: { id: 'c' } } }),
      submitPullRequestReview: () => ({ submitPullRequestReview: { pullRequestReview: { url: 'https://x/review' } } }),
    });
    expect(await postThreadReplies('o/r', 4, 'abc', replies)).toEqual({ batched: true, url: 'https://x/review' });
    expect(seen.filter((k) => k === 'addPullRequestReviewThreadReply')).toHaveLength(3);
  });

  it('posts nothing while the viewer has a pending review, and says what to do', async () => {
    // GitHub refuses a REST reply then (422: one pending review per user) and parks a GraphQL
    // reply in the pending review unposted, as checked live.
    const seen = fakeGh({ 'reviews(states': pending(true) });
    await expect(postThreadReplies('o/r', 4, 'abc', replies)).rejects.toBeInstanceOf(PendingReviewError);
    await expect(postThreadReplies('o/r', 4, 'abc', replies)).rejects.toThrow('submit or discard it there');
    expect(seen).toEqual(['reviews(states', 'reviews(states']);
  });

  it('names the threads that posted when a one-by-one send fails partway', async () => {
    // Batching fails at the first step, so the replies go one by one.
    fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => {
        throw new Error('no review');
      },
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => {
        throw new Error('HTTP 502');
      },
    });
    const err = await postThreadReplies('o/r', 4, 'abc', replies).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSendError);
    expect((err as PartialSendError).posted).toEqual(['T1']);
    expect((err as Error).message).toBe('HTTP 502');
  });

  it('deletes the pending review and falls back to one by one when batching fails', async () => {
    let n = 0;
    const seen = fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => ({ addPullRequestReview: { pullRequestReview: { id: 'R1' } } }),
      addPullRequestReviewThreadReply: () => {
        if (++n === 2) throw new Error('Could not resolve to a node');
        return { addPullRequestReviewThreadReply: { comment: { id: 'c' } } };
      },
      deletePullRequestReview: () => ({ deletePullRequestReview: { clientMutationId: null } }),
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => '{}',
      'comments/13/replies': () => '{}',
    });
    const r = await postThreadReplies('o/r', 4, 'abc', replies);
    expect(r).toEqual({ batched: false, fallbackReason: 'Could not resolve to a node' });
    expect(seen).toContain('deletePullRequestReview');
    expect(seen.filter((k) => k.endsWith('/replies'))).toHaveLength(3);
  });

  it('does not post again when the submit step fails and the review is no longer pending', async () => {
    const seen = fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => ({ addPullRequestReview: { pullRequestReview: { id: 'R1' } } }),
      addPullRequestReviewThreadReply: () => ({ addPullRequestReviewThreadReply: { comment: { id: 'c' } } }),
      submitPullRequestReview: () => {
        throw new Error('socket hang up');
      },
      // Not pending any more, so it was submitted: the delete is refused.
      deletePullRequestReview: () => {
        throw new Error('Could not resolve to a node');
      },
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => '{}',
      'comments/13/replies': () => '{}',
    });
    const err = await postThreadReplies('o/r', 4, 'abc', replies).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UncertainSendError);
    expect((err as Error).message).toContain('socket hang up');
    expect(seen.filter((k) => k.endsWith('/replies'))).toHaveLength(0);
  });

  it('falls back when the submit step fails and the pending review could still be deleted', async () => {
    const seen = fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => ({ addPullRequestReview: { pullRequestReview: { id: 'R1' } } }),
      addPullRequestReviewThreadReply: () => ({ addPullRequestReviewThreadReply: { comment: { id: 'c' } } }),
      submitPullRequestReview: () => {
        throw new Error('HTTP 502');
      },
      deletePullRequestReview: () => ({ deletePullRequestReview: { clientMutationId: null } }),
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => '{}',
      'comments/13/replies': () => '{}',
    });
    expect((await postThreadReplies('o/r', 4, 'abc', replies)).fallbackReason).toBe('HTTP 502');
    expect(seen.filter((k) => k.endsWith('/replies'))).toHaveLength(3);
  });

  it('falls back when the review cannot be created or submitted', async () => {
    fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => {
        throw new Error('nope');
      },
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => '{}',
      'comments/13/replies': () => '{}',
    });
    expect((await postThreadReplies('o/r', 4, 'abc', replies)).fallbackReason).toBe('nope');
  });

  it('reports a failure of the fallback as a partial send', async () => {
    fakeGh({
      'reviews(states': pending(false),
      addPullRequestReview: () => {
        throw new Error('nope');
      },
      'comments/11/replies': () => '{}',
      'comments/12/replies': () => {
        throw new Error('HTTP 500');
      },
    });
    const err = await postThreadReplies('o/r', 4, 'abc', replies).catch((e: unknown) => e);
    expect((err as PartialSendError).posted).toEqual(['T1']);
  });
});

describe('listAuthoredPRs', () => {
  const node = (n: number) => ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    updatedAt: '2026-10-01T00:00:00Z',
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    author: { login: 'me' },
    repository: { nameWithOwner: 'o/r', owner: { login: 'o' } },
    labels: { nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    latestReviews: { nodes: [] },
    reviewRequests: { totalCount: 0 },
    commits: { nodes: [] },
  });
  const page = (from: number, count: number, hasNextPage: boolean) => ({
    viewer: { login: 'me' },
    search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor${from + count}` : null }, nodes: Array.from({ length: count }, (_, i) => node(from + i)) },
  });

  it('reads every page up to the limit, passing the cursor along', async () => {
    const afters: (string | undefined)[] = [];
    fakeGh({
      'search(query': (_a, vars) => {
        afters.push(vars.after);
        const from = afters.length * 50 - 49;
        return page(from, 50, afters.length < 2);
      },
    });
    const r = await listAuthoredPRs();
    expect(r.prs).toHaveLength(100);
    expect(r.truncated).toBe(false);
    expect(afters).toEqual([undefined, 'cursor51']);
  });

  it('says so when there are more than the limit', async () => {
    let n = 0;
    fakeGh({ 'search(query': () => page(++n * 50 - 49, 50, true) });
    const r = await listAuthoredPRs();
    expect(r.prs).toHaveLength(AUTHORED_LIMIT);
    expect(r.truncated).toBe(true);
    expect(n).toBe(AUTHORED_LIMIT / 50);
  });

  it('marks thread counts as lower bounds when a PR has more threads than were read', async () => {
    const big = node(1);
    big.reviewThreads = { pageInfo: { hasNextPage: true }, nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'ann' } }] } }] } as never;
    fakeGh({ 'search(query': () => ({ viewer: { login: 'me' }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [big, node(2)] } }) });
    const { prs } = await listAuthoredPRs();
    expect(prs[0]).toMatchObject({ unresolvedThreads: 1, openThreads: 1, unresolvedThreadsAtLeast: true });
    expect(prs[1]).not.toHaveProperty('unresolvedThreadsAtLeast');
  });
});

describe('listAuthoredPRs noReviewers', () => {
  const base = {
    number: 1,
    title: 't',
    url: 'u',
    updatedAt: '2026-10-01T00:00:00Z',
    isDraft: false,
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    author: { login: 'me' },
    labels: { nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    latestReviews: { nodes: [] },
    reviewRequests: { totalCount: 0 },
    commits: { nodes: [] },
  };
  const run1 = async (owner: string, extra: object = {}) => {
    fakeGh({
      'search(query': () => ({
        viewer: { login: 'Me' },
        search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...base, repository: { nameWithOwner: `${owner}/r`, owner: { login: owner } }, ...extra }] },
      }),
    });
    return (await listAuthoredPRs()).prs[0];
  };

  it('flags a PR nobody was asked to review in a repository you do not own', async () => {
    expect((await run1('acme')).noReviewers).toBe(true);
  });
  it('stays quiet in your own repository, whatever the case of your login', async () => {
    expect((await run1('me')).noReviewers).toBe(false);
  });
  it('stays quiet for drafts, requested reviewers and existing reviews', async () => {
    expect((await run1('acme', { isDraft: true })).noReviewers).toBe(false);
    expect((await run1('acme', { reviewRequests: { totalCount: 1 } })).noReviewers).toBe(false);
    expect((await run1('acme', { latestReviews: { nodes: [{ author: { login: 'ann' }, submittedAt: '2026-10-02T00:00:00Z' }] } })).noReviewers).toBe(false);
  });
});

describe('listAuthoredPRs mapping', () => {
  it('counts open threads (a reviewer has the last word) apart from unresolved ones, and finds new reviews and checks', async () => {
    const thread = (resolved: boolean, last: string) => ({ isResolved: resolved, comments: { nodes: [{ author: { login: last } }] } });
    const node = {
      number: 7,
      title: 'Mine',
      url: 'https://github.com/acme/app/pull/7',
      updatedAt: '2026-10-05T00:00:00Z',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'BLOCKED',
      author: null,
      repository: { nameWithOwner: 'acme/app', owner: { login: 'acme' } },
      labels: { nodes: [{ name: 'bug' }] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread(false, 'ann'), thread(false, 'me'), thread(true, 'ann')] },
      latestReviews: {
        nodes: [
          { author: { login: 'ann' }, submittedAt: '2026-10-04T12:00:00Z' },
          { author: { login: 'me' }, submittedAt: '2026-10-05T00:00:00Z' },
        ],
      },
      reviewRequests: { totalCount: 0 },
      commits: {
        nodes: [
          {
            commit: {
              committedDate: '2026-10-04T00:00:00Z',
              statusCheckRollup: { contexts: { nodes: [{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-04T00:01:00Z' }] } },
            },
          },
        ],
      },
    };
    fakeGh({ 'search(query': () => ({ viewer: { login: 'me' }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node, {}] } }) });
    const { prs } = await listAuthoredPRs();
    expect(prs).toEqual([
      {
        repo: 'acme/app',
        number: 7,
        title: 'Mine',
        author: 'me',
        url: 'https://github.com/acme/app/pull/7',
        updatedAt: '2026-10-05T00:00:00Z',
        isDraft: false,
        labels: ['bug'],
        unresolvedThreads: 2,
        openThreads: 1,
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'BLOCKED',
        noReviewers: false,
        newReview: true,
        checks: 'FAILURE',
      },
    ]);
  });

  it('does not count a review from before the latest commit, or your own, as new', async () => {
    const mk = (reviews: object[]) => ({
      number: 1,
      title: 't',
      url: 'u',
      updatedAt: '2026-10-05T00:00:00Z',
      isDraft: false,
      reviewDecision: null,
      mergeStateStatus: 'CLEAN',
      author: { login: 'me' },
      repository: { nameWithOwner: 'me/app', owner: { login: 'me' } },
      labels: { nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      latestReviews: { nodes: reviews },
      reviewRequests: { totalCount: 1 },
      commits: { nodes: [{ commit: { committedDate: '2026-10-04T00:00:00Z', statusCheckRollup: null } }] },
    });
    fakeGh({
      'search(query': () => ({
        viewer: { login: 'me' },
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [mk([{ author: { login: 'ann' }, submittedAt: '2026-10-03T00:00:00Z' }]), mk([{ author: { login: 'me' }, submittedAt: '2026-10-05T00:00:00Z' }])],
        },
      }),
    });
    const { prs } = await listAuthoredPRs();
    expect(prs.map((p) => p.newReview)).toEqual([false, false]);
    expect(prs[0].checks).toBe('');
  });
});

describe('fetchMergeStatus', () => {
  const raw = (over: { repo?: object; pr?: object } = {}) => ({
    repository: {
      viewerPermission: 'WRITE',
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
      deleteBranchOnMerge: true,
      pullRequest: {
        id: 'PR_1',
        title: 'Retry',
        state: 'OPEN',
        isDraft: false,
        viewerCanUpdate: true,
        viewerCanUpdateBranch: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        headRefOid: 'abc123',
        headRefName: 'retries',
        baseRefName: 'main',
        headRepository: { nameWithOwner: 'o/r' },
        commits: { totalCount: 3 },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
        last: {
          nodes: [{ commit: { committedDate: '2026-10-04T00:00:00Z', statusCheckRollup: { contexts: { nodes: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true }] } } } }],
        },
        ...over.pr,
      },
      ...over.repo,
    },
  });

  it('maps the PR, the merge methods in order, and who may merge', async () => {
    fakeGh({ viewerPermission: () => raw() });
    const s = await fetchMergeStatus('o/r', 4);
    expect(s).toMatchObject({
      id: 'PR_1',
      repo: 'o/r',
      number: 4,
      state: 'OPEN',
      reviewDecision: '',
      headSha: 'abc123',
      headRef: 'retries',
      baseRef: 'main',
      headRepo: 'o/r',
      methods: ['merge', 'squash'],
      viewerCanMerge: true,
      deleteBranchOnMerge: true,
      unresolvedThreads: 2,
      commitCount: 3,
      headCommittedAt: '2026-10-04T00:00:00Z',
      checks: { passed: 1, failed: 0, pending: 0 },
    });
    expect(s).not.toHaveProperty('unresolvedThreadsAtLeast');
  });

  it('refuses read-only viewers, lists all three methods in merge, squash, rebase order, and marks a capped thread count', async () => {
    fakeGh({
      viewerPermission: () =>
        raw({
          repo: { viewerPermission: 'READ', rebaseMergeAllowed: true },
          pr: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [{ isResolved: false }] }, headRepository: null, last: { nodes: [] } },
        }),
    });
    const s = await fetchMergeStatus('o/r', 4);
    expect(s.viewerCanMerge).toBe(false);
    expect(s.methods).toEqual(['merge', 'squash', 'rebase']);
    expect(s).toMatchObject({ unresolvedThreads: 1, unresolvedThreadsAtLeast: true, headRepo: undefined, headCommittedAt: undefined });
  });
});
