import {
  CoachMode,
  ConversationDigest,
  SessionPrivacy,
  SessionRecap,
  SessionStatus,
  type SessionView,
} from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, fetchByIdsInBatches, queryFirst, queryNumber, queryOne, queryRows } from './common.js';
import { EPHEMERAL_REDACTION_TEXT } from './turns.js';

type CoachModeValue = z.infer<typeof CoachMode>;
type SessionRecapValue = z.infer<typeof SessionRecap>;
type ConversationDigestValue = z.infer<typeof ConversationDigest>;

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly assignmentId: string;
  readonly personaReleaseId: string;
  readonly startedBy: string;
  readonly mode: CoachModeValue;
  readonly privacy: z.infer<typeof SessionPrivacy>;
  readonly goal: string | null;
  readonly status: z.infer<typeof SessionStatus>;
  readonly policyVersion: string;
  readonly recap: SessionRecapValue | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /**
   * Conversation title (from the first message, renamed by people, refined by distillation). Founder text:
   * null for readers outside the venture's founder/team (an assigned EIR). Never set for temporary chats.
   */
  readonly title: string | null;
  /** Who set the title: `auto` (first message or distillation, which may replace it) or a `person`. */
  readonly titleSource: 'auto' | 'person';
  /** Latest turn or the start (maintained by the `turns_touch_session` trigger). */
  readonly lastActivityAt: string;
  /** Whether any turn was spoken during a call. */
  readonly hasCalls: boolean;
  /** AI-written digest (never for temporary chats). Content: never log it. */
  readonly digest: ConversationDigestValue | null;
  /** Set when a person deleted the digest: distillation never writes one again. */
  readonly digestDeletedAt: string | null;
  readonly distilledAt: string | null;
  /** Number of turns the stored digest covers (0: never distilled). */
  readonly distillVersion: number;
  /** The vEIR's validated opening line (standard conversations only). AI-written: never log it. */
  readonly opener: string | null;
}

/**
 * A column holding the founder's own words (title, goal), readable only by the venture's founder/team: an
 * assigned EIR may read conversation rows (RLS) but gets null here. System work (owner role, no principal)
 * reads it as stored.
 */
function memberOnly(column: string): string {
  return `CASE WHEN app.current_principal() IS NULL OR app.can_write_venture(s.venture_id) THEN ${column} END`;
}

const COLUMNS = `s.id, s.tenant_id, s.venture_id, s.assignment_id, s.persona_release_id, s.started_by, s.mode, s.privacy,
  ${memberOnly('s.goal')} AS goal, s.status, s.policy_version, s.recap, s.started_at, s.ended_at,
  ${memberOnly('s.title')} AS title, s.title_source, s.last_activity_at, s.has_calls, s.digest, s.digest_deleted_at,
  s.distilled_at, s.distill_version, s.opener`;

