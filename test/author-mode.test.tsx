import { useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { ExistingThread, Tour } from '../src/types.js';
import { CONVERSATION, buildFeedback, groupFeedback, reviewerStatus, type QueuedReply, type ThreadDiffs } from '../src/review/feedback.js';
import { FeedbackBriefing } from '../src/tui/author/FeedbackBriefing.js';
import { FeedbackScreen } from '../src/tui/author/FeedbackScreen.js';
import { SendScreen } from '../src/tui/author/SendScreen.js';
import { CommentComposer } from '../src/tui/author/CommentComposer.js';
import { AuthorMode } from '../src/tui/author/AuthorMode.js';
import { MergeScreen } from '../src/tui/MergeScreen.js';
import { mergeReadiness } from '../src/review/merge.js';
import { Store } from '../src/store/db.js';
import {
  fetchIssueComments,
  fetchMergeStatus,
  fetchPR,
  fetchReviews,
  fetchThreads,
  markReadyForReview,
  mergePR,
  updateBranch,
  PartialSendError,
  postIssueComment,
  postThreadReplies,
  requestReviewers,
  setThreadResolved,
  type MergeStatus,
} from '../src/github/gh.js';
import { loadThreadDiffs } from '../src/review/threadDiffs.js';
import { hunk, tour as makeTour } from './fixtures/tour.js';
import { waitFor } from './helpers/waitFor.js';

// Every GitHub call is a mock: nothing here reaches the network.
vi.mock('../src/github/gh.js', async (orig) => ({
  ...(await orig<typeof import('../src/github/gh.js')>()),
  fetchThreads: vi.fn(),
  fetchReviews: vi.fn(),
  fetchIssueComments: vi.fn(),
  fetchMergeStatus: vi.fn(),
  fetchPR: vi.fn(),
  viewerLogin: vi.fn(async () => 'dev'),
  getMentionUsers: vi.fn(async () => []),
  postThreadReplies: vi.fn(async () => ({ batched: true, url: 'https://example.test/review/9' })),
  postIssueComment: vi.fn(async () => ({ url: 'https://example.test/comment/5' })),
  setThreadResolved: vi.fn(async (_id: string, resolved: boolean) => resolved),
  requestReviewers: vi.fn(async () => undefined),
  fetchPendingReviewers: vi.fn(async () => ({ author: 'dev', users: ['carl'], teams: ['core'] })),
  mergePR: vi.fn(async () => ({ sha: 'merged123456' })),
  markReadyForReview: vi.fn(async () => undefined),
  updateBranch: vi.fn(async () => undefined),
  setCommentReaction: vi.fn(async () => []),
}));

vi.mock('../src/agent/feedback.js', async (orig) => ({
  ...(await orig<typeof import('../src/agent/feedback.js')>()),
  draftMergeMessage: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../src/review/threadDiffs.js', () => ({ loadThreadDiffs: vi.fn(async () => new Map()) }));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const h = hunk('h1', 'src/pay.ts', [
  { kind: 'ctx', text: 'function pay() {', oldLine: 1, newLine: 1 },
  { kind: 'add', text: '  retry(3);', newLine: 2 },
  { kind: 'ctx', text: '}', oldLine: 2, newLine: 3 },
]);
const tour: Tour = makeTour([h], [{ id: 'c0', title: 'Payment retries', hunkIds: ['h1'] }], { repo: 'acme/pay', pr: 4, title: 'Retry payments', author: 'dev', headSha: 'head1234' });

const threads: ExistingThread[] = [
  {
    id: 'T1',
    path: 'src/pay.ts',
    line: 2,
    originalLine: 2,
    originalCommit: 'head1234',
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    comments: [{ id: '11', nodeId: 'N11', author: 'ann', body: 'Why three retries?', createdAt: '2026-10-01T00:00:00Z' }],
  },
  {
    id: 'T2',
    path: 'src/pay.ts',
    line: 3,
    originalLine: 3,
    originalCommit: 'head1234',
    isResolved: false,
    isOutdated: false,
    comments: [{ id: '12', author: 'bob', body: '**[nit]** brace style', createdAt: '2026-10-01T00:00:00Z' }],
  },
];
const reviews = [{ id: 1, author: 'ann', state: 'CHANGES_REQUESTED', body: 'Please look at the retry policy.', submittedAt: '2026-10-01T00:00:00Z', url: 'u' }];
const diffs: ThreadDiffs = new Map();
const items = buildFeedback(tour, threads, { author: 'dev', diffs });

const status: MergeStatus = {
  repo: 'acme/pay',
  number: 4,
  title: 'Retry payments',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  headSha: 'head1234',
  headRef: 'retries',
  baseRef: 'main',
  headRepo: 'acme/pay',
  methods: ['merge', 'squash', 'rebase'],
  viewerCanMerge: true,
  deleteBranchOnMerge: false,
  checks: { passed: 2, failed: 0, pending: 0, failedNames: [], requiredFailed: [], requiredPending: [], items: [] },
  unresolvedThreads: 0,
  commitCount: 2,
};

const noop = () => {};

describe('FeedbackBriefing', () => {
  it('shows reviewers, merge readiness, counts and the feedback chapters', async () => {
    const onStart = vi.fn();
    const ui = render(
      <FeedbackBriefing
        tour={tour}
        items={items}
        groups={groupFeedback(items, tour.chapters)}
        reviewers={reviewerStatus(reviews, 'dev')}
        reviews={reviews}
        comments={[]}
        pending={{ author: 'dev', users: ['carl'], teams: ['core'] }}
        readiness={mergeReadiness({ ...status, reviewDecision: 'CHANGES_REQUESTED' })}
        queued={0}
        showHidden={false}
        silent={0}
        notes={[]}
        width={120}
        height={30}
        active
        onStart={onStart}
        onSend={noop}
        onToggleHidden={noop}
        onFullTour={noop}
        onRefresh={noop}
        onQuit={noop}
      />,
    );
    const frame = ui.lastFrame()!;
    expect(frame).toContain('@ann changes requested');
    expect(frame).toContain('@carl asked, waiting');
    expect(frame).toContain('@acme/core asked, waiting');
    expect(frame).toContain('Not ready: changes requested');
    expect(frame).toContain('2 open');
    expect(frame).toContain('Payment retries');
    expect(frame).toContain('1 change request');
    ui.stdin.write('n');
    await waitFor(() => expect(onStart).toHaveBeenCalledWith());
    ui.unmount();
  });
});

function ThreadHost(props: { onSave: (id: string, body: string, resolve: boolean) => void; onTriage: (t: unknown) => void; onResolve: () => Promise<void> }) {
  const [pos, setPos] = useState({ ci: 0, ii: 0 });
  const [queued, setQueued] = useState<QueuedReply[]>([]);
  return (
    <FeedbackScreen
      tour={tour}
      groups={groupFeedback(items, tour.chapters)}
      pos={pos}
      setPos={setPos}
      queued={queued}
      mentions={[]}
      wantMentions={noop}
      showHidden={false}
      width={110}
      height={30}
      active
      onTriage={(_i, t) => props.onTriage(t)}
      onSaveReply={(id, body, resolve) => {
        props.onSave(id, body, resolve);
        setQueued([{ threadId: id, body, resolve, updatedAt: '' }]);
      }}
      onResolve={props.onResolve}
      onReact={async () => {}}
      onHandoff={noop}
      onToggleHidden={noop}
      onSend={noop}
      onBriefing={noop}
      onRefresh={noop}
      onQuit={noop}
    />
  );
}

describe('FeedbackScreen', () => {
  it('shows the thread on its code, queues a reply, triages and resolves', async () => {
    const onSave = vi.fn();
    const onTriage = vi.fn();
    const onResolve = vi.fn(async () => {});
    const ui = render(<ThreadHost onSave={onSave} onTriage={onTriage} onResolve={onResolve} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Why three retries?'));
    expect(ui.lastFrame()).toContain('retry(3);');
    expect(ui.lastFrame()).toContain('change request');

    ui.stdin.write('y');
    await waitFor(() => expect(ui.lastFrame()).toContain('queued, not posted'));
    ui.stdin.write('Three matches the provider limit.');
    await tick();
    ui.stdin.write('\x12'); // ^R: resolve after sending
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('T1', 'Three matches the provider limit.', true));
    await waitFor(() => expect(ui.lastFrame()).toContain('Queued reply, then resolve'));

    ui.stdin.write(' ');
    await waitFor(() => expect(ui.lastFrame()).toContain('Triage this thread'));
    ui.stdin.write('1');
    await waitFor(() => expect(onTriage).toHaveBeenCalledWith('will'));

    ui.stdin.write('Z');
    await waitFor(() => expect(ui.lastFrame()).toContain('Resolve this thread on GitHub now?'));
    ui.stdin.write('y');
    await waitFor(() => expect(onResolve).toHaveBeenCalled());

    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain('brace style'));
    ui.unmount();
  });
});

describe('linked files', () => {
  // limits.ts: 60 numbered lines; a link's lines show with ten lines on each side.
  const file = Array.from({ length: 60 }, (_, i) => `export const L${i + 1} = ${i + 1};`).join('\n');
  const linkTo = (lines: string) => `https://github.com/acme/pay/blob/main/limits.ts#${lines}`;

  function preview(body: string, height: number, codeIndex?: Parameters<typeof FeedbackScreen>[0]['codeIndex']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-preview-'));
    fs.writeFileSync(path.join(dir, 'limits.ts'), file);
    const linked: ExistingThread = { ...threads[0], comments: [{ ...threads[0].comments[0], body }] };
    const linkedItems = buildFeedback(tour, [linked], { author: 'dev', diffs });
    function Host() {
      const [pos, setPos] = useState({ ci: 0, ii: 0 });
      return (
        <FeedbackScreen
          tour={tour}
          groups={groupFeedback(linkedItems, tour.chapters)}
          pos={pos}
          setPos={setPos}
          queued={[]}
          root={dir}
          codeIndex={codeIndex}
          mentions={[]}
          wantMentions={noop}
          showHidden={false}
          width={140}
          height={height}
          active
          onTriage={noop}
          onSaveReply={noop}
          onResolve={async () => {}}
          onReact={async () => {}}
          onHandoff={noop}
          onToggleHidden={noop}
          onSend={noop}
          onBriefing={noop}
          onRefresh={noop}
          onQuit={noop}
        />
      );
    }
    const ui = render(<Host />);
    return { ui, cleanup: () => (ui.unmount(), fs.rmSync(dir, { recursive: true, force: true })) };
  }

  it('shows a linked file beside the thread, with ten lines around the link', async () => {
    const { ui, cleanup } = preview(`See [\`limits.ts:30\`](${linkTo('L30')})`, 40);
    await waitFor(() => expect(ui.lastFrame()).toContain('export const L30 = 30;'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('limits.ts:30');
    expect(frame).toContain('shown at the PR head');
    expect(frame).toContain('L20 = 20');
    expect(frame).toContain('L40 = 40');
    expect(frame).not.toContain('L19 = 19');
    expect(frame).not.toContain('L41 = 41');
    cleanup();
  });

  it('stacks every linked file that fits, and pages through the rest with l', async () => {
    const body = [linkTo('L5'), linkTo('L30'), linkTo('L50')].join(' and ');
    const { ui, cleanup } = preview(body, 34);
    await waitFor(() => expect(ui.lastFrame()).toContain('L30 = 30'));
    let frame = ui.lastFrame()!;
    expect(frame).toContain('limits.ts:5 ');
    expect(frame).toContain('limits.ts:30');
    expect(frame).not.toContain('limits.ts:50');
    expect(frame).toContain('1 more linked file · l next');
    ui.stdin.write('l');
    await waitFor(() => expect(ui.lastFrame()).toContain('limits.ts:50'));
    frame = ui.lastFrame()!;
    expect(frame).toContain('1 above');
    expect(frame).not.toContain('limits.ts:5 ');
    cleanup();
  });
});

describe('code a thread names', () => {
  it('shows the definition of a class the comment names but does not link', async () => {
    const file = Array.from({ length: 60 }, (_, i) => (i === 29 ? 'export class RetryLimits {' : `// line ${i + 1}`)).join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-named-'));
    fs.writeFileSync(path.join(dir, 'limits.ts'), file);
    const named: ExistingThread = { ...threads[0], comments: [{ ...threads[0].comments[0], body: 'We already have RetryLimits for this: can it live there?' }] };
    const items = buildFeedback(tour, [named], { author: 'dev', diffs });
    const symbols = vi.fn(async () =>
      Object.assign([{ name: 'RetryLimits', qualified: 'RetryLimits', kind: 'class' as const, file: 'limits.ts', startLine: 30, endLine: 60, exported: true }], { truncated: false }),
    );
    const ui = render(
      <FeedbackScreen
        tour={tour}
        groups={groupFeedback(items, tour.chapters)}
        pos={{ ci: 0, ii: 0 }}
        setPos={noop}
        queued={[]}
        root={dir}
        codeIndex={{ symbols, files: async () => [] }}
        mentions={[]}
        wantMentions={noop}
        showHidden={false}
        width={140}
        height={40}
        active
        onTriage={noop}
        onSaveReply={noop}
        onResolve={async () => {}}
        onReact={async () => {}}
        onHandoff={noop}
        onToggleHidden={noop}
        onSend={noop}
        onBriefing={noop}
        onRefresh={noop}
        onQuit={noop}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('export class RetryLimits {'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain(`RetryLimits → limits.ts:30 @ ${tour.headSha.slice(0, 8)}`);
    expect(frame).toContain('line 20');
    expect(frame).toContain('line 40');
    expect(frame).not.toContain('shown at the PR head');
    expect(symbols).toHaveBeenCalledWith('RetryLimits', expect.anything());
    ui.unmount();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SendScreen', () => {
  it('posts queued replies together, then resolves and re-requests review', async () => {
    const onSent = vi.fn();
    const ui = render(
      <SendScreen
        tour={tour}
        headSha="livehead1"
        items={items}
        queued={[{ threadId: 'T1', body: 'Done.', resolve: true, updatedAt: '' }]}
        candidates={reviewerStatus([...reviews, { id: 2, author: 'cat', state: 'APPROVED', body: '', submittedAt: '2026-10-02T00:00:00Z', url: 'u' }], 'dev')}
        rerequestDefault
        silent={[]}
        width={100}
        height={24}
        onEdit={noop}
        onToggleResolve={noop}
        onDelete={noop}
        onSent={onSent}
        onBack={noop}
      />,
    );
    expect(ui.lastFrame()).toContain('src/pay.ts:2 → Done.');
    // The reviewer who asked for changes starts ticked; the approver does not.
    expect(ui.lastFrame()).toContain('[x] @ann changes requested');
    expect(ui.lastFrame()).toContain('[ ] @cat approved');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post 1 reply, resolve 1 thread, re-request 1 reviewer'));
    ui.stdin.write('y');
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    // The review is attached to the head as last read, not the tour's.
    expect(postThreadReplies).toHaveBeenCalledWith('acme/pay', 4, 'livehead1', [{ threadId: 'T1', commentId: '11', body: 'Done.' }]);
    expect(setThreadResolved).toHaveBeenCalledWith('T1', true);
    expect(requestReviewers).toHaveBeenCalledWith('acme/pay', 4, ['ann']);
    expect(onSent.mock.calls[0][1]).toEqual(['T1']);
    ui.unmount();
  });

  it('posts the queued comment on the conversation after the replies', async () => {
    const onSent = vi.fn();
    const ui = render(
      <SendScreen
        tour={tour}
        headSha="livehead1"
        items={items}
        queued={[
          { threadId: 'T1', body: 'Done.', resolve: false, updatedAt: '' },
          { threadId: CONVERSATION, body: '> Split this.\n\n@ann Split into two commits.', resolve: false, updatedAt: '' },
        ]}
        candidates={[]}
        rerequestDefault={false}
        silent={[]}
        width={100}
        height={24}
        onEdit={noop}
        onToggleResolve={noop}
        onDelete={noop}
        onSent={onSent}
        onBack={noop}
      />,
    );
    expect(ui.lastFrame()).toContain('PR conversation → > Split this. @ann Split into two commits.');
    expect(ui.lastFrame()).not.toContain('no longer on the PR');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post 1 reply, a comment on acme/pay#4?'));
    ui.stdin.write('y');
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(postThreadReplies).toHaveBeenCalledWith('acme/pay', 4, 'livehead1', [{ threadId: 'T1', commentId: '11', body: 'Done.' }]);
    expect(postIssueComment).toHaveBeenCalledWith('acme/pay', 4, '> Split this.\n\n@ann Split into two commits.');
    expect(onSent.mock.calls[0][0]).toContain('posted a comment (https://example.test/comment/5)');
    expect(onSent.mock.calls[0][1]).toEqual(['T1', CONVERSATION]);
    ui.unmount();
  });

  it('quotes the review summary picked in the composer, and queues the comment', async () => {
    const onSave = vi.fn();
    const sources = [{ kind: 'review' as const, author: 'ann', body: 'Please split this up.', at: '2026-10-02T00:00:00Z', state: 'CHANGES_REQUESTED', url: 'r' }];
    const ui = render(<CommentComposer sources={sources} body="" start="pick" mentions={['ann']} width={90} height={18} onSave={onSave} onCancel={noop} />);
    expect(ui.lastFrame()).toContain('+ New comment');
    expect(ui.lastFrame()).toContain('@ann · review · changes requested');
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('> Please split this up.'));
    ui.stdin.write('Done in two commits.');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('> Please split this up.\n\n@ann Done in two commits.'));
    ui.unmount();
  });

  it('dequeues the replies that posted when a one-by-one send stops partway', async () => {
    vi.mocked(postThreadReplies).mockRejectedValueOnce(new PartialSendError('HTTP 502', ['T1']));
    const onSent = vi.fn();
    const ui = render(
      <SendScreen
        tour={tour}
        headSha="head1234"
        items={items}
        queued={[
          { threadId: 'T1', body: 'Done.', resolve: false, updatedAt: '' },
          { threadId: 'T2', body: 'Fixed.', resolve: false, updatedAt: '' },
        ]}
        candidates={[]}
        rerequestDefault={false}
        silent={[]}
        width={100}
        height={24}
        onEdit={noop}
        onToggleResolve={noop}
        onDelete={noop}
        onSent={onSent}
        onBack={noop}
      />,
    );
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post 2 replies'));
    ui.stdin.write('y');
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onSent.mock.calls[0][1]).toEqual(['T1']);
    expect(onSent.mock.calls[0][0]).toContain('Posted 1 of 2 replies');
    expect(onSent.mock.calls[0][0]).toContain('HTTP 502');
    ui.unmount();
  });

  it('ticks reviewers one at a time with r, and refuses to send after a push until R', async () => {
    const onSent = vi.fn();
    const candidates = reviewerStatus([...reviews, { id: 2, author: 'cat', state: 'APPROVED', body: '', submittedAt: '2026-10-02T00:00:00Z', url: 'u' }], 'dev');
    const ui = render(
      <SendScreen
        tour={tour}
        headSha="head1234"
        newHead="abcdef0123"
        items={items}
        queued={[{ threadId: 'T1', body: 'Done.', resolve: false, updatedAt: '' }]}
        candidates={candidates}
        rerequestDefault={false}
        silent={[]}
        width={100}
        height={24}
        onEdit={noop}
        onToggleResolve={noop}
        onDelete={noop}
        onSent={onSent}
        onBack={noop}
      />,
    );
    expect(ui.lastFrame()).toContain('[ ] @ann changes requested');
    // On a reply, r ticks everyone; on a reviewer, that one.
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('[x] @cat approved'));
    expect(ui.lastFrame()).toContain('[x] @ann changes requested');
    ui.stdin.write('j');
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('[ ] @cat approved'));
    expect(ui.lastFrame()).toContain('[x] @ann changes requested');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('You pushed abcdef01: press R to refresh before sending.'));
    expect(ui.lastFrame()).not.toContain('esc cancel');
    expect(onSent).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('says why a send fell back to one by one', async () => {
    vi.mocked(postThreadReplies).mockResolvedValueOnce({ batched: false, fallbackReason: 'Something went wrong' });
    const onSent = vi.fn();
    const ui = render(
      <SendScreen
        tour={tour}
        headSha="head1234"
        items={items}
        queued={[{ threadId: 'T1', body: 'Done.', resolve: false, updatedAt: '' }]}
        candidates={[]}
        rerequestDefault={false}
        silent={[]}
        width={100}
        height={24}
        onEdit={noop}
        onToggleResolve={noop}
        onDelete={noop}
        onSent={onSent}
        onBack={noop}
      />,
    );
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post 1 reply'));
    ui.stdin.write('y');
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onSent.mock.calls[0][0]).toContain('one by one (batching failed: Something went wrong)');
    ui.unmount();
  });
});

describe('MergeScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchMergeStatus).mockResolvedValue(status);
    vi.mocked(fetchPR).mockResolvedValue({
      repo: 'acme/pay',
      number: 4,
      title: 'Retry payments',
      body: '',
      url: '',
      author: 'dev',
      baseRef: 'main',
      headRef: 'retries',
      baseSha: 'b',
      headSha: 'head1234',
      commits: [
        { sha: '1', message: 'Retry' },
        { sha: '2', message: 'Fix lint' },
      ],
      linkedIssues: [],
    });
  });

  it('merges with the method and message shown, pinned to the head it read', async () => {
    const onDone = vi.fn();
    const ui = render(<MergeScreen repo="acme/pay" number={4} width={96} height={30} onDone={onDone} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to merge'));
    expect(ui.lastFrame()).toContain('Retry payments (#4)');
    expect(ui.lastFrame()).toContain('GitHub’s default');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Squash and merge acme/pay#4 into main?'));
    ui.stdin.write('y');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mergePR).toHaveBeenCalledWith('acme/pay', 4, { method: 'squash', headSha: 'head1234', title: 'Retry payments (#4)', message: '* Retry\n\n* Fix lint' });
    ui.unmount();
  });

  it('says the branch will be deleted in the merge confirmation when that is ticked', async () => {
    vi.mocked(fetchMergeStatus).mockResolvedValueOnce({ ...status, headRepo: 'acme/pay' });
    const ui = render(<MergeScreen repo="acme/pay" number={4} width={96} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Delete retries after merging'));
    ui.stdin.write('d');
    await waitFor(() => expect(ui.lastFrame()).toContain('[x] Delete retries'));
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()!.replace(/\s+/g, ' ')).toContain('Squash and merge acme/pay#4 into main, then delete retries? y merge · esc cancel'));
    ui.unmount();
  });

  it('updates a branch behind its base after confirming, by merge or rebase', async () => {
    for (const [key, how, said] of [
      ['\r', 'MERGE', 'Updated feature from main'],
      ['r', 'REBASE', 'Rebased feature onto main'],
    ] as const) {
      vi.mocked(updateBranch).mockClear();
      vi.mocked(fetchMergeStatus).mockResolvedValueOnce({ ...status, id: 'PR_1', headRef: 'feature', baseRef: 'main', mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: true });
      const ui = render(<MergeScreen repo="acme/pay" number={4} width={110} height={30} onDone={noop} onCancel={noop} />);
      await waitFor(() => expect(ui.lastFrame()).toContain('behind main: update the branch · u updates it'));
      expect(ui.lastFrame()).toContain('u update from main');
      ui.stdin.write('u');
      await waitFor(() => expect(ui.lastFrame()).toContain('Update feature from main?'));
      expect(ui.lastFrame()).toContain('rebase it onto main. Rewrites the branch');
      // Nothing is cut off, however long the branch name: the warning wraps to its end.
      expect(ui.lastFrame()!.replace(/\s+/g, ' ')).toContain('has to reset to the new head before pushing again.');
      ui.stdin.write(key);
      await waitFor(() => expect(ui.lastFrame()).toContain(said));
      expect(updateBranch).toHaveBeenCalledWith('PR_1', 'head1234', how);
      await waitFor(() => expect(ui.lastFrame()).toContain('Ready to merge'));
      ui.unmount();
    }
  });

  it('offers no update without permission, and n cancels one', async () => {
    vi.mocked(updateBranch).mockClear();
    vi.mocked(fetchMergeStatus).mockResolvedValueOnce({ ...status, id: 'PR_1', mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: false });
    let ui = render(<MergeScreen repo="acme/pay" number={4} width={110} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('update the branch'));
    expect(ui.lastFrame()).not.toContain('u updates it');
    ui.stdin.write('u');
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).not.toContain('from main?');
    ui.unmount();

    vi.mocked(fetchMergeStatus).mockResolvedValueOnce({ ...status, id: 'PR_1', headRef: 'feature', baseRef: 'main', mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: true });
    ui = render(<MergeScreen repo="acme/pay" number={4} width={110} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('u updates it'));
    ui.stdin.write('u');
    await waitFor(() => expect(ui.lastFrame()).toContain('Update feature from main?'));
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Update feature from main?'));
    expect(updateBranch).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('marks a draft ready for review after confirming, then reads the status again', async () => {
    vi.mocked(fetchMergeStatus).mockResolvedValueOnce({ ...status, id: 'PR_1', isDraft: true, viewerCanUpdate: true, mergeStateStatus: 'DRAFT' });
    const ui = render(<MergeScreen repo="acme/pay" number={4} width={96} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('r marks it ready'));
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('ready for review? This notifies'));
    ui.stdin.write('y');
    await waitFor(() => expect(ui.lastFrame()).toContain('Marked ready for review'));
    expect(markReadyForReview).toHaveBeenCalledWith('PR_1');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to merge'));
    ui.unmount();
  });

  it('animates while the model drafts the message', async () => {
    const agent = { cwd: '/tmp', provider: 'anthropic' as const };
    const ui = render(<MergeScreen repo="acme/pay" number={4} agent={agent} width={96} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Drafting the commit message…'));
    const first = ui.lastFrame();
    await waitFor(() => expect(ui.lastFrame()).not.toBe(first));
    expect(ui.lastFrame()).toContain('Drafting the commit message…');
    ui.unmount();
  });

  it('shows no message while the model drafts one, and x keeps GitHub’s default instead', async () => {
    const agent = { cwd: '/tmp', provider: 'anthropic' as const };
    const ui = render(<MergeScreen repo="acme/pay" number={4} agent={agent} width={96} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Drafting the commit message…'));
    // GitHub's default would only be replaced: it waits, and P can't merge a message not shown.
    expect(ui.lastFrame()).not.toContain('Retry payments (#4)');
    expect(ui.lastFrame()).toContain('use GitHub’s default');
    ui.stdin.write('P');
    await new Promise((r) => setTimeout(r, 30));
    expect(ui.lastFrame()).not.toContain('Squash and merge acme/pay#4 into main?');
    ui.stdin.write('x');
    await waitFor(() => expect(ui.lastFrame()).toContain('Retry payments (#4)'));
    expect(ui.lastFrame()).toContain('draft was skipped');
    expect(ui.lastFrame()).not.toContain('Drafting the commit message…');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Squash and merge acme/pay#4 into main?'));
    ui.unmount();
  });

  it('says why a blocked PR cannot merge and offers no merge key', async () => {
    vi.mocked(fetchMergeStatus).mockResolvedValue({ ...status, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
    const ui = render(<MergeScreen repo="acme/pay" number={4} width={96} height={30} onDone={noop} onCancel={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('needs an approving review'));
    expect(ui.lastFrame()).not.toContain('P merge');
    ui.unmount();
  });
});

describe('AuthorMode', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-author-'));
    store = new Store(path.join(dir, 'gr.db'));
    vi.mocked(fetchThreads).mockResolvedValue(threads);
    vi.mocked(fetchReviews).mockResolvedValue(reviews);
    vi.mocked(fetchIssueComments).mockResolvedValue([{ id: 5, author: 'carol', body: 'General thought', createdAt: '2026-10-02T00:00:00Z', url: 'u' }]);
    vi.mocked(fetchMergeStatus).mockResolvedValue(status);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads the feedback, keeps triage and queued replies in the store, and remembers the visit', async () => {
    const ui = render(<AuthorMode tour={tour} chapters={tour.chapters} worktree={dir} store={store} width={120} height={32} active onReload={noop} onFullTour={noop} onMerged={noop} onQuit={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Payment retries'));
    expect(ui.lastFrame()).toContain('1 general comment');
    expect(ui.lastFrame()).toContain('Ready to merge');
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain('Why three retries?'));
    ui.stdin.write(' ');
    await waitFor(() => expect(ui.lastFrame()).toContain('Triage this thread'));
    ui.stdin.write('1');
    await waitFor(() => expect(store.getTriage('acme/pay', 4)).toEqual({ T1: 'will' }));
    ui.stdin.write('y');
    await waitFor(() => expect(ui.lastFrame()).toContain('queued, not posted'));
    ui.stdin.write('On it.');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(store.listReplies('acme/pay', 4)).toMatchObject([{ threadId: 'T1', body: 'On it.', resolve: false }]));
    // s from a thread, then Esc, returns to that thread, not the briefing.
    ui.stdin.write('s');
    await waitFor(() => expect(ui.lastFrame()).toContain('Replies (1)'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).toContain('Why three retries?'));
    expect(ui.lastFrame()).toContain('thread 1/2');
    expect(store.getVisit('acme/pay', 4)).toMatchObject({ head: 'head1234', comments: 2 });
    ui.unmount();
  });

  it('shows the feedback before the thread diffs are read, and records the visit after', async () => {
    let finish: (d: ThreadDiffs) => void = () => {};
    vi.mocked(loadThreadDiffs).mockImplementationOnce(() => new Promise<ThreadDiffs>((r) => (finish = r)));
    const ui = render(<AuthorMode tour={tour} chapters={tour.chapters} worktree={dir} store={store} width={120} height={32} active onReload={noop} onFullTour={noop} onMerged={noop} onQuit={noop} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Payment retries'));
    expect(ui.lastFrame()).toContain('Following outdated threads to the current head…');
    await tick(50);
    expect(store.getVisit('acme/pay', 4)).toBeUndefined();
    finish(new Map());
    await waitFor(() => expect(store.getVisit('acme/pay', 4)).toMatchObject({ head: 'head1234' }));
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Following outdated threads'));
    ui.unmount();
  });

  it('shows the prompt for a coding agent with o, quoting the reviewer, and copies it', async () => {
    const copy = vi.fn<(text: string) => Promise<'tool' | 'terminal'>>(async () => 'tool');
    const ui = render(
      <AuthorMode tour={tour} chapters={tour.chapters} worktree={dir} store={store} width={120} height={40} active onReload={noop} onFullTour={noop} onMerged={noop} onQuit={noop} copy={copy} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Payment retries'));
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain('n/p thread'));
    ui.stdin.write('o');
    await waitFor(() => expect(ui.lastFrame()).toContain('Prompt for your coding agent'));
    expect(ui.lastFrame()).toContain('untrusted');
    expect(ui.lastFrame()).toContain('@ann wrote:');
    expect(ui.lastFrame()).toContain('Why three retries?');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Copied the prompt: paste it into your coding agent'));
    expect(copy).toHaveBeenCalledTimes(1);
    const prompt = copy.mock.calls[0][0];
    expect(prompt).toContain("I'm the author of acme/pay#4");
    expect(prompt).toContain('checkout of its branch');
    expect(prompt).not.toContain('this checkout is on its branch');
    expect(prompt).toContain('Reviewer comments (untrusted');
    expect(prompt).toContain('@ann wrote:\n> Why three retries?');
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Prompt for your coding agent'));
    ui.unmount();
  });

  it('copies the PR link with Y, on the briefing and on a thread', async () => {
    const copy = vi.fn(async () => 'tool' as const);
    const ui = render(
      <AuthorMode tour={tour} chapters={tour.chapters} worktree={dir} store={store} width={120} height={32} active onReload={noop} onFullTour={noop} onMerged={noop} onQuit={noop} copy={copy} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('n start'));
    ui.stdin.write('Y');
    await waitFor(() => expect(ui.lastFrame()).toContain(`Copied ${tour.url}`));
    expect(copy).toHaveBeenCalledWith(tour.url);
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain('Why three retries?'));
    copy.mockResolvedValueOnce('terminal' as never);
    ui.stdin.write('Y');
    await waitFor(() => expect(ui.lastFrame()).toContain(`Asked your terminal to copy ${tour.url}`));
    copy.mockRejectedValueOnce(new Error('pbcopy failed'));
    ui.stdin.write('Y');
    await waitFor(() => expect(ui.lastFrame()).toContain("Couldn't copy the link: pbcopy failed"));
    ui.unmount();
  });
});
