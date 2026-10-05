import {
  DataClassification,
  MembershipRole,
  VentureDomain,
  VentureStage,
  VentureStatus,
  type ProgramVentureRow,
  type TeamMemberView,
  type VentureSummary,
} from '@foundry/contracts';
import { type z } from 'zod';

import { camelRow, col, type CamelRow } from '../columns.js';
import { type SqlExecutor, type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import {
  principalSelect,
  queryFirst,
  queryOne,
  queryRows,
  requiredPrincipalFrom,
  setClause,
} from './common.js';

type MembershipRoleValue = (typeof MembershipRole.options)[number];

const ventureShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  name: col.text,
  one_liner: col.text,
  stage: col.enum(VentureStage.options),
  domain: col.enum(VentureDomain.options),
  cohort: col.text.nullable,
  classification: col.enum(DataClassification.options),
  status: col.enum(VentureStatus.options),
  current_goal: col.text.nullable,
  created_at: col.ts,
  updated_at: col.ts,
};
const ventureCodec = camelRow(ventureShape);
export type VentureRecord = CamelRow<typeof ventureShape>;
const COLUMNS =
  'id, tenant_id, name, one_liner, stage, domain, cohort, classification, status, current_goal, created_at, updated_at';

export function getVenture(ex: SqlExecutor, id: string): Promise<VentureRecord | null> {
  return queryFirst(ex, `SELECT ${COLUMNS} FROM ventures WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    ventureCodec.decode(r),
  );
}

/**
 * Counts shown on venture cards. Under RLS every sub-count only sees what the caller may see
 * (a program lead without membership gets zeros and no last session).
 *  - openActions: confirmed `action` items whose attributes.status is open/in_progress (or unset)
 *  - pendingMemory: `proposed` items
 *  - openEscalations: not resolved/declined/withdrawn
 */
const SUMMARY_SQL = `
  SELECT v.id, v.name, v.one_liner, v.stage, v.domain, v.status,
         (SELECT m.role FROM venture_memberships m
          WHERE m.venture_id = v.id AND m.principal_id = :principalId AND m.revoked_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now())
          ORDER BY m.granted_at LIMIT 1) AS my_role,
         (SELECT max(s.started_at) FROM coaching_sessions s WHERE s.venture_id = v.id) AS last_session_at,
         (SELECT count(*) FROM memory_objects mo
          WHERE mo.venture_id = v.id AND mo.type = 'action' AND mo.status = 'confirmed'
            AND coalesce(mo.attributes ->> 'status', 'open') IN ('open', 'in_progress')) AS open_actions,
         (SELECT count(*) FROM memory_objects mo WHERE mo.venture_id = v.id AND mo.status = 'proposed') AS pending_memory,
         (SELECT count(*) FROM escalations e
          WHERE e.venture_id = v.id AND e.status NOT IN ('resolved', 'declined', 'withdrawn')) AS open_escalations
  FROM ventures v`;

const summaryShape = {
  id: col.uuid,
  name: col.text,
  one_liner: col.text,
  stage: col.enum(VentureStage.options),
  domain: col.enum(VentureDomain.options),
  status: col.enum(VentureStatus.options),
  my_role: col.enum(MembershipRole.options).nullable,
  last_session_at: col.ts.nullable,
  open_actions: col.int,
  pending_memory: col.int,
  open_escalations: col.int,
};
const summaryCodec = camelRow(summaryShape);

export interface ListVentureSummariesOptions {
  /** The caller (used for `myRole`). */
  readonly principalId: string;
  readonly tenantId: string;
  /**
   * `member`: ventures where the principal is an active member or the assigned EIR (default).
   * `tenant`: every venture of the tenant the executor can see (program leads see all, without content).
   */
  readonly scope?: 'member' | 'tenant';
  readonly includeArchived?: boolean;
}

/** Venture cards with counts (contract `VentureSummary`). */
export function listVentureSummaries(
  ex: SqlExecutor,
  options: ListVentureSummariesOptions,
): Promise<VentureSummary[]> {
  const memberOnly = (options.scope ?? 'member') === 'member';
  return queryRows(
    ex,
    `${SUMMARY_SQL}
     WHERE v.tenant_id = :tenantId
       AND (:includeArchived OR v.status <> 'archived')
       AND (NOT :memberOnly
            OR EXISTS (SELECT 1 FROM venture_memberships m
                       WHERE m.venture_id = v.id AND m.principal_id = :principalId AND m.revoked_at IS NULL
                         AND (m.expires_at IS NULL OR m.expires_at > now()))
            OR EXISTS (SELECT 1 FROM assignments a JOIN eir_profiles e ON e.id = a.eir_profile_id
                       WHERE a.venture_id = v.id AND e.principal_id = :principalId AND a.status = 'active'
                         AND (a.expires_at IS NULL OR a.expires_at > now())))
     ORDER BY v.name, v.id`,
    {
      principalId: p.uuid(options.principalId),
      tenantId: p.uuid(options.tenantId),
      includeArchived: p.bool(options.includeArchived ?? false),
      memberOnly: p.bool(memberOnly),
    },
    (r) => summaryCodec.decode(r),
  );
}

/** One venture card (null when the venture is not visible). */
export function getVentureSummary(
  ex: SqlExecutor,
  args: { ventureId: string; principalId: string },
): Promise<VentureSummary | null> {
  return queryFirst(
    ex,
    `${SUMMARY_SQL} WHERE v.id = :ventureId`,
    { ventureId: p.uuid(args.ventureId), principalId: p.uuid(args.principalId) },
    (r) => summaryCodec.decode(r),
  );
}

export interface VentureAccess {
  readonly ventureId: string;
  readonly tenantId: string;
  readonly ventureStatus: VentureRecord['status'];
  /** Active membership role of the principal, if any. */
  readonly membershipRole: MembershipRoleValue | null;
  /** The principal is the EIR of the venture's active assignment. */
  readonly isAssignedEir: boolean;
}

/**
 * Re-derives a principal's relationship to a venture from the database (authorization input). Works
 * under both executors; under RLS a venture the caller cannot see returns null.
 */
export function getVentureAccess(
  ex: SqlExecutor,
  args: { ventureId: string; principalId: string },
): Promise<VentureAccess | null> {
  return queryFirst(
    ex,
    `SELECT v.id, v.tenant_id, v.status,
            (SELECT m.role FROM venture_memberships m
             WHERE m.venture_id = v.id AND m.principal_id = :principalId AND m.revoked_at IS NULL
               AND (m.expires_at IS NULL OR m.expires_at > now())
             ORDER BY CASE m.role WHEN 'founder' THEN 0 WHEN 'team' THEN 1 ELSE 2 END LIMIT 1) AS membership_role,
            EXISTS (SELECT 1 FROM assignments a JOIN eir_profiles e ON e.id = a.eir_profile_id
                    WHERE a.venture_id = v.id AND a.tenant_id = v.tenant_id AND e.principal_id = :principalId
                      AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())) AS is_assigned_eir
     FROM ventures v WHERE v.id = :ventureId`,
    { ventureId: p.uuid(args.ventureId), principalId: p.uuid(args.principalId) },
    (r) => ({
      ventureId: col.uuid.decode(r.id, 'id'),
      tenantId: col.uuid.decode(r.tenant_id, 'tenant_id'),
      ventureStatus: col.enum(VentureStatus.options).decode(r.status, 'status'),
      membershipRole: col.enum(MembershipRole.options).nullable.decode(r.membership_role, 'membership_role'),
      isAssignedEir: col.bool.decode(r.is_assigned_eir, 'is_assigned_eir'),
    }),
  );
}

export interface CreateVentureInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly name: string;
  readonly oneLiner?: string;
  readonly stage?: VentureRecord['stage'];
  readonly domain?: VentureRecord['domain'];
  readonly cohort?: string | null;
  readonly classification?: VentureRecord['classification'];
  readonly currentGoal?: string | null;
}

/** Creates a venture (app: program lead of the tenant). */
export function createVenture(ex: SqlExecutor, input: CreateVentureInput): Promise<VentureRecord> {
  return queryOne(
    ex,
    `INSERT INTO ventures (id, tenant_id, name, one_liner, stage, domain, cohort, classification, current_goal)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :name, coalesce(:oneLiner, ''), coalesce(:stage, 'idea'),
             coalesce(:domain, 'general'), :cohort, coalesce(:classification, 'synthetic'), :currentGoal)
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      name: p.text(input.name),
      oneLiner: p.nullable.text(input.oneLiner),
      stage: p.nullable.text(input.stage),
      domain: p.nullable.text(input.domain),
      cohort: p.nullable.text(input.cohort),
      classification: p.nullable.text(input.classification),
      currentGoal: p.nullable.text(input.currentGoal),
    },
    (r) => ventureCodec.decode(r),
    'createVenture',
  );
}

