/**
 * Hybrid retrieval (vector + full text) for the evidence pack.
 *
 *   score = 0.55 · max(0, 1 − cosine_distance) + 0.25 · ts_rank_cd(…, 32) + 0.10 · recency + 0.10 · authority
 *
 * - ts_rank_cd normalisation 32 maps the rank into [0, 1) (rank / (rank + 1)); the lexical query uses OR
 *   semantics over the stemmed query words.
 * - recency = 0.5 ^ (age_days / half_life_days) (default half-life 90 days).
 * - authority is store-specific (memory: status, confidence, pin; chunks: source status).
 * - Rows without an embedding (or a query without one) score lexically only (vector term = 0).
 *
 * Venture-scoped stores (venture chunks, memory) always filter `tenant_id` and `venture_id` FIRST and scan
 * exactly within the venture — there is no unscoped vector search. Shared corpora (program/public/persona,
 * `venture_id IS NULL`) take ANN candidates from the partial HNSW index plus lexical candidates, then
 * rescore. Under `db.withContext` RLS additionally applies (memory visibility, venture membership).
 *
 * founder_private memory is never a coaching candidate: turns, their evidence, recaps, escalation drafts
 * and EIR samples are shared with the venture team (and sampled turns with the assigned EIR), so an item
 * visible to its author only must not shape them. `privateOwnerId` is the only way in (that principal's
 * own private items), for a session whose content RLS restricts to its author; no such session mode
 * exists today, so callers never pass it.
 */
import { EvidenceKind, MemoryStatus, MemoryType, Visibility } from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p, type SqlParam } from '../params.js';
import { clampLimit, excerptSql, orTsQuerySql, queryRows } from './common.js';
import { type KnowledgeClassification } from './knowledge.js';
import { ACTIVE_MEMORY_STATUSES, type MemoryStatusValue, type MemoryTypeValue } from './memory.js';

export const RETRIEVAL_WEIGHTS = { vector: 0.55, lexical: 0.25, recency: 0.1, authority: 0.1 } as const;
export const DEFAULT_HALF_LIFE_DAYS = 90;

type EvidenceKindValue = z.infer<typeof EvidenceKind>;

/** A scored candidate; core assigns evidence keys (E1…En) and builds `EvidenceItem`s from these. */
export interface RetrievedItem {
  readonly kind: EvidenceKindValue;
  /** Id of the memory item / chunk / resource / pattern. */
  readonly refId: string;
  readonly title: string;
  /** At most 600 characters. */
  readonly excerpt: string;
  readonly score: number;
  readonly freshnessAt: string | null;
  /** Memory status, source status, resource status or pattern status. */
  readonly status: string | null;
  readonly ventureId: string | null;
  /** Knowledge source of a chunk. */
  readonly sourceId: string | null;
  /** Memory type (memory items only). */
  readonly memoryType: MemoryTypeValue | null;
  /** Memory visibility (memory items only). */
  readonly visibility: z.infer<typeof Visibility> | null;
  readonly components: {
    readonly vector: number;
    readonly lexical: number;
    readonly recency: number;
    readonly authority: number;
    /** Resources only: 1 when tagged for the venture's stage, 0.5 when untagged, else 0. */
    readonly stageFit?: number;
  };
}

interface BaseQuery {
  readonly tenantId: string;
  /** The founder's text (websearch syntax tolerated). May be empty when an embedding is given. */
  readonly query: string;
  /** Query embedding (1024-d) or null for lexical-only retrieval. */
  readonly embedding: readonly number[] | null;
  readonly limit?: number;
  readonly halfLifeDays?: number;
  /** Drop candidates scoring below this (default 0). */
  readonly minScore?: number;
}

const SCORE_SQL = `(${RETRIEVAL_WEIGHTS.vector} * x.vec + ${RETRIEVAL_WEIGHTS.lexical} * x.lex
  + ${RETRIEVAL_WEIGHTS.recency} * x.recency + ${RETRIEVAL_WEIGHTS.authority} * x.authority)`;

function vecSql(column: string): string {
  return `CASE WHEN ${column} IS NULL OR :embedding IS NULL THEN 0
               ELSE greatest(0, 1 - (${column} <=> :embedding)) END`;
}

function recencySql(column: string): string {
  return `power(0.5, greatest(0, extract(epoch FROM now() - ${column})) / (86400.0 * :halfLife))`;
}

