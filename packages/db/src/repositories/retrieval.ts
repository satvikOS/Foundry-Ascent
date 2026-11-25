/**
 * Hybrid retrieval (vector + full text) for the evidence pack: rank fusion with a relevance floor.
 *
 *   rrf   = w_v / (k + rank_v) + w_l / (k + rank_l), scaled so the best possible row scores 1 (Reciprocal Rank Fusion)
 *           w_v 3, w_l 0.25 (words break near ties); w_l 1.5 for a row whose title says a named thing the message names
 *           ("patent", "LLC")
 *   score = 0.80 · rrf + 0.12 · authority + 0.08 · recency        ({@link RETRIEVAL_FUSION})
 *
 * - **Lexical** relevance is coverage: the message's content words (`knowledge-pack/query-terms.ts`: generic words left
 *   out, "VC" and "venture capital" one word), each weighted by how rare it is in the store (idf). A long message is
 *   measured against its six rarest words, so a passage need not repeat a whole story to be about it. Headings count
 *   extra in the shared corpora, and `ts_rank_cd` breaks ties.
 * - **Floor** ({@link RETRIEVAL_FLOORS}): a row nothing in the message points at is not returned, however few rows the
 *   store has. "No evidence" is a valid result. The vector floor is the embedding model's own ({@link
 *   EMBEDDING_PROFILES}): cosine similarities of two models are not comparable. Pinned memory is always a candidate.
 * - **Semantic admission** ({@link SEMANTIC_ADMISSION}): shared notes near the founder's own words come beside what the
 *   gates bring, as candidates (`lane` `semantic`) that {@link admitSemantic} chooses from.
 * - **Diversity**: near-identical passages are returned once, and one source gives at most {@link PER_SOURCE_LIMIT}.
 * - recency = 0.5 ^ (age_days / half_life_days) (default half-life 90 days); authority is store-specific (memory:
 *   status, confidence, pin; chunks: source status). Both only order rows of about the same rank.
 * - A row without a comparable vector (none yet, or another model's) takes its lexical rank, at a discount, for both; a query without
 *   an embedding is lexical only.
 *
 * Venture-scoped stores (venture chunks, memory) always filter `tenant_id` and `venture_id` FIRST and scan
 * exactly within the venture — there is no unscoped vector search. Shared corpora (program/public/persona,
 * `venture_id IS NULL`) take ANN candidates from the partial HNSW index plus lexical candidates, then
 * fuse. Under `db.withContext` RLS additionally applies (memory visibility, venture membership).
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
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor } from '../executor.js';
import { p, type SqlParam, type SqlParams } from '../params.js';
import { rewritePlaceholders } from '../sql-lexer.js';
import { alternateOf, embeddingModelOf } from '../embedding-model.js';
import { clampLimit, excerptSql, queryRows } from './common.js';
import {
  corpusUrisForMessage,
  corpusUrisForTopics,
  LIBRARY_URI_PREFIX,
  pinnedNote,
  PROGRAMME_NOTES_URI_PREFIX,
  type CitingPlay,
} from '../knowledge-pack/corpus.js';
import {
  CONTEXT_GAP_TURNS,
  selectContextualReference,
  selectReferences,
  type ConversationContext,
} from '../knowledge-pack/gate.js';
import { notAnAskSql, PLAY_ASK_LOCATOR, PLAY_ASKS_URI } from '../knowledge-pack/play-asks.js';
import { namedTermGroups, queryTermGroups, subjectTermGroups } from '../knowledge-pack/query-terms.js';
import { DOCUMENTED_ACCOUNT_HEADING, PACK_URI_PREFIX } from '../knowledge-pack/render.js';
import { isCorpusTopic, seeksHelp, type CorpusTopic } from '../knowledge-pack/topics.js';
import { type KnowledgeClassification } from './knowledge.js';
import { ACTIVE_MEMORY_STATUSES, type MemoryStatusValue, type MemoryTypeValue } from './memory.js';

/**
 * Rank fusion: RRF's k and list weights, and how much order authority and recency may change. Every constant of the
 * ranking is here, in {@link RETRIEVAL_FLOORS} and in {@link EMBEDDING_PROFILES}, and nowhere else (docs/runbooks/
 * embedding-model.md, "How retrieval is tuned").
 *
 * The weights come from real embeddings (models benchmark, 2026-11-24, Titan Text V2 at 1024): the vector alone found the
 * answer first for 50 % of paraphrased questions; fused with a word ranking of equal weight, for 31 %. So the vector
 * leads (3), words break near ties (0.25: enough to swap neighbours, not to carry a passage the vector ranks low), and
 * count for more only where the message names a thing by name and the row's title says it (`namedTermGroups`).
 */
export const RETRIEVAL_FUSION = {
  k: 12,
  vector: 3,
  lexical: 0.25,
  /** The word ranking's weight for a row whose title or heading holds a named term of the message. */
  rescue: 1.5,
  rrf: 0.8,
  authority: 0.12,
  recency: 0.08,
  /** A row without a comparable vector takes this share of the vector part at its lexical rank. */
  unembedded: 0.6,
  /** A long message is measured against this many of its rarest words. */
  capTerms: 6,
  /** Rarity is estimated as if a store had at least this many rows (a new venture has a handful). */
  minRows: 60,
} as const;

/**
 * A row is returned only when it passes one of: its vector is close (the model's `floor`, and not far below the
 * closest row); its words cover enough of the message's (`coverage`); it shares three or more of a long message's
 * words (`manyCoverage`); or both are moderate (`weak` vector and `weakCoverage`). The founder's own record and
 * documents are all about their venture, so their vector floor is lower (`ownFactor`).
 */
export const RETRIEVAL_FLOORS = {
  coverage: 0.5,
  manyTerms: 3,
  manyCoverage: 0.3,
  weakCoverage: 0.25,
  relative: 0.6,
  ownFactor: 0.65,
  /** One rare word of the message is enough for the founder's own record, not for a document. */
  memoryCoverage: 0.12,
  ownCoverage: 0.22,
  /**
   * A programme resource or a lesson is offered to a founder, not their own: it has to cover this much of what the
   * message is about (`subjectTermGroups`: "campus", "venture" and "app" say nothing about that) and its title or tags
   * have to hold a word of it. Words alone: there is no vector.
   */
  offerCoverage: 0.4,
  /** A passage of a source the message's topic admitted only has to touch the message. */
  topicCoverage: 0.12,
  /**
   * A corpus note whose topic the message does not name, when the message asks for something: its vector is at the
   * model's floor and near the closest, or it covers most of the message with three words or more.
   */
  openRelative: 0.8,
  openCoverage: 0.6,
  openTerms: 3,
} as const;

/**
 * Semantic admission of shared notes (the programme's notes and curriculum, the cited library, the reference library) to
 * a coaching turn that asks something, in whatever words ({@link admitSemantic}): beside what the gates bring, never
 * instead of it. The similarity is of the founder's OWN words, never of what the retrieval query adds to them (the
 * vEIR's last question, the venture goal), and its floor is the embedding model's (`EmbeddingProfile.admit`).
 *
 * The gates alone (topics, vocabulary, strong word coverage) showed the answer for 15 to 24 % of paraphrased questions,
 * and none of 63 the reference library answers, while the whole corpus held it for 67 % (models benchmark, 2026-11-24).
 * These are starting values, strict on purpose; the benchmark's "admission" rows measure others in one run.
 */
export const SEMANTIC_ADMISSION = {
  /** Added to the floor for a message that only may ask (a statement, a few words). */
  guard: 0.06,
  /** A note must be this close to the closest one. */
  relative: 0.85,
  /** Most notes it adds to a typed turn, and to a call's. */
  limit: 2,
  voiceLimit: 1,
  /** It adds none past this many notes in all (the gates' and the play's counted), on a typed turn and on a call. */
  room: 4,
  voiceRoom: 3,
  /** Most reference-library notes it may leave a turn with, the gate's counted. */
  references: 1,
  /** Notes read when a reranker chooses among them, and the score from which one is admitted then. */
  rerankCandidates: 8,
  rerankScore: 0.5,
} as const;

type Weights<T> = { readonly [K in keyof T]: number };

/**
 * Other constants for one search: only to measure them (the models benchmark). Nothing that answers a founder passes
 * one; its numbers are the code's own, never a request's.
 */
export interface RetrievalTuning {
  readonly fusion?: Partial<Weights<typeof RETRIEVAL_FUSION>>;
  readonly floors?: Partial<Weights<typeof RETRIEVAL_FLOORS>>;
  readonly profile?: EmbeddingProfile;
  /** Semantic admission's, `floor` instead of the model's `admit`. */
  readonly semantic?: Partial<Weights<typeof SEMANTIC_ADMISSION>> & { readonly floor?: number };
}

export interface EmbeddingProfile {
  /** Cosine similarity from which a passage is about the query by its vector alone. */
  readonly floor: number;
  /** From which it is, together with shared words. */
  readonly weak: number;
  /** From which a shared note no gate brings is admitted ({@link SEMANTIC_ADMISSION}); absent: none is. */
  readonly admit?: number;
}

