/**
 * Call recordings (`call_recordings`, migration 0031): a founder's recordings of their own calls. Rows hold object
 * keys, sizes, a duration and the lifecycle (pending → ready, deleted → purged), never content: the files are in the
 * recordings bucket. RLS shows a recording only to the person who made it; the purge reads run as the owner role.
 */
import { RecordingMimeType, RecordingStatus, type RecordingView } from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, queryFirst, queryNumber, queryRows } from './common.js';
import { microsToIso } from './sessions.js';

export const RECORDING_DELETE_REASONS = ['founder', 'conversation', 'abandoned', 'expired'] as const;
export type RecordingDeleteReason = (typeof RECORDING_DELETE_REASONS)[number];

export interface RecordingRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly recordedBy: string;
  readonly mimeType: z.infer<typeof RecordingMimeType>;
  readonly bytes: number;
  readonly durationMs: number;
  readonly storageKey: string;
  readonly captionsKey: string | null;
  readonly captionsBytes: number | null;
  readonly cues: number;
  readonly status: z.infer<typeof RecordingStatus>;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedReason: RecordingDeleteReason | null;
  /** The conversation's title (null: untitled, or not visible). */
  readonly conversationTitle: string | null;
}

/** The columns of a recording row aliased `a`, with its conversation's title (`s`). */
function columns(a: string): string {
  return `${a}.id, ${a}.tenant_id, ${a}.venture_id, ${a}.session_id, ${a}.call_id, ${a}.recorded_by, ${a}.mime_type,
  ${a}.bytes, ${a}.duration_ms, ${a}.storage_key, ${a}.captions_key, ${a}.captions_bytes, ${a}.cues, ${a}.status,
  ${a}.created_at, ${a}.completed_at, ${a}.deleted_at, ${a}.deleted_reason, s.title AS conversation_title`;
}
const COLUMNS = columns('r');
const FROM = 'call_recordings r LEFT JOIN coaching_sessions s ON s.id = r.session_id';

function decodeRecording(r: RawRow): RecordingRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    sessionId: col.uuid.decode(r.session_id, 'session_id'),
    callId: col.uuid.decode(r.call_id, 'call_id'),
    recordedBy: col.uuid.decode(r.recorded_by, 'recorded_by'),
    mimeType: col.enum(RecordingMimeType.options).decode(r.mime_type, 'mime_type'),
    bytes: col.int.decode(r.bytes, 'bytes'),
    durationMs: col.int.decode(r.duration_ms, 'duration_ms'),
    storageKey: col.text.decode(r.storage_key, 'storage_key'),
    captionsKey: col.text.nullable.decode(r.captions_key, 'captions_key'),
    captionsBytes: col.int.nullable.decode(r.captions_bytes, 'captions_bytes'),
    cues: col.int.decode(r.cues, 'cues'),
    status: col.enum(RecordingStatus.options).decode(r.status, 'status'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    completedAt: col.ts.nullable.decode(r.completed_at, 'completed_at'),
    deletedAt: col.ts.nullable.decode(r.deleted_at, 'deleted_at'),
    deletedReason: col.enum(RECORDING_DELETE_REASONS).nullable.decode(r.deleted_reason, 'deleted_reason'),
    conversationTitle: col.text.nullable.decode(r.conversation_title, 'conversation_title'),
  };
}

/** The recording as its owner sees it. */
export function toRecordingView(recording: RecordingRecord): RecordingView {
  return {
    id: recording.id,
    callId: recording.callId,
    sessionId: recording.sessionId,
    ventureId: recording.ventureId,
    conversationTitle: recording.conversationTitle,
    mimeType: recording.mimeType,
    kind: recording.mimeType.startsWith('video/') ? 'video' : 'audio',
    bytes: recording.bytes,
    durationMs: recording.durationMs,
    hasCaptions: recording.captionsKey !== null,
    status: recording.status,
    createdAt: recording.createdAt,
    // Registered as its save began, so it began its length earlier.
    startedAt: new Date(Date.parse(recording.createdAt) - recording.durationMs).toISOString(),
    completedAt: recording.completedAt,
  };
}

export interface CreateRecordingInput {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly recordedBy: string;
  readonly mimeType: z.infer<typeof RecordingMimeType>;
  readonly bytes: number;
  readonly durationMs: number;
  readonly storageKey: string;
  readonly captions: { readonly key: string; readonly bytes: number; readonly cues: number } | null;
}

