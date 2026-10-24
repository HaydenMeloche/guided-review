import type { Key } from 'ink';
import type { Hint } from '../KeyBar.js';

// The chapter screen's keys, once: what each does in which view, its row in the help, and its entry
// in the key bar. The screen supplies the actions; this decides which one a keypress runs.

// `code`: a hunk (or none). `collapsed`: a collapsed chapter's summary, whose keys come first and
// otherwise fall back to the code keys. `tests`: the linked test pane has focus. `any`: every view.
export type View = 'code' | 'tests' | 'collapsed';
type Mode = View | 'any';

// What `when` and the key bar's labels look at.
export interface KeyCtx {
  hunk: boolean;
  chapter: boolean;
  agent: boolean; // a and ^T need it
  selecting: boolean; // v has set a range anchor
  threads: boolean; // review threads on the cursor line
  reply: boolean; // replies can be posted
  draft: boolean; // an unposted draft on the cursor line
  tests: boolean; // linked tests
  diagram: boolean;
  done: boolean; // every hunk read or skipped
  split: boolean; // the diff shows split
  rereview: boolean;
  deltaOnly: boolean; // a re-review shows only new and changed hunks
  rebase: boolean;
  theme: boolean;
}

export type Action =
  | 'briefing'
  | 'quit'
  | 'next'
  | 'prev'
  | 'nextChapter'
  | 'prevChapter'
  | 'down'
  | 'up'
  | 'pageDown'
  | 'pageUp'
  | 'range'
  | 'escape'
  | 'comment'
  | 'commentFlow'
  | 'thread'
  | 'reply'
  | 'editDraft'
  | 'deleteDraft'
  | 'ask'
  | 'focusTests'
  | 'testPane'
  | 'leaveTests'
  | 'testDown'
  | 'testUp'
  | 'testPageDown'
  | 'testPageUp'
  | 'nextTest'
  | 'prevTest'
  | 'commentTest'
  | 'askTest'
  | 'untested'
  | 'diagram'
  | 'raw'
  | 'split'
  | 'moreContext'
  | 'lessContext'
  | 'whitespace'
  | 'skip'
  | 'defer'
  | 'unread'
  | 'move'
  | 'order'
  | 'delta'
  | 'rebase'
  | 'openInAgent'
  | 'checklist'
  | 'submit'
  | 'help'
  | 'theme'
  | 'summaryDown'
  | 'summaryUp'
  | 'expand'
  | 'skipChapter'
  | 'palette';

// A printable key, or one of Ink's named keys.
const NAMED = { up: 'upArrow', down: 'downArrow', pageUp: 'pageUp', pageDown: 'pageDown', return: 'return', escape: 'escape', tab: 'tab' } as const satisfies Record<string, keyof Key>;
type KeyName = keyof typeof NAMED | (string & {});

interface Binding {
  mode: Mode;
  on: KeyName[];
  do: Action;
  when?: (c: KeyCtx) => boolean; // otherwise the key does nothing here
  palette?: string; // its command in the palette (:), listed with the key
}

interface BarEntry {
  mode: View;
  key: string;
  label: string | ((c: KeyCtx) => string);
  when?: (c: KeyCtx) => boolean;
}

export interface KeyRow {
  keys: string; // as the help shows them
  help?: string; // left out of the help when unset
  group?: string; // the help section it is listed under
  ai?: boolean; // left out of the help with no agent
  bind?: Binding[];
  bar?: BarEntry[];
}

const hunk = (c: KeyCtx) => c.hunk;

