import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { openInEditor } from './util/editor.js';
import {
  DEFAULT_CHAPTER_ORDER,
  defaultUserConfig,
  githubApiUrlProblem,
  KINDS,
  parseRepoConfig,
  repoConfigProblems,
  loadUserConfig,
  PRESET_MODELS,
  presetUserConfig,
  saveUserConfig,
  userConfigPath,
  type ChapterOrderSetting,
  type GitHubConfig,
  type UserConfig,
} from './config.js';
import { DEFAULT_API_URL, restJson } from './github/api.js';
import { isTheme, TERMINAL_THEME } from './tui/theme.js';
import { expandHome, resolveGitHubAuth } from './github/auth.js';
import { configForRole, defaultApiKeyEnv, type AgentConfig, type Provider } from './agent/types.js';

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(130);
  });
  try {
    const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function askRequired(question: string, fallback = '', check?: (value: string) => string | undefined): Promise<string> {
  for (;;) {
    const value = await ask(question, fallback);
    const problem = value ? check?.(value) : 'a value is required';
    if (!problem) return value;
    process.stdout.write(`  ${problem}\n`);
  }
}

async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const value = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]`)).toLowerCase();
    if (!value) return fallback;
    if (['y', 'yes'].includes(value)) return true;
    if (['n', 'no'].includes(value)) return false;
  }
}

// An option with `unavailable` set is listed with the reason but cannot be chosen.
async function choose<T extends string>(title: string, options: { value: T; label: string; unavailable?: string }[], fallback: T): Promise<T> {
  process.stdout.write(`\n${title}\n`);
  options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.label}${o.unavailable ? ` (unavailable: ${o.unavailable})` : ''}\n`));
  const preferred = options.find((o) => o.value === fallback && !o.unavailable) ?? options.find((o) => !o.unavailable)!;
  const fallbackIndex = String(options.indexOf(preferred) + 1);
  for (;;) {
    const n = Number(await ask('Choice', fallbackIndex));
    if (!Number.isInteger(n) || n < 1 || n > options.length) continue;
    const option = options[n - 1];
    if (!option.unavailable) return option.value;
    process.stdout.write(`  That option is unavailable: ${option.unavailable}.\n`);
  }
}

