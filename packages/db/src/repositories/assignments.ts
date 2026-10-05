import { CoachMode, PersonaKind, PersonaStatus } from '@foundry/contracts';

import { camelRow, col, type CamelRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { queryFirst, queryOne, queryRows } from './common.js';
import { getActiveRelease, type PersonaReleaseRecord } from './personas.js';

type CoachModeValue = (typeof CoachMode.options)[number];

const assignmentShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  venture_id: col.uuid,
  persona_id: col.uuid,
  eir_profile_id: col.uuid.nullable,
  allowed_modes: col.textArray,
  data_class_ceiling: col.enum(['public', 'program_internal', 'venture_private'] as const),
  status: col.enum(['active', 'suspended', 'ended'] as const),
  starts_at: col.ts,
  expires_at: col.ts.nullable,
  created_by: col.uuid.nullable,
  created_at: col.ts,
};
const assignmentCodec = camelRow(assignmentShape);
export type AssignmentRecord = Omit<CamelRow<typeof assignmentShape>, 'allowedModes'> & {
  readonly allowedModes: CoachModeValue[];
};
const COLUMNS =
  'id, tenant_id, venture_id, persona_id, eir_profile_id, allowed_modes, data_class_ceiling, status, starts_at, expires_at, created_by, created_at';

function decodeAssignment(raw: Parameters<typeof assignmentCodec.decode>[0]): AssignmentRecord {
  const a = assignmentCodec.decode(raw);
  return {
    ...a,
    allowedModes: a.allowedModes.filter((m): m is CoachModeValue =>
      (CoachMode.options as readonly string[]).includes(m),
    ),
  };
}

export function getAssignment(ex: SqlExecutor, id: string): Promise<AssignmentRecord | null> {
  return queryFirst(
    ex,
    `SELECT ${COLUMNS} FROM assignments WHERE id = :id`,
    { id: p.uuid(id) },
    decodeAssignment,
  );
}

export function listAssignments(ex: SqlExecutor, ventureId: string): Promise<AssignmentRecord[]> {
  return queryRows(
    ex,
    `SELECT ${COLUMNS} FROM assignments WHERE venture_id = :ventureId ORDER BY created_at DESC`,
    { ventureId: p.uuid(ventureId) },
    decodeAssignment,
  );
}

export interface ResolvedAssignment {
  readonly assignment: AssignmentRecord;
  readonly persona: {
    readonly id: string;
    readonly name: string;
    readonly kind: (typeof PersonaKind.options)[number];
    readonly status: (typeof PersonaStatus.options)[number];
    readonly suspendedReason: string | null;
  };
  /** Newest approved, unexpired release of the persona (null: nothing approved → sessions must not start). */
  readonly release: PersonaReleaseRecord | null;
  readonly eir: {
    readonly id: string;
    readonly principalId: string | null;
    readonly displayName: string;
    readonly synthetic: boolean;
    readonly status: 'active' | 'unavailable' | 'retired';
  } | null;
}

/**
 * Server-side resolution of who coaches a venture (run on every session create and turn): the venture's
 * active, started, unexpired assignment, its persona (with status — check for `suspended`), the active
 * persona release and the assigned EIR. Returns null when the venture has no active assignment.
 */