// In the help's order. Settings flipped once in a review are under Settings: their letters stay
// as shortcuts, and the palette (:) lists them with the rest.
export const KEYS: KeyRow[] = [
  {
    keys: 'n / p',
    group: 'Move',
    help: 'Next or previous hunk (n marks it read), on into the next chapter',
    bind: [
      { mode: 'code', on: ['n'], do: 'next', palette: 'Next hunk, marking this one read' },
      { mode: 'code', on: ['p'], do: 'prev', palette: 'Previous hunk' },
    ],
    bar: [
      { mode: 'code', key: 'n/p', label: 'hunk' },
      { mode: 'collapsed', key: 'n/p', label: 'next/prev' },
    ],
  },
  {
    keys: 'N / P, ] / [',
    group: 'Move',
    help: 'Next or previous chapter, including optional chapters',
    bind: [
      { mode: 'code', on: ['N', ']'], do: 'nextChapter', palette: 'Next chapter' },
      { mode: 'code', on: ['P', '['], do: 'prevChapter', palette: 'Previous chapter' },
    ],
    bar: [
      { mode: 'code', key: ']/[', label: 'chapter' },
      { mode: 'collapsed', key: ']/[', label: 'chapter' },
    ],
  },
  {
    keys: 'j / k, J / K',
    group: 'Move',
    help: 'Move by line (or 10 lines) inside the hunk',
    bind: [
      { mode: 'code', on: ['j', 'down'], do: 'down', when: hunk },
      { mode: 'code', on: ['k', 'up'], do: 'up', when: hunk },
      { mode: 'code', on: ['J', 'pageDown'], do: 'pageDown', when: hunk },
      { mode: 'code', on: ['K', 'pageUp'], do: 'pageUp', when: hunk },
    ],
  },
  {
    keys: 'c / C',
    group: 'Comment',
    help: 'Comment on the selected line or range (on your draft: edit it) / on the whole chapter',
    bind: [
      { mode: 'code', on: ['c'], do: 'comment', when: hunk, palette: 'Comment on the line or range' },
      { mode: 'code', on: ['C'], do: 'commentFlow', when: (c) => c.chapter, palette: 'Comment on the whole chapter' },
    ],
    bar: [
      { mode: 'code', key: 'c', label: (c) => (c.draft ? 'edit draft' : c.selecting ? 'comment on range' : 'comment') },
      { mode: 'collapsed', key: 'C', label: 'comment on chapter' },
    ],
  },
  {
    keys: 'v',
    group: 'Comment',
    help: 'Start or end a range selection',
    bind: [{ mode: 'code', on: ['v'], do: 'range', when: hunk, palette: 'Select a range of lines' }],
    bar: [{ mode: 'code', key: 'v', label: (c) => (c.selecting ? 'end range' : 'range') }],
  },
  { keys: 'In a comment', group: 'Comment', help: '@ people/code (@callers: @tests: @threads: …) · ctrl+x deletes your draft' },
  { keys: '  ^T', group: 'Comment', help: 'In a comment: suggest a code change with AI', ai: true },
  {
    keys: 'E / X',
    group: 'Comment',
    // Their old keys, kept for one release: the screen says where each moved.
    help: 'Old keys: c on your draft edits it; ctrl+x in the comment deletes it',
    bind: [
      { mode: 'code', on: ['E'], do: 'editDraft', when: hunk },
      { mode: 'code', on: ['X'], do: 'deleteDraft', when: hunk },
    ],
  },
  {
    keys: 'e',
    group: 'Threads',
    help: 'Read existing review threads on the selected line inline',
    bind: [{ mode: 'code', on: ['e'], do: 'thread', when: hunk, palette: 'Read the review threads on this line' }],
    bar: [{ mode: 'code', key: 'e', label: 'thread', when: (c) => c.threads }],
  },
  {
    keys: 'y',
    group: 'Threads',
    help: 'Reply to an existing review thread on the selected line',
    bind: [{ mode: 'code', on: ['y'], do: 'reply', when: (c) => c.hunk && c.reply, palette: 'Reply to the thread on this line' }],
    bar: [{ mode: 'code', key: 'y', label: 'reply', when: (c) => c.threads && c.reply }],
  },
  {
    keys: 'a',
    group: 'Ask',
    help: 'Ask the model about the selection',
    ai: true,
    bind: [{ mode: 'code', on: ['a'], do: 'ask', palette: 'Ask the model about the selection' }],
    bar: [
      { mode: 'code', key: 'a', label: 'ask', when: (c) => c.agent },
      { mode: 'tests', key: 'a', label: 'ask', when: (c) => c.agent },
    ],
  },
  {
    keys: 't',
    group: 'View',
    help: 'Focus the test pane (narrow terminals: toggle source/tests)',
    bind: [{ mode: 'code', on: ['t'], do: 'focusTests', palette: 'Focus the linked tests' }],
    bar: [{ mode: 'code', key: 't', label: 'tests', when: (c) => c.tests }],
  },
  {
    keys: 'Focused tests',
    group: 'View',
    help: 'n/p test · j/k line · c comment · a ask · t/Esc back to source',
    bind: [
      { mode: 'tests', on: ['escape', 't'], do: 'leaveTests' },
      { mode: 'tests', on: ['j', 'down'], do: 'testDown' },
      { mode: 'tests', on: ['k', 'up'], do: 'testUp' },
      { mode: 'tests', on: ['J', 'pageDown'], do: 'testPageDown' },
      { mode: 'tests', on: ['K', 'pageUp'], do: 'testPageUp' },
      { mode: 'tests', on: ['n', 'tab'], do: 'nextTest' },
      { mode: 'tests', on: ['p'], do: 'prevTest' },
      { mode: 'tests', on: ['c'], do: 'commentTest' },
      { mode: 'tests', on: ['a'], do: 'askTest' },
    ],
    bar: [
      { mode: 'tests', key: 'n/p', label: 'test' },
      { mode: 'tests', key: 'c', label: 'comment' },
    ],
  },
  {
    keys: 'd',
    group: 'View',
    help: 'Chapter diagram (select a node to jump to its code)',
    bind: [{ mode: 'code', on: ['d'], do: 'diagram', palette: 'Chapter diagram' }],
    bar: [{ mode: 'code', key: 'd', label: 'diagram', when: (c) => c.diagram }],
  },
  {
    keys: '+ / -',
    group: 'View',
    help: 'Show 10 more or fewer lines of the file around the hunk',
    bind: [
      { mode: 'code', on: ['+', '='], do: 'moreContext', when: hunk, palette: 'More lines around the hunk' },
      { mode: 'code', on: ['-'], do: 'lessContext', when: hunk, palette: 'Fewer lines around the hunk' },
    ],
    bar: [{ mode: 'code', key: '+/-', label: 'context' }],
  },
  {
    keys: 'x / z / u',
    group: 'Read',
    help: 'Mark the hunk skipped / deferred / unread',
    bind: [
      { mode: 'code', on: ['x'], do: 'skip', when: hunk, palette: 'Skip this hunk' },
      { mode: 'code', on: ['z'], do: 'defer', when: hunk, palette: 'Defer this hunk' },
      { mode: 'code', on: ['u'], do: 'unread', when: hunk, palette: 'Mark this hunk unread' },
    ],
    bar: [{ mode: 'code', key: 'x', label: 'skip' }],
  },
  { keys: 'f', group: 'Read', help: 'Cycle Guided, Risk first, Small first, and File order', bind: [{ mode: 'code', on: ['f'], do: 'order', palette: 'Change the chapter order' }] },
  {
    keys: 'D',
    group: 'Read',
    help: 'Re-review: switch between only new and changed hunks and the full review',
    bind: [{ mode: 'code', on: ['D'], do: 'delta', when: (c) => c.rereview, palette: 'Changes only, or the full review' }],
  },
  {
    keys: 'S',
    group: 'Settings',
    help: 'Split view (old beside new) or inline',
    bind: [{ mode: 'code', on: ['S'], do: 'split', palette: 'Split view: old beside new, or inline' }],
  },
  { keys: 'w', group: 'Settings', help: 'Hide or show whitespace-only changes', bind: [{ mode: 'code', on: ['w'], do: 'whitespace', palette: 'Hide or show whitespace-only changes' }] },
  { keys: 'r', group: 'Settings', help: 'Raw unified diff for the hunk', bind: [{ mode: 'code', on: ['r'], do: 'raw', when: hunk, palette: 'Raw unified diff' }] },
  { keys: 'T', group: 'Settings', help: 'Hide or show the test pane beside the code', bind: [{ mode: 'code', on: ['T'], do: 'testPane', palette: 'Hide or show the test pane' }] },
  { keys: 'U', group: 'Settings', help: 'Expand or collapse possible test gaps in the explanation', bind: [{ mode: 'code', on: ['U'], do: 'untested', palette: 'Show or hide possible test gaps' }] },
  { keys: 'm', group: 'Settings', help: 'Move the hunk to another chapter', bind: [{ mode: 'code', on: ['m'], do: 'move', when: hunk, palette: 'Move this hunk to another chapter' }] },
  { keys: 'i', group: 'Settings', help: 'Team checklist for this chapter', bind: [{ mode: 'code', on: ['i'], do: 'checklist', palette: 'Team checklist' }] },
  {
    keys: 'R',
    group: 'Settings',
    help: 'Rebuild the tour on a newer PR head after the author pushes',
    bind: [{ mode: 'code', on: ['R'], do: 'rebase', when: (c) => c.rebase, palette: 'Rebuild on the new head' }],
  },
  {
    keys: 'o',
    group: 'Settings',
    help: 'Open the hunk in your coding agent (set in gr config)',
    bind: [{ mode: 'code', on: ['o'], do: 'openInAgent', palette: 'Open the hunk in your coding agent' }],
  },
  {
    keys: 'L',
    group: 'Settings',
    help: 'Color theme (previews as you move through the list)',
    bind: [{ mode: 'code', on: ['L'], do: 'theme', when: (c) => c.theme, palette: 'Color theme' }],
  },
  {
    keys: ':',
    group: 'Go',
    help: 'Command palette: every action here, and go to a file or chapter',
    bind: [{ mode: 'any', on: [':'], do: 'palette' }],
  },
  {
    keys: 'b / s',
    group: 'Go',
    help: 'Briefing / submit screen',
    bind: [
      { mode: 'any', on: ['b'], do: 'briefing', palette: 'Briefing' },
      { mode: 'code', on: ['s'], do: 'submit', palette: 'Submit the review' },
    ],
    bar: [
      { mode: 'code', key: 's', label: 'submit', when: (c) => c.done },
      { mode: 'collapsed', key: 's', label: 'submit', when: (c) => c.done },
    ],
  },
  // The key bar's end names it; h is its old key.
  { keys: '? / h', bind: [{ mode: 'any', on: ['?', 'h'], do: 'help' }] },
  {
    keys: 'esc / q, Q',
    group: 'Go',
    help: 'Back to the briefing (esc first clears a range) / quit (progress is saved)',
    bind: [
      { mode: 'code', on: ['escape'], do: 'escape' },
      { mode: 'any', on: ['q'], do: 'briefing' },
      { mode: 'any', on: ['Q'], do: 'quit' },
    ],
  },
  // A collapsed chapter's summary, described by its own key bar.
  {
    keys: 'enter',
    bind: [
      { mode: 'collapsed', on: ['j', 'down'], do: 'summaryDown' },
      { mode: 'collapsed', on: ['k', 'up'], do: 'summaryUp' },
      { mode: 'collapsed', on: ['return', 'e'], do: 'expand' },
      { mode: 'collapsed', on: ['x'], do: 'skipChapter' },
    ],
    bar: [
      { mode: 'collapsed', key: 'enter', label: 'expand' },
      { mode: 'collapsed', key: 'x', label: 'skip chapter' },
    ],
  },
];