/** Parses a stored recap; recaps that no longer match the contract are treated as absent. */
function decodeRecap(raw: unknown): SessionRecapValue | null {
  const value = col.json().nullable.decode(raw, 'recap');
  if (value === null) return null;
  const parsed = SessionRecap.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parses a stored digest; digests that no longer match the contract are treated as absent. */
function decodeDigest(raw: unknown): ConversationDigestValue | null {
  const value = col.json().nullable.decode(raw, 'digest');
  if (value === null) return null;
  const parsed = ConversationDigest.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeSession(r: RawRow): SessionRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    assignmentId: col.uuid.decode(r.assignment_id, 'assignment_id'),
    personaReleaseId: col.uuid.decode(r.persona_release_id, 'persona_release_id'),
    startedBy: col.uuid.decode(r.started_by, 'started_by'),
    mode: col.enum(CoachMode.options).decode(r.mode, 'mode'),
    privacy: col.enum(SessionPrivacy.options).decode(r.privacy, 'privacy'),
    goal: col.text.nullable.decode(r.goal, 'goal'),
    status: col.enum(SessionStatus.options).decode(r.status, 'status'),
    policyVersion: col.text.decode(r.policy_version, 'policy_version'),
    recap: decodeRecap(r.recap),
    startedAt: col.ts.decode(r.started_at, 'started_at'),
    endedAt: col.ts.nullable.decode(r.ended_at, 'ended_at'),
    title: col.text.nullable.decode(r.title, 'title'),
    titleSource: col.enum(['auto', 'person'] as const).decode(r.title_source, 'title_source'),
    lastActivityAt: col.ts.decode(r.last_activity_at, 'last_activity_at'),
    hasCalls: col.bool.decode(r.has_calls, 'has_calls'),
    digest: decodeDigest(r.digest),
    digestDeletedAt: col.ts.nullable.decode(r.digest_deleted_at, 'digest_deleted_at'),
    distilledAt: col.ts.nullable.decode(r.distilled_at, 'distilled_at'),
    distillVersion: col.int.decode(r.distill_version, 'distill_version'),
    opener: col.text.nullable.decode(r.opener, 'opener'),
  };
}

export function getSession(ex: SqlExecutor, id: string): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS} FROM coaching_sessions s WHERE s.id = :id`,
    { id: p.uuid(id) },
    decodeSession,
  );
}

export interface CreateSessionInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly assignmentId: string;
  readonly personaReleaseId: string;
  /** Must be the request principal under RLS. */
  readonly startedBy: string;
  readonly mode: CoachModeValue;
  readonly privacy: SessionRecord['privacy'];
  readonly goal?: string | null;
  /** Version tag of the policy/validator bundle in force (e.g. `2026-10-05.1`). */
  readonly policyVersion: string;
  /** Title chosen by the person (standard conversations only); otherwise the first message titles it. */
  readonly title?: string | null;
  /** The vEIR's validated opening line (standard conversations only; at most 300 characters). */
  readonly opener?: string | null;
}

export function createSession(ex: SqlExecutor, input: CreateSessionInput): Promise<SessionRecord> {
  return queryOne(
    ex,
    `INSERT INTO coaching_sessions AS s (id, tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                         privacy, goal, policy_version, title, title_source, opener)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :assignmentId, :releaseId, :startedBy, :mode,
             :privacy, :goal, :policyVersion, :title, CASE WHEN :title IS NULL THEN 'auto' ELSE 'person' END,
             :opener)
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      assignmentId: p.uuid(input.assignmentId),
      releaseId: p.uuid(input.personaReleaseId),
      startedBy: p.uuid(input.startedBy),
      mode: p.text(input.mode),
      privacy: p.text(input.privacy),
      goal: p.nullable.text(input.goal),
      policyVersion: p.text(input.policyVersion),
      title: p.nullable.text(input.title),
      opener: p.nullable.text(input.opener),
    },
    decodeSession,
    'createSession',
  );
}

/**
 * Ends an active session and stores the recap (null for ephemeral sessions, which also lose their title).
 * Null when not active/visible.
 */
export function endSession(
  ex: SqlExecutor,
  args: { sessionId: string; recap: SessionRecapValue | null },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s
     SET status = 'ended', ended_at = now(), recap = :recap,
         title = CASE WHEN s.privacy = 'ephemeral' THEN NULL ELSE s.title END
     WHERE s.id = :id AND s.status = 'active'
     RETURNING ${COLUMNS}`,
    { id: p.uuid(args.sessionId), recap: p.nullable.json(args.recap) },
    decodeSession,
  );
}

export function setSessionStatus(
  ex: SqlExecutor,
  args: { sessionId: string; status: SessionRecord['status'] },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s
     SET status = :status, ended_at = CASE WHEN :status = 'ended' THEN coalesce(s.ended_at, now()) ELSE s.ended_at END
     WHERE s.id = :id RETURNING ${COLUMNS}`,
    { id: p.uuid(args.sessionId), status: p.text(args.status) },
    decodeSession,
  );
}

