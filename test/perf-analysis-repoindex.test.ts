import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RepoIndex } from '../src/analysis/repoIndex.js';
import { parseTsSymbols } from '../src/analysis/symbols.js';

// A 2,000-file repository: every file declares a `widget` function, so a query for it hits the
// 40-file cap, and one file declares a unique name that must still be found quickly.
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-repoindex-perf-'));
  for (let d = 0; d < 40; d++) {
    const dir = path.join(root, 'src', `mod${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++) {
      const n = d * 50 + f;
      const body = Array.from({ length: 30 }, (_, i) => `export function widget${n}_${i}(x: number) {\n  return helper${i}(x) + ${n};\n}`).join('\n');
      fs.writeFileSync(path.join(dir, `file${f}.ts`), body + (n === 1234 ? '\nexport class Needle { find() { return 1; } }\n' : '\n'));
    }
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  parseTsSymbols('warm.ts', 'export const x = 1;', 'head'); // load the compiler outside the timing
}, 60_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('finds a symbol in a 2,000-file repository well under a second', async () => {
  const idx = new RepoIndex({ root, headSha: 'x', changedFiles: ['src/mod0/file0.ts'] });
  const t0 = performance.now();
  const hits = await idx.symbols('Needle');
  const ms = performance.now() - t0;
  expect(hits[0]).toMatchObject({ name: 'Needle', file: 'src/mod24/file34.ts' });
  expect(ms).toBeLessThan(1000);
});

it('caps a broad query at 40 parsed files and says so', async () => {
  const idx = new RepoIndex({ root, headSha: 'x' });
  const t0 = performance.now();
  const hits = await idx.symbols('widget', { limit: 30 });
  const ms = performance.now() - t0;
  expect(hits).toHaveLength(30);
  expect(hits.truncated).toBe(true);
  const all = Array.from({ length: 2000 }, (_, n) => `src/mod${Math.floor(n / 50)}/file${n % 50}.ts`);
  expect(all.filter((p) => idx.declsIn(p)).length).toBe(40);
  expect(ms).toBeLessThan(1000);
  const files = await idx.files('mod3file12');
  expect(files[0].path).toBe('src/mod3/file12.ts');
});
