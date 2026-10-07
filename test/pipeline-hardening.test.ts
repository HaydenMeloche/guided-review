import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapLimit, mergeModelRisk } from '../src/pipeline.js';
import { safeReader } from '../src/analysis/safeRead.js';
import { loadCoverage } from '../src/analysis/tests.js';
import type { Hunk } from '../src/types.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-head-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-outside-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('readHead', () => {
  it('reads regular files inside the worktree', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    expect(safeReader(root)('src/a.ts')).toBe('export const a = 1;\n');
  });

  it('rejects a symlink to a secret outside the worktree', () => {
    fs.writeFileSync(path.join(outside, 'credentials'), 'aws_secret_access_key=xyz');
    fs.symlinkSync(path.join(outside, 'credentials'), path.join(root, 'x.test.ts'));
    expect(safeReader(root)('x.test.ts')).toBeUndefined();
  });

  it('rejects a symlink to a device such as /dev/zero', () => {
    fs.symlinkSync('/dev/zero', path.join(root, 'zero.test.ts'));
    expect(safeReader(root)('zero.test.ts')).toBeUndefined();
  });

  it('rejects symlinks even when they point inside the worktree', () => {
    fs.writeFileSync(path.join(root, 'real.ts'), 'x');
    fs.symlinkSync('real.ts', path.join(root, 'link.ts'));
    expect(safeReader(root)('link.ts')).toBeUndefined();
  });

  it('rejects files reached through a symlinked parent directory', () => {
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'dir'));
    expect(safeReader(root)('dir/secret.ts')).toBeUndefined();
  });

  it('rejects directories, absolute paths and .. escapes', () => {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(outside, 'f.ts'), 'f');
    const read = safeReader(root);
    expect(read('sub')).toBeUndefined();
    expect(read(path.join(outside, 'f.ts'))).toBeUndefined();
    expect(read(`../${path.basename(outside)}/f.ts`)).toBeUndefined();
  });

  it('enforces the 1 MB size cap', () => {
    fs.writeFileSync(path.join(root, 'ok.txt'), Buffer.alloc(1024 * 1024, 'a'));
    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 'a'));
    const read = safeReader(root);
    expect(read('ok.txt')).toHaveLength(1024 * 1024);
    expect(read('big.txt')).toBeUndefined();
  });
});

describe('loadCoverage', () => {
  it('ignores coverage files the PR changed', () => {
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), 'SF:src/a.ts\nDA:1,1\nend_of_record\n');
    expect(loadCoverage(root)?.get('src/a.ts')?.get(1)).toBe(1);
    expect(loadCoverage(root, { skip: ['coverage/lcov.info'] })).toBeUndefined();
  });

  it('clamps statement ranges to the file length', () => {
    fs.mkdirSync(path.join(root, 'coverage'));
    const json = { 'src/a.ts': { path: 'src/a.ts', statementMap: { 0: { start: { line: 2 }, end: { line: 1e9 } } }, s: { 0: 3 } } };
    fs.writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(json));
    const hits = loadCoverage(root, { lineCount: () => 10 })?.get('src/a.ts');
    expect(hits?.size).toBe(9);
    expect(hits?.get(10)).toBe(3);
    expect(hits?.has(11)).toBe(false);
  });

  it('does not follow a symlinked coverage file', () => {
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.symlinkSync('/dev/zero', path.join(root, 'coverage', 'lcov.info'));
    expect(loadCoverage(root)).toBeUndefined();
  });
});

describe('mapLimit', () => {
  it('stops dequeuing and aborts in-flight work after the first error', async () => {
    const started: number[] = [];
    const finishedAfterAbort: number[] = [];
    const controller = new AbortController();
    const items = Array.from({ length: 10 }, (_, i) => i);
    const run = mapLimit(
      items,
      3,
      async (n) => {
        started.push(n);
        if (n === 1) {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error('fatal');
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
        if (controller.signal.aborted) finishedAfterAbort.push(n);
      },
      controller,
    );
    await expect(run).rejects.toThrow('fatal');
    expect(controller.signal.aborted).toBe(true);
    expect(started).toEqual([0, 1, 2]);
    expect(finishedAfterAbort.sort()).toEqual([0, 2]);
  });

  it('starts nothing once the caller has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3], 2, async (n) => void started.push(n), controller)).rejects.toThrow();
    expect(started).toEqual([]);
  });

  it('runs every item when nothing fails', async () => {
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4], 2, async (n) => void seen.push(n));
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('mergeModelRisk', () => {
  const hunk = (risk: 0 | 1 | 2 | 3, reasons: string[]) => ({ risk, riskReasons: reasons }) as unknown as Hunk;

  it('does not let the model lower static risk', () => {
    const h = hunk(3, ['touches auth']);
    mergeModelRisk(h, 0, 'looks harmless');
    expect(h.risk).toBe(3);
    expect(h.riskReasons[0]).toBe('touches auth');
    expect(h.riskReasons).toContain('looks harmless');
  });

  it('lets the model raise risk, keeping static reasons visible', () => {
    const h = hunk(1, ['public API']);
    mergeModelRisk(h, 3, 'race on shared state');
    expect(h.risk).toBe(3);
    expect(h.riskReasons).toEqual(['race on shared state', 'public API']);
  });

  it('clamps out-of-range model risk', () => {
    const h = hunk(0, []);
    mergeModelRisk(h, 99, 'r');
    expect(h.risk).toBe(3);
  });
});
