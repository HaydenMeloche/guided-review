import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { detectCodingAgents, detectGitHub, detectProviders } from '../src/detect.js';
import { checkModels, distinctModels } from '../src/agent/check.js';
import { cleanLabel, cursorOption, defaultParams, findVariant, KNOWN_MODELS, listModels, type ModelOption } from '../src/agent/models.js';
import { configForRole, formatModel, routingIdentity } from '../src/agent/types.js';
import { buildConfig, githubConfig, githubDefaults, githubProblems, modelDefaults, modelNotes, modelProblems, modelReady, replacesOverrides, type SetupResult } from '../src/setup.js';
import { NO_PROVIDER, PRESET_MODELS, presetUserConfig, type UserConfig } from '../src/config.js';
import { providerRows, SetupWizard, type Detected } from '../src/tui/SetupWizard.js';
import { terminalPalette, themeList } from '../src/tui/theme.js';
import { waitFor } from './helpers/waitFor.js';

// Stands in for Cursor's catalog; listModels imports the SDK on first use.
const cursorList = vi.hoisted(() => vi.fn());
vi.mock('@cursor/sdk', () => ({ Cursor: { models: { list: cursorList } } }));

const ENTER = '\r';
const DOWN = '\u001B[B';
const ESC = '\u001B';

const offline = (async () => {
  throw new Error('offline');
}) as unknown as typeof fetch;

