export const PROVIDERS = ['claude-code', 'anthropic', 'codex', 'cursor', 'openai', 'openai-compatible', 'bedrock', 'vertex'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface AgentConfig {
  provider?: Provider;
  model?: string;
  baseUrl?: string;
  // A key written into config.json wins over apiKeyEnv, the name of the variable holding it.
  apiKey?: string;
  apiKeyEnv?: string;
  toolCalling?: boolean;
  // Output token cap per model turn (Anthropic provider).
  maxOutputTokens?: number;
}

export const AGENT_ROLES = ['briefing', 'narration', 'qa'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentRouting extends AgentConfig {
  roles?: Partial<Record<AgentRole, AgentConfig>>;
}

export interface ModelStamp {
  provider: NonNullable<AgentConfig['provider']>;
  model?: string;
  baseUrl?: string;
  fallback?: boolean;
}

export function configForRole(routing: AgentRouting = {}, role: AgentRole): AgentConfig {
  const { roles, ...defaults } = routing;
  const override = roles?.[role];
  if (override?.provider && override.provider !== (defaults.provider ?? 'claude-code')) {
    return { provider: override.provider, toolCalling: defaults.toolCalling, ...override };
  }
  return { ...defaults, ...override };
}

export function defaultApiKeyEnv(provider: AgentConfig['provider']): string | undefined {
  if (provider === 'openai' || provider === 'openai-compatible') return 'OPENAI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  // Without the variable, Cursor falls back to a login stored by its SDK.
  if (provider === 'cursor') return 'CURSOR_API_KEY';
  return undefined; // Claude Code and Codex use their own logins; Bedrock and Vertex use cloud credentials.
}

export function resolveApiKey(config: AgentConfig): { key?: string; source?: string } {
  if (config.apiKey) return { key: config.apiKey, source: 'config.json' };
  const name = config.apiKeyEnv ?? defaultApiKeyEnv(config.provider);
  if (!name) return {};
  return { key: process.env[name] || undefined, source: `$${name}` };
}

export function validateRouting(routing: AgentRouting): void {
  const claudeProviders = new Set(
    AGENT_ROLES.map((role) => configForRole(routing, role).provider ?? 'claude-code').filter((provider) => provider === 'claude-code' || provider === 'bedrock' || provider === 'vertex'),
  );
  if (claudeProviders.size > 1) throw new Error('Claude Code, Bedrock, and Vertex cannot be mixed within one run');
  for (const role of AGENT_ROLES) {
    const config = configForRole(routing, role);
    if ((config.provider === 'openai' || config.provider === 'openai-compatible' || config.provider === 'anthropic') && !config.model) throw new Error(`${role} requires a model ID`);
    if (config.provider === 'openai-compatible' && !config.baseUrl) throw new Error(`${role} requires a baseUrl`);
    // An explicitly named variable must be set; OpenAI and Anthropic always need a key.
    const { key, source } = resolveApiKey(config);
    if (!key && (config.apiKeyEnv || config.provider === 'openai' || config.provider === 'anthropic')) throw new Error(`${config.provider} needs an API key, but ${source} is not set`);
  }
}

export function routingIdentity(routing: AgentRouting = {}): string {
  return JSON.stringify(
    Object.fromEntries(
      AGENT_ROLES.map((role) => {
        const config = configForRole(routing, role);
        return [role, { provider: config.provider ?? 'claude-code', model: config.model ?? '', baseUrl: config.baseUrl ?? '', toolCalling: config.toolCalling !== false }];
      }),
    ),
  );
}

export interface AgentContext extends AgentRouting {
  cwd: string;
  sessions?: Partial<Record<AgentRole, string>>;
  rememberSession?: (role: AgentRole, sessionId: string) => void;
}

// What a provider adapter is called with. keepSession is false when nobody will resume the
// conversation, so the adapter need not keep it.
export interface ProviderRunConfig extends AgentConfig {
  cwd: string;
  resume?: string;
  maxTurns?: number;
  keepSession?: boolean;
}
