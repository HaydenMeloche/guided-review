import { resolveApiKey, type CallUsage, type ProviderResult, type ProviderRunConfig } from './types.js';
import { SessionStore } from './sessions.js';
import { assertSecureEndpoint, postModel, sseData } from './http.js';
import { parseToolArgs, REPO_TOOLS } from './repoTools.js';
import { runToolLoop, type ModelOpts } from './toolLoop.js';

type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
type ChatChunk = {
  error?: { message?: string };
  usage?: ChatUsage | null;
  choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
};

// prompt_tokens includes the cached ones; CallUsage counts them apart. Servers that don't
// report usage (most streams, unless asked) leave it undefined.
function usageOf(usage: ChatUsage | null | undefined): CallUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.prompt_tokens === undefined ? undefined : usage.prompt_tokens - (cached ?? 0),
    outputTokens: usage.completion_tokens,
    cacheReadTokens: cached,
  };
}

const conversations = new SessionStore<Message>();
const chatTools = REPO_TOOLS.map((tool) => ({ type: 'function', function: tool }));

async function streamedMessage(response: Response, onText: (text: string) => void): Promise<{ content: string; tool_calls: ToolCall[]; usage?: ChatUsage }> {
  let content = '';
  let usage: ChatUsage | undefined;
  const calls = new Map<number, ToolCall>();
  for await (const data of sseData(response)) {
    const event = data as ChatChunk;
    if (event.error) throw new Error(event.error.message || 'model response failed');
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onText(content);
    }
    for (const part of delta?.tool_calls ?? []) {
      const call = calls.get(part.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      // Some servers repeat the id and name in every chunk; only the arguments arrive in pieces.
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name = part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
  }
  return { content, tool_calls: [...calls.values()], usage };
}

export async function runCompatible<T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, systemPrompt: string): Promise<ProviderResult<T>> {
  if (!config.model) throw new Error('openai-compatible provider requires a model ID');
  if (!config.baseUrl) throw new Error('openai-compatible provider requires baseUrl');
  const url = new URL(config.baseUrl.replace(/\/+$/, '') + '/chat/completions');
  assertSecureEndpoint(url);
  const { key } = resolveApiKey(config);
  return runToolLoop<Message, T>(prompt, config, opts, {
    prefix: 'compatible',
    store: conversations,
    start: [{ role: 'system', content: systemPrompt }],
    user: (content) => ({ role: 'user', content }),
    async turn(messages) {
      const { response, streamed } = await postModel(
        url,
        key,
        { model: config.model, messages, ...(config.toolCalling === false ? {} : { tools: chatTools, tool_choice: 'auto' }), stream: !!opts.onText },
        opts.signal,
      );
      let answer: { content?: string | { text?: string }[] | null; tool_calls?: ToolCall[] } | undefined;
      let usage: ChatUsage | null | undefined;
      if (streamed) {
        const message = await streamedMessage(response, opts.onText!);
        answer = message;
        usage = message.usage;
      } else {
        const body = (await response.json()) as { choices?: { message?: typeof answer }[]; usage?: ChatUsage | null };
        answer = body.choices?.[0]?.message;
        usage = body.usage;
      }
      if (!answer) throw new Error('model API returned no message');
      const text = typeof answer.content === 'string' ? answer.content : Array.isArray(answer.content) ? answer.content.map((p) => p.text ?? '').join('') : '';
      const toolCalls = answer.tool_calls ?? [];
      messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      return { text, streamed, usage: usageOf(usage), calls: toolCalls.map((call) => ({ id: call.id, name: call.function.name, input: parseToolArgs(call.function.arguments) })) };
    },
    results: (calls, outputs) => calls.map((call, i): Message => ({ role: 'tool', tool_call_id: call.id, content: outputs[i] })),
  });
}
