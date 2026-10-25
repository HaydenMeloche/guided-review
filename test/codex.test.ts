import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexArgs, runCodex } from '../src/agent/codex.js';

const originalPath = process.env.PATH;
const roots: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Puts a fake `codex` on PATH that records its args and stdin, then prints the given JSONL events.
function fakeCodex(events: unknown[], exitCode = 0): { cwd: string; calls: () => { args: string[]; stdin: string; schemaFile: { path: string; text: string } } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-codex-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const record = path.join(root, 'call.json');
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const at = args.indexOf('--output-schema');
  const schemaFile = at >= 0 ? { path: args[at + 1], text: fs.readFileSync(args[at + 1], 'utf8') } : undefined;
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, stdin, schemaFile }));
  for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
  process.exit(${exitCode});
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  return { cwd: root, calls: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

describe('Codex provider', () => {
  it('runs a read-only exec with the model and returns the last agent message', async () => {
    const fake = fakeCodex([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { type: 'agent_message', text: "I'll check." } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg x' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'The answer is 42.' } },
      { type: 'turn.completed' },
    ]);
    const seen: string[] = [];
    const result = await runCodex<string>('Find the answer', { provider: 'codex', model: 'gpt-6-luna', cwd: fake.cwd }, { onText: (t) => seen.push(t) }, 'Read only');
    expect(result).toEqual({ value: 'The answer is 42.', sessionId: 'codex:thread-1' });
    expect(seen).toEqual(["I'll check.", 'The answer is 42.']);
    const { args, stdin } = fake.calls();
    expect(args).toEqual(
      expect.arrayContaining(['exec', '--json', '--ignore-user-config', '--strict-config', 'default_permissions="guided_review"', 'approval_policy="never"', '-m', 'gpt-6-luna', '-C', fake.cwd]),
    );
    expect(stdin).toBe('Read only\n\nFind the answer');
  });

  it('parses structured output and resumes Q&A sessions', async () => {
    const fake = fakeCodex([
      { type: 'thread.started', thread_id: 'thread-2' },
      { type: 'item.completed', item: { type: 'agent_message', text: '```json\n{"message":"hi"}\n```' } },
    ]);
    const schema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };
    const result = await runCodex('Summarize', { provider: 'codex', cwd: fake.cwd, resume: 'codex:thread-2' }, { schema }, 'Read only');
    expect(result.value).toEqual({ message: 'hi' });
    const { args, stdin } = fake.calls();
    expect(args.slice(-3)).toEqual(['resume', 'thread-2', '-']);
    // --output-schema works on a resumed turn, so the prompt carries no schema instruction.
    expect(args.indexOf('--output-schema')).toBeLessThan(args.indexOf('resume'));
    expect(stdin).toBe('Summarize');
    expect(codexArgs({ cwd: '/x' }, undefined)).not.toContain('-m');
  });

  it('passes effort and the fast service tier as config overrides, only when set', () => {
    const args = codexArgs({ cwd: '/x', effort: 'xhigh', fastMode: true }, 'thread-1', undefined);
    expect(args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"']));
    expect(args.indexOf('model_reasoning_effort="xhigh"')).toBeLessThan(args.indexOf('resume'));
    const plain = codexArgs({ cwd: '/x', fastMode: false }, undefined, undefined).join(' ');
    expect(plain).not.toContain('model_reasoning_effort');
    expect(plain).not.toContain('service_tier');
    expect(plain).not.toContain('--output-schema');
  });

  it('sends the schema as a strict --output-schema file, removed afterwards, and drops nulls for optional fields', async () => {
    const fake = fakeCodex([
      { type: 'thread.started', thread_id: 'thread-3' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"message":"hi","detail":null}' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 40, reasoning_output_tokens: 10 } },
    ]);
    const schema = { type: 'object', properties: { message: { type: 'string' }, detail: { type: 'string' } }, required: ['message'] };
    const result = await runCodex('Summarize', { provider: 'codex', cwd: fake.cwd }, { schema }, 'Read only');
    expect(result.value).toEqual({ message: 'hi' });
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadTokens: 600 });
    const { args, stdin, schemaFile } = fake.calls();
    expect(stdin).toBe('Read only\n\nSummarize');
    expect(args[args.indexOf('--output-schema') + 1]).toBe(schemaFile.path);
    expect(JSON.parse(schemaFile.text)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { message: { type: 'string' }, detail: { type: ['string', 'null'] } },
      required: ['message', 'detail'],
    });
    expect(fs.existsSync(schemaFile.path)).toBe(false);
  });

  it('removes the schema file when the run fails', async () => {
    const fake = fakeCodex([{ type: 'turn.failed', error: { message: 'boom' } }], 1);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    await expect(runCodex('q', { provider: 'codex', cwd: fake.cwd }, { schema }, 's')).rejects.toThrow(/boom/);
    expect(fs.existsSync(fake.calls().schemaFile.path)).toBe(false);
  });

  it("reports a resumed turn's own usage from the thread's running totals", async () => {
    const turn = (input: number, output: number) => [
      { type: 'thread.started', thread_id: 'thread-4' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      { type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } },
    ];
    let fake = fakeCodex(turn(100, 5));
    const first = await runCodex('q', { provider: 'codex', cwd: fake.cwd }, {}, 's');
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 });
    fake = fakeCodex(turn(250, 12));
    const second = await runCodex('q', { provider: 'codex', cwd: fake.cwd, resume: first.sessionId }, {}, 's');
    expect(second.usage).toEqual({ inputTokens: 150, outputTokens: 7, cacheReadTokens: 0 });
    // A thread this process has no total for reports no counts rather than the whole thread's.
    fake = fakeCodex([{ ...turn(900, 9)[0], thread_id: 'thread-5' }, ...turn(900, 9).slice(1)]);
    expect((await runCodex('q', { provider: 'codex', cwd: fake.cwd, resume: 'codex:thread-5' }, {}, 's')).usage).toBeUndefined();
  });

  it('maps failed turns to model errors, retrying rate limits', async () => {
    const fake = fakeCodex(
      [
        { type: 'thread.started', thread_id: 't' },
        { type: 'turn.failed', error: { message: JSON.stringify({ status: 429, error: { message: 'slow down' } }) } },
      ],
      1,
    );
    await expect(runCodex('q', { provider: 'codex', cwd: fake.cwd }, {}, 's')).rejects.toMatchObject({ name: 'ModelError', transient: true, message: 'codex: slow down' });
    fakeCodex([{ type: 'turn.failed', error: { message: JSON.stringify({ status: 400, error: { message: 'bad model' } }) } }], 1);
    await expect(runCodex('q', { provider: 'codex', cwd: fake.cwd }, {}, 's')).rejects.toMatchObject({ name: 'ModelError', transient: false });
  });

  it('reports a missing codex CLI', async () => {
    process.env.PATH = '/nonexistent';
    await expect(runCodex('q', { provider: 'codex', cwd: os.tmpdir() }, {}, 's')).rejects.toThrow(/not installed or not on PATH/);
  });
});
