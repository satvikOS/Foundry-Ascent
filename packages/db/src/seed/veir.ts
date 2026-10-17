/**
 * Seeds the vEIR personas (Corin's vEIR, Ruth's vEIR), their consents, approved releases, voices, common-pool
 * libraries and lessons, re-points the demo ventures to them, and gives every venture × vEIR pair a notebook
 * (QuietQuad's with a past conversation, its digest and what the vEIR took from it).
 *
 * Idempotent and safe on a database seeded before vEIRs existed:
 * - every row has a deterministic id and is inserted only when absent, so product changes (an edited note, a
 *   suspended persona, a deleted conversation, a corrected notebook) are never overwritten; a library
 *   source's chunks are inserted only together with the source, so an edited or withdrawn note keeps the
 *   chunks it has;
 * - a demo venture is re-pointed only while its active assignment is still the original seeded Foundry Guide
 *   assignment: that assignment is ended and the vEIR assignment created, once. A venture a program lead
 *   re-assigned (to anything) is left alone.
 * - it runs only when migration 0004 is applied (the seed also runs against older schemas in tests).
 * - once migration 0016 is applied, the seeded consents cover `first_person` (founders meet "Corin · vEIR"). The
 *   seeded EIRs are fictional (synthetic) and their consent is the seed's own record, so a database seeded before
 *   0016 has that record extended once, unless it was revoked; a consent anyone recorded in the product is never
 *   touched.
 */
import { col } from '../columns.js';
import { SqlUsageError } from '../errors.js';
import { type SystemExecutor } from '../executor.js';
import { p } from '../params.js';
import { insertRows, insertSourceWithChunks } from './insert.js';
import { SEED_VEIRS, VEIR_ASSIGNMENTS, sectionChunks, type SeedVeir } from './veir-content.js';
import { type SeedEir } from './ventures.js';

export interface SeededVeir {
  readonly eirKey: string;
  readonly personaId: string;
  readonly releaseId: string;
  readonly consentId: string;
  readonly name: string;
}

export interface VeirSeedResult {
  readonly veirs: readonly SeededVeir[];
  /** Active assignment of each re-pointed (or already vEIR-assigned) demo venture, by venture key. */
  readonly assignments: Readonly<Record<string, { readonly id: string; readonly personaId: string }>>;
}

interface VeirSeedContext {
  readonly tenantId: string;
  readonly id: (...parts: string[]) => string;
  readonly principals: Readonly<Record<string, string>>;
  readonly eirs: readonly SeedEir[];
  readonly guidePersonaId: string;
  readonly approver: string | null;
  readonly ventures: readonly { readonly key: string; readonly id: string; readonly assignmentId: string }[];
  readonly memoryIds: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly day: (offsetDays: number) => string;
  readonly now: Date;
}

/** True when consents may cover the first-person presentation (migration 0016). */
export async function hasFirstPersonScope(sx: SystemExecutor): Promise<boolean> {
  const result = await sx.query(
    `SELECT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'consents_asset_types_check'
                       AND pg_get_constraintdef(oid) LIKE '%first_person%') AS ready`,
  );
  return result.rows[0]?.ready === true;
}

/** True when the schema has the vEIR tables and columns (migration 0004). */
export async function hasVeirSchema(sx: SystemExecutor): Promise<boolean> {
  const result = await sx.query(
    `SELECT (to_regclass('public.veir_notebooks') IS NOT NULL
             AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'personas' AND column_name = 'embodiment'))
            AS ready`,
  );
  return result.rows[0]?.ready === true;
}

