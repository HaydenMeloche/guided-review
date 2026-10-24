import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAnthropic } from '../src/agent/anthropic.js';

const originalKey = process.env.ANTHROPIC_API_KEY;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-anthropic-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const answer = 42;\n');
  process.env.ANTHROPIC_API_KEY = 'test-key';
  return root;
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

// A Messages API event stream that returns the given content blocks.
function messageStream(blocks: Block[], stopReason: string, usage: Record<string, number> = { input_tokens: 1, output_tokens: 0 }): Response {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage },
      },
    ],
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      for (const word of block.text.split(/(?= )/)) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('Anthropic provider', () => {
  it('runs read-only tools and feeds their output back to Claude', async () => {
    const cwd = fixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(messageStream([{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'example.ts' } }], 'tool_use'))
      .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'The answer is 42.' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAnthropic<string>('Find the answer', { provider: 'anthropic', model: 'claude-haiku-5-5', cwd }, {}, 'Read only');
    expect(result.value).toBe('The answer is 42.');
    expect(result.sessionId).toMatch(/^anthropic:/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages');
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first).toMatchObject({ model: 'claude-haiku-5-5', system: [{ type: 'text', text: 'Read only' }], stream: true });
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(['read_file', 'search_repo', 'git_history']);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1: export const answer = 42;\n2: ' }] });
  });

  it('marks the tools + system prefix and the growing conversation for prompt caching', async () => {
    const cwd = fixture();
    fs.writeFileSync(path.join(cwd, 'other.ts'), 'export const other = 1;\n');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        messageStream(
          [
            { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'example.ts' } },
            { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'other.ts' } },
          ],
          'tool_use',
        ),
      )
      .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'done' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    await runAnthropic<string>('Find it', { provider: 'anthropic', model: 'm', cwd }, {}, 'Read only');

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    // Counts every cache_control marker in a request, including the top-level one.
    const markers = (value: unknown): number =>
      Array.isArray(value)
        ? value.reduce((n: number, v) => n + markers(v), 0)
        : value && typeof value === 'object'
          ? Object.entries(value).reduce((n, [k, v]) => n + (k === 'cache_control' ? 1 : markers(v)), 0)
          : 0;
    for (const body of bodies) {
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
      expect(body.system).toEqual([{ type: 'text', text: 'Read only', cache_control: { type: 'ephemeral' } }]);
      expect(markers(body.tools)).toBe(0);
      expect(markers(body.messages)).toBe(0);
      expect(markers(body)).toBe(2);
    }
    // Both calls ran, and their results are returned in call order.
    expect(bodies[1].messages.at(-1).content.map((r: { tool_use_id: string; content: string }) => [r.tool_use_id, r.content])).toEqual([
      ['toolu_a', '1: export const answer = 42;\n2: '],
      ['toolu_b', '1: export const other = 1;\n2: '],
    ]);
  });

  it('puts the prefix breakpoint on the last tool when there is no system prompt', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn().mockImplementation(async () => messageStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '');
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd, toolCalling: false }, {}, '');
    const [withTools, withoutTools] = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(withTools.system).toBeUndefined();
    expect(withTools.tools.map((t: { cache_control?: unknown }) => t.cache_control)).toEqual([undefined, undefined, { type: 'ephemeral' }]);
    expect(withTools.cache_control).toEqual({ type: 'ephemeral' });
    expect(withoutTools.tools).toBeUndefined();
    expect(withoutTools.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('streams text to Q&A and parses structured output', async () => {
    const cwd = fixture();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'Hello world' }], 'end_turn'))
        .mockResolvedValueOnce(messageStream([{ type: 'text', text: '{"intent": "x"}' }], 'end_turn')),
    );
    const updates: string[] = [];
    const answer = await runAnthropic<string>('Greet', { provider: 'anthropic', model: 'claude-opus-5-5', cwd }, { onText: (text) => updates.push(text) }, 'Read only');
    expect(updates).toEqual(['Hello', 'Hello world']);
    expect(answer.value).toBe('Hello world');
    const brief = await runAnthropic<{ intent: string }>(
      'Brief',
      { provider: 'anthropic', model: 'claude-opus-5-5', cwd },
      { schema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] } },
      'Read only',
    );
    expect(brief.value).toEqual({ intent: 'x' });
  });

  it('reports a missing key and marks rate limits as transient', async () => {
    const cwd = fixture();
    delete process.env.ANTHROPIC_API_KEY;
    await expect(runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '')).rejects.toThrow(/set \$ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
        ),
    );
    await expect(runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '')).rejects.toMatchObject({ name: 'ModelError', transient: true });
  });

  it('rejects a non-HTTPS baseUrl except on localhost', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn().mockImplementation(async () => messageStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    for (const baseUrl of ['http://proxy.example.com', 'http://10.0.0.5:8080', 'ftp://example.com']) {
      await expect(runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd, baseUrl }, {}, '')).rejects.toThrow(/HTTPS/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    for (const baseUrl of ['http://localhost:8080', 'http://127.0.0.1:9000', 'http://[::1]:4000', 'https://gateway.example.com']) {
      expect((await runAnthropic<string>('Hi', { provider: 'anthropic', model: 'm', cwd, baseUrl }, {}, '')).value).toBe('ok');
    }
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8080/v1/messages');
  });

  it('caps output tokens at 16000 unless maxOutputTokens is set', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn().mockImplementation(async () => messageStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '');
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd, maxOutputTokens: 4096 }, {}, '');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(16000);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(4096);
  });

  it('sends effort as output_config.effort only when set', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn().mockImplementation(async () => messageStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd, effort: 'low' }, {}, '');
    await runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config).toEqual({ effort: 'low' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('output_config');
  });

  it('sends the answer schema as the structured output format instead of a prompt instruction', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn().mockImplementation(async () => messageStream([{ type: 'text', text: '{"hunks":[{"id":"h1","risk":2}]}' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    const schema = {
      type: 'object',
      properties: {
        hunks: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, risk: { type: 'integer', minimum: 0, maximum: 3 } }, required: ['id'] },
        },
        note: { type: 'string', maxLength: 10 },
      },
      required: ['hunks'],
    };
    const result = await runAnthropic<{ hunks: { id: string }[] }>('Narrate', { provider: 'anthropic', model: 'm', cwd, effort: 'low' }, { schema }, 'Read only');
    expect(result.value.hunks).toEqual([{ id: 'h1', risk: 2 }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe('Narrate');
    expect(body.output_config).toEqual({
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hunks: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, risk: { type: 'integer' } }, required: ['id'] },
            },
            note: { type: 'string' },
          },
          required: ['hunks'],
        },
      },
    });
  });

  it('uses the beta endpoint with the fast mode header and speed when fastMode is on, keeping caching and tools', async () => {
    const cwd = fixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(messageStream([{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'example.ts' } }], 'tool_use'))
      .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'fast answer' }], 'end_turn'))
      .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'standard' }], 'end_turn'));
    vi.stubGlobal('fetch', fetchMock);
    const updates: string[] = [];
    const result = await runAnthropic<string>('Q', { provider: 'anthropic', model: 'claude-opus-5-5', cwd, fastMode: true, effort: 'high' }, { onText: (t) => updates.push(t) }, 'Read only');
    expect(result.value).toBe('fast answer');
    expect(updates.at(-1)).toBe('fast answer');
    for (const [url, init] of fetchMock.mock.calls.slice(0, 2)) {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages?beta=true');
      expect(new Headers(init.headers).get('anthropic-beta')).toBe('fast-mode-2026-02-01');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ speed: 'fast', output_config: { effort: 'high' }, cache_control: { type: 'ephemeral' } });
      expect(body).not.toHaveProperty('betas');
      expect(body.system).toEqual([{ type: 'text', text: 'Read only', cache_control: { type: 'ephemeral' } }]);
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['read_file', 'search_repo', 'git_history']);
    }
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });

    await runAnthropic('Q', { provider: 'anthropic', model: 'claude-opus-5-5', cwd, fastMode: false }, {}, 'Read only');
    const [url, init] = fetchMock.mock.calls[2];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
    expect(JSON.parse(init.body)).not.toHaveProperty('speed');
  });

  it('sums token usage across turns and counts tool turns', async () => {
    const cwd = fixture();
    const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(messageStream([{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'example.ts' } }], 'tool_use', usage))
        .mockResolvedValueOnce(messageStream([{ type: 'text', text: 'done' }], 'end_turn', usage)),
    );
    const result = await runAnthropic<string>('Q', { provider: 'anthropic', model: 'm', cwd }, {}, 'Read only');
    // message_delta reports the final output count (1) for each turn.
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 1000, cacheWriteTokens: 80, toolTurns: 1 });
  });

  it("puts a rate limit's retry-after header on the ModelError", async () => {
    const cwd = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '20' },
        }),
      ),
    );
    await expect(runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, {}, '')).rejects.toMatchObject({ name: 'ModelError', transient: true, retryAfterMs: 20_000 });
  });

  it('stops when the signal is aborted', async () => {
    const cwd = fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(runAnthropic('Hi', { provider: 'anthropic', model: 'm', cwd }, { signal: controller.signal }, '')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
