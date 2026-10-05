import {
  CoachMode,
  CoachResponse,
  EvidenceKind,
  TurnStatus,
  ValidatorResults,
  type EvidenceItem,
  type TurnBlockedDetail,
  type TurnView,
} from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import {
  clampLimit,
  excerptSql,
  fetchByIdsInBatches,
  queryFirst,
  queryNumber,
  queryOne,
  queryRows,
} from './common.js';
import { escalationIdsByTurn } from './escalations.js';

type CoachModeValue = z.infer<typeof CoachMode>;
type CoachResponseValue = z.infer<typeof CoachResponse>;
type ValidatorResultsValue = z.infer<typeof ValidatorResults>;
type EvidenceItemValue = z.infer<typeof EvidenceItem>;
type TurnStatusValue = z.infer<typeof TurnStatus>;

export interface TurnRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly authorId: string;
  readonly mode: CoachModeValue;
  /** Founder input. Content: never log it. */
  readonly founderText: string;
  readonly response: CoachResponseValue | null;
  readonly status: TurnStatusValue;
  readonly riskLabel: string | null;
  readonly riskCategories: string[];
  readonly validatorResults: ValidatorResultsValue | null;
  readonly modelId: string | null;
  readonly fallbackUsed: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number | null;
  readonly sampledForReview: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

const COLUMNS = `t.id, t.tenant_id, t.venture_id, t.session_id, t.ordinal, t.author_id, t.mode, t.founder_text, t.response,
  t.status, t.risk_label, t.risk_categories, t.validator_results, t.model_id, t.fallback_used, t.input_tokens,
  t.output_tokens, t.cost_usd, t.latency_ms, t.sampled_for_review, t.created_at, t.completed_at`;

