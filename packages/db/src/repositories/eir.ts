import { type EirProfileView, type PrincipalView } from '@foundry/contracts';
import { type z } from 'zod';

import { camelRow, col, type CamelRow, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryOne, queryRows, setClause } from './common.js';

const eirShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  principal_id: col.uuid.nullable,
  display_name: col.text,
  title: col.text.nullable,
  expertise_tags: col.textArray,
  routing_intents: col.textArray,
  synthetic: col.bool,
  status: col.enum(['active', 'unavailable', 'retired'] as const),
  bio: col.text.nullable,
  created_at: col.ts,
};
const eirCodec = camelRow(eirShape);
/** EIR expertise registry entry (candidate metadata, not authority). */
export type EirProfileRecord = CamelRow<typeof eirShape>;
const COLUMNS =
  'id, tenant_id, principal_id, display_name, title, expertise_tags, routing_intents, synthetic, status, bio, created_at';

/** Contract view of a profile; `principal` is the linked account when it was read with the profile. */
export function toEirProfileView(
  r: EirProfileRecord,
  principal: PrincipalView | null = null,
): z.infer<typeof EirProfileView> {
  return {
    id: r.id,
    displayName: r.displayName,
    title: r.title,
    expertiseTags: r.expertiseTags,
    routingIntents: r.routingIntents,
    synthetic: r.synthetic,
    status: r.status,
    bio: r.bio,
    principal,
  };
}

export function listEirProfiles(
  ex: SqlExecutor,
  args: { tenantId: string; status?: EirProfileRecord['status'] },
): Promise<EirProfileRecord[]> {
  return queryRows(
    ex,
    `SELECT ${COLUMNS} FROM eir_profiles
     WHERE tenant_id = :tenantId AND (:status IS NULL OR status = :status)
     ORDER BY display_name, id`,
    { tenantId: p.uuid(args.tenantId), status: p.nullable.text(args.status) },
    (r) => eirCodec.decode(r),
  );
}

function decodeLinked(r: RawRow): PrincipalView | null {
  const id = col.uuid.nullable.decode(r.account_id, 'account_id');
  if (id === null) return null;
  return {
    id,
    displayName: col.text.decode(r.account_name, 'account_name'),
    title: col.text.nullable.decode(r.account_title, 'account_title'),
    synthetic: col.bool.decode(r.account_synthetic, 'account_synthetic'),
  };
}

const PROFILE_COLUMNS = COLUMNS.split(', ')
  .map((c) => `e.${c}`)
  .join(', ');

const VIEW_SELECT = `
  SELECT ${PROFILE_COLUMNS}, pr.id AS account_id, pr.display_name AS account_name, pr.title AS account_title,
         pr.synthetic AS account_synthetic
  FROM eir_profiles e
  LEFT JOIN principals pr ON pr.id = e.principal_id AND pr.tenant_id = e.tenant_id`;

/** Profiles of the tenant with their linked account (the EIR registry view), ordered by name. */
export function listEirProfileViews(
  ex: SqlExecutor,
  tenantId: string,
): Promise<z.infer<typeof EirProfileView>[]> {
  return queryRows(
    ex,
    `${VIEW_SELECT} WHERE e.tenant_id = :tenantId ORDER BY e.display_name, e.id`,
    { tenantId: p.uuid(tenantId) },
    (r) => toEirProfileView(eirCodec.decode(r), decodeLinked(r)),
  );
}

/** One profile with its linked account. */
export function getEirProfileView(
  ex: SqlExecutor,
  id: string,
): Promise<z.infer<typeof EirProfileView> | null> {
  return queryFirst(ex, `${VIEW_SELECT} WHERE e.id = :id`, { id: p.uuid(id) }, (r) =>
    toEirProfileView(eirCodec.decode(r), decodeLinked(r)),
  );
}

export function getEirProfile(ex: SqlExecutor, id: string): Promise<EirProfileRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM eir_profiles WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    eirCodec.decode(r),
  );
}

