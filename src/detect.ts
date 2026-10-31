import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { defaultApiKeyEnv, type Provider } from './agent/types.js';

// What first-run setup can find on this machine without asking: model providers that are
// signed in or have a key, and whether gh is signed in. Every probe is local or a short
// request to localhost or gh, and a probe that fails or times out reports nothing found.

export interface ProviderFinding {
  provider: Provider;
  detail: string; // e.g. "signed in with ChatGPT", "$ANTHROPIC_API_KEY is set"
  baseUrl?: string; // a local OpenAI-compatible server
  models?: string[]; // the models a local server lists
}

export interface GitHubFinding {
  installed: boolean;
  login?: string; // signed-in user, when gh is signed in
}

// `missing`: the command isn't installed.
type Run = (cmd: string, args: string[], signal?: AbortSignal) => Promise<{ ok: boolean; out: string; missing?: boolean }>;

export interface DetectDeps {
  run?: Run;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  home?: string;
  signal?: AbortSignal; // stops the probes still running, e.g. when setup closes first
}

const PROBE_MS = 4000;

const runCommand: Run = (cmd, args, signal) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: PROBE_MS, signal }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}`.trim(), missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    );
  });

// Local servers that speak the OpenAI API, by their default ports.
const LOCAL_SERVERS = [
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
];

async function localServer(fetchFn: typeof fetch, server: (typeof LOCAL_SERVERS)[number], signal?: AbortSignal): Promise<ProviderFinding | undefined> {
  try {
    const timeout = AbortSignal.timeout(1500);
    const res = await fetchFn(`${server.baseUrl}/models`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    if (!models.length) return undefined;
    return { provider: 'openai-compatible', detail: `${server.name} is running · ${models.length} model${models.length === 1 ? '' : 's'}`, baseUrl: server.baseUrl, models };
  } catch {
    return undefined;
  }
}

async function codex(run: Run, signal?: AbortSignal): Promise<ProviderFinding | undefined> {
  const status = await run('codex', ['login', 'status'], signal);
  if (!status.ok) return undefined;
  // "Logged in using ChatGPT" → "signed in using ChatGPT"
  const line = status.out.split('\n').pop() ?? '';
  return { provider: 'codex', detail: line.replace(/^Logged in/i, 'signed in') || 'signed in' };
}

function keyFinding(provider: Provider, env: NodeJS.ProcessEnv): ProviderFinding | undefined {
  const name = defaultApiKeyEnv(provider)!;
  return env[name] ? { provider, detail: `$${name} is set` } : undefined;
}

function bedrock(env: NodeJS.ProcessEnv, home: string): ProviderFinding | undefined {
  // Credentials alone don't mean Bedrock access; Claude Code's own switch or a profile does.
  if (env.CLAUDE_CODE_USE_BEDROCK) return { provider: 'bedrock', detail: '$CLAUDE_CODE_USE_BEDROCK is set' };
  if (env.AWS_BEARER_TOKEN_BEDROCK) return { provider: 'bedrock', detail: '$AWS_BEARER_TOKEN_BEDROCK is set' };
  if (env.AWS_PROFILE && fs.existsSync(path.join(home, '.aws'))) return { provider: 'bedrock', detail: `AWS profile ${env.AWS_PROFILE}` };
  return undefined;
}

function vertex(env: NodeJS.ProcessEnv): ProviderFinding | undefined {
  if (env.CLAUDE_CODE_USE_VERTEX) return { provider: 'vertex', detail: '$CLAUDE_CODE_USE_VERTEX is set' };
  if (env.ANTHROPIC_VERTEX_PROJECT_ID) return { provider: 'vertex', detail: `Google Cloud project ${env.ANTHROPIC_VERTEX_PROJECT_ID}` };
  return undefined;
}

// Found providers, best first: the recommended API keys, then a signed-in Codex, local servers, and clouds.
export async function detectProviders(deps: DetectDeps = {}): Promise<ProviderFinding[]> {
  const run = deps.run ?? runCommand;
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? fetch;
  const home = deps.home ?? os.homedir();
  const [codexFound, ...servers] = await Promise.all([codex(run, deps.signal), ...LOCAL_SERVERS.map((s) => localServer(fetchFn, s, deps.signal))]);
  return [keyFinding('anthropic', env), keyFinding('openai', env), keyFinding('cursor', env), codexFound, ...servers, bedrock(env, home), vertex(env)].filter((f): f is ProviderFinding => !!f);
}

// What detection looked for, shown on a provider it didn't find so people know what to set.
export const LOOKED_FOR: Partial<Record<Provider, string>> = {
  anthropic: `$${defaultApiKeyEnv('anthropic')} not set`,
  openai: `$${defaultApiKeyEnv('openai')} not set`,
  cursor: `$${defaultApiKeyEnv('cursor')} not set`,
  codex: 'no Codex login (codex login status)',
  'openai-compatible': `nothing running on ${LOCAL_SERVERS.map((s) => new URL(s.baseUrl).host).join(' or ')}`,
  bedrock: '$CLAUDE_CODE_USE_BEDROCK not set',
  vertex: '$CLAUDE_CODE_USE_VERTEX not set',
};

// One gh call: it fails to start when gh isn't installed, and fails when gh isn't signed in.
export async function detectGitHub(deps: Pick<DetectDeps, 'run' | 'signal'> = {}): Promise<GitHubFinding> {
  const user = await (deps.run ?? runCommand)('gh', ['api', 'user', '--jq', '.login'], deps.signal);
  if (user.missing) return { installed: false };
  return { installed: true, login: user.ok && /^[\w-]+$/.test(user.out) ? user.out : undefined };
}