function safeJson<T>(schema: z.ZodType<T>, raw: unknown, column: string): T | null {
  const value = col.json().nullable.decode(raw, column);
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeTurn(r: RawRow): TurnRecord {
  const mode = col.text.decode(r.mode, 'mode');
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    sessionId: col.uuid.decode(r.session_id, 'session_id'),
    ordinal: col.int.decode(r.ordinal, 'ordinal'),
    authorId: col.uuid.decode(r.author_id, 'author_id'),
    mode: CoachMode.safeParse(mode).data ?? 'coach',
    founderText: col.text.decode(r.founder_text, 'founder_text'),
    response: safeJson(CoachResponse, r.response, 'response'),
    status: col.enum(TurnStatus.options).decode(r.status, 'status'),
    riskLabel: col.text.nullable.decode(r.risk_label, 'risk_label'),
    riskCategories: col.textArray.decode(r.risk_categories, 'risk_categories'),
    validatorResults: safeJson(ValidatorResults, r.validator_results, 'validator_results'),
    modelId: col.text.nullable.decode(r.model_id, 'model_id'),
    fallbackUsed: col.bool.decode(r.fallback_used, 'fallback_used'),
    inputTokens: col.int.decode(r.input_tokens, 'input_tokens'),
    outputTokens: col.int.decode(r.output_tokens, 'output_tokens'),
    costUsd: col.num.decode(r.cost_usd, 'cost_usd'),
    latencyMs: col.int.nullable.decode(r.latency_ms, 'latency_ms'),
    sampledForReview: col.bool.decode(r.sampled_for_review, 'sampled_for_review'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    completedAt: col.ts.nullable.decode(r.completed_at, 'completed_at'),
  };
}

export function getTurn(ex: SqlExecutor, id: string): Promise<TurnRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM turns t WHERE t.id = :id`, { id: p.uuid(id) }, decodeTurn);
}

/**
 * Full turn rows per statement. A turn can hold 8 000 characters of founder text plus a validated response
 * (answer, claims, actions, candidates; tens of kB at most), so five per statement keeps every result far
 * below the RDS Data API's 1 MB limit however long the session.
 */
export const TURN_BATCH_SIZE = 5;

/** Turns by id, in the order of `ids` (ids the caller cannot see are skipped). Batched (Data API 1 MB). */
export function getTurnsByIds(ex: SqlExecutor, ids: readonly string[]): Promise<TurnRecord[]> {
  return fetchByIdsInBatches(
    ids,
    TURN_BATCH_SIZE,
    (batch) =>
      queryRows(
        ex,
        `SELECT ${COLUMNS} FROM turns t WHERE t.id = ANY (:ids)`,
        { ids: p.uuidArray(batch) },
        decodeTurn,
      ),
    (turn) => turn.id,
  );
}

/** All turns of a session in order (ids first, then the rows in batches). */
export async function listTurns(ex: SqlExecutor, sessionId: string): Promise<TurnRecord[]> {
  const ids = await queryRows(
    ex,
    'SELECT t.id FROM turns t WHERE t.session_id = :sessionId ORDER BY t.ordinal',
    { sessionId: p.uuid(sessionId) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return getTurnsByIds(ex, ids);
}

/** The last `limit` completed turns of a session, oldest first (conversation context; default 8). */
export async function listRecentTurns(
  ex: SqlExecutor,
  args: { sessionId: string; limit?: number; beforeOrdinal?: number },
): Promise<TurnRecord[]> {
  const ids = await queryRows(
    ex,
    `SELECT t.id FROM turns t
     WHERE t.session_id = :sessionId AND t.status = 'completed' AND (:before IS NULL OR t.ordinal < :before)
     ORDER BY t.ordinal DESC LIMIT :limit`,
    {
      sessionId: p.uuid(args.sessionId),
      before: p.nullable.int(args.beforeOrdinal),
      limit: p.int(clampLimit(args.limit, 8, 50)),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return (await getTurnsByIds(ex, ids)).reverse();
}

/** Number of turns in a session (max_turns_per_session). */
export function countSessionTurns(ex: SqlExecutor, sessionId: string): Promise<number> {
  return queryNumber(ex, 'SELECT count(*) AS n FROM turns WHERE session_id = :sessionId', {
    sessionId: p.uuid(sessionId),
  });
}

/** Advisory-lock namespace of the per-principal turn admission (two-key form; see auth/migrate keys). */
export const TURN_ADMISSION_LOCK_NAMESPACE = 7_012_030;

/**
 * Serialises turn admission for one principal until the end of the caller's transaction: the rate-limit
 * count, the in-flight count, the spend-cap check and the insert of the pending turn then run as one unit,
 * so parallel requests cannot all pass the checks before any of them is recorded. The lock call is wrapped
 * so the result column is an integer, never `void` (which the RDS Data API need not serialise). Must run
 * inside a transaction (`db.withContext`).
 */
export async function lockTurnAdmission(ex: SqlExecutor, principalId: string): Promise<void> {
  await ex.query(
    'SELECT count(*) AS n FROM (SELECT pg_advisory_xact_lock(:namespace, hashtext(:principal))) AS l',
    { namespace: p.int(TURN_ADMISSION_LOCK_NAMESPACE), principal: p.text(principalId.toLowerCase()) },
  );
}

/**
 * Daily AI spend against the caps the caller read from platform_settings (`app.spend_cap_state`): which
 * cap is reached, or null. Runs under RLS without access to the ledger itself (no amounts are returned).
 */
export async function spendCapState(
  ex: SqlExecutor,
  caps: { globalUsd: number; principalUsd: number },
): Promise<'global' | 'principal' | null> {
  const row = await queryFirst(
    ex,
    'SELECT app.spend_cap_state(:globalCap, :principalCap) AS state',
    { globalCap: p.num(caps.globalUsd), principalCap: p.num(caps.principalUsd) },
    (r) => col.enum(['global', 'principal'] as const).nullable.decode(r.state, 'state'),
  );
  return row ?? null;
}

/**
 * Turns of a principal still being answered (`pending`) that were created in the last `withinSeconds`
 * (older pending turns belong to a request that died and do not count).
 */
export function countPendingTurnsByAuthor(
  ex: SqlExecutor,
  args: { authorId: string; withinSeconds: number },
): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM turns
     WHERE author_id = :authorId AND status = 'pending' AND created_at > now() - make_interval(secs => :within)`,
    { authorId: p.uuid(args.authorId), within: p.num(args.withinSeconds) },
  );
}

