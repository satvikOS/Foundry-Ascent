/**
 * Voice calls (`calls`, migration 0008) and the turns that belong to them. A call is a mode of a conversation:
 * its words are ordinary turns (`turns.call_id`, linked by the `turns_link_call` trigger). Rows hold identifiers
 * and numbers only, never content. Times are measured with the database clock so every check agrees.
 */
import {
  AvatarProviderId,
  CallEndReason,
  CallInputMode,
  type CallState,
  CallStatus,
  NextAction,
  TurnStatus,
  type CallView,
} from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p, type SqlParams } from '../params.js';
import {
  firstPart,
  numberPart,
  queryFirst,
  queryNumber,
  queryOne,
  queryRows,
  readPart,
  rowsPart,
  type ReadPart,
} from './common.js';

type CallEndReasonValue = z.infer<typeof CallEndReason>;

/** The voice a call started with (`calls.voice_vendor`). */
export const CALL_VOICE_VENDORS = ['polly', 'elevenlabs', 'fake'] as const;
export type CallVoiceVendor = (typeof CALL_VOICE_VENDORS)[number];
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
  /**
   * The voice the call started with (0017): `polly` (a stock voice, `voiceId`), or `elevenlabs` / `fake` (the
   * EIR's cloned voice, with `voiceId` as its stock fallback). Never changes.
   */
  readonly voiceVendor: CallVoiceVendor;
  readonly maxSeconds: number;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: CallEndReasonValue | null;
  readonly endDetail: string | null;
  readonly sttGrants: number;
  readonly speechCharacters: number;
  /** Seconds the client's microphone was open for speech-to-text (heartbeats; never more than wall time). */
  readonly micOpenSeconds: number;
  /** Whole seconds from the start to the end (to now while live), by the database clock. */
  readonly elapsedSeconds: number;
  /** Whole seconds since the last heartbeat (since the start when none came yet), by the database clock. */
  readonly idleSeconds: number;
}

