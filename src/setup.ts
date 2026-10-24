import fs from 'node:fs';
import path from 'node:path';
import { openInEditor } from './util/editor.js';
import {
  agentRouting,
  DEFAULT_CHAPTER_ORDER,
  keptRouting,
  defaultUserConfig,
  githubApiUrlProblem,
  KINDS,
  parseRepoConfig,
  repoConfigProblems,
  loadUserConfig,
  NO_PROVIDER,
  PRESET_MODELS,
  presetUserConfig,
  saveUserConfig,
  userConfigPath,
  type GitHubConfig,
  type UserConfig,
} from './config.js';
import { DEFAULT_API_URL, restJson } from './github/api.js';
import { isTheme, TERMINAL_THEME } from './tui/theme.js';
import { expandHome, resolveGitHubAuth } from './github/auth.js';
import { configForRole, defaultApiKeyEnv, formatModel, type AgentConfig, type AgentRouting, type Provider } from './agent/types.js';
import type { ProviderFinding } from './detect.js';
import { codingAgentName, CUSTOM_AGENT, type CodingAgentSetting } from './codingAgent.js';

function checkBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'enter a full URL, such as http://localhost:11434/v1';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  return 'remote endpoints must use https (http is allowed on localhost)';
}

function describeKey(config: AgentConfig): string {
  if (config.apiKey) return 'saved in config.json';
  const provider = config.provider ?? 'claude-code';
  if (provider === 'codex') return 'Codex CLI login';
  if (provider === 'bedrock') return 'AWS credentials';
  if (provider === 'vertex') return 'Google Cloud credentials';
  if (config.apiKeyEnv) return `$${config.apiKeyEnv}`;
  if (provider === 'claude-code') return 'Claude Code login';
  if (provider === 'openai-compatible') return 'none';
  return `$${defaultApiKeyEnv(provider)}`;
}

