import { type EirProfileView } from '@foundry/contracts';
import { type z } from 'zod';

import { camelRow, col, type CamelRow } from '../columns.js';
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
  created_at: col.ts,
};
const eirCodec = camelRow(eirShape);
/** EIR expertise registry entry (candidate metadata, not authority). */
export type EirProfileRecord = CamelRow<typeof eirShape>;
const COLUMNS =
  'id, tenant_id, principal_id, display_name, title, expertise_tags, routing_intents, synthetic, status, created_at';

export function toEirProfileView(r: EirProfileRecord): z.infer<typeof EirProfileView> {
  return {
    id: r.id,
    displayName: r.displayName,
    title: r.title,
    expertiseTags: r.expertiseTags,
    routingIntents: r.routingIntents,
    synthetic: r.synthetic,
    status: r.status,
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

export interface CreateEirProfileInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly principalId?: string | null;
  readonly displayName: string;
  readonly title?: string | null;
  readonly expertiseTags?: readonly string[];
  readonly routingIntents?: readonly string[];
  readonly synthetic?: boolean;
}

export function createEirProfile(ex: SqlExecutor, input: CreateEirProfileInput): Promise<EirProfileRecord> {
  return queryOne(
    ex,
    `INSERT INTO eir_profiles (id, tenant_id, principal_id, display_name, title, expertise_tags, routing_intents, synthetic)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :principalId, :displayName, :title, :tags, :intents, :synthetic)
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
  ]);
  if (set.sql === '') return getEirProfile(ex, id);
  return queryFirst(
    ex,
    `UPDATE eir_profiles SET ${set.sql} WHERE id = :id RETURNING ${COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    (r) => eirCodec.decode(r),
  );
}