const COLUMNS = `c.id, c.tenant_id, c.venture_id, c.session_id, c.persona_id, c.started_by, c.status, c.provider,
  c.input_mode, c.voice_id, c.voice_vendor, c.max_seconds, c.started_at, c.last_heartbeat_at, c.ended_at, c.end_reason, c.end_detail,
  c.stt_grants, c.speech_characters, c.mic_open_seconds,
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
    voiceVendor: col.enum(CALL_VOICE_VENDORS).decode(r.voice_vendor, 'voice_vendor'),
    maxSeconds: col.int.decode(r.max_seconds, 'max_seconds'),
    startedAt: col.ts.decode(r.started_at, 'started_at'),
    lastHeartbeatAt: col.ts.nullable.decode(r.last_heartbeat_at, 'last_heartbeat_at'),
    endedAt: col.ts.nullable.decode(r.ended_at, 'ended_at'),
    endReason: col.enum(CallEndReason.options).nullable.decode(r.end_reason, 'end_reason'),
    endDetail: col.text.nullable.decode(r.end_detail, 'end_detail'),
    sttGrants: col.int.decode(r.stt_grants, 'stt_grants'),
    speechCharacters: col.int.decode(r.speech_characters, 'speech_characters'),
    micOpenSeconds: col.int.decode(r.mic_open_seconds, 'mic_open_seconds'),
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
  return readPart(ex, callPart(id));
}

/** {@link getCall} as a read of a combined statement (`readTogether`). */
export function callPart(id: string): ReadPart<CallRecord | null> {
  return firstPart(`SELECT ${COLUMNS} FROM calls c WHERE c.id = :id`, { id: p.uuid(id) }, decodeCall);
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
  /** Default `polly`. */
  readonly voiceVendor?: CallVoiceVendor;
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
                             voice_vendor, max_seconds)
     VALUES (:tenantId, :ventureId, :sessionId, :personaId, :startedBy, :provider, :inputMode, :voiceId, :voiceVendor,
             :maxSeconds)
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
      voiceVendor: p.text(input.voiceVendor ?? 'polly'),
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

/**
 * Seconds a call's microphone total may exceed the call's own wall time (client clock and rounding drift).
 * Granted once per call, never per heartbeat: heartbeats sent faster add nothing beyond the wall time.
 */
export const MIC_SECONDS_SLACK = 5;

export interface Heartbeat {
  readonly call: CallRecord;
  /** Microphone seconds this heartbeat added (what speech-to-text is billed for). */
  readonly micSecondsAdded: number;
}

/**
 * Records a heartbeat of a live call with the client's running total of microphone seconds. The total only
 * grows, never by more than the wall time since the previous heartbeat, and never beyond the wall time since
 * the call started (plus {@link MIC_SECONDS_SLACK}, once per call), whatever the client reports and however
 * often it beats, by the database clock. Concurrent heartbeats are serialised so each second is added once.
 * Null when the call is not live or not the caller's.
 */
export function recordHeartbeat(
  ex: SqlExecutor,
  input: { readonly callId: string; readonly state: CallStateValue; readonly micOpenSeconds: number },
): Promise<Heartbeat | null> {
  return queryFirst(
    ex,
    `WITH prev AS (
       SELECT x.id, x.mic_open_seconds AS before,
              ceil(extract(epoch FROM now() - coalesce(x.last_heartbeat_at, x.started_at)))::integer AS gap,
              ceil(extract(epoch FROM now() - x.started_at))::integer AS lasted
       FROM calls x WHERE x.id = :id AND x.status = 'live' FOR UPDATE)
     UPDATE calls AS c SET last_heartbeat_at = now(), last_state = :state,
                           mic_open_seconds = least(86400, greatest(c.mic_open_seconds,
                                                                    least(:mic, prev.before + prev.gap,
                                                                          prev.lasted + :slack)))
     FROM prev WHERE c.id = prev.id
     RETURNING ${COLUMNS}, (c.mic_open_seconds - prev.before)::integer AS mic_added`,
    {
      id: p.uuid(input.callId),
      state: p.text(input.state),
      mic: p.int(Math.min(86_400, Math.max(0, Math.floor(input.micOpenSeconds)))),
      slack: p.int(MIC_SECONDS_SLACK),
    },
    (r) => ({
      call: decodeCall(r),
      micSecondsAdded: Math.max(0, col.int.decode(r.mic_added, 'mic_added')),
    }),
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

/** Speech-to-text grants minted for a person's calls started today (UTC, by the database clock). */
export function sttGrantsToday(ex: SqlExecutor, principalId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT coalesce(sum(c.stt_grants), 0)::integer AS n FROM calls c
     WHERE c.started_by = :principal
       AND c.started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    { principal: p.uuid(principalId) },
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
 * ended, live calls until now but never more than `graceSeconds` after their last sign of life, which is also
 * where a call whose client went away is closed (`endCall` with `atLastHeartbeat`, `reapStaleCalls`): the count
 * is the same before and after the close.
 */
export function callSecondsToday(
  ex: SqlExecutor,
  input: { readonly principalId: string; readonly graceSeconds: number },
): Promise<number> {
  return readPart(ex, callSecondsTodayPart(input));
}

/** {@link callSecondsToday} as a read of a combined statement (`readTogether`). */
export function callSecondsTodayPart(input: {
  readonly principalId: string;
  readonly graceSeconds: number;
}): ReadPart<number> {
  return numberPart(
    `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start_at)
     SELECT coalesce(floor(sum(greatest(0, extract(epoch FROM
              least(coalesce(c.ended_at,
                             least(now(), coalesce(c.last_heartbeat_at, c.started_at)
                                          + make_interval(secs => :grace::integer))),
                    day.start_at + interval '1 day')
              - greatest(c.started_at, day.start_at))))), 0)::integer AS n
     FROM calls c, day
     WHERE c.started_by = :principal AND c.started_at < day.start_at + interval '1 day'
       AND (c.ended_at IS NULL OR c.ended_at > day.start_at)`,
    { principal: p.uuid(input.principalId), grace: p.int(input.graceSeconds) },
  );
}

/** Spoken turns a person sent in the last `windowSeconds` (the voice-turn rate limit). */
export function countRecentVoiceTurns(
  ex: SqlExecutor,
  input: { readonly authorId: string; readonly windowSeconds: number },
): Promise<number> {
  return readPart(ex, countRecentVoiceTurnsPart(input));
}

/** {@link countRecentVoiceTurns} as a read of a combined statement (`readTogether`). */
export function countRecentVoiceTurnsPart(input: {
  readonly authorId: string;
  readonly windowSeconds: number;
}): ReadPart<number> {
  return numberPart(
    `SELECT count(*) AS n FROM turns
     WHERE author_id = :authorId AND channel = 'voice' AND created_at > now() - make_interval(secs => :window)`,
    { authorId: p.uuid(input.authorId), window: p.num(input.windowSeconds) },
  );
}

/** Turns of a call so far. */
export function countCallTurns(ex: SqlExecutor, callId: string): Promise<number> {
  return readPart(ex, countCallTurnsPart(callId));
}

/** {@link countCallTurns} as a read of a combined statement (`readTogether`). */
export function countCallTurnsPart(callId: string): ReadPart<number> {
  return numberPart('SELECT count(*) AS n FROM turns WHERE call_id = :id', { id: p.uuid(callId) });
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
 * What a call's turns left behind, oldest first (as visible to the caller): the AI memory they produced (kept
 * automatically, or a proposal from before that still awaits review) and escalation drafts or requests.
 */
export async function callFollowUps(
  ex: SqlExecutor,
  input: { readonly ventureId: string; readonly turnIds: readonly string[] },
): Promise<{ memoryProposalIds: string[]; memoryKeptIds: string[]; escalationIds: string[] }> {
  if (input.turnIds.length === 0) return { memoryProposalIds: [], memoryKeptIds: [], escalationIds: [] };
  const memory = await queryRows(
    ex,
    `SELECT m.id, m.status FROM memory_objects m
     WHERE m.venture_id = :venture AND m.origin = 'ai'
       AND (m.status = 'proposed' OR (m.approved_by IS NULL AND m.status IN ('confirmed', 'disputed')))
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.source_refs) = 'array'
                                                           THEN m.source_refs ELSE '[]'::jsonb END) AS r (ref)
                   WHERE r.ref ->> 'kind' = 'turn' AND (r.ref ->> 'id') = ANY (:turnIds))
     ORDER BY m.created_at, m.id`,
    { venture: p.uuid(input.ventureId), turnIds: p.textArray(input.turnIds) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      proposed: col.text.decode(r.status, 'status') === 'proposed',
    }),
  );
  const escalationIds = await queryRows(
    ex,
    `SELECT e.id FROM escalations e WHERE e.venture_id = :venture AND e.turn_id = ANY (:turnIds)
     ORDER BY e.created_at, e.id`,
    { venture: p.uuid(input.ventureId), turnIds: p.uuidArray(input.turnIds) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return {
    memoryProposalIds: memory.filter((m) => m.proposed).map((m) => m.id),
    memoryKeptIds: memory.filter((m) => !m.proposed).map((m) => m.id),
    escalationIds,
  };
}

// ------------------------------------------------------------------------------------------------
// Barge-in
// ------------------------------------------------------------------------------------------------

/** Largest speech unit sequence number a turn can have (`turns_heard_seq_check`). */
export const MAX_SPEECH_SEQ = 10_000;
/** Longest record of what the founder heard of one reply (`turns_heard_seq_check`). */
export const MAX_HEARD_CHARS = 40_000;

export interface TurnInterruption {
  readonly turnId: string;
  /** The last speech unit the founder heard (-1: none). */
  readonly heardSeq: number;
  /**
   * The words of units 0…`heardSeq` as played, verified when recorded; null when the founder heard nothing,
   * the client did not send them, or the conversation's content was redacted since.
   */
  readonly heardText: string | null;
  readonly interruptedAt: string;
}

/**
 * Records that the founder spoke over the reply of a turn of their call after hearing units 0…`heardSeq`
 * (whose words are `heardText`, already verified by the caller). The first record wins (a retried interrupt
 * changes nothing). Null when the turn is not that person's turn in that call, not visible, or its conversation
 * is no longer active (its content may have been redacted).
 *
 * The conversation is locked (FOR SHARE) while it is checked: deleting it or ending a temporary chat locks it
 * too, so a barge-in that races the erasure either commits first (and its words are erased with the rest) or
 * sees the conversation gone and records nothing. Without the lock, the check could read the conversation as
 * it was before an erasure that was committing, and store the heard words on a redacted turn.
 */
export function markTurnInterrupted(
  ex: SqlExecutor,
  input: {
    readonly turnId: string;
    readonly callId: string;
    readonly authorId: string;
    readonly heardSeq: number;
    readonly heardText: string | null;
  },
): Promise<TurnInterruption | null> {
  return queryFirst(
    ex,
    `UPDATE turns AS t SET heard_seq = coalesce(t.heard_seq, :seq),
                           heard_text = CASE WHEN t.interrupted_at IS NULL THEN :heard ELSE t.heard_text END,
                           interrupted_at = coalesce(t.interrupted_at, now())
     WHERE t.id = :id AND t.call_id = :callId AND t.author_id = :authorId
       AND EXISTS (SELECT 1 FROM coaching_sessions s
                   WHERE s.id = t.session_id AND s.status = 'active' AND s.deleted_at IS NULL
                   FOR SHARE OF s)
     RETURNING t.id, t.heard_seq, t.heard_text, t.interrupted_at`,
    {
      id: p.uuid(input.turnId),
      callId: p.uuid(input.callId),
      authorId: p.uuid(input.authorId),
      seq: p.int(input.heardSeq),
      heard: p.nullable.text(input.heardText),
    },
    decodeInterruption,
  );
}

function decodeInterruption(r: RawRow): TurnInterruption {
  return {
    turnId: col.uuid.decode(r.id, 'id'),
    heardSeq: col.int.decode(r.heard_seq, 'heard_seq'),
    heardText: col.text.nullable.decode(r.heard_text, 'heard_text'),
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
  return readPart(ex, turnInterruptionsPart(turnIds));
}

/**
 * {@link listTurnInterruptions} as a read of a combined statement (`readTogether`): of `turnIds`, or of the turns a
 * subquery of the same statement selects (`turnsRepo.recentTurnIdsSubquery`).
 */
export function turnInterruptionsPart(
  turnIds: readonly string[] | { readonly sql: string; readonly params: SqlParams },
): ReadPart<Map<string, TurnInterruption>> {
  const among = Array.isArray(turnIds)
    ? { sql: 't.id = ANY (:ids)', params: { ids: p.uuidArray(turnIds) } }
    : (({ sql, params }: { readonly sql: string; readonly params: SqlParams }) => ({
        sql: `t.id IN (${sql})`,
        params,
      }))(turnIds as { readonly sql: string; readonly params: SqlParams });
  const part = rowsPart(
    `SELECT t.id, t.heard_seq, t.heard_text, t.interrupted_at FROM turns t
     WHERE ${among.sql} AND t.interrupted_at IS NOT NULL`,
    among.params,
    decodeInterruption,
  );
  return { ...part, decode: (rows) => new Map(part.decode(rows).map((r) => [r.turnId, r])) };
}

// ------------------------------------------------------------------------------------------------
// Speech
// ------------------------------------------------------------------------------------------------

/** What `POST /speech` needs to know about a turn whose words a call would speak (no content but `spoken`). */
export interface SpokenTurn {
  readonly turnId: string;
  readonly sessionId: string;
  readonly ventureId: string;
  readonly authorId: string;
  /** The call the turn was sent in (null: outside a call). */
  readonly callId: string | null;
  readonly status: z.infer<typeof TurnStatus>;
  /** The reply's validated spoken form (null when it has none). */
  readonly spoken: string | null;
  /** The turn was answered with the fixed crisis support message (no model call). */
  readonly crisisSupport: boolean;
  /** Whole seconds since the turn was sent, by the database clock. */
  readonly ageSeconds: number;
}

export function getSpokenTurn(ex: SqlExecutor, turnId: string): Promise<SpokenTurn | null> {
  return queryFirst(
    ex,
    `SELECT t.id, t.session_id, t.venture_id, t.author_id, t.call_id, t.status,
            CASE WHEN jsonb_typeof(t.response -> 'spoken') = 'string' THEN t.response ->> 'spoken' END AS spoken,
            coalesce(jsonb_typeof(t.validator_results -> 'notes') = 'array'
                     AND (t.validator_results -> 'notes') @> '["crisis_support"]'::jsonb, false) AS crisis_support,
            floor(extract(epoch FROM now() - t.created_at))::integer AS age_seconds
     FROM turns t WHERE t.id = :id`,
    { id: p.uuid(turnId) },
    (r) => ({
      turnId: col.uuid.decode(r.id, 'id'),
      sessionId: col.uuid.decode(r.session_id, 'session_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      authorId: col.uuid.decode(r.author_id, 'author_id'),
      callId: col.uuid.nullable.decode(r.call_id, 'call_id'),
      status: col.enum(TurnStatus.options).decode(r.status, 'status'),
      spoken: col.text.nullable.decode(r.spoken, 'spoken'),
      crisisSupport: col.bool.decode(r.crisis_support, 'crisis_support'),
      ageSeconds: Math.max(0, col.int.decode(r.age_seconds, 'age_seconds')),
    }),
  );
}

/**
 * What a call speaks, as `call_speech` keys it (identifiers only): the intro, a signed unit of a reply, a run
 * of whole sentences of a stored reply (sentence indices, first to last), a crisis turn's support message, or a
 * signed unit (or the intro, `turnId` null) handed to a FULL face as text (0018), counted apart from its own play.
 */
export type SpeechUnitKey =
  | { readonly kind: 'intro' }
  | { readonly kind: 'unit'; readonly turnId: string; readonly seq: number }
  | { readonly kind: 'run'; readonly turnId: string; readonly first: number; readonly last: number }
  | { readonly kind: 'crisis'; readonly turnId: string }
  | { readonly kind: 'face'; readonly turnId: string | null; readonly seq: number };

/** The `call_speech.unit` text of a key. */
export function speechUnitKey(key: SpeechUnitKey): string {
  switch (key.kind) {
    case 'intro':
      return 'intro';
    case 'unit':
      return `unit.${key.turnId.toLowerCase()}.${String(key.seq)}`;
    case 'run':
      return `run.${key.turnId.toLowerCase()}.${String(key.first)}.${String(key.last)}`;
    case 'crisis':
      return `crisis.${key.turnId.toLowerCase()}`;
    case 'face':
      return key.turnId === null ? 'face.intro' : `face.${key.turnId.toLowerCase()}.${String(key.seq)}`;
  }
}

/** How many characters a call, and a person's calls in a UTC day, may have synthesized. */
export interface SpeechBudget {
  /** Characters per second the call has lasted (and per second of its `max_seconds`, its ceiling). */
  readonly charactersPerSecond: number;
  /** Characters a call may synthesize before it has lasted long enough to pay for them. */
  readonly headroomCharacters: number;
  /** Characters the calls a person started today (UTC) may have synthesized together. */
  readonly dailyCharacters: number;
}

export type SpeechReservation =
  | { readonly ok: true; readonly plays: number }
  | {
      readonly ok: false;
      /**
       * `call_not_active`: not a live call of this person; `already_played`: the unit used its plays;
       * `call_budget` / `daily_budget`: the characters would exceed the call's or the person's day's budget.
       */
      readonly reason: 'call_not_active' | 'already_played' | 'call_budget' | 'daily_budget';
    };

export const TODAY_UTC = `date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/** The budget conditions of `reserveCallSpeech` on the call row `c` (whose own counter is current). */
export const CALL_BUDGET_OK = `c.speech_characters + :n
       <= least(:rate * c.max_seconds, :headroom + :rate * floor(extract(epoch FROM now() - c.started_at))::integer)`;
