import { describe, expect, it } from 'vitest';
import { normalizeReplacement, originalLines, suggestionApplicability } from '../src/review/suggestion.js';
import type { DraftAnchor, SuggestionMeta } from '../src/types.js';
import { hunk, tour } from './fixtures/tour.js';

// h1 is a fused hunk: two GitHub hunks joined by expanded context at 13-14.
const h1 = hunk('h1', 'src/a.ts', [
  { kind: 'ctx', text: 'a', oldLine: 10, newLine: 10 },
  { kind: 'del', text: 'b', oldLine: 11 },
  { kind: 'add', text: 'B', newLine: 11 },
  { kind: 'add', text: 'C', newLine: 12 },
  { kind: 'ctx', text: 'x', oldLine: 12, newLine: 13, expanded: true },
  { kind: 'ctx', text: 'y', oldLine: 13, newLine: 14, expanded: true },
  { kind: 'add', text: 'D', newLine: 15 },
]);
const h2 = hunk('h2', 'src/a.ts', [{ kind: 'add', text: 'z', newLine: 50 }]);
const t = tour([h1, h2], []);

const line = (n: number, side: 'LEFT' | 'RIGHT' = 'RIGHT'): DraftAnchor => ({ type: 'line', hunkId: 'h1', file: 'src/a.ts', line: n, side });
const range = (startLine: number, n: number): DraftAnchor => ({ type: 'range', hunkId: 'h1', file: 'src/a.ts', startLine, line: n, side: 'RIGHT' });
const meta = (headSha: string): SuggestionMeta => ({ source: 'ai', headSha, originalHash: 'h' });

describe('suggestionApplicability', () => {
  it('accepts a RIGHT-side line in the diff', () => {
    expect(suggestionApplicability(t, line(11))).toEqual({ ok: true, startLine: 11, line: 11 });
  });

  it('accepts a range within one GitHub hunk', () => {
    expect(suggestionApplicability(t, range(10, 12))).toEqual({ ok: true, startLine: 10, line: 12 });
  });

  it('refuses the LEFT side and non-line anchors', () => {
    expect(suggestionApplicability(t, line(11, 'LEFT'))).toMatchObject({ ok: false, code: 'left-side' });
    expect(suggestionApplicability(t, { type: 'chapter', chapterId: 'c0' })).toMatchObject({ ok: false, code: 'not-line-anchor' });
  });

  it('refuses a range across the expanded context of a fused hunk, or across hunks', () => {
    expect(suggestionApplicability(t, range(12, 15))).toMatchObject({ ok: false, code: 'crosses-hunks' });
    expect(suggestionApplicability(t, range(15, 50))).toMatchObject({ ok: false, code: 'crosses-hunks' });
  });

  it('refuses a selection that ends on expanded context', () => {
    expect(suggestionApplicability(t, range(11, 13))).toMatchObject({ ok: false, code: 'expanded-context' });
    expect(suggestionApplicability(t, line(14))).toMatchObject({ ok: false, code: 'expanded-context' });
  });

  it('refuses a line not in the diff', () => {
    expect(suggestionApplicability(t, line(30))).toMatchObject({ ok: false, code: 'not-in-diff', reason: 'Line 30 is not in the diff.' });
  });

  it('refuses a suggestion written on another head unless its lines are unchanged', () => {
    expect(suggestionApplicability(t, line(11), meta(t.headSha))).toMatchObject({ ok: true });
    expect(suggestionApplicability(t, line(11), meta('a1b2c3d4'))).toMatchObject({ ok: false, code: 'head-changed' });
    expect(suggestionApplicability(t, line(11), meta('a1b2c3d4'), { originalUnchanged: true })).toEqual({ ok: true, startLine: 11, line: 11 });
  });
});

describe('originalLines', () => {
  it('takes the anchored lines on their side, skipping the other side', () => {
    expect(originalLines(h1, range(10, 12) as Extract<DraftAnchor, { type: 'range' }>)).toBe('a\nB\nC');
    expect(originalLines(h1, { type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 11, side: 'LEFT' })).toBe('b');
  });
});

describe('normalizeReplacement', () => {
  const original = '  const b = 2;';

  it('strips a surrounding fence, with or without a language', () => {
    for (const fence of ['```', '```ts', '```suggestion']) {
      const r = normalizeReplacement(original, `${fence}\n  const b = 3;\n\`\`\`\n`);
      expect(r).toEqual({ ok: true, code: '  const b = 3;', notes: ['The code fence around the proposal was removed.'] });
    }
  });

  it('rejects a fence inside the code', () => {
    expect(normalizeReplacement(original, '  a();\n```\n  b();')).toMatchObject({ ok: false });
  });

  it('converts CRLF and strips trailing whitespace and blank lines', () => {
    expect(normalizeReplacement(original, '  const b = 3;   \r\n  return b;\t\r\n\r\n\r\n')).toEqual({ ok: true, code: '  const b = 3;\n  return b;', notes: [] });
  });

  it('strips consistent + markers and rejects a diff', () => {
    expect(normalizeReplacement(original, '+  const b = 3;\n+  return b;')).toEqual({ ok: true, code: '  const b = 3;\n  return b;', notes: ['Diff + markers were removed from the proposal.'] });
    expect(normalizeReplacement('x', '+ y\n+ z')).toMatchObject({ ok: true, code: 'y\nz' });
    expect(normalizeReplacement(original, '-  const b = 2;\n+  const b = 3;')).toMatchObject({ ok: false, reason: expect.stringContaining('diff') });
  });

  it('rejects a replacement identical to the original', () => {
    expect(normalizeReplacement(original, '  const b = 2;  \n')).toEqual({ ok: false, reason: 'The proposal is identical to the selected code.' });
  });

  it('accepts an empty replacement only as a deletion', () => {
    expect(normalizeReplacement(original, '\n')).toEqual({ ok: false, reason: 'The proposal is empty.' });
    expect(normalizeReplacement(original, '', { allowEmpty: true })).toEqual({ ok: true, code: '', notes: ['The proposal deletes the selected lines.'] });
  });

  it('trims lines repeated from just outside the selection', () => {
    const r = normalizeReplacement(original, 'function f() {\n  const b = 3;\n}', { before: 'function f() {', after: '}' });
    expect(r).toEqual({ ok: true, code: '  const b = 3;', notes: ['The model included surrounding lines. They were removed from the proposal.'] });
    expect(normalizeReplacement(original, '  const b = 3;\n}', { after: '}' })).toMatchObject({ ok: true, code: '  const b = 3;' });
  });

  it('keeps a matching line when the selection itself starts with it', () => {
    expect(normalizeReplacement('}\n  x();', '}\n  y();', { before: '}' })).toEqual({ ok: true, code: '}\n  y();', notes: [] });
  });

  it('accepts a replacement with a different line count', () => {
    expect(normalizeReplacement('  a();\n  b();', '  if (ok) {\n    a();\n    b();\n  }\n  c();')).toMatchObject({ ok: true, notes: [] });
  });

  it('notes an indentation that differs from the original', () => {
    expect(normalizeReplacement(original, 'const b = 3;')).toEqual({ ok: true, code: 'const b = 3;', notes: ["The proposal's indentation differs from the selected code."] });
  });
});
