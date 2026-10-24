import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { docKeys, helpOf, type KeyDef } from '../src/tui/keys.js';
import { CHECK_LOG_KEYS, CHECKS_KEYS, MERGE_KEYS, PICKER_KEYS, REVIEW_BRIEFING_KEYS, SUBMIT_KEYS, mergeBar, pickerBar } from '../src/tui/screenKeys.js';

// The bar's hints without their groups.
const pairs = (hints: [string, string, string?][]) => hints.map(([k, label]) => [k, label]);

const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const usage = read('../docs/usage.md');
const section = (from: string, to: string) => usage.slice(usage.indexOf(from), usage.indexOf(to));

// Every `input === 'x'` a screen's handlers read, leaving out the Ctrl chords.
function literals(src: string): Set<string> {
  const plain = src.replace(/key\.ctrl && input === '.'/g, '');
  return new Set([...plain.matchAll(/input === '(.)'/g)].map((m) => m[1]));
}
const chars = (defs: KeyDef<never>[]) => new Set(defs.flatMap((d) => d.keys.filter((k) => k.length === 1)));

const screens: [string, string, KeyDef<never>[], string][] = [
  ['the PR list', '../src/tui/PickerScreen.tsx', PICKER_KEYS, section('## Pick a PR', '## Read the tour')],
  ['the briefing', '../src/tui/BriefingScreen.tsx', REVIEW_BRIEFING_KEYS, section('## Read the tour', '### Change-aware chapters')],
  ['the submit screen', '../src/tui/SubmitScreen.tsx', SUBMIT_KEYS, section('## Draft and submit comments', '## Review after a new push')],
  ['the merge dialog', '../src/tui/MergeScreen.tsx', MERGE_KEYS, section('## Merge a PR', '## Preview your own branch')],
  ['checks', '../src/tui/ChecksScreen.tsx', [...CHECKS_KEYS, ...CHECK_LOG_KEYS] as KeyDef<never>[], section('## Checks', '## Merge a PR')],
];

describe('screen keys', () => {
  for (const [name, file, defs, docs] of screens) {
    it(`lists every key ${name} reads`, () => {
      const known = chars(defs);
      // y answers a confirmation; the prompt names it.
      const unlisted = [...literals(read(file))].filter((k) => !known.has(k) && k !== 'y');
      expect(unlisted).toEqual([]);
    });

    it(`has every key ${name} lists in docs/usage.md`, () => {
      const missing = docKeys(defs).filter((k) => !docs.includes(`\`${k}\``));
      expect(missing).toEqual([]);
    });
  }

  it('groups the help in the order the groups first appear', () => {
    expect(helpOf(PICKER_KEYS).map((s) => s.title)).toEqual(['Open', 'Move', 'PR', 'Download', 'App']);
    expect(helpOf(PICKER_KEYS)[0].rows).toEqual([['enter', 'Open the tour, or the feedback on your own PR']]);
  });

  it('shows only the keys that apply in the bar', () => {
    expect(pairs(pickerBar({ items: false, filter: true, merge: true, checks: true, reviewers: false, theme: false })).map(([k]) => k)).toEqual(['/', 'r']);
    const base = { canMerge: true, waitingDraft: false, methods: true, message: true, agent: false, canMarkReady: false, canUpdate: false, base: 'main' };
    expect(pairs(mergeBar(base)).map(([k]) => k)).toEqual(['P', 'm', 'e', 'b']);
    expect(pairs(mergeBar({ ...base, waitingDraft: true })).map(([k]) => k)).toEqual(['x', 'm']);
    expect(pairs(mergeBar({ ...base, canMerge: false, canUpdate: true }))).toEqual([['u', 'update from main']]);
  });
});
