import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/util/abort.js';

const aborted = (signal: AbortSignal) => new Promise<unknown>((resolve) => signal.addEventListener('abort', () => resolve(signal.reason)));

describe('withTimeout', () => {
  it('times out with a TimeoutError, as AbortSignal.timeout does', async () => {
    const reason = await aborted(withTimeout(new AbortController().signal, 10));
    expect((reason as DOMException).name).toBe('TimeoutError');
  });

  it('aborts with the given signal, for its reason', async () => {
    const owner = new AbortController();
    const reason = aborted(withTimeout(owner.signal, 60_000));
    owner.abort(new Error('closed'));
    expect(((await reason) as Error).message).toBe('closed');
  });

  it('is aborted at once when the given signal already is', () => {
    expect(withTimeout(AbortSignal.abort(), 60_000).aborted).toBe(true);
  });

  // Node 22.13 garbage-collects AbortSignal.any's signal while only a listener holds it, so its
  // timeout never fires. This one must fire even after a collection.
  it('fires its timeout after a garbage collection', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    let fired = 0;
    for (let i = 0; i < 10; i++) void aborted(withTimeout(new AbortController().signal, 20)).then(() => fired++);
    gc?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(10);
  });
});