// Raw-mode read so a pasted key is not echoed or left in the scrollback.
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          finish();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

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
  const briefing = configForRole(config, 'briefing');
  const narration = configForRole(config, 'narration');
  const qa = configForRole(config, 'qa');
  const lines = [`Provider: ${config.provider}${config.baseUrl ? ` (${config.baseUrl})` : ''}`];
  if (briefing.model === narration.model) lines.push(`Summaries and narration: ${briefing.model ?? 'default'}`);
  else lines.push(`Summaries: ${briefing.model ?? 'default'}`, `Narration: ${narration.model ?? 'default'}`);
  lines.push(`Q&A: ${qa.model ?? 'default'}${qa.provider !== config.provider ? ` (${qa.provider})` : ''}`);
  lines.push(`API key: ${describeKey(config)}`);
  if (config.toolCalling === false) lines.push('Tool calling: off');
  lines.push(`Chapter order: ${config.chapterOrder ?? DEFAULT_CHAPTER_ORDER}`);
  lines.push(`Theme: ${config.theme ?? `${TERMINAL_THEME} (your terminal's colors)`}`);
  lines.push(`GitHub: ${describeGitHub(config.github)}`);
  return lines;
}

// The full-screen picker previews each theme as the cursor moves; Esc keeps the current one.
// A saved name shiki doesn't have is dropped, so Enter through the questions can't save it again.
async function chooseTheme(saved: string | undefined): Promise<string | undefined> {
  let current = saved;
  if (current && !(await isTheme(current))) {
    process.stdout.write(`\nYour config names a theme that doesn't exist: ${current}.\n`);
    current = undefined;
  }
  if (!(await askYesNo(`\nColor theme: ${current ?? TERMINAL_THEME}. Choose a different one (with a live preview)?`, !current))) return current;
  const { pickTheme } = await import('./tui/ThemeSetup.js');
  const chosen = (await pickTheme(current)) ?? current;
  process.stdout.write(`Theme: ${chosen ?? TERMINAL_THEME}\n`);
  return chosen;
}

function describeGitHub(github: GitHubConfig | undefined): string {
  if (!github) return 'GitHub CLI (gh)';
  const source = github.tokenEnv ? `$${github.tokenEnv}` : github.tokenFile;
  return `personal access token from ${source}${github.apiUrl && github.apiUrl !== DEFAULT_API_URL ? ` (${github.apiUrl})` : ''}`;
}

type GitHubChoice = 'gh' | 'env' | 'file';

const TOKEN_HELP = [
  'A personal access token works instead. Create one at https://github.com/settings/personal-access-tokens:',
  '  a fine-grained token needs read access to Contents and Metadata, and read and write access to',
  '  Pull requests and Issues; a classic token needs the repo scope (and read:org for private orgs).',
  'gr reads the token from an environment variable or a file each time it runs; it is not copied into config.json.',
];

// GitHub access: gh when it is installed, otherwise (or by choice) a personal access token.
async function configureGitHub(current: GitHubConfig | undefined): Promise<GitHubConfig | undefined> {
  const ghInstalled = !spawnSync('gh', ['--version'], { encoding: 'utf8' }).error;
  if (ghInstalled && !current) return undefined;

  const options: { value: GitHubChoice; label: string }[] = [
    { value: 'env', label: 'Personal access token in an environment variable' },
    { value: 'file', label: 'Personal access token in a file' },
    { value: 'gh', label: ghInstalled ? 'GitHub CLI (gh): uses your gh login' : 'I will install the GitHub CLI (gh) instead' },
  ];
  if (ghInstalled) {
    process.stdout.write('\nGitHub access: your config uses a personal access token, and the GitHub CLI (gh) is also installed.\n');
  } else {
    process.stdout.write(
      [
        '',
        'GitHub access: gr reads PRs and posts reviews through GitHub, and the GitHub CLI (gh) is not installed.',
        'You can choose between:',
        '  - installing gh (https://cli.github.com) and signing in with `gh auth login`; nothing else to set here, or',
        `  - ${TOKEN_HELP[0].replace(/^A/, 'a')}`,
        ...TOKEN_HELP.slice(1).map((l) => `  ${l}`),
        '',
      ].join('\n'),
    );
  }
  const currentChoice: GitHubChoice = current?.tokenFile ? 'file' : current?.tokenEnv ? 'env' : ghInstalled ? 'gh' : 'env';
  const choice = await choose('How should gr access GitHub?', options, currentChoice);
  if (choice === 'gh') {
    if (!ghInstalled) process.stdout.write('  Install gh from https://cli.github.com and run `gh auth login` before reviewing.\n');
    return undefined;
  }

  const github: GitHubConfig = {};
  if (choice === 'env') {
    const name = await askRequired('Environment variable that holds the token', current?.tokenEnv ?? 'GITHUB_TOKEN', (v) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.replace(/^\$/, '')) ? undefined : 'not a valid variable name',
    );
    github.tokenEnv = name.replace(/^\$/, '');
    if (!process.env[github.tokenEnv]) process.stdout.write(`  Note: $${github.tokenEnv} is not set in this shell. Set it before running gr.\n`);
  } else {
    github.tokenFile = await askRequired('Path to the file that holds the token', current?.tokenFile ?? '');
    const file = expandHome(github.tokenFile);
    if (!fs.existsSync(file)) process.stdout.write(`  Note: ${github.tokenFile} does not exist yet. Save the token there before running gr.\n`);
    else if (process.platform !== 'win32' && fs.statSync(file).mode & 0o077) {
      process.stdout.write(`  Note: other users can read ${github.tokenFile}. Consider chmod 600 ${github.tokenFile}.\n`);
    }
  }

  const apiUrl = await askRequired('GitHub API URL (change it for GitHub Enterprise Server, e.g. https://github.example.com/api/v3)', current?.apiUrl ?? DEFAULT_API_URL, githubApiUrlProblem);
  if (apiUrl.replace(/\/+$/, '') !== DEFAULT_API_URL) github.apiUrl = apiUrl.replace(/\/+$/, '');

  await checkGitHubToken(github);
  return github;
}

