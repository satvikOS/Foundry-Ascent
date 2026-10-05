import {
  EscalationCategory,
  EscalationPacket,
  EscalationPriority,
  EscalationStatus,
  OPEN_ESCALATION_STATUSES as CONTRACT_OPEN_STATUSES,
  RequestedRole,
  type EscalationQueueItem,
  type EscalationView,
} from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import {
  fetchByIdsInBatches,
  principalFrom,
  principalSelect,
  queryFirst,
  queryNumber,
  queryOne,
  queryRows,
  requiredPrincipalFrom,
} from './common.js';

type EscalationPacketValue = z.infer<typeof EscalationPacket>;
type EscalationStatusValue = z.infer<typeof EscalationStatus>;
type EscalationQueueItemValue = z.infer<typeof EscalationQueueItem>;

const Resolution = z.object({ summary: z.string(), nextSteps: z.array(z.string()) });
export type EscalationResolution = z.infer<typeof Resolution>;

/** Statuses that count as open (shown on venture cards / inbox). */
export const OPEN_ESCALATION_STATUSES: readonly EscalationStatusValue[] = CONTRACT_OPEN_STATUSES;

/** Contract view plus tenant and consent bookkeeping. */
export type EscalationRecord = EscalationView & {
  readonly tenantId: string;
  readonly sharingConsentBy: string | null;
  readonly resolvedBy: string | null;
};

function safeParse<T>(schema: z.ZodType<T>, raw: unknown, column: string): T | null {
  const value = col.json().nullable.decode(raw, column);
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const SELECT = `
  SELECT e.id, e.tenant_id, e.venture_id, coalesce(v.name, 'Shared venture') AS venture_name, e.session_id, e.turn_id, e.category, e.priority,
         e.status, e.requested_role, e.packet, e.sharing_consent_at, e.sharing_consent_by, e.assignee_principal_id,
         e.due_at, e.resolved_by, e.resolution, e.created_by, e.created_at, e.updated_at,
         ${principalSelect('asg', 'asg')}, ${principalSelect('cb', 'cb')}
  FROM escalations e
  -- LEFT: a consented assignee who is neither member nor assigned EIR cannot read the venture row.
  LEFT JOIN ventures v ON v.id = e.venture_id
  LEFT JOIN principals asg ON asg.id = e.assignee_principal_id
  LEFT JOIN principals cb ON cb.id = e.created_by`;

function decode(r: RawRow): EscalationRecord {
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    ventureName: col.text.decode(r.venture_name, 'venture_name'),
    sessionId: col.uuid.nullable.decode(r.session_id, 'session_id'),
    turnId: col.uuid.nullable.decode(r.turn_id, 'turn_id'),
    category: col.enum(EscalationCategory.options).decode(r.category, 'category'),
    priority: col.enum(EscalationPriority.options).decode(r.priority, 'priority'),
    status: col.enum(EscalationStatus.options).decode(r.status, 'status'),
    requestedRole: col.enum(RequestedRole.options).decode(r.requested_role, 'requested_role'),
    packet: safeParse(EscalationPacket, r.packet, 'packet'),
    sharingConsentAt: col.ts.nullable.decode(r.sharing_consent_at, 'sharing_consent_at'),
    sharingConsentBy: col.uuid.nullable.decode(r.sharing_consent_by, 'sharing_consent_by'),
    assignee: principalFrom(
      r,
      'asg',
      col.uuid.nullable.decode(r.assignee_principal_id, 'assignee_principal_id'),
    ),
    dueAt: col.ts.nullable.decode(r.due_at, 'due_at'),
    resolvedBy: col.uuid.nullable.decode(r.resolved_by, 'resolved_by'),
    resolution: safeParse(Resolution, r.resolution, 'resolution'),
    createdBy: requiredPrincipalFrom(r, 'cb', col.uuid.decode(r.created_by, 'created_by')),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    updatedAt: col.ts.decode(r.updated_at, 'updated_at'),
  };
}

export function getEscalation(ex: SqlExecutor, id: string): Promise<EscalationRecord | null> {
  return queryFirst(ex, `${SELECT} WHERE e.id = :id`, { id: p.uuid(id) }, decode);
}

/**
 * Escalations per statement: a packet can carry 30 shared facts of up to 1 000 characters plus the
 * question and unknowns (≈45 kB), so ten keep every Data API result far below its 1 MB limit.
 */
const ESCALATION_BATCH_SIZE = 10;

function escalationsByIds(ex: SqlExecutor, ids: readonly string[]): Promise<EscalationRecord[]> {
  return fetchByIdsInBatches(
    ids,
    ESCALATION_BATCH_SIZE,
    (batch) => queryRows(ex, `${SELECT} WHERE e.id = ANY (:ids)`, { ids: p.uuidArray(batch) }, decode),
    (e) => e.id,
  );
}

const idOf = (r: RawRow): string => col.uuid.decode(r.id, 'id');

