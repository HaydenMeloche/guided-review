import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import { ask, run, runRole } from '../src/agent/agent.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const options = { provider: 'openai-compatible' as const, model: 'm', baseUrl: 'http://localhost:1', cwd: os.tmpdir() };
const rateLimited = () => new Response('slow down', { status: 429 });
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
const listeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;

describe('agent abort handling', () => {
  it('removes its abort listener after a backoff completes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(answer('ok')));
    const controller = new AbortController();
    const result = run<string>('q', options, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).value).toBe('ok');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('stops a backoff when the signal aborts, leaving no listener behind', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = run<string>('q', options, { signal: controller.signal });
    const settled = expect(result).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listeners(controller.signal)).toBe(0);
  });

  it('does not call the model for an already aborted signal', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(run('q', options, { signal: controller.signal })).rejects.toThrow(/aborted/);
    await expect(runRole('qa', 'q', options, { signal: controller.signal })).rejects.toThrow(/aborted/);
    await expect(ask({ ...options, question: 'q', onText: () => {}, signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors the signal in the provider adapters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error), { once: true });
          }),
      ),
    );
    for (const provider of ['openai-compatible', 'openai', 'anthropic'] as const) {
      const controller = new AbortController();
      const pending = run('q', { ...options, provider, apiKey: 'k' }, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(listeners(controller.signal)).toBe(0);
    }
  });
});
