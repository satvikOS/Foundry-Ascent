import { ResourceKind, VentureStage, type ResourceView } from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { andTsQuerySql, queryFirst, queryOne, queryRows, setClause } from './common.js';

type ResourceKindValue = z.infer<typeof ResourceKind>;
type VentureStageValue = z.infer<typeof VentureStage>;

/** Contract view plus tenant id. */
export type ResourceRecord = ResourceView & { readonly tenantId: string };

const COLUMNS =
  'id, tenant_id, name, kind, description, url, tags, stages, eligibility, owner, freshness_at, status';

function decode(r: RawRow): ResourceRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    name: col.text.decode(r.name, 'name'),
    kind: col.enum(ResourceKind.options).decode(r.kind, 'kind'),
    description: col.text.decode(r.description, 'description'),
    url: col.text.nullable.decode(r.url, 'url'),
    tags: col.textArray.decode(r.tags, 'tags'),
    stages: col.textArray
      .decode(r.stages, 'stages')
      .filter((s): s is VentureStageValue => (VentureStage.options as readonly string[]).includes(s)),
    eligibility: col.text.nullable.decode(r.eligibility, 'eligibility'),
    owner: col.text.nullable.decode(r.owner, 'owner'),
    freshnessAt: col.ts.decode(r.freshness_at, 'freshness_at'),
    status: col.enum(['active', 'stale', 'retired'] as const).decode(r.status, 'status'),
  };
}

export function getResource(ex: SqlExecutor, id: string): Promise<ResourceRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM resources WHERE id = :id`, { id: p.uuid(id) }, decode);
}

export interface ListResourcesOptions {
  readonly tenantId: string;
  readonly kind?: ResourceKindValue;
  readonly stage?: VentureStageValue;
  readonly tag?: string;
  /** Full-text search over name, description and tags. */
  readonly q?: string;
  /** Default: active and stale (retired hidden). */
  readonly statuses?: readonly ResourceRecord['status'][];
}

/** Program resources (route mode, program console). */
export function listResources(ex: SqlExecutor, options: ListResourcesOptions): Promise<ResourceRecord[]> {
  const q = options.q?.trim() ? options.q.trim() : null;
  return queryRows(
    ex,
    `SELECT ${COLUMNS} FROM resources
     WHERE tenant_id = :tenantId
       AND status = ANY (:statuses)
       AND (:kind IS NULL OR kind = :kind)
       AND (:stage IS NULL OR :stage = ANY (stages))
       AND (:tag IS NULL OR :tag = ANY (tags))
       AND (:q IS NULL OR tsv @@ ${andTsQuerySql('q')})
     ORDER BY name, id`,
    {
      tenantId: p.uuid(options.tenantId),
      statuses: p.textArray(options.statuses ?? ['active', 'stale']),
      kind: p.nullable.text(options.kind),
      stage: p.nullable.text(options.stage),
      tag: p.nullable.text(options.tag),
      q: p.nullable.text(q),
    },
    decode,
  );
}

export interface ResourceInput {
  readonly name: string;
  readonly kind: ResourceKindValue;
  readonly description: string;
  readonly url?: string | null;
  readonly tags?: readonly string[];
  readonly stages?: readonly VentureStageValue[];
  readonly eligibility?: string | null;
  readonly owner?: string | null;
}

/** Creates a resource (app: program lead). */
export function createResource(
  ex: SqlExecutor,
  input: ResourceInput & {
    readonly id?: string;
    readonly tenantId: string;
    readonly freshnessAt?: string | Date | null;
  },
): Promise<ResourceRecord> {
  return queryOne(
    ex,
    `INSERT INTO resources (id, tenant_id, name, kind, description, url, tags, stages, eligibility, owner, freshness_at)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :name, :kind, :description, :url, :tags, :stages,
             :eligibility, :owner, coalesce(:freshnessAt, now()))
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      name: p.text(input.name),
      kind: p.text(input.kind),
      description: p.text(input.description),
      url: p.nullable.text(input.url),
      tags: p.textArray(input.tags ?? []),
      stages: p.textArray(input.stages ?? []),
      eligibility: p.nullable.text(input.eligibility),
      owner: p.nullable.text(input.owner),
      freshnessAt: p.nullable.ts(input.freshnessAt),
    },
    decode,
    'createResource',
  );
}