// Signs in once with the token so a typo shows up now rather than on the first review.
async function checkGitHubToken(github: GitHubConfig): Promise<void> {
  let auth;
  try {
    auth = resolveGitHubAuth(github);
  } catch {
    return; // missing variable or file: already noted above
  }
  if (!auth) return;
  try {
    const user = await restJson<{ login: string }>(auth, 'user', { signal: AbortSignal.timeout(10_000) });
    process.stdout.write(`  Signed in to GitHub as ${user.login}.\n`);
  } catch (e) {
    process.stdout.write(`  Warning: could not sign in to GitHub with this token: ${(e as Error).message}\n`);
  }
}

const PROVIDER_CHOICES: { value: Provider | 'edit'; label: string; unavailable?: string }[] = [
  { value: 'claude-code', label: 'Claude Code: uses your Claude Code login (Claude plan)', unavailable: 'temporarily disabled because of performance issues' },
  { value: 'anthropic', label: 'Anthropic API: API key required' },
  { value: 'codex', label: 'Codex: uses your Codex CLI login (ChatGPT plan or API key)' },
  { value: 'cursor', label: 'Cursor: Cursor API key required (Cursor plan)' },
  { value: 'openai', label: 'OpenAI API: API key required' },
  { value: 'openai-compatible', label: 'OpenAI-compatible endpoint: Ollama, vLLM, LM Studio, a proxy, ...' },
  { value: 'bedrock', label: 'Claude on Amazon Bedrock: uses your AWS credentials' },
  { value: 'vertex', label: 'Claude on Google Vertex AI: uses your Google Cloud credentials' },
  { value: 'edit', label: 'Open config.json in your editor' },
];

const CHAPTER_ORDER_CHOICES: { value: ChapterOrderSetting; label: string }[] = [
  { value: 'guide', label: 'Guided: follows the flow of the change, as the briefing recommends' },
  { value: 'risk', label: 'Risk first: riskiest chapters first' },
  { value: 'size', label: 'Small first: smallest chapters first' },
  { value: 'file', label: 'File: one chapter per file, by path' },
];

type KeySource = 'none' | 'env' | 'store';

async function askApiKey(provider: Provider, current: AgentConfig | undefined): Promise<Pick<AgentConfig, 'apiKey' | 'apiKeyEnv'>> {
  if (provider === 'claude-code' || provider === 'codex' || provider === 'bedrock' || provider === 'vertex') return {};
  const defaultEnv = defaultApiKeyEnv(provider)!;
  const options: { value: KeySource; label: string }[] = [];
  if (provider === 'openai-compatible') options.push({ value: 'none', label: 'No key (a local server)' });
  options.push({ value: 'env', label: 'Read it from an environment variable' });
  options.push({ value: 'store', label: 'Save it in config.json' });
  const currentSource: KeySource | undefined = current?.apiKey ? 'store' : current?.apiKeyEnv ? 'env' : undefined;
  const source = await choose('How should gr get the API key?', options, currentSource ?? options[0].value);

  if (source === 'env') {
    const name = await askRequired('Environment variable name', current?.apiKeyEnv ?? defaultEnv, (v) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.replace(/^\$/, '')) ? undefined : 'not a valid variable name',
    );
    const apiKeyEnv = name.replace(/^\$/, '');
    if (!process.env[apiKeyEnv]) process.stdout.write(`  Note: $${apiKeyEnv} is not set in this shell. Set it before running gr.\n`);
    return { apiKeyEnv };
  }
  if (source === 'store') {
    for (;;) {
      const keep = !!current?.apiKey;
      const apiKey = await askSecret(keep ? 'API key (hidden; Enter keeps the saved key): ' : 'API key (hidden): ');
      if (apiKey) return { apiKey };
      if (keep) return { apiKey: current.apiKey };
    }
  }
  return {};
}

