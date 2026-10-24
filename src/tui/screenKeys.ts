// The keys of the PR list, the review briefing, the submit screen, the merge dialog and the
// checks popup (see keys.ts). test/screen-keys.test.ts checks every key a screen's handlers read
// is listed here and every listed key is in docs/usage.md.
import { barOf, type KeyDef } from './keys.js';

// ---------- the PR list ----------

export interface PickerKeyCtx {
  items: boolean; // the list has a PR to act on
  filter: boolean; // there is a list to filter
  merge: boolean;
  checks: boolean;
  reviewers: boolean; // the highlighted PR is yours
  theme: boolean;
}

export const PICKER_KEYS: KeyDef<PickerKeyCtx>[] = [
  { keys: ['Enter'], group: 'Open', help: 'Open the tour, or the feedback on your own PR', bar: { shown: 'enter', label: 'open', when: (c) => c.items } },
  { keys: ['j', 'k'], group: 'Move', help: 'Move through the list', bar: { shown: 'j/k', label: 'move', when: (c) => c.items } },
  { keys: ['g', 'G'], group: 'Move', help: 'First or last PR' },
  { keys: ['/'], group: 'Move', help: 'Filter by repo, title, author or label (esc clears it)', bar: { shown: '/', label: 'filter', when: (c) => c.filter } },
  { keys: ['c'], group: 'PR', help: 'Checks and their logs', bar: { shown: 'c', label: 'checks', when: (c) => c.items && c.checks } },
  { keys: ['M'], group: 'PR', help: 'Merge the PR', bar: { shown: 'M', label: 'merge', when: (c) => c.items && c.merge } },
  { keys: ['o'], group: 'PR', help: 'Open the PR in your browser', bar: { shown: 'o', label: 'browser', when: (c) => c.items } },
  { keys: ['A'], group: 'PR', help: 'Your PR: who is asked to review it, and ask more', bar: { shown: 'A', label: 'reviewers', when: (c) => c.reviewers } },
  { keys: ['w'], group: 'PR', help: 'Show or hide your PRs that wait on reviewers' },
  { keys: ['p', 'x'], group: 'PR', name: 'p / x', help: 'Open or dismiss the PR link on your clipboard' },
  { keys: [' '], doc: ['Space'], group: 'Download', help: 'Select the PR for download' },
  { keys: ['a'], group: 'Download', help: 'Select every PR the filter shows' },
  { keys: ['d'], group: 'Download', help: 'Download the selected tours (or the highlighted one)' },
  { keys: ['r'], group: 'App', help: 'Refresh the list', bar: { shown: 'r', label: 'refresh' } },
  { keys: ['L'], group: 'App', help: 'Color theme', bar: { shown: 'L', label: 'theme', when: (c) => c.theme } },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['q'] },
  { keys: ['Q'], alias: true },
];

export const pickerBar = (c: PickerKeyCtx) => barOf(PICKER_KEYS, c);

// ---------- the review briefing ----------

export interface ReviewBriefingKeyCtx {
  start: string; // what n does: start, or resume and where
  agent: boolean;
  readDescription: boolean; // r is not already hinted under a cut-off description
  diagram: boolean; // d is not already hinted beside the overview
  feedback: boolean; // your own PR
  checks: boolean;
  theme: boolean;
}

export const REVIEW_BRIEFING_KEYS: KeyDef<ReviewBriefingKeyCtx>[] = [
  { keys: ['n'], group: 'Read', help: 'Start reading, or resume where you left off', bar: { shown: 'n', label: (c) => c.start } },
  { keys: ['Enter'], group: 'Read', help: 'Open the selected chapter', bar: { shown: 'enter', label: 'open' } },
  { keys: ['j', 'k'], group: 'Read', help: 'Select a chapter', bar: { shown: 'j/k', label: 'select' } },
  { keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], doc: ['1'], name: '1–9', group: 'Read', help: 'Open the chapter with that number' },
  { keys: ['f'], group: 'Read', help: 'Cycle Guided, Risk first, Small first and File order' },
  { keys: ['D'], group: 'Read', help: 'Re-review: only new and changed hunks, or the full review' },
  { keys: ['a'], group: 'Ask', help: 'Ask the model about the whole PR', bar: { shown: 'a', label: 'ask about the PR', when: (c) => c.agent } },
  { keys: ['r'], group: 'View', help: 'Read the full PR description', bar: { shown: 'r', label: 'read description', when: (c) => c.readDescription } },
  { keys: ['V'], group: 'View', help: 'Read the submitted reviews' },
  { keys: ['d'], group: 'View', help: 'Explore the overview diagram', bar: { shown: 'd', label: 'overview diagram', when: (c) => c.diagram } },
  { keys: ['s'], group: 'PR', help: 'Submit screen', bar: { shown: 's', label: 'submit' } },
  { keys: ['M'], group: 'PR', help: 'Merge the PR' },
  { keys: ['c'], group: 'PR', help: 'Checks and their logs', bar: { shown: 'c', label: 'checks', when: (c) => c.checks } },
  { keys: ['t'], group: 'PR', help: 'Your PR: switch to its feedback', bar: { shown: 't', label: 'your feedback', when: (c) => c.feedback } },
  { keys: ['L'], group: 'App', help: 'Color theme', bar: { shown: 'L', label: 'theme', when: (c) => c.theme } },
  { keys: [':'], group: 'App', help: 'Command palette: the briefing’s commands, and a chapter to open' },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: [' '], alias: true },
  { keys: ['q'] },
  { keys: ['Q'], alias: true },
];

export const reviewBriefingBar = (c: ReviewBriefingKeyCtx) => barOf(REVIEW_BRIEFING_KEYS, c);

// ---------- the submit screen ----------

