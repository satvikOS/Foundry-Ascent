import type { JsonObject, JsonValue, StrictJsonSchema } from './json-schema.js';
import { stripReasoning } from './reasoning-filter.js';

/**
 * Tolerant reading of structured output, guided by the schema, before it is validated. Nova 2 Lite returned
 * `invalid_output` on about a quarter of first turn attempts and half of first distillation attempts in the lab
 * (LAB-M6, LAB-R7), each retried at the cost of a second call and 3–4 s. Its tool input is not decoded against the
 * schema (the schema is a hint to it, not a constraint), so the failures are the ones a model makes writing JSON
 * by hand. From the code paths (provider.ts `validateStructured`, nova.ts `generate`), each one a schema failure
 * before this module:
 *
 * - `missing_null`: a property the schema allows to be null left out (strict schemas list every property as
 *   required; "no challenge" written as no `challenge` at all);
 * - `null_string`: the string "null" for a property that may be null;
 * - `json_string`: an object or array written as a JSON string (`"digest": "{\"summary\": …}"`), or the whole input
 *   as one string;
 * - `wrapper`: the object wrapped in one key (`{"DistillDraft": {…}}`, `{"input": {…}}`) or written inside an echo of
 *   the schema (`{"type": "object", "properties": {…}}`);
 * - `number_string` / `boolean_string`: `"0.8"`, `"true"`;
 * - `enum_case`: an enum value in another case or spelling (`"Coach"`, `"in-progress"` for `in_progress`);
 * - `null_array`: null for a list (none), and `single_item`: one object where a list of them is expected;
 * - text instead of the tool call: JSON in prose, a code fence or after `<thinking>` (`extractJsonValue`).
 *
 * Nothing is weakened: every repair only reshapes what the model wrote into the form the schema asks for, and the
 * result is still validated by the Zod schema in full (a repaired value that fails is reported with its issues).
 * Repairs are reported as `code:path` (field names and indices, never values) for the logs.
 */

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(node: JsonValue | undefined, root: JsonObject): JsonObject | null {
  if (!isObject(node)) return null;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let current: JsonValue = root;
  for (const segment of ref.slice(2).split('/')) {
    if (!isObject(current)) return null;
    current = current[segment.replace(/~1/g, '/').replace(/~0/g, '~')] ?? null;
  }
  return isObject(current) ? current : null;
}

/** The branches a value may take at `node` (itself, or its `anyOf` / `oneOf` alternatives), references resolved. */
function branches(node: JsonObject, root: JsonObject): JsonObject[] {
  const out: JsonObject[] = [node];
  for (const key of ['anyOf', 'oneOf'] as const) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const branch = resolve(item, root);
      if (branch) out.push(...branches(branch, root));
    }
  }
  return out;
}

function typesOf(node: JsonObject, root: JsonObject): Set<string> {
  const types = new Set<string>();
  for (const branch of branches(node, root)) {
    const type = branch.type;
    if (typeof type === 'string') types.add(type);
    else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') types.add(t);
    if (Array.isArray(branch.enum)) {
      for (const member of branch.enum) types.add(member === null ? 'null' : typeof member);
    }
    if (isObject(branch.properties)) types.add('object');
  }
  return types;
}

function enumOf(node: JsonObject, root: JsonObject): string[] | null {
  const members: string[] = [];
  for (const branch of branches(node, root)) {
    if (!Array.isArray(branch.enum)) continue;
    for (const member of branch.enum) if (typeof member === 'string') members.push(member);
  }
  return members.length === 0 ? null : members;
}

function objectBranch(node: JsonObject, root: JsonObject): JsonObject | null {
  return branches(node, root).find((b) => isObject(b.properties)) ?? null;
}

function itemsOf(node: JsonObject, root: JsonObject): JsonObject | null {
  for (const branch of branches(node, root)) {
    const items = resolve(branch.items, root);
    if (items) return items;
  }
  return null;
}

function enumKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** The end (exclusive) of the JSON object or array opening at `start`, string-aware; -1 when it never closes. */
function balancedEnd(text: string, start: number): number {
  const open = text.charAt(start);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The JSON object (or array) a model wrote in text: the whole text, a code fence's content, or the first balanced
 * object in prose, after any reasoning block (`<thinking>…</thinking>`). Undefined when there is none.
 */
export function extractJsonValue(text: string): unknown {
  const plain = stripReasoning(text).trim();
  if (plain === '') return undefined;
  const whole = tryParse(plain);
  if (typeof whole === 'object' && whole !== null) return whole;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(plain)?.[1];
  if (fenced !== undefined) {
    const inner = tryParse(fenced.trim());
    if (typeof inner === 'object' && inner !== null) return inner;
  }
  for (let start = plain.search(/[{[]/); start >= 0;) {
    const end = balancedEnd(plain, start);
    if (end > start) {
      const candidate = tryParse(plain.slice(start, end));
      if (typeof candidate === 'object' && candidate !== null) return candidate;
    }
    const next = plain.slice(start + 1).search(/[{[]/);
    start = next < 0 ? -1 : start + 1 + next;
  }
  return undefined;
}

class Repairer {
  readonly repairs: string[] = [];

  constructor(private readonly root: JsonObject) {}

  note(code: string, path: string): void {
    if (this.repairs.length < 20) this.repairs.push(`${code}:${path === '' ? '(root)' : path}`);
  }

  value(value: unknown, node: JsonObject | null, path: string): unknown {
    if (node === null) return value;
    const types = typesOf(node, this.root);
    const nullable = types.has('null');
    if (value === null || value === undefined) {
      if (!nullable && types.has('array') && value === null) {
        this.note('null_array', path);
        return [];
      }
      return value;
    }
    if (typeof value === 'string') return this.string(value, node, types, path);
    if (Array.isArray(value)) {
      if (!types.has('array')) return value;
      const items = itemsOf(node, this.root);
      return value.map((item, i) => this.value(item, items, `${path}[${String(i)}]`));
    }
    if (isObject(value)) {
      const object = objectBranch(node, this.root);
      if (object === null && types.has('array')) {
        const items = itemsOf(node, this.root);
        if (items !== null && objectBranch(items, this.root) !== null) {
          this.note('single_item', path);
          return [this.value(value, items, `${path}[0]`)];
        }
      }
      return object === null ? value : this.object(value, object, path);
    }
    return value;
  }

  string(value: string, node: JsonObject, types: Set<string>, path: string): unknown {
    const trimmed = value.trim();
    if (types.has('null') && /^null$/i.test(trimmed)) {
      this.note('null_string', path);
      return null;
    }
    if (types.has('string')) {
      const members = enumOf(node, this.root);
      if (members !== null && !members.includes(value)) {
        const matches = members.filter((m) => enumKey(m) === enumKey(value));
        if (matches.length === 1) {
          this.note('enum_case', path);
          return matches[0];
        }
      }
      return value;
    }
    if ((types.has('object') || types.has('array')) && /^[[{`]/.test(trimmed)) {
      const decoded = extractJsonValue(trimmed);
      if (decoded !== undefined) {
        this.note('json_string', path);
        return this.value(decoded, node, path);
      }
    }
    if ((types.has('number') || types.has('integer')) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      this.note('number_string', path);
      return Number(trimmed);
    }
    if (types.has('boolean') && /^(?:true|false)$/i.test(trimmed)) {
      this.note('boolean_string', path);
      return trimmed.toLowerCase() === 'true';
    }
    return value;
  }

  object(value: JsonObject, schema: JsonObject, path: string): JsonObject {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = resolve(properties[key], this.root);
      out[key] = this.value(child, childSchema, path === '' ? key : `${path}.${key}`) as JsonValue;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) continue;
      const childSchema = resolve(child, this.root);
      if (childSchema !== null && typesOf(childSchema, this.root).has('null')) {
        this.note('missing_null', path === '' ? key : `${path}.${key}`);
        out[key] = null;
      }
    }
    return out;
  }
}

/** The root object inside a wrapper key or a schema echo, when the value is not already the root object. */
function unwrapRoot(value: unknown, root: JsonObject, repairer: Repairer): unknown {
  let current = value;
  if (typeof current === 'string') {
    const decoded = extractJsonValue(current);
    if (decoded === undefined) return value;
    repairer.note('json_string', '');
    current = decoded;
  }
  if (!isObject(current)) return current;
  const names = new Set(Object.keys(isObject(root.properties) ? root.properties : {}));
  const keys = Object.keys(current);
  if (names.size === 0 || keys.some((k) => names.has(k))) return current;
  const candidates = keys.length === 1 ? [current[keys[0] ?? '']] : [];
  if (isObject(current.properties)) candidates.push(current.properties);
  for (const candidate of candidates) {
    const inner = typeof candidate === 'string' ? extractJsonValue(candidate) : candidate;
    if (isObject(inner) && Object.keys(inner).some((k) => names.has(k))) {
      repairer.note('wrapper', '');
      return inner;
    }
  }
  return current;
}

/**
 * `value` reshaped toward `strict.schema` (see the module comment), with the repairs made. The value is returned
 * unchanged, with no repairs, when it needs none.
 */
export function repairStructured(
  value: unknown,
  strict: StrictJsonSchema,
): { readonly value: unknown; readonly repairs: readonly string[] } {
  const root = strict.schema;
  const repairer = new Repairer(root);
  const unwrapped = unwrapRoot(value, root, repairer);
  const repaired = repairer.value(unwrapped, root, '');
  return repairer.repairs.length === 0
    ? { value, repairs: [] }
    : { value: repaired, repairs: repairer.repairs };
}
