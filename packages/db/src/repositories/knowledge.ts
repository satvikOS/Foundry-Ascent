import {
  DocumentContentType,
  KnowledgeSourceKind,
  type PersonaKnowledgeSourceView,
} from '@foundry/contracts';

import { camelRow, col, type CamelRow, type RawRow } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { encodeVectorLiteral, p } from '../params.js';
import {
  fetchByIdsInBatches,
  principalFrom,
  principalSelect,
  queryFirst,
  queryNumber,
  queryOne,
  queryRows,
  setClause,
} from './common.js';

export type KnowledgeScope = 'public' | 'program' | 'persona' | 'venture';
export type KnowledgeClassification = 'synthetic' | 'public' | 'program_internal' | 'venture_private';
export type KnowledgeKind = (typeof KnowledgeSourceKind.options)[number];

/**
 * Source lifecycle. Authored notes and ingested venture documents are `active` (or `stale`, `withdrawn`);
 * uploads to shared corpora go `pending_upload` → `processing` → `active` | `failed`.
 */
export const KNOWLEDGE_SOURCE_STATUSES = [
  'pending_upload',
  'processing',
  'active',
  'stale',
  'failed',
  'withdrawn',
] as const;
export type KnowledgeSourceStatusValue = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

/** Embedding dimensions of `knowledge_chunks.embedding` / `memory_objects.embedding` (Titan V2). */
export const EMBEDDING_DIMENSIONS = 1024;

const sourceShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  scope: col.enum(['public', 'program', 'persona', 'venture'] as const),
  venture_id: col.uuid.nullable,
  persona_id: col.uuid.nullable,
  title: col.text,
  uri: col.text.nullable,
  owner: col.text.nullable,
  classification: col.enum(['synthetic', 'public', 'program_internal', 'venture_private'] as const),
  checksum: col.text.nullable,
  license: col.text.nullable,
  status: col.enum(KNOWLEDGE_SOURCE_STATUSES),
  freshness_at: col.ts,
  created_by: col.uuid.nullable,
  created_at: col.ts,
  kind: col.enum(KnowledgeSourceKind.options),
  summary: col.text.nullable,
  body: col.text.nullable,
  updated_at: col.ts,
  failure_reason: col.text.nullable,
  filename: col.text.nullable,
  content_type: col.enum(DocumentContentType.options).nullable,
  size_bytes: col.int.nullable,
  s3_key: col.text.nullable,
};
const sourceCodec = camelRow(sourceShape);
/** A knowledge source. `body` is authored content: never log it. */
export type KnowledgeSourceRecord = CamelRow<typeof sourceShape>;
const SOURCE_COLUMNS = `id, tenant_id, scope, venture_id, persona_id, title, uri, owner, classification, checksum, license,
  status, freshness_at, created_by, created_at, kind, summary, body, updated_at, failure_reason, filename, content_type,
  size_bytes, s3_key`;

export interface CreateKnowledgeSourceInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly scope: KnowledgeScope;
  /** Required for scope `venture`, forbidden otherwise. */
  readonly ventureId?: string | null;
  /** Required for scope `persona`. */
  readonly personaId?: string | null;
  readonly title: string;
  readonly uri?: string | null;
  readonly owner?: string | null;
  readonly classification?: KnowledgeClassification;
  readonly checksum?: string | null;
  readonly license?: string | null;
  readonly freshnessAt?: string | Date | null;
  readonly createdBy?: string | null;
  /** Default `document`; notes, cases, FAQs and transcripts belong to persona or program corpora. */
  readonly kind?: KnowledgeKind;
  readonly summary?: string | null;
  /** Authored text (notes, cases, FAQs, transcripts). */
  readonly body?: string | null;
  /** Default `active`; shared-corpus uploads start `pending_upload`. */
  readonly status?: KnowledgeSourceStatusValue;
  /** Upload of a shared-corpus document (all four together). */
  readonly upload?: {
    readonly s3Key: string;
    readonly filename: string;
    readonly contentType: (typeof DocumentContentType.options)[number];
    readonly sizeBytes: number;
  } | null;
}

