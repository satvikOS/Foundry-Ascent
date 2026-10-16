/**
 * Conversation privacy and lifecycle (migration 0005): titles are founder text that only the venture's
 * founder/team read; temporary chats never carry one; a person's title survives distillation; deleting a
 * conversation erases everything drawn from it; recents order by when messages were sent, under concurrent
 * turns too; a notebook that no longer matches its contract is never shown or saved as if empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotebookIntegrityError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as escalationsRepo from './escalations.js';
import * as memoryRepo from './memory.js';
import * as notebooksRepo from './notebooks.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';

type Ctx = ReturnType<typeof makeContext>;

let t: TestDatabase;
let seed: SeedResult;
let quietquad: SeedResult['ventures'][number];
let emberloop: SeedResult['ventures'][number];
let maya: Ctx;
let corin: Ctx;
let jonah: Ctx;

const PAST_TITLE = 'Is exam-week demand strong enough for a pilot?';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

function venture(key: string): SeedResult['ventures'][number] {
  return must(seed.ventures.find((v) => v.key === key));
}

async function newSession(
  ctx: Ctx,
  v: SeedResult['ventures'][number],
  options: { privacy?: 'standard' | 'ephemeral'; title?: string } = {},
): Promise<string> {
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy: options.privacy ?? 'standard',
      goal: 'Price the pilot',
      policyVersion: 'test',
      title: options.title ?? null,
    });
    return session.id;
  });
}

function turnInput(ctx: Ctx, v: SeedResult['ventures'][number], sessionId: string, text: string) {
  return {
    tenantId: seed.tenantId,
    ventureId: v.id,
    sessionId,
    authorId: ctx.principalId,
    mode: 'coach' as const,
    founderText: text,
  };
}

async function addTurn(
  ctx: Ctx,
  v: SeedResult['ventures'][number],
  sessionId: string,
  text: string,
): Promise<turnsRepo.TurnRecord> {
  return t.db.withContext(ctx, (tx) => turnsRepo.createTurn(tx, turnInput(ctx, v, sessionId, text)));
}

function notebookOf(ctx: Ctx, v: SeedResult['ventures'][number]): Promise<notebooksRepo.NotebookRecord> {
  return t.db.withContext(ctx, async (tx) =>
    must(await notebooksRepo.getNotebook(tx, { ventureId: v.id, personaId: v.personaId })),
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  quietquad = venture('quietquad');
  emberloop = venture('emberloop');
  maya = makeContext(must(seed.principals.maya), seed.tenantId);
  corin = makeContext(must(seed.principals['eir-corin']), seed.tenantId);
  jonah = makeContext(must(seed.principals.jonah), seed.tenantId);
});
afterAll(async () => {
  await t.cleanup();
});

describe('conversation titles', () => {
  it('are founder text: the assigned EIR reads the conversation row and its digest, never its title or goal', async () => {
    const asMaya = await t.db.withContext(maya, (tx) =>
      sessionsRepo.listSessionViews(tx, { ventureId: quietquad.id }),
    );
    const past = must(asMaya.find((s) => s.title === PAST_TITLE));
    expect(past.goal).not.toBeNull();

    // Corin is the EIR whose vEIR coaches QuietQuad: RLS lets him read its conversation rows.
    const asCorin = await t.db.withContext(corin, async (tx) => ({
      view: await sessionsRepo.getSessionView(tx, past.id),
      list: await sessionsRepo.listSessionViews(tx, { ventureId: quietquad.id }),
      record: await sessionsRepo.getSession(tx, past.id),
      digests: await sessionsRepo.listRecentDigests(tx, {
        ventureId: quietquad.id,
        personaId: quietquad.personaId,
      }),
    }));
    expect(asCorin.view).toMatchObject({ id: past.id, title: null, goal: null });
    // Digests are AI summaries shared with the assigned EIR, like recaps.
    expect(asCorin.view?.digest?.summary).toBe(past.digest?.summary);
    expect(asCorin.list.find((s) => s.id === past.id)).toMatchObject({ title: null, goal: null });
    expect(asCorin.record).toMatchObject({ title: null, goal: null, titleSource: 'auto' });
    expect(asCorin.digests.map((d) => [d.sessionId, d.title])).toEqual([[past.id, null]]);
    // Recents list only conversations the reader works on.
    const recents = await t.db.withContext(corin, (tx) =>
      sessionsRepo.listSessionPage(tx, { principalId: corin.principalId, scope: 'all' }),
    );
    expect(recents.items).toEqual([]);

    // Founders and system jobs (distillation) read titles as stored.
    const digests = await t.db.withContext(maya, (tx) =>
      sessionsRepo.listRecentDigests(tx, { ventureId: quietquad.id, personaId: quietquad.personaId }),
    );
    expect(digests[0]?.title).toBe(PAST_TITLE);
    const system = await t.db.system((sx) => sessionsRepo.getSession(sx, past.id));
    expect(system?.title).toBe(PAST_TITLE);
  });

  it('record who set them: the first message and distillation title automatically, a person’s title stays', async () => {
    const auto = await newSession(maya, quietquad);
    await addTurn(maya, quietquad, auto, 'How many **seats** do we need for exam week?');
    let record = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, auto));
    expect(record).toMatchObject({ title: 'How many seats do we need for exam week?', titleSource: 'auto' });

    const digest = {
      summary: 'Seat counts for the exam weeks.',
      topics: ['Seats'],
      commitments: [],
      openQuestions: [],
      generatedAt: new Date().toISOString(),
    };
    const distil = (sessionId: string, title: string): Promise<boolean> =>
      t.db.system((sx) => sessionsRepo.setSessionDigest(sx, { sessionId, digest, distillVersion: 1, title }));
    expect(await distil(auto, 'Exam-week seat counts')).toBe(true);
    record = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, auto));
    expect(record).toMatchObject({ title: 'Exam-week seat counts', titleSource: 'auto' });

    const renamed = await t.db.withContext(maya, (tx) =>
      sessionsRepo.renameSession(tx, { sessionId: auto, title: 'Seat plan' }),
    );
    expect(renamed).toMatchObject({ title: 'Seat plan', titleSource: 'person' });
    expect(await distil(auto, 'Something the model preferred')).toBe(true);
    record = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, auto));
    expect(record).toMatchObject({ title: 'Seat plan', titleSource: 'person' });

    // A title given at the start is the person's too.
    const named = await newSession(maya, quietquad, { title: 'Library pilot' });
    await addTurn(maya, quietquad, named, 'First question');
    record = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, named));
    expect(record).toMatchObject({ title: 'Library pilot', titleSource: 'person' });
  });

  it('never exist for temporary chats (rename refuses; the database refuses any other write)', async () => {
    await expect(newSession(maya, quietquad, { privacy: 'ephemeral', title: 'Kept?' })).rejects.toMatchObject(
      {
        sqlState: '23514',
        constraint: 'coaching_sessions_title_privacy_check',
      },
    );
    const temporary = await newSession(maya, quietquad, { privacy: 'ephemeral' });
    await addTurn(maya, quietquad, temporary, 'A quick private question');
    const record = await t.db.withContext(maya, (tx) => sessionsRepo.getSession(tx, temporary));
    expect(record?.title).toBeNull();
    expect(
      await t.db.withContext(maya, (tx) =>
        sessionsRepo.renameSession(tx, { sessionId: temporary, title: 'Private' }),
      ),
    ).toBeNull();
    await expect(
      t.db.system((sx) =>
        sx.query(`UPDATE coaching_sessions SET title = 'x' WHERE id = :id`, { id: p.uuid(temporary) }),
      ),
    ).rejects.toMatchObject({ sqlState: '23514', constraint: 'coaching_sessions_title_privacy_check' });
  });
});

describe('recents', () => {
  it('page by exact microsecond positions', async () => {
    const [a, b, c] = [
      await newSession(jonah, emberloop),
      await newSession(jonah, emberloop),
      await newSession(jonah, emberloop),
    ];
    // Two conversations one microsecond apart, the third later.
    await t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET last_activity_at = CASE id
           WHEN :a THEN timestamptz '2026-10-01 10:00:00.000001+00'
           WHEN :b THEN timestamptz '2026-10-01 10:00:00.000002+00'
           ELSE timestamptz '2026-10-01 11:00:00+00' END
         WHERE id IN (:a, :b, :c)`,
        { a: p.uuid(a), b: p.uuid(b), c: p.uuid(c) },
      ),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: sessionsRepo.SessionPage = await t.db.withContext(jonah, (tx) =>
        sessionsRepo.listSessionPage(tx, { principalId: jonah.principalId, scope: 'mine', cursor, limit: 1 }),
      );
      seen.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([c, b, a]);
  });

  it('order by when each message was sent, however the transactions interleave', async () => {
    const early = await newSession(jonah, emberloop);
    const late = await newSession(jonah, emberloop);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: () => void = () => undefined;
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    // The first transaction opens now but sends its message only after another conversation got one.
    const slow = t.db.withContext(jonah, async (tx) => {
      await tx.query('SELECT 1 AS ok');
      opened();
      await gate;
      const first = await turnsRepo.createTurn(tx, turnInput(jonah, emberloop, early, 'Sent second'));
      const next = await turnsRepo.createTurn(tx, turnInput(jonah, emberloop, late, 'Sent third'));
      return { first, next };
    });
    await isOpen;
    await pause(15);
    const quick = await addTurn(jonah, emberloop, late, 'Sent first');
    await pause(15);
    release();
    const { first, next } = await slow;

    expect(Date.parse(first.createdAt)).toBeGreaterThan(Date.parse(quick.createdAt));
    // In one conversation, a later ordinal never carries an earlier time.
    expect(next.ordinal).toBe(quick.ordinal + 1);
    expect(Date.parse(next.createdAt)).toBeGreaterThanOrEqual(Date.parse(quick.createdAt));
    const page = await t.db.withContext(jonah, (tx) =>
      sessionsRepo.listSessionPage(tx, { principalId: jonah.principalId, scope: 'mine', limit: 2 }),
    );
    expect(page.items.map((s) => s.id)).toEqual([late, early]);
  });
});

describe('deleting a conversation', () => {
  it('erases everything drawn from it and keeps what a person kept or shared', async () => {
    const past = must(
      (
        await t.db.withContext(maya, (tx) => sessionsRepo.listSessionViews(tx, { ventureId: quietquad.id }))
      ).find((s) => s.title === PAST_TITLE),
    );
    const fromPast = { sourceRefs: [{ kind: 'session' as const, id: past.id }] };
    const proposal = (title: string, extra: Partial<memoryRepo.CreateMemoryInput> = {}) =>
      t.db.withContext(maya, (tx) =>
        memoryRepo.createMemory(tx, {
          tenantId: seed.tenantId,
          ventureId: quietquad.id,
          type: 'insight',
          title,
          content: `${title}: students might prefer notifications.`,
          origin: 'ai',
          createdBy: maya.principalId,
          visibility: 'team',
          ...fromPast,
          ...extra,
        }),
      );
    const pending = await proposal('Pending');
    const rejected = await proposal('Rejected', { status: 'rejected' });
    const kept = await proposal('Kept', { status: 'confirmed', approvedBy: maya.principalId });
    const packet = {
      founderQuestion: 'Should we wait for staff counts?',
      desiredDecision: null,
      sharedFacts: [],
      evidenceConsidered: [],
      conflictingSignals: [],
      unknowns: [],
      reason: 'Needs a person who knows the libraries',
      urgency: 'This week',
      proposedNextStep: null,
      sessionSummary: 'Exam-week demand and staff counts.',
      aiGenerated: true as const,
    };
    const escalate = (status: 'draft' | 'awaiting_consent') =>
      t.db.withContext(maya, (tx) =>
        escalationsRepo.createEscalation(tx, {
          tenantId: seed.tenantId,
          ventureId: quietquad.id,
          sessionId: past.id,
          category: 'expert_judgment',
          priority: 'P2',
          status,
          requestedRole: 'eir',
          packet,
          createdBy: maya.principalId,
        }),
      );
    const unshared = await escalate('awaiting_consent');
    const withdrawn = await escalate('draft');
    await t.db.withContext(maya, (tx) =>
      escalationsRepo.transitionEscalation(tx, {
        escalationId: withdrawn.id,
        action: 'withdraw',
        actorId: maya.principalId,
      }),
    );
    const shared = await escalate('awaiting_consent');
    await t.db.withContext(maya, (tx) =>
      escalationsRepo.recordSharingConsent(tx, { escalationId: shared.id, consentBy: maya.principalId }),
    );

    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, past.id))).toBe(true);

    const memory = await t.db.system((sx) =>
      sx.query('SELECT id, status, content FROM memory_objects WHERE id = ANY (:ids)', {
        ids: p.uuidArray([pending.id, rejected.id, kept.id]),
      }),
    );
    const byId = new Map(memory.rows.map((r) => [String(r.id), r]));
    expect(byId.get(pending.id)).toMatchObject({ status: 'deleted', content: '' });
    expect(byId.get(rejected.id)).toMatchObject({ status: 'deleted', content: '' });
    expect(byId.get(kept.id)).toMatchObject({
      status: 'confirmed',
      content: 'Kept: students might prefer notifications.',
    });
    // A packet the founder shared went to a person with consent: it stays. One never shared (open or
    // withdrawn) is withdrawn and erased: it held the founder's question verbatim.
    const escalations = await t.db.withContext(
      maya,
      async (tx) =>
        new Map(
          (await escalationsRepo.listVentureEscalations(tx, { ventureId: quietquad.id })).map(
            (e) => [e.id, e] as const,
          ),
        ),
    );
    expect(escalations.get(shared.id)).toMatchObject({ status: 'awaiting_assignment', packet });
    const erased = {
      ...packet,
      founderQuestion: '[deleted conversation]',
      reason: '[deleted conversation]',
      sessionSummary: null,
    };
    expect(escalations.get(unshared.id)).toMatchObject({ status: 'withdrawn', packet: erased });
    expect(escalations.get(withdrawn.id)).toMatchObject({ status: 'withdrawn', packet: erased });
    const notebook = await notebookOf(maya, quietquad);
    expect(notebook.content).toMatchObject({
      summary: '',
      summarySources: [],
      nextOpener: null,
      nextOpenerSource: null,
      commitments: [],
      founderProfile: [],
      openQuestions: [],
      lastAdvice: [],
    });
  });

  it('erases the vEIR’s untouched memory from it and keeps memory the founder edited (the delete dialog’s promise)', async () => {
    const sessionId = await newSession(maya, quietquad, { title: 'Pricing call' });
    const turn = await addTurn(maya, quietquad, sessionId, 'Libraries pay per seat, not per student.');
    const learned = (title: string) =>
      t.db.withContext(maya, (tx) =>
        memoryRepo.createMemory(tx, {
          tenantId: seed.tenantId,
          ventureId: quietquad.id,
          type: 'insight',
          title,
          content: `${title}: libraries pay per seat.`,
          origin: 'ai',
          createdBy: maya.principalId,
          visibility: 'team',
          sourceRefs: [{ kind: 'turn', id: turn.id, label: 'AI proposal' }],
        }),
      );
    const untouched = await learned('Untouched');
    const edited = await learned('Edited');
    // Knowledge's Edit on memory the vEIR saved before memory was kept automatically: the person editing it
    // means to keep it, so it is kept first, then corrected as a new version.
    must(
      await t.db.withContext(maya, (tx) =>
        memoryRepo.approveMemory(tx, { memoryId: edited.id, actorId: maya.principalId }),
      ),
    );
    const corrected = must(
      await t.db.withContext(maya, (tx) =>
        memoryRepo.correctMemory(tx, {
          memoryId: edited.id,
          actorId: maya.principalId,
          patch: { content: 'Edited: libraries pay per seat, renewed each term.' },
        }),
      ),
    );

    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, sessionId))).toBe(true);

    const rows = await t.db.system((sx) =>
      sx.query('SELECT id, status, content FROM memory_objects WHERE id = ANY (:ids)', {
        ids: p.uuidArray([untouched.id, corrected.id]),
      }),
    );
    const byId = new Map(rows.rows.map((r) => [String(r.id), r]));
    expect(byId.get(untouched.id)).toMatchObject({ status: 'deleted', content: '' });
    expect(byId.get(corrected.id)).toMatchObject({
      status: 'confirmed',
      content: 'Edited: libraries pay per seat, renewed each term.',
    });
  });

  it('clears a summary only when it was drawn from that conversation (or its sources are unknown)', async () => {
    const a = await newSession(maya, quietquad);
    const b = await newSession(maya, quietquad);
    await addTurn(maya, quietquad, a, 'Conversation A');
    await addTurn(maya, quietquad, b, 'Conversation B');
    const write = async (summary: string, opener: string, source: string | null): Promise<void> => {
      const current = await notebookOf(maya, quietquad);
      const saved = await t.db.system((sx) =>
        notebooksRepo.saveNotebook(sx, {
          tenantId: seed.tenantId,
          ventureId: quietquad.id,
          personaId: quietquad.personaId,
          expectedVersion: current.version,
          content: { ...current.content, summary, nextOpener: opener },
          suppressed: current.suppressed,
          editedBy: 'veir',
          sourceSessionId: source,
        }),
      );
      expect(saved).not.toBeNull();
    };
    await write('Drawn from A.', 'About A?', a);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({
      summarySources: [a],
      nextOpenerSource: a,
    });
    // B is neither a source nor distilled: the summary stays.
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, b))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({
      summary: 'Drawn from A.',
      nextOpener: 'About A?',
    });
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, a))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({ summary: '', nextOpener: null });

    // Unknown sources (written without one): deleting a distilled conversation of the persona clears them.
    const c = await newSession(maya, quietquad);
    const d = await newSession(maya, quietquad);
    await addTurn(maya, quietquad, c, 'Conversation C');
    await addTurn(maya, quietquad, d, 'Conversation D');
    await write('Unknown origin.', 'Unknown opener?', null);
    expect((await notebookOf(maya, quietquad)).content.summarySources).toBeUndefined();
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, d))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content.summary).toBe('Unknown origin.');
    await t.db.system((sx) =>
      sessionsRepo.setSessionDigest(sx, {
        sessionId: c,
        digest: {
          summary: 'C',
          topics: [],
          commitments: [],
          openQuestions: [],
          generatedAt: new Date().toISOString(),
        },
        distillVersion: 1,
      }),
    );
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, c))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({ summary: '', nextOpener: null });
  });
});

describe('deleting a conversation leaves what a person wrote', () => {
  it('keeps a summary and opener a person wrote, whichever conversation is deleted', async () => {
    const distill = (sessionId: string) =>
      t.db.system((sx) =>
        sx.query('UPDATE coaching_sessions SET distilled_at = now(), distill_version = 1 WHERE id = :id', {
          id: p.uuid(sessionId),
        }),
      );
    const save = async (
      editedBy: 'person' | 'veir',
      patch: Pick<notebooksRepo.NotebookContent, 'summary' | 'nextOpener'>,
    ): Promise<void> => {
      const current = await notebookOf(maya, quietquad);
      const saved = await t.db.withContext(maya, (tx) =>
        notebooksRepo.saveNotebook(tx, {
          tenantId: seed.tenantId,
          ventureId: quietquad.id,
          personaId: quietquad.personaId,
          expectedVersion: current.version,
          content: { ...current.content, ...patch },
          suppressed: current.suppressed,
          editedBy,
          principalId: editedBy === 'person' ? maya.principalId : null,
        }),
      );
      expect(saved).not.toBeNull();
    };
    const mine = { summary: 'My own words about QuietQuad.', nextOpener: 'Ask me about Tuesday.' };
    await save('person', { summary: '', nextOpener: null });
    await save('person', mine);
    // The repository records a person's text written where there was none as drawn from no conversation.
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({
      ...mine,
      summarySources: [],
      nextOpenerSource: null,
    });

    const unrelated = await newSession(maya, quietquad);
    await addTurn(maya, quietquad, unrelated, 'An unrelated question about logos');
    await distill(unrelated);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, unrelated))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject(mine);

    // Text rewritten by distillation without a source is of unknown origin: it may carry the deleted
    // conversation, so it is cleared.
    await save('veir', { summary: 'Rewritten by the vEIR.', nextOpener: 'Rewritten opener?' });
    expect((await notebookOf(maya, quietquad)).content).not.toHaveProperty('summarySources');
    const other = await newSession(maya, quietquad);
    await distill(other);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, other))).toBe(true);
    expect((await notebookOf(maya, quietquad)).content).toMatchObject({ summary: '', nextOpener: null });
  });
});

describe('notebook integrity', () => {
  it('never shows or saves a stored notebook it cannot read in full as if it were empty', async () => {
    const before = await notebookOf(jonah, emberloop);
    const readable = {
      id: 'fp-1',
      text: 'Prefers numbers first',
      sourceSessionId: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    const legacy = { ...readable, id: 'fp-2', sourceSessionId: 'imported-from-a-spreadsheet' };
    // A row written before the contract tightened (the CHECK now refuses it, so bypass it for this test).
    await t.db.system(async (sx) => {
      await sx.query('ALTER TABLE veir_notebooks DROP CONSTRAINT veir_notebooks_content_check');
      await sx.query(
        `UPDATE veir_notebooks SET content = content || jsonb_build_object('summary', 'Kiln studios', 'founderProfile', :entries)
         WHERE id = :id`,
        { id: p.uuid(before.id), entries: p.json([readable, legacy]) },
      );
    });
    try {
      const damaged = await notebookOf(jonah, emberloop);
      expect(damaged.intact).toBe(false);
      expect(damaged.content.summary).toBe('Kiln studios');
      expect(damaged.content.founderProfile).toEqual([readable]);
      for (const editedBy of ['person', 'veir'] as const) {
        await expect(
          t.db.withContext(jonah, (tx) =>
            notebooksRepo.saveNotebook(tx, {
              tenantId: seed.tenantId,
              ventureId: emberloop.id,
              personaId: emberloop.personaId,
              expectedVersion: damaged.version,
              content: { ...damaged.content, summary: '' },
              suppressed: [],
              editedBy,
            }),
          ),
        ).rejects.toBeInstanceOf(NotebookIntegrityError);
      }
      expect((await notebookOf(jonah, emberloop)).content.summary).toBe('Kiln studios');
    } finally {
      await t.db.system(async (sx) => {
        await sx.query(`UPDATE veir_notebooks SET content = :content WHERE id = :id`, {
          id: p.uuid(before.id),
          content: p.json(before.content),
        });
        await sx.query(
          `ALTER TABLE veir_notebooks ADD CONSTRAINT veir_notebooks_content_check
             CHECK (app.notebook_content_valid(content))`,
        );
      });
    }
  });

  it('is enforced by the database: sources are conversation ids and times ISO timestamps', async () => {
    const current = await notebookOf(jonah, emberloop);
    const write = (entry: Record<string, unknown>) =>
      t.db.system((sx) =>
        sx.query(
          `UPDATE veir_notebooks SET content = content || jsonb_build_object('lastAdvice', :e) WHERE id = :id`,
          {
            id: p.uuid(current.id),
            e: p.json([entry]),
          },
        ),
      );
    const valid = {
      id: 'a-1',
      text: 'Lease first',
      sourceSessionId: null,
      createdAt: '2026-10-01T10:00:00Z',
    };
    await expect(write(valid)).resolves.toBeDefined();
    await expect(write({ ...valid, sourceSessionId: 'session-7' })).rejects.toMatchObject({
      sqlState: '23514',
    });
    await expect(write({ ...valid, createdAt: 'yesterday' })).rejects.toMatchObject({ sqlState: '23514' });
    await expect(write({ ...valid, createdAt: '2026-02-30T10:00:00Z' })).rejects.toMatchObject({
      sqlState: '23514',
    });
    await expect(
      t.db.system((sx) =>
        sx.query(
          `UPDATE veir_notebooks SET content = content || '{"summarySources": ["not-a-conversation"]}'::jsonb
           WHERE id = :id`,
          { id: p.uuid(current.id) },
        ),
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });
  });
});
