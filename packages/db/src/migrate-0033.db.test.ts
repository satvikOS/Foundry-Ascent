/**
 * Migration 0033 (the founder path) on a database that already holds ventures, conversations and turns: it applies
 * cleanly as the non-superuser owner and re-runs without changes; a venture's path is read by its founders, team and
 * assigned EIR and written by founders and team alone, never across ventures or tenants; a step's change needs the
 * version that was read; a step given twice is one row; a program lead reads the path's shape and no words; and what a
 * conversation left in the path, and a turn's guidance, go with the conversation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.js';
import { DbError } from './errors.js';
import { MIGRATIONS, migrate } from './migrate.js';
import { p } from './params.js';
import { assignmentsRepo, pathRepo, readTogether, sessionsRepo, turnsRepo } from './repositories/index.js';
import { seedDatabase, type SeedConfig, type SeededVenture, type SeedResult } from './seed/seed.js';
import { splitStatements } from './sql-lexer.js';
import { createTestDatabase, makeContext, type TestDatabase } from './testing/test-database.js';

const PATH = MIGRATIONS.find((m) => m.version === '0033_founder_path');
/** The path's later migration: it replaces 0033's erasure of a deleted conversation's words. */
const IDEA = MIGRATIONS.find((m) => m.version === '0035_path_idea');
const BEFORE = MIGRATIONS.filter((m) => m.version < '0033');
const CONFIG: SeedConfig = { homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' }, owner: null };
const STEP = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000001';

let t: TestDatabase;
let seed: SeedResult;
let mine: SeededVenture;
let theirs: SeededVenture;
let coached: SeededVenture;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}
async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof DbError) return err.sqlState;
    throw err;
  }
}
const ctx = (key: string) => makeContext(must(seed.principals[key]), seed.tenantId);
const lead = () => makeContext(must(seed.programLeadId), seed.tenantId);
const venture = (key: string): SeededVenture => must(seed.ventures.find((v) => v.key === key));

const step = (over: Partial<pathRepo.PathStepRecord> = {}): pathRepo.InsertStepInput['step'] => ({
  id: STEP,
  playId: 'ten-interviews',
  criterionId: 'discovery-interviews',
  title: 'Interview ten people',
  items: [{ do: 'List twenty people', how: 'Names.', minutes: 20, done: false }],
  doneWhen: 'Ten notes.',
  dueOn: '2026-12-01',
  status: 'now',
  origin: 'path',
  template: { title: 'Script', body: 'Tell me about the last time…' },
  citations: [{ sourceId: 'mom-test', locator: null, title: 'The Mom Test', authors: 'R. F.', url: null }],
  ...over,
});
const reads = (who: ReturnType<typeof ctx>, v: SeededVenture) =>
  t.db.withContext(who, async (tx) =>
    pathRepo.pathReadsFrom(await readTogether(tx, pathRepo.pathParts(v.id))),
  );

