/**
 * Conversation lab only (docs/runbooks/conversation-lab.md, suite `agenda`): two synthetic ventures whose vEIR
 * notebook holds ONE dominant open commitment dated in the past, the shape that made the vEIR steer every call
 * back to it (owner's production calls, 2026-10-16…20). One is talked to in typed conversations, one on calls, so
 * each channel meets the same starting state. Each has a synthetic founder, QuietQuad's vEIR as its coach, an
 * earlier conversation (ended 12 days ago, distilled, with a digest) and a notebook that opens on that commitment.
 * Every id is deterministic; a second run changes nothing. The lab adds them to its own freshly reset database.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { seedId } from './ids.js';
import { insertRows } from './insert.js';

const DAY_MS = 86_400_000;

/** The commitment every conversation of the suite meets: open, and due nine days ago. */
export const AGENDA_COMMITMENT =
  'Book the regulatory and reimbursement advisor session and prepare three questions for it';

/** Invented names only (ADR-006). */
export const LAB_AGENDA_VENTURES = [
  {
    key: 'pelora',
    name: 'Pelora',
    founderKey: 'lab-agenda-rhea',
    founder: 'Rhea Castellan',
    channel: 'chat',
  },
  { key: 'quillon', name: 'Quillon', founderKey: 'lab-agenda-idris', founder: 'Idris Vane', channel: 'call' },
] as const;

const ONE_LINER =
  'A smart compression sleeve that tracks arm swelling for lymphoedema patients between clinic visits.';
const GOAL = 'Work out the regulatory and reimbursement route before building the next prototype.';

