// A signal that aborts when `signal` does or after `ms`, whichever is first: what
// AbortSignal.any([signal, AbortSignal.timeout(ms)]) does. Node 22.13 (the oldest gr supports)
// can garbage-collect the signal AbortSignal.any returns while a fetch still waits on it, and then
// the timeout never fires and the fetch hangs. Here the timer holds the signal until it fires.
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  if (!signal) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
  // As AbortSignal.timeout's: the timer does not keep gr running.
  timer.unref();
  const stop = () => {
    clearTimeout(timer);
    controller.abort(signal.reason);
  };
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  return controller.signal;
}