export function describeUserConfig(config: UserConfig): string[] {
  const routing = agentRouting(config);
  const lines = routing ? describeRouting(routing) : ['Provider: none (no AI: static analysis only, AI features are off)'];
  if (config.lastProvider) lines.push(`Kept for later: your ${config.lastProvider} settings`);
  lines.push(`Chapter order: ${config.chapterOrder ?? DEFAULT_CHAPTER_ORDER}`);
  lines.push(`Theme: ${config.theme ?? `${TERMINAL_THEME} (your terminal's colors)`}`);
  lines.push(`Coding agent (o): ${codingAgentName(config.codingAgent && { agent: config.codingAgent, command: config.codingAgentCommand })}`);
  lines.push(`GitHub: ${describeGitHub(config.github)}`);
  return lines;
}

function describeRouting(config: AgentRouting): string[] {
  const briefing = configForRole(config, 'briefing');
  const narration = configForRole(config, 'narration');
  const qa = configForRole(config, 'qa');
  const lines = [`Provider: ${config.provider}${config.baseUrl ? ` (${config.baseUrl})` : ''}`];
  const show = (c: AgentConfig) => formatModel(c.model, c.modelParams);
  if (show(briefing) === show(narration)) lines.push(`Briefing and narration: ${show(briefing)}`);
  else lines.push(`Briefing: ${show(briefing)}`, `Narration: ${show(narration)}`);
  lines.push(`Q&A: ${show(qa)}${qa.provider !== config.provider ? ` (${qa.provider})` : ''}`);
  lines.push(`API key: ${describeKey(config)}`);
  if (config.toolCalling === false) lines.push('Tool calling: off');
  return lines;
}

function describeGitHub(github: GitHubConfig | undefined): string {
  if (!github) return 'GitHub CLI (gh)';
  const source = github.tokenEnv ? `$${github.tokenEnv}` : github.tokenFile;
  return `personal access token from ${source}${github.apiUrl && github.apiUrl !== DEFAULT_API_URL ? ` (${github.apiUrl})` : ''}`;
}

export const TOKEN_HELP = [
  'Create a token at https://github.com/settings/personal-access-tokens. A fine-grained token needs read',
  'access to Contents and Metadata, and read and write access to Pull requests and Issues; a classic',
  'token needs the repo scope (and read:org for private orgs). gr reads the token each time it runs;',
  'it is not copied into config.json.',
];

// Signs in once with the token so a typo shows up now rather than on the first review.
export async function checkGitHubToken(github: GitHubConfig): Promise<{ ok: boolean; message: string }> {
  let auth;
  try {
    auth = resolveGitHubAuth(github);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!auth) return { ok: false, message: 'no token found' };
  try {
    const user = await restJson<{ login: string }>(auth, 'user', { signal: AbortSignal.timeout(10_000) });
    return { ok: true, message: `signed in to GitHub as ${user.login}` };
  } catch (e) {
    return { ok: false, message: `could not sign in to GitHub with this token: ${(e as Error).message}` };
  }
}

export type ProviderChoice = Provider | typeof NO_PROVIDER;

// The API-key providers are recommended: gr calls them from its own process, while Codex starts
// a CLI process for every call.
export const PROVIDER_CHOICES: { value: ProviderChoice; name: string; about: string; unavailable?: string; recommended?: boolean }[] = [
  { value: 'anthropic', name: 'Anthropic API', about: 'Claude models with an Anthropic API key. Recommended: the fastest way to run gr, with answers that stream.', recommended: true },
  { value: 'openai', name: 'OpenAI API', about: 'OpenAI models with an OpenAI API key. Recommended: the fastest way to run gr, with answers that stream.', recommended: true },
  { value: 'cursor', name: 'Cursor', about: "Cursor's models with a Cursor API key (Cursor plan). Recommended: gr calls Cursor's models directly from its own process.", recommended: true },
  { value: 'codex', name: 'Codex', about: 'Uses your Codex CLI login (ChatGPT plan or API key). Slower than an API key: every request starts a Codex process.' },
  { value: 'openai-compatible', name: 'OpenAI-compatible endpoint', about: 'Ollama, vLLM, LM Studio, a proxy, or any Chat Completions server.' },
  { value: 'bedrock', name: 'Claude on Amazon Bedrock', about: 'Uses your AWS credentials.' },
  { value: 'vertex', name: 'Claude on Google Vertex AI', about: 'Uses your Google Cloud credentials.' },
  { value: 'claude-code', name: 'Claude Code', about: 'Uses your Claude Code login (Claude plan).', unavailable: 'temporarily disabled because of performance issues' },
  { value: NO_PROVIDER, name: 'No AI model', about: 'Static analysis only: chapters, flags, tests, and diagrams still work. AI briefings, narration, Q&A, and suggestions are off.' },
];

export type KeySource = 'none' | 'env' | 'store';

// What the model step of setup collects. Fields a provider doesn't use are ignored.
export interface ModelAnswers {
  provider: ProviderChoice;
  fast: string; // summaries and chapter narration
  strong: string; // Q&A
  fastParams?: Record<string, string>; // a Cursor model's variant
  strongParams?: Record<string, string>;
  baseUrl: string;
  toolCalling: boolean;
  keySource: KeySource;
  apiKeyEnv: string;
  apiKey: string;
}

// Providers that take an API key from gr rather than a login or cloud credentials.
export const takesKey = (p: ProviderChoice): boolean => p === 'anthropic' || p === 'openai' || p === 'cursor' || p === 'openai-compatible';

// The answers to start from: the saved settings when the provider is unchanged, then what
// detection found (a local server's models), then the presets.
export function modelDefaults(provider: ProviderChoice, previous: AgentRouting | undefined, finding?: ProviderFinding): ModelAnswers {
  const same = provider !== NO_PROVIDER && previous?.provider === provider ? previous : undefined;
  const preset = provider === NO_PROVIDER ? undefined : PRESET_MODELS[provider];
  const savedFast = same && configForRole(same, 'briefing');
  const savedStrong = same && configForRole(same, 'qa');
  const fast = savedFast?.model ?? preset?.fast ?? finding?.models?.[0] ?? '';
  const strong = savedStrong?.model ?? preset?.strong ?? fast;
  // Each variant goes with the model it came with.
  const fastParams = savedFast?.model ? savedFast.modelParams : preset?.fastParams;
  const strongParams = savedStrong?.model ? savedStrong.modelParams : preset?.strongParams;
  const envName = provider === NO_PROVIDER ? undefined : defaultApiKeyEnv(provider);
  // A key is read from a variable unless the saved config pasted one. A compatible endpoint saved
  // without a key, or a local server found, needs none.
  const keySource: KeySource = same?.apiKey ? 'store' : same?.apiKeyEnv ? 'env' : provider === 'openai-compatible' && (same || finding?.baseUrl) ? 'none' : 'env';
  return {
    provider,
    fast,
    strong,
    ...(fastParams ? { fastParams } : {}),
    ...(strongParams ? { strongParams } : {}),
    baseUrl: same?.baseUrl ?? finding?.baseUrl ?? '',
    toolCalling: same?.toolCalling !== false,
    keySource,
    apiKeyEnv: same?.apiKeyEnv ?? envName ?? '',
    apiKey: same?.apiKey ?? '',
  };
}

const ENV_NAME = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;

// A problem with an environment variable's name as typed (a leading $ is allowed), or undefined.
function envNameProblem(value: string): string | undefined {
  return ENV_NAME.test(value) ? undefined : 'not a valid variable name';
}

// A note when the named variable isn't set in this shell.
function envNote(value: string, env: NodeJS.ProcessEnv): string[] {
  const name = value.replace(/^\$/, '');
  return name && !env[name] ? [`$${name} is not set in this shell. Set it before running gr.`] : [];
}

export function checkBaseUrlAnswer(value: string): string | undefined {
  return value ? checkBaseUrl(value) : 'enter the API base URL, including /v1';
}

// What must be fixed before the answers can be saved, by field.
export function modelProblems(a: ModelAnswers): Partial<Record<keyof ModelAnswers, string>> {
  if (a.provider === NO_PROVIDER) return {};
  const problems: Partial<Record<keyof ModelAnswers, string>> = {};
  if (a.provider === 'openai-compatible') {
    const problem = checkBaseUrlAnswer(a.baseUrl);
    if (problem) problems.baseUrl = problem;
  }
  if (!a.fast.trim()) problems.fast = 'a model is required';
  if (!a.strong.trim()) problems.strong = 'a model is required';
  const envProblem = takesKey(a.provider) && a.keySource === 'env' && envNameProblem(a.apiKeyEnv);
  if (envProblem) problems.apiKeyEnv = envProblem;
  if (takesKey(a.provider) && a.keySource === 'store' && !a.apiKey) problems.apiKey = 'paste your API key';
  return problems;
}

// Things worth saying that don't stop a save, such as a key variable this shell doesn't have.
export function modelNotes(a: ModelAnswers, env: NodeJS.ProcessEnv = process.env): string[] {
  return takesKey(a.provider) && a.keySource === 'env' ? envNote(a.apiKeyEnv, env) : [];
}

// Whether choosing the provider can skip its details: everything it needs was found.
export function modelReady(a: ModelAnswers, env: NodeJS.ProcessEnv = process.env): boolean {
  return !Object.keys(modelProblems(a)).length && !modelNotes(a, env).length;
}

export type GitHubMethod = 'gh' | 'env' | 'file';

export interface GitHubAnswers {
  method: GitHubMethod;
  tokenEnv: string;
  tokenFile: string;
  apiUrl: string;
}

export function githubDefaults(current: GitHubConfig | undefined, ghInstalled: boolean): GitHubAnswers {
  return {
    method: current?.tokenFile ? 'file' : current?.tokenEnv ? 'env' : ghInstalled ? 'gh' : 'env',
    tokenEnv: current?.tokenEnv ?? 'GITHUB_TOKEN',
    tokenFile: current?.tokenFile ?? '',
    apiUrl: current?.apiUrl ?? DEFAULT_API_URL,
  };
}

export function githubProblems(g: GitHubAnswers): Partial<Record<keyof GitHubAnswers, string>> {
  if (g.method === 'gh') return {};
  const problems: Partial<Record<keyof GitHubAnswers, string>> = {};
  const envProblem = g.method === 'env' && envNameProblem(g.tokenEnv);
  if (envProblem) problems.tokenEnv = envProblem;
  if (g.method === 'file' && !g.tokenFile.trim()) problems.tokenFile = 'enter the path of the file that holds the token';
  const urlProblem = githubApiUrlProblem(g.apiUrl);
  if (urlProblem) problems.apiUrl = urlProblem;
  return problems;
}

export function githubNotes(g: GitHubAnswers, ghInstalled: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  if (g.method === 'gh') return ghInstalled ? ['Sign in with `gh auth login` if you have not.'] : ['Install gh from https://cli.github.com and run `gh auth login` before reviewing.'];
  if (g.method === 'env') return envNote(g.tokenEnv, env);
  const file = expandHome(g.tokenFile.trim());
  if (!file) return [];
  if (!fs.existsSync(file)) return [`${g.tokenFile} does not exist yet. Save the token there before running gr.`];
  if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) return [`Other users can read ${g.tokenFile}. Consider chmod 600 ${g.tokenFile}.`];
  return [];
}

// The config's "github" value; undefined means gh.
export function githubConfig(g: GitHubAnswers): GitHubConfig | undefined {
  if (g.method === 'gh') return undefined;
  const github: GitHubConfig = g.method === 'env' ? { tokenEnv: g.tokenEnv.replace(/^\$/, '') } : { tokenFile: g.tokenFile.trim() };
  const apiUrl = g.apiUrl.replace(/\/+$/, '');
  if (apiUrl !== DEFAULT_API_URL) github.apiUrl = apiUrl;
  return github;
}

// The model settings in use, or the ones a config with no model kept for later.
export function previousRouting(current: UserConfig | undefined): AgentRouting | undefined {
  return current && (agentRouting(current) ?? keptRouting(current));
}

// Role settings setup writes or carries over; any other set by hand is replaced on save.
const KEPT_ROLE_KEYS = new Set(['model', 'modelParams', 'maxOutputTokens', 'effort', 'fastMode']);

// Whether saving a provider drops per-task overrides set by hand (another provider, endpoint,
// key, or tool calling for one task).
export function replacesOverrides(current: UserConfig | undefined, provider: ProviderChoice): boolean {
  const previous = previousRouting(current);
  return provider !== NO_PROVIDER && !!previous?.roles && Object.values(previous.roles).some((r) => r && Object.keys(r).some((k) => !KEPT_ROLE_KEYS.has(k)));
}

// The config setup saves. Settings it doesn't ask about (chapter order, the diff toggles) are kept,
// and so is the coding agent when none is given.
export function buildConfig(current: UserConfig | undefined, model: ModelAnswers, theme: string | undefined, github: GitHubConfig | undefined, codingAgent?: CodingAgentSetting): UserConfig {
  const previous = previousRouting(current);
  let config: UserConfig;
  if (model.provider === NO_PROVIDER) {
    // No model keeps the model settings, so choosing a provider again starts from them.
    config = { ...previous, provider: NO_PROVIDER, ...(previous?.provider ? { lastProvider: previous.provider } : {}) };
  } else {
    const connection: Omit<AgentConfig, 'provider' | 'model'> = {};
    if (model.provider === 'openai-compatible') {
      connection.baseUrl = model.baseUrl;
      if (!model.toolCalling) connection.toolCalling = false;
    }
    if (takesKey(model.provider) && model.keySource === 'env') connection.apiKeyEnv = model.apiKeyEnv.replace(/^\$/, '');
    if (takesKey(model.provider) && model.keySource === 'store') connection.apiKey = model.apiKey;
    config = presetUserConfig(model.provider, { fast: model.fast.trim(), strong: model.strong.trim(), fastParams: model.fastParams, strongParams: model.strongParams }, connection);
    // Output caps, effort, and fast mode set by hand stay while the provider does; setup doesn't
    // ask for them.
    if (previous?.provider === model.provider) {
      if (previous.maxOutputTokens) config.maxOutputTokens = previous.maxOutputTokens;
      if (previous.effort) config.effort = previous.effort;
      if (previous.fastMode !== undefined) config.fastMode = previous.fastMode;
      for (const [role, settings] of Object.entries(config.roles ?? {})) {
        const kept = previous.roles?.[role as keyof typeof previous.roles];
        if (kept?.maxOutputTokens) settings.maxOutputTokens = kept.maxOutputTokens;
        if (kept?.effort) settings.effort = kept.effort;
        if (kept?.fastMode !== undefined) settings.fastMode = kept.fastMode;
      }
    }
  }
  config.chapterOrder = current?.chapterOrder ?? DEFAULT_CHAPTER_ORDER;
  if (current?.hideWhitespace !== undefined) config.hideWhitespace = current.hideWhitespace; // set by w during a tour
  if (current?.splitDiff !== undefined) config.splitDiff = current.splitDiff; // set by S during a tour
  if (theme && theme !== TERMINAL_THEME) config.theme = theme;
  const agent = codingAgent ?? (current?.codingAgent && { agent: current.codingAgent, command: current.codingAgentCommand });
  if (agent) config.codingAgent = agent.agent;
  if (agent?.agent === CUSTOM_AGENT) config.codingAgentCommand = agent.command?.trim();
  if (github) config.github = github;
  return config;
}

export type SetupResult = { kind: 'saved'; config: UserConfig } | { kind: 'cancelled' } | { kind: 'edit' };

// The full-screen setup. `firstRun` is gr starting without a config: it opens with an
// introduction, and the command that was run continues once the config is saved.
export async function setup(opts: { edit?: boolean; firstRun?: boolean } = {}): Promise<SetupResult> {
  const file = userConfigPath();
  if (opts.edit) {
    if (!fs.existsSync(file)) saveUserConfig(defaultUserConfig());
    openInEditor(file);
    reportConfig(file);
    return { kind: 'edit' };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`gr config needs an interactive terminal; edit ${file} directly instead.`);

  let current: UserConfig | undefined;
  let problem: string | undefined;
  if (fs.existsSync(file)) {
    try {
      current = loadUserConfig();
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  // A saved theme shiki doesn't have is dropped, so finishing setup can't save it again.
  if (current?.theme && !(await isTheme(current.theme))) current = { ...current, theme: undefined };

  const { runSetupWizard } = await import('./tui/SetupWizard.js');
  const result = await runSetupWizard({ firstRun: !!opts.firstRun, current, problem, file });
  if (result.kind === 'edit') return setup({ edit: true });
  if (result.kind === 'cancelled') {
    process.stdout.write('Setup cancelled. Nothing saved.\n');
    return result;
  }
  saveUserConfig(result.config);
  process.stdout.write(`Saved ${file}. Run gr config to change it, or gr config --edit to fine-tune per-task models by hand.\n`);
  return result;
}
function reportConfig(file: string): void {
  try {
    loadUserConfig();
    process.stdout.write(`Config saved at ${file}\n`);
  } catch (e) {
    process.stdout.write(`Warning: ${(e as Error).message}\nRun gr config to fix it.\n`);
  }
}

// What each key of .guided-review.json does; printed by `gr config --repo` before the editor opens.
export function repoConfigHelp(file: string, created: boolean): string[] {
  return [
    `${created ? 'Created' : 'Editing'} ${file}. Commit it so everyone reviewing this repository gets the same rules.`,
    '',
    'Keys (all optional; globs match repo-relative paths, e.g. "src/gen/**"):',
    '  kinds         Override how files are classified.',
    '                [{ "pattern": "src/gen/**", "kind": "generated" }]',
    `                kind is one of: ${KINDS.join(', ')}`,
    '  testPatterns  Extra globs for test files, on top of the built-in ones.',
    '                ["**/*.it.ts"]',
    '  checklists    Items to check when a changed path matches the pattern (press i in a chapter).',
    '                [{ "pattern": "db/**", "items": ["Migrations are reversible"] }]',
    '',
    "Rules are read from the PR's merge base, so a PR cannot change its own classification.",
    'Reference and examples: https://github.com/HaydenMeloche/guided-review/tree/master/docs',
    '',
  ];
}

export function editRepoConfig(root: string): void {
  const file = path.join(root, '.guided-review.json');
  const created = !fs.existsSync(file);
  if (created) fs.writeFileSync(file, JSON.stringify({ kinds: [], testPatterns: [], checklists: [] }, null, 2) + '\n');
  process.stdout.write(repoConfigHelp(file, created).join('\n') + '\n');
  openInEditor(file);

  const text = fs.readFileSync(file, 'utf8');
  const problems = repoConfigProblems(text);
  const cfg = parseRepoConfig(text);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  process.stdout.write(`Saved: ${count(cfg.kinds.length, 'kind rule')}, ${count(cfg.testPatterns.length, 'test pattern')}, ${count(cfg.checklists.length, 'checklist')}.\n`);
  if (problems.length) {
    process.stdout.write(`\nThese entries will be ignored:\n${problems.map((p) => `  - ${p}`).join('\n')}\nRun gr config --repo to fix them.\n`);
  }
}