/** Turns authored by a principal in the last `windowSeconds` (per-principal rate limit). */
export function countRecentTurnsByAuthor(
  ex: SqlExecutor,
  args: { authorId: string; windowSeconds: number },
): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM turns WHERE author_id = :authorId AND created_at > now() - make_interval(secs => :window)`,
    { authorId: p.uuid(args.authorId), window: p.num(args.windowSeconds) },
  );
}

export interface CreateTurnInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  /** Must be the request principal under RLS. */
  readonly authorId: string;
  readonly mode: CoachModeValue;
  readonly founderText: string;
  readonly riskLabel?: string | null;
  readonly riskCategories?: readonly string[];
}

/**
 * Creates a `pending` turn with the next ordinal of the session. Concurrent creates in the same session
 * fail with a unique violation (session_id, ordinal); callers may retry.
 */
export function createTurn(ex: SqlExecutor, input: CreateTurnInput): Promise<TurnRecord> {
  return queryOne(
    ex,
    `INSERT INTO turns AS t (id, tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, risk_label,
                             risk_categories)
     SELECT coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :sessionId,
            coalesce((SELECT max(x.ordinal) FROM turns x WHERE x.session_id = :sessionId), 0) + 1,
            :authorId, :mode, :text, :riskLabel, :riskCategories
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      sessionId: p.uuid(input.sessionId),
      authorId: p.uuid(input.authorId),
      mode: p.text(input.mode),
      text: p.text(input.founderText),
      riskLabel: p.nullable.text(input.riskLabel),
      riskCategories: p.textArray(input.riskCategories ?? []),
    },
    decodeTurn,
    'createTurn',
  );
}

export interface FinishTurnInput {
  readonly turnId: string;
  readonly status: Exclude<TurnStatusValue, 'pending'>;
  readonly response?: CoachResponseValue | null;
  readonly riskLabel?: string | null;
  readonly riskCategories?: readonly string[];
  readonly validatorResults?: ValidatorResultsValue | null;
  readonly modelId?: string | null;
  readonly fallbackUsed?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly latencyMs?: number | null;
  readonly sampledForReview?: boolean;
  /** Mode actually used (the model may switch e.g. to route). */
  readonly mode?: CoachModeValue;
}

/** Completes, blocks or fails a pending turn. Returns null when the turn is not pending/visible. */
export function finishTurn(ex: SqlExecutor, input: FinishTurnInput): Promise<TurnRecord | null> {
  return queryFirst(
    ex,
    `UPDATE turns AS t SET
       status = :status,
       response = :response,
       mode = coalesce(:mode, t.mode),
       risk_label = coalesce(:riskLabel, t.risk_label),
       risk_categories = coalesce(:riskCategories, t.risk_categories),
       validator_results = coalesce(:validator, '{}'::jsonb),
       model_id = :modelId,
       fallback_used = :fallbackUsed,
       input_tokens = :inputTokens,
       output_tokens = :outputTokens,
       cost_usd = :costUsd,
       latency_ms = :latencyMs,
       sampled_for_review = :sampled,
       completed_at = now()
     WHERE t.id = :id AND t.status = 'pending'
     RETURNING ${COLUMNS}`,
    {
      id: p.uuid(input.turnId),
      status: p.text(input.status),
      response: p.nullable.json(input.response),
      mode: p.nullable.text(input.mode),
      riskLabel: p.nullable.text(input.riskLabel),
      riskCategories: p.nullable.textArray(input.riskCategories),
      validator: p.nullable.json(input.validatorResults),
      modelId: p.nullable.text(input.modelId),
      fallbackUsed: p.bool(input.fallbackUsed ?? false),
      inputTokens: p.int(input.inputTokens ?? 0),
      outputTokens: p.int(input.outputTokens ?? 0),
      costUsd: p.num(input.costUsd ?? 0),
      latencyMs: p.nullable.int(input.latencyMs),
      sampled: p.bool(input.sampledForReview ?? false),
    },
    decodeTurn,
  );
}

/** Text that replaces the founder's words when an ephemeral session ends. */
export const EPHEMERAL_REDACTION_TEXT = '[ephemeral session: content removed]';

