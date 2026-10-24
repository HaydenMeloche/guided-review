import fs from 'node:fs';
import path from 'node:path';
import { grHome } from './paths.js';
import { TERMINAL_THEME } from './tui/theme.js';
import type { ChapterOrder, FileKind, KindRule, RepoConfig } from './types.js';
import { AGENT_ROLES, EFFORTS, PROVIDERS, type AgentConfig, type AgentRouting, type Effort, type Provider } from './agent/types.js';
import { CODING_AGENT_VALUES, CUSTOM_AGENT, customCommandProblem, DEFAULT_CODING_AGENT, isCodingAgent, type CodingAgent, type CodingAgentSetting } from './codingAgent.js';

export const KINDS: FileKind[] = ['logic', 'test', 'config', 'mechanical', 'generated', 'vendored'];
const REPO_CONFIG_KEYS = ['kinds', 'testPatterns', 'checklists'];

export function defaultRepoConfig(): RepoConfig {
  return { kinds: [], testPatterns: [], checklists: [] };
}

// Validates the text of a .guided-review.json; anything malformed falls back to defaults.
export function parseRepoConfig(text: string): RepoConfig {
  const cfg = defaultRepoConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return cfg;
  }
  if (!raw || typeof raw !== 'object') return cfg;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.kinds)) {
    cfg.kinds = r.kinds.filter((k): k is KindRule => !!k && typeof k === 'object' && typeof (k as KindRule).pattern === 'string' && KINDS.includes((k as KindRule).kind));
  }
  if (Array.isArray(r.testPatterns)) cfg.testPatterns = r.testPatterns.filter((p): p is string => typeof p === 'string');
  if (Array.isArray(r.checklists)) {
    cfg.checklists = r.checklists
      .filter(
        (c: unknown): c is { pattern: string; items: unknown[] } =>
          !!c && typeof c === 'object' && typeof (c as { pattern?: unknown }).pattern === 'string' && Array.isArray((c as { items?: unknown }).items),
      )
      .map((c) => ({ pattern: c.pattern, items: c.items.filter((i): i is string => typeof i === 'string') }));
  }
  return cfg;
}

// Everything in a .guided-review.json that parseRepoConfig would silently drop, as readable messages.
export function repoConfigProblems(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return [`not valid JSON: ${(e as Error).message}`];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['must contain a JSON object'];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(r)) {
    if (!REPO_CONFIG_KEYS.includes(key)) problems.push(`unknown key ${JSON.stringify(key)} (expected ${REPO_CONFIG_KEYS.join(', ')})`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (r.kinds !== undefined) {
    if (!Array.isArray(r.kinds)) problems.push('"kinds" must be an array');
    else
      r.kinds.forEach((k, i) => {
        if (!isObject(k)) return problems.push(`kinds[${i}] must be an object like { "pattern": "src/gen/**", "kind": "generated" }`);
        if (typeof k.pattern !== 'string') problems.push(`kinds[${i}] needs a string "pattern"`);
        if (!KINDS.includes(k.kind as FileKind)) problems.push(`kinds[${i}]: unknown kind ${JSON.stringify(k.kind)} (expected ${KINDS.join(', ')})`);
      });
  }
  if (r.testPatterns !== undefined) {
    if (!Array.isArray(r.testPatterns)) problems.push('"testPatterns" must be an array of globs');
    else r.testPatterns.forEach((p, i) => typeof p !== 'string' && problems.push(`testPatterns[${i}] must be a string`));
  }
  if (r.checklists !== undefined) {
    if (!Array.isArray(r.checklists)) problems.push('"checklists" must be an array');
    else
      r.checklists.forEach((c, i) => {
        if (!isObject(c)) return problems.push(`checklists[${i}] must be an object like { "pattern": "db/**", "items": ["..."] }`);
        if (typeof c.pattern !== 'string') problems.push(`checklists[${i}] needs a string "pattern"`);
        if (!Array.isArray(c.items)) problems.push(`checklists[${i}] needs an "items" array`);
        else c.items.forEach((item, j) => typeof item !== 'string' && problems.push(`checklists[${i}].items[${j}] must be a string`));
      });
  }
  return problems;
}

// The "chapterOrder" values in config.json; "guide" is the guided (flow) order.
export const CHAPTER_ORDER_SETTINGS = { guide: 'flow', risk: 'risk', size: 'size', file: 'file' } as const satisfies Record<string, ChapterOrder>;
export type ChapterOrderSetting = keyof typeof CHAPTER_ORDER_SETTINGS;
export const DEFAULT_CHAPTER_ORDER: ChapterOrderSetting = 'guide';

// How gr reaches GitHub. Unset means the gh CLI; otherwise a personal access token read from
// an environment variable or a file, sent to apiUrl (https://api.github.com by default).
export interface GitHubConfig {
  tokenEnv?: string;
  tokenFile?: string;
  apiUrl?: string;
}

// An API root as config.json may hold it: https, without a trailing slash. Returns a problem or undefined.
export function githubApiUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'enter a full URL, such as https://github.example.com/api/v3';
  }
  return url.protocol === 'https:' ? undefined : 'the GitHub API URL must use https';
}