// The key bar's order in each view, in groups the bar separates: most useful first.
const BAR_ORDER: Record<View, string[][]> = {
  code: [['s'], ['n/p', ']/['], ['c', 'a', 'e', 'y', 'v'], ['t', 'd', '+/-'], ['x']],
  collapsed: [['s'], ['enter', 'n/p', ']/['], ['C', 'x']],
  tests: [['n/p'], ['c', 'a']],
};

const BINDINGS = KEYS.flatMap((r) => r.bind ?? []);
const BAR = KEYS.flatMap((r) => r.bar ?? []);

// Collapsed-summary keys take precedence over the code keys they fall back to.
const SEARCH: Record<View, Mode[]> = { code: ['any', 'code'], collapsed: ['any', 'collapsed', 'code'], tests: ['any', 'tests'] };

const named = (k: KeyName): k is keyof typeof NAMED => Object.hasOwn(NAMED, k);
const pressed = (k: KeyName, input: string, key: Key) => (named(k) ? key[NAMED[k]] : input === k);

export function keyAction(view: View, c: KeyCtx, input: string, key: Key): Action | undefined {
  for (const mode of SEARCH[view]) {
    const b = BINDINGS.find((b) => b.mode === mode && b.on.some((k) => pressed(k, input, key)) && (b.when?.(c) ?? true));
    if (b) return b.do;
  }
  return undefined;
}

