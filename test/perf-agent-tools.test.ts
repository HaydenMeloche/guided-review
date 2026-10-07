import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/agent/agent.js';
import { runCompatible } from '../src/agent/openaiCompatible.js';
import { runRepoTool } from '../src/agent/repoTools.js';
import { SessionStore } from '../src/agent/sessions.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-perf-agent-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  return root;
}

const readFile = (root: string, args: Record<string, unknown>) => runRepoTool(root, 'read_file', args);

// The previous whole-file implementation, as the reference for the windowed read.
function reference(text: string, startLine?: number, lineCount?: number): string {
  const start = Math.max(1, Math.floor(Number(startLine) || 1));
  const count = Math.min(250, Math.max(1, Math.floor(Number(lineCount) || 120)));
  return text
    .split('\n')
    .slice(start - 1, start - 1 + count)
    .map((line, i) => `${start + i}: ${line}`)
    .join('\n')
    .slice(0, 24_000);
}

describe('read_file reads only the window it returns', () => {
  const big = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} ${'é'.repeat(i % 7)}`).join('\n') + '\n';
  const cases: [string, string, number | undefined, number | undefined][] = [
    ['trailing newline', 'a\nb\n', undefined, undefined],
    ['no trailing newline', 'a\nb', undefined, undefined],
    ['empty file', '', undefined, undefined],
    ['CRLF', 'a\r\nb\r\n', 1, 5],
    ['start past the end', 'a\nb\n', 10, 5],
    ['window deep in a large file (multibyte across chunks)', big, 15_000, 40],
    ['the 250-line cap', big, 3, 1000],
    ['last lines of a large file', big, 19_990, 50],
    ['output cap from many long lines', Array.from({ length: 300 }, () => 'x'.repeat(500)).join('\n'), 1, 250],
    ['one line longer than the output cap', `short\n${'y'.repeat(100_000)}\nafter\n`, 2, 3],
  ];
  for (const [name, text, startLine, lineCount] of cases) {
    it(`matches the whole-file result: ${name}`, async () => {
      const root = repo({ 'f.txt': text });
      expect(await readFile(root, { path: 'f.txt', startLine, lineCount })).toBe(reference(text, startLine, lineCount));
    });
  }

  it('does not load the whole file', async () => {
    const root = repo({ 'big.txt': big });
    const whole = vi.spyOn(fsp, 'readFile');
    expect(await readFile(root, { path: 'big.txt', lineCount: 3 })).toBe(reference(big, 1, 3));
    expect(whole).not.toHaveBeenCalled();
  });

  it('keeps the repository confinement checks', async () => {
    const root = repo({ 'f.txt': 'x' });
    const outside = repo({ 'secret.txt': 'secret' });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    expect(await readFile(root, { path: 'link.txt' })).toMatch(/outside the repository/);
    expect(await readFile(root, { path: '../secret.txt' })).toMatch(/Tool error/);
    expect(await readFile(root, { path: path.join(outside, 'secret.txt') })).toMatch(/relative to the repository/);
  });
});

describe('session store', () => {
  it('evicts the least recently used conversation past its cap', () => {
    const store = new SessionStore<number>(2);
    store.set('a', [1]);
    store.set('b', [2]);
    store.get('a');
    store.set('c', [3]);
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.has('c')).toBe(true);
    expect(store.size).toBe(2);
  });

  it('returns a copy, so a failed turn cannot change the stored conversation', () => {
    const store = new SessionStore<number>();
    store.set('a', [1]);
    store.get('a')!.push(2);
    expect(store.get('a')).toEqual([1]);
  });

  it('keeps a provider conversation only when it can be resumed', async () => {
    const root = repo({});
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const config = { provider: 'openai-compatible' as const, model: 'm', baseUrl: 'http://localhost:1', cwd: root };
    const sent = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body).messages.map((m: { content: string }) => m.content);

    const dropped = await runCompatible('first', { ...config, keepSession: false }, {}, 'sys');
    await runCompatible('second', { ...config, resume: dropped.sessionId }, {}, 'sys');
    expect(sent(1)).toEqual(['sys', 'second']);

    const kept = await runCompatible('first', { ...config, keepSession: true }, {}, 'sys');
    const resumed = await runCompatible('second', { ...config, resume: kept.sessionId }, {}, 'sys');
    expect(resumed.sessionId).toBe(kept.sessionId);
    expect(sent(3)).toEqual(['sys', 'first', 'ok', 'second']);
  });
});

describe('concurrent calls on one signal', () => {
  it('add one listener each to the shared signal and clean up on abort', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const options = { provider: 'openai-compatible' as const, model: 'm', baseUrl: 'http://localhost:1', cwd: os.tmpdir() };
      const pending = Array.from({ length: 6 }, () => run('q', options, { signal: controller.signal }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(6);
      controller.abort();
      for (const p of pending) await expect(p).rejects.toThrow();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      // Each fetch listened on its call's own signal, never the shared one.
      for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).not.toBe(controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });
});