/**
 * Cosine floors by embedding model (a similarity of 0.3 means different things to two models). A model without a
 * profile gets the default, which is strict. Cohere's are starting values until the models benchmark has measured them in
 * production's search ("How retrieval is tuned", docs/runbooks/embedding-model.md).
 */
export const EMBEDDING_PROFILES: Readonly<Record<string, EmbeddingProfile>> = {
  // Models benchmark, 2026-11-24 (272 questions with an answer, 82 without): the answer among the first three for 67 % of
  // them, 50 % with the starting floors (0.3, 0.2); nothing shown for 66 % of those without one (72 %).
  'amazon.titan-embed-text-v2:0': { floor: 0.22, weak: 0.16, admit: 0.25 },
  'cohere.embed-v4:0': { floor: 0.4, weak: 0.28, admit: 0.44 },
  // Its similarity does not tell a question with an answer from one without (no-answer AUC 0.26, 2026-11-24): the vector
  // orders, and never admits.
  'amazon.nova-2-multimodal-embeddings-v1:0': { floor: 1.01, weak: 1.01 },
  // The deterministic hash embedding of tests and local development: only shared words make texts similar.
  // Function words weigh as much as any in it, so its similarity alone admits nothing (and no note: `admit` is absent).
  'mock-embeddings': { floor: 0.6, weak: 0.4 },
};
export const DEFAULT_EMBEDDING_PROFILE: EmbeddingProfile = { floor: 0.35, weak: 0.24 };

/** The floors of `modelId`; a cross-Region inference profile (`us.…`) has its model's. */
export function embeddingProfile(modelId: string | null | undefined): EmbeddingProfile {
  const id = (modelId ?? '').replace(/^(?:us|eu|apac|global)\./, '');
  return Object.hasOwn(EMBEDDING_PROFILES, id)
    ? (EMBEDDING_PROFILES[id] ?? DEFAULT_EMBEDDING_PROFILE)
    : DEFAULT_EMBEDDING_PROFILE;
}

/**
 * Floors for a model from labelled cosine similarities: `related`, of each question with the passage that answers it;
 * `unrelated`, of each question nothing answers with its closest passage. `floor` lets at most 1 % of the unrelated
 * questions find something, `weak` at most 10 %, and neither goes above what 90 % (75 % for `floor`) of related pairs
 * reach: words bring back what the vector alone does not.
 */
export function suggestEmbeddingProfile(
  related: readonly number[],
  unrelated: readonly number[],
): EmbeddingProfile {
  const at = (values: readonly number[], q: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] ?? 0;
  };
  if (related.length === 0 || unrelated.length === 0) return DEFAULT_EMBEDDING_PROFILE;
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    floor: round(Math.min(at(unrelated, 0.99), at(related, 0.25))),
    weak: round(Math.min(at(unrelated, 0.9), at(related, 0.1))),
  };
}

/** Characters of a row's text a search returns: a whole ingested chunk, so the part that matches is in it. */
export const PASSAGE_CHARS = 3_200;
/** Most passages one source gives a store's result. */
export const PER_SOURCE_LIMIT = 2;
export const DEFAULT_HALF_LIFE_DAYS = 90;

type EvidenceKindValue = z.infer<typeof EvidenceKind>;
type EvidenceSourceScopeValue = z.infer<typeof EvidenceSourceScope>;

export const SHARED_LANES = ['core', 'reference', 'corpus', 'pinned', 'semantic'] as const;
export type SharedLane = (typeof SHARED_LANES)[number];

/** Where a passage comes from, as its source records it. */
export interface PassageCitation {
  /** Section, chapter, or module, unit and timestamp. */
  readonly locator: string | null;
  readonly url: string | null;
  readonly licence: string | null;
  readonly attribution: string | null;
}

/** Kinds of shared notes semantic admission reads. */
export const NOTE_FAMILIES = ['note', 'reference', 'curriculum'] as const;
export type NoteFamily = (typeof NOTE_FAMILIES)[number];

/** How near a shared note is to the founder's own words. */
export interface NearNote {
  readonly similarity: number;
  /** A course or library note, an item of the reference library, or a passage about the course itself. */
  readonly family: NoteFamily;
  /** A passage of its source is already evidence in this conversation. */
  readonly shownBefore: boolean;
}

