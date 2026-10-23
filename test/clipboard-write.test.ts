import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' });

describe('writeClipboard', () => {
  afterEach(() => {
    vi.resetModules();
    vi.mocked(run).mockReset();
  });

  it('pipes the text to the platform tool', async () => {
    vi.mocked(run).mockResolvedValue('');
    const { writeClipboard } = await import('../src/util/clipboard.js');
    const out = { write: vi.fn() };
    expect(await writeClipboard('https://github.com/o/r/pull/1', out)).toBe('tool');
    expect(vi.mocked(run).mock.calls[0][2]).toMatchObject({ input: 'https://github.com/o/r/pull/1' });
    expect(out.write).not.toHaveBeenCalled();
  });

  it('asks the terminal with OSC 52 when no tool is installed', async () => {
    vi.mocked(run).mockRejectedValue(enoent());
    const { writeClipboard } = await import('../src/util/clipboard.js');
    const out = { write: vi.fn() };
    expect(await writeClipboard('hi', out)).toBe('terminal');
    expect(out.write).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`);
    // It remembers there is no tool, and goes straight to the terminal next time.
    vi.mocked(run).mockClear();
    await writeClipboard('again', out);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a tool that runs and fails', async () => {
    vi.mocked(run).mockRejectedValue(Object.assign(new Error('pbcopy failed'), { code: 1 }));
    const { writeClipboard } = await import('../src/util/clipboard.js');
    await expect(writeClipboard('x', { write: vi.fn() })).rejects.toThrow('pbcopy failed');
  });
});
