import { describe, expect, it } from 'vitest';
import { callersLine, explanation } from '../src/tui/chapter/guide.js';
import { chapterPrompt } from '../src/agent/prompts.js';
import { chapter, filesFor, hunk, tour } from './fixtures/tour.js';

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

describe('explanation of a collapsed chapter', () => {
  const text = (summary: string, files: { path: string; summary?: string }[]) => {
    const hs = files.map((f, i) => hunk(`h${i}`, f.path, [{ kind: 'add', text: 'x', newLine: 1 }]));
    const t = tour(hs, [{ hunkIds: hs.map((h) => h.id), collapsed: true, summary }], {
      files: filesFor(hs).map((f, i) => ({ ...f, summary: files[i].summary })),
    });
    const lines = explanation({ tour: t, chapter: t.chapters[0], hi: -1, collapsed: true, files: new Map(t.files.map((f) => [f.path, f])), linkedTests: false, showUntested: false }, 80);
    return lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  };

  it('leaves out the per-file lines the file list shows', () => {
    const files = [
      { path: 'gen/A.java', summary: '2 generated lines added (generated-code header)' },
      { path: 'gen/B.java', summary: '4 generated lines added (generated-code header)' },
    ];
    expect(text(files.map((f) => `${f.path}: ${f.summary}`).join('\n'), files)).not.toContain('gen/');
    expect(text(files[0].summary, [files[0]])).not.toContain('generated lines');
  });

  it('keeps a summary written as prose', () => {
    expect(text('2 hunk(s) that only add, remove or reorder imports.', [{ path: 'a.ts' }, { path: 'b.ts' }])).toContain('only add, remove or reorder imports');
  });
});
