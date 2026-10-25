import { describe, expect, it } from 'vitest';
import { dropOptionalNulls, finishOutput, openAIStrictSchema } from '../src/agent/output.js';

const schema = {
  type: 'object',
  properties: {
    hunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          risk: { type: 'integer', minimum: 0, maximum: 3 },
          status: { type: 'string', enum: ['pass', 'fail'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
    },
    note: { type: 'string', maxLength: 10, description: 'optional' },
    diagram: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  required: ['hunks'],
};

describe('openAIStrictSchema', () => {
  it('requires every property, makes the optional ones nullable, and strips bounds', () => {
    expect(openAIStrictSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        hunks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              risk: { type: ['integer', 'null'] },
              status: { anyOf: [{ type: 'string', enum: ['pass', 'fail'] }, { type: 'null' }] },
              tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
            },
            required: ['id', 'risk', 'status', 'tags'],
          },
        },
        note: { type: ['string', 'null'], description: 'optional' },
        diagram: { anyOf: [{ type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required: ['title'] }, { type: 'null' }] },
      },
      required: ['hunks', 'note', 'diagram'],
    });
  });

  it('leaves the schema it was given unchanged', () => {
    const before = JSON.stringify(schema);
    openAIStrictSchema(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });
});

describe('dropOptionalNulls', () => {
  it('removes nulls for optional properties at any depth, and keeps other values', () => {
    const answer = { hunks: [{ id: 'h1', risk: null, status: 'pass', tags: null }], note: null, diagram: null };
    expect(dropOptionalNulls(answer, schema)).toEqual({ hunks: [{ id: 'h1', status: 'pass' }] });
  });

  it('keeps a null for a required property, so the schema check still rejects it', () => {
    expect(dropOptionalNulls({ hunks: null }, schema)).toEqual({ hunks: null });
    expect(() => finishOutput('{"hunks":[{"id":null}]}', schema, true)).toThrow(/does not match/);
  });

  it('runs before the schema check only when asked', () => {
    const text = '{"hunks":[{"id":"h1","risk":null}],"note":null}';
    expect(finishOutput(text, schema, true)).toEqual({ hunks: [{ id: 'h1' }] });
    expect(() => finishOutput(text, schema)).toThrow(/does not match/);
  });
});
