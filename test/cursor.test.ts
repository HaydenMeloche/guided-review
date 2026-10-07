import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKCustomTool } from '@cursor/sdk';

type FakeOptions = { tools?: string[]; mcpServers?: unknown; systemPrompt?: unknown; local: { cwd: string; settingSources?: unknown; customTools: Record<string, SDKCustomTool> } };
type Delta = (a: { update: { type: string; text?: string; callId?: string } }) => void;

// A fake SDK: each test sets `script` to drive one run, and calls are recorded.
const calls: { method: 'create' | 'resume'; id?: string; options: FakeOptions; input?: string }[] = [];
let script: (ctx: { options: FakeOptions; onDelta?: Delta }) => Promise<{ status: string; result?: string; error?: { message: string } }>;
const closed: string[] = [];

vi.mock('@cursor/sdk', () => {
  class CursorSdkError extends Error {
    isRetryable: boolean;
    constructor(message: string, options: { isRetryable?: boolean } = {}) {
      super(message);
      this.isRetryable = options.isRetryable ?? false;
    }
  }
  class AuthenticationError extends CursorSdkError {}
  class RateLimitError extends CursorSdkError {}
  class NetworkError extends CursorSdkError {}
  const agent = (id: string, options: FakeOptions) => ({
    agentId: id,
    close: () => closed.push(id),
    send: async (input: string, sendOpts: { onDelta?: Delta }) => {
      calls[calls.length - 1].input = input;
      const pending = script({ options, onDelta: sendOpts.onDelta });
      return { wait: () => pending, cancel: async () => {} };
    },
  });
  return {
    CursorSdkError,
    AuthenticationError,
    RateLimitError,
    NetworkError,
    Agent: {
      create: async (options: FakeOptions) => {
        calls.push({ method: 'create', options });
        return agent('agent-new', options);
      },
      resume: async (id: string, options: FakeOptions) => {
        calls.push({ method: 'resume', id, options });
        return agent(id, options);
      },
    },
  };
});

const { runCursor } = await import('../src/agent/cursor.js');

const originalKey = process.env.CURSOR_API_KEY;
const roots: string[] = [];

