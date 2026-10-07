import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSecureEndpoint, httpModelError } from '../src/agent/http.js';
import { finishOutput, matchesSchema, withSchemaInstruction } from '../src/agent/output.js';
import { runCompatible } from '../src/agent/openaiCompatible.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-http-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const answer = 42;\n');
  return root;
}

const sse = (events: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        // Split mid-event, so the parser has to reassemble across reads.
        const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
        for (let i = 0; i < text.length; i += 17) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 17)));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

describe('assertSecureEndpoint', () => {
  it('requires HTTPS except on localhost', () => {
    for (const url of ['https://api.example.com/v1', 'http://localhost:8080', 'http://127.0.0.1:1', 'http://[::1]:4000']) expect(() => assertSecureEndpoint(new URL(url))).not.toThrow();
    for (const url of ['http://api.example.com', 'http://10.0.0.5', 'http://localhost.example.com', 'ftp://localhost']) expect(() => assertSecureEndpoint(new URL(url))).toThrow(/HTTPS/);
  });
});

describe('httpModelError', () => {
  it('marks rate limits and overloads as transient', () => {
    for (const status of [429, 500, 502, 503, 504, 529]) expect(httpModelError(status, 'x').transient).toBe(true);
    for (const status of [400, 401, 403, 404]) expect(httpModelError(status, 'x').transient).toBe(false);
    expect(httpModelError(401, 'bad key').message).toBe('model API 401: bad key');
  });
});

describe('structured output', () => {
  const schema = {
    type: 'object',
    properties: { intent: { type: 'string' }, risk: { type: 'integer' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
    required: ['intent'],
  };

  it('checks types, required keys, array items, and enums', () => {
    expect(matchesSchema({ intent: 'x', risk: 2, tags: ['a'] }, schema)).toBe(true);
    expect(matchesSchema({ intent: 'x', extra: true }, schema)).toBe(true);
    expect(matchesSchema({ risk: 2 }, schema)).toBe(false);
    expect(matchesSchema({ intent: 1 }, schema)).toBe(false);
    expect(matchesSchema({ intent: 'x', risk: 1.5 }, schema)).toBe(false);
    expect(matchesSchema({ intent: 'x', tags: ['c'] }, schema)).toBe(false);
    expect(matchesSchema([], schema)).toBe(false);
  });

  it('parses fenced or wrapped JSON and rejects a mismatch', () => {
    expect(finishOutput('```json\n{"intent":"x"}\n```', schema)).toEqual({ intent: 'x' });
    expect(finishOutput('Here you go: {"intent":"y"} done', schema)).toEqual({ intent: 'y' });
    expect(() => finishOutput('{"other":1}', schema)).toThrow(/does not match/);
    expect(() => finishOutput('no json', schema)).toThrow(/invalid JSON/);
    expect(finishOutput('plain text')).toBe('plain text');
  });

  it('appends the schema instruction only when there is a schema', () => {
    expect(withSchemaInstruction('p')).toBe('p');
    expect(withSchemaInstruction('p', { type: 'object' })).toBe('p\n\nReturn only a JSON object matching this schema:\n{"type":"object"}');
  });
});

describe('chat completions streaming', () => {
  const config = (cwd: string) => ({ provider: 'openai-compatible' as const, model: 'm', baseUrl: 'http://localhost:1', cwd });

  it('joins tool call arguments split across chunks when the server repeats the id and name', async () => {
    const cwd = fixture();
    const call = (args: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: args } }] } }] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sse([call('{"pa'), call('th":"exa'), call('mple.ts"}')]))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'The answer' } }] }, { choices: [{ delta: { content: ' is 42.' } }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const result = await runCompatible<string>('q', config(cwd), { onText: (t) => seen.push(t) }, 'sys');
    expect(result.value).toBe('The answer is 42.');
    expect(seen).toEqual(['The answer', 'The answer is 42.']);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.messages[2].tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"example.ts"}' } }]);
    expect(second.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '1: export const answer = 42;\n2: ' });
  });

  it('reports bad tool arguments to the model instead of failing', async () => {
    const cwd = fixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'ok' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await runCompatible<string>('q', config(cwd), {}, 'sys')).value).toBe('ok');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[3].content).toMatch(/^Tool error: /);
  });

  it('fails on an error event in the stream', async () => {
    const cwd = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: 'partial' } }] }, { error: { message: 'upstream exploded' } }])));
    await expect(runCompatible('q', config(cwd), { onText: () => {} }, 'sys')).rejects.toThrow('upstream exploded');
  });

  it('returns no session id for a conversation that is not kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json({ choices: [{ message: { content: 'ok' } }] })),
    );
    expect((await runCompatible('q', { ...config(fixture()), keepSession: false }, {}, 'sys')).sessionId).toBeUndefined();
    expect((await runCompatible('q', config(fixture()), {}, 'sys')).sessionId).toMatch(/^compatible:/);
  });
});