/** A scored candidate; core assigns evidence keys (E1…En) and builds `EvidenceItem`s from these. */
export interface RetrievedItem {
  readonly kind: EvidenceKindValue;
  /** Id of the memory item / chunk / resource / pattern. */
  readonly refId: string;
  readonly title: string;
  /** The item's text, at most {@link PASSAGE_CHARS}; what a turn shows of it is its caller's (`excerptWindow` in core). */
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
  /** Where a passage can be checked (migration 0034); absent or null: not a passage, or its source records nothing. */
  readonly citation?: PassageCitation | null;
  /**
   * Why a shared passage is here: relevance, the reference gate, the message's topic, the play's citation, or its nearness
   * to the founder's own words alone (`semantic`: a candidate, shown only when {@link admitSemantic} admits it).
   */
  readonly lane?: SharedLane;
  /** A shared note near the founder's own words (with {@link SharedChunkQuery.semantic}), whatever its lane. */
  readonly near?: NearNote;
  readonly components: {
    /** Cosine similarity (0 without a comparable vector). */
    readonly vector: number;
    /** Share of the message's content words the row covers, weighted by rarity (0–1; a heading match may exceed it). */
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
  /**
   * The model that made `embedding` (default: the one it is tagged with, `embedding-model.ts`): rows whose vector
   * another model made are not compared with it. None known: every vector is compared.
   */
  readonly embeddingModel?: string | null;
  /** The same query embedded by the model being replaced, while rows still carry its vectors. */
  readonly alternate?: { readonly embedding: readonly number[]; readonly modelId: string } | null;
  readonly limit?: number;
  readonly halfLifeDays?: number;
  /** Drop candidates scoring below this (default 0). */
  readonly minScore?: number;
  /** Other ranking constants, for measurement only ({@link RetrievalTuning}). */
  readonly tuning?: RetrievalTuning;
}

/** The query with the model and the alternate its vector is tagged with. */
function withModel<Q extends BaseQuery>(q: Q): Q {
  const embeddingModel = q.embeddingModel ?? embeddingModelOf(q.embedding);
  return {
    ...q,
    embeddingModel,
    alternate: embeddingModel === null ? null : (q.alternate ?? alternateOf(q.embedding)),
  };
}

/** Cosine similarity of `column` with the query embedded by the row's own model; NULL when they cannot be compared. */
function vecSql(
  column: string,
  modelColumn: string,
  q: Pick<BaseQuery, 'embeddingModel' | 'alternate'>,
  /** The parameter of each part, when the query has another vector besides its own. */
  name: (part: string) => string = (part) => part,
): string {
  const embedding = `:${name('embedding')}`;
  const primary = `1 - (${column} <=> ${embedding})`;
  if (q.embeddingModel == null) {
    return `CASE WHEN ${column} IS NULL OR ${embedding} IS NULL THEN NULL ELSE ${primary} END`;
  }
  const alternate =
    q.alternate == null
      ? ''
      : `WHEN ${modelColumn} = :${name('alternateModel')} THEN 1 - (${column} <=> :${name('alternateEmbedding')})`;
  return `CASE WHEN ${column} IS NULL OR ${embedding} IS NULL THEN NULL
               WHEN ${modelColumn} IS NULL OR ${modelColumn} = :${name('embeddingModel')} THEN ${primary}
               ${alternate} ELSE NULL END`;
}

function recencySql(column: string): string {
  return `power(0.5, greatest(0, extract(epoch FROM now() - ${column})) / (86400.0 * :halfLife))`;
}

type StoreKind = 'memory' | 'own' | 'offer' | 'shared';

function baseParams(q: BaseQuery, defaultLimit: number, kind: StoreKind): Record<string, SqlParam> {
  const profile = q.tuning?.profile ?? embeddingProfile(q.embeddingModel);
  const { L } = constants(q);
  const factor = kind === 'shared' ? 1 : L.ownFactor;
  return {
    tenantId: p.uuid(q.tenantId),
    terms: p.textArray(kind === 'offer' ? subjectTermGroups(q.query) : queryTermGroups(q.query)),
    named: p.textArray(namedTermGroups(q.query)),
    subjects: p.textArray(subjectTermGroups(q.query)),
    embedding: p.nullable.vector(q.embedding),
    halfLife: p.num(q.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS),
    minScore: p.num(q.minScore ?? 0),
    limit: p.int(clampLimit(q.limit, defaultLimit, 50)),
    vecFloor: p.num(profile.floor * factor),
    vecWeak: p.num(profile.weak * factor),
    coverage: p.num(
      {
        memory: L.memoryCoverage,
        own: L.ownCoverage,
        offer: L.offerCoverage,
        shared: L.coverage,
      }[kind],
    ),
    ...(q.embeddingModel == null ? {} : { embeddingModel: p.text(q.embeddingModel) }),
    ...(q.embeddingModel == null || q.alternate == null
      ? {}
      : {
          alternateModel: p.text(q.alternate.modelId),
          alternateEmbedding: p.vector(q.alternate.embedding),
        }),
  };
}

interface Constants {
  readonly F: Weights<typeof RETRIEVAL_FUSION>;
  readonly L: Weights<typeof RETRIEVAL_FLOORS>;
}

/** The constants of one search: the code's, with what a measurement changes. They go into the SQL as numbers. */
function constants(q: { readonly tuning?: RetrievalTuning }): Constants {
  const F = { ...RETRIEVAL_FUSION, ...q.tuning?.fusion };
  const L = { ...RETRIEVAL_FLOORS, ...q.tuning?.floors };
  for (const value of [...Object.values(F), ...Object.values(L)]) {
    if (!Number.isFinite(value)) throw new SqlUsageError('a retrieval constant must be a finite number');
  }
  return { F, L };
}

/**
 * The message's content words as tsqueries (one per distinct lexeme set; `named`: the word names one thing) and all of
 * them together.
 */
const TERMS_CTE = `terms AS MATERIALIZED (
       SELECT DISTINCT ON (w.tsq::text) w.ord, w.tsq, w.named, w.subject
       FROM (SELECT t.ord, websearch_to_tsquery('english', t.text) AS tsq, t.text = ANY (:named) AS named,
                    t.text = ANY (:subjects) AS subject
             FROM unnest(:terms) WITH ORDINALITY AS t (text, ord)) w
       WHERE numnode(w.tsq) > 0
       ORDER BY w.tsq::text, w.named DESC, w.subject DESC, w.ord)
     , q AS (SELECT coalesce(string_agg('(' || tsq::text || ')', ' | '), '')::tsquery AS tsq,
                    count(*) AS words, coalesce(bool_or(named), false) AS named FROM terms)`;

/** Rarity of each word in the store (`hits`: rows × words; `rows`: how many rows there are) and each row's coverage. */
const lexicalCtes = ({ F }: Constants): string => `store_size AS MATERIALIZED (
       SELECT greatest(count(*), ${F.minRows})::double precision AS n FROM store_rows)
     , found AS MATERIALIZED (SELECT ord, count(*) AS n FROM hits GROUP BY ord)
     , idf AS MATERIALIZED (
       SELECT t.ord, ln(1 + (s.n - coalesce(f.n, 0) + 0.5) / (coalesce(f.n, 0) + 0.5)) AS idf
       FROM terms t CROSS JOIN store_size s LEFT JOIN found f ON f.ord = t.ord)
     , total AS MATERIALIZED (
       SELECT sum(idf) AS total FROM (SELECT idf FROM idf ORDER BY idf DESC LIMIT ${F.capTerms}) z)
     , coverage AS MATERIALIZED (
       SELECT h.id, least(1, sum(i.idf) / max(t.total)) AS cov, count(*) AS words,
              count(*) FILTER (WHERE m.subject) AS subjects
       FROM hits h JOIN idf i ON i.ord = h.ord JOIN terms m ON m.ord = h.ord CROSS JOIN total t
       GROUP BY h.id)`;

/**
 * Whether a scored row (`vec`, `cov`, `matched`, `subjects`, `top_vec`) is about the message ({@link RETRIEVAL_FLOORS}).
 * Outside the founder's own record words admit only when one of them says what the message is about: "Tell me my idea is
 * great" has one word, "idea", and every passage that says it covered all of it.
 */
const floorSql = ({ L }: Constants, kind: StoreKind): string =>
  `(coalesce(s.vec >= :vecFloor AND s.vec >= ${L.relative} * s.top_vec, false)
       OR ((${kind === 'memory' ? 'true' : `s.subjects > 0 OR s.matched >= ${L.manyTerms}`}) AND
           (s.cov >= :coverage
            OR (s.matched >= ${L.manyTerms} AND s.cov >= ${L.manyCoverage})
            OR coalesce(s.vec >= :vecWeak AND s.cov >= ${L.weakCoverage}, false))))`;

/** A ranked row's fused score (columns `lex_rank`, `vec_rank`, `rescued`, `recency`, `authority`). */
const fusedSql = ({ F }: Constants): string => {
  // Without a query vector the words are the whole ranking: their weight is 1, as it always was.
  const weight = (value: number): string =>
    `(CASE WHEN :embedding IS NULL THEN ${Math.max(value, 1)} ELSE ${value} END)`;
  const plain = weight(F.lexical);
  const named = weight(Math.max(F.rescue, F.lexical));
  const words = `CASE WHEN r.rescued THEN ${named} ELSE ${plain} END::double precision`;
  const most = `CASE WHEN q.named THEN ${named} ELSE ${plain} END`;
  return `(${F.rrf} * (${F.k} + 1) * (
         (CASE WHEN q.words > 0 AND r.lex_rank IS NOT NULL THEN ${words} / (${F.k} + r.lex_rank) ELSE 0 END
          + CASE WHEN :embedding IS NULL THEN 0
                 WHEN r.vec_rank IS NOT NULL THEN ${F.vector}::double precision / (${F.k} + r.vec_rank)
                 WHEN r.lex_rank IS NOT NULL THEN ${F.vector * F.unembedded}::double precision / (${F.k} + r.lex_rank) ELSE 0 END)
         / greatest(CASE WHEN q.words > 0 THEN ${most} ELSE 0 END
                    + CASE WHEN :embedding IS NULL THEN 0 ELSE ${F.vector} END, 0.000001))
       + ${F.authority} * r.authority + ${F.recency} * r.recency)`;
};

const RANKS_SQL = `CASE WHEN k.lex > 0 THEN rank() OVER (ORDER BY k.lex DESC) END AS lex_rank,
              CASE WHEN k.vec IS NOT NULL THEN rank() OVER (ORDER BY k.vec DESC NULLS LAST) END AS vec_rank`;

const STORE_COLUMNS = (
  'id venture_id source_id source_scope memory_type visibility title excerpt freshness_at status vec recency ' +
  'authority always dedupe'
).split(' ');

/**
 * A store scanned exactly: `rows` selects its scoped rows with the output columns plus `tsv`, `vec`, `always` (kept
 * whatever the floor says) and `dedupe` (equal values are one passage; the best is kept).
 */
function exactStore(
  kind: StoreKind,
  q: { readonly tuning?: RetrievalTuning },
  rows: string,
  options: {
    readonly overview?: boolean;
    readonly perSource?: boolean;
    /** Only rows whose `subject` text (title, tags) holds a word of the message. */
    readonly onSubject?: boolean;
    /** Output columns of this store alone. */
    readonly extra?: readonly string[];
  } = {},
): string {
  // A message with no subject of its own ("what should I do next?") asks for the record itself.
  const overview = options.overview === true ? 'OR q.words = 0' : '';
  const onSubject =
    options.onSubject === true
      ? `AND EXISTS (SELECT 1 FROM terms t WHERE to_tsvector('english', s.subject) @@ t.tsq)`
      : '';
  const c = constants(q);
  // Named, so the text search vectors stay in the database.
  const columns = [
    ...STORE_COLUMNS,
    ...(options.onSubject === true ? ['subject'] : []),
    ...(options.extra ?? []),
  ]
    .map((c) => `d.${c}`)
    .join(', ');
  return `WITH ${TERMS_CTE}
     , store_rows AS MATERIALIZED (${rows})
     , hits AS MATERIALIZED (SELECT d.id, t.ord FROM store_rows d JOIN terms t ON d.tsv @@ t.tsq)
     , ${lexicalCtes(c)}
     , scored AS (
       SELECT ${columns}, q.named AND EXISTS (
                SELECT 1 FROM terms t WHERE t.named AND to_tsvector('english', d.title) @@ t.tsq) AS rescued,
              coalesce(c.cov, 0) AS cov, coalesce(c.words, 0) AS matched,
              coalesce(c.subjects, 0) AS subjects, max(d.vec) OVER () AS top_vec,
              CASE WHEN c.cov IS NULL THEN 0 ELSE c.cov + 0.15 * ts_rank_cd(d.tsv, q.tsq, 32) END AS lex
       FROM store_rows d CROSS JOIN q LEFT JOIN coverage c ON c.id = d.id)
     , ranked AS (
       SELECT k.*, ${RANKS_SQL}
       FROM (SELECT s.* FROM scored s CROSS JOIN q WHERE s.always ${overview} OR (${floorSql(c, kind)} ${onSubject})) k)
     , fused AS (
       SELECT r.*, ${fusedSql(c)} AS score FROM ranked r CROSS JOIN q)
     , one AS (
       SELECT f.*, row_number() OVER (PARTITION BY f.dedupe ORDER BY f.score DESC, f.id) AS copy,
              row_number() OVER (PARTITION BY coalesce(f.source_id, f.id) ORDER BY f.score DESC, f.id) AS of_source
       FROM fused f)
     SELECT o.*, coalesce(greatest(o.vec, 0), 0) AS vec_shown
     FROM one o
     WHERE o.copy = 1 ${options.perSource === true ? `AND o.of_source <= ${PER_SOURCE_LIMIT + 1}` : ''}
       AND o.score >= :minScore
     ORDER BY o.score DESC, o.id
     LIMIT :limit`;
}

/** Equal text (case and spacing aside) is one passage. */
function dedupeSql(column: string): string {
  return `md5(lower(regexp_replace(${column}, '\\s+', ' ', 'g')))`;
}

function decodeItem(kind: EvidenceKindValue | 'from_row', r: RawRow): RetrievedItem {
  const resolvedKind = kind === 'from_row' ? col.enum(EvidenceKind.options).decode(r.kind, 'kind') : kind;
  const stageFit = r.stage_fit === undefined ? undefined : col.num.decode(r.stage_fit, 'stage_fit');
  const text = (value: unknown, name: string): string | null =>
    value === undefined ? null : col.text.nullable.decode(value, name);
  const citation: PassageCitation = {
    locator: text(r.locator, 'locator'),
    url: text(r.url, 'url'),
    licence: text(r.licence, 'licence'),
    attribution: text(r.attribution, 'attribution'),
  };
  return {
    kind: resolvedKind,
    refId: col.uuid.decode(r.id, 'id'),
    title: col.text.decode(r.title, 'title'),
    excerpt: col.text.decode(r.excerpt, 'excerpt'),
    // A topic or stage preference may take a first-ranked note a little past 1 in the store's own order.
    score: Math.min(1, col.num.decode(r.score, 'score')),
    freshnessAt: col.ts.nullable.decode(r.freshness_at, 'freshness_at'),
    status: col.text.nullable.decode(r.status, 'status'),
    ventureId: col.uuid.nullable.decode(r.venture_id, 'venture_id'),
    sourceId: col.uuid.nullable.decode(r.source_id, 'source_id'),
    sourceScope: col.enum(EvidenceSourceScope.options).nullable.decode(r.source_scope, 'source_scope'),
    memoryType: col.enum(MemoryType.options).nullable.decode(r.memory_type, 'memory_type'),
    visibility: col.enum(Visibility.options).nullable.decode(r.visibility, 'visibility'),
    ...(r.lane === undefined ? {} : { lane: col.enum(SHARED_LANES).decode(r.lane, 'lane') }),
    ...(r.near_family === undefined || r.near_family === null
      ? {}
      : {
          near: {
            similarity: col.num.decode(r.near_similarity, 'near_similarity'),
            family: col.enum(NOTE_FAMILIES).decode(r.near_family, 'near_family'),
            shownBefore: col.bool.decode(r.near_shown, 'near_shown'),
          },
        }),
    citation: citation.locator === null && citation.url === null ? null : citation,
    components: {
      vector: col.num.decode(r.vec_shown, 'vec_shown'),
      lexical: col.num.decode(r.cov, 'cov'),
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
 * never a candidate) × (0.5 + 0.5 · confidence). Pinned items are always candidates. A message with no subject of its
 * own ("what should I do next?") asks for the record itself: every item is a candidate then, best first.
 */
export function searchVentureMemory(ex: SqlExecutor, q: VentureMemoryQuery): Promise<RetrievedItem[]> {
  return run(ex, memorySearch(q));
}

/** A milestone still ahead reads as a goal: "Two paid pilots signed", due next month, was told back as done. */
const MEMORY_TITLE_SQL = `CASE WHEN m.type = 'milestone' AND (m.attributes ->> 'completed_on') IS NULL
                        AND ((m.attributes ->> 'target_date') IS NOT NULL OR (m.attributes ->> 'status') IS NOT NULL)
                        AND coalesce(m.attributes ->> 'status', '') NOT IN ('done', 'completed', 'reached', 'met')
                   THEN 'Goal, not reached yet: ' || m.title ELSE m.title END AS title`;

/** What an item says: an experiment's result is kept beside its words, and is as much of it as they are. */
const MEMORY_WORDS_SQL = `CASE WHEN m.type = 'experiment' AND coalesce(m.attributes ->> 'result', '') <> ''
                         AND position('result:' IN lower(m.content)) = 0
                         AND position(m.attributes ->> 'result' IN m.content) = 0
                    THEN m.content || ' Result: ' || (m.attributes ->> 'result') ELSE m.content END`;

function memorySearch(query: VentureMemoryQuery): StoreSearch {
  const q = withModel(query);
  const statuses = (q.statuses ?? ACTIVE_MEMORY_STATUSES).filter((s) => MemoryStatus.options.includes(s));
  return {
    sql: exactStore(
      'memory',
      q,
      `SELECT m.id, m.venture_id, NULL::uuid AS source_id, NULL::text AS source_scope, m.type AS memory_type,
              m.visibility,
              ${MEMORY_TITLE_SQL},
              ${excerptSql(MEMORY_WORDS_SQL, PASSAGE_CHARS)} AS excerpt, m.updated_at AS freshness_at, m.status, m.tsv,
              ${vecSql('m.embedding', 'm.embedding_model', q)} AS vec,
              ${recencySql('m.updated_at')} AS recency,
              CASE WHEN m.pinned THEN 1.0
                   ELSE (CASE m.status WHEN 'confirmed' THEN 1.0 WHEN 'disputed' THEN 0.5 ELSE 0.4 END)
                        * (0.5 + 0.5 * m.confidence) END AS authority,
              m.pinned AS always, m.id::text AS dedupe
       FROM memory_objects m
       WHERE m.tenant_id = :tenantId AND m.venture_id = :ventureId
         AND m.status = ANY (:statuses)
         AND NOT (m.origin = 'ai' AND m.status = 'proposed')
         AND (:types IS NULL OR m.type = ANY (:types))
         AND (m.visibility <> 'founder_private' OR (:privateOwner IS NOT NULL AND m.created_by = :privateOwner))
         AND NOT (:excludeSession IS NOT NULL AND m.origin = 'ai' AND jsonb_typeof(m.source_refs) = 'array'
                  AND m.source_refs -> 0 ->> 'kind' = 'session' AND m.source_refs -> 0 ->> 'id' = :excludeSession
                  AND (CAST(:excludeSince AS timestamptz) IS NULL OR m.created_at >= CAST(:excludeSince AS timestamptz)))`,
      { overview: true },
    ),
    params: {
      ...baseParams(q, 8, 'memory'),
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

function chunkSearch(query: VentureChunkQuery): StoreSearch {
  const q = withModel(query);
  return {
    sql: exactStore(
      'own',
      q,
      `SELECT c.id, c.venture_id, c.source_id, 'venture'::text AS source_scope, NULL::text AS memory_type,
              NULL::text AS visibility,
              CASE WHEN c.heading IS NULL OR c.heading = '' THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
              ${excerptSql('c.content', PASSAGE_CHARS)} AS excerpt, s.freshness_at, s.status, c.tsv,
              ${vecSql('c.embedding', 'c.embedding_model', q)} AS vec,
              ${recencySql('s.freshness_at')} AS recency,
              CASE s.status WHEN 'active' THEN 1.0 ELSE 0.5 END AS authority,
              false AS always, ${dedupeSql('c.content')} AS dedupe
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.id = c.source_id
       WHERE c.tenant_id = :tenantId AND c.venture_id = :ventureId AND c.scope = 'venture'
         AND s.venture_id = :ventureId AND s.status <> 'withdrawn'`,
      { perSource: true },
    ),
    params: { ...baseParams(q, 6, 'own'), ventureId: p.uuid(q.ventureId) },
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
   * The reference library (scope `public`, the startup knowledge base) for this turn; absent: none of it is
   * returned by the gate. Its passages are never candidates by the lexical query, nor by vector proximity but for
   * `semantic`.
   */
  readonly reference?: ReferenceQuery;
  /**
   * The cited corpus (the programme's course notes and the open library) for this turn; absent: none of it is
   * returned, whatever is close to the query (`semantic` aside).
   */
  readonly corpus?: CorpusQuery;
  /**
   * Shared notes near the founder's own words, when they ask (none when `asks` is null); absent (semantic admission is
   * off): the cited corpus admits a note by the query's vector itself, as before it.
   */
  readonly semantic?: SemanticQuery;
}

/** What a turn asks of semantic admission ({@link SEMANTIC_ADMISSION}). */
export interface SemanticQuery {
  /** The message plainly asks something (`ask`), or only may (`guarded`); null: it does not, and none is read. */
  readonly asks: 'ask' | 'guarded' | null;
  /** The founder's own words, embedded: the query's vector when it adds nothing to them. Null: no note is read. */
  readonly embedding: readonly number[] | null;
  readonly channel: 'text' | 'voice';
  /** A reranker will choose: more notes are read, by the model's `weak` floor. */
  readonly reranked?: boolean;
  /** The conversation; null or absent: no note was shown before. */
  readonly sessionId?: string | null;
}

/** The numbers one turn's semantic admission uses. */
export interface SemanticRule {
  readonly floor: number;
  readonly relative: number;
  readonly limit: number;
  readonly room: number;
  readonly references: number;
  readonly rerankCandidates: number;
  readonly rerankScore: number;
}

export function semanticRule(
  q: Pick<SemanticQuery, 'asks' | 'channel'> & { readonly embedding?: readonly number[] | null },
  tuning: RetrievalTuning = {},
): SemanticRule {
  const C = { ...SEMANTIC_ADMISSION, ...tuning.semantic };
  const admit = tuning.semantic?.floor ?? embeddingProfile(embeddingModelOf(q.embedding ?? null)).admit;
  const text = q.channel === 'text';
  return {
    // No similarity reaches it.
    floor: admit === undefined ? 2 : admit + (q.asks === 'guarded' ? C.guard : 0),
    relative: C.relative,
    limit: text ? C.limit : C.voiceLimit,
    room: text ? C.room : C.voiceRoom,
    references: C.references,
    rerankCandidates: C.rerankCandidates,
    rerankScore: C.rerankScore,
  };
}

/**
 * Which of the shared notes a search found are shown: those the gates brought, as they are, and at most `rule.limit` of
 * the `semantic` candidates, the closest first. One is admitted when
 *
 * - it is near the founder's words (`floor`) and not far behind the closest note (`relative`); with a reranker's `scores`
 *   (by `refId`), when its score is at least `rerankScore`;
 * - there is room: the gates' notes and the play's count;
 * - it is the closest note of all, or its source was not evidence in this conversation, gives no other note of this turn,
 *   and is not about the course itself (a curriculum passage answers a question about the course, and nothing else);
 * - the turn would not have more than `references` reference-library items.
 *
 * Pure: the same candidates always give the same notes, in the order they came.
 */
export function admitSemantic(
  items: readonly RetrievedItem[],
  rule: SemanticRule,
  scores: ReadonlyMap<string, number> | null = null,
): RetrievedItem[] {
  const value = (i: RetrievedItem): number =>
    scores === null ? (i.near?.similarity ?? -1) : (scores.get(i.refId) ?? -1);
  // With scores, only what was scored competes: the gates' notes were not read by the reranker.
  const ranked = items
    .filter((i) => i.near !== undefined && (scores === null || scores.has(i.refId)))
    .sort((a, b) => value(b) - value(a) || (a.refId < b.refId ? -1 : 1));
  const best = ranked[0];
  const taken = items.filter((i) => i.lane === 'reference' || i.lane === 'corpus' || i.lane === 'pinned');
  const sources = new Set(taken.map((i) => i.sourceId));
  let room = Math.min(rule.limit, rule.room - taken.length);
  let references = taken.filter((i) => i.lane === 'reference').length;
  const admitted = new Set<string>();
  for (const item of ranked) {
    if (item.lane !== 'semantic' || item.near === undefined || best === undefined) continue;
    if (room <= 0) break;
    const near =
      scores === null
        ? value(item) >= rule.floor && value(item) >= rule.relative * value(best)
        : value(item) >= rule.rerankScore;
    if (!near) break;
    const first = item === best;
    if (!first && (item.near.shownBefore || sources.has(item.sourceId) || item.near.family === 'curriculum'))
      continue;
    if (item.near.family === 'reference') {
      if (references >= rule.references) continue;
      references += 1;
    }
    admitted.add(item.refId);
    sources.add(item.sourceId);
    room -= 1;
  }
  return items.filter((i) => i.lane !== 'semantic' || admitted.has(i.refId));
}

/**
 * What a turn may draw from the cited corpus (`knowledge-pack/corpus.ts`). A source is admitted only when the founder's
 * own message asks about one of its topics, the caller names the topic, or the play the path chose cites it; its notes
 * then have slots of their own beside `limit`.
 */
export interface CorpusQuery {
  /** The founder's own message (never the composed retrieval query). */
  readonly founderText: string;
  /** Most notes the message's topics bring, one per source (default {@link CORPUS_LIMIT}). */
  readonly limit?: number;
  /** Topics the caller already knows the turn is about (a path intent); ones the corpus does not have are ignored. */
  readonly topics?: readonly string[];
  /**
   * The turn's play: the one note of the sources it cites that is about the play itself is returned whatever the floor
   * says (`pinnedNote`), so the play's source is evidence beside it; none when no note is.
   */
  readonly play?: CitingPlay | null;
  /** The venture's stage: notes on its usual subjects are preferred among about equal ones. */
  readonly stage?: string | null;
}

export const CORPUS_LIMIT = 2;
/** Most notes the turn's play brings ({@link CorpusQuery.play}). */
export const CORPUS_PIN_LIMIT = 1;

/** What ventures of a stage ask about most (a small preference among notes about equally relevant; never admission). */
const STAGE_TOPICS: Readonly<Record<string, readonly CorpusTopic[]>> = {
  idea: ['idea', 'mindset', 'customer-discovery', 'customer-user'],
  discovery: ['customer-discovery', 'customer-user', 'market-research', 'networking'],
  validation: ['mvp', 'customer-discovery', 'target-market', 'competition'],
  business_model: ['business-model', 'canvas', 'pricing', 'break-even', 'startup-costs'],
  commercialization: ['legal-structure', 'registration', 'patent', 'ein', 'business-plan'],
  growth: ['fundraising', 'investors', 'securities', 'team', 'pitch'],
  transition: ['fundraising', 'networking', 'business-plan'],
};

export interface ReferenceQuery {
  /**
   * The founder's own message: the only text the relevance gate reads. Never the composed retrieval query, whose
   * additions (the vEIR's last question, the venture goal) are not the founder asking for a reference.
   */
  readonly founderText: string;
  /** Most passages (default {@link REFERENCE_GATE}.limit; a call's turn: 1). The gate gives one unless asked for more. */
  readonly limit?: number;
  /** The conversation: a library item already cited in it is never shown again. Null or absent: none left out. */
  readonly sessionId?: string | null;
  /**
   * What the conversation is about beyond the founder's message (their earlier messages, the venture's own words):
   * when the message asks for nothing, an item they and the conversation both name may be offered as optional
   * background (`selectContextualReference`), at most once every {@link REFERENCE_GATE}.contextGapTurns turns. Absent:
   * only what they ask for.
   */
  readonly context?: ConversationContext;
}

/**
 * When a reference-library passage is shown (the startup knowledge base: general material the program did not
 * write). The coaching diagnosis of 2026-11-05 (C1) traced fixation to library notes injected on almost every turn
 * whatever was asked, so:
 *
 * - **the relevance gate** (`knowledge-pack/gate.ts`, `selectReferences`) reads the founder's own message and admits
 *   an item only when that message names it with the item's curated vocabulary (never an everyday English word,
 *   a framework or stage only in a sentence that asks about it, a case by its company's full name in an
 *   entrepreneurship context); one item per turn unless the founder asks for several;
 * - **the vector floor**: with a query embedding, a passage whose own embedding is less similar than `minVector` is
 *   vetoed (the words may coincide while the meaning differs). Similarity admits none here: an item near the founder's
 *   own words comes by {@link SEMANTIC_ADMISSION}, one a turn at most, when they ask;
 * - **never twice in a conversation**: an item already cited in the conversation (`turn_evidence` with source scope
 *   `public`) is not shown again; the history already holds what was said about it;
 * - one passage per item: a case's documented account before its editorial guidance, else the item's first
 *   passage; at most `limit` (a call's turn: 1), in slots of their own beside the shared budget.
 *
 * - **in context** (coaching v3): when the founder's message asks for nothing, an item both it and the conversation
 *   name by its vocabulary (`selectContextualReference`: an earlier message of theirs or the venture's own words) is
 *   offered, one item, and only when no reference passage was shown in the conversation's last `contextGapTurns`
 *   turns; the prompt says a reference is optional background (`REFERENCE_RULES`).
 *
 * They are ranked by the usual hybrid score, in which the library's authority (0.7; 0.63 for editorial guidance)
 * stays below the program's own guidance (0.9) and the vEIR's library (1.0).
 */
export const REFERENCE_GATE = {
  minVector: 0.2,
  limit: 2,
  /**
   * Earlier turns of the conversation that must show no reference passage before one comes back unasked (coaching
   * v3: at most one contextual reference every few turns). One the founder asks for is never held back.
   */
  contextGapTurns: CONTEXT_GAP_TURNS,
} as const;

/**
 * URI prefix of a programme's curriculum notes (`seed/curriculum.ts`): programme-scope passages about the course
 * itself (modules, checklists, capstones), which answer a question about the programme and nothing else.
 */
export const CURRICULUM_URI_PREFIX = 'curriculum:';

/** What a message about the programme itself names: its parts, its coursework and where it lives. */
const PROGRAMME_WORDS =
  /\b(?:modules?|capstones?|curriculum|checklists?|quiz(?:zes)?|coursework|blackboard|mentorship hub|mentor journal|foundry (?:program(?:me)?|series|roadmap|hub|sessions?)|roadmap|ain foundry)\b/i;

/**
 * The founder's own message is about the programme (a module, a capstone, the checklist, Blackboard, the Mentorship
 * Hub…): only then is a curriculum passage a candidate for the shared slots. Anything else keeps them for the vEIR's
 * library and the programme handbook (a review on 2026-11-08 found curriculum passages taking both slots from
 * "Should I raise money or bootstrap?").
 */
export function asksAboutProgramme(founderText: string): boolean {
  return PROGRAMME_WORDS.test(founderText);
}

/**
 * Shared-corpus chunks. Candidates: the HNSW index (`ORDER BY embedding <=> :q LIMIT n` on the `venture_id IS NULL`
 * partial index) ∪ the best lexical coverage, fused and floored as every store's; then, beside them, the reference
 * passages {@link REFERENCE_GATE} admits and the notes of the cited corpus ({@link CorpusQuery}). Persona chunks are
 * returned as kind `doctrine`, others as `chunk`. authority: persona 1.0, program 0.9, public 0.7 (× 0.9 for a
 * reference passage that is not a documented account; × 0.5 when the source is stale). Public chunks are never ANN or
 * lexical candidates. `limit` counts the persona's and the programme's passages; reference passages (`reference.limit`)
 * and corpus notes (`corpus.limit`, and the play's cited note) come beyond it.
 */
export function searchSharedChunks(ex: SqlExecutor, q: SharedChunkQuery): Promise<RetrievedItem[]> {
  return run(ex, sharedSearch(q));
}

function sharedSearch(query: SharedChunkQuery): StoreSearch {
  const q = withModel(query);
  const c = constants(q);
  const { L } = c;
  const scopeFilter = `c.venture_id IS NULL AND c.tenant_id = :tenantId AND c.scope = ANY (:scopes)
    AND (c.scope <> 'persona' OR c.persona_id = :personaId) AND ${notAnAskSql('c')}`;
  const refLimit = q.reference ? Math.max(0, Math.min(q.reference.limit ?? REFERENCE_GATE.limit, 10)) : 0;
  const gate = q.reference ? selectReferences(q.reference.founderText, { limit: refLimit }) : null;
  const admitted = gate?.matches ?? [];
  // Nothing asked for: what the conversation is about may bring one item, rate-limited in SQL (`recent_ref`).
  const contextual =
    admitted.length === 0 && refLimit > 0 && q.reference?.context !== undefined
      ? selectContextualReference(q.reference.founderText, q.reference.context).matches
      : [];
  const founderText = q.corpus?.founderText ?? '';
  const topicUris = new Set([
    ...corpusUrisForMessage(founderText),
    ...corpusUrisForTopics((q.corpus?.topics ?? []).filter(isCorpusTopic)),
  ]);
  const pin = q.corpus?.play == null ? null : pinnedNote(q.corpus.play);
  // The corpus's own vector rule: semantic admission takes its place (its founder's own words, its floor, its slots).
  const byVector = q.semantic === undefined;
  const meaning = semanticOf(q, gate?.reason === 'program');
  const stageTopics = q.corpus?.stage == null ? [] : (STAGE_TOPICS[q.corpus.stage] ?? []);
  // The persona's and the programme's own passages: curriculum ones only when the founder's message is about the
  // programme, the course notes never (they come as corpus notes).
  const core = `c.scope <> 'public' AND NOT EXISTS (SELECT 1 FROM knowledge_sources cs
       WHERE cs.id = c.source_id AND starts_with(coalesce(cs.uri, ''), :curriculumPrefix)
         AND (NOT :curriculumAsked OR starts_with(cs.uri, :notesPrefix)))`;
  const ann = (vector: string, model: string | null): string => `SELECT c.id FROM knowledge_chunks c
       WHERE ${scopeFilter} AND :embedding IS NOT NULL AND ${core}
         ${model === null ? '' : `AND ${model}`}
       ORDER BY c.embedding <=> ${vector}
       LIMIT :candidates`;
  const annSql =
    q.embeddingModel == null
      ? `(${ann(':embedding', null)})`
      : `(${ann(':embedding', '(c.embedding_model IS NULL OR c.embedding_model = :embeddingModel)')})` +
        (q.alternate == null
          ? ''
          : ` UNION (${ann(':alternateEmbedding', 'c.embedding_model = :alternateModel')})`);
  return {
    sql: `WITH ${TERMS_CTE}
     , store_rows AS (SELECT c.id FROM knowledge_chunks c WHERE ${scopeFilter})
     , hits AS MATERIALIZED (
       SELECT c.id, t.ord FROM terms t JOIN knowledge_chunks c ON c.tsv @@ t.tsq WHERE ${scopeFilter})
     , ${lexicalCtes(c)}
     , ann AS (${annSql})
     , lexical AS (
       SELECT c.id FROM coverage v JOIN knowledge_chunks c ON c.id = v.id
       WHERE ${core}
       ORDER BY v.cov DESC, c.id
       LIMIT :candidates)
     , recent_ref AS (
       SELECT 1 FROM turn_evidence te
       JOIN (SELECT t.id FROM turns t
             WHERE :refSessionId IS NOT NULL AND t.session_id = :refSessionId
             ORDER BY t.ordinal DESC
             LIMIT :ctxGap) recent ON recent.id = te.turn_id
       WHERE te.source_scope = 'public'
         AND NOT EXISTS (SELECT 1 FROM knowledge_sources ls
                         WHERE ls.id = te.source_id AND starts_with(coalesce(ls.uri, ''), :libraryPrefix)))
     , gate AS (
       SELECT g.uri, g.rank FROM unnest(:refUris) WITH ORDINALITY AS g (uri, rank)
       UNION ALL
       SELECT g.uri, g.rank FROM unnest(:ctxUris) WITH ORDINALITY AS g (uri, rank)
       WHERE NOT EXISTS (SELECT 1 FROM recent_ref))
     , cited AS (
       SELECT te.source_id FROM turn_evidence te JOIN turns t ON t.id = te.turn_id
       WHERE :refSessionId IS NOT NULL AND t.session_id = :refSessionId
         AND te.source_scope = 'public' AND te.source_id IS NOT NULL)
     , ref_passages AS (
       SELECT c.id, g.rank,
              row_number() OVER (PARTITION BY c.source_id
                                 ORDER BY starts_with(coalesce(c.heading, ''), :refDocumented) DESC, c.ordinal, c.id)
                AS pick
       FROM gate g
       JOIN knowledge_sources s ON s.uri = g.uri AND s.tenant_id = :tenantId AND s.scope = 'public'
       JOIN knowledge_chunks c ON c.source_id = s.id
       WHERE ${scopeFilter} AND c.scope = 'public' AND s.status IN ('active', 'stale')
         AND (:classifications IS NULL OR s.classification = ANY (:classifications))
         AND NOT EXISTS (SELECT 1 FROM cited WHERE cited.source_id = s.id)
         AND (:embedding IS NULL OR c.embedding IS NULL OR coalesce(${vecSql('c.embedding', 'c.embedding_model', q)}, 1) >= :refMinVector))
     , reference AS (SELECT id FROM ref_passages WHERE pick = 1 ORDER BY rank LIMIT :refLimit)
     , corpus AS (
       SELECT c.id, coalesce(s.uri = :pinUri AND c.ordinal = :pinOrdinal, false) AS is_pin,
              s.uri = ANY (:corpusUris) AS topical
       FROM knowledge_sources s
       JOIN knowledge_chunks c ON c.source_id = s.id
       WHERE s.tenant_id = :tenantId AND s.scope IN ('program', 'public') AND s.uri = ANY (:corpusAll) AND ${scopeFilter})
     , strong AS MATERIALIZED (
       SELECT id FROM coverage WHERE cov >= ${L.openCoverage} AND words >= ${L.openTerms})
     , open_notes AS (
       SELECT c.id FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
       WHERE :corpusOpen AND ${scopeFilter} AND s.scope IN ('program', 'public')
         AND (starts_with(s.uri, :notesPrefix) OR starts_with(s.uri, :libraryPrefix))
         AND (c.id IN (SELECT id FROM strong)
              OR (${byVector ? 'true' : 'false'}
                  AND coalesce(${vecSql('c.embedding', 'c.embedding_model', q)} >= :vecFloor, false))))
     , near_notes AS MATERIALIZED (${meaning?.sql(scopeFilter) ?? NO_NEAR_NOTES})
     , core_cand AS MATERIALIZED (SELECT id FROM ann UNION SELECT id FROM lexical)
     , cand AS (SELECT id FROM core_cand UNION SELECT id FROM reference UNION SELECT id FROM corpus
               UNION SELECT id FROM open_notes UNION SELECT id FROM near_notes)
     , cand_coverage AS MATERIALIZED (SELECT v.* FROM coverage v WHERE v.id IN (SELECT id FROM cand))
     , store AS (
       SELECT c.id, c.ordinal, NULL::uuid AS venture_id, c.source_id, c.scope AS source_scope, NULL::text AS memory_type,
              NULL::text AS visibility,
              CASE WHEN c.scope = 'persona' THEN 'doctrine' ELSE 'chunk' END AS kind,
              CASE WHEN c.heading IS NULL OR c.heading = '' THEN s.title ELSE s.title || ' — ' || c.heading END AS title,
              ${excerptSql('c.content', PASSAGE_CHARS)} AS excerpt, s.freshness_at, s.status,
              coalesce(c.locator, CASE WHEN s.url IS NULL THEN NULL ELSE c.heading END) AS locator,
              s.url, s.license AS licence, s.attribution,
              ${vecSql('c.embedding', 'c.embedding_model', q)} AS vec,
              ${recencySql('s.freshness_at')} AS recency,
              (CASE c.scope WHEN 'persona' THEN 1.0 WHEN 'program' THEN 0.9
                 ELSE 0.7 * (CASE WHEN co.id IS NOT NULL OR op.id IS NOT NULL OR starts_with(coalesce(c.heading, ''), :refDocumented)
                                  THEN 1.0 ELSE 0.9 END)
               END)
                * (CASE s.status WHEN 'active' THEN 1.0 ELSE 0.5 END) AS authority,
              coalesce(v.cov, 0) AS cov, coalesce(v.words, 0) AS matched, coalesce(v.subjects, 0) AS subjects,
              CASE WHEN v.cov IS NULL THEN 0 ELSE v.cov + 0.15 * ts_rank_cd(c.tsv, q.tsq, 32) END
                + 0.35 * coalesce(h.cov, 0) AS lex,
              coalesce(h.cov, 0) AS heading_cov, coalesce(h.named, false) AS rescued,
              re.id IS NOT NULL AS is_reference, coalesce(co.is_pin, false) AS is_pin, coalesce(co.topical, false) AS topical,
              co.id IS NULL AND op.id IS NULL AND cc.id IS NOT NULL AS is_core,
              op.id IS NOT NULL AS is_open,
              ne.family AS near_family, ne.similarity AS near_similarity, ne.shown AS near_shown,
              -- Only its nearness brings it: the other lanes' floors are measured without it.
              co.id IS NULL AND op.id IS NULL AND cc.id IS NULL AND re.id IS NULL AND ne.family <> 'note' AS only_near,
              s.uri = ANY (:stageUris) AS of_stage,
              ${dedupeSql('c.content')} AS dedupe
       FROM cand
       JOIN knowledge_chunks c ON c.id = cand.id
       JOIN knowledge_sources s ON s.id = c.source_id
       CROSS JOIN q
       LEFT JOIN cand_coverage v ON v.id = c.id
       LEFT JOIN reference re ON re.id = c.id
       LEFT JOIN corpus co ON co.id = c.id
       LEFT JOIN open_notes op ON op.id = c.id
       LEFT JOIN near_notes ne ON ne.id = c.id
       LEFT JOIN core_cand cc ON cc.id = c.id
       LEFT JOIN LATERAL (
         SELECT least(1, sum(i.idf) / max(tt.total)) AS cov, bool_or(t.named) AS named
         FROM terms t JOIN idf i ON i.ord = t.ord CROSS JOIN total tt
         WHERE to_tsvector('english', s.title || ' ' || coalesce(c.heading, '')) @@ t.tsq) h ON true
       WHERE ${scopeFilter} AND s.status IN ('active', 'stale')
         AND (:classifications IS NULL OR s.classification = ANY (:classifications)))
     , scored AS (SELECT x.*, max(x.vec) FILTER (WHERE NOT coalesce(x.only_near, false)) OVER () AS top_vec FROM store x)
     , ranked AS (
       SELECT k.*, ${RANKS_SQL}
       FROM (SELECT s.*, ${floorSql(c, 'shared')} AS about,
                    greatest(s.cov, s.heading_cov) >= ${L.topicCoverage} OR coalesce(s.vec >= :vecWeak, false) AS touches,
                    (s.cov >= ${L.openCoverage} AND s.matched >= ${L.openTerms})
                      OR ${byVector ? `coalesce(s.vec >= :vecFloor AND s.vec >= ${L.openRelative} * s.top_vec, false)` : 'false'} AS open_about
             FROM scored s) k)
     , fused AS (
       SELECT r.*, ${fusedSql(c)} + CASE WHEN r.of_stage THEN 0.02 ELSE 0 END
                + CASE WHEN r.topical AND r.touches THEN 0.08 ELSE 0 END AS score
       FROM ranked r CROSS JOIN q)
     , laned AS (
       SELECT b.*, CASE WHEN b.is_pin THEN 'pinned'
                        WHEN b.is_reference THEN 'reference'
                        WHEN b.topical AND b.touches THEN 'corpus'
                        WHEN b.is_open AND b.open_about THEN 'corpus'
                        WHEN b.is_core AND b.about THEN 'core'
                        WHEN b.near_family IS NOT NULL THEN 'semantic' END AS came_by
       FROM fused b)
     , one AS (
       SELECT l.*, row_number() OVER (PARTITION BY l.came_by, l.source_id ORDER BY l.score DESC, l.id) AS of_source,
              row_number() OVER (PARTITION BY l.dedupe ORDER BY (l.came_by = 'pinned') DESC, (l.came_by = 'semantic'), l.score DESC, l.id) AS copy
       FROM laned l
       WHERE l.came_by IS NOT NULL AND (l.came_by IN ('pinned', 'semantic') OR l.score >= :minScore))
     , numbered AS (
       SELECT o.*, row_number() OVER (PARTITION BY o.came_by ORDER BY o.score DESC, o.id) AS lane_rank
       FROM one o
       WHERE o.copy = 1
         AND o.of_source <= CASE o.came_by WHEN 'corpus' THEN 1 WHEN 'core' THEN ${PER_SOURCE_LIMIT} ELSE 1000 END)
     , placed AS (
       SELECT n.id, n.came_by AS lane FROM numbered n
       WHERE n.lane_rank <= CASE n.came_by WHEN 'core' THEN :limit WHEN 'corpus' THEN :corpusLimit ELSE 1000 END)
     -- A near note the gates had no slot for is a candidate still.
     SELECT o.*, coalesce(pl.lane, 'semantic') AS lane, coalesce(greatest(o.vec, 0), 0) AS vec_shown
     FROM one o LEFT JOIN placed pl ON pl.id = o.id
     WHERE o.copy = 1 AND (pl.id IS NOT NULL OR o.near_family IS NOT NULL)
     ORDER BY o.score DESC, o.id`,
    params: {
      ...baseParams(q, 4, 'shared'),
      scopes: p.textArray(q.scopes ?? ['program', 'public', 'persona']),
      personaId: p.nullable.uuid(q.personaId),
      classifications: p.nullable.textArray(q.classifications),
      candidates: p.int(clampLimit(q.candidates, 40, 400)),
      refUris: p.textArray(admitted.map((m) => m.uri)),
      ctxUris: p.textArray(contextual.map((m) => m.uri)),
      // The turn being answered is in the conversation already (with no evidence yet): one row more.
      ctxGap: p.int(REFERENCE_GATE.contextGapTurns + 1),
      refSessionId: p.nullable.uuid(q.reference?.sessionId ?? null),
      refDocumented: p.text(DOCUMENTED_ACCOUNT_HEADING),
      refMinVector: p.num(REFERENCE_GATE.minVector),
      refLimit: p.int(refLimit),
      curriculumAsked: p.bool(q.reference !== undefined && asksAboutProgramme(q.reference.founderText)),
      curriculumPrefix: p.text(CURRICULUM_URI_PREFIX),
      notesPrefix: p.text(PROGRAMME_NOTES_URI_PREFIX),
      libraryPrefix: p.text(LIBRARY_URI_PREFIX),
      corpusOpen: p.bool(founderText !== '' && seeksHelp(founderText)),
      corpusUris: p.textArray([...topicUris]),
      corpusAll: p.textArray([...new Set([...topicUris, ...(pin === null ? [] : [pin.uri])])]),
      pinUri: p.nullable.text(pin?.uri ?? null),
      pinOrdinal: p.nullable.int(pin?.ordinal ?? null),
      corpusLimit: p.int(
        q.corpus === undefined ? 0 : Math.max(0, Math.min(q.corpus.limit ?? CORPUS_LIMIT, 10)),
      ),
      stageUris: p.textArray(corpusUrisForTopics(stageTopics)),
      ...meaning?.params,
    },
    decode: (r) => decodeItem('from_row', r),
  };
}

const NO_NEAR_NOTES = `SELECT NULL::uuid AS id, NULL::text AS family, NULL::double precision AS similarity,
       NULL::boolean AS shown WHERE false`;

/**
 * The notes near the founder's own words: an exact scan of the tenant's few hundred shared notes (no index: a filtered ANN
 * scan drops rows), the closest passage of each source, the closest sources first. Null: the turn reads none.
 */
function semanticOf(
  q: SharedChunkQuery,
  /** They ask about the programme itself: its own guidance answers, never the reference library. */
  programme: boolean,
): { readonly sql: (scopeFilter: string) => string; readonly params: Record<string, SqlParam> } | null {
  const semantic = q.semantic;
  if (semantic?.embedding == null || semantic.asks === null) return null;
  // The query's own vector is sent once.
  const same = semantic.embedding === q.embedding;
  const model = same ? q.embeddingModel : embeddingModelOf(semantic.embedding);
  const alternate = same ? q.alternate : model == null ? null : alternateOf(semantic.embedding);
  const rule = semanticRule(semantic, q.tuning);
  const profile = q.tuning?.profile ?? embeddingProfile(model);
  const floor = semantic.reranked === true ? profile.weak : rule.floor;
  const name = (n: string): string => (same ? n : `near${n.charAt(0).toUpperCase()}${n.slice(1)}`);
  const similarity = vecSql(
    'c.embedding',
    'c.embedding_model',
    { embeddingModel: model, alternate: alternate ?? null },
    name,
  );
  return {
    sql: (scopeFilter) => `SELECT y.id, y.family, y.similarity,
              EXISTS (SELECT 1 FROM turn_evidence te JOIN turns t ON t.id = te.turn_id
                      WHERE :nearSessionId IS NOT NULL AND t.session_id = :nearSessionId
                        AND te.source_id = y.source_id) AS shown
       FROM (
       SELECT z.* FROM (
         SELECT n.*, row_number() OVER (PARTITION BY n.source_id ORDER BY n.similarity DESC, n.id) AS of_source
         FROM (
           SELECT c.id, c.source_id, ${similarity} AS similarity,
                  CASE WHEN starts_with(s.uri, :packPrefix) THEN 'reference'
                       WHEN starts_with(s.uri, :curriculumPrefix) AND NOT starts_with(s.uri, :notesPrefix) THEN 'curriculum'
                       ELSE 'note' END AS family
           FROM knowledge_sources s JOIN knowledge_chunks c ON c.source_id = s.id
           WHERE s.tenant_id = :tenantId AND s.scope IN ('program', 'public') AND s.status IN ('active', 'stale')
             AND (:classifications IS NULL OR s.classification = ANY (:classifications))
             AND ((starts_with(s.uri, :packPrefix) AND ${String(!programme)}) OR starts_with(s.uri, :curriculumPrefix)
                  OR starts_with(s.uri, :libraryPrefix))
             AND ${scopeFilter}) n
         WHERE n.similarity >= :nearFloor) z
       WHERE z.of_source = 1
       ORDER BY z.similarity DESC, z.id
       LIMIT :nearLimit) y`,
    params: {
      packPrefix: p.text(PACK_URI_PREFIX),
      nearSessionId: p.nullable.uuid(semantic.sessionId ?? null),
      nearFloor: p.num(floor),
      nearLimit: p.int(clampLimit(rule.rerankCandidates, SEMANTIC_ADMISSION.rerankCandidates, 50)),
      ...(same
        ? {}
        : {
            [name('embedding')]: p.vector(semantic.embedding),
            ...(model == null ? {} : { [name('embeddingModel')]: p.text(model) }),
            ...(model == null || alternate == null
              ? {}
              : {
                  [name('alternateModel')]: p.text(alternate.modelId),
                  [name('alternateEmbedding')]: p.vector(alternate.embedding),
                }),
          }),
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The plays a message is nearest to
// ------------------------------------------------------------------------------------------------

/** A play by its closest ask (`knowledge-pack/play-asks.ts`). */
export interface NearPlay {
  readonly playId: string;
  /** Cosine similarity of the message with the play's closest ask. */
  readonly score: number;
}

/** The nearest plays, best first, and the embedding model their scores are of (scores of two are not comparable). */
export interface NearPlays {
  readonly modelId: string;
  readonly plays: readonly NearPlay[];
}

/**
 * The plays whose asks the message is closest to, each once, best first (equal scores: by id). One exact scan of the
 * tenant's few hundred asks. Null unless every stored ask has a vector of one model that also embedded the message (its
 * own, else the model being replaced, {@link alternateOf}): with a part of them, a play is chosen because the right one is
 * missing.
 */
export async function nearestPlays(
  ex: SqlExecutor,
  args: {
    readonly tenantId: string;
    /** The founder's own message, embedded; only a tagged vector (`embedding-model.ts`) can be compared. */
    readonly embedding: readonly number[];
    readonly limit: number;
  },
): Promise<NearPlays | null> {
  const modelId = embeddingModelOf(args.embedding);
  if (modelId === null) return null;
  const alternate = alternateOf(args.embedding);
  const result = await ex.query(
    `WITH asks AS MATERIALIZED (
       SELECT substr(c.locator, ${PLAY_ASK_LOCATOR.length + 1}) AS play_id, c.embedding, c.embedding_model
       FROM knowledge_sources s JOIN knowledge_chunks c ON c.source_id = s.id
       WHERE s.tenant_id = :tenantId AND s.scope = 'public' AND s.uri = :uri AND s.status = 'active'
         AND c.tenant_id = :tenantId)
     , model AS (
       SELECT CASE WHEN bool_and(coalesce(embedding IS NOT NULL AND embedding_model = :modelId, false)) THEN :modelId
                   WHEN bool_and(coalesce(embedding IS NOT NULL AND embedding_model = :alternateModel, false))
                     THEN :alternateModel END AS id
       FROM asks)
     SELECT m.id AS model_id, a.play_id,
            max(1 - (a.embedding <=> CASE WHEN m.id = :modelId THEN :embedding ELSE :alternate END)) AS score
     FROM asks a JOIN model m ON m.id IS NOT NULL
     GROUP BY m.id, a.play_id
     ORDER BY score DESC, a.play_id
     LIMIT :limit`,
    {
      tenantId: p.uuid(args.tenantId),
      uri: p.text(PLAY_ASKS_URI),
      modelId: p.text(modelId),
      embedding: p.vector(args.embedding),
      alternateModel: p.nullable.text(alternate?.modelId),
      alternate: p.nullable.vector(alternate?.embedding),
      limit: p.int(clampLimit(args.limit, 3, 20)),
    },
  );
  const first = result.rows[0];
  if (first === undefined) return null;
  return {
    modelId: col.text.decode(first.model_id, 'model_id'),
    plays: result.rows.map((r) => ({
      playId: col.text.decode(r.play_id, 'play_id'),
      score: col.num.decode(r.score, 'score'),
    })),
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
 * Program resources for route mode (lexical): authority = status (active 1.0, stale 0.5) × (0.4 + 0.6 · stage fit).
 * Stage fit: 1 when the resource lists the stage, 0.5 when it lists no stages. Retired resources are excluded.
 */
export function searchResources(ex: SqlExecutor, q: ResourceQuery): Promise<RetrievedItem[]> {
  return run(ex, resourceSearch(q));
}

function resourceSearch(q: ResourceQuery): StoreSearch {
  return {
    // The stage fit is the resource's authority: it orders resources that match about equally.
    sql: exactStore(
      'offer',
      q,
      `SELECT r.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS source_scope,
              NULL::text AS memory_type, NULL::text AS visibility, r.name AS title,
              ${excerptSql('r.description', PASSAGE_CHARS)} AS excerpt, r.freshness_at, r.status, r.tsv,
              NULL::double precision AS vec,
              f.stage_fit, r.name || ' ' || replace(array_to_string(r.tags, ' '), '-', ' ') AS subject,
              ${recencySql('r.freshness_at')} AS recency,
              (CASE r.status WHEN 'active' THEN 1.0 ELSE 0.5 END) * (0.4 + 0.6 * f.stage_fit) AS authority,
              false AS always, r.id::text AS dedupe
       FROM resources r
       CROSS JOIN LATERAL (
         SELECT CASE WHEN :stage IS NOT NULL AND :stage = ANY (r.stages) THEN 1.0
                     WHEN cardinality(r.stages) = 0 THEN 0.5 ELSE 0 END AS stage_fit) f
       WHERE r.tenant_id = :tenantId AND r.status <> 'retired'`,
      { extra: ['stage_fit'], onSubject: true },
    ),
    params: { ...baseParams({ ...q, embedding: null }, 4, 'offer'), stage: p.nullable.text(q.stage) },
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
    sql: exactStore(
      'offer',
      q,
      `SELECT pt.id, NULL::uuid AS venture_id, NULL::uuid AS source_id, NULL::text AS source_scope,
              NULL::text AS memory_type, NULL::text AS visibility, pt.title,
              ${excerptSql("pt.signal || ' → ' || pt.intervention || ' (limits: ' || pt.limits || ')'", PASSAGE_CHARS)} AS excerpt,
              pt.created_at AS freshness_at, pt.status,
              to_tsvector('english', pt.title || ' ' || pt.context || ' ' || pt.signal || ' ' || pt.intervention) AS tsv,
              NULL::double precision AS vec,
              ${recencySql('pt.created_at')} AS recency,
              1.0 AS authority, false AS always, pt.id::text AS dedupe, pt.title AS subject
       FROM patterns pt
       WHERE pt.tenant_id = :tenantId AND pt.status = 'published'
         AND (pt.persona_id IS NULL OR pt.persona_id = :personaId)
         AND (pt.expires_at IS NULL OR pt.expires_at > now())`,
      { onSubject: true },
    ),
    params: { ...baseParams({ ...q, embedding: null }, 2, 'offer'), personaId: p.nullable.uuid(q.personaId) },
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
 * JSON with their rank within the store (the columns the decoder reads, never a tsvector).
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
