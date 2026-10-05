import { MembershipRole, PlatformRole, type PrincipalView } from '@foundry/contracts';

import { camelRow, col, type CamelRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryNumber, queryOne, queryRows, setClause } from './common.js';

type PlatformRoleValue = (typeof PlatformRole.options)[number];
type MembershipRoleValue = (typeof MembershipRole.options)[number];

const principalShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  display_name: col.text,
  email: col.text.nullable,
  title: col.text.nullable,
  synthetic: col.bool,
  status: col.enum(['active', 'disabled'] as const),
  created_at: col.ts,
  updated_at: col.ts,
};
const principalCodec = camelRow(principalShape);
export type PrincipalRecord = CamelRow<typeof principalShape>;

const COLUMNS = 'id, tenant_id, display_name, email, title, synthetic, status, created_at, updated_at';

export function toPrincipalView(
  r: Pick<PrincipalRecord, 'id' | 'displayName' | 'title' | 'synthetic'>,
): PrincipalView {
  return { id: r.id, displayName: r.displayName, title: r.title, synthetic: r.synthetic };
}

export function getPrincipal(ex: SqlExecutor, id: string): Promise<PrincipalRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM principals WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    principalCodec.decode(r),
  );
}

export interface ListPrincipalsOptions {
  readonly tenantId: string;
  readonly status?: PrincipalRecord['status'];
  /** Restrict to these ids. */
  readonly ids?: readonly string[];
}

/** Principals of a tenant ordered by display name. */
export function listPrincipals(ex: SqlExecutor, options: ListPrincipalsOptions): Promise<PrincipalRecord[]> {
  return queryRows(
    ex,
    `SELECT ${COLUMNS} FROM principals
     WHERE tenant_id = :tenantId
       AND (:status IS NULL OR status = :status)
       AND (:ids IS NULL OR id = ANY (:ids))
     ORDER BY display_name, id`,
    {
      tenantId: p.uuid(options.tenantId),
      status: p.nullable.text(options.status),
      ids: p.nullable.uuidArray(options.ids),
    },
    (r) => principalCodec.decode(r),
  );
}

export interface CreatePrincipalInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly email?: string | null;
  readonly title?: string | null;
  readonly synthetic?: boolean;
}

