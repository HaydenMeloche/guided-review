import { setMaxListeners } from 'node:events';
import { readOnlyGuard, readOnlyHook } from './guard.js';
import type { Chapter, DiffLine, Graph, Hunk, PRInfo, Tour } from '../types.js';
import { briefingPrompt, chapterPrompt, SYSTEM_PROMPT } from './prompts.js';
import { runCompatible } from './openaiCompatible.js';
import { runOpenAI } from './openaiResponses.js';
import { runCodex } from './codex.js';
import { runCursor } from './cursor.js';
import { runAnthropic } from './anthropic.js';
import { ModelError } from './http.js';
import { checkSchema } from './output.js';
import type { ModelOpts } from './toolLoop.js';
import { logModelCall } from './debugLog.js';
import {
  configForRole,
  type AgentConfig,
  type AgentContext,
  type AgentRole,
  type AgentRouting,
  type CallUsage,
  type ModelStamp,
  type ProviderResult,
  type ProviderRunConfig,
  resolveApiKey,
} from './types.js';

// The claude-code, bedrock, and vertex providers run on the Claude Agent SDK, which reuses the
// Claude Code login (or the Bedrock / Vertex env). Other providers have their own adapters.
// Analysis uses read-only tools scoped to the PR worktree; nothing is ever written.
// The Claude Agent SDK is imported on first use, so startup paths that never call a model skip it.

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];

export interface RunResult<T> {
  value: T;
  sessionId?: string;
  modelUsed?: ModelStamp;
}

const TRANSIENT = new Set(['rate_limit', 'overloaded', 'server_error']);
const BACKOFF_MS = [5_000, 15_000, 40_000];
// A server's retry-after is honoured up to this long.
const MAX_RETRY_AFTER_MS = 60_000;

// The providers that send `effort`, and those with a fast mode (Anthropic's fast mode, OpenAI's
// priority processing).
const SENDS_EFFORT = new Set<AgentConfig['provider']>(['anthropic', 'claude-code', 'bedrock', 'vertex', 'openai', 'codex', undefined]);
const SENDS_FAST_MODE = new Set<AgentConfig['provider']>(['anthropic', 'openai', 'codex']);

function stampOf(config: AgentConfig, usage: CallUsage | undefined, elapsedMs: number): ModelStamp {
  const counts = Object.fromEntries(Object.entries(usage ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as CallUsage;
  return {
    provider: config.provider ?? 'claude-code',
    model: config.model,
    baseUrl: config.baseUrl,
    ...(config.effort && SENDS_EFFORT.has(config.provider) ? { effort: config.effort } : {}),
    ...(config.fastMode && SENDS_FAST_MODE.has(config.provider) ? { fastMode: true } : {}),
    ...counts,
    elapsedMs,
  };
}

export class AgentUnavailableError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason as Error);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Rate limits and overloads are retried with backoff before the agent counts as unavailable. The
// wait is the server's retry-after when it gives one (capped), or the next fixed step. The result's
// modelUsed carries the call's measurements, timed across every attempt.
export async function run<T>(prompt: string, options: ProviderRunConfig, opts: ModelOpts = {}): Promise<RunResult<T>> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const { value, sessionId, usage } = await runOnce<T>(prompt, options, opts);
      return { value, ...(sessionId ? { sessionId } : {}), modelUsed: stampOf(options, usage, Date.now() - started) };
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      if (!e.transient || attempt >= BACKOFF_MS.length || opts.signal?.aborted) throw new AgentUnavailableError(e.message);
      await sleep(e.retryAfterMs !== undefined ? Math.min(e.retryAfterMs, MAX_RETRY_AFTER_MS) : BACKOFF_MS[attempt], opts.signal);
    }
  }
}

