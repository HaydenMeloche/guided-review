import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider adapters are the seam below run(): faking them exercises run()/runRole()'s
// retry, backoff and fallback logic without any network or SDK.
vi.mock('../src/agent/anthropic.js', () => ({ runAnthropic: vi.fn() }));
vi.mock('../src/agent/openaiResponses.js', () => ({ runOpenAI: vi.fn() }));
vi.mock('../src/agent/openaiCompatible.js', () => ({ runCompatible: vi.fn() }));

import { AgentUnavailableError, ask, run, runRole } from '../src/agent/agent.js';
import { runAnthropic } from '../src/agent/anthropic.js';
import { ModelError } from '../src/agent/http.js';
import { runOpenAI } from '../src/agent/openaiResponses.js';
import { runCompatible } from '../src/agent/openaiCompatible.js';
import type { ProviderRunConfig } from '../src/agent/types.js';
import type { Hunk } from '../src/types.js';

const anthropic = vi.mocked(runAnthropic);
const openai = vi.mocked(runOpenAI);
const compatible = vi.mocked(runCompatible);

const options: ProviderRunConfig = { cwd: '/repo', provider: 'anthropic', model: 'claude-x', apiKey: 'k' };

beforeEach(() => {
  anthropic.mockReset();
  openai.mockReset();
  compatible.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('run: retry and backoff', () => {
  it('retries transient errors on the 5s/15s/40s schedule, then succeeds', async () => {
    vi.useFakeTimers();
    anthropic
      .mockRejectedValueOnce(new ModelError('model error: rate_limit', true))
      .mockRejectedValueOnce(new ModelError('model API 529', true))
      .mockResolvedValueOnce({ value: 'ok', sessionId: 's1' });

    const result = run<string>('q', options);
    await vi.advanceTimersByTimeAsync(0);
    expect(anthropic).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(anthropic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(anthropic).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(anthropic).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(anthropic).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toEqual({ value: 'ok', sessionId: 's1', modelUsed: { provider: 'anthropic', model: 'claude-x', elapsedMs: 20_000 } });
  });

  it("waits the server's retry-after instead of the fixed step, capped at 60s", async () => {
    vi.useFakeTimers();
    anthropic
      .mockRejectedValueOnce(new ModelError('model API 429', true, 2_000))
      .mockRejectedValueOnce(new ModelError('model API 429', true, 600_000))
      .mockResolvedValueOnce({ value: 'ok' });
    const result = run<string>('q', options);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(anthropic).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(anthropic).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(anthropic).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(anthropic).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toMatchObject({ value: 'ok', modelUsed: { elapsedMs: 62_000 } });
  });

  it('puts the provider usage, the effort sent, and the elapsed time in modelUsed', async () => {
    anthropic.mockResolvedValue({ value: 'ok', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, toolTurns: 2 } });
    const r = await run<string>('q', { ...options, effort: 'low', fastMode: true });
    expect(r.modelUsed).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
      baseUrl: undefined,
      effort: 'low',
      fastMode: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      toolTurns: 2,
      elapsedMs: expect.any(Number),
    });
  });

  it('stamps effort and fast mode on OpenAI, which sends them as reasoning effort and priority processing', async () => {
    openai.mockResolvedValue({ value: 'ok', usage: { toolTurns: 0 } });
    const r = await run<string>('q', { cwd: '/repo', provider: 'openai', model: 'gpt-x', apiKey: 'k', effort: 'low', fastMode: true });
    expect(r.modelUsed).toEqual({ provider: 'openai', model: 'gpt-x', baseUrl: undefined, effort: 'low', fastMode: true, toolTurns: 0, elapsedMs: expect.any(Number) });
  });

  it('stamps no effort or fast mode for a provider that does not send them', async () => {
    compatible.mockResolvedValue({ value: 'ok', usage: { toolTurns: 0 } });
    const r = await run<string>('q', { cwd: '/repo', provider: 'openai-compatible', model: 'llama', baseUrl: 'http://localhost:1/v1', effort: 'low', fastMode: true });
    expect(r.modelUsed).toEqual({ provider: 'openai-compatible', model: 'llama', baseUrl: 'http://localhost:1/v1', toolTurns: 0, elapsedMs: expect.any(Number) });
  });

  it('gives up after the last backoff and reports the agent as unavailable', async () => {
    vi.useFakeTimers();
    anthropic.mockRejectedValue(new ModelError('overloaded', true));
    const result = run<string>('q', options);
    const assertion = expect(result).rejects.toThrow(AgentUnavailableError);
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 40_000);
    await assertion;
    expect(anthropic).toHaveBeenCalledTimes(4);
    await expect(result).rejects.toThrow('overloaded');
  });

  it('does not retry a permanent model API error, but marks the agent unavailable', async () => {
    anthropic.mockRejectedValue(new ModelError('model API 401: bad key'));
    await expect(run('q', options)).rejects.toThrow(AgentUnavailableError);
    expect(anthropic).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors as they are, without retrying', async () => {
    const boom = new Error('schema mismatch');
    anthropic.mockRejectedValue(boom);
    await expect(run('q', options)).rejects.toBe(boom);
    expect(anthropic).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when aborted during a backoff', async () => {
    vi.useFakeTimers();
    anthropic.mockRejectedValue(new ModelError('model error: overloaded', true));
    const controller = new AbortController();
    const result = run('q', options, { signal: controller.signal });
    const assertion = expect(result).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(anthropic).toHaveBeenCalledTimes(1);
  });

  it('does not call the provider when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run('q', options, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(anthropic).not.toHaveBeenCalled();
  });
});