/** Registers a pending recording (RLS: the caller's own call, in a remembered conversation that still exists). */
export async function createRecording(
  ex: SqlExecutor,
  input: CreateRecordingInput,
): Promise<RecordingRecord> {
  await ex.query(
    `INSERT INTO call_recordings (id, tenant_id, venture_id, session_id, call_id, recorded_by, mime_type, bytes,
                                  duration_ms, storage_key, captions_key, captions_bytes, cues)
     VALUES (:id, :tenant, :venture, :session, :call, :by, :mime, :bytes, :duration, :key, :captionsKey,
             :captionsBytes, :cues)`,
    {
      id: p.uuid(input.id),
      tenant: p.uuid(input.tenantId),
      venture: p.uuid(input.ventureId),
      session: p.uuid(input.sessionId),
      call: p.uuid(input.callId),
      by: p.uuid(input.recordedBy),
      mime: p.text(input.mimeType),
      bytes: p.int(input.bytes),
      duration: p.int(input.durationMs),
      key: p.text(input.storageKey),
      captionsKey: p.nullable.text(input.captions?.key ?? null),
      captionsBytes: p.nullable.int(input.captions?.bytes ?? null),
      cues: p.int(input.captions?.cues ?? 0),
    },
  );
  const created = await getRecording(ex, input.id);
  if (created === null) throw new Error('call recording not visible after insert');
  return created;
}