// "provider": "none" chooses no model: every tour is built by static analysis alone, as with --no-agent.
// The model settings stay in the file, with the provider they were for in "lastProvider", so turning
// AI back on in gr config starts from them.
export const NO_PROVIDER = 'none';

export type UserConfig = Omit<AgentRouting, 'provider'> & {
  provider?: Provider | typeof NO_PROVIDER;
  lastProvider?: Provider;
  chapterOrder?: ChapterOrderSetting;
  hideWhitespace?: boolean;
  splitDiff?: boolean;
  theme?: string;
  codingAgent?: CodingAgent;
  codingAgentCommand?: string; // with "codingAgent": "custom"
  github?: GitHubConfig;
};

export class UserConfigError extends Error {}

// Models for the two tasks, with a Cursor model's variant: the fast one for the briefing and
// narration, the strong one for Q&A.
export interface ModelPair {
  fast: string;
  strong: string;
  fastParams?: Record<string, string>;
  strongParams?: Record<string, string>;
}

// Presets written by `gr config`. Cursor's name a variant at 256k context: its default variants
// are Max Mode, the most expensive way to run a model.
export const PRESET_MODELS: Partial<Record<Provider, ModelPair>> = {
  'claude-code': { fast: 'haiku', strong: 'opus' },
  anthropic: { fast: 'claude-haiku-5-5', strong: 'claude-opus-5-5' },
  bedrock: { fast: 'haiku', strong: 'opus' },
  vertex: { fast: 'haiku', strong: 'opus' },
  codex: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' },
  cursor: {
    fast: 'grok-4.7',
    strong: 'grok-4.7',
    fastParams: { context: '256k', reasoning_effort: 'low', fast: 'true' },
    strongParams: { context: '256k', reasoning_effort: 'high', fast: 'false' },
  },
  openai: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' },
};

// Providers whose preset runs the briefing and narration at low effort: fewer thinking tokens
// and tool calls on tasks that summarize. Q&A keeps the model's default.
const LOW_EFFORT_PRESETS = new Set<Provider>(['anthropic', 'claude-code', 'bedrock', 'vertex']);

export function presetUserConfig(provider: Provider, models: ModelPair, connection: Omit<AgentConfig, 'provider' | 'model' | 'modelParams'> = {}): UserConfig & AgentRouting {
  // When either task has a variant, both name theirs ({} for the default), so one can't inherit
  // the other's through the top level.
  const variants = !!(models.fastParams || models.strongParams);
  const fast: AgentConfig = {
    model: models.fast,
    ...(variants ? { modelParams: models.fastParams ?? {} } : {}),
    ...(LOW_EFFORT_PRESETS.has(provider) ? { effort: 'low' as const } : {}),
  };
  const strong = { model: models.strong, ...(variants ? { modelParams: models.strongParams ?? {} } : {}) };
  return {
    provider,
    ...strong,
    chapterOrder: DEFAULT_CHAPTER_ORDER,
    ...connection,
    roles: { briefing: { ...fast }, narration: { ...fast }, qa: strong },
  };
}

