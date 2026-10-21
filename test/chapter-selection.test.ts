import { describe, expect, it } from 'vitest';
import type { Chapter, DiffLine, ExistingThread, Hunk } from '../src/types.js';
import { cursorNotes } from '../src/tui/chapter/lineNotes.js';
import { linkedTests } from '../src/tui/chapter/linkedTests.js';
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

describe('cursorNotes', () => {
  const h = hunk('h3', 'src/c.ts', diffLines([' a', '-old', '+new'], 1));
  const thread = (line: number, side: 'LEFT' | 'RIGHT') =>
    ({ id: `t${line}${side}`, path: 'src/c.ts', line: side === 'RIGHT' ? line : undefined, originalLine: line, isOutdated: side === 'LEFT', comments: [] }) as unknown as ExistingThread;
  const draft = (line: number, side: 'LEFT' | 'RIGHT', createdAt: string, posted = false) => ({
    ...newDraft({ repo: 'r', pr: 1, headSha: 's' }, { type: 'line', hunkId: 'h3', file: 'src/c.ts', line, side }),
    createdAt,
    posted,
  });
  const threads = [thread(2, 'LEFT'), thread(2, 'RIGHT')];
  const drafts = [draft(2, 'RIGHT', '2026-01-02'), draft(2, 'LEFT', '2026-01-03'), draft(2, 'RIGHT', '2026-01-04', true)];
  const partner = [-1, 2, 1];

  it('finds the notes on the cursor line’s side', () => {
    const inline = cursorNotes(h, 2, new Map(), partner, threads, drafts);
    expect(inline.threads.map((t) => t.id)).toEqual(['t2RIGHT']);
    expect(inline.draft?.createdAt).toBe('2026-01-02');
  });

  it('split, counts the removed line beside the cursor, newest unposted draft last', () => {
    const split = cursorNotes(h, 2, new Map([[1, 'beside' as const]]), partner, threads, drafts);
    expect(split.threads.map((t) => t.id)).toEqual(['t2RIGHT', 't2LEFT']);
    expect(split.draft?.createdAt).toBe('2026-01-03');
  });

  it('has nothing without a hunk', () => {
    expect(cursorNotes(undefined, 0, new Map(), [], threads, drafts)).toEqual({ threads: [], draft: undefined });
  });
});

describe('linkedTests', () => {
  it('leaves name guesses out and shows the selected test’s lines', () => {
    const tests = [
      { testFile: 'a.test.ts', testName: 'guess', source: 'naming', startLine: 1, lines: ['x'], confidence: 0.2 },
      { testFile: 'b.test.ts', testName: 'real', source: 'coverage', startLine: 10, lines: ['it()', 'expect()'], confidence: 0.9 },
    ] as unknown as Hunk['tests'];
    const linked = linkedTests(hunk('h4', 'src/d.ts', diffLines(['+x']), { tests }), 0);
    expect(linked.tests.map((t) => t.testName)).toEqual(['real']);
    expect(linked).toMatchObject({ file: 'b.test.ts', any: true });
    expect(linked.lines).toEqual([
      { kind: 'ctx', text: 'it()', newLine: 10 },
      { kind: 'ctx', text: 'expect()', newLine: 11 },
    ]);
  });

  it('shows a test hunk the code it covers', () => {
    const linked = linkedTests(hunk('h5', 'test/d.test.ts', diffLines(['+x']), { covers: { file: 'src/d.ts', startLine: 5, lines: ['fn()'] } }), 0);
    expect(linked).toMatchObject({ file: 'src/d.ts', any: true, lines: [{ kind: 'ctx', text: 'fn()', newLine: 5 }] });
  });

  it('has none without a hunk or links', () => {
    expect(linkedTests(undefined, 0)).toMatchObject({ tests: [], lines: [], any: false });
    expect(linkedTests(hunk('h6', 'src/e.ts', diffLines(['+x'])), 0).any).toBe(false);
  });
});
