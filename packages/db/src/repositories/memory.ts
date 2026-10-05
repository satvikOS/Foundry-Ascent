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

/** Contract view plus tenant and embedding presence. */
export type MemoryRecord = MemoryObjectView & { readonly tenantId: string; readonly hasEmbedding: boolean };

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
         m.embedding IS NOT NULL AS has_embedding,
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
  /** Default `proposed`. AI-origin items must stay `proposed` until a founder approves them. */
  readonly status?: MemoryStatusValue;
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
  const status = input.status ?? 'proposed';
  const approvedBy = input.approvedBy ?? (status === 'confirmed' ? input.createdBy : null);
  const id = await queryOne(
    ex,
    `WITH ins AS (
       INSERT INTO memory_objects (id, tenant_id, venture_id, type, title, content, attributes, status, visibility,
                                   confidence, source_refs, origin, created_by, approved_by, approved_at, pinned,
                                   expires_at, embedding)
       VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :type, :title, :content, :attributes, :status,
               :visibility, :confidence, :sourceRefs, :origin, :createdBy, :approvedBy,
               CASE WHEN :approvedBy IS NULL THEN NULL ELSE now() END, :pinned, :expiresAt, :embedding)
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
      diff: p.json({ status, origin: input.origin, type: input.type }),
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