/** The profile linked to a principal (an EIR's own login), if any. */
export function getEirProfileByPrincipal(
  ex: SqlExecutor,
  principalId: string,
): Promise<EirProfileRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS} FROM eir_profiles WHERE principal_id = :principalId ORDER BY created_at LIMIT 1`,
    { principalId: p.uuid(principalId) },
    (r) => eirCodec.decode(r),
  );
}

/**
 * People a new profile can be linked to: active principals of the tenant holding the EIR role there, without a
 * profile of their own yet, ordered by name.
 */
export function listEirProfileCandidates(ex: SqlExecutor, tenantId: string): Promise<PrincipalView[]> {
  return queryRows(
    ex,
    `SELECT pr.id, pr.display_name, pr.title, pr.synthetic
     FROM principals pr
     WHERE pr.tenant_id = :tenantId AND pr.status = 'active'
       AND EXISTS (SELECT 1 FROM role_grants g
                   WHERE g.principal_id = pr.id AND g.role = 'eir' AND g.revoked_at IS NULL
                     AND (g.tenant_id IS NULL OR g.tenant_id = :tenantId))
       AND NOT EXISTS (SELECT 1 FROM eir_profiles e WHERE e.principal_id = pr.id)
     ORDER BY pr.display_name, pr.id`,
    { tenantId: p.uuid(tenantId) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      displayName: col.text.decode(r.display_name, 'display_name'),
      title: col.text.nullable.decode(r.title, 'title'),
      synthetic: col.bool.decode(r.synthetic, 'synthetic'),
    }),
  );
}

export interface CreateEirProfileInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly principalId?: string | null;
  readonly displayName: string;
  readonly title?: string | null;
  readonly expertiseTags?: readonly string[];
  readonly routingIntents?: readonly string[];
  readonly synthetic?: boolean;
  readonly bio?: string | null;
}

export function createEirProfile(ex: SqlExecutor, input: CreateEirProfileInput): Promise<EirProfileRecord> {
  return queryOne(
    ex,
    `INSERT INTO eir_profiles (id, tenant_id, principal_id, display_name, title, expertise_tags, routing_intents,
                               synthetic, bio)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :principalId, :displayName, :title, :tags, :intents,
             :synthetic, :bio)
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      principalId: p.nullable.uuid(input.principalId),
      displayName: p.text(input.displayName),
      title: p.nullable.text(input.title),
      tags: p.textArray(input.expertiseTags ?? []),
      intents: p.textArray(input.routingIntents ?? []),
      synthetic: p.bool(input.synthetic ?? true),
      bio: p.nullable.text(input.bio),
    },
    (r) => eirCodec.decode(r),
    'createEirProfile',
  );
}

export interface UpdateEirProfileInput {
  readonly displayName?: string;
  readonly title?: string | null;
  readonly expertiseTags?: readonly string[];
  readonly routingIntents?: readonly string[];
  readonly status?: EirProfileRecord['status'];
  readonly bio?: string | null;
}

export async function updateEirProfile(
  ex: SqlExecutor,
  id: string,
  patch: UpdateEirProfileInput,
): Promise<EirProfileRecord | null> {
  const set = setClause([
    ['display_name', patch.displayName === undefined ? undefined : p.text(patch.displayName)],
    ['title', patch.title === undefined ? undefined : p.nullable.text(patch.title)],
    ['expertise_tags', patch.expertiseTags === undefined ? undefined : p.textArray(patch.expertiseTags)],
    ['routing_intents', patch.routingIntents === undefined ? undefined : p.textArray(patch.routingIntents)],
    ['status', patch.status === undefined ? undefined : p.text(patch.status)],
    ['bio', patch.bio === undefined ? undefined : p.nullable.text(patch.bio)],
  ]);
  if (set.sql === '') return getEirProfile(ex, id);
  return queryFirst(
    ex,
    `UPDATE eir_profiles SET ${set.sql} WHERE id = :id RETURNING ${COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    (r) => eirCodec.decode(r),
  );
}
