import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

// A fake execFile whose calls stay pending until the test settles them, so the test can see
// which tool calls are in flight at once.
const pending: { args: string[]; finish: (stdout: string) => void; fail: (e: Error) => void }[] = [];
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], opts: { signal?: AbortSignal }, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
    const entry = { args, finish: (stdout: string) => cb(null, stdout, ''), fail: (e: Error) => cb(e, '', '') };
    opts.signal?.addEventListener('abort', () => entry.fail(opts.signal!.reason as Error), { once: true });
    pending.push(entry);
  },
}));

const { runRepoTools: runTools } = await import('../src/agent/repoTools.js');

const search = (pattern: string) => ({ name: 'search_repo', input: { pattern } });

afterEach(() => {
  pending.splice(0);
});

describe('tool calls within one turn', () => {
  it('run concurrently and return results in call order', async () => {
    const results = runTools(os.tmpdir(), [search('first'), search('second'), search('third')]);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    // Finish out of order.
    pending[2].finish('c.ts:1:third');
    pending[0].finish('a.ts:1:first');
    pending[1].finish('b.ts:1:second');
    expect(await results).toEqual(['a.ts:1:first', 'b.ts:1:second', 'c.ts:1:third']);
  });

  it('stop when the signal aborts', async () => {
    const controller = new AbortController();
    const results = runTools(os.tmpdir(), [search('first'), search('second')], controller.signal);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    controller.abort(new Error('aborted'));
    await expect(results).rejects.toThrow('aborted');
  });

  it('do not start for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('aborted'));
    await expect(runTools(os.tmpdir(), [search('first')], controller.signal)).rejects.toThrow('aborted');
    expect(pending).toHaveLength(0);
  });
});
