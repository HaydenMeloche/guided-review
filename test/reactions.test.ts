import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchThreads, setCommentReaction } from '../src/github/gh.js';
import { run } from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const mockedRun = vi.mocked(run);

beforeEach(() => mockedRun.mockReset());

describe('review comment reactions', () => {
  it('fetches per-comment counts and viewer state', async () => {
    mockedRun.mockResolvedValue(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread',
                    path: 'src/a.ts',
                    line: 5,
                    originalLine: 5,
                    isResolved: false,
                    isOutdated: false,
                    comments: {
                      nodes: [
                        {
                          id: 'comment-node',
                          fullDatabaseId: '42',
                          author: { login: 'alice' },
                          body: 'Looks good',
                          createdAt: '2026-01-01',
                          reactionGroups: [{ content: 'THUMBS_UP', reactors: { totalCount: 2 }, viewerHasReacted: true }],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const [thread] = await fetchThreads('owner/repo', 12);
    expect(thread.comments[0]).toMatchObject({ id: '42', nodeId: 'comment-node', reactionGroups: [{ content: 'THUMBS_UP', reactors: { totalCount: 2 }, viewerHasReacted: true }] });
    expect(mockedRun.mock.calls[0][1].join(' ')).toContain('reactionGroups');
  });

  it('adds and removes a reaction using the comment node ID', async () => {
    mockedRun.mockResolvedValue(JSON.stringify({ data: { addReaction: { reactionGroups: [] }, removeReaction: { reactionGroups: [] } } }));
    await setCommentReaction('comment-node', 'HEART', false);
    await setCommentReaction('comment-node', 'HEART', true);
    const add = mockedRun.mock.calls[0][1].join(' ');
    const remove = mockedRun.mock.calls[1][1].join(' ');
    expect(add).toContain('addReaction');
    expect(remove).toContain('removeReaction');
    expect(add).toContain('subject=comment-node');
    expect(add).toContain('content=HEART');
  });
});