// `session: false` runs a one-off call on the role's routing that neither resumes nor replaces
// its session (a suggestion uses Q&A routing without touching the Q&A thread).
export async function runRole<T>(role: AgentRole, prompt: string, context: AgentContext, opts: ModelOpts & { maxTurns?: number; session?: boolean } = {}): Promise<RunResult<T>> {
  const { cwd, sessions, rememberSession, ...routing } = context;
  const chosen = configForRole(routing, role);
  const fallback = configForRole({ ...routing, roles: undefined }, role);
  // Only Q&A sessions are ever resumed, so other roles' conversations are not kept.
  const keep = role === 'qa' && opts.session !== false;
  const started = Date.now();
  const execute = async (config: AgentConfig, resume?: string) => {
    const result = await run<T>(prompt, { cwd, ...config, resume, maxTurns: opts.maxTurns, keepSession: keep }, opts);
    if (result.sessionId && keep) rememberSession?.(role, result.sessionId);
    return result;
  };
  // elapsedMs covers the whole role call, a failed override before its fallback included.
  const finish = (config: AgentConfig, result: RunResult<T>, isFallback: boolean): RunResult<T> => {
    const modelUsed: ModelStamp = { ...(result.modelUsed ?? stampOf(config, undefined, 0)), ...(isFallback ? { fallback: true } : {}), elapsedMs: Date.now() - started };
    logModelCall({ role, ...modelUsed });
    return { ...result, modelUsed };
  };
  const failed = (config: AgentConfig, error: unknown, isFallback: boolean) =>
    logModelCall({ role, ...stampOf(config, undefined, Date.now() - started), ...(isFallback ? { fallback: true } : {}), error: (error as Error).message });
  try {
    return finish(chosen, await execute(chosen, keep ? sessions?.qa : undefined), false);
  } catch (error) {
    failed(chosen, error, false);
    if (!routing.roles?.[role] || JSON.stringify(chosen) === JSON.stringify(fallback) || opts.signal?.aborted) throw error;
    try {
      return finish(fallback, await execute(fallback), true);
    } catch (fallbackError) {
      failed(fallback, fallbackError, true);
      throw fallbackError;
    }
  }
}

// Each call gets its own abort controller linked to the caller's signal. Concurrent calls
// (narration runs several chapters at once on one signal) then add one listener each to that
// signal, while a call's own request, SDK and parallel tool listeners go on its private signal.
const CALL_LISTENER_LIMIT = 50;

