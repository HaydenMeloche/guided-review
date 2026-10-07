import { describe, expect, it } from 'vitest';
import { foldedLines, pairChangedLines, wordDiff } from '../src/diff/lines.js';
import { diffLines } from './fixtures/tour.js';

describe('pairChangedLines', () => {
  it('pairs removed and added lines by position within a run', () => {
    const lines = diffLines([' a', '-b', '-c', '+B', '+C', ' d']);
    expect(pairChangedLines(lines)).toEqual([-1, 3, 4, 1, 2, -1]);
  });

  it('anchors on lines equal up to whitespace, so an inserted line does not shift the rest', () => {
    const lines = diffLines(['-if (x) {', '-  go();', '+if (x) {', '+  log();', '+    go();']);
    const partner = pairChangedLines(lines);
    expect(partner[0]).toBe(2);
    expect(partner[1]).toBe(4);
    expect(partner[3]).toBe(-1);
  });

  it('leaves unmatched lines unpaired and never pairs across context', () => {
    const lines = diffLines(['-a', ' x', '+b']);
    expect(pairChangedLines(lines)).toEqual([-1, -1, -1]);
  });
});

describe('foldedLines', () => {
  const fold = (src: string[], ignoreWhitespace = false) => {
    const lines = diffLines(src);
    return Object.fromEntries(foldedLines(lines, pairChangedLines(lines), ignoreWhitespace));
  };

  it('folds a line that only gains words into its replacement', () => {
    expect(fold(['-call(a);', '+call(a, b);'])).toEqual({ 0: 'insertion' });
  });

  it('keeps lines that lose words, gain only whitespace, or were blank', () => {
    expect(fold(['-call(a, b);', '+call(a);'])).toEqual({});
    expect(fold(['-go();', '+  go();'])).toEqual({});
    expect(fold(['-', '+go();'])).toEqual({});
  });

  it('folds whitespace-only changes only while whitespace is ignored', () => {
    expect(fold(['-  go();', '-stop();', '+    go();', '+halt();'], true)).toEqual({ 0: 'whitespace' });
  });

  it('ignoring whitespace, folds a dedented line that also gains words', () => {
    expect(fold(['-  go();', '+go(1);'])).toEqual({});
    expect(fold(['-  go();', '+go(1);'], true)).toEqual({ 0: 'insertion' });
  });
});

describe('wordDiff', () => {
  it('returns the changed words on each side', () => {
    const a = 'const total = price * qty;';
    const b = 'const total = price * quantity;';
    const d = wordDiff(a, b)!;
    expect(d.a.map(([s, e]) => a.slice(s, e))).toEqual(['qty']);
    expect(d.b.map(([s, e]) => b.slice(s, e))).toEqual(['quantity']);
  });

  it('merges changed words separated only by whitespace', () => {
    const a = 'return foo bar;';
    const b = 'return baz qux;';
    expect(wordDiff(a, b)!.b.map(([s, e]) => b.slice(s, e))).toEqual(['baz qux']);
  });

  it('always reports a pure insertion, however small the original', () => {
    const b = 'x + compute(a, b, c)';
    expect(wordDiff('x', b)!.b.map(([s, e]) => b.slice(s, e))).toEqual([' + compute(a, b, c)']);
  });

  it('gives up on rewritten lines with little in common', () => {
    expect(wordDiff('import x from "y";', 'while (true) break;')).toBeUndefined();
  });

  it('finds nothing changed in identical lines', () => {
    expect(wordDiff('a + b', 'a + b')).toEqual({ a: [], b: [] });
  });
});