/** Changes the session's current mode (a turn may switch mode). */
export function setSessionMode(
  ex: SqlExecutor,
  args: { sessionId: string; mode: CoachModeValue },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s SET mode = :mode WHERE s.id = :id AND s.status = 'active' RETURNING ${COLUMNS}`,
    { id: p.uuid(args.sessionId), mode: p.text(args.mode) },
    decodeSession,
  );
}

/**
 * Moves an active conversation to another approved release of its persona (its own release was withdrawn or
 * expired). Null when the conversation is not active or not visible.
 */
export function setSessionRelease(
  ex: SqlExecutor,
  args: { sessionId: string; releaseId: string },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s SET persona_release_id = :releaseId
     WHERE s.id = :id AND s.status = 'active' RETURNING ${COLUMNS}`,
    { id: p.uuid(args.sessionId), releaseId: p.uuid(args.releaseId) },
    decodeSession,
  );
}

/**
 * Renames a standard conversation (founder/team under RLS); the title is then the person's, which
 * distillation never replaces. Null when not visible or temporary (temporary chats keep no title).
 */
export function renameSession(
  ex: SqlExecutor,
  args: { sessionId: string; title: string },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s SET title = :title, title_source = 'person'
     WHERE s.id = :id AND s.privacy = 'standard'
     RETURNING ${COLUMNS}`,
    { id: p.uuid(args.sessionId), title: p.text(args.title) },
    decodeSession,
  );
}

/**
 * Stores the distilled digest of a standard conversation and the number of turns it covers, and its refined
 * `title` unless a person chose the title. Never writes a digest a person deleted, nor one for a temporary or
 * deleted conversation. Returns whether it was stored.
 */
export async function setSessionDigest(
  ex: SqlExecutor,
  args: { sessionId: string; digest: ConversationDigestValue; distillVersion: number; title?: string | null },
): Promise<boolean> {
  const result = await ex.query(
    `UPDATE coaching_sessions AS s
     SET digest = :digest, distilled_at = now(), distill_version = :version,
         title = CASE WHEN s.title_source = 'auto' THEN coalesce(:title, s.title) ELSE s.title END
     WHERE s.id = :id AND s.privacy = 'standard' AND s.deleted_at IS NULL AND s.digest_deleted_at IS NULL`,
    {
      id: p.uuid(args.sessionId),
      digest: p.json(ConversationDigest.parse(args.digest)),
      version: p.int(Math.max(0, Math.trunc(args.distillVersion))),
      title: p.nullable.text(args.title),
    },
  );
  return result.rowCount > 0;
}

/**
 * Deletes a conversation's digest at a person's request; distillation never writes it again. Null when the
 * conversation is not visible/updatable.
 */
export function deleteSessionDigest(ex: SqlExecutor, sessionId: string): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s SET digest = NULL, digest_deleted_at = coalesce(s.digest_deleted_at, now())
     WHERE s.id = :id RETURNING ${COLUMNS}`,
    { id: p.uuid(sessionId) },
    decodeSession,
  );
}

/**
 * Deletes a conversation (`app.soft_delete_session`): its content is erased like an ended temporary chat and
 * it disappears from every list. Returns false when it is unknown or not visible; raises 42501 for readers
 * who may not write the venture.
 */
export async function softDeleteSession(ex: SqlExecutor, sessionId: string): Promise<boolean> {
  const row = await queryFirst(
    ex,
    'SELECT app.soft_delete_session(:id) AS deleted',
    { id: p.uuid(sessionId) },
    (r) => col.bool.decode(r.deleted, 'deleted'),
  );
  return row ?? false;
}

// ------------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------------