export interface LabAgendaVenture {
  readonly key: string;
  readonly name: string;
  readonly founder: string;
  readonly channel: 'chat' | 'call';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Adds the suite's ventures to a seeded database (call inside a system transaction). */
export async function seedLabAgendaVentures(
  sx: SystemExecutor,
  args: { readonly tenantSlug: string; readonly now?: Date },
): Promise<readonly LabAgendaVenture[]> {
  const now = (args.now ?? new Date()).getTime();
  const id = (...parts: string[]): string => seedId(args.tenantSlug, 'lab', ...parts);
  const tenantRow = (
    await sx.query('SELECT id FROM tenants WHERE slug = :slug', { slug: p.text(args.tenantSlug) })
  ).rows[0];
  if (!tenantRow) throw new SqlUsageError('the home tenant is not seeded');
  const tenantId = col.uuid.decode(tenantRow.id, 'id');
  const coachRow = (
    await sx.query(
      `SELECT a.persona_id, a.eir_profile_id,
              (SELECT r.id FROM persona_releases r WHERE r.persona_id = a.persona_id AND r.status = 'approved'
               ORDER BY r.version DESC LIMIT 1) AS release_id
       FROM assignments a WHERE a.venture_id = :ventureId AND a.status = 'active'
       ORDER BY a.created_at DESC LIMIT 1`,
      { ventureId: p.uuid(seedId(args.tenantSlug, 'venture', 'quietquad')) },
    )
  ).rows[0];
  if (!coachRow || coachRow.release_id === null) {
    throw new SqlUsageError('the seeded demo venture has no active vEIR to share');
  }
  const personaId = col.uuid.decode(coachRow.persona_id, 'persona_id');
  const releaseId = col.uuid.decode(coachRow.release_id, 'release_id');
  const eirProfileId =
    coachRow.eir_profile_id === null ? null : col.uuid.decode(coachRow.eir_profile_id, 'eir_profile_id');

  const started = iso(now - 12 * DAY_MS);
  const ended = iso(now - 12 * DAY_MS + 25 * 60_000);
  const due = iso(now - 9 * DAY_MS).slice(0, 10);
  const out: LabAgendaVenture[] = [];
  for (const v of LAB_AGENDA_VENTURES) {
    const ventureId = id('agenda', 'venture', v.key);
    const founderId = id('principal', v.founderKey);
    const assignmentId = id('agenda', 'assignment', v.key);
    const sessionId = id('agenda', 'session', v.key);
    await insertRows(
      sx,
      'principals',
      { id: 'uuid', tenant_id: 'uuid', display_name: 'text', title: 'text', synthetic: 'boolean' },
      [{ id: founderId, tenant_id: tenantId, display_name: v.founder, title: 'Founder', synthetic: true }],
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
          one_liner: ONE_LINER,
          stage: 'business_model',
          domain: 'biomedical',
          cohort: 'Lab',
          classification: 'synthetic',
          current_goal: GOAL,
        },
      ],
    );
    await insertRows(
      sx,
      'venture_memberships',
      { id: 'uuid', venture_id: 'uuid', principal_id: 'uuid', role: 'text' },
      [
        {
          id: id('agenda', 'membership', v.key),
          venture_id: ventureId,
          principal_id: founderId,
          role: 'founder',
        },
      ],
    );
    await insertRows(
      sx,
      'assignments',
      { id: 'uuid', tenant_id: 'uuid', venture_id: 'uuid', persona_id: 'uuid', eir_profile_id: 'uuid' },
      [
        {
          id: assignmentId,
          tenant_id: tenantId,
          venture_id: ventureId,
          persona_id: personaId,
          eir_profile_id: eirProfileId,
        },
      ],
    );
    const first = v.founder.split(' ')[0] ?? v.founder;
    await insertRows(
      sx,
      'coaching_sessions',
      {
        id: 'uuid',
        tenant_id: 'uuid',
        venture_id: 'uuid',
        assignment_id: 'uuid',
        persona_release_id: 'uuid',
        started_by: 'uuid',
        mode: 'text',
        privacy: 'text',
        goal: 'text',
        status: 'text',
        policy_version: 'text',
        started_at: 'timestamptz',
        ended_at: 'timestamptz',
        title: 'text',
        last_activity_at: 'timestamptz',
        digest: 'jsonb',
        distilled_at: 'timestamptz',
        distill_version: 'integer',
      },
      [
        {
          id: sessionId,
          tenant_id: tenantId,
          venture_id: ventureId,
          assignment_id: assignmentId,
          persona_release_id: releaseId,
          started_by: founderId,
          mode: 'diagnose',
          privacy: 'standard',
          goal: GOAL,
          status: 'ended',
          policy_version: 'seed',
          started_at: started,
          ended_at: ended,
          title: 'Is the sleeve a medical device?',
          last_activity_at: ended,
          digest: {
            summary:
              `${first} asked whether the sleeve counts as a medical device and how clinics would pay for it. ` +
              'The next step agreed was a session with the regulatory and reimbursement advisor, with three ' +
              'questions prepared in advance.',
            topics: ['Device classification', 'Reimbursement'],
            commitments: [{ text: AGENDA_COMMITMENT, due }],
            openQuestions: ['Is the sleeve a regulated device, and in which class?'],
            generatedAt: ended,
          },
          distilled_at: ended,
          distill_version: 2,
        },
      ],
    );
    const entry = (key: string, text: string) => ({
      id: key,
      text,
      sourceSessionId: sessionId,
      createdAt: ended,
    });
    await insertRows(
      sx,
      'veir_notebooks',
      {
        id: 'uuid',
        tenant_id: 'uuid',
        venture_id: 'uuid',
        persona_id: 'uuid',
        content: 'jsonb',
        last_edited_by: 'text',
        updated_at: 'timestamptz',
      },
      [
        {
          id: id('agenda', 'notebook', v.key),
          tenant_id: tenantId,
          venture_id: ventureId,
          persona_id: personaId,
          content: {
            summary:
              `${first} is building a compression sleeve that tracks swelling between clinic visits and needs to ` +
              'know whether it is a medical device and how clinics would be paid before the next prototype.',
            founderProfile: [entry('fp-direct', `${first} likes direct answers and concrete next steps.`)],
            commitments: [
              {
                id: 'c-advisor-session',
                text: AGENDA_COMMITMENT,
                due,
                status: 'open',
                sourceSessionId: sessionId,
                createdAt: ended,
              },
            ],
            openQuestions: [entry('q-device', 'Is the sleeve a regulated device, and in which class?')],
            lastAdvice: [
              entry(
                'a-advisor',
                'Book the advisor session before building anything else, and go in with three questions.',
              ),
            ],
            nextOpener: 'Did you manage to book the advisor session and write your three questions?',
            nextTopic: 'the advisor session and your three questions',
            nextOpenerSource: sessionId,
            summarySources: [sessionId],
          },
          last_edited_by: 'veir',
          updated_at: ended,
        },
      ],
    );
    out.push({ key: v.key, name: v.name, founder: v.founder, channel: v.channel });
  }
  return out;
}