/** Escalations of a venture, newest first (ids first, then batches). */
export async function listVentureEscalations(
  ex: SqlExecutor,
  args: { ventureId: string; statuses?: readonly EscalationStatusValue[] },
): Promise<EscalationRecord[]> {
  const ids = await queryRows(
    ex,
    `SELECT e.id FROM escalations e
     WHERE e.venture_id = :ventureId AND (:statuses IS NULL OR e.status = ANY (:statuses))
     ORDER BY e.created_at DESC, e.id`,
    { ventureId: p.uuid(args.ventureId), statuses: p.nullable.textArray(args.statuses) },
    idOf,
  );
  return escalationsByIds(ex, ids);
}

/**
 * The escalation drafted for each of the given turns (the oldest one when a turn has several), as
 * turn id → escalation id. Runs under the caller's RLS: only escalations the caller may read appear.
 */
export async function escalationIdsByTurn(
  ex: SqlExecutor,
  turnIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (turnIds.length === 0) return out;
  const rows = await queryRows(
    ex,
    `SELECT DISTINCT ON (e.turn_id) e.turn_id, e.id
     FROM escalations e
     WHERE e.turn_id = ANY (:turnIds)
     ORDER BY e.turn_id, e.created_at, e.id`,
    { turnIds: p.uuidArray(turnIds) },
    (r) => ({ turnId: col.uuid.decode(r.turn_id, 'turn_id'), id: col.uuid.decode(r.id, 'id') }),
  );
  for (const row of rows) out.set(row.turnId, row.id);
  return out;
}

/** Escalations assigned to a principal whose packet the founder agreed to share (EIR / staff inbox). */
export async function listInboxEscalations(
  ex: SqlExecutor,
  args: { assigneeId: string; includeClosed?: boolean },
): Promise<EscalationRecord[]> {
  const ids = await queryRows(
    ex,
    `SELECT e.id FROM escalations e
     WHERE e.assignee_principal_id = :assigneeId AND e.sharing_consent_at IS NOT NULL
       AND (:includeClosed OR e.status IN ('routed', 'acknowledged'))
     ORDER BY e.priority, e.created_at, e.id`,
    { assigneeId: p.uuid(args.assigneeId), includeClosed: p.bool(args.includeClosed ?? false) },
    idOf,
  );
  return escalationsByIds(ex, ids);
}

