import { CoachMode, SessionPrivacy, SessionRecap, SessionStatus, type SessionView } from '@foundry/contracts';
import { type z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, queryFirst, queryOne, queryRows } from './common.js';

type CoachModeValue = z.infer<typeof CoachMode>;
type SessionRecapValue = z.infer<typeof SessionRecap>;

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
}

const COLUMNS =
  's.id, s.tenant_id, s.venture_id, s.assignment_id, s.persona_release_id, s.started_by, s.mode, s.privacy, s.goal, s.status, s.policy_version, s.recap, s.started_at, s.ended_at';

/** Parses a stored recap; recaps that no longer match the contract are treated as absent. */
function decodeRecap(raw: unknown): SessionRecapValue | null {
  const value = col.json().nullable.decode(raw, 'recap');
  if (value === null) return null;
  const parsed = SessionRecap.safeParse(value);
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
}

export function createSession(ex: SqlExecutor, input: CreateSessionInput): Promise<SessionRecord> {
  return queryOne(
    ex,
    `INSERT INTO coaching_sessions AS s (id, tenant_id, venture_id, assignment_id, persona_release_id, started_by, mode,
                                         privacy, goal, policy_version)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :assignmentId, :releaseId, :startedBy, :mode,
             :privacy, :goal, :policyVersion)
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
    },
    decodeSession,
    'createSession',
  );
}

/** Ends an active session and stores the recap (null for ephemeral sessions). Null when not active/visible. */
export function endSession(
  ex: SqlExecutor,
  args: { sessionId: string; recap: SessionRecapValue | null },
): Promise<SessionRecord | null> {
  return queryFirst(
    ex,
    `UPDATE coaching_sessions AS s SET status = 'ended', ended_at = now(), recap = :recap
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

// ------------------------------------------------------------------------------------------------
// Views
// ------------------------------------------------------------------------------------------------

const VIEW_SELECT = `
  SELECT ${COLUMNS}, pe.name AS persona_name, r.version AS persona_version, r.disclosure_text,
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
  };
}

export function getSessionView(ex: SqlExecutor, id: string): Promise<SessionView | null> {
  return queryFirst(ex, `${VIEW_SELECT} WHERE s.id = :id`, { id: p.uuid(id) }, decodeView);
}

/** Sessions of a venture, newest first (contract `SessionView`). */
export function listSessionViews(
  ex: SqlExecutor,
  args: { ventureId: string; limit?: number; status?: SessionRecord['status'] },
): Promise<SessionView[]> {
  return queryRows(
    ex,
    `${VIEW_SELECT}
     WHERE s.venture_id = :ventureId AND (:status IS NULL OR s.status = :status)
     ORDER BY s.started_at DESC, s.id
     LIMIT :limit`,
    {
      ventureId: p.uuid(args.ventureId),
      status: p.nullable.text(args.status),
      limit: p.int(clampLimit(args.limit, 50, 200)),
    },
    decodeView,
  );
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
