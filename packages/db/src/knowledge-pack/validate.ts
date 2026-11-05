/**
 * Offline validation of the startup knowledge base, with the semantics of the pack's own `validate_kb.py`
 * (schema 3.0.0): exact fields and types, no empty or padded text, unique keys and content, canonical dates,
 * https URLs, eligible sources (reviewed university hosts and listed papers, consistent peer-review status),
 * references that resolve, case and method evidence kept apart (case sources are B-series and never overlap
 * the method sources; the method sources are exactly the union of the case's frameworks' sources), complete
 * coverage (links, frameworks, stages, audit), RAG chunk hashes and sizes, and metadata counts. The Python
 * script's CSV and Markdown checks compare exports this repository does not keep; the RAG documents are
 * checked against their hashes instead (and, in `render.ts`, against the items that reproduce them).
 *
 * A reviewed domain or URL is not proof that a claim is accurate: the pack's source audit records that review.
 */
import { createHash } from 'node:crypto';

import { type KnowledgePack } from './types.js';

const SCHEMAS: Readonly<Record<string, string>> = {
  frameworks:
    'framework_id name category stages description when_to_use how_to_use expected_output limitations source_ids evidence_note',
  scenarios:
    'scenario_id title company industry stage category scenario_type case_period evidence_as_of context problem actual_actions reported_outcome outcome_limitations analysis possible_solutions proposed_experiment primary_metric decision_rule risks_and_constraints framework_ids case_source_ids method_source_ids source_ids evidence_locator source_scope evidence_date_precision',
  scenario_framework_links: 'scenario_id framework_id application',
  sources:
    'source_id title publisher url accessed_date source_type supports authors publication_year publication peer_review_status eligibility_note',
  source_audit: 'source_id checked_date access_status claim_status locator finding limitation url',
  lifecycle_stages:
    'stage_id name objective common_challenges mentorship_needed expected_outputs progression_evidence framework_ids source_ids evidence_note',
  rag_documents:
    'doc_id title category stages framework_ids source_ids evidence_type language version updated_date access_scope path',
  rag_chunks:
    'doc_id title category stages framework_ids source_ids evidence_type language version updated_date access_scope path chunk_id section text content_sha256 chunking_method size_unit size',
};

const ARRAYS = new Set(
  'stages how_to_use source_ids possible_solutions actual_actions case_source_ids method_source_ids framework_ids common_challenges mentorship_needed'.split(
    ' ',
  ),
);

const KEYS: Readonly<Record<string, string>> = {
  frameworks: 'framework_id',
  scenarios: 'scenario_id',
  sources: 'source_id',
  source_audit: 'source_id',
  lifecycle_stages: 'stage_id',
  rag_documents: 'doc_id',
  rag_chunks: 'chunk_id',
};

const ID_FIELDS = new Set(['scenario_id', 'framework_id', 'source_id', 'chunk_id', 'doc_id']);

/** Hosts whose university material was reviewed for eligibility (as in `validate_kb.py`). */
const UNIVERSITY_HOSTS = new Set([
  'www.open.edu',
  'techlaunch.arizona.edu',
  'venturelab.gatech.edu',
  'dschool.stanford.edu',
  'online.hbs.edu',
  'www.bu.edu',
  'technologylicensing.utah.edu',
  'aaltodoc.aalto.fi',
  'som.yale.edu',
  'www.csus.edu',
  'ventures.yale.edu',
  'news.mit.edu',
  'mitsloan.mit.edu',
  'knowledge.wharton.upenn.edu',
  'entrepreneurship.hbs.edu',
  'now.tufts.edu',
  'energy.mit.edu',
  'www.cmu.edu',
  'med.stanford.edu',
]);

const PAPER_URLS = new Set([
  'https://doi.org/10.1177/1042258719899415',
  'https://arxiv.org/abs/2005.11401',
  'https://arxiv.org/html/2312.10997v5',
  'https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf',
]);

const EXPECTED_REVIEW: Readonly<Record<string, string>> = {
  university_material: 'not_peer_reviewed',
  university_thesis: 'examined_thesis_not_journal_peer_review',
  academic_preprint: 'preprint_not_verified_peer_review',
  peer_reviewed_article: 'peer_reviewed',
  peer_reviewed_paper: 'peer_reviewed',
};

const EVIDENCE_TYPES = new Set(['framework_summary', 'documented_real_case', 'editorial_synthesis']);

