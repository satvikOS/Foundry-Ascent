import {
  MemoryEventAction,
  MemoryOrigin,
  MemoryStatus,
  MemoryType,
  SourceRef,
  Visibility,
  type MemoryEventView,
  type MemoryObjectView,
} from '@foundry/contracts';
import { z } from 'zod';

import { col, type RawRow } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SqlExecutor } from '../executor.js';
import { p, type SqlParam } from '../params.js';
import {
  andTsQuerySql,
  clampLimit,
  principalFrom,
  principalSelect,
  queryFirst,
  queryNumber,
  queryOne,
  queryRows,
  requiredPrincipalFrom,
} from './common.js';

export type MemoryTypeValue = z.infer<typeof MemoryType>;
export type MemoryStatusValue = z.infer<typeof MemoryStatus>;
export type VisibilityValue = z.infer<typeof Visibility>;
export type MemoryOriginValue = z.infer<typeof MemoryOrigin>;
export type MemoryEventActionValue = z.infer<typeof MemoryEventAction>;
type SourceRefValue = z.infer<typeof SourceRef>;
type MemoryEventViewValue = z.infer<typeof MemoryEventView>;

/** Statuses shown (and retrieved) by default: superseded/rejected/expired/deleted items are history. */
export const ACTIVE_MEMORY_STATUSES: readonly MemoryStatusValue[] = ['proposed', 'confirmed', 'disputed'];

/** `attributes.status` values that mean an action/milestone/experiment is closed. */
export const CLOSED_ITEM_STATUSES = [
  'done',
  'completed',
  'dropped',
  'cancelled',
  'abandoned',
  'missed',
] as const;

/** History `reason` of an item the vEIR kept by itself (no person approved it). */
export const KEPT_AUTOMATICALLY = 'kept_automatically';

/**
 * Whether `m` was kept automatically. Migration 0013's approval CHECK makes this exactly "`auto_kept_at` is set"
 * for live items: an AI item can be confirmed, disputed or superseded without an approver only when it was kept
 * automatically. Written without the column so the read works on every schema (no such row exists before 0013).
 */
const KEPT_AUTOMATICALLY_SQL = `(m.origin = 'ai' AND m.approved_by IS NULL AND m.status IN ('confirmed', 'disputed', 'superseded'))`;

/** Contract view plus tenant and embedding presence. */
export type MemoryRecord = MemoryObjectView & {
  readonly tenantId: string;
  readonly hasEmbedding: boolean;
  /** Kept by the vEIR itself (`auto_kept_at`, migration 0013): nobody had to approve it. */
  readonly keptAutomatically: boolean;
};

const Attributes = z.record(z.string(), z.unknown());

/**
 * Item columns. With `excerpt` the content is cut to `:excerptChars` characters in SQL (list pages: a page
 * of full 8 000-character items plus attributes could exceed the RDS Data API's 1 MB response limit);
 * `content_length` is always the full length.
 */
function memorySelect(excerpt: boolean): string {
  return `
  SELECT m.id, m.tenant_id, m.venture_id, m.type, m.title,
         ${excerpt ? 'left(m.content, :excerptChars)' : 'm.content'} AS content, length(m.content) AS content_length,
         m.attributes, m.status, m.visibility,
         m.confidence, m.source_refs, m.origin, m.created_by, m.approved_by, m.approved_at, m.version,
         m.supersedes_id, m.pinned, m.expires_at, m.created_at, m.updated_at,
         m.embedding IS NOT NULL AS has_embedding, ${KEPT_AUTOMATICALLY_SQL} AS kept_automatically,
         ${principalSelect('cb', 'cb')}, ${principalSelect('ab', 'ab')}
  FROM memory_objects m
  LEFT JOIN principals cb ON cb.id = m.created_by
  LEFT JOIN principals ab ON ab.id = m.approved_by`;
}
const MEMORY_SELECT = memorySelect(false);

