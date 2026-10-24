// The feedback screens' keys (see ../keys.ts). test/author-keys.test.ts checks every key a
// handler reads is listed here and every listed key is in the docs.
import { barOf, type KeyDef } from '../keys.js';

export { barOf, docKeys, type Bar, type KeyDef } from '../keys.js';

// ---------- a thread ----------

export interface ThreadKeyCtx {
  queued: boolean; // this thread has a queued reply
  resolved: boolean;
  queuedCount: number;
  agent: boolean;
  expanded: boolean;
  showHidden: boolean;
  merge: boolean;
  copy: boolean;
}

export const THREAD_KEYS: KeyDef<ThreadKeyCtx>[] = [
  { keys: ['n', 'p'], group: 'Move', help: 'Next or previous thread, on into the next chapter', bar: { shown: 'n/p', label: 'thread' } },
  { keys: [']', '['], group: 'Move', help: 'Next or previous feedback chapter', bar: { shown: ']/[', label: 'chapter' } },
  { keys: ['j', 'k'], group: 'Move', name: 'j/k, J/K', help: 'Scroll the discussion by a line or a page' },
  { keys: ['J', 'K'], alias: true },
  { keys: ['Tab'], group: 'Move', help: 'Select the next comment' },
  { keys: ['y'], group: 'Answer', help: 'Write a reply (queued until you send)', bar: { shown: 'y', label: (c) => (c.queued ? 'edit reply' : 'reply') } },
  { keys: [' '], doc: ['Space'], group: 'Answer', help: 'Cycle your triage: will do, done, won’t do, discuss', bar: { shown: 'space', label: 'triage' } },
  { keys: ['Z'], group: 'Answer', help: 'Resolve or unresolve the thread on GitHub (asks first)', bar: { shown: 'Z', label: (c) => (c.resolved ? 'unresolve' : 'resolve') } },
  { keys: ['+'], group: 'Answer', help: 'React to the selected comment', bar: { shown: '+', label: 'react' } },
  { keys: ['a'], group: 'Answer', help: 'Ask the model about the thread', bar: { shown: 'a', label: 'ask', when: (c) => c.agent } },
  { keys: ['o'], group: 'Answer', help: 'The prompt for your coding agent to make the fix', bar: { shown: 'o', label: 'prompt for agent' } },
  { keys: ['s'], group: 'Answer', help: 'Send screen', bar: { shown: 's', label: (c) => (c.queuedCount ? `send ${c.queuedCount}` : 'send') } },
  { keys: ['e'], group: 'View', help: 'More of the screen for the discussion, or the code back', bar: { shown: 'e', label: (c) => (c.expanded ? 'show code' : 'more thread') } },
  { keys: ['l'], group: 'View', help: 'Move the linked-file preview on to the next file' },
  { keys: ['H'], group: 'View', help: 'Show or hide resolved threads', bar: { shown: 'H', label: (c) => (c.showHidden ? 'hide resolved' : 'show resolved') } },
  { keys: ['b'], group: 'Go', help: 'Back to the feedback briefing', bar: { shown: 'b', label: 'briefing' } },
  { keys: ['M'], group: 'Go', help: 'Merge the PR', bar: { shown: 'M', label: 'merge', when: (c) => c.merge } },
  { keys: ['Y'], group: 'Go', help: 'Copy the PR’s link', bar: { shown: 'Y', label: 'copy link', when: (c) => c.copy } },
  { keys: ['R'], group: 'Go', help: 'Read the feedback again' },
  { keys: ['L'], group: 'Go', help: 'Color theme' },
  { keys: ['r'], doc: ['r'] }, // in an AI draft: ask for changes
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['Q'], alias: true },
  { keys: ['q'], alias: true },
];

// The thread screen's Ctrl keys, in the reply editor.
export const REPLY_CTRL_KEYS = ['t', 'r'];
export const REPLY_CTRL_DOC = ['Ctrl+T', 'Ctrl+R'];