export const DAY_BUDGET_OK = `c.speech_characters + :n
       + (SELECT coalesce(sum(o.speech_characters), 0)::integer FROM calls o
          WHERE o.started_by = c.started_by AND o.id <> c.id AND o.started_at >= ${TODAY_UTC}) <= :daily`;

/**
 * Reserves one synthesis of `unit` on the live call `callId` of `principalId`, before the speech service is
 * called: one more play of the unit (at most `maxPlays` per call) and `characters` more on the call, within the
 * call's budget (`headroomCharacters` + `charactersPerSecond` × the seconds it has lasted, and never more than
 * `charactersPerSecond` × its `max_seconds`) and the person's budget for the day (`dailyCharacters` across the
 * calls they started today, UTC). One statement: the call row is locked first, so concurrent requests are
 * serialised and each sees the others' characters and plays (by the database clock). Owner role.
 */
export async function reserveCallSpeech(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly principalId: string;
    readonly unit: SpeechUnitKey;
    readonly characters: number;
    readonly maxPlays: number;
    readonly budget: SpeechBudget;
  },
): Promise<SpeechReservation> {
  const params = {
    call: p.uuid(input.callId),
    principal: p.uuid(input.principalId),
    unit: p.text(speechUnitKey(input.unit)),
    n: p.int(Math.max(0, Math.floor(input.characters))),
    max: p.int(input.maxPlays),
    rate: p.int(input.budget.charactersPerSecond),
    headroom: p.int(input.budget.headroomCharacters),
    daily: p.int(input.budget.dailyCharacters),
  };
  const reserved = await queryFirst(
    sx,
    `WITH me AS (
       SELECT c.id FROM calls c
       WHERE c.id = :call AND c.started_by = :principal AND c.status = 'live'
         AND ${CALL_BUDGET_OK}
         AND ${DAY_BUDGET_OK}
       FOR UPDATE OF c),
     play AS (
       INSERT INTO call_speech AS s (call_id, unit, plays, characters)
       SELECT me.id, :unit, 1, :n FROM me
       ON CONFLICT (call_id, unit) DO UPDATE SET plays = s.plays + 1, characters = s.characters + EXCLUDED.characters
         WHERE s.plays < :max
       RETURNING s.call_id, s.plays),
     counted AS (
       UPDATE calls AS c SET speech_characters = c.speech_characters + :n FROM play
       WHERE c.id = play.call_id RETURNING c.id)
     SELECT play.plays FROM play, counted`,
    params,
    (r) => col.int.decode(r.plays, 'plays'),
  );
  if (reserved !== null) return { ok: true, plays: reserved };
  // Refused: say why (read after the fact, for the message only).
  const why = await queryFirst(
    sx,
    `SELECT (c.started_by = :principal AND c.status = 'live') AS live,
            coalesce((SELECT s.plays FROM call_speech s WHERE s.call_id = c.id AND s.unit = :unit), 0) >= :max
              AS played,
            ${CALL_BUDGET_OK} AS call_ok
     FROM calls c WHERE c.id = :call`,
    params,
    (r) => ({
      live: col.bool.decode(r.live, 'live'),
      played: col.bool.decode(r.played, 'played'),
      callOk: col.bool.decode(r.call_ok, 'call_ok'),
    }),
  );
  if (why?.live !== true) return { ok: false, reason: 'call_not_active' };
  if (why.played) return { ok: false, reason: 'already_played' };
  return { ok: false, reason: why.callOk ? 'daily_budget' : 'call_budget' };
}

