import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './agent.js';
import { AGENT_ROLES, configForRole, formatModel, type AgentConfig, type AgentRouting } from './types.js';

// A one-turn request to each distinct model a setup routes to, so a wrong key or model name
// shows up in gr config rather than halfway through the first briefing.

export interface ModelCheck {
  model: string; // as configured, with a Cursor variant, or "default" when the provider picks
  ok: boolean;
  ms: number;
  error?: string;
}

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const PROMPT = 'This is a connection check from Guided Review setup. Reply with {"ok": true} and nothing else. Do not use any tools.';
const CHECK_MS = 90_000; // Codex and the Agent SDK start a process before the first token

type Runner = (config: AgentConfig, cwd: string, signal: AbortSignal) => Promise<unknown>;

const runCheck: Runner = (config, cwd, signal) => run<{ ok: boolean }>(PROMPT, { ...config, cwd, maxTurns: 1, keepSession: false }, { schema: SCHEMA, signal });

// The roles' configs, one per distinct provider, model, and endpoint.
export function distinctModels(routing: AgentRouting): AgentConfig[] {
  const seen = new Map<string, AgentConfig>();
  for (const role of AGENT_ROLES) {
    const c = configForRole(routing, role);
    const key = JSON.stringify([c.provider, c.model, c.modelParams, c.baseUrl]);
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

// Runs in an empty directory, so a model that reaches for its tools finds nothing to read.
export async function checkModels(routing: AgentRouting, opts: { signal?: AbortSignal; runner?: Runner } = {}): Promise<ModelCheck[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-check-'));
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(CHECK_MS)]) : AbortSignal.timeout(CHECK_MS);
  try {
    return await Promise.all(
      distinctModels(routing).map(async (config) => {
        const start = Date.now();
        try {
          await (opts.runner ?? runCheck)(config, cwd, signal);
          return { model: formatModel(config.model, config.modelParams), ok: true, ms: Date.now() - start };
        } catch (e) {
          const error = signal.aborted && !opts.signal?.aborted ? 'no answer within 90 seconds' : (e as Error).message;
          return { model: formatModel(config.model, config.modelParams), ok: false, ms: Date.now() - start, error };
        }
      }),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
