/**
 * Conversation lab (docs/runbooks/conversation-lab.md, suite `face`, its LITE arm): what a LITE face needs in
 * production, for the synthetic vEIR the seeded founder calls, in the lab's own, freshly reset database. A LITE face
 * draws the EIR's likeness, so core offers it only when the persona's face reference is ready under a consent that
 * covers likeness (`app.persona_twin`, migration 0017). For each vEIR coaching the founder's ventures (an EIR persona
 * of a synthetic EIR whose consent subject is synthetic), this records, as the product does (`recordConsent`, then
 * the twin's face marked Ready):
 *
 * - a new consent record of the same synthetic subject that adds `likeness` to the scopes in force, linked to the
 *   persona (skipped when the consent in force already covers it);
 * - the persona's HeyGen face reference, status `ready` (the vendor sandbox's avatar id: the sandbox renders its own
 *   avatar whatever the reference names).
 *
 * Never in the seed (packages/db seed): production keeps every likeness off until a real consent is recorded.
 * Refuses anything but a local Postgres outside production; a second run changes nothing. Prints counts only.
 *
 *   DATABASE_URL=postgresql://…@localhost/… tsx src/scripts/lab-face-twin.ts ["Founder Name"]
 */
import { p, type SqlExecutor } from '@foundry/db';

import { createDatabase } from '../runtime/common.js';
import { LAB_FACE_FOUNDER } from './lab-face-admin.js';
import { refusal } from './lab-local-db.js';

/** The face reference the lab records: the vendor sandbox's only avatar (what the sandbox renders anyway). */
export const LAB_FACE_REFERENCE = 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a';
/** Why the lab's consent record exists (shown wherever the product lists consent evidence). */
export const LAB_CONSENT_EVIDENCE =
  'Synthetic consent record of the conversation lab (fictional EIR, likeness for the LITE face sandbox test)';

/**
 * The vEIRs coaching the synthetic founder `name`: active EIR personas of a synthetic EIR assigned to a venture the
 * founder belongs to, with their consent in force (whose subject is synthetic too).
 */
export const PERSONAS_SQL = `
  SELECT DISTINCT pe.id AS persona_id, pe.tenant_id, c.id AS consent_id, c.subject_principal_id AS subject_id,
         ('likeness' = ANY (c.asset_types)) AS covers_likeness
    FROM principals f
    JOIN venture_memberships m ON m.principal_id = f.id AND m.revoked_at IS NULL
    JOIN assignments a ON a.venture_id = m.venture_id AND a.status = 'active'
    JOIN personas pe ON pe.id = a.persona_id AND pe.kind = 'eir_persona' AND pe.status = 'active'
    JOIN eir_profiles ep ON ep.id = pe.eir_profile_id AND ep.synthetic
    JOIN consents c ON c.id = pe.consent_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
    JOIN principals s ON s.id = c.subject_principal_id AND s.synthetic
   WHERE f.display_name = :name AND f.synthetic
   ORDER BY pe.id`;

/** A new record of the same synthetic subject, the scopes in force plus `likeness`. */
export const CONSENT_SQL = `
  INSERT INTO consents (tenant_id, subject_principal_id, asset_types, approved_uses, audiences, evidence_ref)
  SELECT c.tenant_id, c.subject_principal_id, c.asset_types || ARRAY['likeness'], c.approved_uses, c.audiences,
         :evidence
    FROM consents c
   WHERE c.id = :consent AND NOT ('likeness' = ANY (c.asset_types))
  RETURNING id`;

export const LINK_SQL = 'UPDATE personas SET consent_id = :consent WHERE id = :persona';