async function fingerprint(db: Db): Promise<string> {
  return db.system(async (sx) => {
    const parts: unknown[] = [];
    for (const sql of [
      `SELECT p.proname, md5(p.prosrc) AS src, coalesce(array_to_string(p.proacl, ','), '') AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' ORDER BY 1`,
      `SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
         WHERE tablename IN ('venture_paths', 'path_steps', 'path_criteria') ORDER BY 1, 2`,
      `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_name IN ('venture_paths', 'path_steps', 'path_criteria', 'turns') ORDER BY 1, 2`,
      `SELECT tgname, tgrelid::regclass::text AS tbl FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`,
    ])
      parts.push((await sx.query(sql)).rows);
    return JSON.stringify(parts);
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ migrate: false });
  await migrate(t.db, { migrations: BEFORE });
  seed = await seedDatabase(t.db, CONFIG);
  mine = venture('quietquad');
  theirs = venture('benchtally');
  coached = venture('solesignal');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('migration 0033_founder_path', () => {
  it('applies on top of the earlier migrations with existing data, as the non-superuser owner', async () => {
    const report = await migrate(t.db);
    expect(report.applied[0]).toBe('0033_founder_path');
    expect(PATH && splitStatements(PATH.sql).length).toBeGreaterThanOrEqual(30);
  });

  it('reads an existing venture with empty path tables, its shared memory and nothing private', async () => {
    const r = await reads(ctx('maya'), mine);
    expect([r.path, r.steps, r.criteria]).toEqual([null, [], []]);
    expect(r.memory.length).toBeGreaterThan(3);
    await t.db.system((sx) =>
      sx.query(
        `INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, status, visibility, origin, created_by,
                                     approved_by, approved_at)
         SELECT m.tenant_id, m.venture_id, 'fact', 'A private fact', 'x', 'confirmed', 'founder_private', 'founder',
                m.created_by, m.created_by, now() FROM memory_objects m WHERE m.venture_id = :v LIMIT 1`,
        { v: p.uuid(mine.id) },
      ),
    );
    expect((await reads(ctx('maya'), mine)).memory.some((m) => m.title === 'A private fact')).toBe(false);
  });

  it('founders and team write it; the assigned EIR only reads it; others see nothing', async () => {
    const maya = ctx('maya');
    await t.db.withContext(maya, async (tx) => {
      await pathRepo.ensurePath(tx, {
        tenantId: seed.tenantId,
        ventureId: mine.id,
        stage: 'discovery',
        playbookVersion: 'v1',
      });
      expect(
        await pathRepo.insertStep(tx, {
          tenantId: seed.tenantId,
          ventureId: mine.id,
          step: step(),
          givenTo: maya.principalId,
        }),
      ).toBe(true);
      // Given at once by two turns: one row.
      expect(
        await pathRepo.insertStep(tx, {
          tenantId: seed.tenantId,
          ventureId: mine.id,
          step: step({ title: 'Another title' }),
          givenTo: maya.principalId,
        }),
      ).toBe(false);
      await pathRepo.setCriterion(tx, {
        tenantId: seed.tenantId,
        ventureId: mine.id,
        criterionId: 'idea-page',
        status: 'claimed',
        evidence: 'It is on one page',
        stepId: null,
        sourceSessionId: null,
        principalId: maya.principalId,
      });
    });
    const asTeam = await reads(ctx('devin'), mine);
    expect(asTeam.path).toMatchObject({ stage: 'discovery', version: 1, intake: null });
    expect(asTeam.steps[0]).toMatchObject({
      id: STEP,
      title: 'Interview ten people',
      dueOn: '2026-12-01',
      status: 'now',
      version: 1,
    });
    expect(asTeam.steps[0]?.template?.title).toBe('Script');
    expect(asTeam.criteria).toMatchObject([{ criterionId: 'idea-page', status: 'claimed' }]);

    const assigned = await t.db.withContext(maya, (tx) =>
      assignmentsRepo.resolveActiveAssignment(tx, mine.id),
    );
    const eir = must(seed.eirs.find((e) => e.profileId === assigned?.eir?.id));
    const eirCtx = makeContext(eir.principalId, seed.tenantId);
    expect((await reads(eirCtx, mine)).steps).toHaveLength(1);
    expect(
      await sqlState(
        t.db.withContext(eirCtx, (tx) =>
          pathRepo.insertStep(tx, {
            tenantId: seed.tenantId,
            ventureId: mine.id,
            step: step({ id: 'aaaaaaaa-1111-4111-8111-111111111112' }),
            givenTo: null,
          }),
        ),
      ),
    ).toBe('42501');
    expect(
      await t.db.withContext(eirCtx, (tx) =>
        pathRepo.updateStep(tx, {
          id: STEP,
          expectedVersion: 1,
          change: { status: 'done', completedBy: eir.principalId },
        }),
      ),
    ).toBeNull();

    // Another venture's founder, an advisor, a program lead, the founder in another tenant: nothing.
    for (const who of [ctx('priya'), ctx('graham'), lead(), makeContext(maya.principalId, OTHER_TENANT)]) {
      const r = await reads(who, mine);
      expect([r.path, r.steps.length, r.criteria.length, r.memory.length]).toEqual([null, 0, 0, 0]);
    }
  });

  it('a founder never writes another venture’s path, nor in another tenant’s name', async () => {
    const maya = ctx('maya');
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          pathRepo.ensurePath(tx, {
            tenantId: seed.tenantId,
            ventureId: theirs.id,
            stage: 'idea',
            playbookVersion: 'v1',
          }),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          pathRepo.insertStep(tx, {
            tenantId: OTHER_TENANT,
            ventureId: mine.id,
            step: step({ id: 'aaaaaaaa-1111-4111-8111-111111111113' }),
            givenTo: null,
          }),
        ),
      ),
    ).toBe('42501');
    // Nor gives a step in a teammate's name, nor moves a step to another venture.
    expect(
      await sqlState(
        t.db.withContext(maya, (tx) =>
          pathRepo.insertStep(tx, {
            tenantId: seed.tenantId,
            ventureId: mine.id,
            step: step({ id: 'aaaaaaaa-1111-4111-8111-111111111114' }),
            givenTo: must(seed.principals.devin),
          }),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query('UPDATE path_steps SET venture_id = :v WHERE id = :id', {
            v: p.uuid(theirs.id),
            id: p.uuid(STEP),
          }),
        ),
      ),
    ).toBe('55000');
    const deleted = await sqlState(
      t.db.withContext(maya, (tx) => tx.query('DELETE FROM path_steps WHERE id = :id', { id: p.uuid(STEP) })),
    );
    expect(deleted).toBe('42501');
  });

  it('a change needs the version that was read; the stage only moves forward', async () => {
    const maya = ctx('maya');
    const order = [
      'idea',
      'discovery',
      'validation',
      'business_model',
      'commercialization',
      'growth',
      'transition',
    ] as const;
    const first = await t.db.withContext(maya, (tx) =>
      pathRepo.updateStep(tx, {
        id: STEP,
        expectedVersion: 1,
        change: { items: step().items.map((i) => ({ ...i, done: true })) },
      }),
    );
    expect(first).toMatchObject({ version: 2, items: [{ done: true }] });
    expect(
      await t.db.withContext(ctx('devin'), (tx) =>
        pathRepo.updateStep(tx, { id: STEP, expectedVersion: 1, change: { dueOn: '2026-12-09' } }),
      ),
    ).toBeNull();
    const advance = (stage: (typeof order)[number]) =>
      t.db.withContext(maya, (tx) =>
        pathRepo.advanceStage(tx, { ventureId: mine.id, stage, order, playbookVersion: 'v1' }),
      );
    expect([await advance('idea'), await advance('discovery'), await advance('validation')]).toEqual([
      false,
      false,
      true,
    ]);
    const save = (expectedVersion: number) =>
      t.db.withContext(maya, (tx) =>
        pathRepo.saveIntake(tx, {
          tenantId: seed.tenantId,
          ventureId: mine.id,
          principalId: maya.principalId,
          stage: 'validation',
          playbookVersion: 'v1',
          intake: {
            idea: 'Seats',
            customer: '',
            studies: '',
            experience: 'first_time',
            hoursPerWeek: 5,
            deadline: null,
            doneSoFar: '',
            block: '',
          },
          expectedVersion,
        }),
      );
    expect(await save(1)).toBeNull();
    expect(await save(2)).toMatchObject({ version: 3, intake: { idea: 'Seats' }, stage: 'validation' });
    // A venture without a path yet: the first save (as version 1 was read) makes it; a second on the same read does not.
    const priya = ctx('priya');
    const create = () =>
      t.db.withContext(priya, (tx) =>
        pathRepo.saveIntake(tx, {
          tenantId: seed.tenantId,
          ventureId: theirs.id,
          principalId: priya.principalId,
          stage: 'validation',
          playbookVersion: 'v1',
          intake: {
            idea: 'A',
            customer: '',
            studies: '',
            experience: null,
            hoursPerWeek: null,
            deadline: null,
            doneSoFar: '',
            block: '',
          },
          expectedVersion: 1,
        }),
      );
    expect(await create()).toMatchObject({ version: 2 });
    expect(await create()).toBeNull();
  });

  it('a claim, or progress, never lowers what is met', async () => {
    const maya = ctx('maya');
    const set = (status: 'met' | 'claimed' | 'open', evidence: string | null = status) =>
      t.db.withContext(maya, (tx) =>
        pathRepo.setCriterion(tx, {
          tenantId: seed.tenantId,
          ventureId: mine.id,
          criterionId: 'idea-risk',
          status,
          evidence,
          stepId: null,
          sourceSessionId: null,
          principalId: maya.principalId,
        }),
      );
    const now = async () =>
      (await reads(maya, mine)).criteria.find((c) => c.criterionId === 'idea-risk')?.status;
    await set('met');
    await set('claimed');
    expect(await now()).toBe('met');
    // Progress towards it ("8 of 10: …") never lowers it; taking it back does.
    await set('open', '8 of 10: eight talks');
    expect(await now()).toBe('met');
    await set('open', null);
    expect(await now()).toBe('open');
  });

  it('a program lead reads the shape, never a word of the founder’s; nobody else reads it', async () => {
    const maya = ctx('maya');
    await t.db.withContext(maya, async (tx) => {
      const done = await pathRepo.updateStep(tx, {
        id: STEP,
        expectedVersion: 2,
        change: { status: 'done', evidence: 'SECRET WORDS', completedBy: maya.principalId },
      });
      expect(done).toMatchObject({ status: 'done', evidence: 'SECRET WORDS' });
      expect(done?.completedAt).not.toBeNull();
      await pathRepo.insertStep(tx, {
        tenantId: seed.tenantId,
        ventureId: mine.id,
        step: step({
          id: 'aaaaaaaa-1111-4111-8111-111111111115',
          origin: 'founder',
          title: 'SECRET TITLE',
          status: 'next',
        }),
        givenTo: maya.principalId,
      });
    });
    const overview = await t.db.withContext(lead(), (tx) => pathRepo.pathOverview(tx, mine.id));
    expect(overview).toMatchObject({ stage: 'validation', steps: [{ status: 'done' }, { status: 'next' }] });
    expect(JSON.stringify(overview)).not.toContain('SECRET');
    expect(JSON.stringify(overview)).not.toContain('Seats');
    for (const who of [maya, ctx('priya'), ctx('eir-corin')])
      expect(await sqlState(t.db.withContext(who, (tx) => pathRepo.pathOverview(tx, mine.id)))).toBe('42501');
    expect(
      await t.db.withContext(makeContext(must(seed.programLeadId), seed.tenantId), (tx) =>
        pathRepo.pathOverview(tx, '00000000-0000-4000-8000-00000000dead'),
      ),
    ).toBeNull();
  });

  it('a deleted conversation takes the words it left in the path and its turns’ guidance; what was done stays done', async () => {
    const amara = ctx('amara');
    const sessionId = await t.db.withContext(amara, async (tx) => {
      const assignment = must(await assignmentsRepo.resolveActiveAssignment(tx, coached.id));
      const session = await sessionsRepo.createSession(tx, {
        tenantId: seed.tenantId,
        ventureId: coached.id,
        assignmentId: assignment.assignment.id,
        personaReleaseId: must(assignment.release).id,
        startedBy: amara.principalId,
        mode: 'coach',
        privacy: 'standard',
        goal: null,
        policyVersion: 'test',
        title: null,
        opener: null,
        openerSourceSessionId: null,
        openerByPerson: false,
      });
      const turn = await turnsRepo.createTurn(tx, {
        tenantId: seed.tenantId,
        ventureId: coached.id,
        sessionId: session.id,
        authorId: amara.principalId,
        mode: 'coach',
        founderText: 'I talked to ten people',
      });
      const finished = await turnsRepo.finishTurn(tx, {
        turnId: turn.id,
        status: 'completed',
        guidance: {
          intent: null,
          playId: null,
          stage: 'idea',
          stageTitle: 'Idea',
          stageNumber: 1,
          stageCount: 7,
          step: null,
          then: [],
          referral: null,
          citations: [],
        },
      });
      expect(finished?.guidance).toMatchObject({ stage: 'idea' });
      await pathRepo.insertStep(tx, {
        tenantId: seed.tenantId,
        ventureId: coached.id,
        step: step({ id: 'aaaaaaaa-1111-4111-8111-111111111116' }),
        givenTo: amara.principalId,
      });
      await pathRepo.updateStep(tx, {
        id: 'aaaaaaaa-1111-4111-8111-111111111116',
        expectedVersion: 1,
        change: {
          status: 'done',
          evidence: 'I talked to ten people',
          sourceSessionId: session.id,
          completedBy: amara.principalId,
        },
      });
      await pathRepo.setCriterion(tx, {
        tenantId: seed.tenantId,
        ventureId: coached.id,
        criterionId: 'discovery-interviews',
        status: 'met',
        evidence: 'I talked to ten people',
        stepId: null,
        sourceSessionId: session.id,
        principalId: amara.principalId,
      });
      return session.id;
    });
    await t.db.withContext(amara, (tx) =>
      tx.query('SELECT app.soft_delete_session(:id) AS ok', { id: p.uuid(sessionId) }),
    );
    const r = await reads(amara, coached);
    expect(r.steps[0]).toMatchObject({ status: 'done', evidence: null, sourceSessionId: null });
    expect(r.criteria[0]).toMatchObject({ status: 'met', evidence: null });
    const turns = await t.db.system((sx) =>
      sx.query('SELECT guidance FROM turns WHERE session_id = :id', { id: p.uuid(sessionId) }),
    );
    expect(turns.rows.map((row) => row.guidance)).toEqual([null]);
  });

  it('0035: the idea is kept once and never over one they wrote; a change of it is dated, and may move the stage back', async () => {
    const maya = ctx('maya');
    const keep = (idea: string, sessionId: string) =>
      t.db.withContext(maya, (tx) =>
        pathRepo.keepIdea(tx, {
          tenantId: seed.tenantId,
          ventureId: mine.id,
          principalId: maya.principalId,
          stage: 'validation',
          playbookVersion: 'x',
          idea,
          sessionId,
        }),
      );
    const session = await t.db.withContext(maya, async (tx) => {
      const r = await tx.query(
        'SELECT id FROM coaching_sessions WHERE venture_id = :v AND deleted_at IS NULL LIMIT 1',
        {
          v: p.uuid(mine.id),
        },
      );
      return String(must(r.rows[0]).id);
    });
    await t.db.system((sx) =>
      sx.query(`UPDATE venture_paths SET intake = NULL WHERE venture_id = :v`, { v: p.uuid(mine.id) }),
    );
    expect(await keep('a quiet seat finder', session)).toBe(true);
    expect(await keep('something else', session)).toBe(false);
    const kept = must((await reads(maya, mine)).path);
    expect(kept.intake).toMatchObject({ idea: 'a quiet seat finder', customer: '', deadline: null });
    await t.db.withContext(maya, (tx) =>
      pathRepo.keepPivot(tx, {
        tenantId: seed.tenantId,
        ventureId: mine.id,
        principalId: maya.principalId,
        stage: 'discovery',
        playbookVersion: 'x',
        pivot: { on: '2026-11-24', from: 'a quiet seat finder', to: 'chairs for events', sessionId: session },
        sessionId: session,
      }),
    );
    const changed = must((await reads(maya, mine)).path);
    expect([changed.stage, changed.intake?.idea, changed.pivots.length]).toEqual([
      'discovery',
      'chairs for events',
      1,
    ]);
    // Deleting the conversation takes the words and leaves the day.
    await t.db.system((sx) =>
      sx.query('UPDATE coaching_sessions SET deleted_at = now() WHERE id = :id', { id: p.uuid(session) }),
    );
    const erased = must((await reads(maya, mine)).path);
    expect([erased.intake?.idea, erased.pivots]).toEqual([
      '',
      [{ on: '2026-11-24', from: '', to: '', sessionId: null }],
    ]);
    await t.db.system((sx) =>
      sx.query('UPDATE coaching_sessions SET deleted_at = NULL WHERE id = :id', { id: p.uuid(session) }),
    );
  });

  it('is idempotent: re-running every statement, then the runner, changes nothing', async () => {
    if (!PATH || !IDEA) throw new Error('0033 or 0035 missing');
    const before = await fingerprint(t.db);
    await t.db.system(async (sx) => {
      for (const statement of [...splitStatements(PATH.sql), ...splitStatements(IDEA.sql)])
        await sx.query(statement);
    });
    expect(await fingerprint(t.db)).toBe(before);
    expect((await migrate(t.db)).applied).toEqual([]);
  });
});
