import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider adapters are the seam below run(), as in agent.test.ts.
vi.mock('../src/agent/anthropic.js', () => ({ runAnthropic: vi.fn() }));
vi.mock('../src/agent/openaiResponses.js', () => ({ runOpenAI: vi.fn() }));

import { runAnthropic } from '../src/agent/anthropic.js';
import { ModelError } from '../src/agent/http.js';
import { runOpenAI } from '../src/agent/openaiResponses.js';
import { generateSuggestion, SuggestionError, type SuggestOptions } from '../src/agent/suggest.js';
import { hunk, tour } from './fixtures/tour.js';

const anthropic = vi.mocked(runAnthropic);
const openai = vi.mocked(runOpenAI);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-suggest-'));
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'src/cancel.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

const h = hunk('h1', 'src/cancel.ts', [
  { kind: 'ctx', text: 'function cancel() {', oldLine: 40, newLine: 40 },
  { kind: 'del', text: '  inventory.quantity -= quantity;', oldLine: 41 },
  { kind: 'add', text: '  inventory.quantity += quantity;', newLine: 41 },
  { kind: 'ctx', text: '}', oldLine: 42, newLine: 42 },
]);
const t = tour([h], []);

const base = (extra: Partial<SuggestOptions> = {}): SuggestOptions => ({
  cwd: repo,
  provider: 'anthropic',
  model: 'claude-x',
  apiKey: 'k',
  tour: t,
  hunk: h,
  anchor: { type: 'line', hunkId: 'h1', file: 'src/cancel.ts', line: 41, side: 'RIGHT' },
  instruction: 'make it idempotent',
  ...extra,
});

const output = (extra: Record<string, unknown> = {}) => ({
  value: {
    replacement: '  if (await releases.claim(order.id)) {\n    inventory.quantity += quantity;\n  }',
    explanation: 'claim() inserts a unique row per order. ',
    assumptions: ['claim() runs in the same transaction', ' '],
    citations: [{ path: 'src/cancel.ts', startLine: 3, endLine: 5 }],
    ...extra,
  },
  sessionId: 'anthropic:new',
});

