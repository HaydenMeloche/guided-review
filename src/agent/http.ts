// A failure of the model service itself (as opposed to a bad answer). run() retries a transient
// one with backoff and reports any other as the agent being unavailable. retryAfterMs is the
// wait the server asked for, when it named one.
export class ModelError extends Error {
  constructor(
    message: string,
    readonly transient = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

// 529 is Anthropic's "overloaded".
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export const retryableStatus = (status: number) => RETRYABLE.has(status);

export function httpModelError(status: number, detail: string, retryAfterMs?: number): ModelError {
  return new ModelError(`model API ${status}: ${detail}`, retryableStatus(status), retryAfterMs);
}

// The delay a response asks for before a retry: `retry-after-ms`, or `retry-after` in seconds or
// as an HTTP date. Undefined when there is none or it can't be read.
export function retryAfterMs(headers: { get(name: string): string | null } | undefined, now = Date.now()): number | undefined {
  const ms = headers?.get('retry-after-ms')?.trim();
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  // HTTP dates end in GMT; anything else Date.parse might half-read is ignored.
  const date = value.endsWith('GMT') ? Date.parse(value) : NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

// Model endpoints carry the API key and the PR's code, so they must use HTTPS unless they are
// on this machine.
export function assertSecureEndpoint(url: URL): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  throw new Error('model endpoint must use HTTPS, except on localhost');
}

// POSTs a JSON request; `streamed` is whether the server honored `stream: true` with an event stream.
export async function postModel(url: URL, key: string | undefined, body: { stream: boolean } & Record<string, unknown>, signal?: AbortSignal): Promise<{ response: Response; streamed: boolean }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal,
  }).catch((e: Error) => {
    if (signal?.aborted) throw e;
    throw new ModelError(`model endpoint unavailable: ${e.message}`);
  });
  if (!response.ok) throw httpModelError(response.status, (await response.text()).slice(0, 300), retryAfterMs(response.headers));
  return { response, streamed: body.stream && !!response.headers.get('content-type')?.includes('text/event-stream') };
}

// Yields the parsed `data` of each server-sent event. Events are separated by a blank line and
// may span several `data:` lines.
export async function* sseData(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('model API returned no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      if (done && buffer) events.push(buffer);
      for (const chunk of events) {
        const data = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) return;
    }
  } finally {
    // A consumer that stops early (an error event) leaves the body unread.
    reader.cancel().catch(() => {});
  }
}