/** Creates a principal (app: program lead / platform admin of the tenant; or system). */
export function createPrincipal(ex: SqlExecutor, input: CreatePrincipalInput): Promise<PrincipalRecord> {
  return queryOne(
    ex,
    `INSERT INTO principals (id, tenant_id, display_name, email, title, synthetic)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :displayName, :email, :title, :synthetic)
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      displayName: p.text(input.displayName),
      email: p.nullable.text(input.email),
      title: p.nullable.text(input.title),
      synthetic: p.bool(input.synthetic ?? false),
    },
    (r) => principalCodec.decode(r),
    'createPrincipal',
  );
}

export interface UpdatePrincipalInput {
  readonly displayName?: string;
  readonly email?: string | null;
  readonly title?: string | null;
  readonly status?: PrincipalRecord['status'];
}

export async function updatePrincipal(
  ex: SqlExecutor,
  id: string,
  patch: UpdatePrincipalInput,
): Promise<PrincipalRecord | null> {
  const set = setClause([
    ['display_name', patch.displayName === undefined ? undefined : p.text(patch.displayName)],
    ['email', patch.email === undefined ? undefined : p.nullable.text(patch.email)],
    ['title', patch.title === undefined ? undefined : p.nullable.text(patch.title)],
    ['status', patch.status === undefined ? undefined : p.text(patch.status)],
  ]);
  if (set.sql === '') return getPrincipal(ex, id);
  return queryFirst(
    ex,
    `UPDATE principals SET ${set.sql}, updated_at = now() WHERE id = :id RETURNING ${COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    (r) => principalCodec.decode(r),
  );
}

// ------------------------------------------------------------------------------------------------
// Role grants
// ------------------------------------------------------------------------------------------------

/** Active platform/tenant roles of a principal within `tenantId` (platform roles have no tenant). */
export async function listActiveRoles(
  ex: SqlExecutor,
  args: { principalId: string; tenantId: string },
): Promise<PlatformRoleValue[]> {
  const rows = await queryRows(
    ex,
    `SELECT DISTINCT role FROM role_grants
     WHERE principal_id = :principalId AND revoked_at IS NULL
       AND (tenant_id IS NULL OR tenant_id = :tenantId)
     ORDER BY role`,
    { principalId: p.uuid(args.principalId), tenantId: p.uuid(args.tenantId) },
    (r) => col.enum(PlatformRole.options).decode(r.role, 'role'),
  );
  return rows;
}

export interface RoleGrantRow {
  readonly principalId: string;
  readonly role: PlatformRoleValue;
}

/** Active roles of several principals (admin lists). */
export function listRoleGrants(
  ex: SqlExecutor,
  args: { principalIds: readonly string[]; tenantId: string },
): Promise<RoleGrantRow[]> {
  return queryRows(
    ex,
    `SELECT DISTINCT principal_id, role FROM role_grants
     WHERE principal_id = ANY (:ids) AND revoked_at IS NULL
       AND (tenant_id IS NULL OR tenant_id = :tenantId)
     ORDER BY principal_id, role`,
    { ids: p.uuidArray(args.principalIds), tenantId: p.uuid(args.tenantId) },
    (r) => ({
      principalId: col.uuid.decode(r.principal_id, 'principal_id'),
      role: col.enum(PlatformRole.options).decode(r.role, 'role'),
    }),
  );
}

/**
 * Grants a role unless already active. `platform_admin` is platform-scoped (stored without tenant);
 * other roles are scoped to `tenantId`. Returns true when a grant was created.
 */
export async function grantRole(
  ex: SqlExecutor,
  args: { principalId: string; tenantId: string; role: PlatformRoleValue; grantedBy?: string | null },
): Promise<boolean> {
  const tenantId = args.role === 'platform_admin' ? null : args.tenantId;
  const n = await ex.query(
    `INSERT INTO role_grants (principal_id, tenant_id, role, granted_by)
     SELECT :principalId, :tenantId, :role, :grantedBy
     WHERE NOT EXISTS (
       SELECT 1 FROM role_grants g
       WHERE g.principal_id = :principalId AND g.role = :role AND g.revoked_at IS NULL
         AND g.tenant_id IS NOT DISTINCT FROM :tenantId)`,
    {
      principalId: p.uuid(args.principalId),
      tenantId: p.nullable.uuid(tenantId),
      role: p.text(args.role),
      grantedBy: p.nullable.uuid(args.grantedBy),
    },
  );
  return n.rowCount > 0;
}

/** Revokes an active role. Returns the number of grants revoked. */
export async function revokeRole(
  ex: SqlExecutor,
  args: { principalId: string; tenantId: string; role: PlatformRoleValue },
): Promise<number> {
  const tenantId = args.role === 'platform_admin' ? null : args.tenantId;
  const result = await ex.query(
    `UPDATE role_grants SET revoked_at = now()
     WHERE principal_id = :principalId AND role = :role AND revoked_at IS NULL
       AND tenant_id IS NOT DISTINCT FROM :tenantId`,
    { principalId: p.uuid(args.principalId), tenantId: p.nullable.uuid(tenantId), role: p.text(args.role) },
  );
  return result.rowCount;
}

// ------------------------------------------------------------------------------------------------
// Memberships (as seen from the principal)
// ------------------------------------------------------------------------------------------------

export interface PrincipalMembership {
  readonly principalId: string;
  readonly ventureId: string;
  readonly ventureName: string;
  readonly role: MembershipRoleValue;
}

/** Active (not revoked, not expired) venture memberships of the given principals. */
export function listMembershipsForPrincipals(
  ex: SqlExecutor,
  principalIds: readonly string[],
): Promise<PrincipalMembership[]> {
  return queryRows(
    ex,
    `SELECT m.principal_id, m.venture_id, v.name AS venture_name, m.role
     FROM venture_memberships m JOIN ventures v ON v.id = m.venture_id
     WHERE m.principal_id = ANY (:ids) AND m.revoked_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY v.name, v.id`,
    { ids: p.uuidArray(principalIds) },
    (r) => ({
      principalId: col.uuid.decode(r.principal_id, 'principal_id'),
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      ventureName: col.text.decode(r.venture_name, 'venture_name'),
      role: col.enum(MembershipRole.options).decode(r.role, 'role'),
    }),
  );
}

/** Venture ids for which the principal is the EIR of an active assignment. */
export async function listAssignedVentureIds(ex: SqlExecutor, principalId: string): Promise<string[]> {
  return queryRows(
    ex,
    `SELECT DISTINCT a.venture_id
     FROM assignments a JOIN eir_profiles e ON e.id = a.eir_profile_id
     WHERE e.principal_id = :principalId AND a.status = 'active'
       AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
     ORDER BY a.venture_id`,
    { principalId: p.uuid(principalId) },
    (r) => col.uuid.decode(r.venture_id, 'venture_id'),
  );
}

/** Number of active principals in a tenant. */
export function countPrincipals(ex: SqlExecutor, tenantId: string): Promise<number> {
  return queryNumber(ex, `SELECT count(*) AS n FROM principals WHERE tenant_id = :t AND status = 'active'`, {
    t: p.uuid(tenantId),
  });
}
