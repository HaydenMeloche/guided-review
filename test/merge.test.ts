import { describe, expect, it } from 'vitest';
import { defaultMergeMessage, defaultMethod, mergeReadiness } from '../src/review/merge.js';
import { summarizeChecks, type MergeStatus } from '../src/github/gh.js';

const status = (extra: Partial<MergeStatus> = {}): MergeStatus => ({
  repo: 'o/r',
  number: 7,
  title: 'Add retries',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  headSha: 'head',
  headRef: 'retries',
  baseRef: 'main',
  headRepo: 'o/r',
  methods: ['merge', 'squash', 'rebase'],
  viewerCanMerge: true,
  deleteBranchOnMerge: false,
  checks: { passed: 3, failed: 0, pending: 0, failedNames: [], requiredFailed: [], requiredPending: [], items: [] },
  unresolvedThreads: 0,
  commitCount: 2,
  ...extra,
});

describe('mergeReadiness', () => {
  it('is ready when GitHub says it merges cleanly', () => {
    expect(mergeReadiness(status())).toMatchObject({ level: 'ready', summary: 'Ready to merge', canMerge: true });
  });

  it('names what blocks a merge', () => {
    const r = mergeReadiness(
      status({
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'BLOCKED',
        checks: { passed: 1, failed: 1, pending: 1, failedNames: ['lint'], requiredFailed: ['lint'], requiredPending: ['test'], items: [] },
      }),
    );
    expect(r.level).toBe('blocked');
    expect(r.blockers).toEqual(['changes requested', 'required check failing: lint', 'waiting on 1 required check']);
    expect(r.canMerge).toBe(false);
  });

  it('blames branch protection when GitHub blocks for a reason gr cannot see', () => {
    expect(mergeReadiness(status({ mergeStateStatus: 'BLOCKED', unresolvedThreads: 2 })).blockers).toEqual(['blocked by branch protection (2 unresolved threads may be why)']);
  });

  it('warns about optional checks and open threads without blocking', () => {
    const r = mergeReadiness(
      status({ mergeStateStatus: 'UNSTABLE', unresolvedThreads: 1, checks: { passed: 2, failed: 1, pending: 0, failedNames: ['docs'], requiredFailed: [], requiredPending: [], items: [] } }),
    );
    expect(r).toMatchObject({ level: 'warn', canMerge: true, warnings: ['1 check failing: docs', '1 unresolved thread'] });
    expect(mergeReadiness(status({ mergeStateStatus: 'UNSTABLE', unresolvedThreads: 100, unresolvedThreadsAtLeast: true })).warnings).toEqual(['100+ unresolved threads']);
    expect(mergeReadiness(status({ mergeStateStatus: 'BLOCKED', unresolvedThreads: 100, unresolvedThreadsAtLeast: true })).blockers).toEqual([
      'blocked by branch protection (100+ unresolved threads may be why)',
    ]);
  });

  it('blocks drafts, conflicts and branches behind the base, and does not offer merge without write access', () => {
    expect(mergeReadiness(status({ isDraft: true })).blockers[0]).toMatch(/draft/);
    expect(mergeReadiness(status({ isDraft: true, viewerCanUpdate: true }))).toMatchObject({ canMerge: false, canMarkReady: true });
    expect(mergeReadiness(status({ isDraft: true, viewerCanUpdate: false })).canMarkReady).toBe(false);
    expect(mergeReadiness(status()).canMarkReady).toBe(false);
    expect(mergeReadiness(status({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).blockers).toEqual(['conflicts with main']);
    expect(mergeReadiness(status({ mergeStateStatus: 'BEHIND' })).blockers).toEqual(['behind main: update the branch']);
    expect(mergeReadiness(status({ viewerCanMerge: false })).canMerge).toBe(false);
    expect(mergeReadiness(status({ state: 'MERGED' })).level).toBe('merged');
  });
});

describe('merge messages', () => {
  it('defaults to squash when allowed', () => {
    expect(defaultMethod(['merge', 'squash'])).toBe('squash');
    expect(defaultMethod(['rebase'])).toBe('rebase');
  });

  it('matches GitHub’s defaults', () => {
    const pr = { number: 7, title: 'Add retries', headRef: 'retries', headOwner: 'me', commits: [{ message: 'one' }, { message: 'two\n\nbody' }] };
    expect(defaultMergeMessage('squash', pr)).toEqual({ title: 'Add retries (#7)', message: '* one\n\n* two\n\nbody' });
    expect(defaultMergeMessage('merge', pr)).toEqual({ title: 'Merge pull request #7 from me/retries', message: 'Add retries' });
  });
});

describe('summarizeChecks', () => {
  it('splits required checks out', () => {
    expect(
      summarizeChecks([
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true },
        { name: 'docs', status: 'COMPLETED', conclusion: 'FAILURE' },
        { context: 'ci/test', state: 'PENDING', isRequired: true },
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toMatchObject({ passed: 1, failed: 2, pending: 1, failedNames: ['lint', 'docs'], requiredFailed: ['lint'], requiredPending: ['ci/test'] });
  });
});

describe('updating a branch behind its base', () => {
  it('is offered only when GitHub says the viewer may', () => {
    expect(mergeReadiness(status({ mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: true }))).toMatchObject({ level: 'blocked', canUpdateBranch: true, canMerge: false });
    expect(mergeReadiness(status({ mergeStateStatus: 'BEHIND', viewerCanUpdateBranch: false })).canUpdateBranch).toBe(false);
    expect(mergeReadiness(status({ mergeStateStatus: 'CLEAN', viewerCanUpdateBranch: true })).canUpdateBranch).toBe(false);
  });
});