// The key bar shows only keys that do something here, most useful first; the rest are under ?.
export function barKeys(view: View, c: KeyCtx): Hint[] {
  return BAR_ORDER[view].flatMap((group, g) =>
    group.flatMap((k) => BAR.filter((b) => b.mode === view && b.key === k && (b.when?.(c) ?? true)).map((b): Hint => [b.key, typeof b.label === 'string' ? b.label : b.label(c), String(g)])),
  );
}

// Every key bound anywhere, as typed: for checking the docs.
export const boundKeys = (): string[] => [...new Set(BINDINGS.flatMap((b) => b.on.filter((k) => !named(k))))];

// The key bar's right end: how to get back, and to everything else.
export function barEnd(view: View, c: KeyCtx): [string, string][] {
  if (view === 'tests')
    return [
      ['t/esc', 'back to code'],
      ['?', 'keys'],
    ];
  return [...(c.rereview ? [['D', c.deltaOnly ? 'full review' : 'changes only'] as [string, string]] : []), ['esc', 'back'], ['?', 'keys']];
}

// The help's sections: the rows with a help line, grouped. Rows that need the model are left out
// without one.
export function chapterHelp(ai: boolean): { title: string; rows: [string, string][] }[] {
  const sections: { title: string; rows: [string, string][] }[] = [];
  for (const r of KEYS) {
    if (!r.help || (r.ai && !ai)) continue;
    const title = r.group ?? 'Keys';
    let section = sections.find((x) => x.title === title);
    if (!section) sections.push((section = { title, rows: [] }));
    section.rows.push([r.keys.trim(), ai ? r.help : r.help.replace(' · a ask', '')]);
  }
  return sections;
}

// The palette's commands in this view: every binding with a palette label that applies now, with
// the key that runs it.
export function paletteCommands(view: View, c: KeyCtx): { label: string; key: string; action: Action }[] {
  const out: { label: string; key: string; action: Action }[] = [];
  for (const mode of SEARCH[view])
    for (const b of BINDINGS) if (b.mode === mode && b.palette && (b.when?.(c) ?? true) && !out.some((o) => o.action === b.do)) out.push({ label: b.palette, key: b.on[0], action: b.do });
  return out;
}
