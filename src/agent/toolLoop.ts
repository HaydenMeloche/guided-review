import { randomUUID } from 'node:crypto';
import type { CallUsage, ProviderResult, ProviderRunConfig } from './types.js';
import type { SessionStore } from './sessions.js';
import { runRepoTools, type ToolInput } from './repoTools.js';
import { finishOutput, withSchemaInstruction, type JsonSchema } from './output.js';

// The conversation loop shared by the API providers that run the repository tools themselves:
// send, run any tool calls and send again, until the model answers or runs out of turns.

export type ModelOpts = { schema?: JsonSchema; onText?: (text: string) => void; signal?: AbortSignal };
export type ToolUse = { id: string; name: string; input: ToolInput };

export interface ToolLoopAdapter<M> {
  prefix: string;
  store: SessionStore<M>;
  // A new conversation's opening messages (a system message, for formats that carry one inline).
  start: M[];
  // The adapter gives the model the schema as its response format, so the prompt need not.
  nativeSchema?: boolean;
  user(text: string): M;
  // Sends the conversation and appends the model's reply to it. `streamed` means onText already
  // saw the text. `usage` is the turn's token counts, when the response gave them.
  turn(history: M[]): Promise<{ text: string; calls: ToolUse[]; streamed: boolean; usage?: CallUsage }>;
  results(calls: ToolUse[], outputs: string[]): M[];
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

// Adds one turn's token counts to the call's; a count no turn reported stays undefined.
export function addUsage(total: CallUsage, turn: CallUsage | undefined): CallUsage {
  for (const field of TOKEN_FIELDS) {
    const n = turn?.[field];
    if (typeof n === 'number' && Number.isFinite(n)) total[field] = (total[field] ?? 0) + n;
  }
  return total;
}

export async function runToolLoop<M, T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, adapter: ToolLoopAdapter<M>): Promise<ProviderResult<T>> {
  const { prefix, store } = adapter;
  const id = config.resume?.startsWith(`${prefix}:`) && store.has(config.resume) ? config.resume : `${prefix}:${randomUUID()}`;
  const history = store.get(id) ?? [...adapter.start];
  history.push(adapter.user(adapter.nativeSchema ? prompt : withSchemaInstruction(prompt, opts.schema)));
  const tokens: CallUsage = {};
  let toolTurns = 0;
  for (let turn = 0; turn < Math.max(1, config.maxTurns ?? 10); turn++) {
    opts.signal?.throwIfAborted();
    const { text, calls, streamed, usage: turnUsage } = await adapter.turn(history);
    addUsage(tokens, turnUsage);
    if (calls.length) {
      toolTurns++;
      history.push(...adapter.results(calls, await runRepoTools(config.cwd, calls, opts.signal)));
      continue;
    }
    if (!text) throw new Error('model returned an empty answer');
    if (!streamed) opts.onText?.(text);
    const value = finishOutput<T>(text, opts.schema);
    const usage = { ...tokens, toolTurns };
    if (config.keepSession === false) return { value, usage };
    store.set(id, history);
    return { value, sessionId: id, usage };
  }
  throw new Error('model exceeded the repository tool call limit');
}