export const briefingBar = (c: BriefingKeyCtx) => barOf(BRIEFING_KEYS, c);
export const sendBar = (c: SendKeyCtx) => barOf(SEND_KEYS, c);
export const threadBar = (c: ThreadKeyCtx) => barOf(THREAD_KEYS, c);

// ---------- the briefing ----------

export interface BriefingKeyCtx {
  queuedCount: number;
  comment: boolean;
  merge: boolean;
  reviewers: boolean;
  copy: boolean;
  theme: boolean;
}

export const BRIEFING_KEYS: KeyDef<BriefingKeyCtx>[] = [
  { keys: ['n'], group: 'Read', help: 'Start or resume the feedback', bar: { shown: 'n', label: 'start' } },
  { keys: ['Enter'], group: 'Read', help: 'Open the selected chapter', bar: { shown: 'enter', label: 'open' } },
  { keys: ['j', 'k'], group: 'Read', help: 'Select a chapter', bar: { shown: 'j/k', label: 'select' } },
  { keys: ['H'], group: 'Read', help: 'Show or hide resolved threads' },
  { keys: ['r'], group: 'Read', help: 'Read your PR description' },
  { keys: ['V'], group: 'Read', help: 'Read the reviewers’ summaries' },
  { keys: ['g'], group: 'Read', help: 'Read the PR’s general comments' },
  { keys: ['s'], group: 'Answer', help: 'Send screen', bar: { shown: 's', label: (c) => (c.queuedCount ? `send ${c.queuedCount}` : 'send') } },
  { keys: ['y'], group: 'Answer', help: 'Comment on the PR (queued until you send)', bar: { shown: 'y', label: 'comment', when: (c) => c.comment } },
  { keys: ['M'], group: 'PR', help: 'Merge the PR', bar: { shown: 'M', label: 'merge', when: (c) => c.merge } },
  { keys: ['c'], group: 'PR', help: 'Checks and their logs' },
  { keys: ['A'], group: 'PR', help: 'Ask for reviews', bar: { shown: 'A', label: 'reviewers', when: (c) => c.reviewers } },
  { keys: ['Y'], group: 'PR', help: 'Copy the PR’s link', bar: { shown: 'Y', label: 'copy link', when: (c) => c.copy } },
  { keys: ['t'], group: 'PR', help: 'The full tour of the PR', bar: { shown: 't', label: 'full tour' } },
  { keys: ['R'], group: 'App', help: 'Read the feedback again', bar: { shown: 'R', label: 'refresh' } },
  { keys: ['L'], group: 'App', help: 'Color theme', bar: { shown: 'L', label: 'theme', when: (c) => c.theme } },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: [' '], alias: true },
  { keys: ['p'], alias: true },
  { keys: ['q'], alias: true },
  { keys: ['Q'], alias: true },
];

// ---------- the send screen ----------

export interface SendKeyCtx {
  candidates: boolean; // someone has reviewed, so can be asked again
}

export const SEND_KEYS: KeyDef<SendKeyCtx>[] = [
  { keys: ['P'], group: 'Send', help: 'Send everything (asks first)', bar: { shown: 'P', label: 'send' } },
  { keys: ['Esc'], bar: { shown: 'esc', label: 'back' } },
  { keys: ['j', 'k'], group: 'Send', help: 'Move through the replies, then the reviewers', bar: { shown: 'j/k', label: 'select' } },
  { keys: ['e'], group: 'Send', help: 'Edit the selected reply or comment', bar: { shown: 'e', label: 'edit' } },
  { keys: ['z'], group: 'Send', help: 'Resolve the thread after sending, or not', bar: { shown: 'z', label: 'resolve after' } },
  { keys: ['x'], group: 'Send', help: 'Delete the selected reply (asks first)', bar: { shown: 'x', label: 'delete' } },
  { keys: ['r'], group: 'Send', help: 'Tick or untick re-request review', bar: { shown: 'r', label: 're-request', when: (c) => c.candidates } },
  { keys: ['?'] },
  { keys: ['h'], alias: true },
  { keys: ['q'], alias: true },
  { keys: ['Q'], alias: true },
];
