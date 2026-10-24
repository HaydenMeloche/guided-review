import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Claude Agent SDK is faked at query(): these check what runClaude sends and how it reads
// the result message, without starting Claude Code.
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));

import { run, runRole } from '../src/agent/agent.js';

const originalDebug = process.env.GR_DEBUG_MODEL;
const roots: string[] = [];

function result(extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'answer',
    session_id: 'sess-1',
    num_turns: 4,
    duration_ms: 1234,
    usage: { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 600 },
    ...extra,
  };
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(() =>
    (async function* () {
      yield result();
    })(),
  );
});
afterEach(() => {
  if (originalDebug === undefined) delete process.env.GR_DEBUG_MODEL;
  else process.env.GR_DEBUG_MODEL = originalDebug;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Claude Agent SDK provider', () => {
  it('passes effort into the query options only when set', async () => {
    await run('q', { cwd: '/repo', provider: 'claude-code', model: 'haiku', effort: 'low' });
    await run('q', { cwd: '/repo', provider: 'bedrock', model: 'haiku' });
    expect(query.mock.calls[0][0].options).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(query.mock.calls[1][0].options).not.toHaveProperty('effort');
  });

  it("maps the result message's usage and turns into modelUsed", async () => {
    const r = await run<string>('q', { cwd: '/repo', provider: 'vertex', model: 'opus', effort: 'medium' });
    expect(r.value).toBe('answer');
    expect(r.sessionId).toBe('sess-1');
    expect(r.modelUsed).toEqual({
      provider: 'vertex',
      model: 'opus',
      baseUrl: undefined,
      effort: 'medium',
      inputTokens: 30,
      outputTokens: 40,
      cacheReadTokens: 5000,
      cacheWriteTokens: 600,
      toolTurns: 3,
      elapsedMs: expect.any(Number),
    });
  });

  it('writes one JSON line per role call to the file GR_DEBUG_MODEL names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-debug-'));
    roots.push(root);
    const file = path.join(root, 'model.jsonl');
    process.env.GR_DEBUG_MODEL = file;
    await runRole('narration', 'p', { cwd: '/repo', provider: 'claude-code', model: 'opus', roles: { narration: { model: 'haiku', effort: 'low' } } });
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ role: 'narration', provider: 'claude-code', model: 'haiku', effort: 'low', inputTokens: 30, outputTokens: 40, toolTurns: 3 });
    expect(typeof lines[0].elapsedMs).toBe('number');
    expect(lines[0]).not.toHaveProperty('fallback');
  });
});