function baseParams(q: BaseQuery, defaultLimit: number): Record<string, SqlParam> {
  return {
    tenantId: p.uuid(q.tenantId),
    query: p.text(q.query),
    embedding: p.nullable.vector(q.embedding),
    halfLife: p.num(q.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS),
    minScore: p.num(q.minScore ?? 0),
    limit: p.int(clampLimit(q.limit, defaultLimit, 50)),
  };
}

function decodeItem(kind: EvidenceKindValue | 'from_row', r: RawRow): RetrievedItem {
  const resolvedKind = kind === 'from_row' ? col.enum(EvidenceKind.options).decode(r.kind, 'kind') : kind;
  const stageFit = r.stage_fit === undefined ? undefined : col.num.decode(r.stage_fit, 'stage_fit');
  return {
    kind: resolvedKind,
    refId: col.uuid.decode(r.id, 'id'),
    title: col.text.decode(r.title, 'title'),
    excerpt: col.text.decode(r.excerpt, 'excerpt'),
    score: col.num.decode(r.score, 'score'),
    freshnessAt: col.ts.nullable.decode(r.freshness_at, 'freshness_at'),
    status: col.text.nullable.decode(r.status, 'status'),
    ventureId: col.uuid.nullable.decode(r.venture_id, 'venture_id'),
    sourceId: col.uuid.nullable.decode(r.source_id, 'source_id'),
    memoryType: col.enum(MemoryType.options).nullable.decode(r.memory_type, 'memory_type'),
    visibility: col.enum(Visibility.options).nullable.decode(r.visibility, 'visibility'),
    components: {
      vector: col.num.decode(r.vec, 'vec'),
      lexical: col.num.decode(r.lex, 'lex'),
      recency: col.num.decode(r.recency, 'recency'),
      authority: col.num.decode(r.authority, 'authority'),
      ...(stageFit === undefined ? {} : { stageFit }),
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Venture memory
// ------------------------------------------------------------------------------------------------

export interface VentureMemoryQuery extends BaseQuery {
  readonly ventureId: string;
  /** Default proposed + confirmed + disputed (disputed items carry a contradiction signal). */
  readonly statuses?: readonly MemoryStatusValue[];
  readonly types?: readonly MemoryTypeValue[];
  /**
   * Include this principal's own founder_private items (and nobody else's). Only for sessions whose
   * content is readable by that principal alone; default none: founder_private items are excluded.
   */
  readonly privateOwnerId?: string | null;
}

/**
 * Venture memory candidates (founder_private items excluded, see the module comment). authority = 1 for pinned items, otherwise
 * status weight (confirmed 1.0, disputed 0.5, proposed 0.4) × (0.5 + 0.5 · confidence).
 * Pinned items are always candidates.
 */
export function searchVentureMemory(ex: SqlExecutor, q: VentureMemoryQuery): Promise<RetrievedItem[]> {
  const statuses = (q.statuses ?? ACTIVE_MEMORY_STATUSES).filter((s) => MemoryStatus.options.includes(s));
  return queryRows(
    ex,
    `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT m.id, m.venture_id, NULL::uuid AS source_id, m.type AS memory_type, m.visibility, m.title,
              ${excerptSql('m.content')} AS excerpt, m.updated_at AS freshness_at, m.status,
              ${vecSql('m.embedding')} AS vec,
              ts_rank_cd(m.tsv, q.tsq, 32) AS lex,
              ${recencySql('m.updated_at')} AS recency,
              CASE WHEN m.pinned THEN 1.0
                   ELSE (CASE m.status WHEN 'confirmed' THEN 1.0 WHEN 'disputed' THEN 0.5 ELSE 0.4 END)
                        * (0.5 + 0.5 * m.confidence) END AS authority
       FROM memory_objects m CROSS JOIN q
       WHERE m.tenant_id = :tenantId AND m.venture_id = :ventureId
         AND m.status = ANY (:statuses)
         AND (:types IS NULL OR m.type = ANY (:types))
         AND (m.visibility <> 'founder_private' OR (:privateOwner IS NOT NULL AND m.created_by = :privateOwner))
         AND (m.tsv @@ q.tsq OR m.pinned OR (:embedding IS NOT NULL AND m.embedding IS NOT NULL))
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    {
      ...baseParams(q, 8),
      ventureId: p.uuid(q.ventureId),
      statuses: p.textArray(statuses),
      types: p.nullable.textArray(q.types),
      privateOwner: p.nullable.uuid(q.privateOwnerId),
    },
    (r) => decodeItem('memory', r),
  );
}

// ------------------------------------------------------------------------------------------------
// Venture documents
// ------------------------------------------------------------------------------------------------

export interface VentureChunkQuery extends BaseQuery {
  readonly ventureId: string;
}

/** Chunks of the venture's own documents (exact scan inside the venture). authority: active 1.0, stale 0.5. */
export function searchVentureChunks(ex: SqlExecutor, q: VentureChunkQuery): Promise<RetrievedItem[]> {
  return queryRows(
    ex,
    `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT c.id, c.venture_id, c.source_id, NULL::text AS memory_type, NULL::text AS visibility,
              CASE WHEN c.heading IS NULL OR c.heading = '' THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
              ${excerptSql('c.content')} AS excerpt, s.freshness_at, s.status,
              ${vecSql('c.embedding')} AS vec,
              ts_rank_cd(c.tsv, q.tsq, 32) AS lex,
              ${recencySql('s.freshness_at')} AS recency,
              CASE s.status WHEN 'active' THEN 1.0 ELSE 0.5 END AS authority
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id
       CROSS JOIN q
       WHERE c.tenant_id = :tenantId AND c.venture_id = :ventureId AND c.scope = 'venture'
         AND s.venture_id = :ventureId AND s.status <> 'withdrawn'
         AND (c.tsv @@ q.tsq OR (:embedding IS NOT NULL AND c.embedding IS NOT NULL))
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    { ...baseParams(q, 6), ventureId: p.uuid(q.ventureId) },
    (r) => decodeItem('chunk', r),
  );
}

// ------------------------------------------------------------------------------------------------
// Shared corpora (program / public / persona doctrine)
// ------------------------------------------------------------------------------------------------

export interface SharedChunkQuery extends BaseQuery {
  /** Default ['program', 'public', 'persona']. Persona chunks are only returned for `personaId`. */
  readonly scopes?: readonly ('program' | 'public' | 'persona')[];
  /** The assigned persona whose doctrine corpus may be searched. */
  readonly personaId?: string | null;
  /** Allowed source classifications (data-class ceiling of the assignment). Default: all. */
  readonly classifications?: readonly KnowledgeClassification[];
  /** ANN / lexical candidate pool size (default 40 = HNSW ef_search default). */
  readonly candidates?: number;
}

/**
 * Shared-corpus chunks: candidates from the HNSW index (`ORDER BY embedding <=> :q LIMIT n` on the
 * `venture_id IS NULL` partial index) ∪ lexical candidates, rescored with the hybrid formula. Persona
 * chunks are returned as kind `doctrine`, others as `chunk`. authority: persona 1.0, program 0.9,
 * public 0.7 (× 0.5 when the source is stale).
 */
export function searchSharedChunks(ex: SqlExecutor, q: SharedChunkQuery): Promise<RetrievedItem[]> {
  const scopeFilter = `c.venture_id IS NULL AND c.tenant_id = :tenantId AND c.scope = ANY (:scopes)
    AND (c.scope <> 'persona' OR c.persona_id = :personaId)`;
  return queryRows(
    ex,
    `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     , ann AS (
       SELECT c.id FROM knowledge_chunks c
       WHERE ${scopeFilter} AND :embedding IS NOT NULL
       ORDER BY c.embedding <=> :embedding
       LIMIT :candidates)
     , lexical AS (
       SELECT c.id FROM knowledge_chunks c CROSS JOIN q
       WHERE ${scopeFilter} AND c.tsv @@ q.tsq
       ORDER BY ts_rank_cd(c.tsv, q.tsq, 32) DESC, c.id
       LIMIT :candidates)
     , cand AS (SELECT id FROM ann UNION SELECT id FROM lexical)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT c.id, NULL::uuid AS venture_id, c.source_id, NULL::text AS memory_type, NULL::text AS visibility,
              CASE WHEN c.scope = 'persona' THEN 'doctrine' ELSE 'chunk' END AS kind,
              CASE WHEN c.heading IS NULL OR c.heading = '' THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
              ${excerptSql('c.content')} AS excerpt, s.freshness_at, s.status,
              ${vecSql('c.embedding')} AS vec,
              ts_rank_cd(c.tsv, q.tsq, 32) AS lex,
              ${recencySql('s.freshness_at')} AS recency,
              (CASE c.scope WHEN 'persona' THEN 1.0 WHEN 'program' THEN 0.9 ELSE 0.7 END)
                * (CASE s.status WHEN 'active' THEN 1.0 ELSE 0.5 END) AS authority
       FROM cand
       JOIN knowledge_chunks c ON c.id = cand.id
       JOIN knowledge_sources s ON s.id = c.source_id
       CROSS JOIN q
       WHERE ${scopeFilter} AND s.status <> 'withdrawn'
         AND (:classifications IS NULL OR s.classification = ANY (:classifications))
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    {
      ...baseParams(q, 4),
      scopes: p.textArray(q.scopes ?? ['program', 'public', 'persona']),
      personaId: p.nullable.uuid(q.personaId),
      classifications: p.nullable.textArray(q.classifications),
      candidates: p.int(clampLimit(q.candidates, 40, 400)),
    },
    (r) => decodeItem('from_row', r),
  );
}

// ------------------------------------------------------------------------------------------------
// Program resources and patterns (lexical; no embeddings)
// ------------------------------------------------------------------------------------------------

export interface ResourceQuery extends Omit<BaseQuery, 'embedding'> {
  /** Venture stage: resources tagged for it get the stage-fit bonus. */
  readonly stage?: string | null;
}

/**
 * Program resources for route mode: score = 0.55 · lexical + 0.25 · stage fit + 0.10 · recency +
 * 0.10 · authority (active 1.0, stale 0.5). Stage fit: 1 when the resource lists the stage, 0.5 when it
 * lists no stages. Candidates match lexically; retired resources are excluded.
 */
export function searchResources(ex: SqlExecutor, q: ResourceQuery): Promise<RetrievedItem[]> {
  const score = '(0.55 * x.lex + 0.25 * x.stage_fit + 0.10 * x.recency + 0.10 * x.authority)';
  return queryRows(
    ex,
    `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${score} AS score FROM (
       SELECT r.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS memory_type,
              NULL::text AS visibility, r.name AS title,
              ${excerptSql('r.description')} AS excerpt, r.freshness_at, r.status,
              0::double precision AS vec,
              CASE WHEN :stage IS NOT NULL AND :stage = ANY (r.stages) THEN 1.0
                   WHEN cardinality(r.stages) = 0 THEN 0.5 ELSE 0 END AS stage_fit,
              ts_rank_cd(r.tsv, q.tsq, 32) AS lex,
              ${recencySql('r.freshness_at')} AS recency,
              CASE r.status WHEN 'active' THEN 1.0 ELSE 0.5 END AS authority
       FROM resources r CROSS JOIN q
       WHERE r.tenant_id = :tenantId AND r.status <> 'retired' AND r.tsv @@ q.tsq
     ) x
     WHERE ${score} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    { ...baseParams({ ...q, embedding: null }, 4), stage: p.nullable.text(q.stage) },
    (r) => decodeItem('resource', r),
  );
}

/** Published, unexpired patterns (lexical over title/context/signal/intervention). */
export function searchPatterns(ex: SqlExecutor, q: Omit<BaseQuery, 'embedding'>): Promise<RetrievedItem[]> {
  return queryRows(
    ex,
    `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT pt.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS memory_type,
              NULL::text AS visibility, pt.title,
              ${excerptSql("pt.signal || ' → ' || pt.intervention || ' (limits: ' || pt.limits || ')'")} AS excerpt,
              pt.created_at AS freshness_at, pt.status,
              0::double precision AS vec,
              ts_rank_cd(to_tsvector('english', pt.title || ' ' || pt.context || ' ' || pt.signal || ' ' || pt.intervention),
                         q.tsq, 32) AS lex,
              ${recencySql('pt.created_at')} AS recency,
              1.0 AS authority
       FROM patterns pt CROSS JOIN q
       WHERE pt.tenant_id = :tenantId AND pt.status = 'published'
         AND (pt.expires_at IS NULL OR pt.expires_at > now())
         AND to_tsvector('english', pt.title || ' ' || pt.context || ' ' || pt.signal || ' ' || pt.intervention) @@ q.tsq
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    baseParams({ ...q, embedding: null }, 2),
    (r) => decodeItem('pattern', r),
  );
}
