import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, CallUsage, ProviderResult } from './types.js';
import { ModelError, retryableStatus } from './http.js';
import { finishOutput, openAIStrictSchema } from './output.js';
import type { ModelOpts } from './toolLoop.js';

// Runs `codex exec`, which reuses the Codex CLI login (ChatGPT or API key). Codex's sandbox
// replaces our own tool guard; ignoring the user's Codex config and rules keeps their MCP servers
// and hooks out of the run.
//
// The sandbox is a Codex permission profile rather than sandbox_mode="read-only": read-only mode
// blocks writes and network but can still read the whole disk (~/.ssh, ~/.aws, ~/.config/gh).
// The profile allows reads only of the worktree, its git directory, the Codex install, developer
// tool locations, and Codex's minimal platform paths (system libraries and temp directories), with
// no writes and no network. --strict-config makes a Codex too old to know permission profiles
// fail instead of silently ignoring them and running unconfined.

export const CODEX_PROFILE = 'guided_review';

const BASE_ARGS = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--strict-config', '-c', 'approval_policy="never"'];
// The user's global and system git config can name diff drivers and credential helpers, and
// ~/.gitconfig is outside the readable roots.
const SHELL_ENV = 'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"}';
const TOOL_ROOTS = ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'];

function real(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

// The git directory a worktree reads objects from: `.git` itself, or for a linked worktree the
// directory its `.git` file points at plus that directory's commondir.
function gitDirs(cwd: string): string[] {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return [dotGit];
      const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
      if (!pointer) return [];
      const gitDir = path.resolve(dir, pointer);
      let common: string | undefined;
      try {
        common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      } catch {
        /* not a linked worktree */
      }
      return common ? [gitDir, common] : [gitDir];
    } catch {
      /* keep looking upward */
    }
    if (path.dirname(dir) === dir) return [];
  }
}

// Finds the codex executable on PATH. Spawning its real path matters: Codex re-executes itself
// inside the sandbox, so that path has to be under a readable root.
function resolveCodexBinary(): string | undefined {
  if (process.platform === 'win32') return undefined;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codex');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolved = fs.realpathSync(candidate);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function installRoots(bin: string): string[] {
  const parts = bin.split(path.sep);
  const modules = parts.lastIndexOf('node_modules');
  // An npm install is a Node script that starts a native binary from a sibling package.
  if (modules > 0) return [parts.slice(0, modules + 1).join(path.sep), path.dirname(path.dirname(real(process.execPath) ?? process.execPath))];
  // Standalone and Homebrew installs keep helpers beside the binary's directory.
  return [path.dirname(path.dirname(bin))];
}

// A root that is /, the home directory, or one of its ancestors would expose everything.
function tooBroad(root: string): boolean {
  const home = real(os.homedir()) ?? os.homedir();
  return root === path.parse(root).root || root === home || home.startsWith(root + path.sep);
}

export function codexReadableRoots(cwd: string, bin = resolveCodexBinary()): string[] {
  const roots = new Set<string>();
  const add = (p: string | undefined) => {
    const resolved = p && real(p);
    if (resolved && !tooBroad(resolved)) roots.add(resolved);
  };
  add(cwd);
  for (const dir of gitDirs(real(cwd) ?? cwd)) add(dir);
  if (bin) {
    installRoots(bin).forEach(add);
    // When the install root is too broad (~/bin/codex), allow the binary's directory, or the file.
    const covered = () => [...roots].some((root) => bin.startsWith(root + path.sep));
    if (!covered()) add(path.dirname(bin));
    if (!covered()) roots.add(bin);
  }
  TOOL_ROOTS.forEach(add);
  return [...roots];
}

function permissionArgs(cwd: string, bin: string | undefined): string[] {
  const entries = [':minimal', ...codexReadableRoots(cwd, bin)].map((p) => `${JSON.stringify(p)}="read"`);
  return ['-c', `default_permissions="${CODEX_PROFILE}"`, '-c', `permissions.${CODEX_PROFILE}.filesystem={${entries.join(', ')}}`, '-c', SHELL_ENV];
}

// Children still running when this process exits are killed rather than left orphaned.
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(child: ChildProcess): void {
  live.add(child);
  child.once('exit', () => live.delete(child));
  child.once('error', () => live.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const c of live) c.kill('SIGKILL');
    });
  }
}

export function liveCodexProcesses(): number {
  return live.size;
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  // Escalate when codex ignores SIGTERM.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 3_000).unref();
}

type CodexUsage = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type: string; text?: string };
  usage?: CodexUsage;
}

// turn.completed's usage is the thread's running total, so a resumed turn's own counts are the
// difference from the total last seen for that thread here. A thread resumed without one (from an
// earlier gr process) reports no counts rather than the whole thread's.
const threadTotals = new Map<string, CodexUsage>();

function usageOf(total: CodexUsage | undefined, before: CodexUsage | undefined): CallUsage | undefined {
  if (!total) return undefined;
  const n = (field: keyof CodexUsage) => (typeof total[field] === 'number' ? total[field] - (before?.[field] ?? 0) : undefined);
  const input = n('input_tokens');
  const cached = n('cached_input_tokens');
  // input_tokens includes the cached ones; CallUsage counts them apart.
  return { inputTokens: input === undefined ? undefined : input - (cached ?? 0), outputTokens: n('output_tokens'), cacheReadTokens: cached };
}

