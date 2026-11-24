/**
 * The coach release (./coach-releases.ts, ADR-0021 amendment of 2026-11-24) on a database seeded the way production's
 * was before it: Ruth's vEIR coaches BenchTally and EmberLoop, the Foundry Guide a venture made in the product. Once the
 * deploy names it, all three are Thomas's, through the product's own reassignment; notebooks carry over; every other
 * venture, persona and tenant is left alone; and nothing a person changes afterwards is undone by a redeploy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import {
  assignmentsRepo,
  notebooksRepo,
  personasRepo,
  sessionsRepo,
  turnsRepo,
  venturesRepo,
} from '../repositories/index.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import { accessCodePrefix, generateAccessCode, hashAccessCode } from './access-code.js';
import { COACH_RELEASE_ACTION, THOMAS_EVERYWHERE_RELEASE, coachAssignmentId } from './coach-releases.js';
import { seedId } from './ids.js';
import { parseOwnerReleases } from './owner-releases.js';
import { seedDatabase, type SeedConfig, type SeedResult } from './seed.js';

const KEY = THOMAS_EVERYWHERE_RELEASE.key;
const BEFORE = 'thomas-2026-11-05,amara-seam-again-2026-11-08';
const id = (...parts: string[]): string => seedId('ain', ...parts);
const thomas = id('persona', 'veir', 'eir-corin');
const ruth = id('persona', 'veir', 'eir-ruth');
const guide = id('persona', 'foundry-guide');
const benchtally = id('venture', 'benchtally');
const emberloop = id('venture', 'emberloop');
const quietquad = id('venture', 'quietquad');

let t: TestDatabase;
let config: SeedConfig;
let seed: SeedResult;
const made: Record<string, string> = {};
const sessions: Record<string, string> = {};

const rows = async (sql: string, params: Record<string, ReturnType<typeof p.uuid>> = {}) =>
  t.db.system(async (sx) => (await sx.query(sql, params)).rows);

const deploy = (keys: string): Promise<SeedResult> =>
  seedDatabase(t.db, { ...config, ownerReleases: parseOwnerReleases(keys) });

const coachOf = async (ventureId: string): Promise<assignmentsRepo.ResolvedAssignment | null> =>
  t.db.system((sx) => assignmentsRepo.resolveActiveAssignment(sx, ventureId));

const notebook = async (ventureId: string, personaId: string): Promise<notebooksRepo.NotebookRecord | null> =>
  t.db.system((sx) => notebooksRepo.getNotebook(sx, { ventureId, personaId }));

const as = (key: string) => makeContext(String(seed.principals[key]), seed.tenantId);

/** A venture of the home tenant made in the product, coached by `personaId` and reviewed by its EIR. */
async function makeVenture(name: string, personaId: string): Promise<string> {
  return t.db.system(async (sx) => {
    const venture = await venturesRepo.createVenture(sx, { tenantId: seed.tenantId, name });
    await assignmentsRepo.createAssignment(sx, {
      tenantId: seed.tenantId,
      ventureId: venture.id,
      personaId,
      eirProfileId: (await personasRepo.getPersona(sx, personaId))?.eirProfileId ?? null,
    });
    return venture.id;
  });
}

/** A finished, distilled conversation of `founder` with the venture's coach of the moment. */
async function talk(ventureId: string, founder: string): Promise<string> {
  const sessionId = await t.db.withContext(as(founder), async (tx) => {
    const active = await assignmentsRepo.resolveActiveAssignment(tx, ventureId);
    if (active?.release == null) throw new Error('no coach');
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId,
      assignmentId: active.assignment.id,
      personaReleaseId: active.release.id,
      startedBy: String(seed.principals[founder]),
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    await turnsRepo.createTurn(tx, {
      tenantId: seed.tenantId,
      ventureId,
      sessionId: session.id,
      authorId: String(seed.principals[founder]),
      mode: 'coach',
      founderText: 'How do I price the pilot?',
    });
    return session.id;
  });
  await t.db.system(async (sx) => {
    await sx.query(
      `UPDATE turns SET status = 'completed', completed_at = now(), response = '{"answer": "Start at $40."}'::jsonb
        WHERE session_id = :id`,
      { id: p.uuid(sessionId) },
    );
    await sx.query(
      `UPDATE coaching_sessions SET status = 'ended', ended_at = now(), distilled_at = now(), distill_version = 1,
              last_activity_at = clock_timestamp() WHERE id = :id`,
      { id: p.uuid(sessionId) },
    );
  });
  return sessionId;
}