export interface UpdateVentureInput {
  readonly name?: string;
  readonly oneLiner?: string;
  readonly stage?: VentureRecord['stage'];
  readonly domain?: VentureRecord['domain'];
  readonly cohort?: string | null;
  readonly status?: VentureRecord['status'];
  readonly currentGoal?: string | null;
}

/** Partial update (app: founder/team or program lead). Returns null when not visible/updatable. */
export async function updateVenture(
  ex: SqlExecutor,
  id: string,
  patch: UpdateVentureInput,
): Promise<VentureRecord | null> {
  const set = setClause([
    ['name', patch.name === undefined ? undefined : p.text(patch.name)],
    ['one_liner', patch.oneLiner === undefined ? undefined : p.text(patch.oneLiner)],
    ['stage', patch.stage === undefined ? undefined : p.text(patch.stage)],
    ['domain', patch.domain === undefined ? undefined : p.text(patch.domain)],
    ['cohort', patch.cohort === undefined ? undefined : p.nullable.text(patch.cohort)],
    ['status', patch.status === undefined ? undefined : p.text(patch.status)],
    ['current_goal', patch.currentGoal === undefined ? undefined : p.nullable.text(patch.currentGoal)],
  ]);
  if (set.sql === '') return getVenture(ex, id);
  return queryFirst(
    ex,
    `UPDATE ventures SET ${set.sql}, updated_at = now() WHERE id = :id RETURNING ${COLUMNS}`,
    { ...set.params, id: p.uuid(id) },
    (r) => ventureCodec.decode(r),
  );
}

