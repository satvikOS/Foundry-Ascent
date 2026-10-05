/**
 * Append-only, hash-chained audit log. Application requests append through `app.audit` (tenant, actor
 * and request id are taken from the transaction context and cannot be forged); system jobs append
 * through `app.append_audit` with explicit identifiers. Reads and chain verification are owner-only.
 * Metadata holds identifiers and counts only — never prompts, answers, documents or memory content.
 */
import { type AuditEventView } from '@foundry/contracts';
import { type z } from 'zod';

import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { clampLimit, queryOne, queryRows } from './common.js';

type AuditEventViewValue = z.infer<typeof AuditEventView>;

export type AuditOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed' | 'blocked';
export type AuditMetadataValue =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

export interface AuditEventInput {
  /** Dotted verb, e.g. `session.started`, `retrieval.denied`, `persona.suspended`. */
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly objectType?: string | null;
  readonly objectId?: string | null;
  readonly policyReason?: string | null;
  readonly ventureId?: string | null;
  /** Identifiers and counts only (strings ≤ 200 chars, ≤ 32 keys, arrays ≤ 50 scalars). */
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
  /** System appends only (ignored under withContext, where the request context is authoritative). */
  readonly tenantId?: string | null;
  readonly actorId?: string | null;
  readonly requestId?: string | null;
}

const MAX_META_KEYS = 32;
const MAX_META_STRING = 200;
const MAX_META_ARRAY = 50;

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= MAX_META_STRING)
  );
}

/** Rejects metadata that could carry content (long strings, nested objects). */
export function assertAuditMetadata(metadata: Readonly<Record<string, unknown>>): void {
  const entries = Object.entries(metadata);
  if (entries.length > MAX_META_KEYS) throw new SqlUsageError('audit metadata has too many keys');
  for (const [key, value] of entries) {
    const ok = Array.isArray(value)
      ? value.length <= MAX_META_ARRAY && value.every(isScalar)
      : isScalar(value);
    if (!ok || key.length > 64) {
      throw new SqlUsageError(`audit metadata "${key.slice(0, 64)}" must be an identifier, count or flag`);
    }
  }
}

/**
 * Appends an audit event and returns its id. Under `withContext` (app executor) the tenant, actor and
 * request id come from the transaction context; under `system` they come from the input.
 */
export async function appendAudit(ex: SqlExecutor, event: AuditEventInput): Promise<number> {
  const metadata = event.metadata ?? {};
  assertAuditMetadata(metadata);
  const common = {
    action: p.text(event.action),
    objectType: p.nullable.text(event.objectType),
    objectId: p.nullable.text(event.objectId),
    outcome: p.text(event.outcome),
    reason: p.nullable.text(event.policyReason),
    ventureId: p.nullable.uuid(event.ventureId),
    metadata: p.json(metadata),
  };
  if (ex.privilege === 'app') {
    return queryOne(
      ex,
      'SELECT app.audit(:action, :objectType, :objectId, :outcome, :reason, :ventureId, :metadata) AS id',
      common,
      (r) => col.int.decode(r.id, 'id'),
      'appendAudit',
    );
  }
  return queryOne(
    ex,
    `SELECT app.append_audit(:tenantId, :ventureId, :actorId, :action, :objectType, :objectId, :outcome, :reason,
                             :requestId, :metadata) AS id`,
    {
      ...common,
      tenantId: p.nullable.uuid(event.tenantId),
      actorId: p.nullable.uuid(event.actorId),
      requestId: p.nullable.text(event.requestId),
    },
    (r) => col.int.decode(r.id, 'id'),
    'appendAudit',
  );
}

export interface ListAuditOptions {
  /** Restrict to a tenant (platform admins may omit to see platform-wide events). */
  readonly tenantId?: string | null;
  readonly action?: string;
  readonly outcome?: string;
  readonly ventureId?: string;
  readonly actorId?: string;
  /** Opaque cursor from a previous page (`nextCursor`). */
  readonly cursor?: string | null;
  /** Default 50, max 200. */
  readonly limit?: number;
}

export interface AuditPage {
  readonly items: AuditEventViewValue[];
  readonly nextCursor: string | null;
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  if (!/^\d{1,15}$/.test(cursor)) throw new SqlUsageError('invalid audit cursor');
  return Number(cursor);
}

/** Newest-first keyset pagination over audit events (metadata only; contract `AuditEventView`). */
export async function listAuditEvents(
  sx: SystemExecutor,
  options: ListAuditOptions = {},
): Promise<AuditPage> {
  const limit = clampLimit(options.limit, 50, 200);
  const rows = await queryRows(
    sx,
    `SELECT id, at, action, outcome, actor_id, venture_id, object_type, object_id, policy_reason, request_id, hash
     FROM audit_events
     WHERE (:tenantId IS NULL OR tenant_id = :tenantId)
       AND (:action IS NULL OR action = :action)
       AND (:outcome IS NULL OR outcome = :outcome)
       AND (:ventureId IS NULL OR venture_id = :ventureId)
       AND (:actorId IS NULL OR actor_id = :actorId)
       AND (:before IS NULL OR id < :before)
     ORDER BY id DESC
     LIMIT :limitPlusOne`,
    {
      tenantId: p.nullable.uuid(options.tenantId),
      action: p.nullable.text(options.action),
      outcome: p.nullable.text(options.outcome),
      ventureId: p.nullable.uuid(options.ventureId),
      actorId: p.nullable.uuid(options.actorId),
      before: p.nullable.bigint(decodeCursor(options.cursor)),
      limitPlusOne: p.int(limit + 1),
    },
    (r) => ({
      id: col.int.decode(r.id, 'id'),
      at: col.ts.decode(r.at, 'at'),
      action: col.text.decode(r.action, 'action'),
      outcome: col.text.decode(r.outcome, 'outcome'),
      actorId: col.uuid.nullable.decode(r.actor_id, 'actor_id'),
      ventureId: col.uuid.nullable.decode(r.venture_id, 'venture_id'),
      objectType: col.text.nullable.decode(r.object_type, 'object_type'),
      objectId: col.text.nullable.decode(r.object_id, 'object_id'),
      policyReason: col.text.nullable.decode(r.policy_reason, 'policy_reason'),
      requestId: col.text.nullable.decode(r.request_id, 'request_id'),
      hash: col.text.decode(r.hash, 'hash'),
    }),
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? String(last.id) : null };
}

export interface AuditChainReport {
  /** Events verified in this call. */
  readonly checked: number;
  /** Last verified id (resume point for the next call). */
  readonly lastId: number;
  /** First event whose link or hash does not verify; null when intact. */
  readonly firstBrokenId: number | null;
}

/** Recomputes the sha256 chain for events after `afterId` (at most `limit`, default 10 000). */
export function verifyAuditChain(
  sx: SystemExecutor,
  args: { afterId?: number; limit?: number } = {},
): Promise<AuditChainReport> {
  return queryOne(
    sx,
    'SELECT checked, last_id, first_broken_id FROM app.verify_audit_chain(:after, :limit)',
    { after: p.bigint(args.afterId ?? 0), limit: p.int(clampLimit(args.limit, 10_000, 1_000_000)) },
    (r) => ({
      checked: col.int.decode(r.checked, 'checked'),
      lastId: col.int.decode(r.last_id, 'last_id'),
      firstBrokenId: col.int.nullable.decode(r.first_broken_id, 'first_broken_id'),
    }),
    'verifyAuditChain',
  );
}
