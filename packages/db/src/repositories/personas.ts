import {
  CoachMode,
  Doctrine,
  PersonaKind,
  PersonaReleaseStatus,
  PersonaStatus,
  Style,
  type PersonaReleaseView,
  type PersonaView,
} from '@foundry/contracts';

import { camelRow, col, type CamelRow, type RawRow } from '../columns.js';
import { type SqlExecutor } from '../executor.js';
import { p } from '../params.js';
import { principalFrom, principalSelect, queryFirst, queryOne, queryRows } from './common.js';

type CoachModeValue = (typeof CoachMode.options)[number];

// ------------------------------------------------------------------------------------------------
// Personas
// ------------------------------------------------------------------------------------------------

const personaShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  eir_profile_id: col.uuid.nullable,
  name: col.text,
  kind: col.enum(PersonaKind.options),
  status: col.enum(PersonaStatus.options),
  consent_id: col.uuid.nullable,
  suspended_reason: col.text.nullable,
  created_at: col.ts,
  updated_at: col.ts,
};
const personaCodec = camelRow(personaShape);
export type PersonaRecord = CamelRow<typeof personaShape>;
const PERSONA_COLUMNS =
  'id, tenant_id, eir_profile_id, name, kind, status, consent_id, suspended_reason, created_at, updated_at';

export function getPersona(ex: SqlExecutor, id: string): Promise<PersonaRecord | null> {
  return queryFirst(ex, `SELECT ${PERSONA_COLUMNS} FROM personas WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    personaCodec.decode(r),
  );
}

export interface CreatePersonaInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: PersonaRecord['kind'];
  readonly eirProfileId?: string | null;
  readonly consentId?: string | null;
  readonly status?: PersonaRecord['status'];
}

export function createPersona(ex: SqlExecutor, input: CreatePersonaInput): Promise<PersonaRecord> {
  return queryOne(
    ex,
    `INSERT INTO personas (id, tenant_id, eir_profile_id, name, kind, status, consent_id)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :eirProfileId, :name, :kind, coalesce(:status, 'draft'), :consentId)
     RETURNING ${PERSONA_COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      eirProfileId: p.nullable.uuid(input.eirProfileId),
      name: p.text(input.name),
      kind: p.text(input.kind),
      status: p.nullable.text(input.status),
      consentId: p.nullable.uuid(input.consentId),
    },
    (r) => personaCodec.decode(r),
    'createPersona',
  );
}

/**
 * Suspends, resumes, retires or activates a persona (kill switch without engineering). `reason` is
 * stored for suspensions and cleared otherwise. Returns null when not visible/updatable.
 */
export function setPersonaStatus(
  ex: SqlExecutor,
  args: { personaId: string; status: PersonaRecord['status']; reason?: string | null },
): Promise<PersonaRecord | null> {
  return queryFirst(
    ex,
    `UPDATE personas
     SET status = :status,
         suspended_reason = CASE WHEN :status = 'suspended' THEN :reason ELSE NULL END,
         updated_at = now()
     WHERE id = :id
     RETURNING ${PERSONA_COLUMNS}`,
    { id: p.uuid(args.personaId), status: p.text(args.status), reason: p.nullable.text(args.reason) },
    (r) => personaCodec.decode(r),
  );
}

// ------------------------------------------------------------------------------------------------
// Releases
// ------------------------------------------------------------------------------------------------

/** Contract view plus expiry. */
export type PersonaReleaseRecord = PersonaReleaseView & { readonly expiresAt: string | null };

const releaseShape = {
  id: col.uuid,
  persona_id: col.uuid,
  version: col.int,
  doctrine: col.json(Doctrine),
  style: col.json(Style),
  disclosure_text: col.text,
  allowed_modes: col.textArray,
  status: col.enum(PersonaReleaseStatus.options),
  approved_at: col.ts.nullable,
  expires_at: col.ts.nullable,
  created_at: col.ts,
  created_by: col.uuid.nullable,
  approved_by: col.uuid.nullable,
};
const releaseCodec = camelRow(releaseShape);

function decodeModes(modes: readonly string[]): CoachModeValue[] {
  return modes.filter((m): m is CoachModeValue => (CoachMode.options as readonly string[]).includes(m));
}