export async function seedVeirs(sx: SystemExecutor, c: VeirSeedContext): Promise<VeirSeedResult> {
  const veirs: SeededVeir[] = [];
  for (const v of SEED_VEIRS) veirs.push(await seedPersona(sx, c, v));
  const byEir = new Map(veirs.map((v) => [v.eirKey, v] as const));

  const assignments: Record<string, { id: string; personaId: string }> = {};
  for (const venture of c.ventures) {
    const eirKey = VEIR_ASSIGNMENTS[venture.key];
    const veir = eirKey === undefined ? undefined : byEir.get(eirKey);
    if (!eirKey || !veir) continue;
    const assignmentId = c.id('assignment', venture.key, 'veir-v1');
    await repointVenture(sx, c, {
      ventureId: venture.id,
      oldAssignmentId: venture.assignmentId,
      assignmentId,
      personaId: veir.personaId,
      eirProfileId: c.id('eir-profile', eirKey),
    });
    const exists = await sx.query('SELECT status FROM assignments WHERE id = :id', {
      id: p.uuid(assignmentId),
    });
    if (exists.rows.length === 0) continue;
    assignments[venture.key] = { id: assignmentId, personaId: veir.personaId };
    await seedNotebook(sx, c, { ventureKey: venture.key, ventureId: venture.id, veir, assignmentId });
  }
  return { veirs, assignments };
}

async function seedPersona(sx: SystemExecutor, c: VeirSeedContext, v: SeedVeir): Promise<SeededVeir> {
  const eir = c.eirs.find((e) => e.key === v.eirKey);
  const subject = c.principals[v.eirKey];
  if (!eir || !subject) throw new SqlUsageError(`vEIR seed references unknown EIR ${v.eirKey}`);
  const personaId = c.id('persona', 'veir', v.eirKey);
  const releaseId = c.id('persona-release', 'veir', v.eirKey, 'v1');
  const consentId = c.id('consent', v.eirKey, 'veir-v1');
  const nowIso = c.now.toISOString();
  const firstPerson = await hasFirstPersonScope(sx);

  await insertRows(
    sx,
    'consents',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      subject_principal_id: 'uuid',
      asset_types: 'text[]',
      approved_uses: 'text[]',
      audiences: 'text[]',
      evidence_ref: 'text',
    },
    [
      {
        id: consentId,
        tenant_id: c.tenantId,
        subject_principal_id: subject,
        asset_types: firstPerson ? [...v.consent.assetTypes, 'first_person'] : v.consent.assetTypes,
        approved_uses: v.consent.approvedUses,
        audiences: v.consent.audiences,
        evidence_ref: v.consent.evidenceRef,
      },
    ],
  );
  if (firstPerson) {
    // A seeded (fictional) EIR's own seeded record gains the first-person scope once; never a revoked one.
    await sx.query(
      `UPDATE consents c SET asset_types = c.asset_types || ARRAY['first_person']
        WHERE c.id = :id AND c.revoked_at IS NULL AND NOT ('first_person' = ANY (c.asset_types))
          AND EXISTS (SELECT 1 FROM principals pr WHERE pr.id = c.subject_principal_id AND pr.synthetic)`,
      { id: p.uuid(consentId) },
    );
  }
  // Inserted only when absent: the embodiment trigger re-checks the consent of every proposed row, and a
  // consent revoked in the product must not make a later seed run fail.
  await sx.query(
    `INSERT INTO personas (id, tenant_id, eir_profile_id, name, kind, status, consent_id, tagline, embodiment)
     SELECT :id, :tenantId, :eirProfileId, :name, 'eir_persona', 'active', :consentId, :tagline, :embodiment
     WHERE NOT EXISTS (SELECT 1 FROM personas WHERE id = :id)`,
    {
      id: p.uuid(personaId),
      tenantId: p.uuid(c.tenantId),
      eirProfileId: p.uuid(c.id('eir-profile', v.eirKey)),
      name: p.text(v.name),
      consentId: p.uuid(consentId),
      tagline: p.text(v.tagline),
      embodiment: p.json({ provider: 'builtin', voiceId: v.voiceId, portraitKey: null }),
    },
  );
  await insertRows(
    sx,
    'persona_releases',
    {
      id: 'uuid',
      persona_id: 'uuid',
      version: 'integer',
      doctrine: 'jsonb',
      style: 'jsonb',
      disclosure_text: 'text',
      allowed_modes: 'text[]',
      status: 'text',
      created_by: 'uuid',
      approved_by: 'uuid',
      approved_at: 'timestamptz',
    },
    [
      {
        id: releaseId,
        persona_id: personaId,
        version: 1,
        doctrine: v.doctrine,
        style: v.style,
        disclosure_text: v.disclosure,
        allowed_modes: ['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
        status: 'approved',
        created_by: subject,
        approved_by: c.approver ?? subject,
        approved_at: nowIso,
      },
    ],
  );

  // Common pool: the knowledge library (authored notes, cases, FAQs, transcripts), each with its chunks.
  for (const item of v.library) {
    const sourceId = c.id('knowledge-source', 'veir', v.eirKey, item.key);
    await insertSourceWithChunks(sx, {
      sourceColumns: {
        id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        persona_id: 'uuid',
        kind: 'text',
        title: 'text',
        summary: 'text',
        body: 'text',
        owner: 'text',
        classification: 'text',
        created_by: 'uuid',
      },
      source: {
        id: sourceId,
        tenant_id: c.tenantId,
        scope: 'persona',
        persona_id: personaId,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        body: item.body,
        owner: `${eir.displayName} (synthetic EIR)`,
        classification: 'synthetic',
        created_by: subject,
      },
      chunkColumns: {
        source_id: 'uuid',
        tenant_id: 'uuid',
        scope: 'text',
        persona_id: 'uuid',
        ordinal: 'integer',
        heading: 'text',
        content: 'text',
        token_count: 'integer',
      },
      chunks: sectionChunks(item.body).map((chunk, i) => ({
        source_id: sourceId,
        tenant_id: c.tenantId,
        scope: 'persona',
        persona_id: personaId,
        ordinal: i + 1,
        heading: chunk.heading === null ? item.title : `${item.title}: ${chunk.heading}`,
        content: chunk.content,
        token_count: Math.ceil(chunk.content.length / 4),
      })),
    });
  }

  // Common pool: published lessons of this persona.
  await insertRows(
    sx,
    'patterns',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      persona_id: 'uuid',
      origin: 'text',
      title: 'text',
      context: 'text',
      signal: 'text',
      intervention: 'text',
      outcome: 'text',
      limits: 'text',
      source_class: 'text',
      status: 'text',
      owner_id: 'uuid',
    },
    v.lessons.map((l) => ({
      id: c.id('pattern', 'veir', v.eirKey, l.key),
      tenant_id: c.tenantId,
      persona_id: personaId,
      origin: 'authored',
      title: l.title,
      context: l.context,
      signal: l.signal,
      intervention: l.intervention,
      outcome: l.outcome,
      limits: l.limits,
      source_class: 'synthetic',
      status: 'published',
      owner_id: subject,
    })),
  );
  return { eirKey: v.eirKey, personaId, releaseId, consentId, name: v.name };
}

