import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentRouting,
  defaultUserConfig,
  keptRouting,
  loadChapterOrder,
  loadCodingAgent,
  loadUserConfig,
  loadThemeSetting,
  loadViewSetting,
  loadGlyphSetting,
  loadTipsSeen,
  saveTipSeen,
  parseRepoConfig,
  PRESET_MODELS,
  presetUserConfig,
  repoConfigProblems,
  saveUserConfig,
  saveThemeSetting,
  saveViewSetting,
  UserConfigError,
  userConfigPath,
} from '../src/config.js';
import { configForRole, resolveApiKey, validateRouting } from '../src/agent/types.js';
import { describeUserConfig } from '../src/setup.js';

const originalHome = process.env.GR_HOME;
const originalKey = process.env.GR_TEST_KEY;
const roots: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.GR_HOME;
  else process.env.GR_HOME = originalHome;
  if (originalKey === undefined) delete process.env.GR_TEST_KEY;
  else process.env.GR_TEST_KEY = originalKey;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function configFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-config-'));
  roots.push(root);
  process.env.GR_HOME = root;
  return path.join(root, 'config.json');
}

describe('user config', () => {
  it('errors instead of writing a default when no config exists', () => {
    const file = configFile();
    expect(() => loadUserConfig()).toThrow(UserConfigError);
    expect(() => loadUserConfig()).toThrow(/no model provider is configured/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects configs without a provider, with an unknown provider, or with invalid JSON', () => {
    const file = configFile();
    fs.writeFileSync(file, '{}\n');
    expect(() => loadUserConfig()).toThrow(/does not set a "provider"/);
    fs.writeFileSync(file, '{"provider":"gemini"}\n');
    expect(() => loadUserConfig()).toThrow(/unknown provider "gemini"/);
    fs.writeFileSync(file, '{"provider":"claude-code", "roles": {"qa": {"provider":"nope"}}}\n');
    expect(() => loadUserConfig()).toThrow(/roles.qa: unknown provider/);
    fs.writeFileSync(file, '{"provider":');
    expect(() => loadUserConfig()).toThrow(/not valid JSON/);
  });

  it('loads a custom config without rewriting it', () => {
    const file = configFile();
    const custom = '{"provider":"openai","model":"example","apiKeyEnv":"$MY_KEY"}\n';
    fs.writeFileSync(file, custom);
    expect(loadUserConfig()).toEqual({ provider: 'openai', model: 'example', apiKeyEnv: 'MY_KEY' });
    expect(fs.readFileSync(file, 'utf8')).toBe(custom);
  });

  it('loads a config that chooses no model, keeping its model settings for later', () => {
    const file = configFile();
    fs.writeFileSync(file, '{"provider":"none","lastProvider":"openai","model":"m","apiKeyEnv":"K","roles":{"qa":{"model":"q"}},"chapterOrder":"risk","theme":"nord"}\n');
    const config = loadUserConfig();
    expect(config).toEqual({ provider: 'none', lastProvider: 'openai', model: 'm', apiKeyEnv: 'K', roles: { qa: { model: 'q' } }, chapterOrder: 'risk', theme: 'nord' });
    expect(agentRouting(config)).toBeUndefined();
    expect(keptRouting(config)).toEqual({ provider: 'openai', model: 'm', apiKeyEnv: 'K', roles: { qa: { model: 'q' } } });
    expect(loadChapterOrder()).toBe('risk');
    expect(describeUserConfig(config)[0]).toMatch(/^Provider: none \(no AI/);
    expect(describeUserConfig(config).join('\n')).not.toMatch(/Q&A|API key/);
    expect(describeUserConfig(config)).toContain('Kept for later: your openai settings');
    // Kept settings are still checked.
    fs.writeFileSync(file, '{"provider":"none","roles":{"qa":{"provider":"nope"}}}\n');
    expect(() => loadUserConfig()).toThrow(/roles.qa: unknown provider/);
  });

  it('routes only the model settings', () => {
    const config = { ...presetUserConfig('openai', PRESET_MODELS.openai!), chapterOrder: 'risk' as const, theme: 'nord', github: { tokenEnv: 'T' } };
    const routing = agentRouting(config)!;
    expect(routing).not.toHaveProperty('theme');
    expect(routing).not.toHaveProperty('github');
    expect(routing).not.toHaveProperty('chapterOrder');
    expect(configForRole(routing, 'qa').model).toBe('gpt-6.1-sol');
  });

  it('defaults to Codex with Luna briefing and narration, Sol Q&A', () => {
    const config = defaultUserConfig();
    expect(config.provider).toBe('codex');
    expect(configForRole(config, 'briefing').model).toBe('gpt-6-luna');
    expect(configForRole(config, 'narration').model).toBe('gpt-6-luna');
    expect(configForRole(config, 'qa').model).toBe('gpt-6.1-sol');
  });

  it("saves Cursor's variants, and an empty one, so neither task takes the other's", () => {
    configFile();
    const config = presetUserConfig('cursor', { fast: 'grok-4.7', strong: 'grok-4.7', strongParams: { reasoning_effort: 'high' } });
    saveUserConfig(config);
    const loaded = loadUserConfig();
    expect(loaded).toEqual(config);
    const routing = agentRouting(loaded);
    expect(configForRole(routing, 'narration').modelParams).toEqual({});
    expect(configForRole(routing, 'qa').modelParams).toEqual({ reasoning_effort: 'high' });
    fs.writeFileSync(userConfigPath(), JSON.stringify({ provider: 'cursor', modelParams: { fast: true } }));
    expect(() => loadUserConfig()).toThrow(/"modelParams" must be an object of strings/);
  });

  it('validates effort and fastMode, at the top level and in a role', () => {
    const file = configFile();
    fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', model: 'm', effort: 'high', fastMode: false, roles: { qa: { effort: 'max', fastMode: true } } }));
    expect(loadUserConfig()).toEqual({ provider: 'anthropic', model: 'm', effort: 'high', fastMode: false, roles: { qa: { effort: 'max', fastMode: true } } });
    fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', effort: 'extreme' }));
    expect(() => loadUserConfig()).toThrow(UserConfigError);
    expect(() => loadUserConfig()).toThrow(/unknown effort "extreme" \(expected low, medium, high, xhigh, max\)/);
    fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', roles: { narration: { effort: 2 } } }));
    expect(() => loadUserConfig()).toThrow(/roles.narration: unknown effort 2/);
    fs.writeFileSync(file, JSON.stringify({ provider: 'anthropic', roles: { qa: { fastMode: 'yes' } } }));
    expect(() => loadUserConfig()).toThrow(/roles.qa: "fastMode" must be true or false/);
  });

  it("lets a role's effort win over the top-level one, which applies to roles without their own", () => {
    const routing = { provider: 'anthropic' as const, model: 'big', effort: 'high' as const, roles: { narration: { model: 'small', effort: 'low' as const }, briefing: { model: 'small' } } };
    expect(configForRole(routing, 'narration').effort).toBe('low');
    expect(configForRole(routing, 'briefing').effort).toBe('high');
    expect(configForRole(routing, 'qa').effort).toBe('high');
  });

  it('presets low effort for the briefing and narration on Claude, OpenAI, and Codex, and none for Q&A', () => {
    for (const provider of ['anthropic', 'claude-code', 'bedrock', 'vertex', 'openai', 'codex'] as const) {
      const config = presetUserConfig(provider, PRESET_MODELS[provider]!);
      expect(configForRole(config, 'briefing').effort).toBe('low');
      expect(configForRole(config, 'narration').effort).toBe('low');
      expect(configForRole(config, 'qa').effort).toBeUndefined();
      expect(config.effort).toBeUndefined();
      expect(config.fastMode).toBeUndefined();
    }
    for (const provider of ['cursor'] as const) {
      const config = presetUserConfig(provider, PRESET_MODELS[provider]!);
      expect(configForRole(config, 'narration').effort).toBeUndefined();
    }
  });

  it('routes OpenAI briefing and narration to Luna, Q&A to Sol', () => {
    const file = configFile();
    const config = presetUserConfig('openai', PRESET_MODELS.openai!, { apiKeyEnv: 'OPENAI_API_KEY' });
    saveUserConfig(config);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(config);
    expect(loadUserConfig()).toEqual(config);
    expect(configForRole(config, 'briefing').model).toBe('gpt-6-luna');
    expect(configForRole(config, 'narration').model).toBe('gpt-6-luna');
    expect(configForRole(config, 'qa').model).toBe('gpt-6.1-sol');
    expect(configForRole(config, 'qa').apiKeyEnv).toBe('OPENAI_API_KEY');
  });

  it('defaults the chapter order to guide', () => {
    configFile();
    expect(loadChapterOrder()).toBe('flow');
    expect(defaultUserConfig().chapterOrder).toBe('guide');
  });

  it('hides whitespace by default and reads the saved setting, even without a provider', () => {
    const file = configFile();
    expect(loadViewSetting('hideWhitespace')).toBe(true);
    fs.writeFileSync(file, '{"hideWhitespace":false}\n');
    expect(loadViewSetting('hideWhitespace')).toBe(false);
    fs.writeFileSync(file, '{"provider":"openai","hideWhitespace":false}\n');
    expect(loadUserConfig().hideWhitespace).toBe(false);
    fs.writeFileSync(file, '{"hideWhitespace":"no"}\n');
    expect(() => loadViewSetting('hideWhitespace')).toThrow(/"hideWhitespace" must be true or false/);
  });

  it('saves the whitespace setting without touching the rest of the config', () => {
    const file = configFile();
    saveViewSetting('hideWhitespace', false);
    expect(fs.existsSync(file)).toBe(false); // no config yet: nothing is created
    fs.writeFileSync(file, '{"provider":"openai","apiKeyEnv":"KEY","custom":{"a":1}}\n');
    saveViewSetting('hideWhitespace', false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'openai', apiKeyEnv: 'KEY', custom: { a: 1 }, hideWhitespace: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadViewSetting('hideWhitespace')).toBe(false);
  });

  it('remembers first-run tips shown, without touching the rest of the config', () => {
    const file = configFile();
    expect(loadTipsSeen()).toEqual([]);
    saveTipSeen('first-chapter');
    expect(fs.existsSync(file)).toBe(false); // no config yet: nothing is created
    fs.writeFileSync(file, '{"provider":"none"}\n');
    saveTipSeen('first-chapter');
    saveTipSeen('first-chapter');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'none', tipsSeen: ['first-chapter'] });
    expect(loadTipsSeen()).toEqual(['first-chapter']);
    fs.writeFileSync(file, '{"tipsSeen":"all"}\n');
    expect(() => loadTipsSeen()).toThrow(/"tipsSeen" must be a list of tip names/);
  });

  it('reads the glyph set without a provider: unicode by default, or ascii', () => {
    const file = configFile();
    expect(loadGlyphSetting()).toBe('unicode');
    fs.writeFileSync(file, '{"glyphs":"ascii"}\n');
    expect(loadGlyphSetting()).toBe('ascii');
    fs.writeFileSync(file, '{"provider":"openai","glyphs":"ascii"}\n');
    expect(loadUserConfig().glyphs).toBe('ascii');
    fs.writeFileSync(file, '{"glyphs":"emoji"}\n');
    expect(() => loadGlyphSetting()).toThrow(/unknown glyphs "emoji" \(expected unicode or ascii\)/);
  });

  it('reads and saves the color theme without a provider and leaves the rest of the config alone', () => {
    const file = configFile();
    expect(loadThemeSetting()).toBeUndefined();
    expect(saveThemeSetting('nord')).toBe(false); // no config yet: nothing is created
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '{"provider":"openai","splitDiff":true}\n');
    expect(saveThemeSetting('nord')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'openai', splitDiff: true, theme: 'nord' });
    expect(loadThemeSetting()).toBe('nord');
    expect(loadUserConfig().theme).toBe('nord');
    expect(saveThemeSetting('terminal')).toBe(true); // the default: the key goes, as gr config does
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'openai', splitDiff: true });
    fs.writeFileSync(file, '{"theme":7}\n');
    expect(() => loadThemeSetting()).toThrow(/"theme" must be a theme name/);
  });

  it('loads from a config already read instead of the file', () => {
    const file = configFile();
    fs.writeFileSync(file, '{"provider":"openai","chapterOrder":"size","splitDiff":false,"theme":"nord","codingAgent":"codex"}\n');
    const raw = { provider: 'anthropic', chapterOrder: 'risk', splitDiff: true, theme: 'dracula', codingAgent: 'gemini' };
    expect(loadUserConfig(raw).provider).toBe('anthropic');
    expect(loadChapterOrder(raw)).toBe('risk');
    expect(loadViewSetting('splitDiff', raw)).toBe(true);
    expect(loadThemeSetting(raw)).toBe('dracula');
    expect(loadCodingAgent(raw)).toEqual({ agent: 'gemini' });
    // null is a read that found no file: defaults, without looking at the one that is there.
    expect(() => loadUserConfig(null)).toThrow(/does not exist/);
    expect(loadChapterOrder(null)).toBe('flow');
    expect(loadViewSetting('splitDiff', null)).toBe(false);
    expect(loadThemeSetting(null)).toBeUndefined();
    expect(loadCodingAgent(null)).toEqual({ agent: 'claude' });
    expect(() => loadThemeSetting({ theme: 7 })).toThrow(UserConfigError);
  });

  it('keeps split view off by default and saves it beside the whitespace setting', () => {
    const file = configFile();
    expect(loadViewSetting('splitDiff')).toBe(false);
    fs.writeFileSync(file, '{"provider":"openai","hideWhitespace":false}\n');
    saveViewSetting('splitDiff', true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'openai', hideWhitespace: false, splitDiff: true });
    expect(loadViewSetting('splitDiff')).toBe(true);
    expect(loadUserConfig().splitDiff).toBe(true);
    fs.writeFileSync(file, '{"splitDiff":1}\n');
    expect(() => loadViewSetting('splitDiff')).toThrow(/"splitDiff" must be true or false/);
  });

  it('reads the coding agent o opens, Claude Code when unset, even without a provider', () => {
    const file = configFile();
    expect(loadCodingAgent()).toEqual({ agent: 'claude' });
    fs.writeFileSync(file, '{"codingAgent":"codex"}\n');
    expect(loadCodingAgent()).toEqual({ agent: 'codex' });
    fs.writeFileSync(file, '{"codingAgent":"custom","codingAgentCommand":"aider --message"}\n');
    expect(loadCodingAgent()).toEqual({ agent: 'custom', command: 'aider --message' });
    fs.writeFileSync(file, '{"codingAgent":"custom"}\n');
    expect(() => loadCodingAgent()).toThrow(/"codingAgent": "custom" needs a "codingAgentCommand"/);
    fs.writeFileSync(file, '{"codingAgent":"custom","codingAgentCommand":"\\"\\" --message"}\n');
    expect(() => loadCodingAgent()).toThrow(/"codingAgentCommand": the first word must name the program to run/);
    fs.writeFileSync(file, '{"provider":"openai","codingAgent":"gemini"}\n');
    expect(loadUserConfig().codingAgent).toBe('gemini');
    expect(describeUserConfig(loadUserConfig())).toContain('Coding agent (o): Gemini CLI');
    fs.writeFileSync(file, '{"provider":"openai","codingAgent":"vim"}\n');
    expect(() => loadCodingAgent()).toThrow(/unknown codingAgent "vim" \(expected claude, codex, cursor, gemini, opencode, pi, custom\)/);
    expect(() => loadUserConfig()).toThrow(/unknown codingAgent "vim"/);
  });

  it('reads the preferred chapter order, even without a provider', () => {
    const file = configFile();
    fs.writeFileSync(file, '{"chapterOrder":"risk"}\n');
    expect(loadChapterOrder()).toBe('risk');
    fs.writeFileSync(file, '{"provider":"openai","chapterOrder":"guide"}\n');
    expect(loadChapterOrder()).toBe('flow');
    expect(loadUserConfig().chapterOrder).toBe('guide');
    fs.writeFileSync(file, '{"provider":"openai","chapterOrder":"flow"}\n');
    expect(() => loadChapterOrder()).toThrow(/unknown chapterOrder "flow"/);
    expect(() => loadUserConfig()).toThrow(/unknown chapterOrder "flow"/);
  });

  it('saves the config readable only by its owner', () => {
    const file = configFile();
    saveUserConfig(presetUserConfig('openai', { fast: 'a', strong: 'b' }, { apiKey: 'sk-secret' }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadUserConfig().apiKey).toBe('sk-secret');
  });
});

