/**
 * Platform insights: how the platform is used, read as aggregates and per-row metadata (ids, counts, codes,
 * timings), plus the content reads of the operator export. SystemExecutor only: the operator's insights job
 * reads every tenant, Admin → Usage passes the admin's tenant. Every statement here is a read; callers run
 * them in a read-only transaction (`SET TRANSACTION READ ONLY`, see {@link beginReadOnly}).
 *
 * The metadata functions never select content: no founder text, answers, digests, notebook or memory text,
 * titles, names or codes. Numbers derived from content (answer length, question marks) are computed in SQL so
 * the text never leaves the database for them. The `export*` functions read content and exist only for the
 * operator export, which encrypts it before it leaves the function that read it.
 */
import { col, type RawRow } from '../columns.js';
import { type SystemExecutor } from '../executor.js';
import { p, type SqlParam } from '../params.js';
import { clampLimit, fetchByIdsInBatches, queryRows } from './common.js';

/** Longest window the insights read (days); usage, logs and audit are kept at least this long. */
export const MAX_INSIGHTS_DAYS = 90;
/** Most conversations or calls listed per read. */
export const MAX_INSIGHTS_ROWS = 500;

/** Makes the caller's transaction read-only. Must be the transaction's first statement. */
export async function beginReadOnly(sx: SystemExecutor): Promise<void> {
  await sx.query('SET TRANSACTION READ ONLY');
}

export interface InsightsScope {
  /** Window in days ending now (1…{@link MAX_INSIGHTS_DAYS}). */
  readonly days: number;
  /** Only this tenant (Admin → Usage); null or absent: every tenant (the operator job). */
  readonly tenantId?: string | null;
}

function scopeParams(scope: InsightsScope): { readonly days: SqlParam; readonly tenant: SqlParam } {
  return {
    days: p.int(clampLimit(scope.days, 30, MAX_INSIGHTS_DAYS)),
    tenant: p.nullable.uuid(scope.tenantId ?? null),
  };
}

const SINCE = 'now() - make_interval(days => :days)';

const int = (r: RawRow, key: string): number => col.int.decode(r[key], key);
const intOrNull = (r: RawRow, key: string): number | null => col.int.nullable.decode(r[key], key);
const numOrNull = (r: RawRow, key: string): number | null => {
  const value = col.num.nullable.decode(r[key], key);
  return value === null ? null : Math.round(value);
};
const ts = (r: RawRow, key: string): string => col.ts.decode(r[key], key);
const tsOrNull = (r: RawRow, key: string): string | null => col.ts.nullable.decode(r[key], key);
const bool = (r: RawRow, key: string): boolean => col.bool.decode(r[key], key);

// ---------------------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------------------

/** One conversation as metadata (no title, goal, digest or opener text). */
export interface ConversationInsight {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly personaId: string;
  readonly privacy: 'standard' | 'ephemeral';
  readonly status: string;
  /** `voice` when any turn was spoken during a call. */
  readonly channel: 'text' | 'voice';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly lastActivityAt: string;
  readonly deleted: boolean;
  readonly turns: {
    readonly completed: number;
    readonly blocked: number;
    readonly failed: number;
    readonly pending: number;
    readonly voice: number;
  };
  readonly firstTurnAt: string | null;
  readonly lastTurnAt: string | null;
  readonly calls: number;
  readonly distilledAt: string | null;
  /** Completed turns the stored digest (or the recorded outcome) covers. */
  readonly distillVersion: number;
  readonly hasDigest: boolean;
  readonly digestDeleted: boolean;
  readonly unusableAnswers: number;
  /** A distillation holds the conversation now. */
  readonly distillRunning: boolean;
  readonly hasOpener: boolean;
  /** The conversation the opener was written from (the notebook's source), when known. */
  readonly openerSourceSessionId: string | null;
  readonly openerByPerson: boolean;
}

