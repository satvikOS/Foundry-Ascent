import { CoachResponse, SessionRecap } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { restoreOptionalNulls, toStrictJsonSchema, type JsonObject, type JsonValue } from './json-schema.js';
import { validateStructured } from './provider.js';

function walk(node: JsonValue, visit: (obj: JsonObject) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

const FORBIDDEN = [
  '$schema',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'default',
];

describe('toStrictJsonSchema', () => {
  it.each([
    ['CoachResponse', CoachResponse],
    ['SessionRecap', SessionRecap],
  ])('makes %s strict: closed objects, all properties required, no unsupported keywords', (_name, schema) => {
    const { schema: strict } = toStrictJsonSchema(schema);
    expect(strict.type).toBe('object');
    let objects = 0;
    walk(strict, (node) => {
      if (node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))) {
        objects += 1;
        expect(node.additionalProperties).toBe(false);
        const props = node.properties as JsonObject;
        expect(node.required).toEqual(Object.keys(props));
      }
    });
    expect(objects).toBeGreaterThan(3);
    const serialized = JSON.stringify(strict);
    for (const keyword of FORBIDDEN) expect(serialized).not.toContain(`"${keyword}"`);
  });

  it('turns optional properties into required nullable ones and maps null back to absent', () => {
    const Schema = z.object({
      a: z.string(),
      b: z.string().optional(),
      level: z.enum(['low', 'high']).optional(),
      c: z.object({ d: z.number().optional(), e: z.array(z.object({ f: z.boolean().optional() })) }),
    });
    const strict = toStrictJsonSchema(Schema);
    const props = strict.schema.properties as JsonObject;
    expect(props.b).toEqual({ type: ['string', 'null'] });
    expect(props.level).toEqual({ anyOf: [{ type: 'string', enum: ['low', 'high'] }, { type: 'null' }] });
    expect(strict.schema.required).toEqual(['a', 'b', 'level', 'c']);

    const modelOutput = { a: 'x', b: null, level: null, c: { d: null, e: [{ f: null }, { f: true }] } };
    expect(restoreOptionalNulls(modelOutput, strict)).toEqual({ a: 'x', c: { e: [{}, { f: true }] } });
    const outcome = validateStructured(modelOutput, Schema, strict);
    expect(outcome).toEqual({ ok: true, value: { a: 'x', c: { e: [{}, { f: true }] } } });
  });

  it('keeps nulls for nullable (required) properties', () => {
    const Schema = z.object({ n: z.string().nullable() });
    const strict = toStrictJsonSchema(Schema);
    expect(restoreOptionalNulls({ n: null }, strict)).toEqual({ n: null });
  });

  it('removes constraint keywords that strict mode rejects (Zod still enforces them)', () => {
    const Schema = z.object({
      id: z.uuid(),
      key: z.string().regex(/^E\d+$/),
      p: z.number().min(0).max(1),
      s: z.string().min(2).max(5),
      at: z.iso.datetime(),
    });
    const strict = toStrictJsonSchema(Schema);
    expect(strict.schema.properties).toEqual({
      id: { type: 'string' },
      key: { type: 'string' },
      p: { type: 'number' },
      s: { type: 'string' },
      at: { type: 'string' },
    });
    const bad = validateStructured({ id: 'nope', key: 'E1', p: 2, s: 'x', at: 'yesterday' }, Schema, strict);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toEqual(
        expect.arrayContaining(['id: invalid_format', 'p: too_big', 's: too_small', 'at: invalid_format']),
      );
      expect(bad.issues.join(' ')).not.toContain('nope');
    }
  });

  it('caches per schema instance', () => {
    expect(toStrictJsonSchema(CoachResponse)).toBe(toStrictJsonSchema(CoachResponse));
  });

  it('rejects shapes strict mode cannot express', () => {
    expect(() => toStrictJsonSchema(z.object({ r: z.record(z.string(), z.number()) }))).toThrow(/records/);
    expect(() => toStrictJsonSchema(z.object({ t: z.tuple([z.string(), z.number()]) }))).toThrow(/tuples/);
    expect(() => toStrictJsonSchema(z.array(z.string()))).toThrow(/object at the root/);
  });
});