export function createKnowledgeSource(
  ex: SqlExecutor,
  input: CreateKnowledgeSourceInput,
): Promise<KnowledgeSourceRecord> {
  return queryOne(
    ex,
    `INSERT INTO knowledge_sources (id, tenant_id, scope, venture_id, persona_id, title, uri, owner, classification,
                                    checksum, license, freshness_at, created_by, kind, summary, body, status, s3_key,
                                    filename, content_type, size_bytes)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :scope, :ventureId, :personaId, :title, :uri, :owner,
             coalesce(:classification, 'synthetic'), :checksum, :license, coalesce(:freshnessAt, now()), :createdBy,
             coalesce(:kind, 'document'), :summary, :body, coalesce(:status, 'active'), :s3Key, :filename,
             :contentType, :sizeBytes)
     RETURNING ${SOURCE_COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      scope: p.text(input.scope),
      ventureId: p.nullable.uuid(input.ventureId),
      personaId: p.nullable.uuid(input.personaId),
      title: p.text(input.title),
      uri: p.nullable.text(input.uri),
      owner: p.nullable.text(input.owner),
      classification: p.nullable.text(input.classification),
      checksum: p.nullable.text(input.checksum),
      license: p.nullable.text(input.license),
      freshnessAt: p.nullable.ts(input.freshnessAt),
      createdBy: p.nullable.uuid(input.createdBy),
      kind: p.nullable.text(input.kind),
      summary: p.nullable.text(input.summary),
      body: p.nullable.text(input.body),
      status: p.nullable.text(input.status),
      s3Key: p.nullable.text(input.upload?.s3Key),
      filename: p.nullable.text(input.upload?.filename),
      contentType: p.nullable.text(input.upload?.contentType),
      sizeBytes: p.nullable.int(input.upload?.sizeBytes),
    },
    (r) => sourceCodec.decode(r),
    'createKnowledgeSource',
  );
}

export function getKnowledgeSource(ex: SqlExecutor, id: string): Promise<KnowledgeSourceRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${SOURCE_COLUMNS} FROM knowledge_sources WHERE id = :id`,
    { id: p.uuid(id) },
    (r) => sourceCodec.decode(r),
  );
}

export function listKnowledgeSources(
  ex: SqlExecutor,
  args: { tenantId: string; scope?: KnowledgeScope; ventureId?: string; personaId?: string },
): Promise<KnowledgeSourceRecord[]> {
  return queryRows(
    ex,
    `SELECT ${SOURCE_COLUMNS} FROM knowledge_sources
     WHERE tenant_id = :tenantId
       AND (:scope IS NULL OR scope = :scope)
       AND (:ventureId IS NULL OR venture_id = :ventureId)
       AND (:personaId IS NULL OR persona_id = :personaId)
     ORDER BY created_at, id`,
    {
      tenantId: p.uuid(args.tenantId),
      scope: p.nullable.text(args.scope),
      ventureId: p.nullable.uuid(args.ventureId),
      personaId: p.nullable.uuid(args.personaId),
    },
    (r) => sourceCodec.decode(r),
  );
}

/**
 * Moves a source through its lifecycle. `failureReason` is stored for `failed` and cleared otherwise;
 * `fromStatuses` makes the change optimistic (no row matched → false).
 */
export async function setKnowledgeSourceStatus(
  ex: SqlExecutor,
  args: {
    sourceId: string;
    status: KnowledgeSourceStatusValue;
    freshnessAt?: string | Date | null;
    failureReason?: string | null;
    fromStatuses?: readonly KnowledgeSourceStatusValue[];
    checksum?: string | null;
  },
): Promise<boolean> {
  const result = await ex.query(
    `UPDATE knowledge_sources
     SET status = :status, freshness_at = coalesce(:freshnessAt, freshness_at), updated_at = now(),
         failure_reason = CASE WHEN :status = 'failed' THEN :reason ELSE NULL END,
         checksum = coalesce(:checksum, checksum)
     WHERE id = :id AND (:fromStatuses IS NULL OR status = ANY (:fromStatuses))`,
    {
      id: p.uuid(args.sourceId),
      status: p.text(args.status),
      freshnessAt: p.nullable.ts(args.freshnessAt),
      reason: p.nullable.text(args.failureReason),
      fromStatuses: p.nullable.textArray(args.fromStatuses),
      checksum: p.nullable.text(args.checksum),
    },
  );
  return result.rowCount > 0;
}