function decodeRelease(r: RawRow): PersonaReleaseRecord {
  const base = releaseCodec.decode(r);
  return {
    id: base.id,
    personaId: base.personaId,
    version: base.version,
    doctrine: base.doctrine,
    style: base.style,
    disclosureText: base.disclosureText,
    allowedModes: decodeModes(base.allowedModes),
    status: base.status,
    createdBy: principalFrom(r, 'cb', base.createdBy),
    approvedBy: principalFrom(r, 'ab', base.approvedBy),
    approvedAt: base.approvedAt,
    createdAt: base.createdAt,
    expiresAt: base.expiresAt,
  };
}

const RELEASE_SELECT = `
  SELECT r.id, r.persona_id, r.version, r.doctrine, r.style, r.disclosure_text, r.allowed_modes, r.status,
         r.approved_at, r.expires_at, r.created_at, r.created_by, r.approved_by,
         ${principalSelect('cb', 'cb')}, ${principalSelect('ab', 'ab')}
  FROM persona_releases r
  LEFT JOIN principals cb ON cb.id = r.created_by
  LEFT JOIN principals ab ON ab.id = r.approved_by`;

export function getRelease(ex: SqlExecutor, id: string): Promise<PersonaReleaseRecord | null> {
  return queryFirst(ex, `${RELEASE_SELECT} WHERE r.id = :id`, { id: p.uuid(id) }, decodeRelease);
}

/** Releases of a persona, newest version first. */
export function listReleases(ex: SqlExecutor, personaId: string): Promise<PersonaReleaseRecord[]> {
  return queryRows(
    ex,
    `${RELEASE_SELECT} WHERE r.persona_id = :personaId ORDER BY r.version DESC`,
    { personaId: p.uuid(personaId) },
    decodeRelease,
  );
}

/** The newest approved, unexpired release (what sessions run on). */
export function getActiveRelease(ex: SqlExecutor, personaId: string): Promise<PersonaReleaseRecord | null> {
  return queryFirst(
    ex,
    `${RELEASE_SELECT}
     WHERE r.persona_id = :personaId AND r.status = 'approved' AND (r.expires_at IS NULL OR r.expires_at > now())
     ORDER BY r.version DESC LIMIT 1`,
    { personaId: p.uuid(personaId) },
    decodeRelease,
  );
}

export interface CreateReleaseInput {
  readonly id?: string;
  readonly personaId: string;
  readonly doctrine: Doctrine;
  readonly style: Style;
  readonly disclosureText: string;
  readonly allowedModes: readonly CoachModeValue[];
  readonly createdBy?: string | null;
  readonly expiresAt?: string | Date | null;
}

/** Creates a draft release with the next version number. */
export async function createRelease(
  ex: SqlExecutor,
  input: CreateReleaseInput,
): Promise<PersonaReleaseRecord> {
  const id = await queryOne(
    ex,
    `INSERT INTO persona_releases (id, persona_id, version, doctrine, style, disclosure_text, allowed_modes, created_by, expires_at)
     SELECT coalesce(:id, gen_random_uuid()), :personaId,
            coalesce((SELECT max(version) FROM persona_releases WHERE persona_id = :personaId), 0) + 1,
            :doctrine, :style, :disclosure, :modes, :createdBy, :expiresAt
     RETURNING id`,
    {
      id: p.nullable.uuid(input.id),
      personaId: p.uuid(input.personaId),
      doctrine: p.json(input.doctrine),
      style: p.json(input.style),
      disclosure: p.text(input.disclosureText),
      modes: p.textArray(input.allowedModes),
      createdBy: p.nullable.uuid(input.createdBy),
      expiresAt: p.nullable.ts(input.expiresAt),
    },
    (r) => col.uuid.decode(r.id, 'id'),
    'createRelease',
  );
  const release = await getRelease(ex, id);
  if (!release) throw new Error('release vanished after insert');
  return release;
}

/**
 * Approves a draft release and supersedes previously approved releases of the same persona.
 * Returns null when the release is not a visible draft.
 */