/** A recording by id, deleted or not (null when it does not exist or is not the caller's). */
export function getRecording(ex: SqlExecutor, id: string): Promise<RecordingRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS} FROM ${FROM} WHERE r.id = :id`,
    { id: p.uuid(id) },
    decodeRecording,
  );
}

/**
 * Recordings the caller started today (UTC) and still has, saved or still uploading: the daily limit. One they deleted
 * (its files go with it) no longer counts, so recording and deleting takes in a rehearsal never uses the day up; an
 * upload that never finished counts until it is abandoned, since its presigned PUTs could still store a file.
 */
export function recordingsToday(ex: SqlExecutor, principalId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM call_recordings
     WHERE recorded_by = :principal AND deleted_at IS NULL
       AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
    { principal: p.uuid(principalId) },
  );
}

/** A pending recording whose files arrived becomes ready (null: not pending, deleted or not the caller's). */
export function markReady(ex: SqlExecutor, id: string): Promise<RecordingRecord | null> {
  return queryFirst(
    ex,
    `WITH done AS (
       UPDATE call_recordings SET status = 'ready', completed_at = now()
       WHERE id = :id AND status = 'pending' AND deleted_at IS NULL
       RETURNING *)
     SELECT ${columns('d')} FROM done d LEFT JOIN coaching_sessions s ON s.id = d.session_id`,
    { id: p.uuid(id) },
    decodeRecording,
  );
}

/** Deletes a recording (its files follow: {@link listPurgeable}); null when it was already deleted or is not visible. */
export function softDeleteRecording(
  ex: SqlExecutor,
  id: string,
  reason: 'founder',
): Promise<RecordingRecord | null> {
  return queryFirst(
    ex,
    `WITH gone AS (
       UPDATE call_recordings SET deleted_at = now(), deleted_reason = :reason
       WHERE id = :id AND deleted_at IS NULL
       RETURNING *)
     SELECT ${columns('d')} FROM gone d LEFT JOIN coaching_sessions s ON s.id = d.session_id`,
    { id: p.uuid(id), reason: p.text(reason) },
    decodeRecording,
  );
}

export interface ListRecordingsOptions {
  readonly sessionId?: string | null;
  readonly ventureId?: string | null;
  /** Opaque cursor from the previous page. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface RecordingPage {
  readonly items: RecordingRecord[];
  /** The next (older) page's cursor; null on the last page. */
  readonly nextCursor: string | null;
}

/**
 * Exact keyset position: the registration in microseconds since the epoch (JS dates keep milliseconds only), as a
 * number, so the SQL text carries no time-format literal (see sessions' ACTIVITY_MICROS_SQL).
 */
const CREATED_MICROS_SQL = `(extract(epoch FROM r.created_at) * 1000000)::bigint::text`;
const MICROS = /^\d{1,16}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes a keyset position (registration in microseconds since the epoch, id) as an opaque cursor. */
export function encodeRecordingCursor(createdMicros: string, id: string): string {
  return Buffer.from(`${createdMicros}|${id}`, 'utf8').toString('base64url');
}

/** Decodes a cursor; null when it is malformed. */
export function decodeRecordingCursor(cursor: string): { createdMicros: string; id: string } | null {
  const [position, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (position === undefined || id === undefined || !MICROS.test(position) || !UUID_TEXT.test(id))
    return null;
  return { createdMicros: position, id: id.toLowerCase() };
}

/**
 * The caller's ready recordings, latest first (one conversation's, one venture's, or all of them), one keyset page at
 * a time, of ventures the caller still has: a membership revoked or expired takes that venture's recordings off the
 * list at once.
 */
export async function listRecordings(
  ex: SqlExecutor,
  options: ListRecordingsOptions = {},
): Promise<RecordingPage> {
  const limit = clampLimit(options.limit, 50, 100);
  const cursor = options.cursor ? decodeRecordingCursor(options.cursor) : null;
  const rows = await queryRows(
    ex,
    `SELECT ${COLUMNS}, ${CREATED_MICROS_SQL} AS created_micros FROM ${FROM}
     WHERE r.deleted_at IS NULL AND r.status = 'ready' AND app.can_read_venture(r.venture_id)
       AND (:session IS NULL OR r.session_id = :session)
       AND (:venture IS NULL OR r.venture_id = :venture)
       AND (:cursorAt IS NULL OR (r.created_at, r.id) < ((:cursorAt)::timestamptz, :cursorId))
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT :limit`,
    {
      session: p.nullable.uuid(options.sessionId ?? null),
      venture: p.nullable.uuid(options.ventureId ?? null),
      cursorAt: p.nullable.text(cursor ? microsToIso(cursor.createdMicros) : null),
      cursorId: p.nullable.uuid(cursor?.id),
      limit: p.int(limit + 1),
    },
    (r) => ({
      recording: decodeRecording(r),
      createdMicros: col.text.decode(r.created_micros, 'created_micros'),
    }),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => row.recording),
    nextCursor:
      rows.length > limit && last ? encodeRecordingCursor(last.createdMicros, last.recording.id) : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Owner role: removing the files of deleted recordings
// ------------------------------------------------------------------------------------------------

/** The files of a deleted recording still to remove from the bucket. */
export interface PurgeableRecording {
  readonly id: string;
  readonly storageKey: string;
  readonly captionsKey: string | null;
}

/**
 * Uploads nobody finished: pending recordings older than `olderThanSeconds` are deleted (`abandoned`), so their files
 * (if any arrived) are purged with the rest. Returns how many.
 */
export function abandonStalePending(
  sx: SystemExecutor,
  options: { olderThanSeconds: number },
): Promise<number> {
  return queryNumber(
    sx,
    `WITH gone AS (
       UPDATE call_recordings SET deleted_at = now(), deleted_reason = 'abandoned'
       WHERE status = 'pending' AND deleted_at IS NULL AND created_at < now() - make_interval(secs => :secs)
       RETURNING 1)
     SELECT count(*) AS n FROM gone`,
    { secs: p.int(options.olderThanSeconds) },
  );
}

/** Recordings older than `olderThanDays` are deleted (`expired`): kept as long as recordings are. Returns how many. */
export function expireOldRecordings(sx: SystemExecutor, options: { olderThanDays: number }): Promise<number> {
  return queryNumber(
    sx,
    `WITH gone AS (
       UPDATE call_recordings SET deleted_at = now(), deleted_reason = 'expired'
       WHERE deleted_at IS NULL AND created_at < now() - make_interval(days => :days)
       RETURNING 1)
     SELECT count(*) AS n FROM gone`,
    { days: p.int(options.olderThanDays) },
  );
}

/** Deleted recordings whose files are still in the bucket, oldest first (optionally of one conversation). */
export function listPurgeable(
  sx: SystemExecutor,
  options: { readonly limit: number; readonly sessionId?: string | null; readonly id?: string | null },
): Promise<PurgeableRecording[]> {
  return queryRows(
    sx,
    `SELECT id, storage_key, captions_key FROM call_recordings
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL
       AND (:session IS NULL OR session_id = :session)
       AND (:id IS NULL OR id = :id)
     ORDER BY deleted_at, id
     LIMIT :limit`,
    {
      limit: p.int(clampLimit(options.limit, 100, 1000)),
      session: p.nullable.uuid(options.sessionId ?? null),
      id: p.nullable.uuid(options.id ?? null),
    },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      storageKey: col.text.decode(r.storage_key, 'storage_key'),
      captionsKey: col.text.nullable.decode(r.captions_key, 'captions_key'),
    }),
  );
}

/**
 * The files of these deleted recordings are gone from the bucket, and none can arrive any more: a recording deleted
 * while its upload may still be running (pending, created within `uploadWindowSeconds`) is left purgeable, so a file
 * that lands after this purge is removed by the next one (the daily maintenance). Returns how many were marked.
 */
export async function markPurged(
  sx: SystemExecutor,
  ids: readonly string[],
  options: { readonly uploadWindowSeconds: number },
): Promise<number> {
  if (ids.length === 0) return 0;
  return queryNumber(
    sx,
    `WITH done AS (
       UPDATE call_recordings SET purged_at = now()
       WHERE id = ANY (:ids) AND deleted_at IS NOT NULL AND purged_at IS NULL
         AND (status = 'ready' OR created_at < now() - make_interval(secs => :window))
       RETURNING 1)
     SELECT count(*) AS n FROM done`,
    { ids: p.uuidArray([...ids]), window: p.int(options.uploadWindowSeconds) },
  );
}