export interface UpdateKnowledgeSourceInput {
  readonly title?: string;
  readonly summary?: string | null;
  readonly body?: string | null;
  readonly status?: KnowledgeSourceStatusValue;
}

/** Edits a source (curators under RLS); `freshness_at` moves when the text changes. Null when not visible. */
export function updateKnowledgeSource(
  ex: SqlExecutor,
  id: string,
  patch: UpdateKnowledgeSourceInput,
): Promise<KnowledgeSourceRecord | null> {
  const set = setClause([
    ['title', patch.title === undefined ? undefined : p.text(patch.title)],
    ['summary', patch.summary === undefined ? undefined : p.nullable.text(patch.summary)],
    ['body', patch.body === undefined ? undefined : p.nullable.text(patch.body)],
    ['status', patch.status === undefined ? undefined : p.text(patch.status)],
  ]);
  const assignments = [set.sql, 'updated_at = now()'];
  if (patch.body !== undefined || patch.title !== undefined) assignments.push('freshness_at = now()');
  return queryFirst(
    ex,
    `UPDATE knowledge_sources SET ${assignments.filter((a) => a !== '').join(', ')}
     WHERE id = :id RETURNING ${SOURCE_COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    (r) => sourceCodec.decode(r),
  );
}

// ------------------------------------------------------------------------------------------------
// Persona knowledge library (contract views)
// ------------------------------------------------------------------------------------------------

const LIBRARY_SELECT = `
  SELECT s.id, s.persona_id, s.kind, s.title, s.summary, s.body, s.status, s.failure_reason, s.created_at,
         s.updated_at, s.created_by, ${principalSelect('cb', 'cb')},
         (SELECT count(*) FROM knowledge_chunks c WHERE c.source_id = s.id) AS chunk_count
  FROM knowledge_sources s
  LEFT JOIN principals cb ON cb.id = s.created_by`;

function decodeLibraryView(r: RawRow): PersonaKnowledgeSourceView {
  const status = col.enum(KNOWLEDGE_SOURCE_STATUSES).decode(r.status, 'status');
  return {
    id: col.uuid.decode(r.id, 'id'),
    personaId: col.uuid.decode(r.persona_id, 'persona_id'),
    kind: col.enum(KnowledgeSourceKind.options).decode(r.kind, 'kind'),
    title: col.text.decode(r.title, 'title'),
    summary: col.text.nullable.decode(r.summary, 'summary'),
    body: col.text.nullable.decode(r.body, 'body'),
    // An upload still waiting for its object is reported as processing.
    status: status === 'pending_upload' ? 'processing' : status,
    failureReason: col.text.nullable.decode(r.failure_reason, 'failure_reason'),
    chunkCount: col.int.decode(r.chunk_count, 'chunk_count'),
    createdBy: principalFrom(r, 'cb', col.uuid.nullable.decode(r.created_by, 'created_by')),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    updatedAt: col.ts.decode(r.updated_at, 'updated_at'),
  };
}

/**
 * Library rows per statement: an authored note holds up to 50 000 characters, so five per statement keep a
 * result far below the RDS Data API's 1 MB limit.
 */
const LIBRARY_BATCH_SIZE = 5;

/**
 * A persona's knowledge library, most recently changed first: every source except uploads that never
 * completed (and withdrawn ones unless asked).
 */
export async function listPersonaLibrary(
  ex: SqlExecutor,
  args: { personaId: string; includeWithdrawn?: boolean },
): Promise<PersonaKnowledgeSourceView[]> {
  const ids = await queryRows(
    ex,
    `SELECT s.id FROM knowledge_sources s
     WHERE s.scope = 'persona' AND s.persona_id = :personaId AND s.status <> 'pending_upload'
       AND (:withdrawn OR s.status <> 'withdrawn')
     ORDER BY s.updated_at DESC, s.id`,
    { personaId: p.uuid(args.personaId), withdrawn: p.bool(args.includeWithdrawn ?? false) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return fetchByIdsInBatches(
    ids,
    LIBRARY_BATCH_SIZE,
    (batch) =>
      queryRows(
        ex,
        `${LIBRARY_SELECT} WHERE s.id = ANY (:ids)`,
        { ids: p.uuidArray(batch) },
        decodeLibraryView,
      ),
    (view) => view.id,
  );
}

/** One library source as the contract view (null when not visible or not a persona source). */
export function getPersonaLibrarySource(
  ex: SqlExecutor,
  sourceId: string,
): Promise<PersonaKnowledgeSourceView | null> {
  return queryFirst(
    ex,
    `${LIBRARY_SELECT} WHERE s.id = :id AND s.scope = 'persona'`,
    { id: p.uuid(sourceId) },
    decodeLibraryView,
  );
}

// ------------------------------------------------------------------------------------------------
// Chunks
// ------------------------------------------------------------------------------------------------

export interface ChunkInput {
  readonly ordinal: number;
  readonly heading?: string | null;
  readonly content: string;
  readonly tokenCount?: number;
  /** 1024-d embedding, or null/undefined to backfill later (lexical retrieval works meanwhile). */
  readonly embedding?: readonly number[] | null;
}

export interface InsertChunksInput {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly scope: KnowledgeScope;
  readonly ventureId?: string | null;
  readonly personaId?: string | null;
  readonly chunks: readonly ChunkInput[];
  /**
   * Upper bound on the JSON payload of one statement (default 200 000 characters). Batches keep RDS
   * Data API requests small; embeddings are ~14 KB of text each.
   */
  readonly maxPayloadChars?: number;
}

function assertEmbedding(embedding: readonly number[]): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new SqlUsageError(`embedding must have ${EMBEDDING_DIMENSIONS} dimensions`);
  }
}

/**
 * Inserts chunks in batches (one multi-row INSERT per batch via jsonb_to_recordset, so both drivers
 * make few round trips). Returns the number of chunks inserted. Duplicate (source, ordinal) pairs fail.
 */
export async function insertChunks(ex: SqlExecutor, input: InsertChunksInput): Promise<number> {
  const limit = input.maxPayloadChars ?? 200_000;
  const items = input.chunks.map((c) => {
    if (c.embedding) assertEmbedding(c.embedding);
    return {
      ordinal: c.ordinal,
      heading: c.heading ?? null,
      content: c.content,
      token_count: c.tokenCount ?? 0,
      embedding: c.embedding ? encodeVectorLiteral(c.embedding) : null,
    };
  });
  const batches: (typeof items)[] = [];
  let current: typeof items = [];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length;
    if (current.length > 0 && size + itemSize > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) batches.push(current);

  let inserted = 0;
  for (const batch of batches) {
    const result = await ex.query(
      `INSERT INTO knowledge_chunks (source_id, tenant_id, scope, venture_id, persona_id, ordinal, heading, content,
                                     token_count, embedding)
       SELECT :sourceId, :tenantId, :scope, :ventureId, :personaId, x.ordinal, x.heading, x.content, x.token_count,
              CAST(x.embedding AS vector)
       FROM jsonb_to_recordset(:rows) AS x (ordinal integer, heading text, content text, token_count integer, embedding text)`,
      {
        sourceId: p.uuid(input.sourceId),
        tenantId: p.uuid(input.tenantId),
        scope: p.text(input.scope),
        ventureId: p.nullable.uuid(input.ventureId),
        personaId: p.nullable.uuid(input.personaId),
        rows: p.json(batch),
      },
    );
    inserted += result.rowCount;
  }
  return inserted;
}

/** Number of chunks of a source. */
export function countChunks(ex: SqlExecutor, sourceId: string): Promise<number> {
  return queryNumber(ex, 'SELECT count(*) AS n FROM knowledge_chunks WHERE source_id = :id', {
    id: p.uuid(sourceId),
  });
}

/**
 * Removes every chunk of a source (re-ingestion, an edited note, a withdrawn source). Under RLS only a
 * persona's curators (persona corpora) and program leads (program corpora) may delete; venture chunks are
 * removed by `app.soft_delete_document` alone.
 */
export async function deleteChunksForSource(ex: SqlExecutor, sourceId: string): Promise<number> {
  const result = await ex.query('DELETE FROM knowledge_chunks WHERE source_id = :id', {
    id: p.uuid(sourceId),
  });
  return result.rowCount;
}

export interface EmbeddingBacklogItem {
  readonly id: string;
  /** Text to embed (heading + content for chunks, title + content for memory). Never log it. */
  readonly text: string;
}

/** Chunks without an embedding (seed backfill, failed ingestion embeds). System only. */
export function listChunksMissingEmbeddings(sx: SystemExecutor, limit = 64): Promise<EmbeddingBacklogItem[]> {
  return queryRows(
    sx,
    `SELECT id, coalesce(heading || E'\\n\\n', '') || content AS text
     FROM knowledge_chunks WHERE embedding IS NULL ORDER BY created_at, id LIMIT :limit`,
    { limit: p.int(limit) },
    (r) => ({ id: col.uuid.decode(r.id, 'id'), text: col.text.decode(r.text, 'text') }),
  );
}

/** Sets chunk embeddings (one statement per call). Returns the number of chunks updated. */
export async function setChunkEmbeddings(
  sx: SystemExecutor,
  items: readonly { readonly id: string; readonly embedding: readonly number[] }[],
): Promise<number> {
  return setEmbeddings(sx, 'knowledge_chunks', items);
}

/** Confirmed/proposed memory items without an embedding. System only. */
export function listMemoryMissingEmbeddings(sx: SystemExecutor, limit = 64): Promise<EmbeddingBacklogItem[]> {
  return queryRows(
    sx,
    `SELECT id, title || E'\\n\\n' || content AS text
     FROM memory_objects
     WHERE embedding IS NULL AND status IN ('proposed', 'confirmed', 'disputed')
     ORDER BY created_at, id LIMIT :limit`,
    { limit: p.int(limit) },
    (r) => ({ id: col.uuid.decode(r.id, 'id'), text: col.text.decode(r.text, 'text') }),
  );
}

/** Memory statuses whose content is live (the only ones that may carry an embedding). */
export const EMBEDDABLE_MEMORY_STATUSES = ['proposed', 'confirmed', 'disputed'] as const;

/**
 * Stores memory embeddings, status-guarded: an item deleted, superseded or expired after its text was
 * read keeps a NULL embedding (a deleted item's content is erased and must not regain a vector of its
 * old text). Returns the number of items updated.
 *
 * Accepts either executor: the backfill uses the owner role; request paths pass their RLS transaction,
 * where the `memory_update` policy additionally limits the write to items the caller may edit.
 */
export function setMemoryEmbeddings(
  ex: SqlExecutor,
  items: readonly { readonly id: string; readonly embedding: readonly number[] }[],
): Promise<number> {
  return setEmbeddings(
    ex,
    'memory_objects',
    items,
    `AND t.status IN (${EMBEDDABLE_MEMORY_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  );
}

async function setEmbeddings(
  ex: SqlExecutor,
  table: 'knowledge_chunks' | 'memory_objects',
  items: readonly { readonly id: string; readonly embedding: readonly number[] }[],
  guard = '',
): Promise<number> {
  let updated = 0;
  // Small batches keep each Data API request well under its payload limit.
  for (let i = 0; i < items.length; i += 8) {
    const batch = items.slice(i, i + 8).map((it) => {
      assertEmbedding(it.embedding);
      return { id: it.id, embedding: encodeVectorLiteral(it.embedding) };
    });
    const result = await ex.query(
      `UPDATE ${table} t SET embedding = CAST(x.embedding AS vector)
       FROM jsonb_to_recordset(:rows) AS x (id uuid, embedding text)
       WHERE t.id = x.id ${guard}`,
      { rows: p.json(batch) },
    );
    updated += result.rowCount;
  }
  return updated;
}
