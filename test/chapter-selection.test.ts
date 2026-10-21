import { describe, expect, it } from 'vitest';
import type { Chapter, DiffLine } from '../src/types.js';
import { anchorLines, crossesContext, describeAnchor, lineAnchor, newDraft, selectedCode, selRange, testLineAnchor } from '../src/tui/chapter/selection.js';
import { diffLines, hunk } from './fixtures/tour.js';

// Two diff lines, three lines of expanded context, then two more diff lines.
const ctx = (n: number): DiffLine => ({ kind: 'ctx', text: `ctx ${n}`, oldLine: n, newLine: n, expanded: true });
const fused = hunk('h1', 'src/a.ts', [
  { kind: 'ctx', text: 'one', oldLine: 1, newLine: 1 },
  { kind: 'add', text: 'two', newLine: 2 },
  ctx(3),
  ctx(4),
  ctx(5),
  { kind: 'del', text: 'six', oldLine: 6 },
  { kind: 'add', text: 'six!', newLine: 6 },
]);

describe('selRange', () => {
  it('is the cursor alone without an anchor, else ordered ends', () => {
    expect(selRange(4, null)).toEqual([4, 4]);
    expect(selRange(4, 1)).toEqual([1, 4]);
    expect(selRange(1, 4)).toEqual([1, 4]);
  });
});

describe('anchorLines and crossesContext', () => {
  it('drops expanded context at the ends of the selection', () => {
    expect(anchorLines(fused, [1, 4]).map((l) => l.text)).toEqual(['two']);
    expect(crossesContext(fused, [1, 4])).toBe(false);
  });

  it('flags expanded context between commentable lines', () => {
    expect(crossesContext(fused, [1, 5])).toBe(true);
    expect(crossesContext(fused, [0, 6])).toBe(true);
  });

  it('a selection of only expanded context has nothing to anchor and crosses nothing', () => {
    expect(anchorLines(fused, [2, 4])).toEqual([]);
    expect(crossesContext(fused, [2, 4])).toBe(false);
    expect(lineAnchor(fused, [2, 4])).toBeUndefined();
  });
});

describe('lineAnchor', () => {
  const h = hunk('h2', 'src/b.ts', diffLines([' keep', '-old a', '-old b', '+new a', ' tail'], 10));

  it('anchors a single new or context line on the right', () => {
    expect(lineAnchor(h, [0, 0])).toEqual({ type: 'line', hunkId: 'h2', file: 'src/b.ts', line: 10, side: 'RIGHT' });
    expect(lineAnchor(h, [3, 3])).toEqual({ type: 'line', hunkId: 'h2', file: 'src/b.ts', line: 11, side: 'RIGHT' });
  });

  it('anchors removed lines alone on the left, by old line numbers', () => {
    expect(lineAnchor(h, [1, 1])).toEqual({ type: 'line', hunkId: 'h2', file: 'src/b.ts', line: 11, side: 'LEFT' });
    expect(lineAnchor(h, [1, 2])).toEqual({ type: 'range', hunkId: 'h2', file: 'src/b.ts', startLine: 11, line: 12, side: 'LEFT' });
  });

  it('prefers the right side when the range holds any new code, ignoring the removed lines', () => {
    expect(lineAnchor(h, [1, 3])).toEqual({ type: 'line', hunkId: 'h2', file: 'src/b.ts', line: 11, side: 'RIGHT' });
    expect(lineAnchor(h, [0, 4])).toEqual({ type: 'range', hunkId: 'h2', file: 'src/b.ts', startLine: 10, line: 12, side: 'RIGHT' });
  });

  it('leaves expanded context at the ends out of the range', () => {
    expect(lineAnchor(fused, [1, 4])).toEqual({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 2, side: 'RIGHT' });
  });
});

describe('selectedCode', () => {
  it('is the new side of the selection, without removed lines or expanded context', () => {
    expect(selectedCode(fused, [0, 1])).toBe('one\ntwo');
    expect(selectedCode(fused, [5, 6])).toBe('six!');
    expect(selectedCode(fused, [1, 4])).toBe('two');
  });
});

describe('testLineAnchor', () => {
  const test = hunk('t1', 'test/a.test.ts', [...diffLines([' it()', '-old()', '+new()'], 20), ctx(23)]);
  const hunks = { t1: test, h1: fused };

  it('anchors a test line on the tour hunk that shows it, on its side', () => {
    expect(testLineAnchor(hunks, 'test/a.test.ts', test.lines[2])).toEqual({ type: 'line', hunkId: 't1', file: 'test/a.test.ts', line: 21, side: 'RIGHT' });
    expect(testLineAnchor(hunks, 'test/a.test.ts', test.lines[1])).toEqual({ type: 'line', hunkId: 't1', file: 'test/a.test.ts', line: 21, side: 'LEFT' });
  });

  it('finds nothing for lines outside every hunk, expanded context, or no file', () => {
    expect(testLineAnchor(hunks, 'test/a.test.ts', { kind: 'ctx', text: 'far', oldLine: 90, newLine: 90 })).toBeUndefined();
    expect(testLineAnchor(hunks, 'test/a.test.ts', test.lines[3])).toBeUndefined();
    expect(testLineAnchor(hunks, undefined, test.lines[2])).toBeUndefined();
    expect(testLineAnchor(hunks, 'test/a.test.ts', undefined)).toBeUndefined();
  });
});

describe('newDraft and describeAnchor', () => {
  it('starts an unposted question on the tour head', () => {
    const d = newDraft({ repo: 'acme/x', pr: 3, headSha: 'abc' }, { type: 'chapter', chapterId: 'c1' });
    expect(d).toMatchObject({ repo: 'acme/x', pr: 3, headSha: 'abc', label: 'question', body: '', posted: false, anchor: { type: 'chapter', chapterId: 'c1' } });
    expect(d.id).toMatch(/^d_/);
  });

  it('names each kind of anchor', () => {
    const chapter = { id: 'c1', title: 'Billing', diagram: { nodes: [{ id: 'n1', label: 'createInvoice' }] } } as unknown as Chapter;
    expect(describeAnchor({ type: 'line', hunkId: 'h', file: 'a.ts', line: 3, side: 'RIGHT' }, [chapter])).toBe('a.ts:3');
    expect(describeAnchor({ type: 'range', hunkId: 'h', file: 'a.ts', startLine: 3, line: 5, side: 'LEFT' }, [chapter])).toBe('a.ts:3-5');
    expect(describeAnchor({ type: 'chapter', chapterId: 'c1' }, [chapter])).toBe('flow "Billing"');
    expect(describeAnchor({ type: 'chapter', chapterId: 'gone' }, [chapter])).toBe('flow "gone"');
    expect(describeAnchor({ type: 'node', chapterId: 'c1', nodeId: 'n1' }, [chapter], chapter)).toBe('diagram node "createInvoice"');
    expect(describeAnchor({ type: 'node', chapterId: 'c1', nodeId: 'n9' }, [chapter], chapter)).toBe('diagram node "n9"');
  });
});
