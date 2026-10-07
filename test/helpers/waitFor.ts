// Polls until `fn` stops throwing (and does not return false), then returns its result.
// Use it in place of fixed sleeps when a test waits for a frame or a callback:
//   await waitFor(() => expect(ui.lastFrame()).toContain('Saved'));
// On timeout it rethrows the last assertion error, so failures read like a normal expect.
export async function waitFor<T>(fn: () => T, opts: { timeout?: number; interval?: number } = {}): Promise<T> {
  const timeout = opts.timeout ?? 2000;
  const interval = opts.interval ?? 5;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    // Yield first so pending renders and effects from the triggering action run.
    await new Promise((resolve) => setTimeout(resolve, interval));
    try {
      const result = fn();
      if (result !== false) {
        // A frame can show new state before React runs that render's passive effects
        // (e.g. Ink re-binding input handlers). Let them flush before the test sends more keys.
        await new Promise((resolve) => setImmediate(resolve));
        return result;
      }
      lastError = new Error('waitFor: condition returned false');
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) throw lastError;
  }
}