export async function approveRelease(
  ex: SqlExecutor,
  args: { releaseId: string; approvedBy: string },
): Promise<PersonaReleaseRecord | null> {
  const personaId = await queryFirst(
    ex,
    `UPDATE persona_releases SET status = 'approved', approved_by = :approvedBy, approved_at = now()
     WHERE id = :id AND status = 'draft'
     RETURNING persona_id`,
    { id: p.uuid(args.releaseId), approvedBy: p.uuid(args.approvedBy) },
    (r) => col.uuid.decode(r.persona_id, 'persona_id'),
  );
  if (!personaId) return null;
  await ex.query(
    `UPDATE persona_releases SET status = 'superseded'
     WHERE persona_id = :personaId AND status = 'approved' AND id <> :id`,
    { personaId: p.uuid(personaId), id: p.uuid(args.releaseId) },
  );
  return getRelease(ex, args.releaseId);
}

/** Withdraws a draft or approved release. */
export async function withdrawRelease(ex: SqlExecutor, releaseId: string): Promise<boolean> {
  const result = await ex.query(
    `UPDATE persona_releases SET status = 'withdrawn' WHERE id = :id AND status IN ('draft', 'approved')`,
    { id: p.uuid(releaseId) },
  );
  return result.rowCount > 0;
}

// ------------------------------------------------------------------------------------------------
// Persona views (EIR studio)
// ------------------------------------------------------------------------------------------------

const PERSONA_VIEW_SELECT = `
  SELECT pe.id, pe.name, pe.kind, pe.status, pe.suspended_reason,
         e.id AS eir_id, e.display_name AS eir_display_name, e.synthetic AS eir_synthetic, e.expertise_tags AS eir_tags,
         (pe.consent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM consents c WHERE c.id = pe.consent_id
              AND (c.revoked_at IS NOT NULL OR (c.expires_at IS NOT NULL AND c.expires_at <= now())))) AS has_consent,
         (SELECT count(DISTINCT a.venture_id) FROM assignments a
          WHERE a.persona_id = pe.id AND a.status = 'active' AND (a.expires_at IS NULL OR a.expires_at > now())) AS assigned_count
  FROM personas pe
  LEFT JOIN eir_profiles e ON e.id = pe.eir_profile_id`;

async function buildPersonaViews(ex: SqlExecutor, rows: readonly RawRow[]): Promise<PersonaView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => col.uuid.decode(r.id, 'id'));
  const releases = await queryRows(
    ex,
    `${RELEASE_SELECT} WHERE r.persona_id = ANY (:ids) ORDER BY r.persona_id, r.version DESC`,
    { ids: p.uuidArray(ids) },
    decodeRelease,
  );
  const now = Date.now();
  return rows.map((r) => {
    const id = col.uuid.decode(r.id, 'id');
    const own = releases.filter((rel) => rel.personaId === id);
    const active =
      own.find(
        (rel) => rel.status === 'approved' && (rel.expiresAt === null || Date.parse(rel.expiresAt) > now),
      ) ?? null;
    const eirId = col.uuid.nullable.decode(r.eir_id, 'eir_id');
    let activeRelease: PersonaReleaseView | null = null;
    if (active) {
      const { expiresAt: _expiresAt, ...view } = active;
      activeRelease = view;
    }
    return {
      id,
      name: col.text.decode(r.name, 'name'),
      kind: col.enum(PersonaKind.options).decode(r.kind, 'kind'),
      status: col.enum(PersonaStatus.options).decode(r.status, 'status'),
      suspendedReason: col.text.nullable.decode(r.suspended_reason, 'suspended_reason'),
      eirProfile: eirId
        ? {
            id: eirId,
            displayName: col.text.decode(r.eir_display_name, 'eir_display_name'),
            synthetic: col.bool.decode(r.eir_synthetic, 'eir_synthetic'),
            expertiseTags: col.textArray.decode(r.eir_tags, 'eir_tags'),
          }
        : null,
      hasConsent: col.bool.decode(r.has_consent, 'has_consent'),
      activeRelease,
      releases: own.map((rel) => ({
        id: rel.id,
        version: rel.version,
        status: rel.status,
        approvedAt: rel.approvedAt,
        createdAt: rel.createdAt,
      })),
      assignedVentureCount: col.int.decode(r.assigned_count, 'assigned_count'),
    };
  });
}

/** Personas of a tenant as contract `PersonaView`s (neutral guide first). */
export async function listPersonaViews(ex: SqlExecutor, tenantId: string): Promise<PersonaView[]> {
  const result = await ex.query(
    `${PERSONA_VIEW_SELECT} WHERE pe.tenant_id = :tenantId
     ORDER BY CASE pe.kind WHEN 'neutral_guide' THEN 0 ELSE 1 END, pe.name, pe.id`,
    { tenantId: p.uuid(tenantId) },
  );
  return buildPersonaViews(ex, result.rows);
}