/**
 * Removes the conversation content of every turn of a session (ephemeral sessions keep no content beyond
 * security records once they end): the founder text is replaced and the structured response dropped.
 * Run it in the caller's RLS transaction (the `turns_update` policy limits it to ventures the caller may
 * write). Returns the number of turns redacted.
 */
export async function redactSessionTurns(ex: SqlExecutor, sessionId: string): Promise<number> {
  const result = await ex.query(
    'UPDATE turns SET founder_text = :redacted, response = NULL WHERE session_id = :sessionId',
    { sessionId: p.uuid(sessionId), redacted: p.text(EPHEMERAL_REDACTION_TEXT) },
  );
  return result.rowCount;
}

// ------------------------------------------------------------------------------------------------
// Evidence
// ------------------------------------------------------------------------------------------------

export interface TurnEvidenceInput {
  /** `E1`…`En` as shown to the model and the founder. */
  readonly key: string;
  readonly kind: z.infer<typeof EvidenceKind>;
  readonly refId: string;
  readonly score: number;
  readonly title: string;
  /** Venture of venture-scoped evidence (memory, venture chunks); null for shared corpora. */
  readonly ventureId?: string | null;
}

/** Stores the evidence pack of a turn (one statement). */
export async function insertTurnEvidence(
  ex: SqlExecutor,
  turnId: string,
  items: readonly TurnEvidenceInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const result = await ex.query(
    `INSERT INTO turn_evidence (turn_id, evidence_key, venture_id, kind, ref_id, score, title)
     SELECT :turnId, x.key, x.venture_id, x.kind, x.ref_id, x.score, x.title
     FROM jsonb_to_recordset(:rows) AS x (key text, venture_id uuid, kind text, ref_id uuid, score real, title text)`,
    {
      turnId: p.uuid(turnId),
      rows: p.json(
        items.map((i) => ({
          key: i.key,
          venture_id: i.ventureId ?? null,
          kind: i.kind,
          ref_id: i.refId,
          score: Number.isFinite(i.score) ? i.score : 0,
          title: i.title,
        })),
      ),
    },
  );
  return result.rowCount;
}

/**
 * Evidence items of the given turns (contract `EvidenceItem` with current excerpt, freshness and status
 * joined from the referenced object; an object no longer visible yields an empty excerpt).
 */
export async function listTurnEvidence(
  ex: SqlExecutor,
  turnIds: readonly string[],
): Promise<Map<string, EvidenceItemValue[]>> {
  const out = new Map<string, EvidenceItemValue[]>();
  // Up to ~24 items per turn with a 600-character excerpt each: a few turns per statement (Data API 1 MB).
  for (let i = 0; i < turnIds.length; i += TURN_BATCH_SIZE) {
    await readTurnEvidence(ex, turnIds.slice(i, i + TURN_BATCH_SIZE), out);
  }
  return out;
}

async function readTurnEvidence(
  ex: SqlExecutor,
  turnIds: readonly string[],
  out: Map<string, EvidenceItemValue[]>,
): Promise<void> {
  if (turnIds.length === 0) return;
  const rows = await queryRows(
    ex,
    `SELECT te.turn_id, te.evidence_key, te.kind, te.ref_id, te.score, te.title,
            coalesce(${excerptSql('m.content')}, ${excerptSql('c.content')}, ${excerptSql('r.description')},
                     ${excerptSql('pt.signal')}, '') AS excerpt,
            coalesce(m.updated_at, s.freshness_at, r.freshness_at, pt.created_at) AS freshness_at,
            coalesce(m.status, s.status, r.status, pt.status) AS status
     FROM turn_evidence te
     LEFT JOIN memory_objects m ON te.kind = 'memory' AND m.id = te.ref_id
     LEFT JOIN knowledge_chunks c ON te.kind IN ('chunk', 'doctrine') AND c.id = te.ref_id
     LEFT JOIN knowledge_sources s ON s.id = c.source_id
     LEFT JOIN resources r ON te.kind = 'resource' AND r.id = te.ref_id
     LEFT JOIN patterns pt ON te.kind = 'pattern' AND pt.id = te.ref_id
     WHERE te.turn_id = ANY (:ids)
     ORDER BY te.turn_id, length(te.evidence_key), te.evidence_key`,
    { ids: p.uuidArray(turnIds) },
    (r) => ({
      turnId: col.uuid.decode(r.turn_id, 'turn_id'),
      item: {
        key: col.text.decode(r.evidence_key, 'evidence_key'),
        kind: col.enum(EvidenceKind.options).decode(r.kind, 'kind'),
        refId: col.uuid.decode(r.ref_id, 'ref_id'),
        title: col.text.decode(r.title, 'title'),
        excerpt: col.text.decode(r.excerpt, 'excerpt'),
        score: col.num.decode(r.score, 'score'),
        freshnessAt: col.ts.nullable.decode(r.freshness_at, 'freshness_at'),
        status: col.text.nullable.decode(r.status, 'status'),
      } satisfies EvidenceItemValue,
    }),
  );
  for (const { turnId, item } of rows) {
    const list = out.get(turnId) ?? [];
    list.push(item);
    out.set(turnId, list);
  }
}