function decodeSourceRefs(raw: unknown): SourceRefValue[] {
  const value = col.json().decode(raw, 'source_refs');
  if (!Array.isArray(value)) return [];
  const refs: SourceRefValue[] = [];
  for (const item of value) {
    const parsed = SourceRef.safeParse(item);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

function decodeMemory(r: RawRow): MemoryRecord {
  const createdBy = col.uuid.decode(r.created_by, 'created_by');
  const approvedBy = col.uuid.nullable.decode(r.approved_by, 'approved_by');
  return {
    id: col.uuid.decode(r.id, 'id'),
    tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
    ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
    type: col.enum(MemoryType.options).decode(r.type, 'type'),
    title: col.text.decode(r.title, 'title'),
    content: col.text.decode(r.content, 'content'),
    contentLength: col.int.decode(r.content_length, 'content_length'),
    attributes: col.json(Attributes).decode(r.attributes, 'attributes'),
    status: col.enum(MemoryStatus.options).decode(r.status, 'status'),
    visibility: col.enum(Visibility.options).decode(r.visibility, 'visibility'),
    confidence: col.num.decode(r.confidence, 'confidence'),
    sourceRefs: decodeSourceRefs(r.source_refs),
    origin: col.enum(MemoryOrigin.options).decode(r.origin, 'origin'),
    createdBy: requiredPrincipalFrom(r, 'cb', createdBy),
    approvedBy: principalFrom(r, 'ab', approvedBy),
    approvedAt: col.ts.nullable.decode(r.approved_at, 'approved_at'),
    version: col.int.decode(r.version, 'version'),
    supersedesId: col.uuid.nullable.decode(r.supersedes_id, 'supersedes_id'),
    pinned: col.bool.decode(r.pinned, 'pinned'),
    expiresAt: col.ts.nullable.decode(r.expires_at, 'expires_at'),
    createdAt: col.ts.decode(r.created_at, 'created_at'),
    updatedAt: col.ts.decode(r.updated_at, 'updated_at'),
    keptAutomatically: col.bool.decode(r.kept_automatically, 'kept_automatically'),
    hasEmbedding: col.bool.decode(r.has_embedding, 'has_embedding'),
  };
}

/** One memory item (null when unknown or hidden by RLS — deleted items are never visible to app_rls). */
export function getMemory(ex: SqlExecutor, id: string): Promise<MemoryRecord | null> {
  return queryFirst(ex, `${MEMORY_SELECT} WHERE m.id = :id`, { id: p.uuid(id) }, decodeMemory);
}

/** Several items by id (order not guaranteed). */
export function getMemoryByIds(ex: SqlExecutor, ids: readonly string[]): Promise<MemoryRecord[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return queryRows(ex, `${MEMORY_SELECT} WHERE m.id = ANY (:ids)`, { ids: p.uuidArray(ids) }, decodeMemory);
}

export interface ListMemoryOptions {
  readonly ventureId: string;
  readonly type?: MemoryTypeValue;
  readonly types?: readonly MemoryTypeValue[];
  /** Single status filter (API `?status=`); overrides the default {@link ACTIVE_MEMORY_STATUSES}. */
  readonly status?: MemoryStatusValue;
  readonly statuses?: readonly MemoryStatusValue[];
  /** Full-text search over title + content (all words must match; websearch syntax). */
  readonly q?: string;
  readonly pinned?: boolean;
  readonly visibility?: readonly VisibilityValue[];
  readonly createdSince?: string | Date;
  readonly updatedSince?: string | Date;
  /** Only items whose attributes.status is not closed (see {@link CLOSED_ITEM_STATUSES}). */
  readonly openOnly?: boolean;
  /** `attributes.due` (actions) or `attributes.target_date` (milestones) strictly before this YYYY-MM-DD. */
  readonly dueBefore?: string;
  /** Due/target date on or after this YYYY-MM-DD. */
  readonly dueOnOrAfter?: string;
  /** `recent` (default: pinned first, then last updated), `due` (soonest first), `relevance` (with q). */
  readonly orderBy?: 'recent' | 'due' | 'relevance';
  /** Default 100, max 500. */
  readonly limit?: number;
  /** Rows to skip (offset paging of the API list). */
  readonly offset?: number;
  /**
   * Cut `content` to this many characters (`contentLength` keeps the full length). API list pages always
   * set it; full items come from {@link getMemory}.
   */
  readonly excerptChars?: number;
}

const DUE_SQL = `CASE WHEN coalesce(m.attributes ->> 'due', m.attributes ->> 'target_date') ~ '^\\d{4}-\\d{2}-\\d{2}$'
  THEN coalesce(m.attributes ->> 'due', m.attributes ->> 'target_date') END`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Venture memory with filters and full-text search (contract `MemoryObjectView`s plus tenant/embedding flags). */
export function listMemory(ex: SqlExecutor, options: ListMemoryOptions): Promise<MemoryRecord[]> {
  for (const d of [options.dueBefore, options.dueOnOrAfter]) {
    if (d !== undefined && !DATE_RE.test(d)) throw new SqlUsageError('due filters must be YYYY-MM-DD');
  }
  const types = options.types ?? (options.type ? [options.type] : null);
  const statuses = options.statuses ?? (options.status ? [options.status] : ACTIVE_MEMORY_STATUSES);
  const q = options.q?.trim() ? options.q.trim() : null;
  const orderBy = options.orderBy ?? (q ? 'relevance' : 'recent');
  const order =
    orderBy === 'due'
      ? `${DUE_SQL} ASC NULLS LAST, m.updated_at DESC, m.id`
      : orderBy === 'relevance' && q
        ? `ts_rank_cd(m.tsv, ${andTsQuerySql('q')}) DESC, m.pinned DESC, m.updated_at DESC, m.id`
        : 'm.pinned DESC, m.updated_at DESC, m.id';
  const params: Record<string, SqlParam> = {
    ventureId: p.uuid(options.ventureId),
    types: p.nullable.textArray(types),
    statuses: p.textArray(statuses),
    q: p.nullable.text(q),
    pinned: p.nullable.bool(options.pinned),
    visibility: p.nullable.textArray(options.visibility),
    createdSince: p.nullable.ts(options.createdSince),
    updatedSince: p.nullable.ts(options.updatedSince),
    openOnly: p.bool(options.openOnly ?? false),
    closed: p.textArray(CLOSED_ITEM_STATUSES),
    dueBefore: p.nullable.text(options.dueBefore),
    dueOnOrAfter: p.nullable.text(options.dueOnOrAfter),
    limit: p.int(clampLimit(options.limit, 100, 500)),
    offset: p.int(Math.max(0, Math.min(100_000, Math.trunc(options.offset ?? 0)))),
  };
  const excerpt = options.excerptChars !== undefined;
  if (excerpt)
    params.excerptChars = p.int(Math.max(0, Math.min(8000, Math.trunc(options.excerptChars ?? 0))));
  return queryRows(
    ex,
    `${memorySelect(excerpt)}
     WHERE m.venture_id = :ventureId
       AND m.status = ANY (:statuses)
       AND (:types IS NULL OR m.type = ANY (:types))
       AND (:q IS NULL OR m.tsv @@ ${andTsQuerySql('q')})
       AND (:pinned IS NULL OR m.pinned = :pinned)
       AND (:visibility IS NULL OR m.visibility = ANY (:visibility))
       AND (:createdSince IS NULL OR m.created_at > :createdSince)
       AND (:updatedSince IS NULL OR m.updated_at > :updatedSince)
       AND (NOT :openOnly OR coalesce(m.attributes ->> 'status', 'open') <> ALL (:closed))
       AND (:dueBefore IS NULL OR ${DUE_SQL} < :dueBefore)
       AND (:dueOnOrAfter IS NULL OR ${DUE_SQL} >= :dueOnOrAfter)
     ORDER BY ${order}
     LIMIT :limit OFFSET :offset`,
    params,
    decodeMemory,
  );
}

/** Number of `proposed` items awaiting founder review. */
export function countPendingMemory(ex: SqlExecutor, ventureId: string): Promise<number> {
  return queryNumber(
    ex,
    `SELECT count(*) AS n FROM memory_objects WHERE venture_id = :ventureId AND status = 'proposed'`,
    { ventureId: p.uuid(ventureId) },
  );
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export interface CreateMemoryInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly type: MemoryTypeValue;
  readonly title: string;
  readonly content: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  /**
   * Default `proposed`. An AI-origin item is `proposed` until a person approves it, unless it is kept
   * automatically ({@link CreateMemoryInput.keptAutomatically}).
   */
  readonly status?: MemoryStatusValue;
  /**
   * The vEIR keeps the item by itself (owner decision, migration 0013): it is stored `confirmed` with
   * `auto_kept_at` and no approver, and its first history event is a `created` event marked `system`.
   */
  readonly keptAutomatically?: boolean;
  readonly visibility?: VisibilityValue;
  readonly confidence?: number;
  readonly sourceRefs?: readonly SourceRefValue[];
  readonly origin: MemoryOriginValue;
  /** Must be the request principal under RLS. */
  readonly createdBy: string;
  /** Defaults to `createdBy` when the item is created `confirmed`. */
  readonly approvedBy?: string | null;
  readonly pinned?: boolean;
  readonly expiresAt?: string | Date | null;
  /** Optional embedding (otherwise backfilled by the worker). */
  readonly embedding?: readonly number[] | null;
}

/** Creates a memory item and its `proposed`/`created` event (one round trip). */
export async function createMemory(ex: SqlExecutor, input: CreateMemoryInput): Promise<MemoryRecord> {
  const kept = input.keptAutomatically === true;
  const status = kept ? 'confirmed' : (input.status ?? 'proposed');
  const approvedBy = kept ? null : (input.approvedBy ?? (status === 'confirmed' ? input.createdBy : null));
  // Only an item kept automatically names `auto_kept_at` (migration 0013), so every other write is the
  // statement of the previous schema.
  const id = await queryOne(
    ex,
    `WITH ins AS (
       INSERT INTO memory_objects (id, tenant_id, venture_id, type, title, content, attributes, status, visibility,
                                   confidence, source_refs, origin, created_by, approved_by, approved_at, pinned,
                                   expires_at, embedding${kept ? ', auto_kept_at' : ''})
       VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :type, :title, :content, :attributes, :status,
               :visibility, :confidence, :sourceRefs, :origin, :createdBy, :approvedBy,
               CASE WHEN :approvedBy IS NULL THEN NULL ELSE now() END, :pinned, :expiresAt, :embedding${kept ? ', now()' : ''})
       RETURNING id, venture_id, created_by)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT id, venture_id, created_by, :action, :diff FROM ins)
     SELECT id FROM ins`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      type: p.text(input.type),
      title: p.text(input.title),
      content: p.text(input.content),
      attributes: p.json(input.attributes ?? {}),
      status: p.text(status),
      visibility: p.text(input.visibility ?? 'venture'),
      confidence: p.num(input.confidence ?? 0.5),
      sourceRefs: p.json(input.sourceRefs ?? []),
      origin: p.text(input.origin),
      createdBy: p.uuid(input.createdBy),
      approvedBy: p.nullable.uuid(approvedBy),
      pinned: p.bool(input.pinned ?? false),
      expiresAt: p.nullable.ts(input.expiresAt),
      embedding: p.nullable.vector(input.embedding),
      action: p.text(status === 'proposed' ? 'proposed' : 'created'),
      // Nobody acted on an item kept automatically: the event says so (`system`), as maintenance events do.
      diff: p.json({
        status,
        origin: input.origin,
        type: input.type,
        ...(kept ? { system: true, reason: KEPT_AUTOMATICALLY } : {}),
      }),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'createMemory',
  );
  return mustGet(ex, id);
}

async function mustGet(ex: SqlExecutor, id: string): Promise<MemoryRecord> {
  const record = await getMemory(ex, id);
  if (!record) throw new SqlUsageError('memory item not visible after write');
  return record;
}

/** Appends a history event (append-only; actor must be the request principal under RLS). */
export async function appendMemoryEvent(
  ex: SqlExecutor,
  event: {
    memoryId: string;
    ventureId: string;
    actorId: string;
    action: MemoryEventActionValue;
    diff?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await ex.query(
    `INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
     VALUES (:memoryId, :ventureId, :actorId, :action, :diff)`,
    {
      memoryId: p.uuid(event.memoryId),
      ventureId: p.uuid(event.ventureId),
      actorId: p.uuid(event.actorId),
      action: p.text(event.action),
      diff: p.json(event.diff ?? {}),
    },
  );
}

interface TransitionSpec {
  readonly memoryId: string;
  readonly actorId: string;
  readonly action: MemoryEventActionValue;
  /** Trusted SQL assignments (may reference :actor and extra params). */
  readonly set: string;
  readonly from: readonly MemoryStatusValue[];
  readonly diff: Readonly<Record<string, unknown>>;
  readonly params?: Record<string, SqlParam>;
}

/**
 * Guarded status transition + event in one statement. Returns the updated item, or null when the item is
 * not visible or not in an allowed state.
 */
async function transition(ex: SqlExecutor, spec: TransitionSpec): Promise<MemoryRecord | null> {
  const updated = await queryFirst(
    ex,
    `WITH upd AS (
       UPDATE memory_objects SET ${spec.set}, updated_at = now()
       WHERE id = :id AND status = ANY (:fromStatuses)
       RETURNING id, venture_id)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT id, venture_id, :actor, :action, :diff FROM upd)
     SELECT id FROM upd`,
    {
      ...spec.params,
      id: p.uuid(spec.memoryId),
      fromStatuses: p.textArray(spec.from),
      actor: p.uuid(spec.actorId),
      action: p.text(spec.action),
      diff: p.json(spec.diff),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return updated ? mustGet(ex, updated) : null;
}

/** proposed/disputed → confirmed (founder approval). */
export function approveMemory(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string },
): Promise<MemoryRecord | null> {
  return transition(ex, {
    ...args,
    action: 'approved',
    set: `status = 'confirmed', approved_by = :actor, approved_at = now()`,
    from: ['proposed', 'disputed'],
    diff: { to: 'confirmed' },
  });
}

/** proposed/disputed → rejected. */
export function rejectMemory(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string; reason?: string | null },
): Promise<MemoryRecord | null> {
  return transition(ex, {
    ...args,
    action: 'rejected',
    set: `status = 'rejected', pinned = false`,
    from: ['proposed', 'disputed'],
    diff: { to: 'rejected', reason: args.reason ?? null },
  });
}

/** confirmed → disputed (a founder or new evidence contradicts it). */
export function disputeMemory(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string; reason: string },
): Promise<MemoryRecord | null> {
  return transition(ex, {
    ...args,
    action: 'disputed',
    set: `status = 'disputed'`,
    from: ['confirmed'],
    diff: { to: 'disputed', reason: args.reason },
  });
}

/** Pins or unpins an active item. */
export function setMemoryPinned(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string; pinned: boolean },
): Promise<MemoryRecord | null> {
  return transition(ex, {
    memoryId: args.memoryId,
    actorId: args.actorId,
    action: args.pinned ? 'pinned' : 'unpinned',
    set: 'pinned = :pinned',
    from: ACTIVE_MEMORY_STATUSES,
    diff: {},
    params: { pinned: p.bool(args.pinned) },
  });
}

export interface MemoryCorrection {
  readonly title?: string;
  readonly content?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly visibility?: VisibilityValue;
  readonly confidence?: number;
}

/**
 * Corrects an item by superseding it: a new version (version + 1, `supersedes_id` = old) carries the
 * patch, the old version becomes `superseded`. A proposed item stays proposed; a confirmed/disputed item's
 * correction is confirmed by the corrector. Events: `superseded` on the old version, `corrected` on the new
 * one (diff lists changed field names, never values). Returns the new version or null.
 */
export async function correctMemory(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string; patch: MemoryCorrection; reason?: string | null },
): Promise<MemoryRecord | null> {
  const fields = Object.entries(args.patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  if (fields.length === 0) throw new SqlUsageError('correction must change at least one field');
  const newId = await queryFirst(
    ex,
    `WITH old AS (
       SELECT * FROM memory_objects WHERE id = :id AND status IN ('proposed', 'confirmed', 'disputed') FOR UPDATE)
     , ins AS (
       INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, attributes, status, visibility,
                                   confidence, source_refs, origin, created_by, approved_by, approved_at, version,
                                   supersedes_id, pinned, expires_at)
       SELECT tenant_id, venture_id, type, coalesce(:title, title), coalesce(:content, content),
              coalesce(:attributes, attributes),
              CASE WHEN status = 'proposed' THEN 'proposed' ELSE 'confirmed' END,
              coalesce(:visibility, visibility), coalesce(:confidence, confidence), source_refs, origin, :actor,
              CASE WHEN status = 'proposed' THEN NULL ELSE :actor END,
              CASE WHEN status = 'proposed' THEN NULL ELSE now() END,
              version + 1, id, pinned, expires_at
       FROM old
       RETURNING id, venture_id, supersedes_id, version)
     , upd AS (
       UPDATE memory_objects SET status = 'superseded', pinned = false, updated_at = now()
       WHERE id IN (SELECT id FROM old)
       RETURNING id)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT ins.supersedes_id, ins.venture_id, :actor, 'superseded', jsonb_build_object('by', ins.id) FROM ins
       UNION ALL
       SELECT ins.id, ins.venture_id, :actor, 'corrected',
              jsonb_build_object('fields', CAST(:fields AS jsonb), 'reason', :reason, 'supersedes', ins.supersedes_id,
                                 'version', ins.version)
       FROM ins)
     SELECT ins.id FROM ins, (SELECT count(*) FROM upd) AS u`,
    {
      id: p.uuid(args.memoryId),
      actor: p.uuid(args.actorId),
      title: p.nullable.text(args.patch.title),
      content: p.nullable.text(args.patch.content),
      attributes: p.nullable.json(args.patch.attributes),
      visibility: p.nullable.text(args.patch.visibility),
      confidence: p.nullable.num(args.patch.confidence),
      fields: p.json(fields),
      reason: p.nullable.text(args.reason),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return newId ? mustGet(ex, newId) : null;
}

/**
 * Marks `memoryId` superseded by an existing item `replacementId` (e.g. an approved candidate that
 * replaces an older fact) and links the replacement. Both must be in the same venture.
 */
export async function supersedeMemory(
  ex: SqlExecutor,
  args: { memoryId: string; replacementId: string; actorId: string },
): Promise<MemoryRecord | null> {
  if (args.memoryId === args.replacementId) throw new SqlUsageError('an item cannot supersede itself');
  const id = await queryFirst(
    ex,
    `WITH pair AS (
       SELECT o.id AS old_id, n.id AS new_id, o.venture_id, o.version
       FROM memory_objects o JOIN memory_objects n ON n.venture_id = o.venture_id
       WHERE o.id = :oldId AND n.id = :newId
         AND o.status IN ('proposed', 'confirmed', 'disputed') AND n.status IN ('proposed', 'confirmed', 'disputed'))
     , upd_old AS (
       UPDATE memory_objects SET status = 'superseded', pinned = false, updated_at = now()
       WHERE id IN (SELECT old_id FROM pair) RETURNING id)
     , upd_new AS (
       UPDATE memory_objects m SET supersedes_id = pair.old_id, version = greatest(m.version, pair.version + 1),
              updated_at = now()
       FROM pair WHERE m.id = pair.new_id RETURNING m.id)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT old_id, venture_id, :actor, 'superseded', jsonb_build_object('by', new_id) FROM pair)
     SELECT new_id AS id FROM pair, (SELECT count(*) FROM upd_old) a, (SELECT count(*) FROM upd_new) b`,
    { oldId: p.uuid(args.memoryId), newId: p.uuid(args.replacementId), actor: p.uuid(args.actorId) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id ? mustGet(ex, id) : null;
}

/**
 * Deletes an item and all earlier versions (content erased, history diffs redacted, `deleted` events
 * recorded) through `app.soft_delete_memory`. Returns the number of versions deleted (0: not visible).
 * Throws DbError (42501) when the caller can see but not delete the item.
 */
export async function deleteMemory(ex: SqlExecutor, memoryId: string): Promise<number> {
  return queryNumber(ex, 'SELECT app.soft_delete_memory(:id) AS n', { id: p.uuid(memoryId) });
}

/** History of an item including its earlier versions, oldest first (contract `MemoryEventView`). */
export function listMemoryHistory(ex: SqlExecutor, memoryId: string): Promise<MemoryEventViewValue[]> {
  return queryRows(
    ex,
    `WITH RECURSIVE chain (id, supersedes_id) AS (
       SELECT id, supersedes_id FROM memory_objects WHERE id = :id
       UNION
       SELECT m.id, m.supersedes_id FROM memory_objects m JOIN chain c ON m.id = c.supersedes_id)
     SELECT e.id, e.memory_id, e.actor_id, e.action, e.diff, e.at, ${principalSelect('a', 'a')}
     FROM memory_events e
     JOIN chain c ON c.id = e.memory_id
     LEFT JOIN principals a ON a.id = e.actor_id
     ORDER BY e.at, e.id`,
    { id: p.uuid(memoryId) },
    (r) => ({
      id: col.int.decode(r.id, 'id'),
      memoryId: col.uuid.decode(r.memory_id, 'memory_id'),
      actor: requiredPrincipalFrom(r, 'a', col.uuid.decode(r.actor_id, 'actor_id')),
      action: col.enum(MemoryEventAction.options).decode(r.action, 'action'),
      diff: col.json(Attributes).decode(r.diff, 'diff'),
      at: col.ts.decode(r.at, 'at'),
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Proposal hygiene (distillation, turns, recaps, daily maintenance)
// ------------------------------------------------------------------------------------------------

/**
 * Statuses a new AI candidate is compared against before it is kept: live items, items a person rejected (a
 * turned-down suggestion is never raised again as new), and earlier versions a person corrected (the wording they
 * corrected never comes back as a new item).
 */
export const DEDUPE_MEMORY_STATUSES: readonly MemoryStatusValue[] = [
  'proposed',
  'confirmed',
  'disputed',
  'rejected',
  'superseded',
];

export interface SimilarMemory {
  readonly id: string;
  /** Cosine similarity in [-1, 1]. */
  readonly similarity: number;
}

/**
 * The venture's items closest to `embedding` by cosine similarity, among items that have an embedding and one
 * of `statuses` (an exact scan inside one venture; memory has no ANN index). Most similar first.
 */
export function nearestMemory(
  ex: SqlExecutor,
  args: {
    ventureId: string;
    embedding: readonly number[];
    statuses?: readonly MemoryStatusValue[];
    limit?: number;
  },
): Promise<SimilarMemory[]> {
  return queryRows(
    ex,
    `SELECT m.id, 1 - (m.embedding <=> :embedding) AS similarity
     FROM memory_objects m
     WHERE m.venture_id = :ventureId AND m.embedding IS NOT NULL AND m.status = ANY (:statuses)
     ORDER BY m.embedding <=> :embedding, m.id
     LIMIT :limit`,
    {
      ventureId: p.uuid(args.ventureId),
      embedding: p.vector(args.embedding),
      statuses: p.textArray(args.statuses ?? DEDUPE_MEMORY_STATUSES),
      limit: p.int(clampLimit(args.limit, 1, 20)),
    },
    (r) => ({ id: col.uuid.decode(r.id, 'id'), similarity: col.num.decode(r.similarity, 'similarity') }),
  );
}

/** One item's embedding (null when it has none or is not visible): one vector, never a page of them. */
export function getMemoryEmbedding(ex: SqlExecutor, memoryId: string): Promise<number[] | null> {
  return queryFirst(
    ex,
    `SELECT CAST(m.embedding AS text) AS embedding FROM memory_objects m
     WHERE m.id = :id AND m.embedding IS NOT NULL`,
    { id: p.uuid(memoryId) },
    (r) => decodeVector(r.embedding),
  ).then((v) => v ?? null);
}

/**
 * The venture's items closest by cosine to item `memoryId`'s own embedding (it excluded), among `statuses`: the
 * comparison runs in the database, so no vector leaves it. Most similar first; empty when it has no embedding.
 */
export function nearestToMemory(
  ex: SqlExecutor,
  args: { memoryId: string; ventureId: string; statuses: readonly MemoryStatusValue[]; limit?: number },
): Promise<SimilarMemory[]> {
  return queryRows(
    ex,
    `SELECT m.id, 1 - (m.embedding <=> x.embedding) AS similarity
     FROM memory_objects m, (SELECT embedding FROM memory_objects WHERE id = :id AND embedding IS NOT NULL) x
     WHERE m.venture_id = :ventureId AND m.id <> :id AND m.embedding IS NOT NULL AND m.status = ANY (:statuses)
     ORDER BY m.embedding <=> x.embedding, m.id
     LIMIT :limit`,
    {
      id: p.uuid(args.memoryId),
      ventureId: p.uuid(args.ventureId),
      statuses: p.textArray(args.statuses),
      limit: p.int(clampLimit(args.limit, 3, 20)),
    },
    (r) => ({ id: col.uuid.decode(r.id, 'id'), similarity: col.num.decode(r.similarity, 'similarity') }),
  );
}

/** At most this many source refs are kept on one item. */
const MAX_SOURCE_REFS = 50;

/**
 * Raises AI memory again instead of adding a duplicate: a pending AI proposal, or an item the vEIR kept by itself
 * that no person approved or corrected since. Adds the new source refs it does not have yet (so its provenance
 * names every conversation it was learned from), keeps the higher confidence and refreshes `updated_at`. A
 * proposal gets a `proposed` history event marked `repeated`; a kept item needs none (nothing about it changed
 * but its sources). Null when the item is neither any more (or not visible).
 */
export async function repeatProposal(
  ex: SqlExecutor,
  args: { memoryId: string; actorId: string; sourceRefs: readonly SourceRefValue[]; confidence: number },
): Promise<MemoryRecord | null> {
  const id = await queryFirst(
    ex,
    `WITH upd AS (
       UPDATE memory_objects m
          SET source_refs = CASE
                WHEN jsonb_typeof(m.source_refs) <> 'array' THEN :refs
                ELSE m.source_refs || coalesce(
                  (SELECT jsonb_agg(r.ref) FROM jsonb_array_elements(:refs) AS r (ref)
                    WHERE NOT m.source_refs @> jsonb_build_array(r.ref)
                      AND jsonb_array_length(m.source_refs) < :maxRefs), '[]'::jsonb)
              END,
              confidence = greatest(m.confidence, :confidence),
              updated_at = now()
        WHERE m.id = :id AND m.origin = 'ai'
          AND (m.status = 'proposed' OR (m.status = 'confirmed' AND m.approved_by IS NULL))
        RETURNING m.id, m.venture_id, m.status)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT id, venture_id, :actor, 'proposed', '{"repeated": true}'::jsonb FROM upd WHERE status = 'proposed')
     SELECT id FROM upd`,
    {
      id: p.uuid(args.memoryId),
      actor: p.uuid(args.actorId),
      refs: p.json(args.sourceRefs),
      maxRefs: p.int(MAX_SOURCE_REFS),
      confidence: p.num(Math.min(1, Math.max(0, args.confidence))),
    },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id ? mustGet(ex, id) : null;
}

/**
 * AI memory without an embedding (a pending proposal, or an item kept automatically): what distillation embeds
 * before it deduplicates against it.
 */
export interface UnembeddedProposal {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

/**
 * The venture's AI memory that has no embedding yet (pending proposals and items kept automatically, still
 * live), most recently raised first: turns keep what they learn without an embedding, and the backfill catches
 * up later. Distillation embeds them so its candidates can be compared by meaning.
 */
export function listUnembeddedAiProposals(
  ex: SqlExecutor,
  args: { ventureId: string; limit?: number },
): Promise<UnembeddedProposal[]> {
  return queryRows(
    ex,
    `SELECT m.id, m.title, m.content FROM memory_objects m
     WHERE m.venture_id = :ventureId AND m.origin = 'ai' AND m.embedding IS NULL
       AND (m.status = 'proposed' OR (m.status = 'confirmed' AND m.approved_by IS NULL))
     ORDER BY m.updated_at DESC, m.id
     LIMIT :limit`,
    { ventureId: p.uuid(args.ventureId), limit: p.int(clampLimit(args.limit, 20, 100)) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      title: col.text.decode(r.title, 'title'),
      content: col.text.decode(r.content, 'content'),
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// What the founder made the vEIR forget (migration 0013: `memory_forgotten`)
// ------------------------------------------------------------------------------------------------

/** One version of an item, as its forgotten fingerprint is computed (content: never log it). */
export interface MemoryVersion {
  readonly id: string;
  readonly type: MemoryTypeValue;
  readonly title: string;
  readonly content: string;
  /** Its embedding, when it has one. */
  readonly embedding: number[] | null;
}

function decodeVector(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null;
  const text = col.text.decode(raw, 'embedding');
  const values = text
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => Number(v));
  return values.length > 0 && values.every((v) => Number.isFinite(v)) ? values : null;
}

/**
 * The item and its earlier versions (the whole chain a delete erases), with their embeddings, under the caller's
 * visibility: what a forgotten fingerprint is computed from before the content is erased.
 */
export function listMemoryVersions(ex: SqlExecutor, memoryId: string): Promise<MemoryVersion[]> {
  return queryRows(
    ex,
    `WITH RECURSIVE chain (id, supersedes_id) AS (
       SELECT id, supersedes_id FROM memory_objects WHERE id = :id
       UNION
       SELECT m.id, m.supersedes_id FROM memory_objects m JOIN chain c ON m.id = c.supersedes_id)
     SELECT m.id, m.type, m.title, m.content, CAST(m.embedding AS text) AS embedding
     FROM memory_objects m JOIN chain c ON c.id = m.id
     WHERE m.status <> 'deleted'
     ORDER BY m.version DESC, m.id`,
    { id: p.uuid(memoryId) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      type: col.enum(MemoryType.options).decode(r.type, 'type'),
      title: col.text.decode(r.title, 'title'),
      content: col.text.decode(r.content, 'content'),
      embedding: decodeVector(r.embedding),
    }),
  );
}

/** The fingerprint of one forgotten version (hashes and a meaning signature, never text). */
export interface ForgottenFingerprint {
  readonly type: MemoryTypeValue;
  /** 32 hex characters. */
  readonly titleKey: string;
  readonly contentKey: string;
  /** 16 hex characters. */
  readonly numbersKey: string;
  /** 64 hex characters, or null without an embedding. */
  readonly signature: string | null;
}

/** A forgotten fingerprint and the conversation the forgotten item was learned from. */
export type ForgottenMemory = ForgottenFingerprint & { readonly sessionId: string };

/**
 * Records that the founder made the vEIR forget `memoryId` (`deleted`) or corrected what it kept (`corrected`):
 * one row per conversation the item was learned from and per fingerprint (`app.record_forgotten_memory`, which
 * reads the conversations from the version chain's source refs, so call it before the delete erases them).
 * Founder/team only (the function checks it). Returns the rows written.
 */
export function recordForgottenMemory(
  ex: SqlExecutor,
  args: {
    readonly memoryId: string;
    readonly reason: 'deleted' | 'corrected';
    readonly fingerprints: readonly ForgottenFingerprint[];
  },
): Promise<number> {
  if (args.fingerprints.length === 0) return Promise.resolve(0);
  return queryNumber(ex, 'SELECT app.record_forgotten_memory(:id, :reason, :prints) AS n', {
    id: p.uuid(args.memoryId),
    reason: p.text(args.reason),
    prints: p.json(
      args.fingerprints.map((f) => ({
        type: f.type,
        titleKey: f.titleKey,
        contentKey: f.contentKey,
        numbersKey: f.numbersKey,
        signature: f.signature,
      })),
    ),
  });
}

/** At most this many forgotten fingerprints of a venture are compared with new candidates (newest first). */
export const FORGOTTEN_SCAN_LIMIT = 500;

function decodeForgotten(r: RawRow): ForgottenMemory {
  return {
    sessionId: col.uuid.decode(r.session_id, 'session_id'),
    type: col.enum(MemoryType.options).decode(r.memory_type, 'memory_type'),
    titleKey: col.text.decode(r.title_key, 'title_key'),
    contentKey: col.text.decode(r.content_key, 'content_key'),
    numbersKey: col.text.decode(r.numbers_key, 'numbers_key'),
    signature: col.text.nullable.decode(r.signature, 'signature'),
  };
}

/**
 * The venture's forgotten fingerprints, newest first: through `app.forgotten_memory` for a request (founder/team
 * only), or straight from the table with the owner role (`system`: distillation and maintenance).
 */
export function listForgottenMemory(
  ex: SqlExecutor,
  args: { readonly ventureId: string; readonly system?: boolean },
): Promise<ForgottenMemory[]> {
  const sql =
    args.system === true
      ? `SELECT f.session_id, f.memory_type, f.title_key, f.content_key, f.numbers_key, f.signature
         FROM memory_forgotten f JOIN coaching_sessions s ON s.id = f.session_id
         WHERE s.venture_id = :ventureId
         ORDER BY f.created_at DESC, f.id
         LIMIT :limit`
      : `SELECT f.session_id, f.memory_type, f.title_key, f.content_key, f.numbers_key, f.signature
         FROM app.forgotten_memory(:ventureId, :limit) AS f`;
  return queryRows(
    ex,
    sql,
    { ventureId: p.uuid(args.ventureId), limit: p.int(FORGOTTEN_SCAN_LIMIT) },
    decodeForgotten,
  );
}

/**
 * Takes back an item the vEIR kept automatically moments ago that turned out to restate another item, or something
 * the founder made it forget, once its meaning was known (`app.discard_kept_memory`): its content is erased like
 * a delete, with a `deleted` event marked `system` and the reason. Only an item kept automatically that nobody
 * approved or corrected, and only by the venture's founder/team. Returns whether it was discarded.
 */
export async function discardKeptMemory(
  ex: SqlExecutor,
  args: {
    readonly memoryId: string;
    readonly reason: 'duplicate' | 'forgotten';
    readonly intoId?: string | null;
  },
): Promise<boolean> {
  const n = await queryNumber(ex, 'SELECT app.discard_kept_memory(:id, :reason, :into) AS n', {
    id: p.uuid(args.memoryId),
    reason: p.text(args.reason),
    into: p.nullable.uuid(args.intoId ?? null),
  });
  return n > 0;
}

// ------------------------------------------------------------------------------------------------
// Proposals left from before automatic memory (maintenance)
// ------------------------------------------------------------------------------------------------

/** A pending AI proposal from before automatic memory, as maintenance settles it (content: never log it). */
export interface PendingAiProposal {
  readonly id: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly type: MemoryTypeValue;
  readonly title: string;
  readonly content: string;
  readonly visibility: VisibilityValue;
  readonly createdBy: string;
  readonly sourceRefs: SourceRefValue[];
  readonly hasEmbedding: boolean;
  /** The standard, undeleted conversations it was drawn from (a `session` ref, or a `turn` ref to one of its turns). */
  readonly conversationIds: string[];
}

/** Pending AI proposals (origin `ai`, status `proposed`), oldest first. Owner role. */
export function listPendingAiProposals(
  sx: SqlExecutor,
  args: { readonly limit?: number } = {},
): Promise<PendingAiProposal[]> {
  return queryRows(
    sx,
    `WITH pending AS (
       SELECT m.* FROM memory_objects m
       WHERE m.origin = 'ai' AND m.status = 'proposed'
       ORDER BY m.created_at, m.id
       LIMIT :limit)
     SELECT m.id, m.tenant_id, m.venture_id, m.type, m.title, m.content, m.visibility, m.created_by, m.source_refs,
            m.embedding IS NOT NULL AS has_embedding,
            CAST(ARRAY(
              SELECT s.id FROM coaching_sessions s
              WHERE s.venture_id = m.venture_id AND s.privacy = 'standard' AND s.deleted_at IS NULL
                AND s.id = ANY (ARRAY(
                  SELECT CAST(r.ref ->> 'id' AS uuid) FROM jsonb_array_elements(m.source_refs) AS r (ref)
                  WHERE r.ref ->> 'kind' = 'session' AND app.is_contract_uuid(r.ref ->> 'id')
                  UNION
                  SELECT t.session_id FROM turns t
                  WHERE t.id = ANY (ARRAY(
                    SELECT CAST(r.ref ->> 'id' AS uuid) FROM jsonb_array_elements(m.source_refs) AS r (ref)
                    WHERE r.ref ->> 'kind' = 'turn' AND app.is_contract_uuid(r.ref ->> 'id')))))
              ORDER BY s.last_activity_at DESC) AS text[]) AS conversation_ids
     FROM pending m
     ORDER BY m.created_at, m.id`,
    { limit: p.int(clampLimit(args.limit, 200, 1000)) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      type: col.enum(MemoryType.options).decode(r.type, 'type'),
      title: col.text.decode(r.title, 'title'),
      content: col.text.decode(r.content, 'content'),
      visibility: col.enum(Visibility.options).decode(r.visibility, 'visibility'),
      createdBy: col.uuid.decode(r.created_by, 'created_by'),
      sourceRefs: decodeSourceRefs(r.source_refs),
      hasEmbedding: col.bool.decode(r.has_embedding, 'has_embedding'),
      conversationIds: col.textArray.decode(r.conversation_ids, 'conversation_ids'),
    }),
  );
}

/**
 * Settles a pending AI proposal from before automatic memory (owner role, maintenance): `keep` keeps it the way
 * the vEIR keeps what it learns now (`confirmed`, `auto_kept_at`, no approver, an `approved` event marked
 * `system`); `expire` retires it (`expired`, with the reason: it restated another item, or it was only the coach's
 * advice). Returns whether it was still pending.
 */
export async function settlePendingAiProposal(
  sx: SqlExecutor,
  args: { readonly memoryId: string; readonly outcome: 'keep' | 'expire'; readonly reason: string },
): Promise<boolean> {
  const id = await queryFirst(
    sx,
    `WITH upd AS (
       UPDATE memory_objects m
          SET status = CASE WHEN :keep THEN 'confirmed' ELSE 'expired' END,
              auto_kept_at = CASE WHEN :keep THEN now() ELSE m.auto_kept_at END,
              pinned = CASE WHEN :keep THEN m.pinned ELSE false END,
              updated_at = now()
        WHERE m.id = :id AND m.origin = 'ai' AND m.status = 'proposed'
        RETURNING m.id, m.venture_id, m.created_by)
     , ev AS (
       INSERT INTO memory_events (memory_id, venture_id, actor_id, action, diff)
       SELECT id, venture_id, created_by, CASE WHEN :keep THEN 'approved' ELSE 'expired' END,
              jsonb_build_object('to', CASE WHEN :keep THEN 'confirmed' ELSE 'expired' END, 'system', true,
                                 'reason', :reason)
       FROM upd)
     SELECT id FROM upd`,
    { id: p.uuid(args.memoryId), keep: p.bool(args.outcome === 'keep'), reason: p.text(args.reason) },
    (r) => col.uuid.decode(r.id, 'id'),
  );
  return id !== null;
}
