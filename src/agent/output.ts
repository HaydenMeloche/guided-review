// Structured output: providers without a native JSON-schema mode are asked for JSON in the
// prompt, and every provider's answer is checked against the schema before it is applied.

export type JsonSchema = Record<string, unknown>;

export function withSchemaInstruction(prompt: string, schema?: JsonSchema): string {
  return schema ? `${prompt}\n\nReturn only a JSON object matching this schema:\n${JSON.stringify(schema)}` : prompt;
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
