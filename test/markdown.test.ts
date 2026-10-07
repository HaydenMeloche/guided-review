import { describe, expect, it } from 'vitest';
import { plainText, renderMarkdown, wrapSpans } from '../src/tui/markdown.js';

const text = (md: string, w = 60) => renderMarkdown(md, w).map(plainText);

describe('renderMarkdown', () => {
  it('styles inline code, bold, italics and links', () => {
    const [l] = renderMarkdown('Call `getQuery()` **now**, _maybe_ via [docs](https://example.com/a).', 80);
    expect(plainText(l)).toBe('Call getQuery() now, maybe via docs (example.com/a).');
    expect(l.find((s) => s.text === 'getQuery()')?.color).toBe('cyan');
    expect(l.find((s) => s.text === 'now,')?.bold ?? l.find((s) => s.text.startsWith('now'))?.bold).toBe(true);
    expect(l.find((s) => s.text === 'docs')?.underline).toBe(true);
  });

  it('renders headings, task lists, nested lists and code blocks', () => {
    expect(text('## Summary :notebook:\n\n- [x] Add tests\n- [ ] Docs\n\n1. one\n2. two\n   - nested\n\n```ts\nconst x = 1\n```')).toEqual([
      'Summary',
      '',
      '☑ Add tests',
      '☐ Docs',
      '',
      '1. one',
      '2. two',
      '   ◦ nested',
      '',
      '  ts',
      '▏ const x = 1',
    ]);
  });

  it('drops HTML comments and renders GitHub alerts', () => {
    expect(text('<!-- template -->\n> [!WARNING]\n> Breaks the API.')).toEqual(['▎ Warning', '▎ Breaks the API.']);
  });

  it('renders text and formatting inside GitHub HTML details', () => {
    const lines = text('<details><summary>More context</summary>\n\n**Important** line<br>next line\n</details>');
    expect(lines).toContain('More context');
    expect(lines.join('\n')).toContain('Important line');
    expect(lines.join('\n')).toContain('next line');
  });

  it('draws tables that fit the width', () => {
    const lines = text('| Col | Value |\n|---|---|\n| a | a very long cell value that will not fit |', 30);
    expect(lines[0]).toMatch(/^┌─+┬─+┐$/);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(30);
  });

  it('wraps to the width and indents list continuations', () => {
    const lines = text('- ' + 'word '.repeat(30), 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(20);
    expect(lines[1].startsWith('  word')).toBe(true);
  });
});

describe('wrapSpans', () => {
  it('breaks words longer than the line', () => {
    expect(wrapSpans([{ text: 'x'.repeat(25) }], 10).map(plainText)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});