export function countOpenEscalations(ex: SqlExecutor, ventureId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM escalations WHERE venture_id = :ventureId AND status = ANY (:open)`,
    { ventureId: p.uuid(ventureId), open: p.textArray(OPEN_ESCALATION_STATUSES) },
  );
}

export interface CreateEscalationInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly category: EscalationRecord['category'];
  readonly priority: EscalationRecord['priority'];
  readonly requestedRole?: EscalationRecord['requestedRole'];
  readonly packet: EscalationPacketValue;
  /** Must be the request principal under RLS. */
  readonly createdBy: string;
  /** `draft` (AI-drafted, default) or `awaiting_consent` (founder-initiated, waiting for sharing approval). */
  readonly status?: 'draft' | 'awaiting_consent';
  readonly dueAt?: string | Date | null;
}

export async function createEscalation(
  ex: SqlExecutor,
  input: CreateEscalationInput,
): Promise<EscalationRecord> {
  const id = await queryOne(
    ex,
    `INSERT INTO escalations (id, tenant_id, venture_id, session_id, turn_id, category, priority, status,
                              requested_role, packet, created_by, due_at)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :sessionId, :turnId, :category, :priority,
             coalesce(:status, 'draft'), coalesce(:requestedRole, 'eir'), :packet, :createdBy, :dueAt)
     RETURNING id`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      sessionId: p.nullable.uuid(input.sessionId),
      turnId: p.nullable.uuid(input.turnId),
      category: p.text(input.category),
      priority: p.text(input.priority),
      status: p.nullable.text(input.status),
      requestedRole: p.nullable.text(input.requestedRole),
      packet: p.json(input.packet),
      createdBy: p.uuid(input.createdBy),
      dueAt: p.nullable.ts(input.dueAt),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'createEscalation',
  );
  const record = await getEscalation(ex, id);
  if (!record) throw new Error('escalation not visible after insert');
  return record;
}

/** Replaces the packet while the founder still controls it (draft / awaiting consent). */
export async function updateEscalationPacket(
  ex: SqlExecutor,
  args: { escalationId: string; packet: EscalationPacketValue },
): Promise<EscalationRecord | null> {
  const id = await queryFirst(
    ex,
    `UPDATE escalations SET packet = :packet, updated_at = now()
     WHERE id = :id AND status IN ('draft', 'awaiting_consent') RETURNING id`,
    { id: p.uuid(args.escalationId), packet: p.json(args.packet) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id ? getEscalation(ex, id) : null;
}

/**
 * Founder approves sharing the packet (only from `draft` / `awaiting_consent`). With an assignee the
 * escalation is `routed` immediately; otherwise it becomes `awaiting_assignment` (consented, waiting in
 * the program team's routing queue until {@link routeEscalation}).
 */
export async function recordSharingConsent(
  ex: SqlExecutor,
  args: {
    escalationId: string;
    consentBy: string;
    assigneeId?: string | null;
    dueAt?: string | Date | null;
    packet?: EscalationPacketValue;
  },
): Promise<EscalationRecord | null> {
  const id = await queryFirst(
    ex,
    `UPDATE escalations
     SET sharing_consent_at = now(), sharing_consent_by = :by,
         assignee_principal_id = coalesce(:assignee, assignee_principal_id),
         due_at = coalesce(:dueAt, due_at),
         packet = coalesce(:packet, packet),
         status = CASE WHEN coalesce(:assignee, assignee_principal_id) IS NOT NULL THEN 'routed'
                       ELSE 'awaiting_assignment' END,
         updated_at = now()
     WHERE id = :id AND status IN ('draft', 'awaiting_consent')
     RETURNING id`,
    {
      id: p.uuid(args.escalationId),
      by: p.uuid(args.consentBy),
      assignee: p.nullable.uuid(args.assigneeId),
      dueAt: p.nullable.ts(args.dueAt),
      packet: p.nullable.json(args.packet),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id ? getEscalation(ex, id) : null;
}

/**
 * Allowed transitions for {@link transitionEscalation} (system design §6.2). Consent
 * ({@link recordSharingConsent}) and routing ({@link routeEscalation}) have their own functions. Only an
 * assignee acknowledges, resolves or declines, so those start from the assigned states.
 */
export const ESCALATION_TRANSITIONS = {
  acknowledge: { to: 'acknowledged', from: ['routed'] },
  resolve: { to: 'resolved', from: ['routed', 'acknowledged'] },
  decline: { to: 'declined', from: ['routed', 'acknowledged'] },
  withdraw: { to: 'withdrawn', from: OPEN_ESCALATION_STATUSES },
} as const satisfies Record<string, { to: EscalationStatusValue; from: readonly EscalationStatusValue[] }>;

/**
 * Guarded status change: acknowledge/resolve/decline (assignee) or withdraw (founder). `resolution` is
 * stored for resolve/decline together with `resolved_by`. Returns null when not allowed/visible.
 */
export async function transitionEscalation(
  ex: SqlExecutor,
  args: {
    escalationId: string;
    action: keyof typeof ESCALATION_TRANSITIONS;
    actorId: string;
    resolution?: EscalationResolution | null;
  },
): Promise<EscalationRecord | null> {
  const t = ESCALATION_TRANSITIONS[args.action];
  const closes = args.action === 'resolve' || args.action === 'decline';
  const id = await queryFirst(
    ex,
    `UPDATE escalations
     SET status = :to,
         resolution = CASE WHEN :closes THEN :resolution ELSE resolution END,
         resolved_by = CASE WHEN :closes THEN :actor ELSE resolved_by END,
         updated_at = now()
     WHERE id = :id AND status = ANY (:fromStatuses)
     RETURNING id`,
    {
      id: p.uuid(args.escalationId),
      to: p.text(t.to),
      fromStatuses: p.textArray(t.from),
      closes: p.bool(closes),
      resolution: p.nullable.json(args.resolution),
      actor: p.uuid(args.actorId),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id ? getEscalation(ex, id) : null;
}

/**
 * Program lead routes a consented escalation (`awaiting_assignment`, or re-routes a `routed` /
 * `acknowledged` one) to an EIR or program lead; it becomes `routed`. Via `app.route_escalation`, which
 * re-checks role, tenant, consent, state and assignee. Returns false when the escalation does not exist in
 * the tenant; throws DbError 42501 (not a program lead), 55000 (not routable), 23503 (assignee is not an
 * active EIR or program lead of the tenant).
 */
export async function routeEscalation(
  ex: SqlExecutor,
  args: { escalationId: string; assigneeId: string; dueAt?: string | Date | null },
): Promise<boolean> {
  const result = await ex.query('SELECT app.route_escalation(:id, :assignee, :dueAt) AS ok', {
    id: p.uuid(args.escalationId),
    assignee: p.uuid(args.assigneeId),
    dueAt: p.nullable.ts(args.dueAt),
  });
  const first = result.rows[0];
  return first ? col.bool.decode(first.ok, 'ok') : false;
}

/** Program-lead queue: metadata only (no packet), via `app.escalation_queue()`. Throws 42501 otherwise. */
export function escalationQueue(ex: SqlExecutor): Promise<EscalationQueueItemValue[]> {
  return queryRows(
    ex,
    `SELECT id, venture_id, venture_name, category, priority, status, requested_role, assignee_principal_id,
            due_at, created_at, shared
     FROM app.escalation_queue()`,
    {},
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      ventureName: col.text.decode(r.venture_name, 'venture_name'),
      category: col.enum(EscalationCategory.options).decode(r.category, 'category'),
      priority: col.enum(EscalationPriority.options).decode(r.priority, 'priority'),
      status: col.enum(EscalationStatus.options).decode(r.status, 'status'),
      requestedRole: col.enum(RequestedRole.options).decode(r.requested_role, 'requested_role'),
      assigneeId: col.uuid.nullable.decode(r.assignee_principal_id, 'assignee_principal_id'),
      dueAt: col.ts.nullable.decode(r.due_at, 'due_at'),
      createdAt: col.ts.decode(r.created_at, 'created_at'),
      shared: col.bool.decode(r.shared, 'shared'),
    }),
  );
}