export async function getPersonaView(ex: SqlExecutor, personaId: string): Promise<PersonaView | null> {
  const result = await ex.query(`${PERSONA_VIEW_SELECT} WHERE pe.id = :id`, { id: p.uuid(personaId) });
  const [view] = await buildPersonaViews(ex, result.rows);
  return view ?? null;
}

// ------------------------------------------------------------------------------------------------
// Consents (likeness / voice / doctrine)
// ------------------------------------------------------------------------------------------------

const consentShape = {
  id: col.uuid,
  tenant_id: col.uuid,
  subject_principal_id: col.uuid,
  asset_types: col.textArray,
  approved_uses: col.textArray,
  audiences: col.textArray,
  evidence_ref: col.text.nullable,
  granted_at: col.ts,
  expires_at: col.ts.nullable,
  revoked_at: col.ts.nullable,
};
const consentCodec = camelRow(consentShape);
export type ConsentRecord = CamelRow<typeof consentShape>;
const CONSENT_COLUMNS =
  'id, tenant_id, subject_principal_id, asset_types, approved_uses, audiences, evidence_ref, granted_at, expires_at, revoked_at';

export interface CreateConsentInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly subjectPrincipalId: string;
  readonly assetTypes: readonly ('doctrine' | 'style' | 'voice' | 'likeness' | 'cases')[];
  readonly approvedUses?: readonly string[];
  readonly audiences?: readonly string[];
  readonly evidenceRef?: string | null;
  readonly expiresAt?: string | Date | null;
}

/** Records a consent (app: only the subject may record their own consent). */
export function createConsent(ex: SqlExecutor, input: CreateConsentInput): Promise<ConsentRecord> {
  return queryOne(
    ex,
    `INSERT INTO consents (id, tenant_id, subject_principal_id, asset_types, approved_uses, audiences, evidence_ref, expires_at)
     VALUES (coalesce(:id, gen_random_uuid()), :tenantId, :subject, :assetTypes, :uses, :audiences, :evidenceRef, :expiresAt)
     RETURNING ${CONSENT_COLUMNS}`,
    {
      id: p.nullable.uuid(input.id),
      tenantId: p.uuid(input.tenantId),
      subject: p.uuid(input.subjectPrincipalId),
      assetTypes: p.textArray(input.assetTypes),
      uses: p.textArray(input.approvedUses ?? []),
      audiences: p.textArray(input.audiences ?? []),
      evidenceRef: p.nullable.text(input.evidenceRef),
      expiresAt: p.nullable.ts(input.expiresAt),
    },
    (r) => consentCodec.decode(r),
    'createConsent',
  );
}

export function getConsent(ex: SqlExecutor, id: string): Promise<ConsentRecord | null> {
  return queryFirst(ex, `SELECT ${CONSENT_COLUMNS} FROM consents WHERE id = :id`, { id: p.uuid(id) }, (r) =>
    consentCodec.decode(r),
  );
}

export function listConsents(ex: SqlExecutor, subjectPrincipalId: string): Promise<ConsentRecord[]> {
  return queryRows(
    ex,
    `SELECT ${CONSENT_COLUMNS} FROM consents WHERE subject_principal_id = :subject ORDER BY granted_at DESC`,
    { subject: p.uuid(subjectPrincipalId) },
    (r) => consentCodec.decode(r),
  );
}

/**
 * Revokes a consent and suspends every active persona that relies on it (no persona may run without
 * consent). Returns the number of personas suspended, or null when the consent was not revocable.
 */
export async function revokeConsent(ex: SqlExecutor, consentId: string): Promise<number | null> {
  const revoked = await ex.query(
    'UPDATE consents SET revoked_at = now() WHERE id = :id AND revoked_at IS NULL',
    {
      id: p.uuid(consentId),
    },
  );
  if (revoked.rowCount === 0) return null;
  const suspended = await ex.query(
    `UPDATE personas SET status = 'suspended', suspended_reason = 'consent revoked', updated_at = now()
     WHERE consent_id = :id AND status = 'active'`,
    { id: p.uuid(consentId) },
  );
  return suspended.rowCount;
}
