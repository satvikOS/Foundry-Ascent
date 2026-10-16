/**
 * Repositories behind the vEIR pools and conversations: the notebook's optimistic versioning, conversation
 * titles/activity/call markers (trigger), recents paging, digests and the distillation sweep, the speech
 * source of a turn, the persona library and persona-aware lesson retrieval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as knowledgeRepo from './knowledge.js';
import * as memoryRepo from './memory.js';
import * as notebooksRepo from './notebooks.js';
import * as resourcesRepo from './resources.js';
import * as retrievalRepo from './retrieval.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';

let t: TestDatabase;
let seed: SeedResult;
let quietquad: SeedResult['ventures'][number];
let maya: ReturnType<typeof makeContext>;
let devin: ReturnType<typeof makeContext>;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

async function newSession(
  ctx: ReturnType<typeof makeContext>,
  privacy: 'standard' | 'ephemeral' = 'standard',
): Promise<string> {
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, quietquad.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: quietquad.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy,
      policyVersion: 'test',
    });
    return session.id;
  });
}

async function addTurn(
  ctx: ReturnType<typeof makeContext>,
  sessionId: string,
  text: string,
  options: { channel?: 'text' | 'voice'; riskLabel?: string; answer?: Record<string, unknown> } = {},
): Promise<string> {
  return t.db.withContext(ctx, async (tx) => {
    const turn = await turnsRepo.createTurn(tx, {
      tenantId: seed.tenantId,
      ventureId: quietquad.id,
      sessionId,
      authorId: ctx.principalId,
      mode: 'coach',
      founderText: text,
      ...(options.riskLabel === undefined ? {} : { riskLabel: options.riskLabel }),
      ...(options.channel === undefined ? {} : { channel: options.channel }),
    });
    if (options.answer) {
      await tx.query(
        `UPDATE turns SET status = 'completed', response = :r, completed_at = now() WHERE id = :id`,
        {
          id: p.uuid(turn.id),
          r: p.json(options.answer),
        },
      );
    }
    return turn.id;
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  quietquad = must(seed.ventures.find((v) => v.key === 'quietquad'));
  maya = makeContext(must(seed.principals.maya), seed.tenantId);
  devin = makeContext(must(seed.principals.devin), seed.tenantId);
});
afterAll(async () => {
  await t.cleanup();
});

describe('conversations', () => {
  it('titles a conversation from its first non-crisis message and tracks activity and calls', async () => {
    const id = await newSession(maya);
    await addTurn(maya, id, 'I am in crisis and cannot go on', { riskLabel: 'crisis' });
    await t.db.withContext(maya, async (tx) => {
      expect((await sessionsRepo.getSession(tx, id))?.title).toBeNull();
    });
    await addTurn(maya, id, '  Which **library** should   host the pilot first?\nMore detail follows here.');
    await addTurn(maya, id, 'A spoken follow-up', { channel: 'voice' });
    await t.db.withContext(maya, async (tx) => {
      const session = must(await sessionsRepo.getSession(tx, id));
      expect(session.title).toBe('Which library should host the pilot first? More detail follows here.');
      expect(session.hasCalls).toBe(true);
      const turns = await turnsRepo.listTurns(tx, id);
      expect(turns.map((x) => x.channel)).toEqual(['text', 'text', 'voice']);
      expect(session.lastActivityAt).toBe(turns[2]?.createdAt);
      const view = must(await sessionsRepo.getSessionView(tx, id));
      expect(view).toMatchObject({ title: session.title, hasCalls: true, personaId: quietquad.personaId });
      // Renaming wins over the derived title.
      expect((await sessionsRepo.renameSession(tx, { sessionId: id, title: 'Pilot venue' }))?.title).toBe(
        'Pilot venue',
      );
    });
    // Temporary chats never get a title.
    const temporary = await newSession(maya, 'ephemeral');
    await addTurn(maya, temporary, 'Something I do not want kept');
    await t.db.withContext(maya, async (tx) => {
      expect((await sessionsRepo.getSession(tx, temporary))?.title).toBeNull();
    });
  });

  it('pages the caller’s conversations across ventures by latest activity', async () => {
    const ids = [await newSession(devin), await newSession(devin), await newSession(devin)];
    for (const [i, id] of ids.entries()) await addTurn(devin, id, `Devin question ${String(i)}`);
    const first = await t.db.withContext(devin, (tx) =>
      sessionsRepo.listSessionPage(tx, { principalId: devin.principalId, scope: 'mine', limit: 2 }),
    );
    expect(first.items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await t.db.withContext(devin, (tx) =>
      sessionsRepo.listSessionPage(tx, {
        principalId: devin.principalId,
        scope: 'mine',
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect(second.items.map((s) => s.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    // `all` includes teammates' conversations (and the seeded one); never other ventures'.
    const all = await t.db.withContext(devin, (tx) =>
      sessionsRepo.listSessionPage(tx, { principalId: devin.principalId, scope: 'all', limit: 100 }),
    );
    expect(all.items.length).toBeGreaterThan(3);
    expect(all.items.every((s) => s.ventureId === quietquad.id)).toBe(true);
    expect(all.items.some((s) => s.startedBy.id === maya.principalId)).toBe(true);
    // A malformed cursor reads as the first page.
    expect(sessionsRepo.decodeSessionCursor('not-a-cursor')).toBeNull();
  });

  it('stores digests only for standard conversations, never again once a person deleted one', async () => {
    const id = await newSession(maya);
    await addTurn(maya, id, 'Digest me', { answer: { answer: 'Validated answer.' } });
    const digest = {
      summary: 'We discussed the pilot.',
      topics: ['pilot'],
      commitments: [{ text: 'Call the library', due: null }],
      openQuestions: ['Which library?'],
      generatedAt: new Date().toISOString(),
    };
    await t.db.system(async (sx) => {
      // Idle long enough → a distillation candidate with one completed turn.
      await sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - interval '1 hour' WHERE id = :id`,
        {
          id: p.uuid(id),
        },
      );
      const candidates = await sessionsRepo.listDistillationCandidates(sx, { idleSeconds: 1200, limit: 200 });
      expect(candidates.find((c) => c.sessionId === id)).toMatchObject({
        turnCount: 1,
        ventureId: quietquad.id,
      });
      expect(
        await sessionsRepo.setSessionDigest(sx, { sessionId: id, digest, distillVersion: 1, title: 'Pilot' }),
      ).toBe(true);
      const after = await sessionsRepo.listDistillationCandidates(sx, { idleSeconds: 1200, limit: 200 });
      expect(after.some((c) => c.sessionId === id)).toBe(false);
    });
    await t.db.withContext(maya, async (tx) => {
      const digests = await sessionsRepo.listRecentDigests(tx, {
        ventureId: quietquad.id,
        personaId: quietquad.personaId,
      });
      expect(digests[0]).toMatchObject({ sessionId: id, title: 'Pilot', digest });
      expect(digests.length).toBe(2); // and the seeded past conversation
      expect(must(await sessionsRepo.getSessionView(tx, id)).digestDeleted).toBe(false);
      const cleared = must(await sessionsRepo.deleteSessionDigest(tx, id));
      expect(cleared.digest).toBeNull();
      expect(cleared.digestDeletedAt).not.toBeNull();
      // The view says so, so a reloaded page stops waiting for a summary.
      expect(must(await sessionsRepo.getSessionView(tx, id))).toMatchObject({
        digest: null,
        digestDeleted: true,
      });
    });
    await t.db.system(async (sx) => {
      expect(await sessionsRepo.setSessionDigest(sx, { sessionId: id, digest, distillVersion: 2 })).toBe(
        false,
      );
      const candidates = await sessionsRepo.listDistillationCandidates(sx, { idleSeconds: 1200, limit: 200 });
      expect(candidates.some((c) => c.sessionId === id)).toBe(false);
    });
    // Temporary chats: the database refuses a digest.
    const temporary = await newSession(maya, 'ephemeral');
    await t.db.system(async (sx) => {
      expect(
        await sessionsRepo.setSessionDigest(sx, { sessionId: temporary, digest, distillVersion: 1 }),
      ).toBe(false);
    });
  });
});

describe('the vEIR notebook', () => {
  it('writes against the version read: a stale write is refused; a first write creates the row', async () => {
    const solesignal = must(seed.ventures.find((v) => v.key === 'solesignal'));
    const amara = makeContext(must(seed.principals.amara), seed.tenantId);
    const base = {
      tenantId: seed.tenantId,
      ventureId: solesignal.id,
      personaId: solesignal.personaId,
      suppressed: [],
    };
    const content = { ...notebooksRepo.EMPTY_NOTEBOOK, summary: 'First notes.' };
    await t.db.withContext(amara, async (tx) => {
      const seeded = must(
        await notebooksRepo.getNotebook(tx, { ventureId: solesignal.id, personaId: solesignal.personaId }),
      );
      expect(seeded.version).toBe(0);
      const saved = must(
        await notebooksRepo.saveNotebook(tx, {
          ...base,
          expectedVersion: 0,
          content,
          editedBy: 'person',
          principalId: amara.principalId,
        }),
      );
      expect(saved).toMatchObject({ version: 1, lastEditedBy: 'person', content });
      expect(
        await notebooksRepo.saveNotebook(tx, {
          ...base,
          expectedVersion: 0,
          content: notebooksRepo.EMPTY_NOTEBOOK,
          editedBy: 'person',
          principalId: amara.principalId,
        }),
      ).toBeNull();
    });
    // Distillation writes with the owner role against the version it read.
    await t.db.system(async (sx) => {
      const saved = await notebooksRepo.saveNotebook(sx, {
        ...base,
        expectedVersion: 1,
        content: { ...content, nextOpener: 'How did the clinic interviews go?' },
        editedBy: 'veir',
      });
      expect(saved).toMatchObject({ version: 2, lastEditedBy: 'veir' });
      expect(
        notebooksRepo.toNotebookView(
          { ventureId: solesignal.id, personaId: solesignal.personaId, personaName: 'x' },
          saved,
        ),
      ).toMatchObject({
        personaName: "Corin's vEIR",
        version: 2,
        nextOpener: 'How did the clinic interviews go?',
      });
    });
    // No row yet for QuietQuad × Foundry Guide (its earlier assignment): the first write inserts it.
    await t.db.withContext(maya, async (tx) => {
      const pair = { ventureId: quietquad.id, personaId: seed.personaId };
      expect(await notebooksRepo.getNotebook(tx, pair)).toBeNull();
      const created = await notebooksRepo.saveNotebook(tx, {
        ...pair,
        tenantId: seed.tenantId,
        expectedVersion: 0,
        content,
        suppressed: [
          { section: 'founderProfile', fingerprint: 'a'.repeat(32), at: new Date().toISOString() },
        ],
        editedBy: 'person',
        principalId: maya.principalId,
      });
      expect(created).toMatchObject({ version: 1, personaName: 'Foundry Guide' });
      expect(created?.suppressed).toHaveLength(1);
    });
  });
});

describe('the persona common pool', () => {
  it('lists the library with chunk counts and retrieves lessons for the assigned persona only', async () => {
    const corin = must(seed.veirs.find((v) => v.eirKey === 'eir-corin'));
    const ruth = must(seed.veirs.find((v) => v.eirKey === 'eir-ruth'));
    await t.db.withContext(maya, async (tx) => {
      const library = await knowledgeRepo.listPersonaLibrary(tx, { personaId: corin.personaId });
      expect(library.length).toBe(8);
      expect(library.every((s) => s.personaId === corin.personaId && s.chunkCount >= 1)).toBe(true);
      const one = must(await knowledgeRepo.getPersonaLibrarySource(tx, must(library[0]).id));
      expect(one.body?.length).toBeGreaterThan(100);
      // Shared retrieval finds the assigned persona's library as doctrine.
      const shared = await retrievalRepo.searchSharedChunks(tx, {
        tenantId: seed.tenantId,
        personaId: corin.personaId,
        query: 'kill criterion repeat users prediction',
        embedding: null,
        limit: 5,
      });
      expect(shared.some((i) => i.kind === 'doctrine' && i.title.includes('kill criterion'))).toBe(true);
      // Lessons: program-wide plus the assigned persona's; another persona's never.
      const lessons = await retrievalRepo.searchPatterns(tx, {
        tenantId: seed.tenantId,
        personaId: corin.personaId,
        query: 'pilot buyer budget owner price',
        limit: 10,
      });
      const ruthLessons = await resourcesRepo.listLessons(tx, {
        tenantId: seed.tenantId,
        personaId: ruth.personaId,
      });
      expect(lessons.length).toBeGreaterThan(0);
      expect(lessons.some((l) => ruthLessons.some((r) => r.id === l.refId))).toBe(false);
      expect(lessons.some((l) => l.title === 'Free pilots teach you nothing about price')).toBe(true);
      // Without a persona, only program-wide lessons.
      const programOnly = await retrievalRepo.searchPatterns(tx, {
        tenantId: seed.tenantId,
        query: 'pilot buyer budget owner price',
        limit: 10,
      });
      const corinLessons = await resourcesRepo.listLessons(tx, {
        tenantId: seed.tenantId,
        personaId: corin.personaId,
      });
      expect(programOnly.some((l) => corinLessons.some((c) => c.id === l.refId))).toBe(false);
    });
  });
});

describe('deleting a conversation', () => {
  it('removes what was drawn from it: pending AI proposals, notebook lines, summary and opener', async () => {
    const past = must(
      (
        await t.db.withContext(maya, (tx) => sessionsRepo.listSessionViews(tx, { ventureId: quietquad.id }))
      ).find((s) => s.title === 'Is exam-week demand strong enough for a pilot?'),
    );
    const proposal = await t.db.withContext(maya, (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: quietquad.id,
        type: 'insight',
        title: 'Proposed from the past conversation',
        content: 'Students might prefer notifications.',
        origin: 'ai',
        createdBy: maya.principalId,
        visibility: 'team',
        sourceRefs: [{ kind: 'session', id: past.id }],
      }),
    );
    const before = must(
      await t.db.withContext(maya, (tx) =>
        notebooksRepo.getNotebook(tx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
      ),
    );
    expect(before.content.commitments.length).toBeGreaterThan(0);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, past.id))).toBe(true);
    const after = must(
      await t.db.withContext(maya, (tx) =>
        notebooksRepo.getNotebook(tx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
      ),
    );
    expect(after.version).toBe(before.version + 1);
    expect(after.content.commitments).toEqual([]);
    expect(after.content.founderProfile).toEqual([]);
    // The summary and the opener were drawn from it too.
    expect(before.content.summarySources).toEqual([past.id]);
    expect(after.content).toMatchObject({ summary: '', summarySources: [], nextOpener: null });
    const state = await t.db.system((sx) =>
      sx.query('SELECT status, content FROM memory_objects WHERE id = :id', { id: p.uuid(proposal.id) }),
    );
    expect(state.rows[0]).toEqual({ status: 'deleted', content: '' });
  });
});