/**
 * Reserves one more play of a crisis turn's support message on the turn's call `callId` (live or not) of
 * `principalId`, at most `maxPlays`, adding `characters` to the call's counter. No budget applies: support is
 * never refused for call or budget reasons, only bounded in plays. Atomic (one statement). Owner role.
 */
export function reserveCrisisSpeech(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly principalId: string;
    readonly turnId: string;
    readonly characters: number;
    readonly maxPlays: number;
  },
): Promise<number | null> {
  return queryFirst(
    sx,
    `WITH play AS (
       INSERT INTO call_speech AS s (call_id, unit, plays, characters)
       SELECT c.id, :unit, 1, :n FROM calls c WHERE c.id = :call AND c.started_by = :principal
       ON CONFLICT (call_id, unit) DO UPDATE SET plays = s.plays + 1, characters = s.characters + EXCLUDED.characters
         WHERE s.plays < :max
       RETURNING s.call_id, s.plays),
     counted AS (
       UPDATE calls AS c SET speech_characters = c.speech_characters + :n FROM play
       WHERE c.id = play.call_id RETURNING c.id)
     SELECT play.plays FROM play, counted`,
    {
      call: p.uuid(input.callId),
      principal: p.uuid(input.principalId),
      unit: p.text(speechUnitKey({ kind: 'crisis', turnId: input.turnId })),
      n: p.int(Math.max(0, Math.floor(input.characters))),
      max: p.int(input.maxPlays),
    },
    (r) => col.int.decode(r.plays, 'plays'),
  );
}

