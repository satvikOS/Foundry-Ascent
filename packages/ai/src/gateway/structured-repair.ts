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
 * The lab's post-hotfix runs (wave 6) named what was still failing: `memory_candidates[n].type: invalid_value` (×30
 * in 160 first turn attempts, and every first distillation attempt), `claims[n].evidence_ids: invalid_type` (×30) and
 * the distillation's `title: invalid_type`. The prompts ask for goals and constraints, which are not memory types,
 * and the model wrote one id as a string. So, too:
 *
 * - `enum_near`: an enum value that is a plural, a misspelling or a common synonym of exactly one member
 *   (`"goal"` → `milestone`, `"constraint"` → `fact`, `"decisions"` → `decision`; {@link ENUM_SYNONYMS});
 * - `enum_fallback`: a memory candidate the founder stated or agreed to whose type is still none of the members is
 *   kept as a `decision` (it says something was decided) or a `fact`, never dropped (LAB-K1, wave 7 review: "pricing",
 *   "timeline", "letter_of_intent" lost the founder's own decision); a candidate's source said in other words maps
 *   to its member (`"coach"`, `"vEIR suggestion"` → `coach_advice`; `"founder said"` → `founder_stated`), so the
 *   coach's advice is never read as unlabelled;
 * - `dropped_item`: an item of a list of candidates (`memory_candidates`, `lesson_candidates`: suggestions the server
 *   filters anyway) whose enum value is still none of the members is dropped, never the whole response; there an
 *   unknown value of an enum that may be null (a candidate's `source`) becomes null (`enum_null`, "not said");
 * - `string_list`: one string where a list of strings is expected (`"E1"` → `["E1"]`, `"E1, E2"` → `["E1", "E2"]`,
 *   `"none"` → `[]`);
 * - `scalar_string` / `list_string` / `object_string`: a number, a list of words or a one-field object where a
 *   string is expected (`"title": 2026`, `["Pilot", "pricing"]`, `{"text": "Pilot pricing"}`).
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

/**
 * Words a model uses for an enum member (keys are member names; a synonym applies only where its member is one of
 * the schema's values). Memory types: the prompts ask for goals, constraints and plans; claim kinds: advice.
 */
export const ENUM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  milestone: ['goal', 'goals', 'objective', 'target', 'deadline', 'aim', 'okr'],
  fact: ['constraint', 'limitation', 'context', 'background', 'information', 'info', 'detail', 'requirement'],
  action: [
    'plan',
    'commitment',
    'task',
    'todo',
    'to_do',
    'next_step',
    'step',
    'follow_up',
    'followup',
    'action_item',
    'promise',
  ],
  hypothesis: ['assumption', 'belief', 'guess', 'theory', 'bet', 'hunch'],
  insight: ['learning', 'lesson', 'observation', 'finding', 'takeaway', 'idea', 'opportunity', 'realisation'],
  evidence: ['metric', 'data', 'result', 'proof', 'statistic', 'feedback', 'signal', 'traction'],
  experiment: ['test', 'trial', 'pilot', 'a_b_test', 'ab_test'],
  relationship: [
    'contact',
    'person',
    'partner',
    'partnership',
    'customer',
    'stakeholder',
    'investor',
    'mentor',
    'advisor',
    'team_member',
    'teammate',
    'connection',
    'introduction',
    'lead',
  ],
  risk: ['concern', 'problem', 'challenge', 'threat', 'worry', 'issue', 'blocker', 'obstacle', 'red_flag'],
  preference: ['like', 'dislike', 'style', 'working_style', 'communication_style', 'habit'],
  decision: ['choice', 'agreement', 'resolution', 'policy'],
  recommendation: ['suggestion', 'advice', 'proposal'],
  inference: ['interpretation', 'conclusion', 'deduction'],
};

/** Edit distance of two short words (insertions, deletions, substitutions), stopping past `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length] ?? max + 1;
}

/**
 * The one member `value` stands for (see `enum_near` in the module comment), or null: the same word in the singular,
 * a misspelling (at most one edit, two for longer words), or a synonym ({@link ENUM_SYNONYMS}). Null when nothing,
 * or more than one member, fits.
 */
export function nearestEnumMember(value: string, members: readonly string[]): string | null {
  const key = enumKey(value).replace(/[^a-z0-9_]/g, '');
  if (key === '') return null;
  const singular = key.replace(/(?<=[a-z]{3})(?:ies)$/, 'y').replace(/(?<=[a-z]{3}[^s])s$/, '');
  const pick = (found: readonly string[]): string | null => (found.length === 1 ? (found[0] ?? null) : null);
  const exact = members.filter((m) => {
    const k = enumKey(m);
    return k === key || k === singular;
  });
  if (exact.length > 0) return pick(exact);
  const synonyms = members.filter((m) => {
    const words = ENUM_SYNONYMS[enumKey(m)] ?? [];
    return words.includes(key) || words.includes(singular);
  });
  if (synonyms.length > 0) return pick(synonyms);
  return pick(
    members.filter((m) => {
      const k = enumKey(m);
      const max = Math.min(k.length, key.length) >= 7 ? 2 : 1;
      return Math.min(k.length, key.length) >= 4 && editDistance(k, key, max) <= max;
    }),
  );
}

/**
 * Where a memory candidate came from, said in other words (`MemoryCandidateSource`): "agreed" is the founder taking a
 * proposal up, "coach", "advice", "vEIR" or "suggestion" the coach's own advice, "founder said" the founder's words.
 * Null for anything else, and where the enum is not a candidate's source.
 */
function sourceNear(value: string, members: readonly string[]): string | null {
  if (!members.includes('coach_advice') || !members.includes('founder_stated')) return null;
  const key = value.toLowerCase();
  if (members.includes('founder_agreed') && /agree|accept|took (?:it )?up|adopt|confirm/.test(key))
    return 'founder_agreed';
  if (/coach|advi[cs]|assistant|veir|\bai\b|model|suggest|recommend|\bbot\b|mentor/.test(key))
    return 'coach_advice';
  if (/founder|user|stated|said|told|mention|own words|themsel/.test(key)) return 'founder_stated';
  return null;
}

/** Words of a candidate that say something was decided: kept as a decision rather than a fact. */
const DECIDED =
  /\b(?:decid\w*|decision|chose|chosen|agreed|settled|committed|will|we'll|i'll|going to|plan(?:s|ned)? to)\b/i;

/** Lists of candidates the server filters anyway: an item no repair can make valid is dropped, not the response. */
const DROPPABLE_LISTS: ReadonlySet<string> = new Set(['memory_candidates', 'lesson_candidates']);

/** What {@link Repairer.value} returns for an item of a droppable list that cannot be made valid. */
const DROP = Symbol('drop');

/** Words that mean "no items" where a list is expected. */
const NO_ITEMS = /^(?:|none|null|n\/a|na|nil|\[\s*\])$/i;

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

  /**
   * `value` reshaped toward `node`. Within an item of a droppable list (`droppable`), an enum value no repair can
   * map makes the item {@link DROP} (or null where the enum may be null).
   */
  value(value: unknown, node: JsonObject | null, path: string, droppable = false): unknown {
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
    if (typeof value === 'string') return this.string(value, node, types, path, droppable);
    if (Array.isArray(value)) {
      if (!types.has('array')) return types.has('string') ? this.listToString(value, path) : value;
      const items = itemsOf(node, this.root);
      const listDroppable = DROPPABLE_LISTS.has(path.split('.').at(-1) ?? '');
      const out: unknown[] = [];
      for (const [i, item] of value.entries()) {
        const repaired = this.value(item, items, `${path}[${String(i)}]`, droppable || listDroppable);
        if (repaired !== DROP) out.push(repaired);
        else if (listDroppable) this.note('dropped_item', `${path}[${String(i)}]`);
        // Inside an item of a droppable list: that item goes.
        else return DROP;
      }
      return out;
    }
    if (isObject(value)) {
      const object = objectBranch(node, this.root);
      if (object === null && types.has('array')) {
        const items = itemsOf(node, this.root);
        if (items !== null && objectBranch(items, this.root) !== null) {
          this.note('single_item', path);
          return this.value([value], node, path, droppable);
        }
      }
      if (object === null && types.has('string')) {
        // A one-field object where a string is expected: `{"text": "Pilot pricing"}`.
        const strings = Object.values(value).filter((v): v is string => typeof v === 'string');
        if (strings.length === 1 && Object.keys(value).length === 1) {
          this.note('object_string', path);
          return strings[0];
        }
      }
      return object === null ? value : this.object(value, object, path, droppable);
    }
    if (
      (typeof value === 'number' || typeof value === 'boolean') &&
      types.has('string') &&
      !types.has(typeof value)
    ) {
      if (enumOf(node, this.root) === null) {
        this.note('scalar_string', path);
        return String(value);
      }
    }
    return value;
  }

  /** A list of words where one string is expected (`["Pilot", "pricing"]` → "Pilot pricing"). */
  listToString(value: readonly unknown[], path: string): unknown {
    if (value.length === 0 || !value.every((v) => typeof v === 'string' || typeof v === 'number'))
      return value;
    this.note('list_string', path);
    return value.map(String).join(' ').replace(/\s+/g, ' ').trim();
  }

  string(value: string, node: JsonObject, types: Set<string>, path: string, droppable: boolean): unknown {
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
        const near = nearestEnumMember(value, members) ?? sourceNear(value, members);
        if (near !== null) {
          this.note('enum_near', path);
          return near;
        }
        if (droppable) {
          if (types.has('null')) {
            this.note('enum_null', path);
            return null;
          }
          return DROP;
        }
      }
      return value;
    }
    if (types.has('array') && !/^[[{`]/.test(trimmed)) {
      const items = itemsOf(node, this.root);
      if (items !== null && typesOf(items, this.root).has('string') && enumOf(items, this.root) === null) {
        this.note('string_list', path);
        return stringList(trimmed);
      }
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

  /**
   * The type a memory candidate the founder stated or agreed to is kept under when its own type maps to no member
   * (LAB-K1: "pricing", "timeline", "letter_of_intent" dropped the founder's $900 decision): `decision` when it says
   * something was decided, else `fact`. Null for any other object, a type that maps, or a candidate from the coach.
   */
  memoryTypeFallback(value: JsonObject, properties: JsonObject, path: string): string | null {
    if (!/(?:^|\.)memory_candidates\[\d+\]$/.test(path) || typeof value.type !== 'string') return null;
    const typeNode = resolve(properties.type, this.root);
    const sourceNode = resolve(properties.source, this.root);
    const members = typeNode === null ? null : enumOf(typeNode, this.root);
    if (members === null || sourceNode === null) return null;
    const type = value.type;
    if (members.some((m) => enumKey(m) === enumKey(type)) || nearestEnumMember(type, members) !== null)
      return null;
    const sources = enumOf(sourceNode, this.root) ?? [];
    const raw = typeof value.source === 'string' ? value.source : '';
    const source = sources.includes(raw)
      ? raw
      : (nearestEnumMember(raw, sources) ?? sourceNear(raw, sources));
    if (source !== 'founder_stated' && source !== 'founder_agreed') return null;
    const words = [type, value.title, value.content].filter((v) => typeof v === 'string').join(' ');
    if (DECIDED.test(words.replace(/_/g, ' ')) && members.includes('decision')) return 'decision';
    return members.includes('fact') ? 'fact' : null;
  }

  object(value: JsonObject, schema: JsonObject, path: string, droppable = false): JsonObject | typeof DROP {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const out: JsonObject = {};
    const typeFallback = this.memoryTypeFallback(value, properties, path);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'type' && typeFallback !== null) {
        this.note('enum_fallback', `${path}.type`);
        out[key] = typeFallback;
        continue;
      }
      const childSchema = resolve(properties[key], this.root);
      const repaired = this.value(child, childSchema, path === '' ? key : `${path}.${key}`, droppable);
      if (repaired === DROP) return DROP;
      out[key] = repaired as JsonValue;
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

/** One string as the list of strings it stands for (see `string_list` in the module comment). */
function stringList(text: string): string[] {
  if (NO_ITEMS.test(text)) return [];
  const parts = text
    .split(/\s*[,;]\s*/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length > 1 && parts.every((p) => !/\s/.test(p))) return parts;
  const words = text.split(/\s+/);
  // Ids separated by spaces ("E1 E2").
  if (words.length > 1 && words.every((w) => /^[A-Za-z]{0,3}\d+$/.test(w))) return words;
  return [text];
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
  return repairer.repairs.length === 0 || repaired === DROP
    ? { value, repairs: [] }
    : { value: repaired, repairs: repairer.repairs };
}