/**
 * Why a blocked turn was blocked (`turn.blocked` `reason`), derived from what was stored when it was
 * blocked: the crisis path, then the validator's outcome in the order the validator applies it. Null for
 * turns that are not blocked.
 */
export function blockedReason(
  turn: Pick<TurnRecord, 'status' | 'riskLabel' | 'validatorResults'>,
): string | null {
  if (turn.status !== 'blocked') return null;
  if (turn.riskLabel === 'crisis') return 'crisis_support';
  const validator = turn.validatorResults;
  if (validator?.notes.some((note) => note.startsWith('invalid_schema'))) return 'invalid_schema';
  if (validator?.crossVentureViolation === true) return 'cross_venture';
  if (validator?.identityViolation === true) return 'identity';
  return 'blocked';
}

/**
 * Assembles the contract `TurnView`. `blocked` must be set for blocked turns (see
 * {@link blockedReason}); it is ignored for any other status.
 */
export function toTurnView(
  turn: TurnRecord,
  evidence: readonly EvidenceItemValue[],
  blocked: TurnBlockedDetail | null,
): TurnView {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    ordinal: turn.ordinal,
    mode: turn.mode,
    founderText: turn.founderText,
    status: turn.status,
    response: turn.response,
    evidence: [...evidence],
    validator: turn.validatorResults,
    usage: turn.modelId
      ? {
          modelId: turn.modelId,
          fallbackUsed: turn.fallbackUsed,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          costUsd: turn.costUsd,
          latencyMs: turn.latencyMs ?? 0,
        }
      : null,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
    blocked: turn.status === 'blocked' ? blocked : null,
  };
}

/**
 * Turns of a session as contract `TurnView`s (two queries, plus one for the escalations of blocked turns).
 * Blocked turns carry their reason, the escalation drafted for them (when the caller may read it) and the
 * support message `supportMessageFor` returns for the reason (the crisis message lives in packages/ai).
 */
export async function listTurnViews(
  ex: SqlExecutor,
  sessionId: string,
  supportMessageFor: (reason: string) => string | null,
): Promise<TurnView[]> {
  const turns = await listTurns(ex, sessionId);
  const evidence = await listTurnEvidence(
    ex,
    turns.map((t) => t.id),
  );
  const escalations = await escalationIdsByTurn(
    ex,
    turns.filter((t) => t.status === 'blocked').map((t) => t.id),
  );
  return turns.map((t) => {
    const reason = blockedReason(t);
    const blocked =
      reason === null
        ? null
        : {
            reason,
            supportMessage: supportMessageFor(reason),
            escalationId: escalations.get(t.id) ?? null,
          };
    return toTurnView(t, evidence.get(t.id) ?? [], blocked);
  });
}

// ------------------------------------------------------------------------------------------------
// Feedback and EIR calibration reviews
// ------------------------------------------------------------------------------------------------

export interface FeedbackInput {
  readonly turnId: string;
  readonly ventureId: string;
  /** Must be the request principal under RLS. */
  readonly principalId: string;
  readonly rating: number;
  readonly flags?: readonly string[];
  readonly comment?: string | null;
}