const VIEW_SELECT = `
  SELECT ${COLUMNS}, pe.id AS persona_id, pe.name AS persona_name, r.version AS persona_version, r.disclosure_text,
         st.display_name AS started_by_name,
         (SELECT count(*) FROM turns t WHERE t.session_id = s.id) AS turn_count
  FROM coaching_sessions s
  JOIN persona_releases r ON r.id = s.persona_release_id
  JOIN personas pe ON pe.id = r.persona_id
  LEFT JOIN principals st ON st.id = s.started_by`;

function decodeView(r: RawRow): SessionView {
  const s = decodeSession(r);
  return {
    id: s.id,
    ventureId: s.ventureId,
    mode: s.mode,
    privacy: s.privacy,
    goal: s.goal,
    status: s.status,
    personaName: col.text.decode(r.persona_name, 'persona_name'),
    personaVersion: col.int.decode(r.persona_version, 'persona_version'),
    disclosure: col.text.decode(r.disclosure_text, 'disclosure_text'),
    startedBy: {
      id: s.startedBy,
      displayName: col.text.nullable.decode(r.started_by_name, 'started_by_name') ?? 'Unknown person',
    },
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turnCount: col.int.decode(r.turn_count, 'turn_count'),
    recap: s.recap,
    title: s.title,
    personaId: col.uuid.decode(r.persona_id, 'persona_id'),
    lastActivityAt: s.lastActivityAt,
    hasCalls: s.hasCalls,
    digest: s.privacy === 'standard' ? s.digest : null,
    opener: s.privacy === 'standard' ? s.opener : null,
  };
}

export function getSessionView(ex: SqlExecutor, id: string): Promise<SessionView | null> {
  return queryFirst(ex, `${VIEW_SELECT} WHERE s.id = :id`, { id: p.uuid(id) }, decodeView);
}

/**
 * Session views per statement: each carries its recap (≈15 kB at most) and digest (≈5 kB at most), so 20 stay
 * far below 1 MB.
 */
const SESSION_BATCH_SIZE = 20;

function viewsByIds(ex: SqlExecutor, ids: readonly string[]): Promise<SessionView[]> {
  return fetchByIdsInBatches(
    ids,
    SESSION_BATCH_SIZE,
    (batch) =>
      queryRows(ex, `${VIEW_SELECT} WHERE s.id = ANY (:ids)`, { ids: p.uuidArray(batch) }, decodeView),
    (view) => view.id,
  );
}

