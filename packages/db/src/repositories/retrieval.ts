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
import { EvidenceKind, EvidenceSourceScope, MemoryStatus, MemoryType, Visibility } from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p, type SqlParam, type SqlParams } from '../params.js';
import { rewritePlaceholders } from '../sql-lexer.js';
import { clampLimit, excerptSql, orTsQuerySql, queryRows } from './common.js';
import { DOCUMENTED_ACCOUNT_HEADING, PACK_URI_PREFIX } from '../knowledge-pack/render.js';
import { type KnowledgeClassification } from './knowledge.js';
import { ACTIVE_MEMORY_STATUSES, type MemoryStatusValue, type MemoryTypeValue } from './memory.js';

export const RETRIEVAL_WEIGHTS = { vector: 0.55, lexical: 0.25, recency: 0.1, authority: 0.1 } as const;
export const DEFAULT_HALF_LIFE_DAYS = 90;

type EvidenceKindValue = z.infer<typeof EvidenceKind>;
type EvidenceSourceScopeValue = z.infer<typeof EvidenceSourceScope>;

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
  /** Scope of that source: a venture document, or a program, public or persona library source. */
  readonly sourceScope: EvidenceSourceScopeValue | null;
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
    sourceScope: col.enum(EvidenceSourceScope.options).nullable.decode(r.source_scope, 'source_scope'),
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

/** One store's search: its SQL, parameters and row decoder (run alone, or with the others in one statement). */
interface StoreSearch {
  readonly sql: string;
  readonly params: SqlParams;
  readonly decode: (raw: RawRow) => RetrievedItem;
}

function run(ex: SqlExecutor, search: StoreSearch): Promise<RetrievedItem[]> {
  return queryRows(ex, search.sql, search.params, search.decode);
}

// ------------------------------------------------------------------------------------------------
// Venture memory
// ------------------------------------------------------------------------------------------------

export interface VentureMemoryQuery extends BaseQuery {
  readonly ventureId: string;
  /**
   * Default proposed + confirmed + disputed (disputed items carry a contradiction signal). An AI suggestion still
   * `proposed` is never coach context: under automatic memory every AI item is kept (`confirmed`) at once, so only
   * leftovers the daily maintenance has not checked yet are proposed, and they wait for it (migration 0026).
   * Memory kept automatically (no approver) is retrieved like any confirmed item.
   */
  readonly statuses?: readonly MemoryStatusValue[];
  readonly types?: readonly MemoryTypeValue[];
  /**
   * Include this principal's own founder_private items (and nobody else's). Only for sessions whose
   * content is readable by that principal alone; default none: founder_private items are excluded.
   */
  readonly privateOwnerId?: string | null;
  /**
   * The conversation the turn belongs to: AI memory first learned in it is left out (the history already has what was
   * said; live pilot 42099643194: a turn's own kept items came back as evidence on the next one, and the coach cited
   * its own plan, or the founder's words of a minute ago, as a fact). Items from earlier conversations stay, even when
   * this one repeated them.
   */
  readonly excludeSessionId?: string | null;
  /**
   * With {@link excludeSessionId}: only items of that conversation created at or after this instant are left out (the
   * oldest turn still in the history window). Items learned from turns that fell out of the window come back as
   * evidence, so a long conversation keeps its early facts. Null or absent: every item of the conversation is left out
   * (the whole conversation is in view).
   */
  readonly excludeSessionSince?: string | null;
}

/**
 * Venture memory candidates (founder_private items excluded, see the module comment). authority = 1 for pinned items, otherwise
 * status weight (confirmed 1.0, disputed 0.5, proposed 0.4: an EIR's proposal; an AI suggestion still proposed is
 * never a candidate) × (0.5 + 0.5 · confidence). Pinned items are always candidates.
 */
export function searchVentureMemory(ex: SqlExecutor, q: VentureMemoryQuery): Promise<RetrievedItem[]> {
  return run(ex, memorySearch(q));
}