export const SUBMIT_KEYS: KeyDef<object>[] = [
  { keys: ['P'], group: 'Post', help: 'Post the review (asks first)', bar: { shown: 'P', label: 'post' } },
  { keys: ['a', 'r', 'c'], group: 'Post', name: 'a / r / c', help: 'Verdict: approve, request changes, or comment', bar: { shown: 'a/r/c', label: 'verdict' } },
  { keys: ['w'], group: 'Post', help: 'Write the review summary', bar: { shown: 'w', label: 'summary' } },
  { keys: ['j', 'k'], group: 'Drafts', help: 'Select a draft', bar: { shown: 'j/k', label: 'select' } },
  { keys: ['e'], group: 'Drafts', help: 'Edit the selected draft', bar: { shown: 'e', label: 'edit' } },
  { keys: ['x'], group: 'Drafts', help: 'Delete the selected draft (asks first)', bar: { shown: 'x', label: 'delete' } },
  { keys: ['p'], group: 'Drafts', help: 'Preview the draft as it will post', bar: { shown: 'p', label: 'preview as posted' } },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['q'], alias: true },
  { keys: ['Q'], alias: true },
];

export const submitBar = () => barOf(SUBMIT_KEYS, {});

// ---------- the merge dialog ----------

export interface MergeKeyCtx {
  canMerge: boolean;
  waitingDraft: boolean; // the model is drafting the message
  methods: boolean; // more than one merge method
  message: boolean; // the method takes a commit message
  agent: boolean;
  canMarkReady: boolean;
  canUpdate: boolean;
  base: string;
}

const merging = (c: MergeKeyCtx) => c.canMerge && !c.waitingDraft;
export const MERGE_KEYS: KeyDef<MergeKeyCtx>[] = [
  { keys: ['P'], group: 'Merge', help: 'Merge (asks first; Enter too)', bar: { shown: 'P', label: 'merge', when: merging } },
  { keys: ['x'], group: 'Merge', help: 'While the model drafts the message: use GitHub’s default', bar: { shown: 'x', label: 'use GitHub’s default', when: (c) => c.canMerge && c.waitingDraft } },
  { keys: ['m'], group: 'Merge', help: 'Switch the merge method', bar: { shown: 'm', label: 'method', when: (c) => c.canMerge && c.methods } },
  { keys: ['e'], group: 'Message', help: 'Edit the commit title', bar: { shown: 'e', label: 'edit title', when: (c) => merging(c) && c.message } },
  { keys: ['b'], group: 'Message', help: 'Edit the commit body', bar: { shown: 'b', label: 'edit body', when: (c) => merging(c) && c.message } },
  { keys: ['g'], group: 'Message', help: 'Have the model draft the message again', bar: { shown: 'g', label: 'draft again', when: (c) => merging(c) && c.message && c.agent } },
  { keys: ['d'], group: 'Merge', help: 'Delete the branch after merging, or keep it' },
  { keys: ['r'], group: 'Not ready', help: 'Mark a draft PR ready for review', bar: { shown: 'r', label: 'mark ready for review', when: (c) => !c.canMerge && c.canMarkReady } },
  { keys: ['u'], group: 'Not ready', help: 'Update the branch from its base', bar: { shown: 'u', label: (c) => `update from ${c.base}`, when: (c) => !c.canMerge && c.canUpdate } },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['q'], alias: true },
  { keys: ['Q'], alias: true },
];

export const mergeBar = (c: MergeKeyCtx) => barOf(MERGE_KEYS, c);

// ---------- checks ----------

export interface ChecksKeyCtx {
  log: boolean; // the selected check has a log to read
  url: boolean; // and a page to open
}

export const CHECKS_KEYS: KeyDef<ChecksKeyCtx>[] = [
  { keys: ['j', 'k'], group: 'Checks', help: 'Select a check', bar: { shown: 'j/k', label: 'select' } },
  {
    keys: ['Enter'],
    group: 'Checks',
    help: 'Read a GitHub Actions job’s log, or open the check’s page',
    bar: { shown: 'enter', label: (c) => (c.log ? 'read log' : 'open'), when: (c) => c.log || c.url },
  },
  { keys: ['o'], group: 'Checks', help: 'Open the check’s page on GitHub', bar: { shown: 'o', label: 'open on GitHub', when: (c) => c.log && c.url } },
  { keys: ['R'], group: 'Checks', help: 'Read the checks again', bar: { shown: 'R', label: 'refresh' } },
  { keys: ['c'], alias: true }, // closes, as it opened
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['q'], alias: true },
  { keys: ['Q'], alias: true },
];

export const CHECK_LOG_KEYS: KeyDef<object>[] = [
  { keys: ['j', 'k'], group: 'Log', help: 'Scroll a line', bar: { shown: 'j/k', label: 'scroll' } },
  { keys: ['d', 'u'], group: 'Log', name: 'd / u', help: 'Page down or up (PgDn and PgUp too)', bar: { shown: 'd/u', label: 'page' } },
  { keys: ['g', 'G'], group: 'Log', name: 'g / G', help: 'Top or end of the log', bar: { shown: 'g/G', label: 'top/end' } },
  { keys: ['n', 'N'], group: 'Log', name: 'n / N', help: 'Next or previous error', bar: { shown: 'n/N', label: 'next/prev error' } },
  { keys: ['o'], group: 'Log', help: 'Open the check’s page on GitHub', bar: { shown: 'o', label: 'open on GitHub' } },
  { keys: ['R'], group: 'Log', help: 'Read a running job’s log again', bar: { shown: 'R', label: 'reload' } },
  { keys: [' '], alias: true }, // pages down, as in less
];

export const checksBar = (c: ChecksKeyCtx) => barOf(CHECKS_KEYS, c);
export const checkLogBar = () => barOf(CHECK_LOG_KEYS, {});