/**
 * Settles a reservation once the speech service answered: `characters` is what it billed (the call's counter
 * and the unit's are corrected by the difference), or null when synthesis failed (nothing billed): the play
 * and the reserved characters are given back. Owner role.
 */
export async function settleCallSpeech(
  sx: SystemExecutor,
  input: {
    readonly callId: string;
    readonly unit: SpeechUnitKey;
    readonly reservedCharacters: number;
    readonly characters: number | null;
  },
): Promise<void> {
  const delta = (input.characters ?? 0) - Math.max(0, Math.floor(input.reservedCharacters));
  const giveBack = input.characters === null ? 1 : 0;
  if (delta === 0 && giveBack === 0) return;
  await sx.query(
    `WITH play AS (
       UPDATE call_speech AS s SET plays = greatest(0, s.plays - :back),
                                   characters = greatest(0, s.characters + :delta)
       WHERE s.call_id = :call AND s.unit = :unit RETURNING s.call_id)
     UPDATE calls AS c SET speech_characters = greatest(0, c.speech_characters + :delta) FROM play
     WHERE c.id = play.call_id`,
    {
      call: p.uuid(input.callId),
      unit: p.text(speechUnitKey(input.unit)),
      delta: p.int(Math.trunc(delta)),
      back: p.int(giveBack),
    },
  );
}