function memorySearch(q: VentureMemoryQuery): StoreSearch {
  const statuses = (q.statuses ?? ACTIVE_MEMORY_STATUSES).filter((s) => MemoryStatus.options.includes(s));
  return {
    sql: `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT m.id, m.venture_id, NULL::uuid AS source_id, NULL::text AS source_scope, m.type AS memory_type,
              m.visibility, m.title,
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
         AND NOT (m.origin = 'ai' AND m.status = 'proposed')
         AND (:types IS NULL OR m.type = ANY (:types))
         AND (m.visibility <> 'founder_private' OR (:privateOwner IS NOT NULL AND m.created_by = :privateOwner))
         AND NOT (:excludeSession IS NOT NULL AND m.origin = 'ai' AND jsonb_typeof(m.source_refs) = 'array'
                  AND m.source_refs -> 0 ->> 'kind' = 'session' AND m.source_refs -> 0 ->> 'id' = :excludeSession
                  AND (CAST(:excludeSince AS timestamptz) IS NULL OR m.created_at >= CAST(:excludeSince AS timestamptz)))
         AND (m.tsv @@ q.tsq OR m.pinned OR (:embedding IS NOT NULL AND m.embedding IS NOT NULL))
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    params: {
      ...baseParams(q, 8),
      ventureId: p.uuid(q.ventureId),
      statuses: p.textArray(statuses),
      types: p.nullable.textArray(q.types),
      privateOwner: p.nullable.uuid(q.privateOwnerId),
      excludeSession: p.nullable.text(q.excludeSessionId),
      excludeSince: p.nullable.ts(q.excludeSessionId == null ? null : (q.excludeSessionSince ?? null)),
    },
    decode: (r) => decodeItem('memory', r),
  };
}

// ------------------------------------------------------------------------------------------------
// Venture documents
// ------------------------------------------------------------------------------------------------

export interface VentureChunkQuery extends BaseQuery {
  readonly ventureId: string;
}

/** Chunks of the venture's own documents (exact scan inside the venture). authority: active 1.0, stale 0.5. */
export function searchVentureChunks(ex: SqlExecutor, q: VentureChunkQuery): Promise<RetrievedItem[]> {
  return run(ex, chunkSearch(q));
}

function chunkSearch(q: VentureChunkQuery): StoreSearch {
  return {
    sql: `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT c.id, c.venture_id, c.source_id, 'venture'::text AS source_scope, NULL::text AS memory_type,
              NULL::text AS visibility,
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
    params: { ...baseParams(q, 6), ventureId: p.uuid(q.ventureId) },
    decode: (r) => decodeItem('chunk', r),
  };
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
  /**
   * Most reference-library passages (scope `public`) returned, among `limit` (default
   * {@link REFERENCE_GATE}.limit). They are candidates only when they pass the relevance gate.
   */
  readonly referenceLimit?: number;
}

/**
 * When a reference-library passage (scope `public`: the startup knowledge base, general material the program did
 * not write) is relevant enough to be shown at all. Unlike the program's own corpus and the vEIR's library, it is
 * never a candidate by vector proximity or by one shared word: the coaching diagnosis of 2026-11-05 traced
 * fixation to library notes injected on almost every turn whatever was asked. A passage qualifies only when the
 * founder's words name its subject:
 *
 * - the query's subject words are its English stems, without stopwords, the words of a request rather than a
 *   subject ({@link REFERENCE_REQUEST_WORDS}: "help", "tips", "one"…), compounds' parts counted once, numbers and
 *   two-letter stems; they are DISTINCTIVE when found in at most `maxShare` of the library's passages (at least
 *   `minDf`), so "startup", "customer" or "framework" alone never select anything;
 * - a passage (its heading, text and its source's title) must contain at least `minHits` distinctive words, or be
 *   a documented case whose company the founder names as written ("Dropbox", "NONA": the first word of the case
 *   title's company part, matched case-sensitively as a whole word, so "embrace change" is not "Embrace"), and in
 *   either case at least `minCoverage` of all the distinctive words the query has. A case's company name counts as
 *   a word only when it is named that way;
 * - with a query embedding, a passage whose own embedding is less similar than `minVector` is vetoed (a lenient
 *   floor: the words may coincide while the meaning differs). Similarity never admits a passage on its own;
 * - a question about the program itself ({@link REFERENCE_PROGRAM_WORDS}: its curriculum, gates, EIRs) draws
 *   on the program's own guidance only: the Ain curriculum is preferred, and the library stays out of it.
 *
 * One passage per library item (a documented account before the same case's editorial guidance on a tie) and at
 * most `limit` per turn (voice: 1), in slots of their own beside the shared budget: passages that passed the gate
 * are relevant by construction and never lose their place to the vEIR's doctrine, which is retrieved on almost
 * every turn. They are ranked by the usual hybrid score, in which the library's authority (0.7; 0.63 for
 * editorial guidance) stays below the program's own guidance (0.9) and the vEIR's library (1.0), so the
 * program's curriculum comes first when both cover a question.
 */
