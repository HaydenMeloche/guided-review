import { describe, expect, it } from 'vitest';
import { extractTestCases, lineAt, lineStarts } from '../src/analysis/tests.js';

// The original linear scan: 1 + newlines before idx.
const naive = (src: string, idx: number) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};

describe('lineStarts / lineAt', () => {
  it('matches a linear newline count at every offset', () => {
    for (const src of ['', 'a', '\n', 'a\n', '\n\n\nx', 'one\ntwo\n\nthree\n', 'x\r\ny\n']) {
      const starts = lineStarts(src);
      for (let i = -2; i <= src.length + 2; i++) expect(lineAt(starts, i), `${JSON.stringify(src)} @${i}`).toBe(naive(src, i));
    }
  });

  it('matches on random text', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const src = Array.from({ length: 5000 }, () => (rand() < 0.1 ? '\n' : 'x')).join('');
    const starts = lineStarts(src);
    for (let k = 0; k < 500; k++) {
      const i = Math.floor(rand() * (src.length + 1));
      expect(lineAt(starts, i)).toBe(naive(src, i));
    }
  });

  it('keeps test case line numbers when several files are scanned in turn', () => {
    const a = "describe('a', () => {\n  it('one', () => {\n    x();\n  });\n\n  it('two', () => {});\n});\n";
    const b = "\n\ntest('b', () => {\n  y();\n});\n";
    const lines = (f: string, c: string) => extractTestCases(f, c).map((t) => [t.name, t.startLine, t.endLine]);
    const first = lines('a.test.ts', a);
    expect(first).toEqual([
      ['a > one', 2, 4],
      ['a > two', 6, 6],
    ]);
    expect(lines('b.test.ts', b)).toEqual([['b', 3, 5]]);
    expect(lines('a.test.ts', a)).toEqual(first);
  });
});
