import { expect, it } from 'vitest';
import { initTreeSitter, parseWithTreeSitter, supportsTreeSitter, treeSitterReady } from '../src/analysis/treesitter.js';

it('loads only the grammars the given paths need, once', async () => {
  expect(treeSitterReady()).toBe(false);
  expect(await initTreeSitter(['src/a.ts', 'README.md'])).toBe(true); // nothing to load
  expect(supportsTreeSitter('a.py')).toBe(false);

  const [a, b] = await Promise.all([initTreeSitter(['app/models.py']), initTreeSitter(['app/views.py', 'lib/x.h'])]);
  expect(a && b).toBe(true);
  expect(treeSitterReady()).toBe(true);
  expect(supportsTreeSitter('a.py')).toBe(true);
  expect(supportsTreeSitter('a.c')).toBe(true);
  expect(supportsTreeSitter('a.go')).toBe(false);
  // A .h header with C++ syntax needs the C++ grammar too.
  expect(parseWithTreeSitter('lib/x.h', 'class Store { public: int save() { return 1; } };', 'head')?.decls.map((d) => d.name)).toContain('save');

  expect(await initTreeSitter()).toBe(true);
  for (const p of ['a.go', 'a.kt', 'a.java', 'a.rb', 'a.rs', 'a.cpp']) expect(supportsTreeSitter(p)).toBe(true);
});