/** The persona's face reference, ready (the database refuses `ready` unless the consent covers likeness). */
export const FACE_SQL = `
  INSERT INTO persona_media AS m (persona_id, tenant_id, kind, vendor, vendor_ref, status, updated_by)
  VALUES (:persona, :tenant, 'face', 'heygen', :ref, 'ready', :by)
  ON CONFLICT (persona_id, kind) DO UPDATE
    SET vendor_ref = EXCLUDED.vendor_ref, status = 'ready', updated_by = EXCLUDED.updated_by
    WHERE m.vendor_ref IS DISTINCT FROM EXCLUDED.vendor_ref OR m.status <> 'ready'`;

/** The personas among `ids` whose face is ready under a consent in force that covers likeness. */
export const READY_SQL = `
  SELECT count(*)::int AS n
    FROM persona_media m
    JOIN personas pe ON pe.id = m.persona_id
    JOIN consents c ON c.id = pe.consent_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
   WHERE m.kind = 'face' AND m.vendor = 'heygen' AND m.status = 'ready' AND 'likeness' = ANY (c.asset_types)
     AND m.persona_id = ANY (string_to_array(:ids, ',')::uuid[])`;

export interface LabFaceTwin {
  /** The vEIRs found for the founder. */
  readonly personas: number;
  /** Consent records added (0 when every one already covered likeness). */
  readonly consents: number;
  /** Personas whose face is now ready under likeness consent. */
  readonly ready: number;
}

/** Records the LITE face's prerequisites for the vEIRs of the synthetic founder `name` (a system executor). */
export async function seedLabFaceTwin(
  ex: SqlExecutor,
  name: string = LAB_FACE_FOUNDER,
): Promise<LabFaceTwin> {
  const found = await ex.query(PERSONAS_SQL, { name: p.text(name) });
  const personas = found.rows.map((row) => ({
    personaId: String(row.persona_id),
    tenantId: String(row.tenant_id),
    consentId: String(row.consent_id),
    subjectId: String(row.subject_id),
    coversLikeness: row.covers_likeness === true,
  }));
  let consents = 0;
  for (const persona of personas) {
    if (!persona.coversLikeness) {
      const added = await ex.query(CONSENT_SQL, {
        consent: p.uuid(persona.consentId),
        evidence: p.text(LAB_CONSENT_EVIDENCE),
      });
      const consentId = added.rows[0]?.id;
      if (typeof consentId !== 'string') throw new Error('lab consent not recorded');
      await ex.query(LINK_SQL, { consent: p.uuid(consentId), persona: p.uuid(persona.personaId) });
      consents += 1;
    }
    await ex.query(FACE_SQL, {
      persona: p.uuid(persona.personaId),
      tenant: p.uuid(persona.tenantId),
      ref: p.text(LAB_FACE_REFERENCE),
      by: p.uuid(persona.subjectId),
    });
  }
  const ready =
    personas.length === 0
      ? 0
      : Number(
          (await ex.query(READY_SQL, { ids: p.text(personas.map((x) => x.personaId).join(',')) })).rows[0]
            ?.n ?? 0,
        );
  return { personas: personas.length, consents, ready };
}

/** The line the lab parses (conversation_lab/face.py `parse_twin_line`): counts and the outcome only. */
export function formatLine(result: LabFaceTwin): string {
  const ok = result.personas > 0 && result.ready === result.personas;
  return `lab-face-twin: personas=${String(result.personas)} face=${ok ? 'ready' : 'not_found'}`;
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DB_DRIVER: process.env.DB_DRIVER ?? 'pg',
  };
  const refused = refusal(env);
  if (refused) {
    process.stderr.write(`lab-face-twin: refused (${refused})\n`);
    process.exit(2);
  }
  const given = process.argv[2]?.trim() ?? '';
  const db = createDatabase(env);
  try {
    const result = await db.system((sx) => seedLabFaceTwin(sx, given === '' ? LAB_FACE_FOUNDER : given));
    process.stdout.write(`${formatLine(result)}\n`);
    if (result.personas === 0 || result.ready !== result.personas) process.exitCode = 3;
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith('lab-face-twin.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`lab-face-twin: ${err instanceof Error ? err.name : typeof err}\n`);
    process.exit(2);
  });
}
