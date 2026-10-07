// Types only: the SDK is loaded on first use, so startup paths that never call it skip its cost.
import type { SDKAgent, SDKCustomTool } from '@cursor/sdk';
import { resolveApiKey, type ProviderRunConfig } from './types.js';
import { ModelError } from './http.js';
import { finishOutput, withSchemaInstruction } from './output.js';
import { REPO_TOOLS, runRepoTool, toolInput } from './repoTools.js';
import type { ModelOpts } from './toolLoop.js';

// Runs a local agent through the Cursor SDK: the agent loop runs in this process against the
// worktree, and inference uses Cursor's hosted models. The key comes from config.json,
// $CURSOR_API_KEY, or a login stored by the SDK.
//
// Cursor's built-in tools (shell, edit, read, web, subagents, ...) are all turned off. The agent
// sees only the read-only repository tools the OpenAI and Anthropic providers use, run here and
// confined to the worktree. With no settingSources, no on-disk .cursor layers load: the user's
// rules, hooks, and MCP servers stay out of the run. "mcp" is allowed only because the SDK serves
// custom tools as an MCP server; no other server is configured.

const ALLOWED_TOOLS = ['mcp'];
const DEFAULT_MAX_TOOL_CALLS = 40;

type SDK = typeof import('@cursor/sdk');

function cursorTools(cwd: string, signal: AbortSignal | undefined, maxCalls: number): Record<string, SDKCustomTool> {
  let calls = 0;
  return Object.fromEntries(
    REPO_TOOLS.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.parameters,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        execute: async (args) => {
          // The SDK has no turn limit, so the tools enforce one.
          if (++calls > maxCalls) return { content: [{ type: 'text', text: 'Tool call limit reached. Answer with what you have.' }], isError: true };
          return runRepoTool(cwd, tool.name, toolInput(args ?? {}), signal);
        },
      } satisfies SDKCustomTool,
    ]),
  );
}

function modelError(sdk: SDK, e: unknown): ModelError {
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof sdk.AuthenticationError) return new ModelError(`cursor: ${message}. Set $CURSOR_API_KEY or run \`gr config\`.`);
  return new ModelError(`cursor: ${message}`, e instanceof sdk.RateLimitError || e instanceof sdk.NetworkError || (e instanceof sdk.CursorSdkError && e.isRetryable));
}

export async function runCursor<T>(prompt: string, config: ProviderRunConfig, opts: ModelOpts, systemPrompt: string): Promise<{ value: T; sessionId: string }> {
  opts.signal?.throwIfAborted();
  const sdk = await import('@cursor/sdk');
  const { key } = resolveApiKey(config);
  const resume = config.resume?.startsWith('cursor:') ? config.resume.slice('cursor:'.length) : undefined;
  const maxCalls = config.maxTurns ? config.maxTurns * 4 : DEFAULT_MAX_TOOL_CALLS;
  // Tools and the model are not persisted, so a resume passes them again. The service rejects the
  // SDK's systemPrompt option ("unknown option '--system-prompt'"), so as with Codex a new agent
  // gets the system prompt as a preamble, and a resumed one already has it.
  const options = {
    ...(key ? { apiKey: key } : {}),
    ...(config.model ? { model: { id: config.model } } : {}),
    tools: ALLOWED_TOOLS,
    local: { cwd: config.cwd, customTools: cursorTools(config.cwd, opts.signal, maxCalls) },
  };
  const input = withSchemaInstruction(resume ? prompt : `${systemPrompt}\n\n${prompt}`, opts.schema);

  let agent: SDKAgent | undefined;
  try {
    agent = resume ? await sdk.Agent.resume(resume, options) : await sdk.Agent.create(options);
    let text = '';
    const run = await agent.send(input, {
      onDelta: ({ update }) => {
        // Text before a tool call is a preamble ("I'll check..."); stream only the answer.
        if (update.type === 'tool-call-started') text = '';
        if (update.type === 'text-delta' && !opts.schema) opts.onText?.((text += update.text));
      },
    });
    const cancel = () => void run.cancel().catch(() => {});
    opts.signal?.addEventListener('abort', cancel, { once: true });
    const result = await run.wait().finally(() => opts.signal?.removeEventListener('abort', cancel));

    opts.signal?.throwIfAborted();
    if (result.status === 'cancelled') throw new Error('cursor: the run was cancelled');
    if (result.status === 'error') throw modelError(sdk, new sdk.CursorSdkError(result.error?.message ?? 'run failed', { code: result.error?.code }));
    const answer = result.result?.trim();
    if (!answer) throw new Error('model returned an empty answer');
    return { value: finishOutput<T>(answer, opts.schema), sessionId: `cursor:${agent.agentId}` };
  } catch (e) {
    if (opts.signal?.aborted || !(e instanceof sdk.CursorSdkError)) throw e;
    throw modelError(sdk, e);
  } finally {
    agent?.close();
  }
}
