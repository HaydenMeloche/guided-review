import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { openExternal } from '../src/util/openExternal.js';

// A child that emits `event` on the next tick, as spawn does.
function fakeChild(event: 'spawn' | 'error') {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  setImmediate(() => (event === 'error' ? child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })) : child.emit('spawn')));
  return child;
}

describe('openExternal', () => {
  it('resolves once the opener starts, and detaches from it', async () => {
    const child = fakeChild('spawn');
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    await openExternal('https://example.com');
    expect(child.unref).toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(['https://example.com']);
  });

  it('rejects when the opener cannot be started', async () => {
    vi.mocked(spawn).mockReturnValueOnce(fakeChild('error') as never);
    await expect(openExternal('https://example.com')).rejects.toThrow('ENOENT');
  });
});