describe('runRole: role routing and fallback', () => {
  const routing = {
    cwd: '/repo',
    provider: 'anthropic' as const,
    model: 'claude-x',
    apiKey: 'k',
    roles: { narration: { provider: 'openai' as const, model: 'gpt-x', apiKey: 'o' } },
  };

  it('uses the role override and stamps the model used', async () => {
    openai.mockResolvedValue({ value: 'narrated', sessionId: 's' });
    const r = await runRole<string>('narration', 'p', routing, { maxTurns: 3 });
    expect(r.value).toBe('narrated');
    expect(r.modelUsed).toEqual({ provider: 'openai', model: 'gpt-x', baseUrl: undefined, elapsedMs: expect.any(Number) });
    expect(anthropic).not.toHaveBeenCalled();
    expect(openai.mock.calls[0][1]).toMatchObject({ cwd: '/repo', provider: 'openai', model: 'gpt-x', maxTurns: 3 });
  });

  it('falls back to the default model when the role override fails', async () => {
    openai.mockRejectedValue(new Error('unknown model gpt-x'));
    anthropic.mockResolvedValue({ value: 'from default', sessionId: 's' });
    const r = await runRole<string>('narration', 'p', routing);
    expect(r.value).toBe('from default');
    expect(r.modelUsed).toEqual({ provider: 'anthropic', model: 'claude-x', baseUrl: undefined, fallback: true, elapsedMs: expect.any(Number) });
    expect(openai).toHaveBeenCalledTimes(1);
    expect(anthropic).toHaveBeenCalledTimes(1);
  });

  it('has nothing to fall back to for a role without an override', async () => {
    anthropic.mockRejectedValue(new Error('broken'));
    await expect(runRole('briefing', 'p', routing)).rejects.toThrow('broken');
    expect(anthropic).toHaveBeenCalledTimes(1);
    expect(openai).not.toHaveBeenCalled();
  });

  it('does not fall back after an abort', async () => {
    const controller = new AbortController();
    openai.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(runRole('narration', 'p', routing, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(anthropic).not.toHaveBeenCalled();
  });

  it('resumes and remembers the Q&A session', async () => {
    anthropic.mockResolvedValue({ value: 'a', sessionId: 'qa-2' });
    const rememberSession = vi.fn();
    await runRole('qa', 'p', { ...routing, sessions: { qa: 'qa-1' }, rememberSession });
    expect(anthropic.mock.calls[0][1]).toMatchObject({ resume: 'qa-1' });
    expect(rememberSession).toHaveBeenCalledWith('qa', 'qa-2');
  });

  it('remembers the fallback Q&A session, so a follow-up resumes the provider that answered', async () => {
    const qaRouting = { ...routing, roles: { qa: { provider: 'openai' as const, model: 'gpt-x', apiKey: 'o' } } };
    openai.mockRejectedValue(new Error('unknown model gpt-x'));
    anthropic.mockResolvedValue({ value: 'a', sessionId: 'anthropic:fallback' });
    const rememberSession = vi.fn();
    await runRole('qa', 'p', { ...qaRouting, rememberSession });
    expect(rememberSession).toHaveBeenCalledWith('qa', 'anthropic:fallback');
  });
});

describe('ask: the prompt', () => {
  const hunk: Hunk = {
    id: 'h_0123456789',
    file: 'src/pay.ts',
    header: '@@ -1,2 +1,3 @@',
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    lines: [
      { kind: 'ctx', text: 'const a = 1;', oldLine: 1, newLine: 1 },
      { kind: 'add', text: 'const b = a ?? 2;', newLine: 2 },
      { kind: 'del', text: 'const b = 2;', oldLine: 2 },
    ],
  } as unknown as Hunk;
  const history = [
    { question: 'why nullable?', answer: 'because of legacy rows (pay.ts:2)' },
    { question: 'which rows?', answer: 'pre-2020 ones' },
  ];

  const promptOf = () => anthropic.mock.calls[0][0];

  it('restates the thread and the selection when there is no session to resume', async () => {
    anthropic.mockResolvedValue({ value: 'answer', sessionId: 's' });
    const r = await ask({ ...options, question: 'and the fix?', history, hunk, lineIdx: 1, onText: () => {} });
    expect(r.value).toBe('answer');
    const prompt = promptOf();
    expect(prompt).toContain('The reviewer has selected (>> marks the selection):');
    expect(prompt).toContain('File: src/pay.ts\n@@ -1,2 +1,3 @@');
    expect(prompt).toContain('>>    2 +const b = a ?? 2;');
    expect(prompt).toContain('      1  const a = 1;');
    expect(prompt).toContain('Earlier in this thread:\n\nQ: why nullable?\nA: because of legacy rows (pay.ts:2)\n\nQ: which rows?\nA: pre-2020 ones');
    expect(prompt).toContain('Follow-up question: and the fix?');
    expect(prompt).toContain('Answer from the repository');
    expect(anthropic.mock.calls[0][1]).toMatchObject({ resume: undefined, maxTurns: 10 });
  });

  it('relies on the resumed session instead of restating it', async () => {
    anthropic.mockResolvedValue({ value: 'answer', sessionId: 's' });
    await ask({ ...options, sessions: { qa: 'qa-1' }, question: 'and the fix?', history, hunk, onText: () => {} });
    const prompt = promptOf();
    expect(prompt).not.toContain('Earlier in this thread');
    expect(prompt).not.toContain('The reviewer has selected');
    expect(prompt.startsWith('Follow-up question: and the fix?')).toBe(true);
    expect(anthropic.mock.calls[0][1]).toMatchObject({ resume: 'qa-1' });
  });

  it('asks a first question with the selection and no thread', async () => {
    anthropic.mockResolvedValue({ value: 'answer', sessionId: 's' });
    await ask({ ...options, sessions: { qa: 'stale' }, question: 'what is b?', hunk, onText: () => {} });
    const prompt = promptOf();
    expect(prompt).toContain('The reviewer has selected');
    expect(prompt).not.toContain('Earlier in this thread');
    expect(prompt).toContain('Question: what is b?');
  });

  it('tells a model without tool calling to answer from the selection only', async () => {
    anthropic.mockResolvedValue({ value: 'answer', sessionId: 's' });
    await ask({ ...options, toolCalling: false, question: 'q', history, hunk, onText: () => {} });
    expect(promptOf()).toContain('Answer using the selected code above. If that is insufficient, say so.');
  });
});
