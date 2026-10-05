import { camelRow, col, type CamelRow } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { encodeVectorLiteral, p } from '../params.js';
import { queryFirst, queryNumber, queryOne, queryRows } from './common.js';

export type KnowledgeScope = 'public' | 'program' | 'persona' | 'venture';
export type KnowledgeClassification = 'synthetic' | 'public' | 'program_internal' | 'venture_private';

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
  status: col.enum(['active', 'stale', 'withdrawn'] as const),
  freshness_at: col.ts,
  created_by: col.uuid.nullable,
  created_at: col.ts,
};
const sourceCodec = camelRow(sourceShape);
export type KnowledgeSourceRecord = CamelRow<typeof sourceShape>;
const SOURCE_COLUMNS =
  'id, tenant_id, scope, venture_id, persona_id, title, uri, owner, classification, checksum, license, status, freshness_at, created_by, created_at';

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
}

export function createKnowledgeSource(
  ex: SqlExecutor,
  input: CreateKnowledgeSourceInput,
): Promise<KnowledgeSourceRecord> {
  return queryOne(
    ex,
    `INSERT INTO knowledge_sources (id, tenant_id, scope, venture_id, persona_id, title, uri, owner, classification,
                                    checksum, license, freshness_at, created_by)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :scope, :ventureId, :personaId, :title, :uri, :owner,
             coalesce(:classification, 'synthetic'), :checksum, :license, coalesce(:freshnessAt, now()), :createdBy)
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

export async function setKnowledgeSourceStatus(
  ex: SqlExecutor,
  args: { sourceId: string; status: KnowledgeSourceRecord['status']; freshnessAt?: string | Date | null },
): Promise<boolean> {
  const result = await ex.query(
    `UPDATE knowledge_sources SET status = :status, freshness_at = coalesce(:freshnessAt, freshness_at) WHERE id = :id`,
    { id: p.uuid(args.sourceId), status: p.text(args.status), freshnessAt: p.nullable.ts(args.freshnessAt) },
  );
  return result.rowCount > 0;
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

/** Removes every chunk of a source (re-ingestion). System only: app_rls cannot delete chunks. */
export async function deleteChunksForSource(sx: SystemExecutor, sourceId: string): Promise<number> {
  const result = await sx.query('DELETE FROM knowledge_chunks WHERE source_id = :id', {
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