beforeEach(() => {
  anthropic.mockReset();
  openai.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('generateSuggestion', () => {
  it('returns the validated proposal with the model used', async () => {
    anthropic.mockResolvedValue(output());
    const r = await generateSuggestion(base());
    expect(r).toEqual({
      code: '  if (await releases.claim(order.id)) {\n    inventory.quantity += quantity;\n  }',
      explanation: 'claim() inserts a unique row per order.',
      assumptions: ['claim() runs in the same transaction'],
      citations: [{ path: 'src/cancel.ts', startLine: 3, endLine: 5 }],
      notes: [],
      model: { provider: 'anthropic', model: 'claude-x', baseUrl: undefined, elapsedMs: expect.any(Number) },
    });
    const [prompt, config, opts] = anthropic.mock.calls[0];
    expect(prompt).toContain('>>   41 +  inventory.quantity += quantity;');
    expect(prompt).toContain('     41 -  inventory.quantity -= quantity;');
    expect(prompt).toContain('Propose replacement code for line 41 of src/cancel.ts');
    expect(prompt).toContain("The reviewer's instruction: make it idempotent");
    expect(prompt).toContain('ONLY the code that replaces the >> lines');
    expect(prompt).toContain('available read-only tools');
    expect(config).toMatchObject({ cwd: repo, maxTurns: 8, keepSession: false, resume: undefined });
    expect(config).not.toHaveProperty('tour');
    expect(opts.schema).toMatchObject({ required: ['replacement', 'explanation', 'assumptions', 'citations'] });
  });

  it('includes the enclosing declaration, two tests, five callers and the refs', async () => {
    anthropic.mockResolvedValue(output());
    const test = (n: number) => ({ testFile: 'test/c.test.ts', testName: `case ${n}`, startLine: n * 10, lines: ['expect(1)'], source: 'naming' as const, confidence: 1 });
    await generateSuggestion(
      base({
        enclosing: { name: 'cancel', startLine: 40, endLine: 42, text: 'function cancel() {\n  ...\n}' },
        tests: [test(1), test(2), test(3)],
        callers: Array.from({ length: 7 }, (_, i) => ({ file: 'src/x.ts', line: i + 1, text: ` cancel(${i})` })),
        refs: [{ id: 'r', kind: 'range', path: 'src/stock.ts', commitSha: 'head', startLine: 84, endLine: 96, label: 'stock.ts:84-96' }],
        previous: { code: 'old();', feedback: 'keep the guard' },
      }),
    );
    const prompt = anthropic.mock.calls[0][0];
    expect(prompt).toContain('Enclosing declaration cancel (lines 40-42)');
    expect(prompt).toContain('"case 2"');
    expect(prompt).not.toContain('"case 3"');
    expect(prompt).toContain('src/x.ts:5: cancel(4)');
    expect(prompt).not.toContain('src/x.ts:6:');
    expect(prompt).toContain('- stock.ts:84-96: src/stock.ts:84-96');
    expect(prompt).toContain("The reviewer's feedback on it: keep the guard");
  });

  it('tells a model without tool calling to use the given context only', async () => {
    anthropic.mockResolvedValue(output());
    await generateSuggestion(base({ toolCalling: false }));
    expect(anthropic.mock.calls[0][0]).toContain('Answer from the context above only; you cannot read the repository.');
  });

  it('drops citations that do not resolve inside the worktree', async () => {
    anthropic.mockResolvedValue(
      output({
        citations: [
          { path: './src/cancel.ts', startLine: 20 },
          { path: 'src/cancel.ts', startLine: 18, endLine: 21 },
          { path: 'src/missing.ts', startLine: 1 },
          { path: '../etc/passwd', startLine: 1 },
        ],
      }),
    );
    const r = await generateSuggestion(base());
    expect(r.citations).toEqual([{ path: 'src/cancel.ts', startLine: 20 }]);
    expect(r.notes).toContain("3 citations didn't match the repository and were removed.");
  });

  it('trims surrounding lines the model repeated', async () => {
    anthropic.mockResolvedValue(output({ replacement: 'function cancel() {\n  inventory.quantity = 0;\n}' }));
    const r = await generateSuggestion(base());
    expect(r.code).toBe('  inventory.quantity = 0;');
    expect(r.notes).toContain('The model included surrounding lines. They were removed from the proposal.');
  });

  it('reports output that fails the schema or the checks as invalid', async () => {
    anthropic.mockRejectedValue(new Error('model returned JSON that does not match the requested schema'));
    await expect(generateSuggestion(base())).rejects.toMatchObject({ kind: 'invalid-output' });
    anthropic.mockResolvedValue(output({ replacement: '  inventory.quantity += quantity;' }));
    const e = await generateSuggestion(base()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SuggestionError);
    expect(e).toMatchObject({ kind: 'invalid-output', message: 'The proposal is identical to the selected code.' });
  });

  it('refuses an anchor GitHub cannot apply a suggestion to, without calling the model', async () => {
    await expect(generateSuggestion(base({ anchor: { type: 'line', hunkId: 'h1', file: 'src/cancel.ts', line: 41, side: 'LEFT' } }))).rejects.toMatchObject({ kind: 'not-applicable' });
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('maps an aborted request', async () => {
    const controller = new AbortController();
    anthropic.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(generateSuggestion(base({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted', message: 'Suggestion cancelled.' });
  });

  it('retries transient errors, then reports the model as unavailable', async () => {
    vi.useFakeTimers();
    anthropic.mockRejectedValue(new ModelError('overloaded', true));
    const result = generateSuggestion(base());
    const assertion = expect(result).rejects.toMatchObject({ kind: 'unavailable', message: 'The model is unavailable: overloaded' });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(anthropic).toHaveBeenCalledTimes(4);
  });

  it('leaves the Q&A session alone', async () => {
    anthropic.mockResolvedValue(output());
    const rememberSession = vi.fn();
    await generateSuggestion(base({ sessions: { qa: 'anthropic:qa-1' }, rememberSession }));
    expect(anthropic.mock.calls[0][1]).toMatchObject({ resume: undefined, keepSession: false });
    expect(rememberSession).not.toHaveBeenCalled();
  });

  it('uses the qa role override and falls back to the default model', async () => {
    const roles = { qa: { provider: 'openai' as const, model: 'gpt-x', apiKey: 'o' } };
    openai.mockResolvedValueOnce(output());
    expect((await generateSuggestion(base({ roles }))).model).toEqual({ provider: 'openai', model: 'gpt-x', baseUrl: undefined, elapsedMs: expect.any(Number) });
    expect(anthropic).not.toHaveBeenCalled();

    openai.mockRejectedValueOnce(new Error('unknown model gpt-x'));
    anthropic.mockResolvedValueOnce(output());
    const r = await generateSuggestion(base({ roles }));
    expect(r.model).toEqual({ provider: 'anthropic', model: 'claude-x', baseUrl: undefined, fallback: true, elapsedMs: expect.any(Number) });
    expect(anthropic.mock.calls[0][1]).toMatchObject({ keepSession: false });
  });
});