describe('provider detection', () => {
  it('lists API key variables, a signed-in Codex, and a local server, recommended first', async () => {
    const run = vi.fn(async (cmd: string) => (cmd === 'codex' ? { ok: true, out: 'Logged in using ChatGPT' } : { ok: false, out: '' }));
    const fetchFn = (async (url: string) =>
      url.startsWith('http://localhost:11434') ? new Response(JSON.stringify({ data: [{ id: 'qwen3-coder' }, { id: 'llama4' }] })) : Promise.reject(new Error('refused'))) as unknown as typeof fetch;
    const found = await detectProviders({ run, env: { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: '' }, fetch: fetchFn, home: '/nowhere' });
    expect(found.map((f) => f.provider)).toEqual(['anthropic', 'codex', 'openai-compatible']);
    expect(found[0].detail).toBe('$ANTHROPIC_API_KEY is set');
    expect(found[1].detail).toBe('signed in using ChatGPT');
    expect(found[2]).toMatchObject({ baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder', 'llama4'], detail: 'Ollama is running · 2 models' });
  });

  it('finds nothing when no CLI, key, or server is there', async () => {
    const run = async () => ({ ok: false, out: '' });
    expect(await detectProviders({ run, env: {}, fetch: offline, home: '/nowhere' })).toEqual([]);
  });

  it('reports whether gh is installed and who it is signed in as, with one gh call', async () => {
    const run = vi.fn(async () => ({ ok: true, out: 'octocat' }));
    expect(await detectGitHub({ run })).toEqual({ installed: true, login: 'octocat' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('gh', ['api', 'user', '--jq', '.login'], undefined);
    expect(await detectGitHub({ run: async () => ({ ok: false, out: '', missing: true }) })).toEqual({ installed: false });
    expect(await detectGitHub({ run: async () => ({ ok: false, out: 'not logged in' }) })).toEqual({ installed: true });
  });

  it('finds the coding agents whose commands start', async () => {
    const run = vi.fn(async (cmd: string) => ({ ok: cmd !== 'gemini', out: '', missing: cmd === 'claude' || cmd === 'opencode' }));
    // A command that starts but fails is still installed.
    expect(await detectCodingAgents({ run })).toEqual(['codex', 'cursor', 'gemini', 'pi']);
    expect(run).toHaveBeenCalledWith('cursor-agent', ['--version'], undefined);
  });

  it('stops its probes when told to', async () => {
    const ac = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const run = vi.fn(async (_cmd: string, _args: string[], signal?: AbortSignal) => {
      signals.push(signal);
      return { ok: false, out: '' };
    });
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      throw new Error('refused');
    }) as unknown as typeof fetch;
    await Promise.all([detectProviders({ run, env: {}, fetch: fetchFn, home: '/nowhere', signal: ac.signal }), detectGitHub({ run, signal: ac.signal })]);
    ac.abort();
    // Commands get the signal itself; fetches get it combined with their own timeout.
    expect(signals).toHaveLength(4);
    expect(signals.every((sig) => sig?.aborted)).toBe(true);
  });
});

describe('setup answers', () => {
  it('reads the key from a variable by default, and says when it is not set', () => {
    const a = modelDefaults('anthropic', undefined);
    expect(a).toMatchObject({ keySource: 'env', apiKeyEnv: 'ANTHROPIC_API_KEY', fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' });
    expect(modelReady(a, { ANTHROPIC_API_KEY: 'sk' })).toBe(true);
    expect(modelReady(a, {})).toBe(false);
    expect(modelNotes(a, {})).toEqual(['$ANTHROPIC_API_KEY is not set in this shell. Set it before running gr.']);
    expect(modelProblems({ ...a, keySource: 'store' }).apiKey).toBe('paste your API key');
    // A remote compatible endpoint reads a variable too; only a local server found needs no key.
    expect(modelDefaults('openai-compatible', undefined).keySource).toBe('env');
  });

  it("starts a local server's setup from what detection found", () => {
    const a = modelDefaults('openai-compatible', undefined, { provider: 'openai-compatible', detail: '', baseUrl: 'http://localhost:11434/v1', models: ['qwen3-coder'] });
    expect(a).toMatchObject({ baseUrl: 'http://localhost:11434/v1', fast: 'qwen3-coder', strong: 'qwen3-coder', keySource: 'none' });
    expect(modelReady(a, {})).toBe(true);
    expect(modelProblems({ ...a, baseUrl: 'http://example.com/v1' }).baseUrl).toMatch(/https/);
  });

  it('starts from the saved settings when the provider is unchanged', () => {
    const previous = { ...presetUserConfig('openai', { fast: 'mini', strong: 'big' }), apiKeyEnv: 'MY_KEY' };
    expect(modelDefaults('openai', previous as never, undefined)).toMatchObject({ fast: 'mini', strong: 'big', keySource: 'env', apiKeyEnv: 'MY_KEY' });
    expect(modelDefaults('codex', previous as never, undefined)).toMatchObject({ fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' });
  });

  it('keeps a compatible endpoint saved without a key keyless, even when no local server is found', () => {
    const previous = presetUserConfig('openai-compatible', { fast: 'qwen3', strong: 'qwen3' }, { baseUrl: 'http://localhost:8080/v1' });
    const a = modelDefaults('openai-compatible', previous);
    expect(a).toMatchObject({ keySource: 'none', baseUrl: 'http://localhost:8080/v1' });
    expect(buildConfig(previous, a, undefined, undefined)).not.toHaveProperty('apiKeyEnv');
  });

  it('keeps the saved coding agent unless another is chosen', () => {
    const current: UserConfig = { ...presetUserConfig('codex', PRESET_MODELS.codex!), codingAgent: 'opencode' };
    const answers = modelDefaults('codex', current as never);
    expect(buildConfig(current, answers, undefined, undefined).codingAgent).toBe('opencode');
    expect(buildConfig(current, answers, undefined, undefined, { agent: 'cursor' }).codingAgent).toBe('cursor');
    expect(buildConfig(current, answers, undefined, undefined, { agent: 'custom', command: ' aider --message ' })).toMatchObject({ codingAgent: 'custom', codingAgentCommand: 'aider --message' });
    expect(buildConfig(undefined, answers, undefined, undefined)).not.toHaveProperty('codingAgent');
  });

  it('keeps output caps set by hand while the provider stays, and warns about other overrides', () => {
    const current: UserConfig = { ...presetUserConfig('anthropic', { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' }), maxOutputTokens: 4000 };
    current.roles!.qa!.maxOutputTokens = 8000;
    const same = buildConfig(current, modelDefaults('anthropic', current as never), undefined, undefined);
    expect(same).toMatchObject({ maxOutputTokens: 4000, roles: { qa: { maxOutputTokens: 8000 } } });
    expect(buildConfig(current, modelDefaults('openai', current as never), undefined, undefined)).not.toHaveProperty('maxOutputTokens');
    expect(replacesOverrides(current, 'anthropic')).toBe(false);
    current.roles!.narration = { model: 'claude-haiku-5-5', toolCalling: false };
    expect(replacesOverrides(current, 'anthropic')).toBe(true);
  });

  it('presets low effort for summaries and keeps effort and fast mode set by hand while the provider stays', () => {
    const current: UserConfig = presetUserConfig('anthropic', { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' });
    expect(current.roles).toMatchObject({ briefing: { effort: 'low' }, narration: { effort: 'low' } });
    expect(current.roles!.qa).not.toHaveProperty('effort');
    current.roles!.narration!.effort = 'medium';
    current.roles!.qa = { ...current.roles!.qa, fastMode: true };
    expect(replacesOverrides(current, 'anthropic')).toBe(false);
    const same = buildConfig(current, modelDefaults('anthropic', current as never), undefined, undefined);
    expect(same.roles).toMatchObject({ briefing: { effort: 'low' }, narration: { effort: 'medium' }, qa: { fastMode: true } });
    const other = buildConfig(current, modelDefaults('openai', current as never), undefined, undefined);
    expect(other.roles?.narration).not.toHaveProperty('effort');
    expect(other.roles?.qa).not.toHaveProperty('fastMode');
  });

  it('leaves effort and fast mode out of what the tour cache compares', () => {
    const routing = presetUserConfig('anthropic', PRESET_MODELS.anthropic!);
    const tuned = { ...routing, fastMode: true, roles: { ...routing.roles, narration: { ...routing.roles!.narration, effort: 'high' as const } } };
    expect(routingIdentity(tuned as never)).toBe(routingIdentity(routing as never));
  });

  it("doesn't let one task inherit the other's Cursor variant", () => {
    const routing = presetUserConfig('cursor', { fast: 'grok-4.7', strong: 'grok-4.7', strongParams: { reasoning_effort: 'high' } });
    expect(configForRole(routing as never, 'narration').modelParams).toEqual({});
    expect(configForRole(routing as never, 'qa').modelParams).toEqual({ reasoning_effort: 'high' });
    // Without any variant, nothing is written.
    expect(presetUserConfig('openai', PRESET_MODELS.openai!).roles?.qa).not.toHaveProperty('modelParams');
  });

  it('keeps the settings setup does not ask about', () => {
    const current: UserConfig = { ...presetUserConfig('codex', { fast: 'a', strong: 'b' }), chapterOrder: 'risk', hideWhitespace: false, splitDiff: true };
    const config = buildConfig(current, modelDefaults('anthropic', undefined, undefined), 'nord', undefined);
    expect(config).toMatchObject({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', chapterOrder: 'risk', hideWhitespace: false, splitDiff: true, theme: 'nord' });
    expect(config.github).toBeUndefined();
    expect(buildConfig(undefined, { ...modelDefaults('anthropic', undefined), keySource: 'store', apiKey: 'sk-1' }, 'terminal', undefined)).toMatchObject({ apiKey: 'sk-1', chapterOrder: 'guide' });
    expect(buildConfig(undefined, modelDefaults('anthropic', undefined, undefined), 'terminal', undefined).theme).toBeUndefined();
  });

  it('keeps the model settings for later when no model is chosen', () => {
    const current = presetUserConfig('openai', { fast: 'mini', strong: 'big' });
    const config = buildConfig(current, modelDefaults(NO_PROVIDER, undefined), undefined, undefined);
    expect(config).toMatchObject({ provider: NO_PROVIDER, lastProvider: 'openai', model: 'big' });
  });

  it('builds GitHub access from a token variable or file', () => {
    const g = githubDefaults(undefined, false);
    expect(g.method).toBe('env');
    expect(githubConfig(g)).toEqual({ tokenEnv: 'GITHUB_TOKEN' });
    expect(githubConfig({ ...g, method: 'file', tokenFile: '~/t', apiUrl: 'https://ghe.example.com/api/v3/' })).toEqual({ tokenFile: '~/t', apiUrl: 'https://ghe.example.com/api/v3' });
    expect(githubConfig({ ...g, method: 'gh' })).toBeUndefined();
    expect(githubProblems({ ...g, method: 'file' }).tokenFile).toBeDefined();
    expect(githubDefaults(undefined, true).method).toBe('gh');
  });
});

describe('model check', () => {
  it('sends one request per distinct model and reports failures', async () => {
    const routing = presetUserConfig('anthropic', { fast: 'fast-1', strong: 'strong-1' }, { apiKey: 'k' });
    expect(distinctModels(routing as never).map((c) => c.model)).toEqual(['fast-1', 'strong-1']);
    const runner = vi.fn(async (config: { model?: string }) => {
      if (config.model === 'strong-1') throw new Error('model not found');
    });
    const result = await checkModels(routing, { runner });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.map((r) => [r.model, r.ok, r.error])).toEqual([
      ['fast-1', true, undefined],
      ['strong-1', false, 'model not found'],
    ]);
  });
});

// Grok 4.7 as Cursor lists it, cut to a few variants: the default is Max Mode.
const grok = {
  id: 'grok-4.7',
  displayName: 'Grok 4.7',
  parameters: [
    {
      id: 'context',
      displayName: 'Context',
      values: [
        { value: '256k', displayName: '256K' },
        { value: '500k', displayName: '500K' },
      ],
    },
    {
      id: 'reasoning_effort',
      displayName: 'Effort',
      values: [
        { value: 'low', displayName: 'Low' },
        { value: 'high', displayName: 'High' },
      ],
    },
    { id: 'fast', displayName: 'Fast', values: [{ value: 'false' }, { value: 'true', displayName: 'Fast\u200B\u200B' }] },
  ],
  variants: [
    {
      params: [
        { id: 'context', value: '256k' },
        { id: 'reasoning_effort', value: 'low' },
        { id: 'fast', value: 'true' },
      ],
      displayName: 'Grok 4.7  Low Fast\u200B',
    },
    {
      params: [
        { id: 'context', value: '256k' },
        { id: 'reasoning_effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
      displayName: 'Grok 4.7  High Fast',
    },
    {
      params: [
        { id: 'context', value: '256k' },
        { id: 'reasoning_effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
      displayName: 'Grok 4.7  High',
    },
    {
      params: [
        { id: 'context', value: '500k' },
        { id: 'reasoning_effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
      displayName: 'Grok 4.7  High Fast',
      isDefault: true,
      isMaxMode: true,
    },
  ],
};

describe('model lists', () => {
  it('offers only the current generation of OpenAI and Anthropic models, newest first', () => {
    expect(KNOWN_MODELS.openai!.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
    expect(KNOWN_MODELS.anthropic!.map((m) => m.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']);
    // The presets are in the lists they are chosen from.
    for (const provider of ['openai', 'anthropic'] as const) {
      const ids = KNOWN_MODELS[provider]!.map((m) => m.id);
      expect(ids).toContain(PRESET_MODELS[provider]!.fast);
      expect(ids).toContain(PRESET_MODELS[provider]!.strong);
    }
  });

  it("cleans the zero-width characters and doubled spaces out of a provider's model names", () => {
    expect(cleanLabel('Grok 4.7  Low Fast\u200B\u200B')).toBe('Grok 4.7 Low Fast');
    expect(cleanLabel('\u200B ')).toBeUndefined();
  });

  it("lists a compatible endpoint's models, sending a key only when there is one", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen3-coder' }] })));
    vi.stubGlobal('fetch', fetchFn);
    try {
      expect(await listModels('openai-compatible', { baseUrl: 'http://localhost:11434/v1/' })).toEqual([{ id: 'qwen3-coder' }]);
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://localhost:11434/v1/models');
      expect(init.headers).toEqual({});
      await listModels('openai-compatible', { baseUrl: 'https://llm.example.com/v1', key: 'k' });
      expect((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({ authorization: 'Bearer k' });
      fetchFn.mockResolvedValueOnce(new Response('{"error":{"message":"bad key"}}', { status: 401, statusText: 'Unauthorized' }));
      await expect(listModels('openai-compatible', { baseUrl: 'https://llm.example.com/v1' })).rejects.toThrow('401 Unauthorized: bad key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists Cursor's models with their parameters and variants, with the key or the SDK's own login", async () => {
    cursorList.mockResolvedValue([grok, { id: 'default', displayName: 'Auto' }]);
    const [g, auto] = await listModels('cursor', { key: 'cur-key' });
    expect(cursorList).toHaveBeenLastCalledWith({ apiKey: 'cur-key' });
    expect(g.parameters!.map((p) => p.label)).toEqual(['Context', 'Effort', 'Fast']);
    expect(g.parameters![2].values).toEqual([
      { value: 'false', label: 'false' },
      { value: 'true', label: 'Fast' },
    ]);
    expect(g.variants![3]).toEqual({ params: { context: '500k', reasoning_effort: 'high', fast: 'true' }, isDefault: true, maxMode: true });
    expect(auto).toEqual({ id: 'default', label: 'Auto' });
    await listModels('cursor', {});
    expect(cursorList).toHaveBeenLastCalledWith({});
    cursorList.mockRejectedValueOnce(new Error('API key is required for cloud operations'));
    await expect(listModels('cursor', {})).rejects.toThrow('API key is required');
  });

  it('starts a Cursor model on its default variant, outside Max Mode', () => {
    const g = cursorOption(grok);
    // The default is Max Mode at 500k: the same settings at 256k instead.
    expect(defaultParams(g)).toEqual({ context: '256k', reasoning_effort: 'high', fast: 'true' });
    expect(defaultParams(cursorOption({ id: 'default', displayName: 'Auto' }))).toBeUndefined();
    expect(findVariant(g, { context: '256k', reasoning_effort: 'low', fast: 'true' })).toBeDefined();
    expect(findVariant(g, { context: '256k', reasoning_effort: 'low', fast: 'false' })).toBeUndefined();
  });

  it('keeps a variant with its own model, in the config and in what the tour cache compares', () => {
    const routing = presetUserConfig('cursor', PRESET_MODELS.cursor!);
    expect(configForRole(routing as never, 'narration')).toMatchObject({ model: 'grok-4.7', modelParams: { reasoning_effort: 'low', fast: 'true' } });
    expect(configForRole(routing as never, 'qa')).toMatchObject({ model: 'grok-4.7', modelParams: { reasoning_effort: 'high', fast: 'false' } });
    // A role naming another model by hand doesn't take the top-level model's variant.
    expect(configForRole({ provider: 'cursor', model: 'grok-4.7', modelParams: { fast: 'true' }, roles: { qa: { model: 'composer-2.5' } } }, 'qa').modelParams).toBeUndefined();
    const other = presetUserConfig('cursor', { ...PRESET_MODELS.cursor!, fastParams: { context: '256k', reasoning_effort: 'high', fast: 'true' } });
    expect(routingIdentity(other as never)).not.toBe(routingIdentity(routing as never));
    expect(formatModel('grok-4.7', { context: '256k', reasoning_effort: 'low', fast: 'true' })).toBe('grok-4.7 (256k, low, fast)');
    expect(formatModel('grok-4.7', { fast: 'false' })).toBe('grok-4.7');
  });
});

describe('setup wizard', () => {
  const codexFound: Detected = { providers: [{ provider: 'codex', detail: 'signed in using ChatGPT' }], github: { installed: true, login: 'octocat' } };

  // The coding agent step, taking the agent under the cursor.
  async function keepAgent(ui: Awaited<ReturnType<typeof wizard>>['ui']) {
    await waitFor(() => expect(ui.lastFrame()).toContain('Coding agent'));
    ui.stdin.write(ENTER);
  }

  it('lists found providers first, and keeps compatible endpoints and no model among the others', () => {
    const { found, other } = providerRows(codexFound.providers);
    expect(found.map((r) => r.value)).toEqual(['codex']);
    expect(other.map((r) => r.value)).not.toContain('codex');
    expect(other.map((r) => r.value)).toEqual(expect.arrayContaining(['openai-compatible', NO_PROVIDER]));
  });

  it('puts no model right after the recommended providers, and leaves out one that is off for now', () => {
    const { other } = providerRows([]);
    expect(other.map((r) => r.value)).toEqual(['anthropic', 'openai', 'cursor', NO_PROVIDER, 'codex', 'openai-compatible', 'bedrock', 'vertex']);
    expect([...new Set(other.map((r) => r.group))]).toEqual(['Recommended', 'Without a model', 'Other']);
  });

  async function wizard(detected: Detected, env: NodeJS.ProcessEnv, current?: UserConfig, models: ModelOption[] = []) {
    const listModelsFn = vi.fn(async (): Promise<ModelOption[]> => models);
    const onDone = vi.fn<(r: SetupResult) => void>();
    const checkModelsFn = vi.fn(async (config: UserConfig) => [{ model: config.roles?.briefing?.model ?? 'default', ok: true, ms: 1200 }]);
    const ui = render(
      <SetupWizard
        firstRun={!current}
        current={current}
        file="/tmp/config.json"
        themes={await themeList()}
        initial={terminalPalette}
        detect={Promise.resolve(detected)}
        checkModels={checkModelsFn}
        checkGitHub={async () => ({ ok: true, message: 'signed in to GitHub as octocat' })}
        env={env}
        listModels={listModelsFn}
        onDone={onDone}
      />,
    );
    return { ui, onDone, checkModelsFn, listModelsFn };
  }

  it('takes a first run from the welcome card to a saved config in a few Enters', async () => {
    const { ui, onDone, checkModelsFn } = await wizard(codexFound, {});
    await waitFor(() => expect(ui.lastFrame()).toContain('turns a pull request into a tour'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Found on this machine'));
    expect(ui.lastFrame()).toContain('✓ Codex');
    expect(ui.lastFrame()).toContain('signed in using ChatGPT');
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    // gh is signed in, so there is no GitHub step.
    await waitFor(() => expect(ui.lastFrame()).toContain('gpt-6-luna answered in 1.2s'));
    expect(ui.lastFrame()).toContain('gh is signed in as octocat');
    expect(ui.lastFrame()).not.toContain('GitHub ›');
    expect(checkModelsFn).toHaveBeenCalledTimes(1);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind).toBe('saved');
    expect(result.kind === 'saved' && result.config).toMatchObject({ provider: 'codex', chapterOrder: 'guide' });
    ui.unmount();
  });

  it('asks for what is missing: an API key, then GitHub access without gh', async () => {
    const detected: Detected = { providers: [], github: { installed: false } };
    const { ui, onDone, listModelsFn } = await wizard(detected, {});
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Nothing found on this machine'));
    // Each provider says what was looked for, so people know what to set.
    expect(ui.lastFrame()).toMatch(/Anthropic API\s+\$ANTHROPIC_API_KEY not set\s+recommended/);
    expect(ui.lastFrame()).toMatch(/OpenAI API\s+\$OPENAI_API_KEY not set/);
    expect(ui.lastFrame()).toMatch(/Cursor\s+\$CURSOR_API_KEY not set/);
    expect(ui.lastFrame()).toContain('no Codex login');
    expect(ui.lastFrame()).toContain('nothing running on localhost:11434 or localhost:1234');
    // The recommended API providers come first, with the Anthropic API under the cursor.
    expect(ui.lastFrame()).toMatch(/Anthropic API .*recommended/);
    expect(ui.lastFrame()).toMatch(/OpenAI API .*recommended/);
    expect(ui.lastFrame()).toMatch(/Cursor .*recommended/);
    expect(ui.lastFrame()).toContain('Recommended: the fastest way to run gr');
    ui.stdin.write(ENTER);
    // The key is read from a variable by default; → switches to pasting it.
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ read it from an environment variable ▶'));
    expect(ui.lastFrame()).toContain('←/→ or paste it (saved in config.json');
    ui.stdin.write('\u001B[C');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ paste it (saved in config.json'));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('Hidden as you type'));
    ui.stdin.write('sk-ant-secret');
    await waitFor(() => expect(ui.lastFrame()).toContain('•••••••••••••'));
    expect(ui.lastFrame()).not.toContain('sk-ant-secret');
    // The models are chosen from gr's list of Claude 5.x, not typed; nothing is fetched.
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ claude-haiku-5-5 ▶'));
    expect(ui.lastFrame()).toContain('Claude Haiku 5.5 · 1 of 7');
    expect(ui.lastFrame()).toContain('←/→ to choose from 7 models');
    ui.stdin.write('s'); // typing does nothing: only the arrows choose
    ui.stdin.write('\u001B[C');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ claude-sonnet-5-5 ▶'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ claude-opus-5-5 ▶'));
    ui.stdin.write('\u001B[C'); // → steps through the list
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ claude-fable-5-1 ▶'));
    ui.stdin.write('\u001B[D');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ claude-opus-5-5 ▶'));
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('GitHub access'));
    expect(ui.lastFrame()).toContain('is not installed');
    ui.stdin.write(ENTER); // the variable
    ui.stdin.write(ENTER); // the API URL
    await waitFor(() => expect(ui.lastFrame()).toContain('API URL'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    await waitFor(() => expect(ui.lastFrame()).toContain('signed in to GitHub as octocat'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant-secret',
      model: 'claude-opus-5-5',
      roles: { briefing: { model: 'claude-sonnet-5-5' }, qa: { model: 'claude-opus-5-5' } },
      github: { tokenEnv: 'GITHUB_TOKEN' },
    });
    expect(listModelsFn).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps a theme search going while the theme under the cursor is previewed', async () => {
    const { ui } = await wizard(codexFound, {});
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write('/');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('/ to search'));
    ui.stdin.write('n');
    // The first match has its own background; previewing it over the terminal's colors used to
    // remount the picker and drop the search.
    await waitFor(() => expect(ui.lastFrame()).toContain('/ n'));
    await new Promise((r) => setTimeout(r, 300));
    ui.stdin.write('o');
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('/ nor'));
    await new Promise((r) => setTimeout(r, 300));
    expect(ui.lastFrame()).toContain('/ nor');
    expect(ui.lastFrame()).toContain('Nord');
    ui.unmount();
  });

  it("chooses OpenAI models from gr's list of the current ones, without fetching", async () => {
    const detected: Detected = { providers: [{ provider: 'openai', detail: 'key set' }], github: { installed: true, login: 'octocat' } };
    const { ui, onDone, listModelsFn } = await wizard(detected, { OPENAI_API_KEY: 'sk-oa' });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('✓ OpenAI API'));
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ read it from an environment variable ▶'));
    ui.stdin.write(DOWN); // from the key source to the variable
    ui.stdin.write(DOWN); // to the summaries model
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ gpt-6-luna ▶'));
    expect(ui.lastFrame()).toContain('2 of 4');
    ui.stdin.write('\u001B[C');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ gpt-6-sol ▶'));
    ui.stdin.write(ENTER);
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({ provider: 'openai', roles: { briefing: { model: 'gpt-6-sol' } } });
    expect(listModelsFn).not.toHaveBeenCalled();
    ui.unmount();
  });

  it("chooses a Cursor model's effort, speed, and context, and saves them as its variant", async () => {
    const detected: Detected = { providers: [{ provider: 'cursor', detail: 'key set' }], github: { installed: true, login: 'octocat' } };
    const models = [cursorOption(grok), { id: 'composer-2.5', label: 'Composer 2.5' }];
    const { ui, onDone, listModelsFn } = await wizard(detected, { CURSOR_API_KEY: 'cur' }, undefined, models);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('✓ Cursor'));
    ui.stdin.write('c');
    await waitFor(() => expect(listModelsFn).toHaveBeenCalledWith('cursor', expect.objectContaining({ key: 'cur' })));
    await waitFor(() => expect(ui.lastFrame()).toContain('Grok 4.7'));
    ui.stdin.write(DOWN); // the variable
    ui.stdin.write(DOWN); // the summaries model
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ grok-4.7 ▶'));
    // The preset's variant: low effort, fast, 256k.
    expect(ui.lastFrame()).toMatch(/Context\s+‹ 256K ›/);
    expect(ui.lastFrame()).toMatch(/Effort\s+‹ Low ›/);
    expect(ui.lastFrame()).toMatch(/Fast\s+‹ fast \(costs more\) ›/);
    ui.stdin.write(DOWN); // Context
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ 256K ▶'));
    expect(ui.lastFrame()).toContain('500K (Max Mode)');
    ui.stdin.write('\u001B[C');
    // Max Mode has only high effort here, so low isn't offered at 500k.
    await waitFor(() => expect(ui.lastFrame()).toContain("Cursor doesn't offer this combination"));
    ui.stdin.write('\u001B[D');
    ui.stdin.write(DOWN); // Effort
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ Low ▶'));
    ui.stdin.write('\u001B[C');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ High ▶'));
    ui.stdin.write(DOWN); // Fast
    ui.stdin.write('\u001B[D');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ standard speed ▶'));
    expect(ui.lastFrame()).not.toContain("doesn't offer this combination");
    for (let i = 0; i < 5; i++) ui.stdin.write(ENTER); // the Q&A model and its three parameters
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    expect(ui.lastFrame()).toContain('Briefing and narration: grok-4.7 (256k, high)');
    expect(ui.lastFrame()).toContain('Q&A: grok-4.7 (256k, high)');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({
      provider: 'cursor',
      roles: {
        narration: { model: 'grok-4.7', modelParams: { context: '256k', reasoning_effort: 'high', fast: 'false' } },
        qa: { model: 'grok-4.7', modelParams: { context: '256k', reasoning_effort: 'high', fast: 'false' } },
      },
    });
    ui.unmount();
  });

  it('starts another Cursor model on its own default variant', async () => {
    const detected: Detected = { providers: [{ provider: 'cursor', detail: 'key set' }], github: { installed: true, login: 'octocat' } };
    const models = [{ id: 'composer-2.5', label: 'Composer 2.5' }, cursorOption(grok)];
    const current = presetUserConfig('cursor', { fast: 'composer-2.5', strong: 'composer-2.5' });
    const { ui } = await wizard(detected, { CURSOR_API_KEY: 'cur' }, current, models);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('✓ Cursor'));
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('composer-2.5'));
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ composer-2.5 ▶'));
    expect(ui.lastFrame()).not.toContain('Effort');
    ui.stdin.write('\u001B[C');
    // Grok's default is Max Mode at 500k; setup starts it on the same settings at 256k.
    await waitFor(() => expect(ui.lastFrame()).toMatch(/Context\s+‹ 256K ›/));
    expect(ui.lastFrame()).toMatch(/Effort\s+‹ High ›/);
    ui.unmount();
  });

  it('keeps each local server its own answers', async () => {
    const detected: Detected = {
      providers: [
        { provider: 'openai-compatible', detail: 'Ollama is running', baseUrl: 'http://localhost:11434/v1', models: ['qwen3'] },
        { provider: 'openai-compatible', detail: 'LM Studio is running', baseUrl: 'http://localhost:1234/v1', models: ['gemma4'] },
      ],
      github: { installed: true, login: 'octocat' },
    };
    const { ui, onDone } = await wizard(detected, {});
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ollama is running'));
    ui.stdin.write(ENTER); // Ollama: everything found, past the details
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Provider: openai-compatible (http://localhost:11434/v1)'));
    ui.stdin.write('b');
    await waitFor(() => expect(ui.lastFrame()).toContain('Coding agent'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('LM Studio is running'));
    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Provider: openai-compatible (http://localhost:1234/v1)'));
    expect(ui.lastFrame()).toContain('Briefing and narration: gemma4');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({ baseUrl: 'http://localhost:1234/v1', model: 'gemma4' });
    ui.unmount();
  });

  it('keeps the provider cursor on its row when detection adds rows above it', async () => {
    let finish: (d: Detected) => void = () => undefined;
    const detect = new Promise<Detected>((resolve) => (finish = resolve));
    const ui = render(
      <SetupWizard
        firstRun
        file="/tmp/config.json"
        themes={await themeList()}
        initial={terminalPalette}
        detect={detect}
        checkModels={async () => []}
        checkGitHub={async () => ({ ok: true, message: '' })}
        listModels={async () => []}
        env={{}}
        onDone={() => undefined}
      />,
    );
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Looking for Codex'));
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN); // Anthropic API, OpenAI API, Cursor
    await waitFor(() => expect(ui.lastFrame()).toContain("Cursor's models with a Cursor API key"));
    finish({
      providers: [
        { provider: 'anthropic', detail: '$ANTHROPIC_API_KEY is set' },
        { provider: 'codex', detail: 'signed in' },
      ],
      github: { installed: true, login: 'octocat' },
    });
    await waitFor(() => expect(ui.lastFrame()).toContain('Found on this machine'));
    expect(ui.lastFrame()).toContain("Cursor's models with a Cursor API key");
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/^\s*Cursor$/m));
    ui.unmount();
  });

  it("keeps a typed Cursor model on setup's variant when the list can't load", async () => {
    const detected: Detected = { providers: [{ provider: 'cursor', detail: 'key set' }], github: { installed: true, login: 'octocat' } };
    const onDone = vi.fn<(r: SetupResult) => void>();
    const ui = render(
      <SetupWizard
        firstRun
        file="/tmp/config.json"
        themes={await themeList()}
        initial={terminalPalette}
        detect={Promise.resolve(detected)}
        checkModels={async () => []}
        checkGitHub={async () => ({ ok: true, message: '' })}
        listModels={async () => {
          throw new Error('network down');
        }}
        env={{ CURSOR_API_KEY: 'cur' }}
        onDone={onDone}
      />,
    );
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('✓ Cursor'));
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('◀ read it from an environment variable ▶'));
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN); // the summaries model, a text field while there is no list
    await waitFor(() => expect(ui.lastFrame()).toContain('listing your models failed: network down'));
    ui.stdin.write('\u0015'); // Ctrl+U clears it
    await waitFor(() => expect(ui.lastFrame()).not.toMatch(/Briefing and narration\s+grok/));
    ui.stdin.write('grok-4.7');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/Briefing and narration\s+grok-4\.7/));
    ui.stdin.write(ENTER);
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    expect(ui.lastFrame()).toContain('Briefing and narration: grok-4.7 (256k, low, fast)');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({ roles: { narration: { modelParams: PRESET_MODELS.cursor!.fastParams } } });
    ui.unmount();
  });

  it('chooses the coding agent o opens, starting on the first one installed', async () => {
    const { ui, onDone } = await wizard({ ...codexFound, codingAgents: ['codex', 'gemini'] }, {});
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Found on this machine'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Coding agent'));
    expect(ui.lastFrame()).toMatch(/✓ Codex\s+codex is installed/);
    expect(ui.lastFrame()).toMatch(/Claude Code\s+claude not found/);
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    expect(ui.lastFrame()).toContain('Coding agent (o): Gemini CLI');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config.codingAgent).toBe('gemini');
    ui.unmount();
  });

  it('takes a custom command for the coding agent, and Esc goes back to the list', async () => {
    const { ui, onDone } = await wizard(codexFound, {});
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Found on this machine'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Coding agent'));
    expect(ui.lastFrame()).toMatch(/pi\s/);
    ui.stdin.write('G');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Runs without a shell'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Runs without a shell'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Runs without a shell'));
    ui.stdin.write(ENTER); // empty: stays, with the problem shown
    await waitFor(() => expect(ui.lastFrame()).toContain('enter the command that starts your agent'));
    ui.stdin.write('aider --message');
    await waitFor(() => expect(ui.lastFrame()).toContain('aider --message'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    expect(ui.lastFrame()).toContain('Coding agent (o): custom command (aider --message)');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config).toMatchObject({ codingAgent: 'custom', codingAgentCommand: 'aider --message' });
    ui.unmount();
  });

  it('keeps Claude Code under the cursor for a saved config without a coding agent', async () => {
    const current = presetUserConfig('codex', { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' });
    const { ui, onDone } = await wizard({ ...codexFound, codingAgents: ['codex'] }, {}, current);
    await waitFor(() => expect(ui.lastFrame()).toContain('Provider: codex'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Color theme'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Found on this machine'));
    ui.stdin.write(ENTER);
    await keepAgent(ui);
    await waitFor(() => expect(ui.lastFrame()).toContain('Ready to save'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.kind === 'saved' && result.config.codingAgent).toBe('claude');
    ui.unmount();
  });

  it('shows the saved settings when run again, and q leaves without saving', async () => {
    const current = presetUserConfig('codex', { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' });
    const { ui, onDone } = await wizard(codexFound, {}, current);
    await waitFor(() => expect(ui.lastFrame()).toContain('Provider: codex'));
    expect(ui.lastFrame()).not.toContain('turns a pull request into a tour');
    ui.stdin.write('q');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'cancelled' }));
    ui.unmount();
  });
});
