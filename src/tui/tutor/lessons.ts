import { KEYS, type Action } from '../chapter/keys.js';
import { REVIEW_BRIEFING_KEYS, SUBMIT_KEYS } from '../screenKeys.js';
import type { Phase } from '../App.js';
import type { AnchorId } from './anchors.js';
import type { TutorEvent } from './bridge.js';

// The tutor's lessons (`gr tutor`), as plain data over the demo tour. The demo is written the same
// way every run, so a lesson can name a file and line and expect them on screen. Lesson text names
// actions, not letters: {next} is whatever key the chapter screen binds to `next`, so rebinding a
// key changes the text with it, and test/tutor.test.ts fails on a token that names nothing.
//
// The text calls the tool Guided Review, and its commands guided-review: `gr` is a shell alias in
// some setups (Oh My Zsh's git plugin), and a newcomer shouldn't trip on that first.

// Where a lesson starts: the briefing, or the chapter holding a file's hunk (its summary when the
// chapter opens on one), with the cursor on a line of the file when given.
export type Place = { phase: 'briefing' } | { phase: 'chapter'; file: string; line?: number };

// What a step's `when` looks at: the app's state and the screen's.
export interface TutorView {
  phase: Phase;
  ci: number;
  hi: number;
  drafts: number; // unposted
  overlay: string; // the chapter screen's open overlay, or 'none'
  testFocus: boolean;
}

// read: enter continues. event: the screen reports one of these. when: the view reaches a state.
export type Until = { read: true } | { event: TutorEvent[] } | { when: (v: TutorView) => boolean };

export interface Step {
  text: string;
  until: Until;
  point?: AnchorId; // what the callout points at; the rest of the screen is dimmed on a read step
  go?: Place; // where the step takes the reader before it shows
  press?: string; // the token whose key the key bar inverts; a do step's first event when unset
  dock?: 'top'; // a step over an open overlay sits at the top, clear of it
}

export interface Lesson {
  id: string;
  title: string;
  start: Place;
  steps: Step[];
}

const read = { read: true } as const;
const on = (...events: TutorEvent[]): Until => ({ event: events });
const when = (f: (v: TutorView) => boolean): Until => ({ when: f });

const ROUTES = 'src/routes.ts';
const DOCS = 'https://haydenmeloche.github.io/guided-review/usage.html';
const PRICING = 'src/pricing.ts';
const STAFF50 = 18; // src/pricing.ts on the demo branch: { code: 'STAFF50', percent: 50, minCents: 0 }