function modelError(message: string): ModelError {
  // Codex wraps API failures as JSON with an HTTP status.
  let status: number | undefined;
  let detail = message;
  try {
    const parsed = JSON.parse(message) as { status?: number; error?: { message?: string } };
    status = parsed.status;
    detail = parsed.error?.message ?? message;
  } catch {
    /* plain text */
  }
  return new ModelError(`codex: ${detail}`, status !== undefined && retryableStatus(status));
}

// Effort, priority processing (Codex's "fast" service tier, which it sends as "priority"), and the
// answer's schema. Options before `resume` apply to the resumed turn too, --output-schema included.
export function codexArgs(config: AgentConfig & { cwd: string }, resume?: string, bin = resolveCodexBinary(), schemaFile?: string): string[] {
  const model = config.model ? ['-m', config.model] : [];
  const effort = config.effort ? ['-c', `model_reasoning_effort="${config.effort}"`] : [];
  const fast = config.fastMode ? ['-c', 'service_tier="fast"'] : [];
  const schema = schemaFile ? ['--output-schema', schemaFile] : [];
  const base = [...BASE_ARGS, ...permissionArgs(config.cwd, bin), ...model, ...effort, ...fast, ...schema];
  return resume ? [...base, 'resume', resume, '-'] : [...base, '-C', config.cwd, '-'];
}

export async function runCodex<T>(
  prompt: string,
  config: AgentConfig & { cwd: string; resume?: string; keepSession?: boolean },
  opts: ModelOpts,
  systemPrompt: string,
): Promise<ProviderResult<T> & { sessionId: string }> {
  const resume = config.resume?.startsWith('codex:') ? config.resume.slice('codex:'.length) : undefined;
  // `codex exec` has no system prompt option, so a new session gets it as a preamble. The schema
  // goes as --output-schema, which Codex sends as a strict response format, so it needs a file.
  const input = resume ? prompt : `${systemPrompt}\n\n${prompt}`;

  opts.signal?.throwIfAborted();
  const schemaDir = opts.schema ? fs.mkdtempSync(path.join(os.tmpdir(), 'gr-codex-schema-')) : undefined;
  try {
    const schemaFile = schemaDir && path.join(schemaDir, 'schema.json');
    if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(openAIStrictSchema(opts.schema!)));
    return await exec<T>(input, config, opts, resume, schemaFile);
  } finally {
    if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
  }
}

async function exec<T>(
  input: string,
  config: AgentConfig & { cwd: string; keepSession?: boolean },
  opts: ModelOpts,
  resume: string | undefined,
  schemaFile: string | undefined,
): Promise<ProviderResult<T> & { sessionId: string }> {
  const bin = resolveCodexBinary();
  const child = spawn(bin ?? 'codex', codexArgs(config, resume, bin, schemaFile), { cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  track(child);
  const abort = () => stop(child);
  opts.signal?.addEventListener('abort', abort, { once: true });

  let threadId = resume;
  let message: string | undefined;
  let total: CodexUsage | undefined;
  let failure: Error | undefined;
  let stderr = '';
  let buffered = '';
  const onEvent = (event: CodexEvent) => {
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text !== undefined) {
      // Earlier messages are preambles ("I'll check..."); the last one is the answer.
      message = event.item.text;
      if (!opts.schema) opts.onText?.(message);
    }
    if (event.type === 'turn.completed' && event.usage) total = event.usage;
    if (event.type === 'turn.failed') failure = modelError(event.error?.message ?? 'turn failed');
    if (event.type === 'error' && event.message && !failure) failure = modelError(event.message);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue; // non-JSON log line
      }
      try {
        onEvent(event);
      } catch (e) {
        // A throwing onText would otherwise escape the stream handler; fail the run instead.
        failure ??= e as Error;
        stop(child);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(new ModelError(e.code === 'ENOENT' ? 'the codex CLI is not installed or not on PATH' : `could not run codex: ${e.message}`));
    });
    child.on('close', resolve);
    child.stdin.on('error', () => {
      /* codex exited before reading the prompt; reported by close */
    });
    child.stdin.end(input);
  }).finally(() => opts.signal?.removeEventListener('abort', abort));

  opts.signal?.throwIfAborted();
  if (failure) throw failure;
  if (code !== 0 || message === undefined) {
    const hint = /log ?in|auth|401/i.test(stderr)
      ? ' Run `codex login` first.'
      : /strict-config|unknown configuration field|default_permissions|permission profile/i.test(stderr)
        ? ' Guided Review needs a Codex CLI with permission profiles; update codex.'
        : '';
    throw modelError(`exited with status ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}.${hint}`);
  }
  const value = finishOutput<T>(message, opts.schema, true);
  const usage = threadId && (!resume || threadTotals.has(threadId)) ? usageOf(total, threadTotals.get(threadId)) : undefined;
  if (threadId && total && config.keepSession !== false) threadTotals.set(threadId, total);
  return { value, sessionId: `codex:${threadId}`, ...(usage ? { usage } : {}) };
}