/** Plays of a unit a call reserved so far (0 when none). */
export function speechPlays(
  ex: SqlExecutor | SystemExecutor,
  input: { readonly callId: string; readonly unit: SpeechUnitKey },
): Promise<number> {
  return queryNumber(
    ex,
    `SELECT coalesce((SELECT s.plays FROM call_speech s WHERE s.call_id = :call AND s.unit = :unit), 0) AS n`,
    { call: p.uuid(input.callId), unit: p.text(speechUnitKey(input.unit)) },
  );
}

// ------------------------------------------------------------------------------------------------
// Maintenance
// ------------------------------------------------------------------------------------------------

/** A call the reaper ended, and the conversation it was in (distilled next: the call is over). */
export interface ReapedCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly ventureId: string;
}

/**
 * Ends live calls whose client went away (no heartbeat for `staleSeconds`) as `timeout` / `stale_heartbeat`,
 * at their last sign of life plus `graceSeconds`. Owner role (maintenance). Returns the calls it ended.
 */
export function reapStaleCalls(
  sx: SystemExecutor,
  input: { readonly staleSeconds: number; readonly graceSeconds: number; readonly limit?: number },
): Promise<ReapedCall[]> {
  return queryRows(
    sx,
    `UPDATE calls AS c SET status = 'ended', end_reason = 'timeout', end_detail = 'stale_heartbeat',
            ended_at = greatest(c.started_at, least(now(), coalesce(c.last_heartbeat_at, c.started_at)
                                                          + make_interval(secs => :grace::integer)))
     WHERE c.id IN (SELECT x.id FROM calls x
                    WHERE x.status = 'live'
                      AND coalesce(x.last_heartbeat_at, x.started_at) < now() - make_interval(secs => :stale::integer)
                    ORDER BY x.started_at LIMIT :limit)
     RETURNING c.id, c.session_id, c.venture_id`,
    { stale: p.int(input.staleSeconds), grace: p.int(input.graceSeconds), limit: p.int(input.limit ?? 500) },
    (r) => ({
      callId: col.uuid.decode(r.id, 'id'),
      sessionId: col.uuid.decode(r.session_id, 'session_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    }),
  );
}
