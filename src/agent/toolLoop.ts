import { randomUUID } from 'node:crypto';
import type { ProviderRunConfig } from './types.js';
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
  user(text: string): M;
  // Sends the conversation and appends the model's reply to it. `streamed` means onText already
  // saw the text.
  turn(history: M[]): Promise<{ text: string; calls: ToolUse[]; streamed: boolean }>;
  results(calls: ToolUse[], outputs: string[]): M[];
}

export async function runToolLoop<M, T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, adapter: ToolLoopAdapter<M>): Promise<{ value: T; sessionId?: string }> {
  const { prefix, store } = adapter;
  const id = config.resume?.startsWith(`${prefix}:`) && store.has(config.resume) ? config.resume : `${prefix}:${randomUUID()}`;
  const history = store.get(id) ?? [...adapter.start];
  history.push(adapter.user(withSchemaInstruction(prompt, opts.schema)));
  for (let turn = 0; turn < Math.max(1, config.maxTurns ?? 10); turn++) {
    opts.signal?.throwIfAborted();
    const { text, calls, streamed } = await adapter.turn(history);
    if (calls.length) {
      history.push(...adapter.results(calls, await runRepoTools(config.cwd, calls, opts.signal)));
      continue;
    }
    if (!text) throw new Error('model returned an empty answer');
    if (!streamed) opts.onText?.(text);
    const value = finishOutput<T>(text, opts.schema);
    if (config.keepSession === false) return { value };
    store.set(id, history);
    return { value, sessionId: id };
  }
  throw new Error('model exceeded the repository tool call limit');
}
