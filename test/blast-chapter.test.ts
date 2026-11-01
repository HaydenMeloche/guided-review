import { describe, expect, it } from 'vitest';
import { callersLine } from '../src/tui/chapter/guide.js';
import { chapterPrompt } from '../src/agent/prompts.js';
import { chapter, hunk, tour } from './fixtures/tour.js';

const use = (file: string, line: number) => ({ file, line, text: 'parse(x)' });

describe('callersLine', () => {
  it('counts each place once and warns when a signature changed', () => {
    expect(
      callersLine([
        { symbol: 'parse', hunkId: 'h1', change: 'signature', callers: [use('a.ts', 1), use('b.ts', 2)] },
        { symbol: 'Parser.parse', hunkId: 'h1', callers: [use('a.ts', 1)] },
      ]),
    ).toEqual({ text: '▲ Signature changed: 2 uses in unchanged files · B: list', warn: true });
  });

  it('is quiet for a change inside a body, and absent with no uses', () => {
    expect(callersLine([{ symbol: 'parse', hunkId: 'h1', callers: [use('a.ts', 1)] }])).toEqual({ text: '1 use in unchanged files · B: list', warn: false });
    expect(callersLine([])).toBeUndefined();
  });
});

describe('chapterPrompt', () => {
  it('lists the uses in unchanged files of what the chapter changes', () => {
    const h = hunk('h1', 'src/parse.ts', [{ kind: 'add', text: 'export function parse(x, opts) {', newLine: 1 }]);
    const callers = Array.from({ length: 7 }, (_, i) => use(`src/u${i}.ts`, i + 1));
    const t = tour([h], [{ hunkIds: ['h1'] }], {
      blastRadius: [
        { symbol: 'parse', hunkId: 'h1', change: 'signature', callers },
        { symbol: 'other', hunkId: 'h9', callers: [use('z.ts', 1)] },
      ],
    });
    const p = chapterPrompt(t, t.chapters[0]);
    expect(p).toContain('- parse (hunk h1, signature changed):\n  - src/u0.ts:1: parse(x)');
    expect(p).toContain('  - … 2 more');
    expect(p).not.toContain('z.ts');
    expect(chapterPrompt(tour([h], [{ hunkIds: ['h1'] }]), chapter('c0', ['h1']))).not.toContain('Uses in unchanged files');
  });
});
