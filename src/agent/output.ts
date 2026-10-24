// Structured output: providers with a native JSON-schema mode (the Anthropic API, the Claude
// Agent SDK) are given the schema as the response format; the others are asked for JSON in the
// prompt. Every provider's answer is checked against the schema before it is applied.

export type JsonSchema = Record<string, unknown>;

export function withSchemaInstruction(prompt: string, schema?: JsonSchema): string {
  return schema ? `${prompt}\n\nReturn only a JSON object matching this schema:\n${JSON.stringify(schema)}` : prompt;
}

// The Messages API's structured outputs accept a JSON schema subset: every object must say
// additionalProperties: false, and numeric and string bounds are rejected. The bounds still
// hold here (matchesSchema, and the pipeline clamps risk), so they are only left out of the
// schema sent.
const UNSUPPORTED_BOUNDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];

export function structuredOutputSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_BOUNDS.includes(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, child]) => [name, structuredOutputSchema(child)]));
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.items = structuredOutputSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

export function parseJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('model returned invalid JSON');
  }
}

export function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => typeof key === 'string' && !(key in obj))) return false;
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    return !properties || Object.entries(properties).every(([key, child]) => !(key in obj) || matchesSchema(obj[key], child));
  }
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every((item) => matchesSchema(item, schema.items as JsonSchema)));
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  return !Array.isArray(schema.enum) || schema.enum.includes(value);
}

export function checkSchema<T>(value: unknown, schema: JsonSchema): T {
  if (!matchesSchema(value, schema)) throw new Error('model returned JSON that does not match the requested schema');
  return value as T;
}

// The final answer: plain text, or with a schema, JSON that matches it.
export function finishOutput<T>(text: string, schema?: JsonSchema): T {
  return schema ? checkSchema<T>(parseJson(text), schema) : (text as T);
}
