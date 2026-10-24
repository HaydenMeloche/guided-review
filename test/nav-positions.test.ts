import { describe, expect, it } from 'vitest';
import type { Chapter } from '../src/types.js';
import { firstHunk, nextPos, prevPos, summaryHunkIds } from '../src/tui/nav.js';

const ch = (id: string, hunks: number, extra: Partial<Chapter> = {}) => ({ id, hunkIds: Array.from({ length: hunks }, (_, i) => `${id}${i}`), ...extra }) as Chapter;
const chapters = [ch('a', 2), ch('imports', 1, { optional: true }), ch('lock', 3, { collapsed: true }), ch('b', 1)];

describe('nextPos and prevPos', () => {
  it('steps through hunks, then to the next chapter that is not optional', () => {
    expect(nextPos(chapters, 0, 0)).toEqual({ ci: 0, hi: 1 });
    expect(nextPos(chapters, 0, 1)).toEqual({ ci: 2, hi: -1 });
    expect(nextPos(chapters, 2, -1)).toEqual({ ci: 3, hi: 0 });
    expect(nextPos(chapters, 2, 1)).toEqual({ ci: 2, hi: 2 });
    expect(nextPos(chapters, 3, 0)).toBeUndefined();
  });

  it('steps back through hunks, a collapsed summary, and the end of the previous chapter', () => {
    expect(prevPos(chapters, 3, 0)).toEqual({ ci: 2, hi: -1 });
    expect(prevPos(chapters, 2, 0)).toEqual({ ci: 2, hi: -1 });
    expect(prevPos(chapters, 2, -1)).toEqual({ ci: 0, hi: 1 });
    expect(prevPos(chapters, 0, 0)).toBeUndefined();
  });

  it('starts a collapsed chapter on its summary', () => {
    expect(firstHunk(chapters, 2)).toBe(-1);
    expect(firstHunk(chapters, 0)).toBe(0);
    expect(firstHunk(chapters, 9)).toBe(0);
  });
});

describe('a chapter with folded hunks', () => {
  // Two manifest hunks, then two lockfile hunks behind the summary page.
  const deps = ch('deps', 4, { folded: ['deps2', 'deps3'] });
  const list = [ch('a', 1), deps, ch('b', 1)];

  it('opens on the summary, then steps through the other hunks and leaves', () => {
    expect(nextPos(list, 0, 0)).toEqual({ ci: 1, hi: -1 });
    expect(nextPos(list, 1, -1)).toEqual({ ci: 1, hi: 0 });
    expect(nextPos(list, 1, 0)).toEqual({ ci: 1, hi: 1 });
    expect(nextPos(list, 1, 1)).toEqual({ ci: 2, hi: 0 });
  });

  it('steps through folded hunks opened from the summary on their own', () => {
    expect(nextPos(list, 1, 2)).toEqual({ ci: 1, hi: 3 });
    expect(nextPos(list, 1, 3)).toEqual({ ci: 2, hi: 0 });
    expect(prevPos(list, 1, 2)).toEqual({ ci: 1, hi: -1 });
  });

  it('steps back to the summary, and from the next chapter to the last hunk that is not folded', () => {
    expect(prevPos(list, 2, 0)).toEqual({ ci: 1, hi: 1 });
    expect(prevPos(list, 1, 1)).toEqual({ ci: 1, hi: 0 });
    expect(prevPos(list, 1, 0)).toEqual({ ci: 1, hi: -1 });
    expect(prevPos(list, 1, -1)).toEqual({ ci: 0, hi: 0 });
  });

  it('lists the folded hunks on the summary page', () => {
    expect(summaryHunkIds(deps)).toEqual(['deps2', 'deps3']);
    expect(summaryHunkIds(chapters[2])).toEqual(['lock0', 'lock1', 'lock2']);
  });
});