async function saveNotes(
  ventureId: string,
  content: notebooksRepo.NotebookContent,
  editor: { by: 'veir' } | { by: 'person'; principalId: string },
  suppressed: readonly notebooksRepo.SuppressedLine[] = [],
): Promise<void> {
  await t.db.system(async (sx) => {
    const current = await notebooksRepo.getNotebook(sx, { ventureId, personaId: ruth });
    const saved = await notebooksRepo.saveNotebook(sx, {
      tenantId: seed.tenantId,
      ventureId,
      personaId: ruth,
      expectedVersion: current?.version ?? 0,
      content,
      suppressed,
      editedBy: editor.by,
      principalId: editor.by === 'person' ? editor.principalId : null,
      sourceSessionId: content.nextOpenerSource ?? null,
    });
    if (saved === null) throw new Error('notebook not saved');
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  const code = generateAccessCode();
  config = {
    homeTenant: { slug: 'ain', name: 'Ain Foundry (test)' },
    owner: {
      displayName: 'Platform Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    },
  };
  seed = await deploy(BEFORE);

  made.guided = await makeVenture('Fernwick Loop', guide);
  // A second guide stands for a persona made in the studio: not a seeded one.
  const studio = await t.db.system(async (sx) => {
    const persona = await personasRepo.createPersona(sx, {
      tenantId: seed.tenantId,
      name: 'Studio Guide',
      kind: 'neutral_guide',
      status: 'active',
    });
    return persona.id;
  });
  made.studio = await makeVenture('Juniper Works', studio);
  made.paused = await makeVenture('Paused Pines', ruth);
  made.suspended = await makeVenture('Quiet Quarry', ruth);
  await rows(`UPDATE ventures SET status = 'paused' WHERE id = :id`, { id: p.uuid(made.paused) });
  await rows(`UPDATE assignments SET status = 'suspended' WHERE venture_id = :id`, {
    id: p.uuid(made.suspended),
  });

  // BenchTally: Ruth's vEIR took notes, and Priya wrote a line of her own and changed the opener's neighbour.
  sessions.old = await talk(benchtally, 'priya');
  sessions.last = await talk(benchtally, 'priya');
  const at = '2026-11-20T10:00:00.000Z';
  const line = (key: string, text: string, source: string | null) => ({
    id: key,
    text,
    sourceSessionId: source,
    createdAt: at,
  });
  const notes: notebooksRepo.NotebookContent = {
    summary: "Priya runs two paid pilots. Ruth's vEIR suggested a renewal price.",
    founderProfile: [line('fp-1', 'Likes numbers first.', sessions.old)],
    commitments: [
      { ...line('c-1', 'Ask two labs to renew', sessions.last), due: '2026-12-01', status: 'open' as const },
    ],
    openQuestions: [line('q-1', 'Who signs a purchase over $500?', sessions.last)],
    lastAdvice: [line('a-1', "Ruth's vEIR advised starting at $40 a lab.", sessions.last)],
    nextOpener: 'Good to see you again. Want help writing the renewal note to the two labs?',
    nextTopic: 'the renewal note',
    nextOpenerSource: sessions.last,
  };
  await saveNotes(benchtally, notes, { by: 'veir' });
  // As a notebook written before sources were recorded: where its summary came from is unknown.
  await rows(`UPDATE veir_notebooks SET content = content - 'summarySources' WHERE venture_id = :id`, {
    id: p.uuid(benchtally),
  });
  // EmberLoop: the opener is left from a conversation Ines has had another one since.
  sessions.ines = await talk(emberloop, 'ines');
  await saveNotes(
    emberloop,
    {
      ...notebooksRepo.EMPTY_NOTEBOOK,
      summary: 'Ines is pricing a heat store.',
      nextOpener: 'Want help with the fabricator quotes?',
      nextTopic: 'the fabricator quotes',
      nextOpenerSource: sessions.ines,
    },
    { by: 'veir' },
  );
  await talk(emberloop, 'ines');
  await saveNotes(
    benchtally,
    { ...notes, founderProfile: [...notes.founderProfile, line('fp-mine', "Ruth's vEIR is fun.", null)] },
    { by: 'person', principalId: String(seed.principals.priya) },
    [{ section: 'lastAdvice', fingerprint: 'abcdef0123456789', at }],
  );
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('before the deploy names it', () => {
  it('changes nothing', async () => {
    const again = await deploy(BEFORE);
    expect(again.coachReleases).toEqual([]);
    expect((await coachOf(benchtally))?.persona.name).toBe("Ruth's vEIR");
    expect((await coachOf(String(made.guided)))?.persona.name).toBe('Foundry Guide');
  });

  it('waits for a mentor: while Thomas cannot be assigned nothing moves and nothing is recorded', async () => {
    await rows(`UPDATE personas SET presentation = 'twin' WHERE id = :id`, { id: p.uuid(thomas) });
    const result = await deploy(`${BEFORE},${KEY}`);
    expect(result.coachReleases).toEqual([
      { key: KEY, outcome: 'no_mentor', personaId: thomas, ventures: 0, notebooks: 0 },
    ]);
    expect((await coachOf(benchtally))?.persona.name).toBe("Ruth's vEIR");
    await rows(`UPDATE personas SET presentation = 'mentor' WHERE id = :id`, { id: p.uuid(thomas) });
  });
});

describe('the thomas-everywhere coach release', () => {
  const ruthBefore: { notebook?: notebooksRepo.NotebookRecord | null } = {};
  const oldAssignment: { id?: string } = {};

  it("moves the active ventures of Ruth's vEIR and the Foundry Guide to Thomas, and only those", async () => {
    ruthBefore.notebook = await notebook(benchtally, ruth);
    oldAssignment.id = (await coachOf(benchtally))?.assignment.id;
    // Who reads BenchTally's work before: Ruth, who reviews it, and not Corin.
    for (const [eir, sees] of [
      ['eir-ruth', true],
      ['eir-corin', false],
    ] as const) {
      const found = await t.db.withContext(as(eir), (tx) => venturesRepo.getVenture(tx, benchtally));
      expect(found !== null).toBe(sees);
    }

    const result = await deploy(`${KEY},${BEFORE}`);
    expect(result.coachReleases).toEqual([
      { key: KEY, outcome: 'applied', personaId: thomas, ventures: 3, notebooks: 2 },
    ]);
    const corinProfile = id('eir-profile', 'eir-corin');
    for (const ventureId of [benchtally, emberloop, String(made.guided)]) {
      const active = await coachOf(ventureId);
      expect(active?.persona).toMatchObject({ id: thomas, name: 'Thomas', status: 'active' });
      expect(active?.release?.status).toBe('approved');
      expect(active?.assignment).toMatchObject({
        id: coachAssignmentId(THOMAS_EVERYWHERE_RELEASE, ventureId, id),
        eirProfileId: corinProfile,
        createdBy: result.ownerId,
        dataClassCeiling: 'venture_private',
      });
      expect([...(active?.assignment.allowedModes ?? [])].sort()).toEqual(
        [...(active?.release?.allowedModes ?? [])].sort(),
      );
    }
    // The result names the assignment the venture has now.
    expect(result.ventures.find((v) => v.key === 'benchtally')).toMatchObject({
      personaId: thomas,
      eirKey: 'eir-corin',
      assignmentId: coachAssignmentId(THOMAS_EVERYWHERE_RELEASE, benchtally, id),
    });
    // The old assignment ended; it is not deleted.
    const old = await rows('SELECT status FROM assignments WHERE id = :id', {
      id: p.uuid(String(oldAssignment.id)),
    });
    expect(old).toEqual([{ status: 'ended' }]);

    // Left alone: a venture already Thomas's, a persona of the studio, a paused venture, a suspended assignment.
    expect((await coachOf(quietquad))?.assignment.id).toBe(id('assignment', 'quietquad', 'veir-v1'));
    expect((await coachOf(String(made.studio)))?.persona.name).toBe('Studio Guide');
    expect((await coachOf(String(made.paused)))?.persona.id).toBe(ruth);
    expect(await coachOf(String(made.suspended))).toBeNull();
  });

  it('is audited like a reassignment in the product, with the release named', async () => {
    const events = await rows(
      `SELECT venture_id, actor_id, metadata::text AS metadata FROM audit_events
        WHERE action = 'assignment.created' AND metadata ->> 'ownerRelease' = '${KEY}' ORDER BY id`,
    );
    expect(events).toHaveLength(3);
    const bench = events.find((e) => e.venture_id === benchtally);
    expect(bench?.actor_id).toBe(seed.ownerId);
    expect(JSON.parse(String(bench?.metadata))).toEqual({
      personaId: thomas,
      eirProfileId: id('eir-profile', 'eir-corin'),
      previousAssignmentId: oldAssignment.id,
      via: 'owner_release',
      ownerRelease: KEY,
    });
    const [marker] = await rows(
      `SELECT object_id, metadata::text AS metadata FROM audit_events WHERE action = '${COACH_RELEASE_ACTION}'`,
    );
    expect(marker?.object_id).toBe(thomas);
    expect(JSON.parse(String(marker?.metadata))).toEqual({
      ownerRelease: KEY,
      approvedOn: '2026-11-24',
      ventures: 3,
      notebooks: 2,
    });
  });

  it("carries BenchTally's notebook over: every line, what Priya wrote as hers, no twin named, no false reunion", async () => {
    // The old row is exactly what it was.
    expect(await notebook(benchtally, ruth)).toEqual(ruthBefore.notebook);
    const carried = await notebook(benchtally, thomas);
    if (!carried) throw new Error('no notebook');
    expect(carried).toMatchObject({
      personaName: 'Thomas',
      intact: true,
      version: 2,
      lastEditedBy: 'person',
      updatedAt: ruthBefore.notebook?.updatedAt,
      suppressed: ruthBefore.notebook?.suppressed,
    });
    const c = carried.content;
    expect(c.summary).toBe('Priya runs two paid pilots. The coach suggested a renewal price.');
    // Its origin was unknown; it is now the conversations it can have been drawn from.
    expect(c.summarySources).toEqual([sessions.old, sessions.last]);
    expect(c.lastAdvice.map((x) => x.text)).toEqual(['The coach advised starting at $40 a lab.']);
    expect(c.commitments).toEqual(ruthBefore.notebook?.content.commitments);
    expect(c.openQuestions).toEqual(ruthBefore.notebook?.content.openQuestions);
    expect(c.founderProfile).toEqual(ruthBefore.notebook?.content.founderProfile);
    // Drawn from her latest conversation: still where she left off, without "again" from someone she never met.
    expect(c.nextOpener).toBe('Want help writing the renewal note to the two labs?');
    expect(c.nextTopic).toBe('the renewal note');
    expect(c.nextOpenerSource).toBe(sessions.last);
    const marks = await t.db.system((sx) =>
      notebooksRepo.getNotebookMarks(sx, { ventureId: benchtally, personaId: thomas }),
    );
    expect(marks).toEqual({ personEdits: ['fp-mine'], veirVersion: 1 });
    // No notes to carry: no row made.
    expect(await notebook(String(made.guided), thomas)).toBeNull();
  });

  it('leaves a stale opener behind: one drawn from a conversation its founder has moved on from', async () => {
    const carried = await notebook(emberloop, thomas);
    expect(carried).toMatchObject({ version: 1, lastEditedBy: 'veir' });
    expect(carried?.content).toMatchObject({
      summary: 'Ines is pricing a heat store.',
      summarySources: [sessions.ines],
      nextOpener: null,
      nextTopic: null,
      nextOpenerSource: null,
    });
    expect((await notebook(emberloop, ruth))?.content.nextOpener).toBe(
      'Want help with the fabricator quotes?',
    );
  });

  it("who sees the work changes as a program lead's reassignment changes it: Corin reviews it, Ruth no longer does", async () => {
    for (const [eir, sees] of [
      ['eir-ruth', false],
      ['eir-corin', true],
    ] as const) {
      const context = as(eir);
      const seen = await t.db.withContext(context, async (tx) => ({
        venture: (await venturesRepo.getVenture(tx, benchtally)) !== null,
        guided: (await venturesRepo.getVenture(tx, String(made.guided))) !== null,
        notes: (await notebooksRepo.getNotebook(tx, { ventureId: benchtally, personaId: thomas })) !== null,
      }));
      expect(seen).toEqual({ venture: sees, guided: sees, notes: sees });
      // Unchanged for what was not moved: Ruth keeps her paused venture, Corin gains nothing there.
      const paused = await t.db.withContext(context, (tx) =>
        venturesRepo.getVenture(tx, String(made.paused)),
      );
      expect(paused !== null).toBe(!sees);
    }
    // The founders' own access is untouched.
    const own = await t.db.withContext(as('priya'), (tx) => venturesRepo.getVenture(tx, benchtally));
    expect(own?.name).toBe('BenchTally');
  });

  it('deleting the conversation the notes came from erases them in both notebooks', async () => {
    await t.db.withContext(as('priya'), (tx) => sessionsRepo.softDeleteSession(tx, String(sessions.last)));
    const c = (await notebook(benchtally, thomas))?.content;
    expect(c).toMatchObject({
      summary: '',
      commitments: [],
      openQuestions: [],
      lastAdvice: [],
      nextOpener: null,
    });
    expect(c?.founderProfile.map((x) => x.id)).toEqual(['fp-1', 'fp-mine']);
    expect((await notebook(benchtally, ruth))?.content.summary).toBe('');
  });

  it('is applied once: what a program lead decides afterwards is never undone by a redeploy', async () => {
    // BenchTally goes back to Ruth's vEIR and a new venture is given to her, both in the product.
    await t.db.system((sx) =>
      assignmentsRepo.createAssignment(sx, {
        tenantId: seed.tenantId,
        ventureId: benchtally,
        personaId: ruth,
        eirProfileId: id('eir-profile', 'eir-ruth'),
      }),
    );
    const later = await makeVenture('Larkspur Labs', ruth);
    const before = await rows('SELECT id, status FROM assignments ORDER BY id');
    const again = await deploy(`${BEFORE},${KEY}`);
    expect(again.coachReleases).toEqual([
      { key: KEY, outcome: 'present', personaId: thomas, ventures: 0, notebooks: 0 },
    ]);
    expect(await rows('SELECT id, status FROM assignments ORDER BY id')).toEqual(before);
    expect((await coachOf(benchtally))?.persona.id).toBe(ruth);
    expect((await coachOf(later))?.persona.id).toBe(ruth);
    expect(again.ventures.find((v) => v.key === 'benchtally')?.personaId).not.toBe(thomas);
    expect((await coachOf(emberloop))?.persona.id).toBe(thomas);
  });

  it('never touches another tenant, and needs the deploy owner and Thomas', async () => {
    const code = generateAccessCode();
    const owner = {
      displayName: 'Partner Owner',
      accessCodePrefix: accessCodePrefix(code),
      accessCodeHash: await hashAccessCode(code),
    };
    const partner = { homeTenant: { slug: 'partner', name: 'Partner (test)' }, knowledgePack: false };
    const releases = parseOwnerReleases(KEY);
    await seedDatabase(t.db, { ...partner, owner: null });
    const noOwner = await seedDatabase(t.db, { ...partner, owner: null, ownerReleases: releases });
    expect(noOwner.coachReleases.map((r) => r.outcome)).toEqual(['no_owner']);
    const noMentor = await seedDatabase(t.db, { ...partner, owner, ownerReleases: releases });
    expect(noMentor.coachReleases.map((r) => r.outcome)).toEqual(['no_mentor']);
    expect((await coachOf(seedId('partner', 'venture', 'benchtally')))?.persona.id).toBe(
      seedId('partner', 'persona', 'veir', 'eir-ruth'),
    );
  });
});

describe('a fresh database', () => {
  it("applies production's whole list at once: every seeded venture is Thomas's, and a second run changes nothing", async () => {
    const fresh = await createTestDatabase();
    try {
      const releases = parseOwnerReleases(`${BEFORE},${KEY}`);
      const first = await seedDatabase(fresh.db, { ...config, ownerReleases: releases });
      expect(first.ownerReleases.map((r) => r.outcome)).toEqual(['applied']);
      expect(first.storyReleases.map((r) => r.outcome)).toEqual(['applied']);
      expect(first.coachReleases).toEqual([
        { key: KEY, outcome: 'applied', personaId: thomas, ventures: 2, notebooks: 0 },
      ]);
      expect(new Set(first.ventures.map((v) => v.personaId))).toEqual(new Set([thomas]));
      const names = await fresh.db.system((sx) =>
        sx.query(
          `SELECT DISTINCT pe.name FROM assignments a JOIN personas pe ON pe.id = a.persona_id
            WHERE a.status = 'active'`,
        ),
      );
      expect(names.rows).toEqual([{ name: 'Thomas' }]);
      const second = await seedDatabase(fresh.db, { ...config, ownerReleases: releases });
      expect(second.coachReleases.map((r) => r.outcome)).toEqual(['present']);
      expect(second.ventures).toEqual(first.ventures);
    } finally {
      await fresh.cleanup();
    }
  }, 180_000);
});

describe('the mentor of new ventures', () => {
  it('is the active mentor with an approved release; a suspended one, or a tenant without one, has none', async () => {
    const find = (tenantId: string) => t.db.system((sx) => personasRepo.findMentorPersona(sx, { tenantId }));
    expect(await find(seed.tenantId)).toEqual({
      id: thomas,
      eirProfileId: id('eir-profile', 'eir-corin'),
      allowedModes: ['diagnose', 'challenge', 'coach', 'teach', 'rehearse', 'route'],
    });
    const partner = await rows(`SELECT id FROM tenants WHERE slug = 'partner'`);
    expect(await find(String(partner[0]?.id))).toBeNull();
    await t.db.system((sx) =>
      personasRepo.setPersonaStatus(sx, { personaId: thomas, status: 'suspended', reason: 'test' }),
    );
    expect(await find(seed.tenantId)).toBeNull();
    await t.db.system((sx) => personasRepo.setPersonaStatus(sx, { personaId: thomas, status: 'active' }));
  });
});
