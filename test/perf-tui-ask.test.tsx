import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { waitFor } from './helpers/waitFor.js';

const TOKENS = 200;
const FINAL = 'The final answer ends here: DONE.';
let finalValue = FINAL;
// Streaming 200 tokens through real renders can take seconds on a loaded runner (macOS CI, coverage).
const SLOW = { timeout: 10_000 };
// How the mock waits between tokens. Real streaming just yields; the batching test swaps in
// simulated time so the number of flush windows doesn't depend on how fast the runner is.
let betweenTokens = () => new Promise<void>((r) => setImmediate(r));

vi.mock('../src/agent/agent.js', () => ({
  ask: vi.fn(async (opts: { onText?: (t: string) => void }) => {
    let text = '';
    for (let i = 0; i < TOKENS; i++) {
      text += `w${i} `;
      opts.onText?.(text);
      await betweenTokens();
    }
    opts.onText?.(`${text}${FINAL}`);
    return { value: finalValue };
  }),
}));

const { AskOverlay, ASK_FLUSH_MS } = await import('../src/tui/AskOverlay.js');
const { ask } = await import('../src/agent/agent.js');

async function typeQuestion() {
  const ui = render(<AskOverlay target="x" agent={{ cwd: '/tmp' }} width={200} height={40} onClose={() => {}} />);
  await waitFor(() => expect(ui.lastFrame()).toContain('enter: ask'));
  ui.stdin.write('why?');
  await waitFor(() => expect(ui.lastFrame()).toContain('why?'));
  return ui;
}

async function askOnce() {
  const ui = await typeQuestion();
  ui.stdin.write('\r');
  return ui;
}

describe('Ask streaming', () => {
  it('batches streamed tokens into far fewer renders and shows the full final answer', async () => {
    finalValue = FINAL;
    // Tokens arrive every TOKEN_MS of fake time. Only the timers are faked: Ink and React
    // still render on real setImmediate, and each token waits for that render to land.
    const TOKEN_MS = 5;
    vi.mocked(ask).mockClear();
    const ui = await typeQuestion();
    const before = ui.frames.length;
    betweenTokens = async () => {
      await vi.advanceTimersByTimeAsync(TOKEN_MS);
      await new Promise((r) => setImmediate(r));
    };
    try {
      // Fake the clock before submitting so the overlay's flush timer is a fake one from the start.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      ui.stdin.write('\r');
      while (!vi.mocked(ask).mock.results.length) await new Promise((r) => setImmediate(r));
      await vi.mocked(ask).mock.results[0].value;
    } finally {
      vi.useRealTimers();
      betweenTokens = () => new Promise<void>((r) => setImmediate(r));
    }
    await waitFor(() => expect(ui.lastFrame()).toContain('DONE.'), SLOW);
    await waitFor(() => expect(ui.lastFrame()).toContain('enter: follow up'), SLOW);
    // At most one flush per window, plus the busy and final frames. One render per token
    // would be over 200 frames.
    const windows = Math.ceil((TOKENS * TOKEN_MS) / ASK_FLUSH_MS);
    expect(ui.frames.length - before).toBeLessThanOrEqual(windows + 4);
    expect(windows + 4).toBeLessThan(TOKENS / 4);
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
