import type { Provider } from './types.js';

// The models setup offers. OpenAI and Anthropic have a fixed list of their current generation
// (GPT-6, Claude 5.x), newest first; update it when a model ships. Cursor and compatible endpoints
// are asked what they offer, and a Cursor model also lists its parameters and the variants they make.

export interface ModelParameter {
  id: string; // e.g. "reasoning_effort"
  label: string; // e.g. "Effort"
  values: { value: string; label: string }[];
}

export interface ModelVariant {
  params: Record<string, string>;
  isDefault?: boolean;
  maxMode?: boolean; // Cursor's Max Mode: a larger context at a higher price
}

export interface ModelOption {
  id: string; // what config.json stores
  label?: string; // a display name, when the provider gives one
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
}

// Providers setup asks for their models.
export const LISTS_MODELS: Provider[] = ['cursor', 'openai-compatible'];

const LIST_MS = 10_000;

export const KNOWN_MODELS: Partial<Record<Provider, ModelOption[]>> = {
  openai: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }, { id: 'gpt-6-astra' }],
  anthropic: [
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
  ],
};

// Display names as a provider sends them can hold zero-width characters and doubled spaces.
export function cleanLabel(label: string | undefined): string | undefined {
  const clean = label
    ?.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || undefined;
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const message = /"message"\s*:\s*"([^"]+)"/.exec(detail)?.[1];
    throw new Error(`${res.status} ${res.statusText}${message ? `: ${message}` : ''}`);
  }
  return res.json();
}

type CursorModel = Awaited<ReturnType<(typeof import('@cursor/sdk'))['Cursor']['models']['list']>>[number] & { variants?: { isMaxMode?: boolean }[] };

export function cursorOption(m: CursorModel): ModelOption {
  const parameters = (m.parameters ?? []).map((p) => ({
    id: p.id,
    label: cleanLabel(p.displayName) ?? p.id,
    values: p.values.map((v) => ({ value: v.value, label: cleanLabel(v.displayName) ?? v.value })),
  }));
  const variants = (m.variants ?? []).map((v) => ({
    params: Object.fromEntries(v.params.map((p) => [p.id, p.value])),
    ...(v.isDefault ? { isDefault: true } : {}),
    ...((v as { isMaxMode?: boolean }).isMaxMode ? { maxMode: true } : {}),
  }));
  return { id: m.id, label: cleanLabel(m.displayName), ...(parameters.length ? { parameters } : {}), ...(variants.length ? { variants } : {}) };
}

const sameParams = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

// The variant setup starts a model on: its default, unless that is Max Mode, then the same
// settings outside Max Mode, then the first variant outside it.
export function defaultParams(option: ModelOption): Record<string, string> | undefined {
  const variants = option.variants ?? [];
  if (!variants.length) return undefined;
  const preferred = variants.find((v) => v.isDefault) ?? variants[0];
  if (!preferred.maxMode) return preferred.params;
  const others = Object.entries(preferred.params).filter(([k]) => k !== 'context');
  const near = variants.find((v) => !v.maxMode && others.every(([k, val]) => v.params[k] === val));
  return (near ?? variants.find((v) => !v.maxMode) ?? preferred).params;
}

// The variant with exactly these parameters, if the model offers one.
export function findVariant(option: ModelOption, params: Record<string, string>): ModelVariant | undefined {
  return option.variants?.find((v) => sameParams(v.params, params));
}

// `key` undefined: Cursor falls back to the SDK's stored login.
export async function listModels(provider: Provider, opts: { key?: string; baseUrl?: string; signal?: AbortSignal }): Promise<ModelOption[]> {
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(LIST_MS)]) : AbortSignal.timeout(LIST_MS);
  if (provider === 'openai-compatible') {
    if (!opts.baseUrl) throw new Error('no base URL');
    const body = (await getJson(`${opts.baseUrl.replace(/\/+$/, '')}/models`, opts.key ? { authorization: `Bearer ${opts.key}` } : {}, signal)) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({ id: m.id }));
  }
  if (provider === 'cursor') {
    const { Cursor } = await import('@cursor/sdk');
    const models = await Promise.race([
      Cursor.models.list(opts.key ? { apiKey: opts.key } : {}),
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('no answer from Cursor')), { once: true })),
    ]);
    return models.map(cursorOption);
  }
  throw new Error(`${provider} does not list its models`);
}