export const REFERENCE_GATE = {
  minHits: 2,
  minCoverage: 0.34,
  maxShare: 0.25,
  minDf: 3,
  minVector: 0.2,
  limit: 2,
} as const;

/** Words of a request rather than of its subject; never subject words for the reference gate. */
export const REFERENCE_REQUEST_WORDS =
  'help helping need needs want wants tip tips think know idea ideas question questions thing things way ways ' +
  'thanks thank please advice advise tell ask talk mean sure okay yes get make take say see let use using feel ' +
  'try look like also really just one two three four five first second new good best better right time today ' +
  'week day month year lot much many well still even now kind sort maybe something anything everything stuff';

/**
 * Words that only a question about the program itself uses (its name, cohort, curriculum, handbook, stage gates,
 * EIRs): such a question is answered from the program's own guidance, so the general reference library is not
 * searched at all. Words with everyday senses ("program", "session", "module") are left out on purpose.
 */
export const REFERENCE_PROGRAM_WORDS = 'Ain Foundry cohort curriculum handbook gate gates EIR EIRs';

/** Documented cases of the startup knowledge base (`knowledge-pack/render.ts`), whose company a founder may name. */
const REFERENCE_CASE_URI_PREFIX = `${PACK_URI_PREFIX}case/`;

/**
 * Shared-corpus chunks: candidates from the HNSW index (`ORDER BY embedding <=> :q LIMIT n` on the
 * `venture_id IS NULL` partial index) ∪ lexical candidates, rescored with the hybrid formula. Persona
 * chunks are returned as kind `doctrine`, others as `chunk`. authority: persona 1.0, program 0.9,
 * public 0.7 (× 0.9 for a passage that is not a documented account; × 0.5 when the source is stale). Public
 * (reference-library) chunks come only through the relevance gate ({@link REFERENCE_GATE}), never from the ANN or
 * plain lexical candidates, and take up to `referenceLimit` rows beyond `limit`.
 */
export function searchSharedChunks(ex: SqlExecutor, q: SharedChunkQuery): Promise<RetrievedItem[]> {
  return run(ex, sharedSearch(q));
}

