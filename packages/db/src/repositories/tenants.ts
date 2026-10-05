import { TenantKind, type TenantView } from '@foundry/contracts';

import { camelRow, col, type CamelRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryOne, queryRows } from './common.js';

const tenantShape = {
  id: col.uuid,
  slug: col.text,
  name: col.text,
  kind: col.enum(TenantKind.options),
  status: col.enum(['active', 'suspended', 'archived'] as const),
  created_at: col.ts,
};
const tenantCodec = camelRow(tenantShape);
export type TenantRecord = CamelRow<typeof tenantShape>;

const COLUMNS = 'id, slug, name, kind, status, created_at';

export function toTenantView(t: TenantRecord): TenantView {
  return { id: t.id, slug: t.slug, name: t.name, kind: t.kind };
}

/** The tenant by id (under RLS: only the request's own tenant is visible). */
export function getTenant(ex: SqlExecutor, id: string): Promise<TenantRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM tenants WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    tenantCodec.decode(r),
  );
}

export function getTenantBySlug(ex: SqlExecutor, slug: string): Promise<TenantRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM tenants WHERE slug = :slug`, { slug: p.text(slug) }, (r) =>
    tenantCodec.decode(r),
  );
}

/** All tenants (system: platform administration, seed). */
export function listTenants(sx: SystemExecutor): Promise<TenantRecord[]> {
  return queryRows(sx, `SELECT ${COLUMNS} FROM tenants ORDER BY created_at, slug`, {}, (r) =>
    tenantCodec.decode(r),
  );
}

export interface UpsertTenantInput {
  /** Used only when the slug does not exist yet. */
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: TenantRecord['kind'];
}

/** Creates the tenant or updates its name (keyed by slug). app_rls cannot write tenants: system only. */
export function upsertTenant(sx: SystemExecutor, input: UpsertTenantInput): Promise<TenantRecord> {
  return queryOne(
    sx,
    `INSERT INTO tenants (id, slug, name, kind)
     VALUES (coalesce(:id, gen_random_uuid()), :slug, :name, :kind)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      slug: p.text(input.slug),
      name: p.text(input.name),
      kind: p.text(input.kind),
    },
    (r) => tenantCodec.decode(r),
    'upsertTenant',
  );
}