/** Conversations active in the window (started or with activity), oldest first. */
export function listConversations(
  sx: SystemExecutor,
  scope: InsightsScope & { readonly limit?: number },
): Promise<ConversationInsight[]> {
  return queryRows(
    sx,
    `SELECT s.id, s.tenant_id, s.venture_id, r.persona_id, s.privacy, s.status, s.has_calls, s.started_at,
            s.ended_at, s.last_activity_at, (s.deleted_at IS NOT NULL) AS deleted, s.distilled_at,
            s.distill_version, (s.digest IS NOT NULL) AS has_digest, (s.digest_deleted_at IS NOT NULL) AS digest_deleted,
            s.distill_unusable_answers,
            (s.distill_claimed_until IS NOT NULL AND s.distill_claimed_until > now()) AS distill_running,
            (s.opener IS NOT NULL) AS has_opener, s.opener_source_session_id, s.opener_by_person,
            coalesce(t.completed, 0) AS completed, coalesce(t.blocked, 0) AS blocked, coalesce(t.failed, 0) AS failed,
            coalesce(t.pending, 0) AS pending, coalesce(t.voice, 0) AS voice, t.first_at, t.last_at,
            coalesce(c.calls, 0) AS calls
     FROM coaching_sessions s
     JOIN persona_releases r ON r.id = s.persona_release_id
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE x.status = 'completed') AS completed,
              count(*) FILTER (WHERE x.status = 'blocked') AS blocked,
              count(*) FILTER (WHERE x.status = 'failed') AS failed,
              count(*) FILTER (WHERE x.status = 'pending') AS pending,
              count(*) FILTER (WHERE x.channel = 'voice') AS voice,
              min(x.created_at) AS first_at, max(x.created_at) AS last_at
       FROM turns x WHERE x.session_id = s.id) t ON true
     LEFT JOIN LATERAL (SELECT count(*) AS calls FROM calls k WHERE k.session_id = s.id) c ON true
     WHERE (s.started_at >= ${SINCE} OR s.last_activity_at >= ${SINCE})
       AND (:tenant IS NULL OR s.tenant_id = :tenant)
     ORDER BY s.started_at, s.id
     LIMIT :limit`,
    { ...scopeParams(scope), limit: p.int(clampLimit(scope.limit, MAX_INSIGHTS_ROWS, MAX_INSIGHTS_ROWS)) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      personaId: col.uuid.decode(r.persona_id, 'persona_id'),
      privacy: col.enum(['standard', 'ephemeral'] as const).decode(r.privacy, 'privacy'),
      status: col.text.decode(r.status, 'status'),
      channel: bool(r, 'has_calls') ? 'voice' : 'text',
      startedAt: ts(r, 'started_at'),
      endedAt: tsOrNull(r, 'ended_at'),
      lastActivityAt: ts(r, 'last_activity_at'),
      deleted: bool(r, 'deleted'),
      turns: {
        completed: int(r, 'completed'),
        blocked: int(r, 'blocked'),
        failed: int(r, 'failed'),
        pending: int(r, 'pending'),
        voice: int(r, 'voice'),
      },
      firstTurnAt: tsOrNull(r, 'first_at'),
      lastTurnAt: tsOrNull(r, 'last_at'),
      calls: int(r, 'calls'),
      distilledAt: tsOrNull(r, 'distilled_at'),
      distillVersion: int(r, 'distill_version'),
      hasDigest: bool(r, 'has_digest'),
      digestDeleted: bool(r, 'digest_deleted'),
      unusableAnswers: int(r, 'distill_unusable_answers'),
      distillRunning: bool(r, 'distill_running'),
      hasOpener: bool(r, 'has_opener'),
      openerSourceSessionId: col.uuid.nullable.decode(r.opener_source_session_id, 'opener_source_session_id'),
      openerByPerson: bool(r, 'opener_by_person'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------------------

export interface CallInsight {
  readonly id: string;
  readonly sessionId: string;
  readonly ventureId: string;
  readonly status: string;
  readonly provider: string;
  readonly inputMode: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Ended (or last heartbeat) minus start. */
  readonly seconds: number;
  readonly endReason: string | null;
  readonly endDetail: string | null;
  readonly lastState: string | null;
  readonly micOpenSeconds: number;
  readonly sttGrants: number;
  readonly speechCharacters: number;
  readonly firstAudioMsP50: number | null;
  readonly firstAudioMsP95: number | null;
  readonly bargeIns: number | null;
  readonly reconnects: number | null;
  readonly turns: number;
  readonly interruptedTurns: number;
  readonly speechUnits: number;
  readonly speechPlays: number;
  readonly turnLatencyMsP50: number | null;
  readonly turnLatencyMsP95: number | null;
}

/** Calls started in the window, oldest first. */
export function listCalls(
  sx: SystemExecutor,
  scope: InsightsScope & { readonly limit?: number },
): Promise<CallInsight[]> {
  return queryRows(
    sx,
    `SELECT c.id, c.session_id, c.venture_id, c.status, c.provider, c.input_mode, c.started_at, c.ended_at,
            greatest(0, extract(epoch FROM coalesce(c.ended_at, c.last_heartbeat_at, c.started_at) - c.started_at))
              AS seconds,
            c.end_reason, c.end_detail, c.last_state, c.mic_open_seconds, c.stt_grants, c.speech_characters,
            c.first_audio_ms_p50, c.first_audio_ms_p95, c.barge_ins, c.reconnects,
            coalesce(t.turns, 0) AS turns, coalesce(t.interrupted, 0) AS interrupted, t.p50, t.p95,
            coalesce(u.units, 0) AS units, coalesce(u.plays, 0) AS plays
     FROM calls c
     LEFT JOIN LATERAL (
       SELECT count(*) AS turns, count(*) FILTER (WHERE x.interrupted_at IS NOT NULL) AS interrupted,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY x.latency_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY x.latency_ms) AS p95
       FROM turns x WHERE x.call_id = c.id) t ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS units, sum(y.plays) AS plays FROM call_speech y WHERE y.call_id = c.id) u ON true
     WHERE c.started_at >= ${SINCE} AND (:tenant IS NULL OR c.tenant_id = :tenant)
     ORDER BY c.started_at, c.id
     LIMIT :limit`,
    { ...scopeParams(scope), limit: p.int(clampLimit(scope.limit, MAX_INSIGHTS_ROWS, MAX_INSIGHTS_ROWS)) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      sessionId: col.uuid.decode(r.session_id, 'session_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      status: col.text.decode(r.status, 'status'),
      provider: col.text.decode(r.provider, 'provider'),
      inputMode: col.text.decode(r.input_mode, 'input_mode'),
      startedAt: ts(r, 'started_at'),
      endedAt: tsOrNull(r, 'ended_at'),
      seconds: numOrNull(r, 'seconds') ?? 0,
      endReason: col.text.nullable.decode(r.end_reason, 'end_reason'),
      endDetail: col.text.nullable.decode(r.end_detail, 'end_detail'),
      lastState: col.text.nullable.decode(r.last_state, 'last_state'),
      micOpenSeconds: int(r, 'mic_open_seconds'),
      sttGrants: int(r, 'stt_grants'),
      speechCharacters: int(r, 'speech_characters'),
      firstAudioMsP50: intOrNull(r, 'first_audio_ms_p50'),
      firstAudioMsP95: intOrNull(r, 'first_audio_ms_p95'),
      bargeIns: intOrNull(r, 'barge_ins'),
      reconnects: intOrNull(r, 'reconnects'),
      turns: int(r, 'turns'),
      interruptedTurns: int(r, 'interrupted'),
      speechUnits: int(r, 'units'),
      speechPlays: numOrNull(r, 'plays') ?? 0,
      turnLatencyMsP50: numOrNull(r, 'p50'),
      turnLatencyMsP95: numOrNull(r, 'p95'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Turns: latency, outcomes, validator codes and the shape of answers (numbers only)
// ---------------------------------------------------------------------------------------------------------

export interface TurnInsight {
  readonly channel: 'text' | 'voice';
  readonly turns: number;
  readonly completed: number;
  readonly blocked: number;
  readonly failed: number;
  readonly pending: number;
  readonly fallbackUsed: number;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
  readonly firstTokenMsP50: number | null;
  readonly firstTokenMsP95: number | null;
  readonly outputTokensAvg: number | null;
  /** Characters of the answer (completed turns). */
  readonly answerCharsP50: number | null;
  readonly answerCharsP95: number | null;
  /** Characters of the spoken form (voice turns). */
  readonly spokenCharsP50: number | null;
  /** Question marks per answer, times 100 (two decimals as an integer). */
  readonly questionMarksPerAnswerX100: number | null;
  readonly followUpQuestionsAvgX100: number | null;
  readonly nextActionsAvgX100: number | null;
  readonly claimsAvgX100: number | null;
  /** Answers with a challenge line. */
  readonly withChallenge: number;
  readonly identityViolations: number;
  readonly crossVentureViolations: number;
  readonly narrowed: number;
  readonly escalationForced: number;
  readonly factsDowngraded: number;
  readonly evidenceIdsRemoved: number;
  readonly founderCharsP50: number | null;
}

const ANSWER = `(x.response ->> 'answer')`;

/** Turn statistics per channel over the window. */
export function turnStats(sx: SystemExecutor, scope: InsightsScope): Promise<TurnInsight[]> {
  return queryRows(
    sx,
    `SELECT x.channel, count(*) AS turns,
            count(*) FILTER (WHERE x.status = 'completed') AS completed,
            count(*) FILTER (WHERE x.status = 'blocked') AS blocked,
            count(*) FILTER (WHERE x.status = 'failed') AS failed,
            count(*) FILTER (WHERE x.status = 'pending') AS pending,
            count(*) FILTER (WHERE x.fallback_used) AS fallback_used,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY x.latency_ms) AS latency_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY x.latency_ms) AS latency_p95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY x.first_token_ms) AS first_token_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY x.first_token_ms) AS first_token_p95,
            avg(x.output_tokens) FILTER (WHERE x.status = 'completed') AS output_tokens_avg,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY length(${ANSWER})) AS answer_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY length(${ANSWER})) AS answer_p95,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY length(x.response ->> 'spoken')) AS spoken_p50,
            100 * avg(length(${ANSWER}) - length(replace(${ANSWER}, '?', ''))) AS question_marks_x100,
            100 * avg(jsonb_array_length(x.response -> 'follow_up_questions'))
              FILTER (WHERE jsonb_typeof(x.response -> 'follow_up_questions') = 'array') AS follow_ups_x100,
            100 * avg(jsonb_array_length(x.response -> 'next_actions'))
              FILTER (WHERE jsonb_typeof(x.response -> 'next_actions') = 'array') AS next_actions_x100,
            100 * avg(jsonb_array_length(x.response -> 'claims'))
              FILTER (WHERE jsonb_typeof(x.response -> 'claims') = 'array') AS claims_x100,
            count(*) FILTER (WHERE coalesce(x.response ->> 'challenge', '') <> '') AS with_challenge,
            count(*) FILTER (WHERE x.validator_results ->> 'identityViolation' = 'true') AS identity,
            count(*) FILTER (WHERE x.validator_results ->> 'crossVentureViolation' = 'true') AS cross_venture,
            count(*) FILTER (WHERE x.validator_results ->> 'narrowed' = 'true') AS narrowed,
            count(*) FILTER (WHERE x.validator_results ->> 'escalationForced' = 'true') AS escalation_forced,
            count(*) FILTER (WHERE (x.validator_results ->> 'factsDowngraded') ~ '^[1-9][0-9]*$') AS facts_downgraded,
            count(*) FILTER (WHERE (x.validator_results ->> 'unknownEvidenceIdsRemoved') ~ '^[1-9][0-9]*$')
              AS evidence_removed,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY length(x.founder_text)) AS founder_p50
     FROM turns x
     WHERE x.created_at >= ${SINCE} AND (:tenant IS NULL OR x.tenant_id = :tenant)
     GROUP BY x.channel
     ORDER BY x.channel`,
    scopeParams(scope),
    (r) => ({
      channel: col.enum(['text', 'voice'] as const).decode(r.channel, 'channel'),
      turns: int(r, 'turns'),
      completed: int(r, 'completed'),
      blocked: int(r, 'blocked'),
      failed: int(r, 'failed'),
      pending: int(r, 'pending'),
      fallbackUsed: int(r, 'fallback_used'),
      latencyMsP50: numOrNull(r, 'latency_p50'),
      latencyMsP95: numOrNull(r, 'latency_p95'),
      firstTokenMsP50: numOrNull(r, 'first_token_p50'),
      firstTokenMsP95: numOrNull(r, 'first_token_p95'),
      outputTokensAvg: numOrNull(r, 'output_tokens_avg'),
      answerCharsP50: numOrNull(r, 'answer_p50'),
      answerCharsP95: numOrNull(r, 'answer_p95'),
      spokenCharsP50: numOrNull(r, 'spoken_p50'),
      questionMarksPerAnswerX100: numOrNull(r, 'question_marks_x100'),
      followUpQuestionsAvgX100: numOrNull(r, 'follow_ups_x100'),
      nextActionsAvgX100: numOrNull(r, 'next_actions_x100'),
      claimsAvgX100: numOrNull(r, 'claims_x100'),
      withChallenge: int(r, 'with_challenge'),
      identityViolations: int(r, 'identity'),
      crossVentureViolations: int(r, 'cross_venture'),
      narrowed: int(r, 'narrowed'),
      escalationForced: int(r, 'escalation_forced'),
      factsDowngraded: int(r, 'facts_downgraded'),
      evidenceIdsRemoved: int(r, 'evidence_removed'),
      founderCharsP50: numOrNull(r, 'founder_p50'),
    }),
  );
}

/** Validator note codes are `code` or `code:count`; anything else is reported as `other`. */
const NOTE_CODE = /^[a-z][a-z0-9_]{0,47}$/;

/** Validator note codes (the part before `:`) and how many turns carried each, over the window. */
export async function validatorNoteCounts(
  sx: SystemExecutor,
  scope: InsightsScope,
): Promise<{ readonly code: string; readonly turns: number }[]> {
  const rows = await queryRows(
    sx,
    `SELECT split_part(n.note, ':', 1) AS code, count(DISTINCT x.id) AS turns
     FROM turns x
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(x.validator_results -> 'notes') = 'array' THEN x.validator_results -> 'notes'
            ELSE '[]'::jsonb END) AS n(note)
     WHERE x.created_at >= ${SINCE} AND (:tenant IS NULL OR x.tenant_id = :tenant)
     GROUP BY 1
     ORDER BY 2 DESC, 1`,
    scopeParams(scope),
    (r) => ({ code: col.text.decode(r.code, 'code'), turns: int(r, 'turns') }),
  );
  const merged = new Map<string, number>();
  for (const row of rows) {
    const code = NOTE_CODE.test(row.code) ? row.code : 'other';
    merged.set(code, (merged.get(code) ?? 0) + row.turns);
  }
  return [...merged].map(([code, turns]) => ({ code, turns }));
}

// ---------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------

export interface UsageInsight {
  readonly purpose: string;
  readonly modelId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

/** The usage ledger by purpose and model over the window, most expensive first. */
export function usageByPurposeAndModel(sx: SystemExecutor, scope: InsightsScope): Promise<UsageInsight[]> {
  return queryRows(
    sx,
    `SELECT u.purpose, u.model_id, count(*) AS calls, coalesce(sum(u.input_tokens), 0) AS input_tokens,
            coalesce(sum(u.output_tokens), 0) AS output_tokens, coalesce(sum(u.cost_usd), 0) AS usd
     FROM usage_ledger u
     WHERE u.at >= ${SINCE} AND (:tenant IS NULL OR u.tenant_id = :tenant)
     GROUP BY u.purpose, u.model_id
     ORDER BY usd DESC, u.purpose, u.model_id`,
    scopeParams(scope),
    (r) => ({
      purpose: col.text.decode(r.purpose, 'purpose'),
      modelId: col.text.decode(r.model_id, 'model_id'),
      calls: int(r, 'calls'),
      inputTokens: col.num.decode(r.input_tokens, 'input_tokens'),
      outputTokens: col.num.decode(r.output_tokens, 'output_tokens'),
      usd: col.num.decode(r.usd, 'usd'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Knowledge per venture: digests, notebooks, memory, lessons (counts)
// ---------------------------------------------------------------------------------------------------------

export interface VentureKnowledgeInsight {
  readonly ventureId: string;
  /** For Admin → Usage only; the operator job never reports it. */
  readonly ventureName: string;
  readonly conversations: number;
  readonly digests: number;
  readonly notebooks: number;
  readonly notebookVersion: number | null;
  readonly notebookUpdatedAt: string | null;
  readonly notebookHasNextOpener: boolean;
  readonly notebookCommitments: number;
  readonly notebookOpenQuestions: number;
  readonly notebookProfileLines: number;
  readonly notebookAdviceLines: number;
  readonly memory: {
    readonly proposed: number;
    readonly confirmed: number;
    readonly rejected: number;
    readonly expired: number;
    readonly deleted: number;
    readonly other: number;
  };
  readonly memoryFromAi: number;
  readonly lessonsDrafted: number;
}

/** Every venture with a conversation (ever), with what its knowledge holds now. */
export function ventureKnowledge(
  sx: SystemExecutor,
  scope: InsightsScope,
): Promise<VentureKnowledgeInsight[]> {
  return queryRows(
    sx,
    `SELECT v.id, v.name,
            (SELECT count(*) FROM coaching_sessions s WHERE s.venture_id = v.id AND s.deleted_at IS NULL) AS conversations,
            (SELECT count(*) FROM coaching_sessions s
              WHERE s.venture_id = v.id AND s.deleted_at IS NULL AND s.digest IS NOT NULL) AS digests,
            n.notebooks, n.version, n.updated_at, coalesce(n.next_opener, false) AS next_opener,
            coalesce(n.commitments, 0) AS commitments, coalesce(n.open_questions, 0) AS open_questions,
            coalesce(n.profile, 0) AS profile, coalesce(n.advice, 0) AS advice,
            coalesce(m.proposed, 0) AS proposed, coalesce(m.confirmed, 0) AS confirmed,
            coalesce(m.rejected, 0) AS rejected, coalesce(m.expired, 0) AS expired,
            coalesce(m.deleted, 0) AS deleted, coalesce(m.other, 0) AS other, coalesce(m.from_ai, 0) AS from_ai,
            (SELECT count(*) FROM patterns pt JOIN coaching_sessions s ON s.id = pt.source_session_id
              WHERE s.venture_id = v.id AND pt.origin = 'distilled') AS lessons
     FROM ventures v
     LEFT JOIN LATERAL (
       SELECT count(*) AS notebooks, max(nb.version) AS version, max(nb.updated_at) AS updated_at,
              bool_or(coalesce(nb.content ->> 'nextOpener', '') <> '') AS next_opener,
              sum(jsonb_array_length(coalesce(nb.content -> 'commitments', '[]'::jsonb))) AS commitments,
              sum(jsonb_array_length(coalesce(nb.content -> 'openQuestions', '[]'::jsonb))) AS open_questions,
              sum(jsonb_array_length(coalesce(nb.content -> 'founderProfile', '[]'::jsonb))) AS profile,
              sum(jsonb_array_length(coalesce(nb.content -> 'lastAdvice', '[]'::jsonb))) AS advice
       FROM veir_notebooks nb WHERE nb.venture_id = v.id) n ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE mo.status = 'proposed') AS proposed,
              count(*) FILTER (WHERE mo.status = 'confirmed') AS confirmed,
              count(*) FILTER (WHERE mo.status = 'rejected') AS rejected,
              count(*) FILTER (WHERE mo.status = 'expired') AS expired,
              count(*) FILTER (WHERE mo.status = 'deleted') AS deleted,
              count(*) FILTER (WHERE mo.status IN ('disputed', 'superseded')) AS other,
              count(*) FILTER (WHERE mo.origin = 'ai') AS from_ai
       FROM memory_objects mo WHERE mo.venture_id = v.id) m ON true
     WHERE EXISTS (SELECT 1 FROM coaching_sessions s WHERE s.venture_id = v.id)
       AND (:tenant IS NULL OR v.tenant_id = :tenant)
       AND :days > 0
     ORDER BY v.created_at, v.id
     LIMIT ${String(MAX_INSIGHTS_ROWS)}`,
    scopeParams(scope),
    (r) => ({
      ventureId: col.uuid.decode(r.id, 'id'),
      ventureName: col.text.decode(r.name, 'name'),
      conversations: int(r, 'conversations'),
      digests: int(r, 'digests'),
      notebooks: int(r, 'notebooks'),
      notebookVersion: intOrNull(r, 'version'),
      notebookUpdatedAt: tsOrNull(r, 'updated_at'),
      notebookHasNextOpener: bool(r, 'next_opener'),
      notebookCommitments: int(r, 'commitments'),
      notebookOpenQuestions: int(r, 'open_questions'),
      notebookProfileLines: int(r, 'profile'),
      notebookAdviceLines: int(r, 'advice'),
      memory: {
        proposed: int(r, 'proposed'),
        confirmed: int(r, 'confirmed'),
        rejected: int(r, 'rejected'),
        expired: int(r, 'expired'),
        deleted: int(r, 'deleted'),
        other: int(r, 'other'),
      },
      memoryFromAi: int(r, 'from_ai'),
      lessonsDrafted: int(r, 'lessons'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Audit: what happened, as action / outcome / reason codes
// ---------------------------------------------------------------------------------------------------------

export interface AuditCountInsight {
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly events: number;
}

/** Audit events over the window by action, outcome and policy reason. */
export function auditCounts(sx: SystemExecutor, scope: InsightsScope): Promise<AuditCountInsight[]> {
  return queryRows(
    sx,
    `SELECT a.action, a.outcome, a.policy_reason, count(*) AS events
     FROM audit_events a
     WHERE a.at >= ${SINCE} AND (:tenant IS NULL OR a.tenant_id = :tenant)
     GROUP BY a.action, a.outcome, a.policy_reason
     ORDER BY a.action, a.outcome, a.policy_reason NULLS FIRST`,
    scopeParams(scope),
    (r) => ({
      action: col.text.decode(r.action, 'action'),
      outcome: col.text.decode(r.outcome, 'outcome'),
      reason: col.text.nullable.decode(r.policy_reason, 'policy_reason'),
      events: int(r, 'events'),
    }),
  );
}

export interface AuditEventInsight {
  readonly id: number;
  readonly at: string;
  readonly action: string;
  readonly outcome: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly ventureId: string | null;
  /** Audit metadata (ids, counts and codes by the audit contract). */
  readonly metadata: unknown;
}

/** Audit events of the window about conversations, calls, turns, notebooks, memory and lessons, by id. */
export function auditEvents(
  sx: SystemExecutor,
  scope: InsightsScope & { readonly afterId?: number; readonly limit?: number },
): Promise<AuditEventInsight[]> {
  return queryRows(
    sx,
    `SELECT a.id, a.at, a.action, a.outcome, a.object_type, a.object_id, a.policy_reason, a.request_id,
            a.venture_id, a.metadata
     FROM audit_events a
     WHERE a.at >= ${SINCE} AND (:tenant IS NULL OR a.tenant_id = :tenant) AND a.id > :afterId
       AND a.action NOT LIKE 'auth.%'
     ORDER BY a.id
     LIMIT :limit`,
    {
      ...scopeParams(scope),
      afterId: p.bigint(scope.afterId ?? 0),
      limit: p.int(clampLimit(scope.limit, 500, 1000)),
    },
    (r) => ({
      id: col.int.decode(r.id, 'id'),
      at: ts(r, 'at'),
      action: col.text.decode(r.action, 'action'),
      outcome: col.text.decode(r.outcome, 'outcome'),
      objectType: col.text.nullable.decode(r.object_type, 'object_type'),
      objectId: col.text.nullable.decode(r.object_id, 'object_id'),
      reason: col.text.nullable.decode(r.policy_reason, 'policy_reason'),
      requestId: col.text.nullable.decode(r.request_id, 'request_id'),
      ventureId: col.uuid.nullable.decode(r.venture_id, 'venture_id'),
      metadata: col.json().decode(r.metadata, 'metadata'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Per-turn trace from the turn audit (what the turn knew, how long it took): ids, flags, counts, timings
// ---------------------------------------------------------------------------------------------------------

export interface TurnTraceInsight {
  readonly turnId: string;
  readonly sessionId: string;
  readonly callId: string | null;
  readonly at: string;
  readonly ordinal: number;
  readonly outcome: 'completed' | 'blocked';
  readonly reason: string | null;
  readonly channel: string | null;
  /** The vEIR notebook was in the prompt. */
  readonly notebook: boolean | null;
  /** Digests of earlier conversations in the prompt. */
  readonly digests: number | null;
  readonly openerReplayed: boolean | null;
  readonly evidence: number | null;
  readonly memoryCandidates: number | null;
  readonly attempts: number | null;
  readonly fallbackUsed: boolean | null;
  readonly inputTokensEstimate: number | null;
  readonly stream: string | null;
  readonly totalMs: number | null;
  readonly modelMs: number | null;
  readonly firstTokenMs: number | null;
  readonly modelFirstTokenMs: number | null;
  readonly speechUnits: number | null;
  readonly gateIdentityRewrites: number | null;
}

const NUMERIC = "'^[0-9]+([.][0-9]+)?$'";
const metaNumber = (key: string): string =>
  `CASE WHEN a.metadata ->> '${key}' ~ ${NUMERIC} THEN (a.metadata ->> '${key}')::numeric END AS ${key.toLowerCase()}`;
const metaBool = (key: string): string =>
  `CASE WHEN a.metadata ->> '${key}' IN ('true', 'false') THEN (a.metadata ->> '${key}')::boolean END AS ${key.toLowerCase()}`;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const code = (value: string | null): string | null =>
  value === null ? null : CODE.test(value) ? value : 'other';
const metaInt = (r: RawRow, key: string): number | null => numOrNull(r, key.toLowerCase());
const metaFlag = (r: RawRow, key: string): boolean | null =>
  col.bool.nullable.decode(r[key.toLowerCase()], key);

/** Every answered or blocked turn of the window with its audit trace, oldest first. */
export function turnTrace(
  sx: SystemExecutor,
  scope: InsightsScope & { readonly limit?: number },
): Promise<TurnTraceInsight[]> {
  return queryRows(
    sx,
    `SELECT t.id, t.session_id, t.call_id, a.at, t.ordinal, a.action, a.policy_reason, a.metadata ->> 'channel' AS channel,
            a.metadata ->> 'stream' AS stream,
            ${metaBool('notebook')}, ${metaNumber('digests')}, ${metaBool('openerReplayed')}, ${metaNumber('evidence')},
            ${metaNumber('memoryCandidates')}, ${metaNumber('attempts')}, ${metaBool('fallbackUsed')},
            ${metaNumber('inputTokensEstimate')}, ${metaNumber('totalMs')}, ${metaNumber('modelMs')},
            ${metaNumber('firstTokenMs')}, ${metaNumber('modelFirstTokenMs')}, ${metaNumber('speechUnits')},
            ${metaNumber('gateIdentityRewrites')}
     FROM audit_events a
     JOIN turns t ON t.id::text = a.object_id
     WHERE a.action IN ('turn.completed', 'turn.blocked') AND a.object_type = 'turn'
       AND a.at >= ${SINCE} AND (:tenant IS NULL OR a.tenant_id = :tenant)
     ORDER BY a.at, a.id
     LIMIT :limit`,
    { ...scopeParams(scope), limit: p.int(clampLimit(scope.limit, 2_000, 5_000)) },
    (r) => ({
      turnId: col.uuid.decode(r.id, 'id'),
      sessionId: col.uuid.decode(r.session_id, 'session_id'),
      callId: col.uuid.nullable.decode(r.call_id, 'call_id'),
      at: ts(r, 'at'),
      ordinal: int(r, 'ordinal'),
      outcome: col.text.decode(r.action, 'action') === 'turn.blocked' ? 'blocked' : 'completed',
      reason: code(col.text.nullable.decode(r.policy_reason, 'policy_reason')),
      channel: code(col.text.nullable.decode(r.channel, 'channel')),
      notebook: metaFlag(r, 'notebook'),
      digests: metaInt(r, 'digests'),
      openerReplayed: metaFlag(r, 'openerReplayed'),
      evidence: metaInt(r, 'evidence'),
      memoryCandidates: metaInt(r, 'memoryCandidates'),
      attempts: metaInt(r, 'attempts'),
      fallbackUsed: metaFlag(r, 'fallbackUsed'),
      inputTokensEstimate: metaInt(r, 'inputTokensEstimate'),
      stream: code(col.text.nullable.decode(r.stream, 'stream')),
      totalMs: metaInt(r, 'totalMs'),
      modelMs: metaInt(r, 'modelMs'),
      firstTokenMs: metaInt(r, 'firstTokenMs'),
      modelFirstTokenMs: metaInt(r, 'modelFirstTokenMs'),
      speechUnits: metaInt(r, 'speechUnits'),
      gateIdentityRewrites: metaInt(r, 'gateIdentityRewrites'),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Operator export (content). Callers encrypt the result before it leaves the process.
// ---------------------------------------------------------------------------------------------------------

/** Voice fields of a conversation's turns (what was heard before an interruption, the call it belongs to). */
export interface ExportVoiceTurn {
  readonly turnId: string;
  readonly callId: string | null;
  readonly heardSeq: number | null;
  readonly interruptedAt: string | null;
  readonly heardText: string | null;
}

/** Voice fields of every voice turn of a conversation, in order (CONTENT: heard text). */
export function exportVoiceTurns(sx: SystemExecutor, sessionId: string): Promise<ExportVoiceTurn[]> {
  return queryRows(
    sx,
    `SELECT t.id, t.call_id, t.heard_seq, t.interrupted_at, t.heard_text
     FROM turns t WHERE t.session_id = :sessionId AND (t.call_id IS NOT NULL OR t.interrupted_at IS NOT NULL)
     ORDER BY t.ordinal`,
    { sessionId: p.uuid(sessionId) },
    (r) => ({
      turnId: col.uuid.decode(r.id, 'id'),
      callId: col.uuid.nullable.decode(r.call_id, 'call_id'),
      heardSeq: intOrNull(r, 'heard_seq'),
      interruptedAt: tsOrNull(r, 'interrupted_at'),
      heardText: col.text.nullable.decode(r.heard_text, 'heard_text'),
    }),
  );
}

export interface ExportSpeechUnit {
  readonly callId: string;
  readonly unit: string;
  readonly plays: number;
  readonly characters: number;
  readonly firstAt: string;
}

/** The speech units of calls (ids, plays and characters; the spoken text is not stored). */
export function exportSpeechUnits(
  sx: SystemExecutor,
  callIds: readonly string[],
): Promise<ExportSpeechUnit[]> {
  if (callIds.length === 0) return Promise.resolve([]);
  return queryRows(
    sx,
    `SELECT y.call_id, y.unit, y.plays, y.characters, y.first_at FROM call_speech y
     WHERE y.call_id = ANY (:ids) ORDER BY y.first_at, y.unit`,
    { ids: p.uuidArray(callIds) },
    (r) => ({
      callId: col.uuid.decode(r.call_id, 'call_id'),
      unit: col.text.decode(r.unit, 'unit'),
      plays: int(r, 'plays'),
      characters: int(r, 'characters'),
      firstAt: ts(r, 'first_at'),
    }),
  );
}

export interface ExportMemoryItem {
  readonly id: string;
  readonly ventureId: string;
  readonly type: string;
  readonly status: string;
  readonly origin: string;
  readonly visibility: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly sourceRefs: unknown;
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedAt: string | null;
}

/** Rows per statement: a memory item holds at most 8 000 characters (Data API 1 MB per result). */
const MEMORY_BATCH = 25;

/** Every memory item of the ventures (CONTENT), oldest first. */
export async function exportMemory(
  sx: SystemExecutor,
  ventureIds: readonly string[],
): Promise<ExportMemoryItem[]> {
  if (ventureIds.length === 0) return [];
  const ids = await queryRows(
    sx,
    'SELECT mo.id FROM memory_objects mo WHERE mo.venture_id = ANY (:ventures) ORDER BY mo.created_at, mo.id',
    { ventures: p.uuidArray(ventureIds) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return fetchByIdsInBatches(
    ids,
    MEMORY_BATCH,
    (batch) =>
      queryRows(
        sx,
        `SELECT mo.id, mo.venture_id, mo.type, mo.status, mo.origin, mo.visibility, mo.title, mo.content,
                mo.confidence, mo.source_refs, mo.pinned, mo.created_at, mo.updated_at, mo.approved_at
         FROM memory_objects mo WHERE mo.id = ANY (:ids)`,
        { ids: p.uuidArray(batch) },
        (r) => ({
          id: col.uuid.decode(r.id, 'id'),
          ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
          type: col.text.decode(r.type, 'type'),
          status: col.text.decode(r.status, 'status'),
          origin: col.text.decode(r.origin, 'origin'),
          visibility: col.text.decode(r.visibility, 'visibility'),
          title: col.text.decode(r.title, 'title'),
          content: col.text.decode(r.content, 'content'),
          confidence: col.num.decode(r.confidence, 'confidence'),
          sourceRefs: col.json().decode(r.source_refs, 'source_refs'),
          pinned: bool(r, 'pinned'),
          createdAt: ts(r, 'created_at'),
          updatedAt: ts(r, 'updated_at'),
          approvedAt: tsOrNull(r, 'approved_at'),
        }),
      ),
    (item) => item.id,
  );
}

export interface ExportLesson {
  readonly id: string;
  readonly sourceSessionId: string | null;
  readonly status: string;
  readonly title: string;
  readonly context: string;
  readonly signal: string;
  readonly intervention: string;
  readonly outcome: string;
  readonly limits: string;
  readonly createdAt: string;
}

/** Lessons distilled from the conversations (CONTENT, de-identified by distillation). */
export async function exportLessons(
  sx: SystemExecutor,
  sessionIds: readonly string[],
): Promise<ExportLesson[]> {
  if (sessionIds.length === 0) return [];
  const ids = await queryRows(
    sx,
    `SELECT pt.id FROM patterns pt WHERE pt.source_session_id = ANY (:sessions) AND pt.origin = 'distilled'
     ORDER BY pt.created_at, pt.id`,
    { sessions: p.uuidArray(sessionIds) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return fetchByIdsInBatches(
    ids,
    MEMORY_BATCH,
    (batch) =>
      queryRows(
        sx,
        `SELECT pt.id, pt.source_session_id, pt.status, pt.title, pt.context, pt.signal, pt.intervention,
                pt.outcome, pt.limits, pt.created_at
         FROM patterns pt WHERE pt.id = ANY (:ids)`,
        { ids: p.uuidArray(batch) },
        (r) => ({
          id: col.uuid.decode(r.id, 'id'),
          sourceSessionId: col.uuid.nullable.decode(r.source_session_id, 'source_session_id'),
          status: col.text.decode(r.status, 'status'),
          title: col.text.decode(r.title, 'title'),
          context: col.text.decode(r.context, 'context'),
          signal: col.text.decode(r.signal, 'signal'),
          intervention: col.text.decode(r.intervention, 'intervention'),
          outcome: col.text.decode(r.outcome, 'outcome'),
          limits: col.text.decode(r.limits, 'limits'),
          createdAt: ts(r, 'created_at'),
        }),
      ),
    (lesson) => lesson.id,
  );
}
