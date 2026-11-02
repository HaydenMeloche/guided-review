import { describe, expect, it } from 'vitest';
import { chapterBatches, chapterPrompt, hunkLimit, isTruncated } from '../src/agent/prompts.js';
import { filesFor, hunk, tour } from './fixtures/tour.js';
import type { Hunk } from '../src/types.js';

// A hunk adding `n` lines of code to `file`.
function added(id: string, file: string, n: number, extra: Partial<Hunk> = {}): Hunk {
  return hunk(
    id,
    file,
    Array.from({ length: n }, (_, i) => ({ kind: 'add' as const, text: `  const v${i} = compute(${i});`, newLine: i + 1 })),
    { header: `@@ -0,0 +1,${n} @@`, newStart: 1, newLines: n, symbols: [], ...extra },
  );
}

describe('hunk rendering in chapter prompts', () => {
  it('shows a large hunk whole when it fits half the budget, and the rest cut with a line to read from', () => {
    const whole = added('h_whole', 'src/registry.ts', 300);
    const huge = added('h_huge', 'src/big.ts', 1000);
    const t = tour([whole, huge], [{ hunkIds: ['h_whole', 'h_huge'] }], { files: filesFor([whole, huge]) });
    expect(hunkLimit(whole)).toBe(600);
    expect(isTruncated(whole)).toBe(false);
    expect(isTruncated(huge)).toBe(true);
    const prompt = chapterPrompt(t, t.chapters[0]);
    expect(prompt).toContain('const v299 = compute(299);');
    expect(prompt).not.toContain('read src/registry.ts');
    expect(prompt).toContain('(400 more lines not shown; read src/big.ts from line 601 before narrating this hunk)');
  });

  it('keeps the 120-line cap for a hunk whose full rendering would take over half the budget', () => {
    const wide = added('h_wide', 'src/wide.ts', 500, {});
    wide.lines = wide.lines.map((l) => ({ ...l, text: l.text.padEnd(200, ' //') }));
    expect(hunkLimit(wide)).toBe(120);
    expect(isTruncated(wide)).toBe(true);
  });

  it('lists the changed tests read in other chapters, with their case names', () => {
    const code = added('h_code', 'src/main/Registry.kt', 10);
    const test = added('h_test', 'src/test/ProviderTest.kt', 10, { symbols: ['ProviderTest', 'ProviderTest.findLoaders', 'ProviderTest.findMappedLoaders'] });
    const files = filesFor([code, test], { 'src/test/ProviderTest.kt': 'test' });
    const t = tour(
      [code, test],
      [
        { hunkIds: ['h_code'], title: 'Registry' },
        { hunkIds: ['h_test'], title: 'Provider', kind: 'tests' },
      ],
      { files },
    );
    const registry = chapterPrompt(t, t.chapters[0]);
    expect(registry).toContain('## Changed tests in other chapters');
    expect(registry).toContain('- src/test/ProviderTest.kt (chapter "Provider"): findLoaders, findMappedLoaders');
    expect(registry).toContain('Before saying that code here has no test');
    // The chapter that holds the test file does not list it.
    expect(chapterPrompt(t, t.chapters[1])).not.toContain('## Changed tests in other chapters');
  });

  it('sizes batches with the same limits the prompt renders with', () => {
    const hunks = [added('h_a', 'src/a.ts', 500), added('h_b', 'src/b.ts', 500), added('h_c', 'src/c.ts', 500)];
    const t = tour(hunks, [{ hunkIds: hunks.map((h) => h.id) }], { files: filesFor(hunks) });
    const batches = chapterBatches(t, t.chapters[0]);
    expect(batches.flat()).toEqual(['h_a', 'h_b', 'h_c']);
    // Each batch's prompt fits: no hunk is omitted for size.
    for (const batch of batches) {
      const prompt = chapterPrompt(t, { ...t.chapters[0], hunkIds: batch });
      expect(prompt).not.toContain('omitted for size');
    }
  });
});
