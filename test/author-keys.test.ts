import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIEFING_KEYS, docKeys, REPLY_CTRL_DOC, REPLY_CTRL_KEYS, SEND_KEYS, THREAD_KEYS, barOf, briefingBar, sendBar, threadBar, type KeyDef } from '../src/tui/author/keys.js';

// The bar's hints without their groups.
const pairs = (hints: [string, string, string?][]) => hints.map(([k, label]) => [k, label]);

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const usage = read('../docs/usage.md');
const section = usage.slice(usage.indexOf('## Respond to a review'), usage.indexOf('## Checks'));

// Every `input === 'x'` a screen's handlers read, leaving out the Ctrl chords.
function literals(src: string): Set<string> {
  const plain = src.replace(/key\.ctrl && input === '.'/g, '');
  return new Set([...plain.matchAll(/input === '(.)'/g)].map((m) => m[1]));
}
const chars = (defs: KeyDef<never>[]) => new Set(defs.flatMap((d) => d.keys.filter((k) => k.length === 1)));

const screens: [string, string, KeyDef<never>[]][] = [
  ['the thread screen', '../src/tui/author/FeedbackScreen.tsx', THREAD_KEYS],
  ['the briefing', '../src/tui/author/FeedbackBriefing.tsx', BRIEFING_KEYS],
  ['the send screen', '../src/tui/author/SendScreen.tsx', SEND_KEYS],
];

describe('feedback keys', () => {
  for (const [name, file, defs] of screens) {
    it(`lists every key ${name} reads`, () => {
      const known = chars(defs);
      // y answers a confirmation; the prompt names it.
      const unlisted = [...literals(read(file))].filter((k) => !known.has(k) && k !== 'y');
      expect(unlisted).toEqual([]);
    });

    it(`has every key ${name} lists in docs/usage.md`, () => {
      const missing = docKeys(defs).filter((k) => !section.includes(`\`${k}\``));
      expect(missing).toEqual([]);
    });
  }

  it('documents the reply editor’s Ctrl keys', () => {
    expect(REPLY_CTRL_KEYS).toHaveLength(REPLY_CTRL_DOC.length);
    expect(REPLY_CTRL_DOC.filter((k) => !section.includes(`\`${k}\``))).toEqual([]);
  });
});

describe('key bars', () => {
  const thread = { queued: false, resolved: false, queuedCount: 0, agent: false, expanded: false, showHidden: false, merge: false, copy: false };
  it('builds the thread bar from its state', () => {
    expect(pairs(threadBar(thread)).map(([k]) => k)).toEqual(['n/p', ']/[', 'y', 'space', 'Z', '+', 'o', 's', 'e', 'H', 'b']);
    const full = pairs(threadBar({ queued: true, resolved: true, queuedCount: 2, agent: true, expanded: true, showHidden: true, merge: true, copy: true }));
    expect(full).toContainEqual(['y', 'edit reply']);
    expect(full).toContainEqual(['Z', 'unresolve']);
    expect(full).toContainEqual(['s', 'send 2']);
    expect(full).toContainEqual(['a', 'ask']);
    expect(full).toContainEqual(['e', 'show code']);
    expect(full).toContainEqual(['H', 'hide resolved']);
    expect(full.at(-1)).toEqual(['Y', 'copy link']);
  });

  it('builds the briefing and send bars', () => {
    expect(pairs(briefingBar({ queuedCount: 0, comment: false, merge: false, reviewers: false, copy: false, theme: false }))).toEqual([
      ['n', 'start'],
      ['enter', 'open'],
      ['j/k', 'select'],
      ['s', 'send'],
      ['t', 'full tour'],
      ['R', 'refresh'],
    ]);
    expect(pairs(briefingBar({ queuedCount: 0, comment: false, merge: false, reviewers: true, copy: false, theme: false }))).toContainEqual(['A', 'reviewers']);
    expect(pairs(sendBar({ candidates: false })).map(([k]) => k)).toEqual(['P', 'esc', 'j/k', 'e', 'z', 'x']);
    expect(pairs(sendBar({ candidates: true })).at(-1)).toEqual(['r', 're-request']);
    expect(barOf([], {})).toEqual([]);
  });
});