describe('API keys', () => {
  it('prefers a saved key, then the named variable, then the provider default', () => {
    process.env.GR_TEST_KEY = 'from-env';
    expect(resolveApiKey({ provider: 'openai', apiKey: 'saved', apiKeyEnv: 'GR_TEST_KEY' })).toEqual({ key: 'saved', source: 'config.json' });
    expect(resolveApiKey({ provider: 'openai', apiKeyEnv: 'GR_TEST_KEY' })).toEqual({ key: 'from-env', source: '$GR_TEST_KEY' });
    expect(resolveApiKey({ provider: 'openai-compatible' }).source).toBe('$OPENAI_API_KEY');
    expect(resolveApiKey({ provider: 'anthropic' }).source).toBe('$ANTHROPIC_API_KEY');
    expect(resolveApiKey({ provider: 'claude-code' })).toEqual({});
    expect(resolveApiKey({ provider: 'bedrock' })).toEqual({});
  });

  it('fails validation when a required key is missing', () => {
    delete process.env.GR_TEST_KEY;
    const openai = presetUserConfig('openai', { fast: 'a', strong: 'b' }, { apiKeyEnv: 'GR_TEST_KEY' });
    expect(() => validateRouting(openai)).toThrow(/\$GR_TEST_KEY is not set/);
    expect(() => validateRouting({ ...openai, apiKey: 'saved' })).not.toThrow();
    // Claude Code uses its own login, and local endpoints may need no key.
    expect(() => validateRouting(defaultUserConfig())).not.toThrow();
    const anthropic = presetUserConfig('anthropic', { fast: 'a', strong: 'b' }, { apiKeyEnv: 'GR_TEST_KEY' });
    expect(() => validateRouting(anthropic)).toThrow(/anthropic needs an API key, but \$GR_TEST_KEY is not set/);
    expect(() => validateRouting({ ...anthropic, apiKey: 'saved' })).not.toThrow();
    expect(() => validateRouting({ provider: 'openai-compatible', model: 'm', baseUrl: 'http://localhost:1/v1' })).not.toThrow();
  });
});