/**
 * Ends the venture's original seeded Foundry Guide assignment and creates its vEIR assignment, only while that
 * original assignment is still the active one and the vEIR assignment was never created.
 */
async function repointVenture(
  sx: SystemExecutor,
  c: VeirSeedContext,
  args: {
    ventureId: string;
    oldAssignmentId: string;
    assignmentId: string;
    personaId: string;
    eirProfileId: string;
  },
): Promise<void> {
  const ended = await sx.query(
    `UPDATE assignments a SET status = 'ended'
     WHERE a.id = :old AND a.venture_id = :ventureId AND a.status = 'active' AND a.persona_id = :guide
       AND NOT EXISTS (SELECT 1 FROM assignments x WHERE x.id = :new)
     RETURNING a.id`,
    {
      old: p.uuid(args.oldAssignmentId),
      ventureId: p.uuid(args.ventureId),
      guide: p.uuid(c.guidePersonaId),
      new: p.uuid(args.assignmentId),
    },
  );
  if (ended.rows.length === 0) return;
  await sx.query(
    `INSERT INTO assignments (id, tenant_id, venture_id, persona_id, eir_profile_id, created_by)
     VALUES (:id, :tenantId, :ventureId, :personaId, :eirProfileId, :createdBy)`,
    {
      id: p.uuid(args.assignmentId),
      tenantId: p.uuid(c.tenantId),
      ventureId: p.uuid(args.ventureId),
      personaId: p.uuid(args.personaId),
      eirProfileId: p.uuid(args.eirProfileId),
      createdBy: p.nullable.uuid(c.approver),
    },
  );
}

