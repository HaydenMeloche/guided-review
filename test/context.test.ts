import { describe, expect, it } from 'vitest';
import { fileLines, withContext } from '../src/diff/context.js';
import { hunkFromDiff } from './fixtures/tour.js';

describe('expanding context', () => {
  const head = fileLines(Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
  const h = hunkFromDiff('src/a.ts', ' l10', '-old', '+l11', ' l12');
  // Renumber to sit at line 10 of the file.
  for (const l of h.lines) {
    if (l.oldLine) l.oldLine += 9;
    if (l.newLine) l.newLine += 9;
  }

  it('adds head lines on both sides, numbered on both sides and marked expanded', () => {
    const { hunk, above, below } = withContext(h, head, 3, 2);
    expect([above, below]).toEqual([3, 2]);
    expect(hunk.id).toBe(h.id);
    expect(hunk.lines.slice(0, 3).map((l) => [l.oldLine, l.newLine, l.text, l.expanded])).toEqual([
      [7, 7, 'l7', true],
      [8, 8, 'l8', true],
      [9, 9, 'l9', true],
    ]);
    expect(hunk.lines.slice(-2).map((l) => l.text)).toEqual(['l13', 'l14']);
  });

  it('stops at the file edges and at neighbouring hunks', () => {
    expect(withContext(h, head, 100, 100).above).toBe(9);
    expect(withContext(h, head, 100, 100).below).toBe(28);
    const bounded = withContext(h, head, 100, 100, { prevEnd: 5, nextStart: 20 });
    expect([bounded.above, bounded.below]).toEqual([4, 7]);
  });
});
