import type { MergeMethod, MergeStatus } from '../github/gh.js';

// Whether a PR can merge now, and why not. GitHub's mergeStateStatus is the authority (it knows
// branch protection); the reasons spell out what is behind it from the parts gr can see.

export interface Readiness {
  level: 'ready' | 'warn' | 'blocked' | 'merged' | 'closed';
  summary: string; // one line: "Ready to merge" or "Not ready: changes requested · 2 checks failing"
  blockers: string[]; // what stops the merge
  warnings: string[]; // what doesn't, but is worth a look first
  canMerge: boolean; // the viewer may press merge (GitHub still decides)
  canMarkReady: boolean; // a draft the viewer may mark ready for review
  canUpdateBranch: boolean; // behind its base, and the viewer may update it from there
}

// A thread count that may be a lower bound: 100+ when GitHub had more threads than gr read.
export const unresolvedText = (n: number, atLeast?: boolean) => `${n}${atLeast ? '+' : ''} unresolved ${n === 1 && !atLeast ? 'thread' : 'threads'}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function mergeReadiness(s: MergeStatus): Readiness {
  if (s.state === 'MERGED') return { level: 'merged', summary: 'Merged', blockers: [], warnings: [], canMerge: false, canMarkReady: false, canUpdateBranch: false };
  if (s.state === 'CLOSED') return { level: 'closed', summary: 'Closed without merging', blockers: [], warnings: [], canMerge: false, canMarkReady: false, canUpdateBranch: false };
  const blockers: string[] = [];
  const warnings: string[] = [];
  const c = s.checks;
  if (s.isDraft) blockers.push('draft PR: mark it ready for review first');
  if (s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'DIRTY') blockers.push(`conflicts with ${s.baseRef}`);
  if (s.mergeStateStatus === 'BEHIND') blockers.push(`behind ${s.baseRef}: update the branch`);
  if (s.reviewDecision === 'CHANGES_REQUESTED') blockers.push('changes requested');
  else if (s.reviewDecision === 'REVIEW_REQUIRED') blockers.push('needs an approving review');
  if (c.requiredFailed.length) blockers.push(`required ${c.requiredFailed.length === 1 ? 'check' : 'checks'} failing: ${c.requiredFailed.slice(0, 3).join(', ')}`);
  if (c.requiredPending.length) blockers.push(`waiting on ${plural(c.requiredPending.length, 'required check')}`);
  if (s.mergeStateStatus === 'BLOCKED' && !blockers.length) {
    blockers.push(s.unresolvedThreads ? `blocked by branch protection (${unresolvedText(s.unresolvedThreads, s.unresolvedThreadsAtLeast)} may be why)` : 'blocked by branch protection');
  }
  const otherFailed = c.failedNames.filter((n) => !c.requiredFailed.includes(n));
  if (otherFailed.length) warnings.push(`${plural(otherFailed.length, 'check')} failing: ${otherFailed.slice(0, 3).join(', ')}`);
  const otherPending = c.pending - c.requiredPending.length;
  if (otherPending > 0) warnings.push(`${plural(otherPending, 'check')} still running`);
  if (s.unresolvedThreads && !blockers.some((b) => b.includes('unresolved'))) warnings.push(unresolvedText(s.unresolvedThreads, s.unresolvedThreadsAtLeast));
  if (s.mergeStateStatus === 'UNKNOWN' || s.mergeable === 'UNKNOWN') warnings.push('GitHub is still working out whether it merges cleanly');
  if (!s.methods.length) blockers.push('the repository allows no merge method');

  const level = blockers.length ? 'blocked' : warnings.length ? 'warn' : 'ready';
  const summary =
    level === 'blocked'
      ? `Not ready: ${blockers.join(' · ')}`
      : level === 'warn'
        ? `Ready to merge, with ${warnings.length === 1 ? 'a warning' : 'warnings'}: ${warnings.join(' · ')}`
        : 'Ready to merge';
  return {
    level,
    summary,
    blockers,
    warnings,
    canMerge: s.viewerCanMerge && level !== 'blocked',
    canMarkReady: s.isDraft && (s.viewerCanUpdate ?? s.viewerCanMerge),
    canUpdateBranch: s.mergeStateStatus === 'BEHIND' && !!s.viewerCanUpdateBranch,
  };
}

export const METHOD_LABEL: Record<MergeMethod, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

// Squash is the usual choice when the repository allows it.
export function defaultMethod(methods: MergeMethod[]): MergeMethod | undefined {
  return methods.includes('squash') ? 'squash' : methods[0];
}

// GitHub's own messages, used until a model drafts better ones (or without a model).
export function defaultMergeMessage(
  method: MergeMethod,
  pr: { number: number; title: string; headRef: string; headOwner?: string; commits: { message: string }[] },
): { title: string; message: string } {
  if (method === 'squash') {
    const message = pr.commits.length > 1 ? pr.commits.map((c) => `* ${c.message.trim()}`).join('\n\n') : (pr.commits[0]?.message.split('\n').slice(1).join('\n').trim() ?? '');
    return { title: `${pr.title} (#${pr.number})`, message };
  }
  if (method === 'merge') return { title: `Merge pull request #${pr.number} from ${pr.headOwner ? `${pr.headOwner}/` : ''}${pr.headRef}`, message: pr.title };
  return { title: '', message: '' };
}