/** Sessions of a venture, latest activity first (contract `SessionView`; ids first, then batches for the Data API). */
export async function listSessionViews(
  ex: SqlExecutor,
  args: { ventureId: string; limit?: number; status?: SessionRecord['status'] },
): Promise<SessionView[]> {
  const ids = await queryRows(
    ex,
    `SELECT s.id FROM coaching_sessions s
     WHERE s.venture_id = :ventureId AND (:status IS NULL OR s.status = :status)
     ORDER BY s.last_activity_at DESC, s.id DESC
     LIMIT :limit`,
    {
      ventureId: p.uuid(args.ventureId),
      status: p.nullable.text(args.status),
      limit: p.int(clampLimit(args.limit, 50, 200)),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return viewsByIds(ex, ids);
}

export interface SessionPageQuery {
  /** The caller (must be the request principal). */
  readonly principalId: string;
  /** `mine`: started by the caller; `all`: every conversation of ventures the caller works on. */
  readonly scope: 'mine' | 'all';
  readonly ventureId?: string | null;
  /** Opaque cursor from the previous page. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface SessionPage {
  readonly items: SessionView[];
  readonly nextCursor: string | null;
}

/**
 * Exact keyset position: the latest activity in microseconds since the epoch (JS dates keep milliseconds
 * only). Computed as a number, so the SQL text carries no time-format literal such as `HH24:MI:SS`, whose
 * `:MI` the RDS Data API's own parameter parser could take for a placeholder.
 */
const ACTIVITY_MICROS_SQL = `(extract(epoch FROM s.last_activity_at) * 1000000)::bigint::text`;
const MICROS = /^\d{1,16}$/;
/** The position of cursors issued before it was numeric: the activity as `…ss.ffffffZ` in UTC. */
const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes a keyset position (latest activity in microseconds since the epoch, id) as an opaque cursor. */
export function encodeSessionCursor(activityMicros: string, id: string): string {
  return Buffer.from(`${activityMicros}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor; null when it is malformed. A cursor in the earlier ISO form is read as the same
 * position, so a list paging across the deploy that changed the form keeps its place.
 */
export function decodeSessionCursor(cursor: string): { activityMicros: string; id: string } | null {
  const [position, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (position === undefined || id === undefined || !UUID_TEXT.test(id)) return null;
  const activityMicros = MICROS.test(position)
    ? position
    : ISO_MICROS.test(position)
      ? isoToMicros(position)
      : null;
  return activityMicros === null ? null : { activityMicros, id: id.toLowerCase() };
}

/** Microseconds since the epoch as an exact ISO timestamp (`…ss.ffffffZ`). */
export function microsToIso(micros: string): string {
  const value = BigInt(micros);
  const millis = new Date(Number(value / 1000n)).toISOString();
  return `${millis.slice(0, -1)}${(value % 1000n).toString().padStart(3, '0')}Z`;
}

/** An exact `…ss.ffffffZ` timestamp as microseconds since the epoch; null for an impossible date. */
function isoToMicros(iso: string): string | null {
  const millis = Date.parse(`${iso.slice(0, 23)}Z`);
  if (Number.isNaN(millis) || millis < 0) return null;
  const micros = (BigInt(millis) * 1000n + BigInt(iso.slice(23, 26))).toString();
  return microsToIso(micros) === iso ? micros : null;
}

/**
 * The caller's conversations across every venture they work on (founder/team), latest activity first, one
 * keyset page at a time (sidebar recents). Deleted conversations are hidden by RLS.
 */
export async function listSessionPage(ex: SqlExecutor, q: SessionPageQuery): Promise<SessionPage> {
  const limit = clampLimit(q.limit, 30, 100);
  const cursor = q.cursor ? decodeSessionCursor(q.cursor) : null;
  const rows = await queryRows(
    ex,
    `SELECT s.id, ${ACTIVITY_MICROS_SQL} AS activity_micros FROM coaching_sessions s
     WHERE app.can_write_venture(s.venture_id)
       AND (:mine = false OR s.started_by = :principal)
       AND (:ventureId IS NULL OR s.venture_id = :ventureId)
       AND (:cursorAt IS NULL OR (s.last_activity_at, s.id) < ((:cursorAt)::timestamptz, :cursorId))
     ORDER BY s.last_activity_at DESC, s.id DESC
     LIMIT :limit`,
    {
      mine: p.bool(q.scope === 'mine'),
      principal: p.uuid(q.principalId),
      ventureId: p.nullable.uuid(q.ventureId),
      cursorAt: p.nullable.text(cursor ? microsToIso(cursor.activityMicros) : null),
      cursorId: p.nullable.uuid(cursor?.id),
      limit: p.int(limit + 1),
    },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      activityMicros: col.text.decode(r.activity_micros, 'activity_micros'),
    }),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await viewsByIds(
      ex,
      page.map((r) => r.id),
    ),
    nextCursor: rows.length > limit && last ? encodeSessionCursor(last.activityMicros, last.id) : null,
  };
}

export interface RecentDigest {
  readonly sessionId: string;
  readonly title: string | null;
  readonly lastActivityAt: string;
  /** Whether any turn was spoken during a call. */
  readonly hasCalls: boolean;
  readonly digest: ConversationDigestValue;
}

/**
 * The latest digests of a venture's conversations with one persona ("Previous conversations" in the
 * prompt), newest first. Temporary and deleted conversations never have one. Titles follow the session
 * rule: null for readers outside the founder/team.
 */
export async function listRecentDigests(
  ex: SqlExecutor,
  args: { ventureId: string; personaId: string; excludeSessionId?: string | null; limit?: number },
): Promise<RecentDigest[]> {
  const rows = await queryRows(
    ex,
    `SELECT s.id, ${memberOnly('s.title')} AS title, s.last_activity_at, s.has_calls, s.digest
     FROM coaching_sessions s
     JOIN persona_releases r ON r.id = s.persona_release_id
     WHERE s.venture_id = :ventureId AND r.persona_id = :personaId AND s.digest IS NOT NULL
       AND s.privacy = 'standard' AND (:except IS NULL OR s.id <> :except)
     ORDER BY s.last_activity_at DESC, s.id DESC
     LIMIT :limit`,
    {
      ventureId: p.uuid(args.ventureId),
      personaId: p.uuid(args.personaId),
      except: p.nullable.uuid(args.excludeSessionId),
      limit: p.int(clampLimit(args.limit, 3, 20)),
    },
    (r) => ({
      sessionId: col.uuid.decode(r.id, 'id'),
      title: col.text.nullable.decode(r.title, 'title'),
      lastActivityAt: col.ts.decode(r.last_activity_at, 'last_activity_at'),
      hasCalls: col.bool.decode(r.has_calls, 'has_calls'),
      digest: decodeDigest(r.digest),
    }),
  );
  return rows.flatMap((r) => (r.digest === null ? [] : [{ ...r, digest: r.digest }]));
}

export interface DistillationCandidate {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly ventureId: string;
  /** Turns the conversation has now (the digest's `distill_version` once written). */
  readonly turnCount: number;
}

/**
 * Standard conversations whose digest is missing or older than their turns, that ended or have been idle
 * for `idleSeconds` (system: the distillation sweep). Never temporary, deleted or digest-deleted ones.
 */
export function listDistillationCandidates(
  sx: SystemExecutor,
  args: { idleSeconds: number; limit?: number },
): Promise<DistillationCandidate[]> {
  return queryRows(
    sx,
    `SELECT x.id, x.tenant_id, x.venture_id, x.turn_count FROM (
       SELECT s.id, s.tenant_id, s.venture_id, s.distill_version, s.last_activity_at,
              (SELECT count(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'completed') AS turn_count
       FROM coaching_sessions s
       WHERE s.privacy = 'standard' AND s.deleted_at IS NULL AND s.digest_deleted_at IS NULL
         AND (s.status = 'ended' OR s.last_activity_at < now() - make_interval(secs => :idle))) x
     WHERE x.turn_count > x.distill_version
     ORDER BY x.last_activity_at
     LIMIT :limit`,
    { idle: p.num(args.idleSeconds), limit: p.int(clampLimit(args.limit, 25, 200)) },
    (r) => ({
      sessionId: col.uuid.decode(r.id, 'id'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      turnCount: col.int.decode(r.turn_count, 'turn_count'),
    }),
  );
}

/** A conversation as distillation sees it (system executor: deleted conversations included). */
export interface DistillState extends SessionRecord {
  readonly deletedAt: string | null;
  /** The persona of the conversation's pinned release (whose notebook it feeds). */
  readonly personaId: string;
  /** Completed turns now; the digest covers `distillVersion` of them. */
  readonly completedTurns: number;
}

/**
 * The distillation state of a conversation, or null when it does not exist. `lock` takes a row lock for the
 * rest of the transaction, so a concurrent delete, digest deletion or second distillation waits for it.
 */
export function getDistillState(
  ex: SqlExecutor,
  sessionId: string,
  options: { readonly lock?: boolean } = {},
): Promise<DistillState | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS}, s.deleted_at, r.persona_id,
            (SELECT count(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'completed') AS completed_turns
     FROM coaching_sessions s
     JOIN persona_releases r ON r.id = s.persona_release_id
     WHERE s.id = :id${options.lock ? '\n     FOR UPDATE OF s' : ''}`,
    { id: p.uuid(sessionId) },
    (r) => ({
      ...decodeSession(r),
      deletedAt: col.ts.nullable.decode(r.deleted_at, 'deleted_at'),
      personaId: col.uuid.decode(r.persona_id, 'persona_id'),
      completedTurns: col.int.decode(r.completed_turns, 'completed_turns'),
    }),
  );
}

/**
 * Records that distillation covered `distillVersion` turns without a new digest (nothing worth keeping, or
 * the result was blocked), so neither the delayed trigger nor the backstop retries it until a new turn.
 * Returns whether it was recorded.
 */
export async function markSessionDistilled(
  ex: SqlExecutor,
  args: { sessionId: string; distillVersion: number },
): Promise<boolean> {
  const result = await ex.query(
    `UPDATE coaching_sessions AS s
     SET distilled_at = now(), distill_version = greatest(s.distill_version, :version)
     WHERE s.id = :id AND s.privacy = 'standard' AND s.deleted_at IS NULL`,
    { id: p.uuid(args.sessionId), version: p.int(Math.max(0, Math.trunc(args.distillVersion))) },
  );
  return result.rowCount > 0;
}

/**
 * Claims a conversation for one distillation run (migration 0007) until `seconds` from now: only when it
 * still has turns no digest covers (`turns` > its distill version) and no other run holds an unexpired claim.
 * Returns whether this run got it. The claim is released by {@link releaseDistillClaim}, or lapses.
 */
export async function claimDistillation(
  sx: SystemExecutor,
  args: { sessionId: string; claimId: string; turns: number; seconds: number },
): Promise<boolean> {
  const result = await sx.query(
    `UPDATE coaching_sessions AS s
     SET distill_claim_id = :claim, distill_claimed_until = now() + make_interval(secs => :secs)
     WHERE s.id = :id AND s.deleted_at IS NULL AND s.distill_version < :turns
       AND (s.distill_claimed_until IS NULL OR s.distill_claimed_until <= now())`,
    {
      id: p.uuid(args.sessionId),
      claim: p.uuid(args.claimId),
      turns: p.int(args.turns),
      secs: p.int(Math.max(1, Math.trunc(args.seconds))),
    },
  );
  return result.rowCount > 0;
}

/** Releases a run's claim (no-op when the claim lapsed and another run took it). */
export async function releaseDistillClaim(
  sx: SystemExecutor,
  args: { sessionId: string; claimId: string },
): Promise<void> {
  await sx.query(
    `UPDATE coaching_sessions AS s SET distill_claim_id = NULL, distill_claimed_until = NULL
     WHERE s.id = :id AND s.distill_claim_id = :claim`,
    { id: p.uuid(args.sessionId), claim: p.uuid(args.claimId) },
  );
}

/** Completed turns of a conversation (as visible to the executor). */
export function countCompletedTurns(ex: SqlExecutor, sessionId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM turns t WHERE t.session_id = :id AND t.status = 'completed'`,
    { id: p.uuid(sessionId) },
  );
}

/** The latest earlier conversation of a person in a venture, with what distillation needs to decide on it. */
export interface PreviousConversation {
  readonly id: string;
  readonly status: SessionRecord['status'];
  readonly privacy: SessionRecord['privacy'];
  readonly lastActivityAt: string;
  readonly distillVersion: number;
  readonly digestDeleted: boolean;
  readonly completedTurns: number;
}

/**
 * The person's most recent other conversation in the venture (deleted ones are hidden by RLS and excluded
 * for the system executor), or null.
 */
export function getPreviousConversation(
  ex: SqlExecutor,
  args: { ventureId: string; startedBy: string; excludeSessionId: string },
): Promise<PreviousConversation | null> {
  return queryFirst(
    ex,
    `SELECT s.id, s.status, s.privacy, s.last_activity_at, s.distill_version,
            s.digest_deleted_at IS NOT NULL AS digest_deleted,
            (SELECT count(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'completed') AS completed_turns
     FROM coaching_sessions s
     WHERE s.venture_id = :ventureId AND s.started_by = :startedBy AND s.id <> :except AND s.deleted_at IS NULL
     ORDER BY s.last_activity_at DESC, s.id DESC
     LIMIT 1`,
    {
      ventureId: p.uuid(args.ventureId),
      startedBy: p.uuid(args.startedBy),
      except: p.uuid(args.excludeSessionId),
    },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      status: col.enum(SessionStatus.options).decode(r.status, 'status'),
      privacy: col.enum(SessionPrivacy.options).decode(r.privacy, 'privacy'),
      lastActivityAt: col.ts.decode(r.last_activity_at, 'last_activity_at'),
      distillVersion: col.int.decode(r.distill_version, 'distill_version'),
      digestDeleted: col.bool.decode(r.digest_deleted, 'digest_deleted'),
      completedTurns: col.int.decode(r.completed_turns, 'completed_turns'),
    }),
  );
}

export interface EphemeralCleanupResult {
  /** Ephemeral sessions ended because nobody wrote in them for the idle period. */
  readonly sessionsEnded: number;
  /** Turns of ended ephemeral sessions whose content was erased by this run. */
  readonly turnsRedacted: number;
}

/**
 * Daily maintenance (system executor): ends every ephemeral session idle for `idleSeconds` (no turn and no
 * start inside the period) and erases the conversation content of every turn of an ephemeral session that
 * has ended, exactly as ending the session does (`turnsRepo.redactSessionTurns`). Covers
 * sessions abandoned without "End session" and anything an earlier end could not redact. Idempotent.
 */
export async function expireStaleEphemeralSessions(
  sx: SystemExecutor,
  args: { idleSeconds: number },
): Promise<EphemeralCleanupResult> {
  const ended = await sx.query(
    `UPDATE coaching_sessions s SET status = 'ended', ended_at = now(), recap = NULL, title = NULL
     WHERE s.privacy = 'ephemeral' AND s.status IN ('active', 'suspended')
       AND s.started_at < now() - make_interval(secs => :idle)
       AND NOT EXISTS (SELECT 1 FROM turns t
                       WHERE t.session_id = s.id AND t.created_at >= now() - make_interval(secs => :idle))`,
    { idle: p.num(args.idleSeconds) },
  );
  await sx.query(
    `UPDATE coaching_sessions s SET title = NULL
     WHERE s.privacy = 'ephemeral' AND s.status = 'ended' AND s.title IS NOT NULL`,
  );
  const redacted = await sx.query(
    `UPDATE turns t SET founder_text = :redacted, response = NULL
     FROM coaching_sessions s
     WHERE s.id = t.session_id AND s.privacy = 'ephemeral' AND s.status = 'ended'
       AND (t.founder_text <> :redacted OR t.response IS NOT NULL)`,
    { redacted: p.text(EPHEMERAL_REDACTION_TEXT) },
  );
  return { sessionsEnded: ended.rowCount, turnsRedacted: redacted.rowCount };
}

/** Start of the most recent session of the venture (excluding `exceptSessionId`), or null. */
export async function lastSessionAt(
  ex: SqlExecutor,
  args: { ventureId: string; exceptSessionId?: string | null },
): Promise<string | null> {
  const row = await queryFirst(
    ex,
    `SELECT max(started_at) AS at FROM coaching_sessions
     WHERE venture_id = :ventureId AND (:except IS NULL OR id <> :except)`,
    { ventureId: p.uuid(args.ventureId), except: p.nullable.uuid(args.exceptSessionId) },
    (r) => col.ts.nullable.decode(r.at, 'at'),
  );
  return row ?? null;
}