export async function resolveActiveAssignment(
  ex: SqlExecutor,
  ventureId: string,
): Promise<ResolvedAssignment | null> {
  const result = await ex.query(
    `SELECT a.id, a.tenant_id, a.venture_id, a.persona_id, a.eir_profile_id, a.allowed_modes, a.data_class_ceiling,
            a.status, a.starts_at, a.expires_at, a.created_by, a.created_at,
            pe.name AS persona_name, pe.kind AS persona_kind, pe.status AS persona_status,
            pe.suspended_reason AS persona_suspended_reason,
            e.principal_id AS eir_principal_id, e.display_name AS eir_display_name, e.synthetic AS eir_synthetic,
            e.status AS eir_status
     FROM assignments a
     JOIN personas pe ON pe.id = a.persona_id
     LEFT JOIN eir_profiles e ON e.id = a.eir_profile_id
     WHERE a.venture_id = :ventureId AND a.status = 'active'
       AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
     ORDER BY a.created_at DESC
     LIMIT 1`,
    { ventureId: p.uuid(ventureId) },
  );
  const raw = result.rows[0];
  if (!raw) return null;
  const assignment = decodeAssignment(raw);
  const release = await getActiveRelease(ex, assignment.personaId);
  return {
    assignment,
    persona: {
      id: assignment.personaId,
      name: col.text.decode(raw.persona_name, 'persona_name'),
      kind: col.enum(PersonaKind.options).decode(raw.persona_kind, 'persona_kind'),
      status: col.enum(PersonaStatus.options).decode(raw.persona_status, 'persona_status'),
      suspendedReason: col.text.nullable.decode(raw.persona_suspended_reason, 'persona_suspended_reason'),
    },
    release,
    eir: assignment.eirProfileId
      ? {
          id: assignment.eirProfileId,
          principalId: col.uuid.nullable.decode(raw.eir_principal_id, 'eir_principal_id'),
          displayName: col.text.decode(raw.eir_display_name, 'eir_display_name'),
          synthetic: col.bool.decode(raw.eir_synthetic, 'eir_synthetic'),
          status: col
            .enum(['active', 'unavailable', 'retired'] as const)
            .decode(raw.eir_status, 'eir_status'),
        }
      : null,
  };
}

export interface CreateAssignmentInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly ventureId: string;
  readonly personaId: string;
  readonly eirProfileId?: string | null;
  readonly allowedModes?: readonly CoachModeValue[];
  readonly dataClassCeiling?: AssignmentRecord['dataClassCeiling'];
  readonly startsAt?: string | Date | null;
  readonly expiresAt?: string | Date | null;
  readonly createdBy?: string | null;
}

/**
 * Creates the venture's active assignment (app: program lead). Any previous active assignment of the
 * venture is ended first (one active assignment per venture).
 */
export async function createAssignment(
  ex: SqlExecutor,
  input: CreateAssignmentInput,
): Promise<AssignmentRecord> {
  await ex.query(
    `UPDATE assignments SET status = 'ended' WHERE venture_id = :ventureId AND status = 'active'`,
    {
      ventureId: p.uuid(input.ventureId),
    },
  );
  return queryOne(
    ex,
    `INSERT INTO assignments (id, tenant_id, venture_id, persona_id, eir_profile_id, allowed_modes, data_class_ceiling,
                              starts_at, expires_at, created_by)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :ventureId, :personaId, :eirProfileId,
             coalesce(:modes, ARRAY['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route']),
             coalesce(:ceiling, 'venture_private'), coalesce(:startsAt, now()), :expiresAt, :createdBy)
     RETURNING ${COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      ventureId: p.uuid(input.ventureId),
      personaId: p.uuid(input.personaId),
      eirProfileId: p.nullable.uuid(input.eirProfileId),
      modes: p.nullable.textArray(input.allowedModes),
      ceiling: p.nullable.text(input.dataClassCeiling),
      startsAt: p.nullable.ts(input.startsAt),
      expiresAt: p.nullable.ts(input.expiresAt),
      createdBy: p.nullable.uuid(input.createdBy),
    },
    decodeAssignment,
    'createAssignment',
  );
}

/** Suspends, resumes or ends an assignment (per-assignment kill switch). */
export function setAssignmentStatus(
  ex: SqlExecutor,
  args: { assignmentId: string; status: AssignmentRecord['status'] },
): Promise<AssignmentRecord | null> {
  return queryFirst(
    ex,
    `UPDATE assignments SET status = :status WHERE id = :id RETURNING ${COLUMNS}`,
    { id: p.uuid(args.assignmentId), status: p.text(args.status) },
    decodeAssignment,
  );
}
