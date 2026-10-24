import { resolveApiKey, type CallUsage, type ProviderResult, type ProviderRunConfig } from './types.js';
import { SessionStore } from './sessions.js';
import { assertSecureEndpoint, ModelError, postModel, sseData } from './http.js';
import { parseToolArgs, REPO_TOOLS } from './repoTools.js';
import { runToolLoop, type ModelOpts } from './toolLoop.js';

type ResponseItem = {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string }[];
  [key: string]: unknown;
};
type ResponseUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
type ModelResponse = { status?: string; error?: { message?: string }; output?: ResponseItem[]; usage?: ResponseUsage };

// input_tokens includes the cached ones; CallUsage counts them apart.
function usageOf(usage: ResponseUsage | undefined): CallUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.input_tokens === undefined ? undefined : usage.input_tokens - (cached ?? 0),
    outputTokens: usage.output_tokens,
    cacheReadTokens: cached,
  };
}

const conversations = new SessionStore<unknown>();
const responseTools = REPO_TOOLS.map((tool) => ({ type: 'function', ...tool, strict: false }));

async function streamedResponse(response: Response, onText: (text: string) => void): Promise<ModelResponse> {
  let content = '';
  let completed: ModelResponse | undefined;
  for await (const data of sseData(response)) {
    const event = data as { type?: string; delta?: string; response?: ModelResponse; message?: string };
    if (event.type === 'response.output_text.delta' && event.delta) {
      content += event.delta;
      onText(content);
    }
    if (event.type === 'response.completed') completed = event.response;
    if (event.type === 'response.failed' || event.type === 'error') throw new Error(event.response?.error?.message || event.message || 'model response failed');
  }
  if (!completed) throw new Error('model stream ended without a completed response');
  return completed;
}

export async function runOpenAI<T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, systemPrompt: string): Promise<ProviderResult<T>> {
  if (!config.model) throw new Error('OpenAI provider requires a model ID');
  const url = new URL((config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/responses');
  assertSecureEndpoint(url);
  const { key, source } = resolveApiKey(config);
  if (!key) throw new ModelError(`set ${source} to use the OpenAI provider`);
  return runToolLoop<unknown, T>(prompt, config, opts, {
    prefix: 'openai',
    store: conversations,
    start: [],
    user: (content) => ({ role: 'user', content }),
    async turn(input) {
      const { response, streamed } = await postModel(
        url,
        key,
        {
          model: config.model,
          instructions: systemPrompt,
          input,
          store: false,
          stream: !!opts.onText,
          ...(config.toolCalling === false ? {} : { tools: responseTools, tool_choice: 'auto' }),
        },
        opts.signal,
      );
      const answer = streamed ? await streamedResponse(response, opts.onText!) : ((await response.json()) as ModelResponse);
      if (answer.status && answer.status !== 'completed') throw new Error(answer.error?.message || `model response ${answer.status}`);
      if (!answer.output) throw new Error('model API returned no output');
      input.push(...answer.output);
      const calls = answer.output.filter((item) => item.type === 'function_call');
      if (calls.some((call) => !call.call_id || !call.name)) throw new Error('model returned an invalid tool call');
      const text = answer.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text || '')
        .join('');
      return { text, streamed, usage: usageOf(answer.usage), calls: calls.map((call) => ({ id: call.call_id!, name: call.name!, input: parseToolArgs(call.arguments) })) };
    },
    results: (calls, outputs) => calls.map((call, i) => ({ type: 'function_call_output', call_id: call.id, output: outputs[i] })),
  });
}