function sharedSearch(q: SharedChunkQuery): StoreSearch {
  const scopeFilter = `c.venture_id IS NULL AND c.tenant_id = :tenantId AND c.scope = ANY (:scopes)
    AND (c.scope <> 'persona' OR c.persona_id = :personaId)`;
  // A reference passage's words: its text and its source's title (an item's subject: "NONA Technologies…"), not
  // its heading, which names publishers ("Harvard Business School") rather than the subject.
  const referenceTsv = "to_tsvector('english', c.content) || to_tsvector('english', s.title)";
  const company = "split_part(split_part(s.title, ':', 1), ' ', 1)";
  const score = SCORE_SQL;
  return {
    sql: `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     , ann AS (
       SELECT c.id FROM knowledge_chunks c
       WHERE ${scopeFilter} AND c.scope <> 'public' AND :embedding IS NOT NULL
       ORDER BY c.embedding <=> :embedding
       LIMIT :candidates)
     , lexical AS (
       SELECT c.id FROM knowledge_chunks c CROSS JOIN q
       WHERE ${scopeFilter} AND c.scope <> 'public' AND c.tsv @@ q.tsq
       ORDER BY ts_rank_cd(c.tsv, q.tsq, 32) DESC, c.id
       LIMIT :candidates)
     , qwords AS (
       SELECT DISTINCT w FROM unnest(tsvector_to_array(to_tsvector('english', :query))) AS w
       WHERE w !~ '-' AND w !~ '^[0-9]+$' AND length(w) >= 3
         AND w <> ALL (tsvector_to_array(to_tsvector('english', :refRequestWords))))
     , program_asked AS (
       SELECT EXISTS (
         SELECT 1 FROM unnest(tsvector_to_array(to_tsvector('english', :query))) AS w
         WHERE w = ANY (tsvector_to_array(to_tsvector('english', :refProgramWords)))) AS yes)
     , ref AS (
       SELECT c.id, tsvector_to_array(${referenceTsv}) AS words,
              CASE WHEN starts_with(coalesce(s.uri, ''), :refCasePrefix)
                   THEN tsvector_to_array(to_tsvector('english', ${company})) ELSE '{}'::text[] END AS company_words,
              starts_with(coalesce(s.uri, ''), :refCasePrefix) AND length(${company}) >= 3
                AND position(' ' || ${company} || ' ' IN :refQueryWords) > 0 AS named,
              :embedding IS NULL OR c.embedding IS NULL OR 1 - (c.embedding <=> :embedding) >= :refMinVector
                AS near
       FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
       WHERE ${scopeFilter} AND c.scope = 'public' AND s.status IN ('active', 'stale')
         AND (:classifications IS NULL OR s.classification = ANY (:classifications)))
     , distinctive AS (
       SELECT qw.w FROM qwords qw JOIN ref ON qw.w = ANY (ref.words)
       GROUP BY qw.w
       HAVING count(*) <= greatest(:refMinDf, :refMaxShare * (SELECT count(*) FROM ref)))
     , reference AS (
       SELECT ref.id FROM ref
       LEFT JOIN distinctive d ON d.w = ANY (ref.words) AND (ref.named OR NOT (d.w = ANY (ref.company_words)))
       WHERE ref.near AND NOT (SELECT yes FROM program_asked)
       GROUP BY ref.id, ref.named
       HAVING (count(d.w) >= :refMinHits OR ref.named)
          AND count(d.w) >= :refMinCoverage * (SELECT count(*) FROM distinctive))
     , cand AS (SELECT id FROM ann UNION SELECT id FROM lexical UNION SELECT id FROM reference)
     SELECT z.* FROM (
       SELECT y.*, row_number() OVER (PARTITION BY y.source_scope = 'public' ORDER BY y.score DESC, y.id) AS scope_rank
       FROM (
         SELECT x.*, ${score} AS score,
                row_number() OVER (PARTITION BY x.source_id ORDER BY ${score} DESC, x.id) AS source_rank
         FROM (
           SELECT c.id, NULL::uuid AS venture_id, c.source_id, c.scope AS source_scope, NULL::text AS memory_type,
                  NULL::text AS visibility,
                  CASE WHEN c.scope = 'persona' THEN 'doctrine' ELSE 'chunk' END AS kind,
                  CASE WHEN c.heading IS NULL OR c.heading = '' THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
                  ${excerptSql('c.content')} AS excerpt, s.freshness_at, s.status,
                  ${vecSql('c.embedding')} AS vec,
                  ts_rank_cd(CASE WHEN c.scope = 'public' THEN ${referenceTsv} ELSE c.tsv END, q.tsq, 32) AS lex,
                  ${recencySql('s.freshness_at')} AS recency,
                  (CASE c.scope WHEN 'persona' THEN 1.0 WHEN 'program' THEN 0.9
                     ELSE 0.7 * (CASE WHEN starts_with(coalesce(c.heading, ''), :refDocumented) THEN 1.0 ELSE 0.9 END)
                   END)
                    * (CASE s.status WHEN 'active' THEN 1.0 ELSE 0.5 END) AS authority
           FROM cand
           JOIN knowledge_chunks c ON c.id = cand.id
           JOIN knowledge_sources s ON s.id = c.source_id
           CROSS JOIN q
           WHERE ${scopeFilter} AND s.status IN ('active', 'stale')
             AND (:classifications IS NULL OR s.classification = ANY (:classifications))
         ) x
         WHERE ${score} >= :minScore
       ) y
       WHERE y.source_scope <> 'public' OR y.source_rank = 1
     ) z
     WHERE z.scope_rank <= CASE WHEN z.source_scope = 'public' THEN :refLimit ELSE :limit END
     ORDER BY z.score DESC, z.id
     LIMIT :limit + :refLimit`,
    params: {
      ...baseParams(q, 4),
      scopes: p.textArray(q.scopes ?? ['program', 'public', 'persona']),
      personaId: p.nullable.uuid(q.personaId),
      classifications: p.nullable.textArray(q.classifications),
      candidates: p.int(clampLimit(q.candidates, 40, 400)),
      refRequestWords: p.text(REFERENCE_REQUEST_WORDS),
      refProgramWords: p.text(REFERENCE_PROGRAM_WORDS),
      refCasePrefix: p.text(REFERENCE_CASE_URI_PREFIX),
      refDocumented: p.text(DOCUMENTED_ACCOUNT_HEADING),
      // The query's words, space-separated with a space at each end, case kept (company names).
      refQueryWords: p.text(` ${q.query.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `),
      refMinHits: p.int(REFERENCE_GATE.minHits),
      refMinCoverage: p.num(REFERENCE_GATE.minCoverage),
      refMaxShare: p.num(REFERENCE_GATE.maxShare),
      refMinDf: p.int(REFERENCE_GATE.minDf),
      refMinVector: p.num(REFERENCE_GATE.minVector),
      refLimit: p.int(Math.max(0, Math.min(q.referenceLimit ?? REFERENCE_GATE.limit, 10))),
    },
    decode: (r) => decodeItem('from_row', r),
  };
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
  return run(ex, resourceSearch(q));
}