export function defaultUserConfig(): UserConfig & AgentRouting {
  return presetUserConfig('codex', PRESET_MODELS.codex!);
}

function parseAgentConfig(raw: Record<string, unknown>, where: string): AgentConfig {
  const out: AgentConfig = {};
  if (raw.provider !== undefined) {
    const provider = raw.provider;
    if (!PROVIDERS.includes(provider as Provider)) throw new UserConfigError(`${where}: unknown provider ${JSON.stringify(raw.provider)} (expected ${PROVIDERS.join(', ')})`);
    out.provider = provider as Provider;
  }
  if (typeof raw.model === 'string') out.model = raw.model;
  if (typeof raw.baseUrl === 'string') out.baseUrl = raw.baseUrl;
  if (typeof raw.apiKey === 'string' && raw.apiKey) out.apiKey = raw.apiKey;
  if (typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv) out.apiKeyEnv = raw.apiKeyEnv.replace(/^\$/, '');
  if (typeof raw.toolCalling === 'boolean') out.toolCalling = raw.toolCalling;
  if (Number.isInteger(raw.maxOutputTokens) && (raw.maxOutputTokens as number) > 0) out.maxOutputTokens = raw.maxOutputTokens as number;
  if (raw.effort !== undefined) {
    if (!EFFORTS.includes(raw.effort as Effort)) throw new UserConfigError(`${where}: unknown effort ${JSON.stringify(raw.effort)} (expected ${EFFORTS.join(', ')})`);
    out.effort = raw.effort as Effort;
  }
  if (raw.fastMode !== undefined) {
    if (typeof raw.fastMode !== 'boolean') throw new UserConfigError(`${where}: "fastMode" must be true or false`);
    out.fastMode = raw.fastMode;
  }
  if (raw.modelParams !== undefined) {
    const params = raw.modelParams;
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.values(params).some((v) => typeof v !== 'string')) {
      throw new UserConfigError(`${where}: "modelParams" must be an object of strings, such as { "reasoning_effort": "low" }`);
    }
    // Kept even when empty: {} says "the model's default variant" and stops a role inheriting one.
    out.modelParams = params as Record<string, string>;
  }
  return out;
}

export function userConfigPath(): string {
  return path.join(grHome(), 'config.json');
}

// config.json as an object, or null when there is none. The loaders below read it themselves,
// or take what this returned (null included) so that one read serves several.
export function readUserConfigFile(): Record<string, unknown> | null {
  const file = userConfigPath();
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserConfigError(`${file} must contain a JSON object`);
  return raw as Record<string, unknown>;
}

function parseChapterOrder(raw: Record<string, unknown>, where: string): ChapterOrderSetting | undefined {
  if (raw.chapterOrder === undefined) return undefined;
  if (typeof raw.chapterOrder !== 'string' || !Object.hasOwn(CHAPTER_ORDER_SETTINGS, raw.chapterOrder)) {
    throw new UserConfigError(`${where}: unknown chapterOrder ${JSON.stringify(raw.chapterOrder)} (expected ${Object.keys(CHAPTER_ORDER_SETTINGS).join(', ')})`);
  }
  return raw.chapterOrder as ChapterOrderSetting;
}

// The preferred chapter order, readable without a model provider (for --no-agent); "guide" when unset.
export function loadChapterOrder(raw = readUserConfigFile()): ChapterOrder {
  return CHAPTER_ORDER_SETTINGS[(raw && parseChapterOrder(raw, userConfigPath())) ?? DEFAULT_CHAPTER_ORDER];
}

// Diff view settings a key toggles during a tour and saves for the next one.
export type ViewSetting = 'hideWhitespace' | 'splitDiff';
const VIEW_DEFAULTS: Record<ViewSetting, boolean> = { hideWhitespace: true, splitDiff: false };