/**
 * Renames a venture as program staff through `app.rename_venture` (program lead or platform admin of the
 * current tenant; works without membership). False when the venture is not in the tenant. A name taken by
 * another venture of the tenant raises a unique violation (constraint `ventures_tenant_name_unique`).
 */
export async function renameVentureAsStaff(
  ex: SqlExecutor,
  args: { ventureId: string; name: string },
): Promise<boolean> {
  const row = await queryFirst(
    ex,
    'SELECT app.rename_venture(:ventureId, :name) AS renamed',
    { ventureId: p.uuid(args.ventureId), name: p.text(args.name) },
    (r) => col.bool.decode(r.renamed, 'renamed'),
  );
  return row === true;
}

type ProgramVentureRowValue = z.infer<typeof ProgramVentureRow>;

/** Program console list: metadata only (member count, assigned persona name). */
export function listProgramVentures(ex: SqlExecutor, tenantId: string): Promise<ProgramVentureRowValue[]> {
  return queryRows(
    ex,
    `SELECT v.id, v.name, v.stage, v.domain, v.status, v.created_at,
            (SELECT count(*) FROM venture_memberships m
             WHERE m.venture_id = v.id AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())) AS member_count,
            (SELECT pe.name FROM assignments a JOIN personas pe ON pe.id = a.persona_id
             WHERE a.venture_id = v.id AND a.status = 'active' LIMIT 1) AS persona_name
     FROM ventures v
     WHERE v.tenant_id = :tenantId
     ORDER BY v.name, v.id`,
    { tenantId: p.uuid(tenantId) },
    (r) => ({
      id: col.uuid.decode(r.id, 'id'),
      name: col.text.decode(r.name, 'name'),
      stage: col.enum(VentureStage.options).decode(r.stage, 'stage'),
      domain: col.enum(VentureDomain.options).decode(r.domain, 'domain'),
      status: col.text.decode(r.status, 'status'),
      memberCount: col.int.decode(r.member_count, 'member_count'),
      personaName: col.text.nullable.decode(r.persona_name, 'persona_name'),
      createdAt: col.ts.decode(r.created_at, 'created_at'),
    }),
  );
}

export interface VentureMemberName {
  readonly ventureId: string;
  readonly principalId: string;
  readonly displayName: string;
}

