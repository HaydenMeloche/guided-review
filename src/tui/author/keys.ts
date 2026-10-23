// The feedback screens' keys, once: what each key is, how docs/usage.md names it, and its entry
// in the key bar (its label can depend on the screen's state). The screens' useInput handlers
// run the actions; test/author-keys.test.ts checks every key a handler reads is listed here and
// every listed key is in the docs.

export type Bar<C> = { shown: string; label: string | ((c: C) => string); when?: (c: C) => boolean };

export interface KeyDef<C> {
  keys: string[]; // the characters the handler reads
  doc?: string[]; // how docs/usage.md writes them in backticks, if not the same as `keys`
  alias?: boolean; // another key's twin: the docs need not name it
  bar?: Bar<C>; // absent: not in the key bar
}

// The key bar of a screen: the entries whose condition holds, in the table's order.
export function barOf<C>(defs: KeyDef<C>[], ctx: C): [string, string][] {
  const out: [string, string][] = [];
  for (const d of defs) {
    const b = d.bar;
    if (!b || (b.when && !b.when(ctx))) continue;
    out.push([b.shown, typeof b.label === 'function' ? b.label(ctx) : b.label]);
  }
  return out;
}

// The key names the docs must mention.
export function docKeys<C>(defs: KeyDef<C>[]): string[] {
  return [...new Set(defs.filter((d) => !d.alias).flatMap((d) => d.doc ?? d.keys))];
}

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
  { keys: ['n', 'p'], bar: { shown: 'n/p', label: 'thread' } },
  { keys: [']', '['], bar: { shown: ']/[', label: 'chapter' } },
  { keys: ['y'], bar: { shown: 'y', label: (c) => (c.queued ? 'edit reply' : 'reply') } },
  { keys: [' '], doc: ['Space'], bar: { shown: 'space', label: 'triage' } },
  { keys: ['Z'], bar: { shown: 'Z', label: (c) => (c.resolved ? 'unresolve' : 'resolve') } },
  { keys: ['s'], bar: { shown: 's', label: (c) => (c.queuedCount ? `send ${c.queuedCount}` : 'send') } },
  { keys: ['?'], bar: { shown: '?', label: 'ask', when: (c) => c.agent } },
  { keys: ['o'], bar: { shown: 'o', label: 'prompt for agent' } },
  { keys: ['e'], bar: { shown: 'e', label: (c) => (c.expanded ? 'show code' : 'more thread') } },
  { keys: ['a'], bar: { shown: 'a', label: 'react' } },
  { keys: ['H'], bar: { shown: 'H', label: (c) => (c.showHidden ? 'hide resolved' : 'show resolved') } },
  { keys: ['b'], bar: { shown: 'b', label: 'briefing' } },
  { keys: ['M'], bar: { shown: 'M', label: 'merge', when: (c) => c.merge } },
  { keys: ['Y'], bar: { shown: 'Y', label: 'copy link', when: (c) => c.copy } },
  { keys: ['j', 'k'] },
  { keys: ['J', 'K'] },
  { keys: ['Tab'] },
  { keys: ['l'] },
  { keys: ['R'] },
  { keys: ['L'], doc: ['L'] },
  { keys: ['r'], doc: ['r'] }, // in an AI draft: ask for changes
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
  { keys: ['n'], bar: { shown: 'n', label: 'start' } },
  { keys: ['Enter'], bar: { shown: 'enter', label: 'open' } },
  { keys: ['j', 'k'], bar: { shown: 'j/k', label: 'select' } },
  { keys: ['s'], bar: { shown: 's', label: (c) => (c.queuedCount ? `send ${c.queuedCount}` : 'send') } },
  { keys: ['y'], bar: { shown: 'y', label: 'comment', when: (c) => c.comment } },
  { keys: ['M'], bar: { shown: 'M', label: 'merge', when: (c) => c.merge } },
  { keys: ['t'], bar: { shown: 't', label: 'full tour' } },
  { keys: ['A'], bar: { shown: 'A', label: 'reviewers', when: (c) => c.reviewers } },
  { keys: ['Y'], bar: { shown: 'Y', label: 'copy link', when: (c) => c.copy } },
  { keys: ['R'], bar: { shown: 'R', label: 'refresh' } },
  { keys: ['L'], bar: { shown: 'L', label: 'theme', when: (c) => c.theme } },
  { keys: ['c'] },
  { keys: ['H'] },
  { keys: ['V'] },
  { keys: ['g'] },
  { keys: ['r'] },
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
  { keys: ['P'], bar: { shown: 'P', label: 'send' } },
  { keys: ['Esc'], bar: { shown: 'esc', label: 'back' } },
  { keys: ['j', 'k'], bar: { shown: 'j/k', label: 'select' } },
  { keys: ['e'], bar: { shown: 'e', label: 'edit' } },
  { keys: ['z'], bar: { shown: 'z', label: 'resolve after' } },
  { keys: ['x'], bar: { shown: 'x', label: 'delete' } },
  { keys: ['r'], bar: { shown: 'r', label: 're-request', when: (c) => c.candidates } },
  { keys: ['q'], alias: true },
];
