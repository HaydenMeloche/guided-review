import { describe, expect, it } from 'vitest';
import { INLINE_ROWS, inlineComposerSlot } from '../src/tui/AiSuggestion.js';
import { initComposer } from '../src/tui/composer.js';
import type { Draft, Tour } from '../src/types.js';

const draft: Draft = {
  id: 'd1',
  repo: 'acme/shop',
  pr: 1,
  headSha: 'abc',
  anchor: { type: 'line', hunkId: 'h1', file: 'a.ts', line: 3, side: 'RIGHT' },
  label: 'question',
  body: 'Look at ',
  posted: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const tour = {} as Tour;

describe('inline composer slot', () => {
  it('keeps its usual rows with no list open', () => {
    expect(inlineComposerSlot(initComposer(draft), tour, 40, 80)).toEqual({ height: INLINE_ROWS });
  });

  it('takes most of the pane while the @ list is open, and gives the rest of the body to the list', () => {
    const st = { ...initComposer(draft), listOpen: true };
    const slot = inlineComposerSlot(st, tour, 40, 80);
    expect(slot.height).toBe(30);
    expect(slot.listRows).toBe(30 - 8); // border, header, labels, margin, one body row, and the footer
    // A short pane never shrinks the slot below its usual rows.
    expect(inlineComposerSlot(st, tour, 10, 80).height).toBe(INLINE_ROWS);
  });

  it('leaves room for a suggestion under the body', () => {
    const st = { ...initComposer(draft), listOpen: true, suggestion: 'a\nb' };
    expect(inlineComposerSlot(st, tour, 40, 80).listRows).toBe(30 - 11);
  });
});