export const LESSONS: Lesson[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    start: { phase: 'briefing' },
    steps: [
      {
        text: 'This is a real tour of a made-up change. You read it the way you would read a PR: the briefing first, then one chapter at a time.\n\nEvery key you learn here is the real key. Nothing you do leaves your machine.',
        until: read,
      },
      {
        point: 'briefing.chapters',
        text: 'Guided Review splits the change into chapters, each one part of the story, in the order it reads best: where the change starts, then what it calls. Moves, generated code and lockfiles get chapters of their own, so you can skim them.',
        until: read,
      },
      { point: 'keybar', text: 'Press {start} to open the first chapter.', until: when((v) => v.phase === 'chapter'), press: 'start' },
    ],
  },
  {
    id: 'where',
    title: 'Where you are',
    start: { phase: 'chapter', file: ROUTES },
    steps: [
      {
        point: 'header',
        text: 'The top line says where you are: the chapter, the hunk, and how much of the tour you have read. A hunk counts once you move past it with {next}, or skip it with {skip}.',
        until: read,
      },
      {
        point: 'explain',
        text: 'Each chapter has a title, and each hunk an explanation of what it does and what to check. This one says the handler passes the code on without checking it: a risk worth your attention.',
        until: read,
      },
      {
        point: 'status',
        text: 'The status line under the code shows the hunk, the line the cursor is on, your drafts, and whether tests cover the hunk. Messages show here too.',
        until: read,
      },
    ],
  },
  {
    id: 'move',
    title: 'Move through the tour',
    start: { phase: 'chapter', file: ROUTES },
    steps: [
      { point: 'keybar', text: 'Press {next} to mark this hunk read and go to the next one.', until: on('next') },
      {
        point: 'header',
        text: 'That was the only hunk in chapter 1, so you are on to chapter 2. {prev} goes back a hunk. {skip} skips a hunk you don’t need to read, {defer} leaves it for later, and {unread} marks it unread again.',
        until: read,
      },
      { point: 'keybar', text: 'Press {nextChapter} to jump to the next chapter. {prevChapter} comes back.', until: on('nextChapter') },
      {
        point: 'header',
        text: '{order} changes the order of the chapters: risk first, small first, by file, or by commit. The guided order you are in reads the change the way it was meant to be read.',
        until: read,
      },
    ],
  },
  {
    id: 'code',
    title: 'Read the code',
    start: { phase: 'chapter', file: PRICING },
    steps: [
      { point: 'code', text: 'This is the code. Press {down} or {up} to move the cursor a line at a time.', until: on('down', 'up') },
      {
        point: 'code',
        text: '{moreContext} and {lessContext} show more or fewer lines of the file around the hunk. {split} shows the old code beside the new.',
        until: read,
      },
      { point: 'keybar', text: 'This hunk has tests. Press {focusTests} to move into them.', until: when((v) => v.testFocus), press: 'focusTests' },
      { point: 'tests', text: 'You are in the tests: {nextTest} moves between them. Press {leaveTests} to go back to the code.', until: when((v) => !v.testFocus), press: 'leaveTests' },
    ],
  },
  {
    id: 'done-for-you',
    title: 'Already done for you',
    start: { phase: 'chapter', file: 'src/receipt.ts' },
    steps: [
      {
        point: 'code',
        text: 'formatReceipt moved from orders.ts to receipt.ts without a change. Guided Review matched the removed lines to the added ones and marks them as a move, so you don’t have to read them as new code.',
        until: read,
      },
      {
        go: { phase: 'chapter', file: 'package.json' },
        point: 'code',
        text: 'Dependencies get a chapter of their own. The lockfile is folded into a list of the packages it adds and removes under the package.json change, so you never read lockfile lines.',
        until: read,
      },
      {
        go: { phase: 'chapter', file: 'src/generated/api-types.ts' },
        point: 'code',
        text: 'Generated code and import-only changes open as a summary, since there is rarely anything to review in them. Press {expand} to open the hunk anyway.',
        until: on('expand'),
      },
    ],
  },
  {
    id: 'comment',
    title: 'Leave a comment',
    start: { phase: 'chapter', file: PRICING, line: STAFF50 },
    steps: [
      { point: 'code', text: 'The cursor is on STAFF50: a code that takes half off any order, and any customer can type it. That is worth a comment.', until: read },
      {
        point: 'keybar',
        text: 'Press {comment} to comment on this line. ({range} first selects a range of lines, and {commentFlow} comments on the whole chapter.)',
        until: on('comment'),
      },
      { dock: 'top', text: 'Write your comment, then press enter to save it as a draft.', until: when((v) => v.drafts > 0 && v.overlay === 'none') },
      { point: 'status', text: 'Your draft is saved on this machine, and the status line counts it. Nothing is posted until you submit the review, all at once.', until: read },
    ],
  },
  {
    id: 'ask',
    title: 'Ask about the code',
    start: { phase: 'chapter', file: PRICING, line: STAFF50 },
    steps: [
      { point: 'keybar', text: 'Press {ask} to ask about the line under the cursor.', until: on('ask') },
      {
        dock: 'top',
        text: 'The demo answers a few prepared questions instead of running a model. Press 1 to ask the first one it suggests, or type your own and press enter.',
        until: on('answered'),
      },
      {
        dock: 'top',
        text: 'Answers name the file and line they rely on, so you can check them, and a follow-up keeps the questions before it. Press esc to close it.',
        until: when((v) => v.overlay === 'none'),
      },
    ],
  },
  {
    id: 'find',
    title: 'Find anything',
    start: { phase: 'chapter', file: PRICING },
    steps: [
      { point: 'keybar', text: 'Press {search} to search the diff and its explanations.', until: when((v) => v.overlay === 'search'), press: 'search' },
      { dock: 'top', text: 'Type a word, such as discount, and press enter to go to it, or esc to close the search.', until: when((v) => v.overlay === 'none') },
      {
        point: 'keybar',
        text: 'Press {palette} for the command palette: every action on this screen, and every chapter and file to go to.',
        until: when((v) => v.overlay === 'palette'),
        press: 'palette',
      },
      { dock: 'top', text: 'Type to filter it. When you forget a key, it is in here, and {help} lists the keys on any screen.', until: read },
    ],
  },
  {
    id: 'submit',
    title: 'Submit',
    start: { phase: 'chapter', file: PRICING },
    steps: [
      { point: 'keybar', text: 'When you have read the tour, press {submit} to see the review you would post.', until: when((v) => v.phase === 'submit'), press: 'submit' },
      {
        point: 'submit',
        text: 'This is your review: a suggested verdict, which {verdict} changes, and your drafts. A real review posts with {post}, after it asks. The demo posts nothing.',
        until: read,
      },
      {
        text: `That is the tour. To review your own PRs, open Guided Review in any repository:\n\n$ guided-review\n$ gr  the short name, if your shell has no gr alias\n\nThe first run sets it up, then lists the PRs waiting for your review. Every screen and key is in the docs:\n${DOCS}`,
        until: read,
      },
    ],
  },
];

// ---------- keys in the text ----------

const SHOWN: Record<string, string> = { escape: 'esc', return: 'enter', down: '↓', up: '↑', pageDown: 'pgdn', pageUp: 'pgup', tab: 'tab' };

// The key the chapter screen binds to an action: the one its key bar shows when it shows one (],
// not N), else the first.
function chapterKey(action: Action): string | undefined {
  for (const row of KEYS)
    for (const b of row.bind ?? []) {
      if (b.do !== action || !b.on.length) continue;
      const barred = (row.bar ?? []).flatMap((e) => e.key.split('/'));
      const k = b.on.find((x) => barred.includes(x)) ?? b.on[0];
      return SHOWN[k] ?? k;
    }
  return undefined;
}

// Keys of the other screens the lessons name.
const OTHER: Record<string, () => string | undefined> = {
  start: () => REVIEW_BRIEFING_KEYS.find((d) => d.help?.startsWith('Start reading'))?.keys[0],
  verdict: () => SUBMIT_KEYS.find((d) => d.help?.startsWith('Verdict'))?.bar?.shown,
  post: () => SUBMIT_KEYS.find((d) => d.help?.startsWith('Post the review'))?.keys[0],
};

// The key a {token} names, or undefined when it names none.
export function tokenKey(token: string): string | undefined {
  return OTHER[token]?.() ?? chapterKey(token as Action);
}

export const tokensIn = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

// The step's text in spans: plain text, and keys to draw as keys.
export function textSpans(text: string): { text: string; key?: boolean }[] {
  const out: { text: string; key?: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: tokenKey(m[1]) ?? m[1], key: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// The token whose key a do step's key bar inverts.
export function pressOf(step: Step): string | undefined {
  if (step.press) return step.press;
  return 'event' in step.until ? step.until.event.find((e) => e !== 'answered') : undefined;
}

export const isRead = (step: Step) => 'read' in step.until;
export const STEP_COUNT = LESSONS.reduce((n, l) => n + l.steps.length, 0);
