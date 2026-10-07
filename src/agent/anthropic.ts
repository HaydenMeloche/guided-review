// Types only: the SDK is loaded on first use, so startup paths that never call it skip its cost.
import type Anthropic from '@anthropic-ai/sdk';
import { resolveApiKey, type ProviderRunConfig } from './types.js';
import { SessionStore } from './sessions.js';
import { assertSecureEndpoint, httpModelError, ModelError } from './http.js';
import { REPO_TOOLS, toolInput } from './repoTools.js';
import { runToolLoop, type ModelOpts } from './toolLoop.js';

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

type SDK = typeof Anthropic;

function modelError(sdk: SDK, e: unknown): ModelError {
  if (e instanceof sdk.APIError && typeof e.status === 'number') return httpModelError(e.status, e.message);
  return new ModelError(`model endpoint unavailable: ${(e as Error).message}`, e instanceof sdk.APIConnectionError);
}

export async function runAnthropic<T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, systemPrompt: string): Promise<{ value: T; sessionId?: string }> {
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
  return runToolLoop<Anthropic.MessageParam, T>(prompt, config, opts, {
    prefix: 'anthropic',
    store: conversations,
    start: [],
    user: (content) => ({ role: 'user', content }),
    async turn(messages) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...(requestTools ? { tools: requestTools } : {}),
          cache_control: EPHEMERAL,
        },
        { signal: opts.signal },
      );
      let text = '';
      if (opts.onText) stream.on('text', (delta) => opts.onText!((text += delta)));
      let message: Anthropic.Message;
      try {
        message = await stream.finalMessage();
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
      return { text: content, streamed: true, calls: calls.map((call) => ({ id: call.id, name: call.name, input: toolInput(call.input ?? {}) })) };
    },
    results: (calls, outputs) => [{ role: 'user', content: calls.map((call, i): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: call.id, content: outputs[i] })) }],
  });
}
