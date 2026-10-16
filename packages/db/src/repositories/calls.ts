/**
 * Voice calls (`calls`, migration 0008) and the turns that belong to them. A call is a mode of a conversation:
 * its words are ordinary turns (`turns.call_id`, linked by the `turns_link_call` trigger). Rows hold identifiers
 * and numbers only, never content. Times are measured with the database clock so every check agrees.
 */
import {
  AvatarProviderId,
  CallEndReason,
  CallInputMode,
  CallState,
  CallStatus,
  NextAction,
  TurnStatus,
  type CallView,
} from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryNumber, queryOne, queryRows } from './common.js';

type CallEndReasonValue = z.infer<typeof CallEndReason>;
type CallStateValue = z.infer<typeof CallState>;

export interface CallRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly personaId: string;
  readonly startedBy: string;
  readonly status: z.infer<typeof CallStatus>;
  readonly provider: z.infer<typeof AvatarProviderId>;
  readonly inputMode: z.infer<typeof CallInputMode>;
  readonly voiceId: string;
  readonly maxSeconds: number;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: CallEndReasonValue | null;
  readonly endDetail: string | null;
  readonly sttGrants: number;
  readonly speechCharacters: number;
  /** Whole seconds from the start to the end (to now while live), by the database clock. */
  readonly elapsedSeconds: number;
  /** Whole seconds since the last heartbeat (since the start when none came yet), by the database clock. */
  readonly idleSeconds: number;
}

const COLUMNS = `c.id, c.tenant_id, c.venture_id, c.session_id, c.persona_id, c.started_by, c.status, c.provider,
  c.input_mode, c.voice_id, c.max_seconds, c.started_at, c.last_heartbeat_at, c.ended_at, c.end_reason, c.end_detail,
  c.stt_grants, c.speech_characters,
  floor(extract(epoch FROM coalesce(c.ended_at, now()) - c.started_at))::integer AS elapsed_seconds,
  floor(extract(epoch FROM now() - coalesce(c.last_heartbeat_at, c.started_at)))::integer AS idle_seconds`;

function decodeCall(r: RawRow): CallRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    sessionId: col.uuid.decode(r.session_id, 'session_id'),
    personaId: col.uuid.decode(r.persona_id, 'persona_id'),
    startedBy: col.uuid.decode(r.started_by, 'started_by'),
    status: col.enum(CallStatus.options).decode(r.status, 'status'),
    provider: col.enum(AvatarProviderId.options).decode(r.provider, 'provider'),
    inputMode: col.enum(CallInputMode.options).decode(r.input_mode, 'input_mode'),
    voiceId: col.text.decode(r.voice_id, 'voice_id'),
    maxSeconds: col.int.decode(r.max_seconds, 'max_seconds'),
    startedAt: col.ts.decode(r.started_at, 'started_at'),
    lastHeartbeatAt: col.ts.nullable.decode(r.last_heartbeat_at, 'last_heartbeat_at'),
    endedAt: col.ts.nullable.decode(r.ended_at, 'ended_at'),
    endReason: col.enum(CallEndReason.options).nullable.decode(r.end_reason, 'end_reason'),
    endDetail: col.text.nullable.decode(r.end_detail, 'end_detail'),
    sttGrants: col.int.decode(r.stt_grants, 'stt_grants'),
    speechCharacters: col.int.decode(r.speech_characters, 'speech_characters'),
    elapsedSeconds: Math.max(0, col.int.decode(r.elapsed_seconds, 'elapsed_seconds')),
    idleSeconds: Math.max(0, col.int.decode(r.idle_seconds, 'idle_seconds')),
  };
}

/** The call as clients see it. */
export function toCallView(call: CallRecord): CallView {
  return {
    id: call.id,
    sessionId: call.sessionId,
    ventureId: call.ventureId,
    personaId: call.personaId,
    status: call.status,
    provider: call.provider,
    inputMode: call.inputMode,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    endReason: call.endReason,
    maxSeconds: call.maxSeconds,
    durationSeconds: call.status === 'ended' ? call.elapsedSeconds : null,
  };
}

/** A call by id (null when it does not exist or is not visible). */
export function getCall(ex: SqlExecutor, id: string): Promise<CallRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM calls c WHERE c.id = :id`, { id: p.uuid(id) }, decodeCall);
}

/** The live call a person started, in any conversation (at most one). */
export function getLiveCallOf(ex: SqlExecutor, principalId: string): Promise<CallRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS} FROM calls c WHERE c.started_by = :principal AND c.status = 'live'`,
    { principal: p.uuid(principalId) },
    decodeCall,
  );
}