/** Creates or replaces the principal's rating of a turn. Returns the feedback id. */
export function upsertFeedback(ex: SqlExecutor, input: FeedbackInput): Promise<string> {
  return queryOne(
    ex,
    `INSERT INTO feedback (turn_id, venture_id, principal_id, rating, flags, comment)
     VALUES (:turnId, :ventureId, :principalId, :rating, :flags, :comment)
     ON CONFLICT (turn_id, principal_id) DO UPDATE
       SET rating = EXCLUDED.rating, flags = EXCLUDED.flags, comment = EXCLUDED.comment, created_at = now()
     RETURNING id`,
    {
      turnId: p.uuid(input.turnId),
      ventureId: p.uuid(input.ventureId),
      principalId: p.uuid(input.principalId),
      rating: p.int(input.rating),
      flags: p.textArray(input.flags ?? []),
      comment: p.nullable.text(input.comment),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'upsertFeedback',
  );
}

export interface ReviewQueueRow {
  readonly turn: TurnRecord;
  readonly ventureId: string;
  readonly ventureName: string;
  readonly reviewed: boolean;
}

/**
 * Sampled turns of ventures where `reviewerId` is the assigned EIR (explicit filter; RLS additionally
 * restricts EIRs to sampled turns of assigned ventures). Unreviewed first, newest first.
 */
export async function listReviewQueue(
  ex: SqlExecutor,
  args: { reviewerId: string; limit?: number },
): Promise<ReviewQueueRow[]> {
  // Ids and metadata first, then the full turns in batches (Data API 1 MB).
  const entries = await queryRows(
    ex,
    `SELECT t.id, v.id AS venture_id, v.name AS venture_name,
            EXISTS (SELECT 1 FROM eir_reviews er WHERE er.turn_id = t.id AND er.reviewer_id = :reviewerId) AS reviewed
     FROM turns t
     JOIN ventures v ON v.id = t.venture_id
     WHERE t.sampled_for_review AND t.status = 'completed'
       AND EXISTS (SELECT 1 FROM assignments a JOIN eir_profiles e ON e.id = a.eir_profile_id
                   WHERE a.venture_id = t.venture_id AND a.status = 'active' AND e.principal_id = :reviewerId
                     AND (a.expires_at IS NULL OR a.expires_at > now()))
     ORDER BY reviewed, t.created_at DESC
     LIMIT :limit`,
    { reviewerId: p.uuid(args.reviewerId), limit: p.int(clampLimit(args.limit, 50, 200)) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      ventureName: col.text.decode(r.venture_name, 'venture_name'),
      reviewed: col.bool.decode(r.reviewed, 'reviewed'),
    }),
  );
  const turns = new Map(
    (
      await getTurnsByIds(
        ex,
        entries.map((e) => e.id),
      )
    ).map((t) => [t.id, t] as const),
  );
  return entries.flatMap((e) => {
    const turn = turns.get(e.id);
    return turn ? [{ turn, ventureId: e.ventureId, ventureName: e.ventureName, reviewed: e.reviewed }] : [];
  });
}

export interface EirReviewInput {
  readonly turnId: string;
  readonly ventureId: string;
  /** Must be the request principal under RLS (assigned EIR). */
  readonly reviewerId: string;
  /** correctness, rigor, specificity, teachability, personaFit, escalation (1–5). */
  readonly scores: Readonly<Record<string, number>>;
  readonly notes?: string | null;
}

/** Creates or replaces the reviewer's blind rubric scores for a sampled turn. Returns the review id. */
export function upsertEirReview(ex: SqlExecutor, input: EirReviewInput): Promise<string> {
  return queryOne(
    ex,
    `INSERT INTO eir_reviews (turn_id, venture_id, reviewer_id, scores, notes)
     VALUES (:turnId, :ventureId, :reviewerId, :scores, :notes)
     ON CONFLICT (turn_id, reviewer_id) DO UPDATE
       SET scores = EXCLUDED.scores, notes = EXCLUDED.notes, created_at = now()
     RETURNING id`,
    {
      turnId: p.uuid(input.turnId),
      ventureId: p.uuid(input.ventureId),
      reviewerId: p.uuid(input.reviewerId),
      scores: p.json(input.scores),
      notes: p.nullable.text(input.notes),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'upsertEirReview',
  );
}