describe('repo config problems', () => {
  it('accepts a valid config', () => {
    const text = JSON.stringify({ kinds: [{ pattern: 'src/gen/**', kind: 'generated' }], testPatterns: ['**/*.it.ts'], checklists: [{ pattern: 'db/**', items: ['Reversible'] }] });
    expect(repoConfigProblems(text)).toEqual([]);
  });

  it('reports what parseRepoConfig would silently drop', () => {
    const text = JSON.stringify({ kind: [], kinds: [{ pattern: 'docs/**', kind: 'docs' }, 'x'], testPatterns: [1], checklists: [{ pattern: 'db/**' }] });
    expect(repoConfigProblems(text)).toEqual([
      'unknown key "kind" (expected kinds, testPatterns, checklists)',
      'kinds[0]: unknown kind "docs" (expected logic, test, config, mechanical, generated, vendored)',
      'kinds[1] must be an object like { "pattern": "src/gen/**", "kind": "generated" }',
      'testPatterns[0] must be a string',
      'checklists[0] needs an "items" array',
    ]);
  });

  it('reports invalid JSON', () => {
    expect(repoConfigProblems('{"kinds":')[0]).toMatch(/^not valid JSON/);
    expect(repoConfigProblems('[]')).toEqual(['must contain a JSON object']);
  });
});

describe('docs/examples', () => {
  const dir = path.join(import.meta.dirname, '..', 'docs', 'examples');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`${name} is a valid repo config`, () => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(repoConfigProblems(text)).toEqual([]);
      const cfg = parseRepoConfig(text);
      expect(cfg.kinds.length + cfg.testPatterns.length + cfg.checklists.length).toBeGreaterThan(0);
    });
  }
});