afterEach(() => {
  calls.length = 0;
  closed.length = 0;
  if (originalKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = originalKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cursor-')));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'example.ts'), 'export const answer = 42;\n');
  return root;
}

describe('Cursor provider', () => {
  it('offers only the read-only repository tools, with no on-disk Cursor settings', async () => {
    const cwd = fixture();
    process.env.CURSOR_API_KEY = 'env-key';
    script = async () => ({ status: 'finished', result: 'ok' });
    const out = await runCursor<string>('hi', { cwd, provider: 'cursor', model: 'composer-2.5' }, {}, 'SYSTEM');
    expect(out).toEqual({ value: 'ok', sessionId: 'cursor:agent-new' });
    const { options } = calls[0];
    expect(options.tools).toEqual(['mcp']);
    expect(options.mcpServers).toBeUndefined();
    expect(options.local.settingSources).toBeUndefined();
    expect(Object.keys(options.local.customTools).sort()).toEqual(['git_history', 'read_file', 'search_repo']);
    expect(options).toMatchObject({ apiKey: 'env-key', model: { id: 'composer-2.5' }, local: { cwd } });
    // The service rejects the systemPrompt option, so it leads the first message instead.
    expect(options.systemPrompt).toBeUndefined();
    expect(calls[0].input).toBe('SYSTEM\n\nhi');
    expect(closed).toEqual(['agent-new']);
  });

  it('reads repository files through its tools and refuses paths outside the worktree', async () => {
    const cwd = fixture();
    const secret = path.join(path.dirname(cwd), `gr-cursor-secret-${process.pid}`);
    fs.writeFileSync(secret, 'secret\n');
    roots.push(secret);
    script = async ({ options }) => {
      const tools = options.local.customTools;
      const inside = await tools.read_file.execute({ path: 'example.ts' }, {});
      const absolute = await tools.read_file.execute({ path: '/etc/hosts' }, {});
      const outside = await tools.read_file.execute({ path: `../${path.basename(secret)}` }, {});
      return { status: 'finished', result: JSON.stringify({ inside, absolute, outside }) };
    };
    const { value } = await runCursor<string>('read', { cwd, provider: 'cursor' }, {}, 'S');
    const { inside, absolute, outside } = JSON.parse(value);
    expect(inside).toContain('export const answer = 42;');
    expect(absolute).toMatch(/must be relative/);
    expect(outside).toMatch(/outside the repository/);
  });

  it('stops tool calls past the limit', async () => {
    const cwd = fixture();
    script = async ({ options }) => {
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await options.local.customTools.search_repo.execute({ pattern: 'answer' }, {}));
      return { status: 'finished', result: JSON.stringify(results.at(-1)) };
    };
    const { value } = await runCursor<string>('q', { cwd, provider: 'cursor', maxTurns: 1 }, {}, 'S');
    expect(JSON.parse(value)).toMatchObject({ isError: true });
  });

  it('resumes its own sessions, passing the tools again', async () => {
    const cwd = fixture();
    script = async () => ({ status: 'finished', result: 'again' });
    const out = await runCursor<string>('follow-up', { cwd, provider: 'cursor', resume: 'cursor:agent-123' }, {}, 'SYSTEM');
    expect(calls[0]).toMatchObject({ method: 'resume', id: 'agent-123', input: 'follow-up', options: { tools: ['mcp'] } });
    expect(out.sessionId).toBe('cursor:agent-123');
    await runCursor<string>('fresh', { cwd, provider: 'cursor', resume: 'codex:thread-1' }, {}, 'S');
    expect(calls[1].method).toBe('create');
  });

  it('asks for JSON and validates it against the schema', async () => {
    const cwd = fixture();
    const schema = { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] };
    script = async () => ({ status: 'finished', result: '```json\n{"intent":"x"}\n```' });
    const { value } = await runCursor<{ intent: string }>('brief', { cwd, provider: 'cursor' }, { schema }, 'S');
    expect(value).toEqual({ intent: 'x' });
    expect(calls[0].input).toContain('Return only a JSON object matching this schema');
    script = async () => ({ status: 'finished', result: '{"other":1}' });
    await expect(runCursor('brief', { cwd, provider: 'cursor' }, { schema }, 'S')).rejects.toThrow(/does not match/);
  });

  it('streams only the text after the last tool call', async () => {
    const cwd = fixture();
    const seen: string[] = [];
    script = async ({ onDelta }) => {
      onDelta?.({ update: { type: 'text-delta', text: "I'll look." } });
      onDelta?.({ update: { type: 'tool-call-started', callId: '1' } });
      onDelta?.({ update: { type: 'text-delta', text: 'The ' } });
      onDelta?.({ update: { type: 'text-delta', text: 'answer.' } });
      return { status: 'finished', result: 'The answer.' };
    };
    await runCursor('q', { cwd, provider: 'cursor' }, { onText: (t) => seen.push(t) }, 'S');
    expect(seen).toEqual(["I'll look.", 'The ', 'The answer.']);
  });

  it('classifies failures for retry', async () => {
    const cwd = fixture();
    const sdk = await import('@cursor/sdk');
    script = async () => {
      throw new sdk.RateLimitError('slow down');
    };
    await expect(runCursor('q', { cwd, provider: 'cursor' }, {}, 'S')).rejects.toMatchObject({ name: 'ModelError', transient: true });
    script = async () => {
      throw new sdk.AuthenticationError('bad key');
    };
    await expect(runCursor('q', { cwd, provider: 'cursor' }, {}, 'S')).rejects.toMatchObject({ name: 'ModelError', transient: false, message: expect.stringContaining('CURSOR_API_KEY') });
    script = async () => ({ status: 'error', error: { message: 'model unavailable' } });
    await expect(runCursor('q', { cwd, provider: 'cursor' }, {}, 'S')).rejects.toMatchObject({ name: 'ModelError', transient: false, message: 'cursor: model unavailable' });
    expect(closed).toHaveLength(3);
  });
});
