import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { waitFor } from './helpers/waitFor.js';

const TOKENS = 200;
const FINAL = 'The final answer ends here: DONE.';
let finalValue = FINAL;
// Streaming 200 tokens through real renders can take seconds on a loaded runner (macOS CI, coverage).
const SLOW = { timeout: 10_000 };

vi.mock('../src/agent/agent.js', () => ({
  ask: vi.fn(async (opts: { onText?: (t: string) => void }) => {
    let text = '';
    for (let i = 0; i < TOKENS; i++) {
      text += `w${i} `;
      opts.onText?.(text);
      await new Promise((r) => setImmediate(r));
    }
    opts.onText?.(`${text}${FINAL}`);
    return { value: finalValue };
  }),
}));

const { AskOverlay } = await import('../src/tui/AskOverlay.js');

async function askOnce() {
  const ui = render(<AskOverlay target="x" agent={{ cwd: '/tmp' }} width={200} height={40} onClose={() => {}} />);
  await waitFor(() => expect(ui.lastFrame()).toContain('enter: ask'));
  ui.stdin.write('why?');
  await waitFor(() => expect(ui.lastFrame()).toContain('why?'));
  ui.stdin.write('\r');
  return ui;
}

describe('Ask streaming', () => {
  it('batches streamed tokens into far fewer renders and shows the full final answer', async () => {
    finalValue = FINAL;
    const ui = await askOnce();
    const before = ui.frames.length;
    await waitFor(() => expect(ui.lastFrame()).toContain('DONE.'), SLOW);
    await waitFor(() => expect(ui.lastFrame()).toContain('enter: follow up'), SLOW);
    // One render per token would be over 200 frames.
    expect(ui.frames.length - before).toBeLessThan(TOKENS / 4);
    ui.unmount();
  }, 30_000);

  it('keeps the last streamed text when the result carries no value', async () => {
    finalValue = '';
    const ui = await askOnce();
    await waitFor(() => expect(ui.lastFrame()).toContain('enter: follow up'), SLOW);
    expect(ui.lastFrame()).toContain('DONE.');
    expect(ui.lastFrame()).toContain('w199');
    ui.unmount();
  }, 30_000);
});
