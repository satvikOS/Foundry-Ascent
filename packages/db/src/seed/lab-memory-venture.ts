/**
 * Conversation lab only (docs/runbooks/conversation-lab.md): a dedicated synthetic venture for the remembered
 * (multi-session) conversations of evals' matrix (`--memory-venture`). Those conversations write to the
 * venture's vEIR notebook and memory, so they never run in a seeded demo venture. The lab adds this venture to
 * its own freshly reset database for each run; nothing deploys it.
 *
 * It gets two synthetic founders and a synthetic teammate (evals issues codes for synthetic principals only; the
 * teammate scenarios need a second member, and a third lets evals spread the remembered conversations under the
 * app's per-person voice-turn limit), QuietQuad's vEIR as its coach (the persona the rest of the lab talks to)
 * and an empty notebook. Every id is deterministic, so a second run changes nothing.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { seedId } from './ids.js';
import { insertRows } from './insert.js';

/** The venture's key as evals derives it from the name (lower-case letters and digits). */
export const LAB_MEMORY_VENTURE_KEY = 'lanternwise';

/** Invented names only (ADR-006), none of them a seeded demo venture's or person's. */
export const LAB_MEMORY_VENTURE = {
  key: LAB_MEMORY_VENTURE_KEY,
  name: 'Lanternwise',
  oneLiner: 'Matches evening-course students into study groups by schedule and module.',
  stage: 'discovery',
  domain: 'consumer',
  cohort: 'Lab',
  currentGoal:
    'Find out whether evening students will join a matched study group within a week of signing up.',
  members: [
    { key: 'lab-founder-tamsin', displayName: 'Tamsin Arkwright', title: 'Founder', role: 'founder' },
    { key: 'lab-founder-imogen', displayName: 'Imogen Castellane', title: 'Co-founder', role: 'founder' },
    { key: 'lab-team-ruairi', displayName: 'Ruairi Fenwick', title: 'Product lead', role: 'team' },
  ],
} as const;

/** The demo venture whose active vEIR assignment the lab venture shares. */
const COACH_FROM = 'quietquad';

export interface LabMemoryVentureResult {
  readonly key: string;
  readonly ventureId: string;
  readonly personaId: string;
  readonly members: number;
}

/** Adds the lab's memory venture to a seeded database (call inside a system transaction). */
export async function seedLabMemoryVenture(
  sx: SystemExecutor,
  args: { readonly tenantSlug: string },
): Promise<LabMemoryVentureResult> {
  const v = LAB_MEMORY_VENTURE;
  const id = (...parts: string[]): string => seedId(args.tenantSlug, 'lab', ...parts);
  const tenant = await sx.query('SELECT id FROM tenants WHERE slug = :slug', {
    slug: p.text(args.tenantSlug),
  });
  const tenantRow = tenant.rows[0];
  if (!tenantRow) throw new SqlUsageError('the home tenant is not seeded');
  const tenantId = col.uuid.decode(tenantRow.id, 'id');
  const coach = await sx.query(
    `SELECT a.persona_id, a.eir_profile_id FROM assignments a
     WHERE a.venture_id = :ventureId AND a.status = 'active'
     ORDER BY a.created_at DESC LIMIT 1`,
    { ventureId: p.uuid(seedId(args.tenantSlug, 'venture', COACH_FROM)) },
  );
  const coachRow = coach.rows[0];
  if (!coachRow) throw new SqlUsageError('the seeded demo venture has no active coach to share');
  const personaId = col.uuid.decode(coachRow.persona_id, 'persona_id');
  const eirProfileId =
    coachRow.eir_profile_id === null ? null : col.uuid.decode(coachRow.eir_profile_id, 'eir_profile_id');
  const lead = await sx.query('SELECT id FROM principals WHERE id = :id', {
    id: p.uuid(seedId(args.tenantSlug, 'principal', 'lead-elise')),
  });
  const grantedBy = lead.rows[0] ? col.uuid.decode(lead.rows[0].id, 'id') : null;

  const ventureId = id('venture', v.key);
  await insertRows(
    sx,
    'principals',
    { id: 'uuid', tenant_id: 'uuid', display_name: 'text', title: 'text', synthetic: 'boolean' },
    v.members.map((m) => ({
      id: id('principal', m.key),
      tenant_id: tenantId,
      display_name: m.displayName,
      title: m.title,
      synthetic: true,
    })),
  );
  await insertRows(
    sx,
    'ventures',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      name: 'text',
      one_liner: 'text',
      stage: 'text',
      domain: 'text',
      cohort: 'text',
      classification: 'text',
      current_goal: 'text',
    },
    [
      {
        id: ventureId,
        tenant_id: tenantId,
        name: v.name,
        one_liner: v.oneLiner,
        stage: v.stage,
        domain: v.domain,
        cohort: v.cohort,
        classification: 'synthetic',
        current_goal: v.currentGoal,
      },
    ],
  );
  await insertRows(
    sx,
    'venture_memberships',
    { id: 'uuid', venture_id: 'uuid', principal_id: 'uuid', role: 'text', granted_by: 'uuid' },
    v.members.map((m) => ({
      id: id('membership', v.key, m.key),
      venture_id: ventureId,
      principal_id: id('principal', m.key),
      role: m.role,
      granted_by: grantedBy,
    })),
  );
  await insertRows(
    sx,
    'assignments',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      venture_id: 'uuid',
      persona_id: 'uuid',
      eir_profile_id: 'uuid',
      created_by: 'uuid',
    },
    [
      {
        id: id('assignment', v.key),
        tenant_id: tenantId,
        venture_id: ventureId,
        persona_id: personaId,
        eir_profile_id: eirProfileId,
        created_by: grantedBy,
      },
    ],
  );
  await insertRows(
    sx,
    'veir_notebooks',
    { id: 'uuid', tenant_id: 'uuid', venture_id: 'uuid', persona_id: 'uuid' },
    [{ id: id('notebook', v.key), tenant_id: tenantId, venture_id: ventureId, persona_id: personaId }],
  );
  return { key: v.key, ventureId, personaId, members: v.members.length };
}