function at(day: string, hour: number, minute: number): string {
  return `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

async function seedNotebook(
  sx: SystemExecutor,
  c: VeirSeedContext,
  args: { ventureKey: string; ventureId: string; veir: SeededVeir; assignmentId: string },
): Promise<void> {
  const notebookId = c.id('notebook', args.ventureKey, args.veir.eirKey);
  if (args.ventureKey !== 'quietquad') {
    await insertRows(
      sx,
      'veir_notebooks',
      { id: 'uuid', tenant_id: 'uuid', venture_id: 'uuid', persona_id: 'uuid' },
      [
        {
          id: notebookId,
          tenant_id: c.tenantId,
          venture_id: args.ventureId,
          persona_id: args.veir.personaId,
        },
      ],
    );
    return;
  }
  const sessionId = await seedQuietQuadConversation(sx, c, args);
  const day = c.day;
  const noted = at(day(-6), 15, 26);
  const entry = (id: string, text: string): Record<string, unknown> => ({
    id,
    text,
    sourceSessionId: sessionId,
    createdAt: noted,
  });
  const content = {
    summary:
      'Maya and Devin are testing whether exam-week seat scarcity hurts enough for students to check a live map ' +
      'instead of a group chat. The hand-counted map reached 19% repeat use against their 25% bar, with a clear ' +
      'spike before a midterm, so they narrowed the first version to the two weeks before exams. The open risk is ' +
      'data: library or facilities counts may need an approval that outlasts the pilot window.',
    founderProfile: [
      entry('fp-numbers-first', 'Maya likes to see the numbers first, then the recommendation.'),
      entry(
        'fp-short-answers',
        'Prefers short, direct answers with one next step rather than a list of options.',
      ),
      entry(
        'fp-build-first',
        'Tends to plan the build before the test; responds well to being asked for the kill criterion up front.',
      ),
    ],
    commitments: [
      {
        id: 'c-staff-interviews',
        text: 'Interview five library staff about how they measure occupancy today',
        due: day(5),
        status: 'open',
        sourceSessionId: sessionId,
        createdAt: noted,
      },
      {
        id: 'c-facilities-email',
        text: 'Email facilities about sharing anonymised door-counter totals',
        due: day(-3),
        status: 'open',
        sourceSessionId: sessionId,
        createdAt: noted,
      },
      {
        id: 'c-kill-criterion',
        text: 'Write the exam-week rerun prediction and kill criterion before launching',
        due: day(-4),
        status: 'done',
        sourceSessionId: sessionId,
        createdAt: noted,
      },
    ],
    openQuestions: [
      entry(
        'q-group-chat',
        'Would students open a map during exam week instead of posting in their group chat?',
      ),
      entry('q-counts', 'Can either library share live or hourly occupancy counts, and who approves it?'),
    ],
    lastAdvice: [
      entry(
        'a-rerun',
        'Rerun the seat map only in the two weeks before finals, with notifications, and stop if repeat use is under 15%.',
      ),
      entry(
        'a-workaround',
        'Treat the group chat as the competitor: the map has to be faster than sending a message.',
      ),
    ],
    nextOpener:
      'Last time you planned five library-staff interviews about occupancy data. How many have you done, and what ' +
      'did they say about sharing counts?',
    // Both were drawn from the past conversation: deleting it clears them.
    summarySources: [sessionId],
    nextOpenerSource: sessionId,
  };
  await insertRows(
    sx,
    'veir_notebooks',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      venture_id: 'uuid',
      persona_id: 'uuid',
      content: 'jsonb',
      version: 'integer',
      last_edited_by: 'text',
      updated_at: 'timestamptz',
    },
    [
      {
        id: notebookId,
        tenant_id: c.tenantId,
        venture_id: args.ventureId,
        persona_id: args.veir.personaId,
        content,
        version: 1,
        last_edited_by: 'veir',
        updated_at: noted,
      },
    ],
  );
}

/**
 * A past conversation between QuietQuad's founder and Corin's vEIR (two validated turns citing the venture's
 * own memory, and the digest distillation wrote), so the demo starts with continuity. Returns its id.
 */
async function seedQuietQuadConversation(
  sx: SystemExecutor,
  c: VeirSeedContext,
  args: { ventureId: string; veir: SeededVeir; assignmentId: string },
): Promise<string> {
  const sessionId = c.id('session', 'quietquad', 'veir-intro');
  const maya = c.principals.maya;
  const memory = c.memoryIds.quietquad ?? {};
  const seatMap = memory['x-seat-map'];
  const dataRisk = memory['r-data-access'];
  if (!maya || !seatMap || !dataRisk)
    throw new SqlUsageError('QuietQuad seed data missing for the vEIR conversation');
  const day = c.day;
  const started = at(day(-6), 15, 2);
  const firstAt = at(day(-6), 15, 3);
  const secondAt = at(day(-6), 15, 14);
  const ended = at(day(-6), 15, 26);

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
        tenant_id: c.tenantId,
        venture_id: args.ventureId,
        assignment_id: args.assignmentId,
        persona_release_id: args.veir.releaseId,
        started_by: maya,
        mode: 'diagnose',
        privacy: 'standard',
        goal: 'Decide whether exam-week demand justifies the two-library pilot',
        status: 'ended',
        policy_version: 'seed',
        started_at: started,
        ended_at: ended,
        title: 'Is exam-week demand strong enough for a pilot?',
        last_activity_at: ended,
        digest: {
          summary:
            'Maya reviewed the hourly seat-map test: 19% repeat use against a 25% bar, with usage spiking before a ' +
            "midterm. Corin's vEIR suggested rerunning the map only in the two weeks before finals with a kill " +
            'criterion written in advance (under 15% repeat use means stop), and running the library-staff and ' +
            'facilities conversations about occupancy data in parallel instead of waiting for them.',
          topics: ['Seat-map test results', 'Exam-week focus', 'Occupancy data access'],
          commitments: [
            { text: 'Interview five library staff about occupancy data', due: day(5) },
            { text: 'Email facilities about anonymised door-counter totals', due: day(-3) },
            { text: 'Write the exam-week rerun prediction and kill criterion', due: day(-4) },
          ],
          openQuestions: [
            'Will students open a map instead of posting in their group chat?',
            'Which library has the longest seat queue during finals?',
          ],
          generatedAt: ended,
        },
        distilled_at: ended,
        distill_version: 2,
      },
    ],
  );

  const validator = {
    unknownEvidenceIdsRemoved: 0,
    factsDowngraded: 0,
    groundingCoverage: 1,
    narrowed: false,
    escalationForced: false,
    identityViolation: false,
    crossVentureViolation: false,
    riskCategories: [],
    notes: [],
  };
  const noEscalation = {
    required: false,
    category: null,
    priority: null,
    reason: null,
    requested_role: null,
  };
  const turns = [
    {
      key: '1',
      at: firstAt,
      completed: at(day(-6), 15, 4),
      text:
        'Our hourly seat map got 38 repeat visitors out of 200 in a normal week, and most of them came the two ' +
        'days before a midterm. Is that enough to justify the two-library pilot?',
      evidence: { key: 'E1', refId: seatMap, title: 'Hand-counted seat map posted hourly for one week' },
      response: {
        mode: 'diagnose',
        answer:
          'Not yet, and that is a useful answer. 38 of 200 is 19%, below the 25% bar you set before the test [E1], ' +
          'and the repeat visits clustered right before a midterm. The problem looks real at the peak and weak the ' +
          'rest of the time.\n\nSo the question is no longer "is there demand?" but "is exam-week demand enough to ' +
          'build for?". Rerun the map only in the two weeks before finals, with a notification when seats open, ' +
          'and write the kill criterion now: under 15% repeat use and you stop.\n\nWhat would convince you that ' +
          'students will open a map instead of posting in their group chat?',
        claims: [
          {
            text: '38 of 200 recipients (19%) returned on two or more days, below the 25% threshold.',
            kind: 'fact',
            evidence_ids: ['E1'],
          },
          {
            text: 'Demand appears concentrated in the days before exams.',
            kind: 'inference',
            evidence_ids: ['E1'],
          },
        ],
        uncertainty: [{ item: 'Whether one ordinary week is representative of the term', level: 'medium' }],
        challenge: 'The group-chat workaround may already be fast enough during exam week.',
        next_actions: [
          {
            owner: 'Maya Okafor-Lindqvist',
            action: 'Write the exam-week rerun prediction and kill criterion',
            target_date: day(-4),
          },
        ],
        escalation: noEscalation,
        memory_candidates: [],
        follow_up_questions: [
          'How will you measure repeat use during finals?',
          'Who sends the notification when seats open?',
        ],
        rehearsal: null,
      },
    },
    {
      key: '2',
      at: secondAt,
      completed: at(day(-6), 15, 15),
      text:
        'Okay. Devin thinks library staff might already count occupancy. Should we wait for that data before the ' +
        'rerun?',
      evidence: { key: 'E1', refId: dataRisk, title: 'Occupancy data may need facilities approval' },
      response: {
        mode: 'diagnose',
        answer:
          'Do not wait; run both in parallel. Staff counts would make the map more accurate, but the rerun tests ' +
          'whether students use a map at all, and that does not need perfect data. Approval for occupancy data may ' +
          'also take longer than your pilot window [E1].\n\nThis week, ask five library staff how they measure ' +
          'occupancy today and whether any counts can be shared, and email facilities about anonymised ' +
          'door-counter totals. If approval looks slow, start with student check-ins.\n\nWhich of the two ' +
          'libraries has the longest queue for seats in finals week?',
        claims: [
          {
            text: 'Occupancy data may need an approval that takes longer than the pilot window.',
            kind: 'fact',
            evidence_ids: ['E1'],
          },
          {
            text: 'The rerun can test student behaviour without staff counts.',
            kind: 'recommendation',
            evidence_ids: [],
          },
        ],
        uncertainty: [{ item: 'How long a data-sharing approval takes', level: 'high' }],
        challenge: null,
        next_actions: [
          {
            owner: 'Devin Ashcombe',
            action: 'Interview five library staff about occupancy data',
            target_date: day(5),
          },
          {
            owner: 'Maya Okafor-Lindqvist',
            action: 'Email facilities about anonymised door-counter totals',
            target_date: day(-3),
          },
        ],
        escalation: noEscalation,
        memory_candidates: [],
        follow_up_questions: ['Which library has the longest seat queue in finals week?'],
        rehearsal: null,
      },
    },
  ];
  await insertRows(
    sx,
    'turns',
    {
      id: 'uuid',
      tenant_id: 'uuid',
      venture_id: 'uuid',
      session_id: 'uuid',
      ordinal: 'integer',
      author_id: 'uuid',
      mode: 'text',
      founder_text: 'text',
      response: 'jsonb',
      status: 'text',
      risk_label: 'text',
      validator_results: 'jsonb',
      model_id: 'text',
      created_at: 'timestamptz',
      completed_at: 'timestamptz',
    },
    turns.map((t, i) => ({
      id: c.id('turn', 'quietquad', 'veir-intro', t.key),
      tenant_id: c.tenantId,
      venture_id: args.ventureId,
      session_id: sessionId,
      ordinal: i + 1,
      author_id: maya,
      mode: 'diagnose',
      founder_text: t.text,
      response: t.response,
      status: 'completed',
      risk_label: 'none',
      validator_results: validator,
      model_id: 'seed',
      created_at: t.at,
      completed_at: t.completed,
    })),
  );
  await insertRows(
    sx,
    'turn_evidence',
    {
      turn_id: 'uuid',
      evidence_key: 'text',
      venture_id: 'uuid',
      kind: 'text',
      ref_id: 'uuid',
      score: 'numeric',
      title: 'text',
    },
    turns.map((t) => ({
      turn_id: c.id('turn', 'quietquad', 'veir-intro', t.key),
      evidence_key: t.evidence.key,
      venture_id: args.ventureId,
      kind: 'memory',
      ref_id: t.evidence.refId,
      score: 0.82,
      title: t.evidence.title,
    })),
  );
  // The conversation exists (inserted now or earlier): read its id back so a deleted one stays deleted.
  const row = await sx.query('SELECT id FROM coaching_sessions WHERE id = :id', { id: p.uuid(sessionId) });
  const first = row.rows[0];
  return first ? col.uuid.decode(first.id, 'id') : sessionId;
}