/**
 * Display names of the active members of every venture of one tenant. **System only**: it reads across
 * ventures, so it may only feed server-side guards (the cross-venture classifier and output validator)
 * and must never be returned to a caller. Both the ventures and the principals are restricted to
 * `tenantId`, so no other tenant's people are ever loaded.
 */
export function listVentureMemberNames(sx: SystemExecutor, tenantId: string): Promise<VentureMemberName[]> {
  return queryRows(
    sx,
    `SELECT m.venture_id, m.principal_id, pr.display_name
     FROM venture_memberships m
     JOIN ventures v ON v.id = m.venture_id AND v.tenant_id = :tenantId
     JOIN principals pr ON pr.id = m.principal_id AND pr.tenant_id = :tenantId
     WHERE m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY m.venture_id, pr.display_name`,
    { tenantId: p.uuid(tenantId) },
    (r) => ({
      ventureId: col.uuid.decode(r.venture_id, 'venture_id'),
      principalId: col.uuid.decode(r.principal_id, 'principal_id'),
      displayName: col.text.decode(r.display_name, 'display_name'),
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Memberships
// ------------------------------------------------------------------------------------------------

type TeamMemberViewValue = z.infer<typeof TeamMemberView>;

/** Active members of a venture (founders first). */
export function listTeam(ex: SqlExecutor, ventureId: string): Promise<TeamMemberViewValue[]> {
  return queryRows(
    ex,
    `SELECT m.principal_id, m.role, m.granted_at, m.expires_at, ${principalSelect('pr', 'pr')}
     FROM venture_memberships m LEFT JOIN principals pr ON pr.id = m.principal_id
     WHERE m.venture_id = :ventureId AND m.revoked_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY CASE m.role WHEN 'founder' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, pr.display_name, m.principal_id`,
    { ventureId: p.uuid(ventureId) },
    (r) => ({
      principal: requiredPrincipalFrom(r, 'pr', col.uuid.decode(r.principal_id, 'principal_id')),
      role: col.enum(MembershipRole.options).decode(r.role, 'role'),
      grantedAt: col.ts.decode(r.granted_at, 'granted_at'),
      expiresAt: col.ts.nullable.decode(r.expires_at, 'expires_at'),
    }),
  );
}

export interface AddMembershipInput {
  readonly id?: string;
  readonly ventureId: string;
  readonly principalId: string;
  readonly role: MembershipRoleValue;
  readonly grantedBy?: string | null;
  readonly expiresAt?: string | Date | null;
}

/**
 * Adds an active membership (app: program lead). If the principal already has an active membership the
 * role and expiry are updated instead. Returns the membership id.
 */
export async function addMembership(ex: SqlExecutor, input: AddMembershipInput): Promise<string> {
  const params = {
    id: p.nullable.uuid(input.id),
    ventureId: p.uuid(input.ventureId),
    principalId: p.uuid(input.principalId),
    role: p.text(input.role),
    grantedBy: p.nullable.uuid(input.grantedBy),
    expiresAt: p.nullable.ts(input.expiresAt),
  };
  const updated = await queryFirst(
    ex,
    `UPDATE venture_memberships SET role = :role, expires_at = :expiresAt
     WHERE venture_id = :ventureId AND principal_id = :principalId AND revoked_at IS NULL
     RETURNING id`,
    params,
    (r) => col.uuid.decode(r.id, 'id'),
  );
  if (updated) return updated;
  return queryOne(
    ex,
    `INSERT INTO venture_memberships (id, venture_id, principal_id, role, granted_by, expires_at)
     VALUES (coalesce(:id, gen_random_uuid()), :ventureId, :principalId, :role, :grantedBy, :expiresAt)
     RETURNING id`,
    params,
    (r) => col.uuid.decode(r.id, 'id'),
    'addMembership',
  );
}

/** Revokes the principal's active membership. Returns the number of memberships revoked. */
export async function revokeMembership(
  ex: SqlExecutor,
  args: { ventureId: string; principalId: string },
): Promise<number> {
  const result = await ex.query(
    `UPDATE venture_memberships SET revoked_at = now()
     WHERE venture_id = :ventureId AND principal_id = :principalId AND revoked_at IS NULL`,
    { ventureId: p.uuid(args.ventureId), principalId: p.uuid(args.principalId) },
  );
  return result.rowCount;
}
