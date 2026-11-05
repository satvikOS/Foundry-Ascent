/**
 * Conversation lab only (docs/runbooks/conversation-lab.md, suite `live`): one synthetic venture and founder per
 * live-evaluation scenario run, so every run starts from its own empty memory and nothing one scenario says can
 * reach another. Each venture is coached by the seeded demo venture's vEIR (QuietQuad's active assignment). A
 * plan entry may share its founder with another entry (`founderKey`): the isolation scenarios' "separate ventures
 * of the same student". Every id is deterministic from the entry's key; a second run changes nothing. The lab adds
 * them to its own freshly reset database; prior memory and documents are then created through the founder's API.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { seedId } from './ids.js';
import { insertRows } from './insert.js';

const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const STAGES = new Set([
  'idea',
  'discovery',
  'validation',
  'business_model',
  'commercialization',
  'growth',
  'transition',
]);
const DOMAINS = new Set([
  'consumer',
  'software',
  'hardware',
  'biomedical',
  'clinical',
  'energy',
  'social',
  'general',
]);
/** Most entries one call accepts (600 scenario runs plus their isolation neighbours, with repeats). */
export const LAB_LIVE_MAX_ENTRIES = 4000;

export interface LabLiveVenturePlan {
  readonly key: string;
  readonly name: string;
  readonly oneLiner: string;
  readonly stage: string;
  readonly domain: string;
  readonly goal: string;
  readonly founderKey: string;
  readonly founderName: string;
}

export interface LabLiveVenture {
  readonly key: string;
  readonly ventureId: string;
  readonly founderId: string;
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new SqlUsageError(`invalid ${what}`);
  }
  return value.trim();
}

/** Validates an untrusted plan (the lab writes it from the scenario files). */
export function parseLabLivePlan(raw: unknown): LabLiveVenturePlan[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LAB_LIVE_MAX_ENTRIES) {
    throw new SqlUsageError('the plan must list 1 to 4000 ventures');
  }
  const keys = new Set<string>();
  return raw.map((entry: unknown) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const key = text(e.key, 80, 'key');
    const founderKey = text(e.founderKey, 80, 'founderKey');
    if (!KEY.test(key) || !KEY.test(founderKey)) throw new SqlUsageError('invalid key');
    if (keys.has(key)) throw new SqlUsageError('duplicate key');
    keys.add(key);
    const stage = text(e.stage, 40, 'stage');
    const domain = text(e.domain, 40, 'domain');
    if (!STAGES.has(stage) || !DOMAINS.has(domain)) throw new SqlUsageError('invalid stage or domain');
    return {
      key,
      name: text(e.name, 120, 'name'),
      oneLiner: text(e.oneLiner, 280, 'oneLiner'),
      stage,
      domain,
      goal: text(e.goal, 400, 'goal'),
      founderKey,
      founderName: text(e.founderName, 120, 'founderName'),
    };
  });
}

/** Adds the plan's ventures to a seeded database (call inside a system transaction). */
export async function seedLabLiveVentures(
  sx: SystemExecutor,
  args: { readonly tenantSlug: string; readonly plan: readonly LabLiveVenturePlan[] },
): Promise<readonly LabLiveVenture[]> {
  const id = (...parts: string[]): string => seedId(args.tenantSlug, 'lab', 'live', ...parts);
  const tenantRow = (
    await sx.query('SELECT id FROM tenants WHERE slug = :slug', { slug: p.text(args.tenantSlug) })
  ).rows[0];
  if (!tenantRow) throw new SqlUsageError('the home tenant is not seeded');
  const tenantId = col.uuid.decode(tenantRow.id, 'id');
  const coachRow = (
    await sx.query(
      `SELECT a.persona_id, a.eir_profile_id
       FROM assignments a WHERE a.venture_id = :ventureId AND a.status = 'active'
       ORDER BY a.created_at DESC LIMIT 1`,
      { ventureId: p.uuid(seedId(args.tenantSlug, 'venture', 'quietquad')) },
    )
  ).rows[0];
  if (!coachRow) throw new SqlUsageError('the seeded demo venture has no active vEIR to share');
  const personaId = col.uuid.decode(coachRow.persona_id, 'persona_id');
  const eirProfileId =
    coachRow.eir_profile_id === null ? null : col.uuid.decode(coachRow.eir_profile_id, 'eir_profile_id');

  const founders = new Map<string, string>();
  for (const e of args.plan) if (!founders.has(e.founderKey)) founders.set(e.founderKey, e.founderName);
  await insertRows(
    sx,
    'principals',
    { id: 'uuid', tenant_id: 'uuid', display_name: 'text', title: 'text', synthetic: 'boolean' },
    [...founders].map(([key, name]) => ({
      id: id('principal', key),
      tenant_id: tenantId,
      display_name: name,
      title: 'Founder',
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
    args.plan.map((e) => ({
      id: id('venture', e.key),
      tenant_id: tenantId,
      name: e.name,
      one_liner: e.oneLiner,
      stage: e.stage,
      domain: e.domain,
      cohort: 'Lab',
      classification: 'synthetic',
      current_goal: e.goal,
    })),
  );
  await insertRows(
    sx,
    'venture_memberships',
    { id: 'uuid', venture_id: 'uuid', principal_id: 'uuid', role: 'text' },
    args.plan.map((e) => ({
      id: id('membership', e.key),
      venture_id: id('venture', e.key),
      principal_id: id('principal', e.founderKey),
      role: 'founder',
    })),
  );
  await insertRows(
    sx,
    'assignments',
    { id: 'uuid', tenant_id: 'uuid', venture_id: 'uuid', persona_id: 'uuid', eir_profile_id: 'uuid' },
    args.plan.map((e) => ({
      id: id('assignment', e.key),
      tenant_id: tenantId,
      venture_id: id('venture', e.key),
      persona_id: personaId,
      eir_profile_id: eirProfileId,
    })),
  );
  return args.plan.map((e) => ({
    key: e.key,
    ventureId: id('venture', e.key),
    founderId: id('principal', e.founderKey),
  }));
}