function resourceSearch(q: ResourceQuery): StoreSearch {
  const score = '(0.55 * x.lex + 0.25 * x.stage_fit + 0.10 * x.recency + 0.10 * x.authority)';
  return {
    sql: `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${score} AS score FROM (
       SELECT r.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS source_scope,
              NULL::text AS memory_type, NULL::text AS visibility, r.name AS title,
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
    params: { ...baseParams({ ...q, embedding: null }, 4), stage: p.nullable.text(q.stage) },
    decode: (r) => decodeItem('resource', r),
  };
}

export interface PatternQuery extends Omit<BaseQuery, 'embedding'> {
  /**
   * The assigned persona: its published lessons are candidates alongside program-wide ones. Absent or null:
   * program-wide lessons only (another persona's lessons are never retrieved).
   */
  readonly personaId?: string | null;
}

/**
 * Published, unexpired lessons (lexical over title/context/signal/intervention): program-wide ones and those
 * of the assigned persona.
 */
export function searchPatterns(ex: SqlExecutor, q: PatternQuery): Promise<RetrievedItem[]> {
  return run(ex, patternSearch(q));
}

function patternSearch(q: PatternQuery): StoreSearch {
  return {
    sql: `WITH q AS (SELECT ${orTsQuerySql('query')} AS tsq)
     SELECT x.*, ${SCORE_SQL} AS score FROM (
       SELECT pt.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS source_scope,
              NULL::text AS memory_type, NULL::text AS visibility, pt.title,
              ${excerptSql("pt.signal || ' → ' || pt.intervention || ' (limits: ' || pt.limits || ')'")} AS excerpt,
              pt.created_at AS freshness_at, pt.status,
              0::double precision AS vec,
              ts_rank_cd(to_tsvector('english', pt.title || ' ' || pt.context || ' ' || pt.signal || ' ' || pt.intervention),
                         q.tsq, 32) AS lex,
              ${recencySql('pt.created_at')} AS recency,
              1.0 AS authority
       FROM patterns pt CROSS JOIN q
       WHERE pt.tenant_id = :tenantId AND pt.status = 'published'
         AND (pt.persona_id IS NULL OR pt.persona_id = :personaId)
         AND (pt.expires_at IS NULL OR pt.expires_at > now())
         AND to_tsvector('english', pt.title || ' ' || pt.context || ' ' || pt.signal || ' ' || pt.intervention) @@ q.tsq
     ) x
     WHERE ${SCORE_SQL} >= :minScore
     ORDER BY score DESC, x.id
     LIMIT :limit`,
    params: { ...baseParams({ ...q, embedding: null }, 2), personaId: p.nullable.uuid(q.personaId) },
    decode: (r) => decodeItem('pattern', r),
  };
}

// ------------------------------------------------------------------------------------------------
// Every store in one statement
// ------------------------------------------------------------------------------------------------

/** The stores a turn searches; an absent store is not searched (and comes back empty). */
export interface EvidenceSearch {
  readonly memory?: VentureMemoryQuery;
  readonly chunks?: VentureChunkQuery;
  readonly shared?: SharedChunkQuery;
  readonly resources?: ResourceQuery;
  readonly patterns?: PatternQuery;
}

export type EvidenceResults = Readonly<Record<keyof EvidenceSearch, RetrievedItem[]>>;

const STORES = ['memory', 'chunks', 'shared', 'resources', 'patterns'] as const;

/**
 * Every store's search in ONE statement, each with exactly its own SQL, parameters, ordering and limit, so
 * the results equal those of the five functions above: on the RDS Data API every statement is an HTTPS round
 * trip, and a turn searches up to five stores (docs/runbooks/latency.md). Each store's rows come back as
 * JSON with their rank within the store.
 */
export async function searchEvidenceStores(
  ex: SqlExecutor,
  search: EvidenceSearch,
): Promise<EvidenceResults> {
  const builders: Record<(typeof STORES)[number], () => StoreSearch | null> = {
    memory: () => (search.memory ? memorySearch(search.memory) : null),
    chunks: () => (search.chunks ? chunkSearch(search.chunks) : null),
    shared: () => (search.shared ? sharedSearch(search.shared) : null),
    resources: () => (search.resources ? resourceSearch(search.resources) : null),
    patterns: () => (search.patterns ? patternSearch(search.patterns) : null),
  };
  const parts: string[] = [];
  const params: Record<string, SqlParam> = {};
  const decoders = new Map<string, StoreSearch['decode']>();
  STORES.forEach((store, i) => {
    const built = builders[store]();
    if (built === null) return;
    const prefix = `s${String(i)}_`;
    // Each store's placeholders get the store's prefix, so equal names (`:limit`, `:query`) stay apart.
    const sql = rewritePlaceholders(built.sql, (name) => `:${prefix}${name}`).text;
    for (const [name, param] of Object.entries(built.params)) params[`${prefix}${name}`] = param;
    decoders.set(store, built.decode);
    parts.push(
      `(SELECT '${store}'::text AS store, row_number() OVER (ORDER BY r.score DESC, r.id) AS rank,
               to_jsonb(r) AS row
        FROM (${sql}) r)`,
    );
  });
  const results: Record<(typeof STORES)[number], RetrievedItem[]> = {
    memory: [],
    chunks: [],
    shared: [],
    resources: [],
    patterns: [],
  };
  if (parts.length === 0) return results;
  const rows = await queryRows(
    ex,
    `SELECT u.store, u.rank, u.row FROM (${parts.join('\n UNION ALL\n')}) u ORDER BY u.store, u.rank`,
    params,
    (r) => ({
      store: col.enum(STORES).decode(r.store, 'store'),
      row: col.json().decode(r.row, 'row') as RawRow,
    }),
  );
  for (const { store, row } of rows) {
    const decode = decoders.get(store);
    if (decode) results[store].push(decode(row));
  }
  return results;
}