export interface StartCallInput {
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly personaId: string;
  /** Must be the request principal under RLS. */
  readonly startedBy: string;
  readonly provider: z.infer<typeof AvatarProviderId>;
  readonly inputMode: z.infer<typeof CallInputMode>;
  readonly voiceId: string;
  readonly maxSeconds: number;
}

/**
 * Records a new live call. A second live call of the same person fails with a unique violation
 * (`calls_one_live_per_person`); callers end or reap the previous one first.
 */
export function startCall(ex: SqlExecutor, input: StartCallInput): Promise<CallRecord> {
  return queryOne(
    ex,
    `INSERT INTO calls AS c (tenant_id, venture_id, session_id, persona_id, started_by, provider, input_mode, voice_id,
                             max_seconds)
     VALUES (:tenantId, :ventureId, :sessionId, :personaId, :startedBy, :provider, :inputMode, :voiceId, :maxSeconds)
     RETURNING ${COLUMNS}`,
    {
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      sessionId: p.uuid(input.sessionId),
      personaId: p.uuid(input.personaId),
      startedBy: p.uuid(input.startedBy),
      provider: p.text(input.provider),
      inputMode: p.text(input.inputMode),
      voiceId: p.text(input.voiceId),
      maxSeconds: p.int(Math.max(0, Math.floor(input.maxSeconds))),
    },
    decodeCall,
    'startCall',
  );
}

/** Numbers the client measured during the call (never content). */
export interface CallClientStats {
  readonly firstAudioMsP50: number | null;
  readonly firstAudioMsP95: number | null;
  readonly bargeIns: number;
  readonly reconnects: number;
}

export interface EndCallInput {
  readonly callId: string;
  readonly reason: CallEndReasonValue;
  /** Machine-readable detail (`kill_switch`, `max_duration`, …). */
  readonly detail: string;
  /**
   * The client went away: the call ends `graceSeconds` after its last sign of life (never after now) instead
   * of now, so minutes it could not use are not counted.
   */
  readonly atLastHeartbeat?: { readonly graceSeconds: number };
  readonly clientStats?: CallClientStats;
}

/** Ends a live call. Null when the call is not live (already ended) or not the caller's. */
export function endCall(ex: SqlExecutor, input: EndCallInput): Promise<CallRecord | null> {
  const stats = input.clientStats;
  return queryFirst(
    ex,
    `UPDATE calls AS c SET
       status = 'ended',
       end_reason = :reason,
       end_detail = :detail,
       ended_at = CASE WHEN :grace::integer IS NULL THEN now()
                       ELSE greatest(c.started_at,
                                     least(now(), coalesce(c.last_heartbeat_at, c.started_at)
                                                  + make_interval(secs => :grace::integer)))
                  END,
       first_audio_ms_p50 = coalesce(:p50, c.first_audio_ms_p50),
       first_audio_ms_p95 = coalesce(:p95, c.first_audio_ms_p95),
       barge_ins = coalesce(:bargeIns, c.barge_ins),
       reconnects = coalesce(:reconnects, c.reconnects)
     WHERE c.id = :id AND c.status = 'live'
     RETURNING ${COLUMNS}`,
    {
      id: p.uuid(input.callId),
      reason: p.text(input.reason),
      detail: p.text(input.detail),
      grace: p.nullable.int(input.atLastHeartbeat?.graceSeconds),
      p50: p.nullable.int(stats?.firstAudioMsP50),
      p95: p.nullable.int(stats?.firstAudioMsP95),
      bargeIns: p.nullable.int(stats?.bargeIns),
      reconnects: p.nullable.int(stats?.reconnects),
    },
    decodeCall,
  );
}

/** Records a heartbeat of a live call. Null when the call is not live or not the caller's. */
export function recordHeartbeat(
  ex: SqlExecutor,
  input: { readonly callId: string; readonly state: CallStateValue; readonly micOpenSeconds: number },
): Promise<CallRecord | null> {
  return queryFirst(
    ex,
    `UPDATE calls AS c SET last_heartbeat_at = now(), last_state = :state,
                           mic_open_seconds = greatest(c.mic_open_seconds, :mic)
     WHERE c.id = :id AND c.status = 'live'
     RETURNING ${COLUMNS}`,
    {
      id: p.uuid(input.callId),
      state: p.text(input.state),
      mic: p.int(Math.min(86_400, Math.max(0, Math.floor(input.micOpenSeconds)))),
    },
    decodeCall,
  );
}

/**
 * Counts one speech-to-text grant against a live call (and marks the call as transcribed). Null when the call
 * is not live, not the caller's, or already used `maxGrants`.
 */
