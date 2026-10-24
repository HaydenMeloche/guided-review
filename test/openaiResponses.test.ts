import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOpenAI } from '../src/agent/openaiResponses.js';

const originalKey = process.env.OPENAI_API_KEY;
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-openai-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const answer = 42;\n');
  process.env.OPENAI_API_KEY = 'test-key';
  return root;
}

describe('OpenAI Responses provider', () => {
  it('uses Responses function calls and feeds read-only tool output back to GPT-6', async () => {
    const cwd = fixture();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'reasoning', encrypted_content: 'opaque' },
              { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"example.ts"}' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runOpenAI<string>('Find the answer', { provider: 'openai', model: 'gpt-6-luna', cwd }, {}, 'Read only');
    expect(result.value).toBe('The answer is 42.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses');
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first).toMatchObject({ model: 'gpt-6-luna', instructions: 'Read only', store: false, tool_choice: 'auto' });
    expect(first.tools[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false });
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.input).toContainEqual({ type: 'reasoning', encrypted_content: 'opaque' });
    expect(second.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: '1: export const answer = 42;\n2: ' });
  });

  it('streams Responses text deltas to Q&A', async () => {
    const cwd = fixture();
    const chunks = [
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'data: {"type":"response.output_text.delta","delta":" world"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello world"}]}]}}\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const updates: string[] = [];
    const result = await runOpenAI<string>('Greet', { provider: 'openai', model: 'gpt-6.1-sol', cwd }, { onText: (text) => updates.push(text) }, 'Read only');
    expect(updates).toEqual(['Hello', 'Hello world']);
    expect(result.value).toBe('Hello world');
  });

  it('reports usage from the response, with cached input counted apart', async () => {
    const cwd = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 300, output_tokens: 12, input_tokens_details: { cached_tokens: 200 } },
        }),
      ),
    );
    const result = await runOpenAI<string>('q', { provider: 'openai', model: 'gpt-x', cwd }, {}, 'sys');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 12, cacheReadTokens: 200, toolTurns: 0 });
  });
});