type Json = unknown;
type Row = Record<string, Json>;

function isRow(v: Json): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A canonical ISO date (YYYY-MM-DD) that exists. */
export function isCanonicalDate(value: Json): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function httpsUrl(value: string): URL | null {
  if (/\s/.test(value)) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.host !== '' ? u : null;
  } catch {
    return null;
  }
}

/** JSON with sorted keys, for comparing content regardless of key order. */
function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRow(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Unicode code points (Python's `len`), not UTF-16 units. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

/** U+FFFD (a decoding failure) or a control character other than tab, line feed and carriage return. */
function hasInvalidCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return true;
  }
  return false;
}

/** Every problem with `pack` (empty when it is valid). `today` bounds year-precision case dates. */
export function validateKnowledgePack(pack: Json, today: Date = new Date()): string[] {
  const errors: string[] = [];
  const check = (ok: boolean, msg: string): void => {
    if (!ok) errors.push(msg);
  };
  const walk = (v: Json, path: string): void => {
    if (typeof v === 'string') {
      check(v.trim() !== '', `${path}: empty text`);
      check(v === v.trim(), `${path}: surrounding whitespace`);
      check(!hasInvalidCharacter(v), `${path}: invalid text character`);
    } else if (Array.isArray(v)) {
      check(v.length > 0, `${path}: empty collection`);
      for (const [i, item] of v.entries()) walk(item, `${path}.${String(i)}`);
    } else if (isRow(v)) {
      check(Object.keys(v).length > 0, `${path}: empty collection`);
      for (const [key, item] of Object.entries(v)) walk(item, `${path}.${key}`);
    } else if (v === null) {
      check(false, `${path}: null`);
    }
  };
  if (!isRow(pack)) return ['root: expected object'];
  walk(pack, 'root');
  for (const [table, fieldList] of Object.entries(SCHEMAS)) {
    const rows = pack[table];
    check(Array.isArray(rows), `${table}: expected array`);
    if (!Array.isArray(rows)) continue;
    const fields = fieldList.split(' ');
    const seen = new Set<string>();
    const content = new Set<string>();
    rows.forEach((r: Json, i) => {
      const loc = `${table}[${String(i)}]`;
      if (!isRow(r)) {
        check(false, `${loc}: expected object`);
        return;
      }
      const keys = Object.keys(r);
      check(
        keys.length === fields.length && fields.every((f) => f in r),
        `${loc}: missing or unexpected fields`,
      );
      for (const field of fields) {
        const v = r[field];
        if (ARRAYS.has(field)) {
          const strings = Array.isArray(v) && v.every((a) => typeof a === 'string');
          check(strings && v.length > 0, `${loc}.${field}: expected string array`);
          if (strings) check(new Set(v).size === v.length, `${loc}.${field}: repeated value`);
        } else if (field === 'size') {
          check(typeof v === 'number' && Number.isInteger(v) && v > 0, `${loc}: invalid size`);
        } else {
          check(typeof v === 'string', `${loc}.${field}: expected string`);
        }
      }
      const key =
        table === 'scenario_framework_links'
          ? JSON.stringify([r.scenario_id, r.framework_id])
          : JSON.stringify(r[KEYS[table] ?? '']);
      check(!seen.has(key), `${loc}: duplicate key`);
      seen.add(key);
      const sig = canonical(
        Object.fromEntries(Object.entries(r).filter(([k]) => !ID_FIELDS.has(k))),
      ).toLowerCase();
      check(!content.has(sig), `${loc}: duplicate normalized content`);
      content.add(sig);
      for (const field of ['accessed_date', 'checked_date', 'updated_date']) {
        if (field in r) check(isCanonicalDate(r[field]), `${loc}: invalid date`);
      }
      if (typeof r.url === 'string') check(httpsUrl(r.url) !== null, `${loc}: invalid URL`);
    });
  }
  if (errors.length > 0) return errors;

  const k = pack as unknown as KnowledgePack;
  const fm = new Map(k.frameworks.map((f) => [f.framework_id, f]));
  const sources = new Map(k.sources.map((s) => [s.source_id, s]));
  for (const [sid, r] of sources) {
    check(r.source_type in EXPECTED_REVIEW, `${sid}: disallowed source type`);
    if (r.source_type.startsWith('university_')) {
      check(
        UNIVERSITY_HOSTS.has(httpsUrl(r.url)?.hostname ?? ''),
        `${sid}: university source needs manual eligibility review`,
      );
    } else {
      check(PAPER_URLS.has(r.url), `${sid}: paper needs manual eligibility review`);
    }
    check(r.peer_review_status === EXPECTED_REVIEW[r.source_type], `${sid}: inconsistent peer-review status`);
  }
  const docs = new Map(k.rag_documents.map((d) => [d.doc_id, d]));
  const stages = new Set(Object.keys(isRow(k.metadata.stages) ? k.metadata.stages : {}));
  check(fm.size >= 8 && fm.size <= 10, 'framework count outside requested range');
  check(k.scenarios.length >= 20 && k.scenarios.length <= 25, 'scenario count outside requested range');
  for (const table of Object.keys(SCHEMAS)) {
    (pack[table] as Row[]).forEach((r, i) => {
      const loc = `${table}[${String(i)}]`;
      if ('source_ids' in r) {
        check(
          (r.source_ids as string[]).every((s) => sources.has(s)),
          `${loc}: unknown source`,
        );
      }
      if ('framework_ids' in r) {
        check(
          (r.framework_ids as string[]).every((f) => fm.has(f)),
          `${loc}: unknown framework`,
        );
      }
      if ('stages' in r && Array.isArray(r.stages)) {
        check(
          (r.stages as string[]).every((s) => stages.has(s)),
          `${loc}: unknown stage`,
        );
      }
    });
  }
  for (const r of k.scenarios) {
    const id = r.scenario_id;
    check(stages.has(r.stage), `${id}: unknown stage`);
    check(r.scenario_type === 'documented_real_case', `${id}: invalid evidence classification`);
    check(['day', 'year'].includes(r.evidence_date_precision), `${id}: invalid evidence date precision`);
    if (r.evidence_date_precision === 'day') {
      check(isCanonicalDate(r.evidence_as_of), `${id}: invalid evidence date`);
    } else if (r.evidence_date_precision === 'year') {
      const year = Number(r.evidence_as_of);
      check(
        /^\d{4}$/.test(r.evidence_as_of) && year >= 1900 && year <= today.getUTCFullYear(),
        `${id}: invalid evidence year`,
      );
    }
    const union = new Set(r.framework_ids.flatMap((f) => fm.get(f)?.source_ids ?? []));
    const method = new Set(r.method_source_ids);
    check(
      method.size === union.size && [...union].every((s) => method.has(s)),
      `${id}: method source union mismatch`,
    );
    check(
      r.case_source_ids.every((s) => sources.has(s)),
      `${id}: unknown case source`,
    );
    check(
      r.case_source_ids.every((s) => s.startsWith('B')),
      `${id}: case source must be a reviewed case reference`,
    );
    check(!r.case_source_ids.some((s) => method.has(s)), `${id}: case and method evidence overlap`);
    const all = new Set([...union, ...r.case_source_ids]);
    const listed = new Set(r.source_ids);
    check(listed.size === all.size && [...all].every((s) => listed.has(s)), `${id}: source union mismatch`);
  }
  const expected = new Set(k.scenarios.flatMap((s) => s.framework_ids.map((f) => `${s.scenario_id}/${f}`)));
  const actual = new Set(k.scenario_framework_links.map((l) => `${l.scenario_id}/${l.framework_id}`));
  check(
    expected.size === actual.size && [...expected].every((x) => actual.has(x)),
    'scenario/framework links mismatch',
  );
  const linked = new Set(k.scenario_framework_links.map((l) => l.framework_id));
  check(
    linked.size === fm.size && [...fm.keys()].every((f) => linked.has(f)),
    'incomplete framework coverage',
  );
  const stageIds = new Set(k.lifecycle_stages.map((s) => s.stage_id));
  check(
    stageIds.size === stages.size && [...stages].every((s) => stageIds.has(s)),
    'incomplete lifecycle coverage',
  );
  const audited = new Set(k.source_audit.map((a) => a.source_id));
  check(
    audited.size === sources.size && [...sources.keys()].every((s) => audited.has(s)),
    'incomplete audit coverage',
  );
  for (const a of k.source_audit) {
    check(a.url === sources.get(a.source_id)?.url, `audit URL mismatch: ${a.source_id}`);
  }
  for (const c of k.rag_chunks) {
    const parent = docs.get(c.doc_id);
    check(parent !== undefined, `${c.chunk_id}: unknown parent`);
    for (const [key, v] of Object.entries(parent ?? {})) {
      check(
        canonical((c as unknown as Row)[key]) === canonical(v),
        `${c.chunk_id}: metadata mismatch ${key}`,
      );
    }
    check(EVIDENCE_TYPES.has(c.evidence_type), `${c.chunk_id}: invalid evidence type`);
    check(sha256Hex(c.text) === c.content_sha256, `${c.chunk_id}: hash mismatch`);
    check(
      c.size_unit === 'unicode_characters' && c.size === codePoints(c.text),
      `${c.chunk_id}: size mismatch`,
    );
  }
  const counts: [keyof KnowledgePack['metadata'], keyof KnowledgePack][] = [
    ['framework_count', 'frameworks'],
    ['scenario_count', 'scenarios'],
    ['source_count', 'sources'],
    ['lifecycle_stage_count', 'lifecycle_stages'],
    ['rag_document_count', 'rag_documents'],
  ];
  for (const [field, table] of counts) {
    const n = k.metadata[field];
    check(
      typeof n === 'number' && Number.isInteger(n) && n === (k[table] as readonly unknown[]).length,
      `metadata count mismatch: ${field}`,
    );
  }
  return errors;
}