async function runOnce<T>(prompt: string, options: ProviderRunConfig, opts: ModelOpts): Promise<ProviderResult<T>> {
  opts.signal?.throwIfAborted();
  const abortController = new AbortController();
  setMaxListeners(CALL_LISTENER_LIMIT, abortController.signal);
  const onAbort = () => abortController.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const callOpts = { ...opts, signal: abortController.signal };
  try {
    if (options.provider === 'openai-compatible') return await runCompatible<T>(prompt, options, callOpts, SYSTEM_PROMPT);
    if (options.provider === 'openai') return await runOpenAI<T>(prompt, options, callOpts, SYSTEM_PROMPT);
    if (options.provider === 'codex') return await runCodex<T>(prompt, options, callOpts, SYSTEM_PROMPT);
    if (options.provider === 'cursor') return await runCursor<T>(prompt, options, callOpts, SYSTEM_PROMPT);
    if (options.provider === 'anthropic') return await runAnthropic<T>(prompt, options, callOpts, SYSTEM_PROMPT);
    return await runClaude<T>(prompt, options, opts, abortController);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function runClaude<T>(prompt: string, options: ProviderRunConfig, opts: ModelOpts, abortController: AbortController): Promise<ProviderResult<T>> {
  // Without a configured key, the SDK uses the Claude Code login or the ambient environment.
  const key = (options.provider ?? 'claude-code') === 'claude-code' && (options.apiKey || options.apiKeyEnv) ? resolveApiKey(options).key : undefined;
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({
    prompt,
    options: {
      cwd: options.cwd,
      model: options.model,
      resume: options.resume,
      maxTurns: options.maxTurns,
      ...(options.effort ? { effort: options.effort } : {}),
      systemPrompt: SYSTEM_PROMPT,
      tools: READ_ONLY_TOOLS,
      // canUseTool only runs when the SDK would prompt; the hook sees every call, including
      // auto-approved ones, so the guard is enforced there and kept here as a second layer.
      hooks: { PreToolUse: [{ hooks: [readOnlyHook(options.cwd)] }] },
      canUseTool: readOnlyGuard(options.cwd),
      permissionMode: 'default',
      settingSources: [],
      // No MCP servers: otherwise the login's claude.ai connectors join after init and their tool
      // schemas (~150k tokens on a well-connected account) ride along with every turn. The guard
      // denies them anyway, so they only cost context, latency, and plan usage.
      strictMcpConfig: true,
      // Sessions are written to disk only when they may be resumed.
      persistSession: options.keepSession ?? true,
      abortController,
      includePartialMessages: !!opts.onText,
      ...(key ? { env: { ...process.env, ANTHROPIC_API_KEY: key } } : {}),
      ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
    },
  });
  let sessionId: string | undefined;
  let text = '';
  for await (const msg of q) {
    if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;
    if (msg.type === 'stream_event' && opts.onText && msg.parent_tool_use_id === null) {
      const ev = msg.event as { type: string; delta?: { type: string; text?: string } };
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        text += ev.delta.text;
        opts.onText(text);
      }
    }
    if (msg.type === 'assistant' && msg.error) throw new ModelError(`model error: ${msg.error}`, TRANSIENT.has(msg.error));
    if (msg.type === 'result') {
      if (msg.subtype !== 'success') throw new Error(`agent stopped: ${msg.subtype}`);
      // The main loop's usage; num_turns counts model turns, the last of which answered.
      const usage: CallUsage = {
        inputTokens: msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        cacheReadTokens: msg.usage?.cache_read_input_tokens,
        cacheWriteTokens: msg.usage?.cache_creation_input_tokens,
        toolTurns: typeof msg.num_turns === 'number' ? Math.max(0, msg.num_turns - 1) : undefined,
      };
      if (!opts.schema) return { value: msg.result as T, sessionId, usage };
      const output = (msg as { structured_output?: unknown }).structured_output;
      if (output === undefined) throw new Error('agent returned no structured output');
      return { value: checkSchema<T>(output, opts.schema), sessionId, usage };
    }
  }
  throw new Error('agent ended without a result');
}

// ---------- Analysis ----------

const graphSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['call', 'before-after', 'state', 'entity', 'deps'] },
    title: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          changed: { type: 'boolean' },
          hunkId: { type: 'string' },
          group: { type: 'string' },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
  },
  required: ['kind', 'title', 'nodes', 'edges'],
};

const briefingSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: '2-3 sentences: what the PR does and why' },
    missingChanges: {
      type: 'array',
      description: 'things the PR probably should have changed but did not (docs, CHANGELOG, migration, feature flag, translations, config)',
      items: {
        type: 'object',
        properties: { message: { type: 'string' }, hunkIds: { type: 'array', items: { type: 'string' } } },
        required: ['message'],
      },
    },
    scopeCreep: {
      type: 'array',
      items: {
        type: 'object',
        properties: { message: { type: 'string' }, hunkIds: { type: 'array', items: { type: 'string' } } },
        required: ['message'],
      },
    },
    chapters: {
      type: 'array',
      description: 'one entry per flow/supporting chapter id given, in the recommended reading order',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['id', 'title', 'summary'],
      },
    },
    overview: graphSchema,
  },
  required: ['intent', 'chapters'],
};

const chapterSchema = {
  type: 'object',
  properties: {
    hunkOrder: { type: 'array', items: { type: 'string' }, description: 'all given hunk ids, in call order' },
    hunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          narration: { type: 'string' },
          citesCode: { type: 'boolean', description: 'false when the narration is inference not grounded in visible code' },
          risk: { type: 'integer', minimum: 0, maximum: 3 },
          riskReason: { type: 'string' },
          orphanReason: { type: 'string' },
        },
        required: ['id', 'narration', 'citesCode'],
      },
    },
    untestedBranches: { type: 'array', items: { type: 'string' } },
    checklist: {
      type: 'array',
      description: 'pre-check of each team checklist item given, by id',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'unknown'] }, reason: { type: 'string' } },
        required: ['id', 'status'],
      },
    },
    diagram: graphSchema,
  },
  required: ['hunks'],
};

