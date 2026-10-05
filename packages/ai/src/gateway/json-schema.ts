import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Keywords removed for strict structured outputs (OpenAI strict mode / Bedrock tool schemas). The
 * constraints they express are still enforced, because every response is re-validated with Zod.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
  'contentEncoding',
  'contentMediaType',
  'propertyNames',
  'readOnly',
  'writeOnly',
]);

export interface StrictJsonSchema {
  /** Strict schema to send to the model. */
  schema: JsonObject;
  /** The unmodified Zod-generated schema, used to map nulls back to omitted optional fields. */
  original: JsonObject;
}

const cache = new WeakMap<z.ZodType, StrictJsonSchema>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeNullable(schema: JsonObject): JsonObject {
  const type = schema.type;
  if (typeof type === 'string') {
    if (type === 'null') return schema;
    // Enums must list null explicitly, otherwise `type: [x, "null"]` with `enum` rejects null.
    if (Array.isArray(schema.enum)) {
      return { anyOf: [schema, { type: 'null' }] };
    }
    return { ...schema, type: [type, 'null'] };
  }
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  }
  if (Array.isArray(schema.anyOf)) {
    const hasNull = schema.anyOf.some((s) => isObject(s) && s.type === 'null');
    return hasNull ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function strictify(node: JsonValue, path: string): JsonValue {
  if (Array.isArray(node)) return node.map((item, i) => strictify(item, `${path}[${i}]`));
  if (!isObject(node)) return node;

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'prefixItems') {
      throw new TypeError(`Strict JSON schema does not support tuples (at ${path || '/'})`);
    }
    if ((key === 'properties' || key === '$defs' || key === 'definitions') && isObject(value)) {
      // Maps of name → schema: the names are data, not keywords, so never filter them.
      const entries: JsonObject = {};
      for (const [name, child] of Object.entries(value)) entries[name] = strictify(child, `${path}/${name}`);
      out[key] = entries;
      continue;
    }
    out[key] = strictify(value, `${path}/${key}`);
  }

  const isObjectSchema = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObjectSchema) {
    if (isObject(out.additionalProperties) || out.additionalProperties === true) {
      if (!isObject(out.properties) || Object.keys(out.properties).length === 0) {
        throw new TypeError(`Strict JSON schema does not support records/maps (at ${path || '/'})`);
      }
    }
    const props = isObject(out.properties) ? out.properties : {};
    const originallyRequired = new Set(
      Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === 'string') : [],
    );
    for (const [name, child] of Object.entries(props)) {
      // Optional properties become required-but-nullable; `restoreOptionalNulls` maps null back.
      if (!originallyRequired.has(name) && isObject(child)) props[name] = makeNullable(child);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Converts a Zod schema to a JSON schema accepted by strict structured outputs: every object has
 * `additionalProperties: false` and lists all properties as required (optional properties become
 * nullable), unsupported keywords are removed, `$defs` references are kept. Results are cached
 * per schema instance.
 *
 * @throws TypeError for shapes strict mode cannot express (records, tuples) or unrepresentable types.
 */
export function toStrictJsonSchema(schema: z.ZodType): StrictJsonSchema {
  const cached = cache.get(schema);
  if (cached) return cached;
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as unknown;
  if (!isObject(generated)) throw new TypeError('Zod produced a non-object JSON schema');
  const original = JSON.parse(JSON.stringify(generated)) as JsonObject;
  const strict = strictify(generated, '');
  if (!isObject(strict) || strict.type !== 'object') {
    throw new TypeError('Structured output schemas must have an object at the root');
  }
  const result: StrictJsonSchema = { schema: strict, original };
  cache.set(schema, result);
  return result;
}

function resolveRef(node: JsonObject, root: JsonObject): JsonObject {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let current: JsonValue = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isObject(current)) return node;
    current = current[segment.replace(/~1/g, '/').replace(/~0/g, '~')] ?? null;
  }
  return isObject(current) ? current : node;
}

function objectBranch(node: JsonObject, root: JsonObject): JsonObject | null {
  const resolved = resolveRef(node, root);
  if (isObject(resolved.properties)) return resolved;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isObject(branch)) {
        const found = objectBranch(branch, root);
        if (found) return found;
      }
    }
  }
  return null;
}

function arrayItems(node: JsonObject, root: JsonObject): JsonObject | null {
  const resolved = resolveRef(node, root);
  if (isObject(resolved.items)) return resolved.items;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isObject(branch)) {
        const found = arrayItems(branch, root);
        if (found) return found;
      }
    }
  }
  return null;
}

function restore(value: unknown, node: JsonObject, root: JsonObject): unknown {
  if (Array.isArray(value)) {
    const items = arrayItems(node, root);
    return items ? value.map((v) => restore(v, items, root)) : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  const branch = objectBranch(node, root);
  if (!branch || !isObject(branch.properties)) return value;
  const required = new Set(Array.isArray(branch.required) ? branch.required : []);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childSchema = branch.properties[key];
    if (child === null && !required.has(key)) continue; // optional field sent as null → omit
    out[key] = isObject(childSchema) ? restore(child, childSchema, root) : child;
  }
  return out;
}

/**
 * Undoes the optional→nullable rewrite of {@link toStrictJsonSchema}: drops `null` values for keys
 * that are optional in the original schema so Zod sees them as absent.
 */
export function restoreOptionalNulls(value: unknown, strict: StrictJsonSchema): unknown {
  return restore(value, strict.original, strict.original);
}