/** Partial update; refreshes `freshness_at` (content was reviewed). */
export async function updateResource(
  ex: SqlExecutor,
  id: string,
  patch: Partial<ResourceInput> & { readonly status?: ResourceRecord['status'] },
): Promise<ResourceRecord | null> {
  const set = setClause([
    ['name', patch.name === undefined ? undefined : p.text(patch.name)],
    ['kind', patch.kind === undefined ? undefined : p.text(patch.kind)],
    ['description', patch.description === undefined ? undefined : p.text(patch.description)],
    ['url', patch.url === undefined ? undefined : p.nullable.text(patch.url)],
    ['tags', patch.tags === undefined ? undefined : p.textArray(patch.tags)],
    ['stages', patch.stages === undefined ? undefined : p.textArray(patch.stages)],
    ['eligibility', patch.eligibility === undefined ? undefined : p.nullable.text(patch.eligibility)],
    ['owner', patch.owner === undefined ? undefined : p.nullable.text(patch.owner)],
    ['status', patch.status === undefined ? undefined : p.text(patch.status)],
  ]);
  if (set.sql === '') return getResource(ex, id);
  return queryFirst(
    ex,
    `UPDATE resources SET ${set.sql}, freshness_at = now() WHERE id = :id RETURNING ${COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    decode,
  );
}

// ------------------------------------------------------------------------------------------------
// Patterns (read path in V1)
// ------------------------------------------------------------------------------------------------

export interface PatternRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly context: string;
  readonly signal: string;
  readonly intervention: string;
  readonly outcome: string;
  readonly limits: string;
  readonly sourceClass: string;
  readonly status: 'draft' | 'in_review' | 'published' | 'withdrawn';
  readonly ownerId: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

function decodePattern(r: RawRow): PatternRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    title: col.text.decode(r.title, 'title'),
    context: col.text.decode(r.context, 'context'),
    signal: col.text.decode(r.signal, 'signal'),
    intervention: col.text.decode(r.intervention, 'intervention'),
    outcome: col.text.decode(r.outcome, 'outcome'),
    limits: col.text.decode(r.limits, 'limits'),
    sourceClass: col.text.decode(r.source_class, 'source_class'),
    status: col.enum(['draft', 'in_review', 'published', 'withdrawn'] as const).decode(r.status, 'status'),
    ownerId: col.uuid.nullable.decode(r.owner_id, 'owner_id'),
    expiresAt: col.ts.nullable.decode(r.expires_at, 'expires_at'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
  };
}

const PATTERN_COLUMNS =
  'id, tenant_id, title, context, signal, intervention, outcome, limits, source_class, status, owner_id, expires_at, created_at';

/** Published, unexpired patterns of the tenant (program leads also see drafts with `includeUnpublished`). */
export function listPatterns(
  ex: SqlExecutor,
  args: { tenantId: string; includeUnpublished?: boolean },
): Promise<PatternRecord[]> {
  return queryRows(
    ex,
    `SELECT ${PATTERN_COLUMNS} FROM patterns
     WHERE tenant_id = :tenantId
       AND (:includeAll OR (status = 'published' AND (expires_at IS NULL OR expires_at > now())))
     ORDER BY created_at DESC, id`,
    { tenantId: p.uuid(args.tenantId), includeAll: p.bool(args.includeUnpublished ?? false) },
    decodePattern,
  );
}

export function createPattern(
  ex: SqlExecutor,
  input: Omit<PatternRecord, 'id' | 'createdAt' | 'status' | 'expiresAt' | 'ownerId'> & {
    readonly id?: string;
    readonly status?: PatternRecord['status'];
    readonly ownerId?: string | null;
    readonly expiresAt?: string | Date | null;
  },
): Promise<PatternRecord> {
  return queryOne(
    ex,
    `INSERT INTO patterns (id, tenant_id, title, context, signal, intervention, outcome, limits, source_class, status,
                           owner_id, expires_at)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :title, :context, :signal, :intervention, :outcome, :limits,
             :sourceClass, coalesce(:status, 'draft'), :ownerId, :expiresAt)
     RETURNING ${PATTERN_COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      title: p.text(input.title),
      context: p.text(input.context),
      signal: p.text(input.signal),
      intervention: p.text(input.intervention),
      outcome: p.text(input.outcome),
      limits: p.text(input.limits),
      sourceClass: p.text(input.sourceClass),
      status: p.nullable.text(input.status),
      ownerId: p.nullable.uuid(input.ownerId),
      expiresAt: p.nullable.ts(input.expiresAt),
    },
    decodePattern,
    'createPattern',
  );
}
