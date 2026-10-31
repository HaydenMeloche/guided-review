import { describe, expect, it } from 'vitest';
import type { Chapter } from '../src/types.js';
import { matcher, searchTour } from '../src/tui/chapter/search.js';
import { diffLines, hunk } from './fixtures/tour.js';

const chapter = (id: string, hunkIds: string[], extra: Partial<Chapter> = {}): Chapter => ({ id, title: id, kind: 'flow', hunkIds, summary: '', ...extra }) as Chapter;

describe('searchTour', () => {
  const a = hunk('a', 'src/a.ts', diffLines([' const retryCount = 0;', '+if (job.retryCount > 3) {', '-old'], 10), { narration: 'Caps retryCount at three.' });
  const b = hunk('b', 'src/b.ts', diffLines(['+job.retryCount += 1;'], 4), { narration: 'Caps retryCount at three.', narrationShared: true });
  const tour = { hunks: { a, b } };
  const chapters = [chapter('one', ['a']), chapter('two', ['b'], { collapsed: true })];

  it('lists changed lines, then context, then explanations, each once', () => {
    const { hits, total } = searchTour(tour, chapters, 'retrycount');
    expect(hits.map((h) => [h.kind, h.where])).toEqual([
      ['add', 'src/a.ts:11'],
      ['add', 'src/b.ts:4'],
      ['ctx', 'src/a.ts:10'],
      ['explanation', 'src/a.ts'],
      ['explanation', 'src/b.ts'],
    ]);
    expect(total).toBe(5);
    expect(hits[0]).toMatchObject({ ci: 0, page: 0, line: 1, at: 8 });
    // A collapsed chapter is read on its summary.
    expect(hits[1]).toMatchObject({ ci: 1, page: -1 });
  });

  it('matches any case in lowercase and exactly with a capital', () => {
    expect(matcher('retry')!('RetryCount')).toBe(0);
    expect(matcher('Retry')!('retryCount')).toBe(-1);
    expect(matcher('')).toBeUndefined();
    expect(searchTour(tour, chapters, 'nothing here').hits).toEqual([]);
  });
});