/** A mutation of a valid pack that {@link validateKnowledgePack} must reject (the Python script's self-test). */
export interface CorruptionCase {
  readonly name: string;
  readonly mutate: (pack: Record<string, Row[] | Row>) => void;
}

function at(pack: Record<string, Row[] | Row>, table: string, index: number): Row {
  const rows = pack[table];
  const row = Array.isArray(rows) ? rows[index] : undefined;
  if (row === undefined) throw new Error(`${table}[${String(index)}] missing`);
  return row;
}

/** The seventeen corruptions of `validate_kb.py --self-test`. */
export const CORRUPTION_CASES: readonly CorruptionCase[] = [
  { name: 'missing field', mutate: (d) => delete at(d, 'frameworks', 0).description },
  { name: 'whitespace-only value', mutate: (d) => (at(d, 'scenarios', 0).problem = '  ') },
  {
    name: 'duplicate ID',
    mutate: (d) => (at(d, 'scenarios', 1).scenario_id = at(d, 'scenarios', 0).scenario_id),
  },
  { name: 'broken reference', mutate: (d) => (at(d, 'scenarios', 0).framework_ids = ['F99']) },
  { name: 'invalid date', mutate: (d) => (at(d, 'sources', 0).accessed_date = '2026-99-99') },
  { name: 'invalid array type', mutate: (d) => (at(d, 'frameworks', 0).source_ids = 'A01') },
  { name: 'metadata drift', mutate: (d) => ((d.metadata as Row).source_count = 999) },
  { name: 'tampered chunk', mutate: (d) => (at(d, 'rag_chunks', 0).text = 'changed') },
  {
    name: 'commercial source rejected',
    mutate: (d) => {
      const s = at(d, 'sources', 0);
      s.url = 'https://example.com/business-blog';
      s.source_type = 'commercial_blog';
    },
  },
  {
    name: 'unreviewed source rejected',
    mutate: (d) => (at(d, 'sources', 0).url = 'https://arxiv.org/abs/9999.99999'),
  },
  {
    name: 'preprint mislabel rejected',
    mutate: (d) => (at(d, 'sources', 12).peer_review_status = 'peer_reviewed'),
  },
  {
    name: 'case source replaced by method source',
    mutate: (d) => (at(d, 'scenarios', 0).case_source_ids = ['A01']),
  },
  { name: 'missing documented action', mutate: (d) => (at(d, 'scenarios', 0).actual_actions = []) },
  { name: 'missing outcome qualification', mutate: (d) => (at(d, 'scenarios', 0).outcome_limitations = '') },
  {
    name: 'incorrect method source union',
    mutate: (d) => (at(d, 'scenarios', 0).method_source_ids = ['A01']),
  },
  { name: 'invalid evidence date', mutate: (d) => (at(d, 'scenarios', 0).evidence_as_of = '2024-99-99') },
  { name: 'wrong case evidence type', mutate: (d) => (at(d, 'scenarios', 0).scenario_type = 'hypothetical') },
];
