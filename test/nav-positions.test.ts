import { describe, expect, it } from 'vitest';
import type { Chapter } from '../src/types.js';
import { firstHunk, nextPos, prevPos } from '../src/tui/nav.js';

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