function parseViewSetting(raw: Record<string, unknown>, key: ViewSetting, where: string): boolean | undefined {
  if (raw[key] === undefined) return undefined;
  if (typeof raw[key] !== 'boolean') throw new UserConfigError(`${where}: "${key}" must be true or false`);
  return raw[key];
}

// A view setting, readable without a model provider: hideWhitespace is on when unset, splitDiff off.
export function loadViewSetting(key: ViewSetting, raw = readUserConfigFile()): boolean {
  return (raw && parseViewSetting(raw, key, userConfigPath())) ?? VIEW_DEFAULTS[key];
}

// Records a toggle. Only this key changes; the rest of the file is written back as it was.
// Without a config file it does nothing: a file holding only this would read as "no provider".
export function saveViewSetting(key: ViewSetting, value: boolean): void {
  const file = userConfigPath();
  const raw = readUserConfigFile();
  if (!raw || raw[key] === value) return;
  fs.writeFileSync(file, JSON.stringify({ ...raw, [key]: value }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function parseTheme(raw: Record<string, unknown>, where: string): string | undefined {
  if (raw.theme === undefined) return undefined;
  if (typeof raw.theme !== 'string' || !raw.theme) throw new UserConfigError(`${where}: "theme" must be a theme name`);
  return raw.theme;
}

// The color theme's name, readable without a model provider; undefined uses the terminal's colors.
// Whether the name exists is checked when the theme loads.
export function loadThemeSetting(raw = readUserConfigFile()): string | undefined {
  return raw ? parseTheme(raw, userConfigPath()) : undefined;
}

// Records the theme chosen in the picker; like saveViewSetting, it needs an existing config file.
// The terminal's colors are the default, so choosing them removes the key, as gr config does.
export function saveThemeSetting(theme: string): boolean {
  const file = userConfigPath();
  const raw = readUserConfigFile();
  if (!raw) return false;
  const { theme: saved, ...rest } = raw;
  const next = theme === TERMINAL_THEME ? rest : { ...rest, theme };
  if (saved !== (theme === TERMINAL_THEME ? undefined : theme)) {
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  return true;
}

function parseCodingAgent(raw: Record<string, unknown>, where: string): CodingAgentSetting | undefined {
  if (raw.codingAgent === undefined) return undefined;
  if (!isCodingAgent(raw.codingAgent)) {
    throw new UserConfigError(`${where}: unknown codingAgent ${JSON.stringify(raw.codingAgent)} (expected ${CODING_AGENT_VALUES.join(', ')})`);
  }
  if (raw.codingAgent !== CUSTOM_AGENT) return { agent: raw.codingAgent };
  const command = typeof raw.codingAgentCommand === 'string' ? raw.codingAgentCommand : undefined;
  if (!command?.trim()) throw new UserConfigError(`${where}: "codingAgent": "custom" needs a "codingAgentCommand", such as "aider --message"`);
  const problem = customCommandProblem(command);
  if (problem) throw new UserConfigError(`${where}: "codingAgentCommand": ${problem}`);
  return { agent: CUSTOM_AGENT, command };
}

// The coding agent o opens, readable without a model provider; Claude Code when unset.
export function loadCodingAgent(raw = readUserConfigFile()): CodingAgentSetting {
  return (raw && parseCodingAgent(raw, userConfigPath())) ?? { agent: DEFAULT_CODING_AGENT };
}

function parseGitHubConfig(raw: Record<string, unknown>, where: string): GitHubConfig | undefined {
  if (raw.github === undefined) return undefined;
  if (!raw.github || typeof raw.github !== 'object' || Array.isArray(raw.github)) throw new UserConfigError(`${where}: "github" must be an object`);
  const g = raw.github as Record<string, unknown>;
  const out: GitHubConfig = {};
  if (typeof g.tokenEnv === 'string' && g.tokenEnv) out.tokenEnv = g.tokenEnv.replace(/^\$/, '');
  else if (typeof g.tokenFile === 'string' && g.tokenFile) out.tokenFile = g.tokenFile;
  else throw new UserConfigError(`${where}: "github" needs a "tokenEnv" or a "tokenFile"`);
  if (g.apiUrl !== undefined) {
    const problem = typeof g.apiUrl === 'string' ? githubApiUrlProblem(g.apiUrl) : 'must be a string';
    if (problem) throw new UserConfigError(`${where}: github.apiUrl ${problem}`);
    out.apiUrl = (g.apiUrl as string).replace(/\/+$/, '');
  }
  return out;
}

// The GitHub settings, readable without a model provider; undefined means use the gh CLI.
export function loadGitHubConfig(): GitHubConfig | undefined {
  const raw = readUserConfigFile();
  return raw ? parseGitHubConfig(raw, userConfigPath()) : undefined;
}

function routingOf(config: UserConfig, provider: Provider | undefined): AgentRouting {
  const { model, modelParams, baseUrl, apiKey, apiKeyEnv, toolCalling, maxOutputTokens, effort, fastMode, roles } = config;
  const routing: AgentRouting = { provider, model, modelParams, baseUrl, apiKey, apiKeyEnv, toolCalling, maxOutputTokens, effort, fastMode, roles };
  return Object.fromEntries(Object.entries(routing).filter(([, v]) => v !== undefined));
}

// The model routing of a config, or undefined when it chooses no model.
export function agentRouting(config: UserConfig): AgentRouting | undefined {
  if (config.provider === NO_PROVIDER) return undefined;
  return routingOf(config, config.provider);
}

// The model settings a config with no model keeps for later, or undefined when it keeps none.
export function keptRouting(config: UserConfig): AgentRouting | undefined {
  return config.provider === NO_PROVIDER && config.lastProvider ? routingOf(config, config.lastProvider) : undefined;
}

// Throws UserConfigError when the config is missing or unusable; nothing is written implicitly.
export function loadUserConfig(raw = readUserConfigFile()): UserConfig {
  const file = userConfigPath();
  if (!raw) throw new UserConfigError(`no model provider is configured (${file} does not exist)`);
  if (raw.provider === undefined) throw new UserConfigError(`${file} does not set a "provider"`);
  // With no model, the settings kept for later are checked as settings for lastProvider.
  const noModel = raw.provider === NO_PROVIDER;
  const parsed = parseAgentConfig(noModel ? { ...raw, provider: raw.lastProvider } : raw, file);
  const out: UserConfig = noModel ? { ...parsed, provider: NO_PROVIDER, ...(parsed.provider ? { lastProvider: parsed.provider } : {}) } : parsed;
  const chapterOrder = parseChapterOrder(raw, file);
  if (chapterOrder) out.chapterOrder = chapterOrder;
  for (const key of ['hideWhitespace', 'splitDiff'] as const) {
    const value = parseViewSetting(raw, key, file);
    if (value !== undefined) out[key] = value;
  }
  const theme = parseTheme(raw, file);
  if (theme) out.theme = theme;
  const codingAgent = parseCodingAgent(raw, file);
  if (codingAgent) {
    out.codingAgent = codingAgent.agent;
    if (codingAgent.command) out.codingAgentCommand = codingAgent.command;
  }
  const github = parseGitHubConfig(raw, file);
  if (github) out.github = github;
  if (raw.roles !== undefined) {
    if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) throw new UserConfigError(`${file}: "roles" must be an object`);
    const roles = raw.roles as Record<string, unknown>;
    out.roles = {};
    for (const role of AGENT_ROLES) {
      const value = roles[role];
      if (value === undefined) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserConfigError(`${file}: roles.${role} must be an object`);
      out.roles[role] = parseAgentConfig(value as Record<string, unknown>, `${file} roles.${role}`);
    }
  }
  return out;
}

// Owner-only, since the config may hold an API key.
export function saveUserConfig(c: UserConfig): void {
  const file = userConfigPath();
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
