/**
 * Conversation lab only (docs/runbooks/conversation-lab.md, suite `client`): one synthetic venture and founder per
 * scenario of the client's test, with the confirmed record the scenario starts from (each item dated in the past, as
 * a founder who has worked for weeks has it). Coached by the seeded demo venture's vEIR (QuietQuad's active
 * assignment). Every id is deterministic from the entry's key; a second run changes nothing. The lab adds them to its
 * own freshly reset database.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { seedId } from './ids.js';
import { insertRows } from './insert.js';
import { parseLabLivePlan, type LabLiveVenturePlan } from './lab-live-ventures.js';

const DAY_MS = 86_400_000;
const MEMORY_TYPES = new Set([
  'fact',
  'hypothesis',
  'decision',
  'experiment',
  'evidence',
  'action',
  'milestone',
  'risk',
  'preference',
  'relationship',
  'insight',
]);
const MAX_RECORD = 20;

export interface LabClientRecordItem {
  readonly type: string;
  readonly title: string;
  readonly content: string;
  readonly daysAgo: number;
}

export interface LabClientVenturePlan extends LabLiveVenturePlan {
  readonly record: readonly LabClientRecordItem[];
}

export interface LabClientVenture {
  readonly key: string;
  readonly ventureId: string;
  readonly founderId: string;
}

function recordItem(raw: unknown): LabClientRecordItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const { type, title, content, daysAgo } = r;
  if (typeof type !== 'string' || !MEMORY_TYPES.has(type)) throw new SqlUsageError('invalid record type');
  if (typeof title !== 'string' || title.trim() === '' || title.length > 200) {
    throw new SqlUsageError('invalid record title');
  }
  if (typeof content !== 'string' || content.trim() === '' || content.length > 2000) {
    throw new SqlUsageError('invalid record content');
  }
  if (typeof daysAgo !== 'number' || !Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo > 365) {
    throw new SqlUsageError('invalid record age');
  }
  return { type, title: title.trim(), content: content.trim(), daysAgo };
}

/** Validates an untrusted plan (the lab writes it from the scenario files). */
export function parseLabClientPlan(raw: unknown): LabClientVenturePlan[] {
  const ventures = parseLabLivePlan(raw);
  const entries = raw as readonly Record<string, unknown>[];
  return ventures.map((venture, i) => {
    const record = entries[i]?.record ?? [];
    if (!Array.isArray(record) || record.length > MAX_RECORD) throw new SqlUsageError('invalid record');
    return { ...venture, record: record.map(recordItem) };
  });
}

/** Adds the plan's ventures to a seeded database (call inside a system transaction). */
export async function seedLabClientVentures(
  sx: SystemExecutor,
  args: {
    readonly tenantSlug: string;
    readonly plan: readonly LabClientVenturePlan[];
    readonly now?: Date;
  },
): Promise<readonly LabClientVenture[]> {
  const now = (args.now ?? new Date()).getTime();
  const id = (...parts: string[]): string => seedId(args.tenantSlug, 'lab', 'client', ...parts);
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
  const eirProfileId = col.uuid.nullable.decode(coachRow.eir_profile_id, 'eir_profile_id');

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
  const record = args.plan.flatMap((e) =>
    e.record.map((r, i) => {
      const at = new Date(now - r.daysAgo * DAY_MS).toISOString();
      const founderId = id('principal', e.founderKey);
      return {
        id: id('memory', e.key, String(i)),
        tenant_id: tenantId,
        venture_id: id('venture', e.key),
        type: r.type,
        title: r.title,
        content: r.content,
        status: 'confirmed',
        visibility: 'venture',
        confidence: 0.9,
        source_refs: [{ kind: 'manual', id: 'seed', label: 'Synthetic lab data' }],
        origin: 'founder',
        created_by: founderId,
        approved_by: founderId,
        approved_at: at,
        created_at: at,
        updated_at: at,
      };
    }),
  );
  await insertRows(
    sx,
    'memory_objects',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      venture_id: 'uuid',
      type: 'text',
      title: 'text',
      content: 'text',
      status: 'text',
      visibility: 'text',
      confidence: 'numeric',
      source_refs: 'jsonb',
      origin: 'text',
      created_by: 'uuid',
      approved_by: 'uuid',
      approved_at: 'timestamptz',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    record,
  );
  return args.plan.map((e) => ({
    key: e.key,
    ventureId: id('venture', e.key),
    founderId: id('principal', e.founderKey),
  }));
}

/** The founder path's tables (migration 0033); on a database without them there is no path to age. */
const PATH_TABLES: readonly string[] = ['venture_paths', 'path_steps', 'path_criteria'];
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface AgeVenturePathResult {
  readonly tables: number;
  readonly rows: number;
}

/**
 * Moves a venture's path back `days` days with the conversations that made it (lab databases only, inside a system
 * transaction): every date and timestamp column of its path rows, so a step that was due in three days is overdue
 * after a week, one done yesterday was done a week and a day ago, and the intake's deadline keeps its distance.
 */
export async function ageVenturePathForLab(
  sx: SystemExecutor,
  args: { readonly ventureId: string; readonly days: number; readonly tables?: readonly string[] },
): Promise<AgeVenturePathResult> {
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) {
    throw new SqlUsageError('days must be a whole number from 1 to 365');
  }
  let tables = 0;
  let rows = 0;
  for (const table of args.tables ?? PATH_TABLES) {
    if (!IDENTIFIER.test(table)) throw new SqlUsageError('invalid table name');
    const columns = await sx.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = :table ORDER BY ordinal_position`,
      { table: p.text(table) },
    );
    const named = columns.rows.map((r) => ({
      name: col.text.decode(r.column_name, 'column_name'),
      type: col.text.decode(r.data_type, 'data_type'),
    }));
    if (!named.some((c) => c.name === 'venture_id')) continue;
    const shifts = named
      .filter((c) => IDENTIFIER.test(c.name))
      .flatMap((c) => {
        if (c.type === 'date') return [`${c.name} = ${c.name} - :days`];
        if (c.type === 'timestamp with time zone') {
          return [`${c.name} = ${c.name} - make_interval(hours => :days * 24)`];
        }
        return [];
      });
    // The deadline a founder gave in the intake was said then too.
    if (named.some((c) => c.name === 'intake' && c.type === 'jsonb')) {
      shifts.push(
        `intake = CASE WHEN intake #>> '{deadline,on}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           THEN jsonb_set(intake, '{deadline,on}',
                          to_jsonb(to_char(CAST(intake #>> '{deadline,on}' AS date) - :days, 'YYYY-MM-DD')))
           ELSE intake END`,
      );
    }
    // So was the day a direction changed.
    if (named.some((c) => c.name === 'pivots' && c.type === 'jsonb')) {
      shifts.push(
        `pivots = (SELECT coalesce(jsonb_agg(jsonb_set(e.value, '{on}',
                       to_jsonb(to_char(CAST(e.value ->> 'on' AS date) - :days, 'YYYY-MM-DD'))) ORDER BY e.ordinality), '[]'::jsonb)
                   FROM jsonb_array_elements(pivots) WITH ORDINALITY e)`,
      );
    }
    if (shifts.length === 0) continue;
    const moved = await sx.query(`UPDATE ${table} SET ${shifts.join(', ')} WHERE venture_id = :ventureId`, {
      ventureId: p.uuid(args.ventureId),
      days: p.int(args.days),
    });
    tables += 1;
    rows += moved.rowCount;
  }
  return { tables, rows };
}
