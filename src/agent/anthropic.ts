// Types only: the SDK is loaded on first use, so startup paths that never call it skip its cost.
import type Anthropic from '@anthropic-ai/sdk';
import { resolveApiKey, type CallUsage, type ProviderResult, type ProviderRunConfig } from './types.js';
import { SessionStore } from './sessions.js';
import { assertSecureEndpoint, httpModelError, ModelError, retryAfterMs } from './http.js';
import { REPO_TOOLS, toolInput } from './repoTools.js';
import { runToolLoop, type ModelOpts } from './toolLoop.js';
import { structuredOutputSchema } from './output.js';

// Calls the Messages API directly with an Anthropic API key, using the same read-only
// repository tools as the OpenAI providers. The claude-code provider covers the Claude Code login.

const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

const conversations = new SessionStore<Anthropic.MessageParam>();

// Prompt caching. Requests are laid out tools, system, messages, and a cache hit needs an exact
// prefix match, so two breakpoints (of the four allowed) cover it:
// - one on the system block, caching tools + system across every call that shares them;
// - top-level automatic caching, which marks the last cacheable block of each request, so each
//   tool turn reads the conversation so far from cache and writes only the new tail.
// Without a system prompt, the first breakpoint goes on the last tool instead.
const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

const anthropicTools: Anthropic.Tool[] = REPO_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));

// Fast mode is a beta: it goes to the beta Messages endpoint with this header and `speed: 'fast'`.
export const FAST_MODE_BETA = 'fast-mode-2026-02-01';

type SDK = typeof Anthropic;

function modelError(sdk: SDK, e: unknown): ModelError {
  if (e instanceof sdk.APIError && typeof e.status === 'number') return httpModelError(e.status, e.message, retryAfterMs(e.headers as Headers | undefined));
  return new ModelError(`model endpoint unavailable: ${(e as Error).message}`, e instanceof sdk.APIConnectionError);
}

function usageOf(usage: Anthropic.Usage | Anthropic.Beta.BetaUsage | undefined): CallUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

// The parts of a streamed reply the loop reads, the same from either endpoint.
type Reply = { content: Anthropic.ContentBlock[]; stop_reason: Anthropic.StopReason | null; usage?: CallUsage };

export async function runAnthropic<T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, systemPrompt: string): Promise<ProviderResult<T>> {
  if (!config.model) throw new Error('Anthropic provider requires a model ID');
  if (config.baseUrl) assertSecureEndpoint(new URL(config.baseUrl));
  const { key, source } = resolveApiKey(config);
  if (!key) throw new ModelError(`set ${source} to use the Anthropic provider`);
  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  // run() owns retries and backoff.
  const client = new AnthropicSDK({ apiKey: key, maxRetries: 0, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
  const model = config.model;
  const maxTokens = config.maxOutputTokens && config.maxOutputTokens > 0 ? Math.floor(config.maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  const withTools = config.toolCalling !== false;
  const system: Anthropic.TextBlockParam[] | undefined = systemPrompt ? [{ type: 'text', text: systemPrompt, cache_control: EPHEMERAL }] : undefined;
  const requestTools = withTools ? (system ? anthropicTools : anthropicTools.map((tool, i, all) => (i === all.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool))) : undefined;
  // Effort, and the answer's schema as the response format: the API then guarantees JSON that
  // matches it, where a prompt instruction leaves room for stray text or a missing field.
  const outputConfig: Anthropic.OutputConfig = {
    ...(config.effort ? { effort: config.effort } : {}),
    ...(opts.schema ? { format: { type: 'json_schema', schema: structuredOutputSchema(opts.schema) } } : {}),
  };
  const effort = Object.keys(outputConfig).length ? { output_config: outputConfig } : {};
  const fast = config.fastMode === true;

  const send = async (messages: Anthropic.MessageParam[], onDelta?: (delta: string) => void): Promise<Reply> => {
    const stream = client.messages.stream(
      { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages, ...(requestTools ? { tools: requestTools } : {}), cache_control: EPHEMERAL, ...effort },
      { signal: opts.signal },
    );
    if (onDelta) stream.on('text', onDelta);
    const message = await stream.finalMessage();
    return { content: message.content, stop_reason: message.stop_reason, usage: usageOf(message.usage) };
  };

  // The same request on the beta endpoint, with the same cache breakpoints. The beta types name
  // the same wire shapes, and the conversation is replayed to whichever endpoint the role uses.
  const betaSystem: Anthropic.Beta.BetaTextBlockParam[] | undefined = system;
  const betaTools: Anthropic.Beta.BetaTool[] | undefined = requestTools;
  const sendFast = async (messages: Anthropic.MessageParam[], onDelta?: (delta: string) => void): Promise<Reply> => {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        ...(betaSystem ? { system: betaSystem } : {}),
        messages,
        ...(betaTools ? { tools: betaTools } : {}),
        cache_control: EPHEMERAL,
        ...effort,
        betas: [FAST_MODE_BETA],
        speed: 'fast',
      },
      { signal: opts.signal },
    );
    if (onDelta) stream.on('text', onDelta);
    const message = await stream.finalMessage();
    return { content: message.content as Anthropic.ContentBlock[], stop_reason: message.stop_reason as Anthropic.StopReason | null, usage: usageOf(message.usage) };
  };

  return runToolLoop<Anthropic.MessageParam, T>(prompt, config, opts, {
    prefix: 'anthropic',
    store: conversations,
    start: [],
    nativeSchema: true,
    user: (content) => ({ role: 'user', content }),
    async turn(messages) {
      let text = '';
      const onDelta = opts.onText ? (delta: string) => opts.onText!((text += delta)) : undefined;
      let message: Reply;
      try {
        message = fast ? await sendFast(messages, onDelta) : await send(messages, onDelta);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        throw modelError(AnthropicSDK, e);
      }
      if (message.stop_reason === 'refusal') throw new ModelError('model declined the request');
      // Keep the full content, including thinking blocks, so later turns replay it unchanged.
      messages.push({ role: 'assistant', content: message.content });
      const calls = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
      if (calls.length && message.stop_reason === 'max_tokens') throw new Error('model output was cut off mid tool call');
      const content = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return { text: content, streamed: true, usage: message.usage, calls: calls.map((call) => ({ id: call.id, name: call.name, input: toolInput(call.input ?? {}) })) };
    },
    results: (calls, outputs) => [{ role: 'user', content: calls.map((call, i): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: call.id, content: outputs[i] })) }],
  });
}