export function recordSttGrant(
  ex: SqlExecutor,
  input: { readonly callId: string; readonly maxGrants: number },
): Promise<CallRecord | null> {
  return queryFirst(
    ex,
    `UPDATE calls AS c SET stt_grants = c.stt_grants + 1, input_mode = 'transcribe'
     WHERE c.id = :id AND c.status = 'live' AND c.stt_grants < :max
     RETURNING ${COLUMNS}`,
    { id: p.uuid(input.callId), max: p.int(input.maxGrants) },
    decodeCall,
  );
}

/** Adds synthesized characters to a call (metering detail; the ledger holds the cost). */
export async function addSpeechCharacters(
  ex: SqlExecutor,
  input: { readonly callId: string; readonly characters: number },
): Promise<void> {
  await ex.query('UPDATE calls SET speech_characters = speech_characters + :n WHERE id = :id', {
    id: p.uuid(input.callId),
    n: p.int(Math.max(0, Math.floor(input.characters))),
  });
}

/**
 * Seconds a person spent in calls during the current UTC day (by the database clock): ended calls until they
 * ended, live calls until now or until `staleSeconds` after their last heartbeat when the client went away.
 */
export function callSecondsToday(
  ex: SqlExecutor,
  input: { readonly principalId: string; readonly staleSeconds: number },
): Promise<number> {
  return queryNumber(
    ex,
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start_at)
     SELECT coalesce(floor(sum(greatest(0, extract(epoch FROM
              least(coalesce(c.ended_at,
                             least(now(), coalesce(c.last_heartbeat_at, c.started_at)
                                          + make_interval(secs => :stale::integer))),
                    day.start_at + interval '1 day')
              - greatest(c.started_at, day.start_at))))), 0)::integer AS n
     FROM calls c, day
     WHERE c.started_by = :principal AND c.started_at < day.start_at + interval '1 day'
       AND (c.ended_at IS NULL OR c.ended_at > day.start_at)`,
    { principal: p.uuid(input.principalId), stale: p.int(input.staleSeconds) },
  );
}

/** Spoken turns a person sent in the last `windowSeconds` (the voice-turn rate limit). */
export function countRecentVoiceTurns(
  ex: SqlExecutor,
  input: { readonly authorId: string; readonly windowSeconds: number },
): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM turns
     WHERE author_id = :authorId AND channel = 'voice' AND created_at > now() - make_interval(secs => :window)`,
    { authorId: p.uuid(input.authorId), window: p.num(input.windowSeconds) },
  );
}

/** Turns of a call so far. */
export function countCallTurns(ex: SqlExecutor, callId: string): Promise<number> {
  return queryNumber(ex, 'SELECT count(*) AS n FROM turns WHERE call_id = :id', { id: p.uuid(callId) });
}

export interface CallTurn {
  readonly id: string;
  readonly status: z.infer<typeof TurnStatus>;
  /** Next actions of a completed reply (empty otherwise). */
  readonly nextActions: z.infer<typeof NextAction>[];
}

const NextActions = z.array(NextAction).catch([]);

/** The turns of a call in order, with the next actions of their replies (no other content). */
export function listCallTurns(ex: SqlExecutor, callId: string): Promise<CallTurn[]> {
  return queryRows(
    ex,
    `SELECT t.id, t.status,
            CASE WHEN t.status = 'completed' AND jsonb_typeof(t.response -> 'next_actions') = 'array'
                 THEN t.response -> 'next_actions' ELSE '[]'::jsonb END AS next_actions
     FROM turns t WHERE t.call_id = :id ORDER BY t.ordinal`,
    { id: p.uuid(callId) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      status: col.enum(TurnStatus.options).decode(r.status, 'status'),
      nextActions: NextActions.parse(col.json().decode(r.next_actions, 'next_actions')),
    }),
  );
}

/**
 * What a call's turns left behind that the founder may act on: AI memory proposals still awaiting review and
 * escalation drafts or requests, oldest first (as visible to the caller).
 */
