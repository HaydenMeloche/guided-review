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
function fakeCodex(events: unknown[], exitCode = 0): { cwd: string; calls: () => { args: string[]; stdin: string } } {
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
  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
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
    expect(stdin.startsWith('Summarize')).toBe(true);
    expect(codexArgs({ cwd: '/x' }, undefined)).not.toContain('-m');
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