async function configureProvider(provider: Provider, current: UserConfig | undefined): Promise<UserConfig> {
  // Reuse the existing answers as defaults when the provider is unchanged.
  const same = current?.provider === provider ? current : undefined;
  const preset = PRESET_MODELS[provider];
  const connection: Omit<AgentConfig, 'provider' | 'model'> = {};

  if (provider === 'codex') {
    const status = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
    if (status.error) process.stdout.write('  Note: the codex CLI is not on your PATH. Install it and run `codex login` before reviewing.\n');
    else if (status.status !== 0) process.stdout.write('  Note: Codex is not logged in. Run `codex login` before reviewing.\n');
    else process.stdout.write(`  ${(status.stdout || status.stderr).trim().split('\n').pop()}\n`);
  }

  if (provider === 'openai-compatible') {
    connection.baseUrl = await askRequired('API base URL, including /v1', same?.baseUrl ?? '', checkBaseUrl);
  }

  process.stdout.write(`\nModels${preset ? ' (Enter accepts the default)' : ''}:\n`);
  const fast = await askRequired('  Summaries and chapter narration', (same && configForRole(same, 'briefing').model) ?? preset?.fast ?? '');
  const strong = await askRequired('  Q&A', (same && configForRole(same, 'qa').model) ?? preset?.strong ?? fast);

  if (provider === 'openai-compatible') {
    const tools = await askYesNo('Does the endpoint support function calling (tools)?', same?.toolCalling !== false);
    if (!tools) connection.toolCalling = false;
  }

  Object.assign(connection, await askApiKey(provider, same));
  return presetUserConfig(provider, { fast, strong }, connection);
}

export async function setup(opts: { edit?: boolean } = {}): Promise<void> {
  const file = userConfigPath();
  if (opts.edit) {
    if (!fs.existsSync(file)) saveUserConfig(defaultUserConfig());
    openInEditor(file);
    reportConfig(file);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`gr config needs an interactive terminal; edit ${file} directly instead.`);

  let current: UserConfig | undefined;
  if (fs.existsSync(file)) {
    try {
      current = loadUserConfig();
      process.stdout.write(
        `Current config (${file}):\n${describeUserConfig(current)
          .map((l) => `  ${l}\n`)
          .join('')}`,
      );
    } catch (e) {
      process.stdout.write(`Current config can't be used: ${(e as Error).message}\n`);
    }
  } else {
    process.stdout.write(`Let's set up a model provider. Settings are saved to ${file}.\n`);
  }

  const choice = await choose('Choose a model provider:', PROVIDER_CHOICES, current?.provider ?? 'codex');
  if (choice === 'edit') {
    await setup({ edit: true });
    return;
  }

  const config = await configureProvider(choice, current);
  config.chapterOrder = await choose('Default chapter order (press f during a tour to switch):', CHAPTER_ORDER_CHOICES, current?.chapterOrder ?? DEFAULT_CHAPTER_ORDER);
  if (current?.hideWhitespace !== undefined) config.hideWhitespace = current.hideWhitespace; // set by w during a tour
  if (current?.splitDiff !== undefined) config.splitDiff = current.splitDiff; // set by S during a tour
  const theme = await chooseTheme(current?.theme);
  if (theme && theme !== TERMINAL_THEME) config.theme = theme;
  const github = await configureGitHub(current?.github);
  if (github) config.github = github;
  if (current?.roles && Object.values(current.roles).some((r) => r?.provider || r?.baseUrl || r?.apiKey || r?.apiKeyEnv)) {
    process.stdout.write('\nYour current config has per-task provider overrides; saving replaces them.\n');
  }
  process.stdout.write(
    `\n${describeUserConfig(config)
      .map((l) => `  ${l}\n`)
      .join('')}`,
  );
  if (!(await askYesNo(`Save to ${file}?`, true))) {
    process.stdout.write('Nothing saved.\n');
    return;
  }
  saveUserConfig(config);
  process.stdout.write(`Saved. Run gr config to change it, or gr config --edit to fine-tune per-task models by hand.\n`);
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