export async function callFollowUps(
  ex: SqlExecutor,
  input: { readonly ventureId: string; readonly turnIds: readonly string[] },
): Promise<{ memoryProposalIds: string[]; escalationIds: string[] }> {
  if (input.turnIds.length === 0) return { memoryProposalIds: [], escalationIds: [] };
  const memoryProposalIds = await queryRows(
    ex,
    `SELECT m.id FROM memory_objects m
     WHERE m.venture_id = :venture AND m.origin = 'ai' AND m.status = 'proposed'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.source_refs) = 'array'
                                                           THEN m.source_refs ELSE '[]'::jsonb END) AS r (ref)
                   WHERE r.ref ->> 'kind' = 'turn' AND (r.ref ->> 'id') = ANY (:turnIds))
     ORDER BY m.created_at, m.id`,
    { venture: p.uuid(input.ventureId), turnIds: p.textArray(input.turnIds) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  const escalationIds = await queryRows(
    ex,
    `SELECT e.id FROM escalations e WHERE e.venture_id = :venture AND e.turn_id = ANY (:turnIds)
     ORDER BY e.created_at, e.id`,
    { venture: p.uuid(input.ventureId), turnIds: p.uuidArray(input.turnIds) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return { memoryProposalIds, escalationIds };
}

// ------------------------------------------------------------------------------------------------
// Barge-in
// ------------------------------------------------------------------------------------------------

/** Largest speech unit sequence number a turn can have (`turns_heard_seq_check`). */
export const MAX_SPEECH_SEQ = 10_000;

export interface TurnInterruption {
  readonly turnId: string;
  /** The last speech unit the founder heard (-1: none). */
  readonly heardSeq: number;
  readonly interruptedAt: string;
}

/**
 * Records that the founder spoke over the reply of a turn of their call after hearing units 0…`heardSeq`. The
 * first record wins (a retried interrupt changes nothing). Null when the turn is not that person's turn in
 * that call (or not visible).
 */
export function markTurnInterrupted(
  ex: SqlExecutor,
  input: {
    readonly turnId: string;
    readonly callId: string;
    readonly authorId: string;
    readonly heardSeq: number;
  },
): Promise<TurnInterruption | null> {
  return queryFirst(
    ex,
    `UPDATE turns AS t SET heard_seq = coalesce(t.heard_seq, :seq), interrupted_at = coalesce(t.interrupted_at, now())
     WHERE t.id = :id AND t.call_id = :callId AND t.author_id = :authorId
     RETURNING t.id, t.heard_seq, t.interrupted_at`,
    {
      id: p.uuid(input.turnId),
      callId: p.uuid(input.callId),
      authorId: p.uuid(input.authorId),
      seq: p.int(input.heardSeq),
    },
    decodeInterruption,
  );
}

function decodeInterruption(r: RawRow): TurnInterruption {
  return {
    turnId: col.uuid.decode(r.id, 'id'),
    heardSeq: col.int.decode(r.heard_seq, 'heard_seq'),
    interruptedAt: col.ts.decode(r.interrupted_at, 'interrupted_at'),
  };
}

/**
 * Interruptions among `turnIds` (turns the founder spoke over), by turn id: the conversation history replays
 * what the founder heard of those replies, not what was generated.
 */
export async function listTurnInterruptions(
  ex: SqlExecutor,
  turnIds: readonly string[],
): Promise<Map<string, TurnInterruption>> {
  if (turnIds.length === 0) return new Map();
  const rows = await queryRows(
    ex,
    `SELECT t.id, t.heard_seq, t.interrupted_at FROM turns t
     WHERE t.id = ANY (:ids) AND t.interrupted_at IS NOT NULL`,
    { ids: p.uuidArray(turnIds) },
    decodeInterruption,
  );
  return new Map(rows.map((r) => [r.turnId, r]));
}

// ------------------------------------------------------------------------------------------------
// Maintenance
// ------------------------------------------------------------------------------------------------

/**
 * Ends live calls whose client went away (no heartbeat for `staleSeconds`) as `timeout` / `stale_heartbeat`,
 * at their last sign of life plus `graceSeconds`. Owner role (maintenance). Returns how many it ended.
 */
export async function reapStaleCalls(
  sx: SystemExecutor,
  input: { readonly staleSeconds: number; readonly graceSeconds: number; readonly limit?: number },
): Promise<number> {
  const result = await sx.query(
    `UPDATE calls AS c SET status = 'ended', end_reason = 'timeout', end_detail = 'stale_heartbeat',
            ended_at = greatest(c.started_at, least(now(), coalesce(c.last_heartbeat_at, c.started_at)
                                                          + make_interval(secs => :grace::integer)))
     WHERE c.id IN (SELECT x.id FROM calls x
                    WHERE x.status = 'live'
                      AND coalesce(x.last_heartbeat_at, x.started_at) < now() - make_interval(secs => :stale::integer)
                    ORDER BY x.started_at LIMIT :limit)`,
    { stale: p.int(input.staleSeconds), grace: p.int(input.graceSeconds), limit: p.int(input.limit ?? 500) },
  );
  return result.rowCount;
}