export interface BriefingResult {
  intent: string;
  scopeCreep?: { message: string; hunkIds?: string[] }[];
  missingChanges?: { message: string; hunkIds?: string[] }[];
  chapters: { id: string; title: string; summary: string }[];
  overview?: Graph;
}

export interface ChapterResult {
  hunkOrder?: string[];
  hunks: { id: string; narration: string; citesCode: boolean; risk?: number; riskReason?: string; orphanReason?: string }[];
  untestedBranches?: string[];
  diagram?: Graph;
  checklist?: { id: string; status: 'pass' | 'fail' | 'unknown'; reason?: string }[];
}

export async function analyzeBriefing(tour: Tour, pr: PRInfo, cwd: string, config: AgentRouting = {}, signal?: AbortSignal) {
  return runRole<BriefingResult>('briefing', briefingPrompt(tour, pr), { cwd, ...config }, { schema: briefingSchema, signal, maxTurns: 12 });
}

export async function analyzeChapter(tour: Tour, chapter: Chapter, cwd: string, config: AgentRouting = {}, signal?: AbortSignal) {
  return runRole<ChapterResult>('narration', chapterPrompt(tour, chapter), { cwd, ...config }, { schema: chapterSchema, signal, maxTurns: 8 });
}

// ---------- Live Q&A ----------

// `selected` overrides the index range, for a selection that skips lines inside it.
export function selectionContext(hunk: Hunk, lineIdx?: number, endIdx?: number, selected?: (line: DiffLine, index: number) => boolean): string {
  const lines = hunk.lines.map((l, i) => {
    const mark = (selected ? selected(l, i) : lineIdx !== undefined && i >= lineIdx && i <= (endIdx ?? lineIdx)) ? '>>' : '  ';
    const no = l.newLine ?? l.oldLine ?? '';
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    return `${mark}${String(no).padStart(5)} ${sign}${l.text}`;
  });
  return `File: ${hunk.file}\n${hunk.header}\n${lines.join('\n')}`;
}

// API providers can run without tool calling; the model then sees only what the prompt gives it.
export const withoutTools = (config: AgentConfig) => (config.provider === 'openai-compatible' || config.provider === 'openai' || config.provider === 'anthropic') && config.toolCalling === false;

export interface AskTurn {
  question: string;
  answer: string;
}

// Follow-ups resume the Q&A session, which already holds the selection and earlier turns.
// Without a session to resume, the thread so far is restated in the prompt instead.
export async function ask(
  opts: AgentContext & {
    question: string;
    history?: AskTurn[];
    hunk?: Hunk;
    lineIdx?: number;
    endIdx?: number;
    context?: string; // more to know before the question, such as the review thread asked about
    onText: (text: string) => void;
    signal?: AbortSignal;
  },
): Promise<RunResult<string>> {
  const history = opts.history ?? [];
  const resumed = history.length > 0 && !!opts.sessions?.qa;
  const context = opts.context && !resumed ? `${opts.context}\n\n` : '';
  const selection = opts.hunk && !resumed ? `${context}The reviewer has selected (>> marks the selection):\n\n${selectionContext(opts.hunk, opts.lineIdx, opts.endIdx)}\n\n` : context;
  const thread = history.length && !resumed ? `Earlier in this thread:\n\n${history.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join('\n\n')}\n\n` : '';
  const label = history.length ? 'Follow-up question' : 'Question';
  const access = withoutTools(configForRole(opts, 'qa'))
    ? 'Answer using the selected code above. If that is insufficient, say so.'
    : 'Answer from the repository (use the available read-only tools when needed).';
  const prompt = `${selection}${thread}${label}: ${opts.question}\n\n${access} Be brief: a few sentences, cite file:line for every claim, and say plainly when something is your inference.`;
  return runRole<string>('qa', prompt, opts, { onText: opts.onText, signal: opts.signal, maxTurns: 10 });
}
