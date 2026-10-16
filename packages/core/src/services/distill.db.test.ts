/**
 * Distillation and memory hygiene through the core services, on a seeded database with the mock model: the
 * triggers, the cheap skips, the one-transaction write (digest, notebook merge that respects person edits and
 * suppression, deduplicated memory proposals, lesson drafts), idempotency per turn count, metering, the kill
 * switch and the spend caps, batch review with its authorization, expiry of stale AI proposals, and escalation
 * resolutions feeding the notebook.
 */
import {
  type DistillDraft,
  type GenerateStructuredRequest,
  MockModelGateway,
  type MockGenerateContext,
  type ModelGateway,
  ModelOutputInvalidError,
  ModelUnavailableError,
  mockDistillDraft,
} from '@foundry/ai';
import { MemoryObjectView, TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { memoryRepo, notebooksRepo, p, sessionsRepo, settingsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { memoryEmbeddingText } from '../internal/embeddings.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { RetryableDistillError } from './distill.js';
import { resolutionEntryId } from './notebook-advice.js';

let h: CoreHarness;
let maya: RequestContext;
let devin: RequestContext;
let priya: RequestContext;
let graham: RequestContext;
let corin: RequestContext;

/** A draft the next distillation of the `scripted` core returns (built from the prompt when a function). */
let scripted: ((context: MockGenerateContext) => DistillDraft) | null = null;
/** Runs after the scripted core's model answered and before the answer is returned (a concurrent edit). */
let whileAnswering: (() => Promise<void>) | null = null;
/** The next model call of the scripted core fails with this error (billed like a real failed attempt). */
let failNext: Error | null = null;
let scriptedCore: Core;

const quietquad = (): string => h.ventures.quietquad.id;
const corinPersona = (): string => h.ventures.quietquad.personaId;
let requestCounter = 0;
const job = (sessionId: string) => ({
  sessionId,
  requestId: `distill-test-${String((requestCounter += 1))}`,
});

async function completedTurn(ctx: RequestContext, sessionId: string, text: string): Promise<TurnView> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(ctx, sessionId, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'none'}`);
  return last.turn;
}

async function conversation(
  ctx: RequestContext,
  texts: readonly string[],
  options: { privacy?: 'standard' | 'ephemeral'; ventureId?: string } = {},
): Promise<string> {
  const session = await h.core.sessions.create(ctx, options.ventureId ?? quietquad(), {
    mode: 'diagnose',
    privacy: options.privacy ?? 'standard',
  });
  for (const text of texts) await completedTurn(ctx, session.id, text);
  return session.id;
}

/** Moves the conversation's last activity into the past (as if nobody wrote for `minutes`). */
async function idle(sessionId: string, minutes: number): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      'UPDATE coaching_sessions SET last_activity_at = now() - make_interval(mins => :m) WHERE id = :id',
      { id: p.uuid(sessionId), m: p.int(minutes) },
    ),
  );
}

function session(id: string): Promise<sessionsRepo.SessionRecord | null> {
  return h.t.db.system((sx) => sessionsRepo.getSession(sx, id));
}

function notebook(): Promise<notebooksRepo.NotebookRecord | null> {
  return h.t.db.system((sx) =>
    notebooksRepo.getNotebook(sx, { ventureId: quietquad(), personaId: corinPersona() }),
  );
}

async function personEdits(): Promise<string[]> {
  const marks = await h.t.db.system((sx) =>
    notebooksRepo.getNotebookMarks(sx, { ventureId: quietquad(), personaId: corinPersona() }),
  );
  return marks.personEdits;
}

async function proposalsFrom(sessionId: string): Promise<{ id: string; status: string; origin: string }[]> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT id, status, origin FROM memory_objects
       WHERE source_refs @> jsonb_build_array(jsonb_build_object('kind', 'session', 'id', CAST(:id AS text)))
       ORDER BY created_at`,
      { id: p.text(sessionId) },
    ),
  );
  return rows.rows as { id: string; status: string; origin: string }[];
}

interface LessonRow extends Record<string, unknown> {
  id: string;
  status: string;
  title: string;
  owner_id: string | null;
  source_session_id: string | null;
}

async function distilledLessons(): Promise<LessonRow[]> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT id, status, title, owner_id, source_session_id FROM patterns
       WHERE persona_id = :persona AND origin = 'distilled' ORDER BY created_at`,
      { persona: p.uuid(corinPersona()) },
    ),
  );
  return rows.rows as LessonRow[];
}

/** Usage-ledger rows of one purpose written under the given request ids. */
async function ledgerRows(purpose: string, requestIds: readonly string[]): Promise<number> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT count(*)::int AS n FROM usage_ledger WHERE purpose = :purpose AND request_id = ANY (:ids)`,
      { purpose: p.text(purpose), ids: p.textArray(requestIds) },
    ),
  );
  return (rows.rows[0] as { n: number }).n;
}

async function auditFor(action: string, objectId: string): Promise<Record<string, unknown>[]> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT action, outcome, metadata::text AS metadata, policy_reason FROM audit_events
       WHERE action = :action AND object_id = :id ORDER BY id`,
      { action: p.text(action), id: p.text(objectId) },
    ),
  );
  return rows.rows.map((r) => ({ ...r, metadata: JSON.parse(String(r.metadata)) as unknown }));
}

async function setSettings(patch: Parameters<typeof settingsRepo.updatePlatformSettings>[1]): Promise<void> {
  await h.t.db.system((sx) => settingsRepo.updatePlatformSettings(sx, patch, h.people.owner));
}

async function proposal(ctx: RequestContext, title: string, content: string): Promise<string> {
  // An AI proposal as a turn or distillation would leave it (owner role: AI items are never created by people).
  return h.t.db.system(async (sx) => {
    const record = await memoryRepo.createMemory(sx, {
      tenantId: h.seed.tenantId,
      ventureId: quietquad(),
      type: 'fact',
      title,
      content,
      status: 'proposed',
      visibility: 'team',
      origin: 'ai',
      createdBy: ctx.principalId,
      sourceRefs: [{ kind: 'manual', id: 'test' }],
    });
    return record.id;
  });
}

beforeAll(async () => {
  h = await createCoreHarness({ config: { turns: { rateLimit: 500 } } });
  maya = await h.ctxFor(h.people.maya);
  devin = await h.ctxFor(h.people.devin);
  priya = await h.ctxFor(h.people.priya);
  graham = await h.ctxFor(h.people.graham);
  corin = await h.ctxFor(h.people.eirCorin);
  const mock = new MockModelGateway({
    fixtures: {
      DistillDraft: (context) => (scripted ? scripted(context) : mockDistillDraft(context)),
    },
  });
  const gateway: ModelGateway = {
    info: mock.info,
    generateStructured: async <T>(request: GenerateStructuredRequest<T>) => {
      const failure = failNext;
      failNext = null;
      if (failure) throw failure;
      const result = await mock.generateStructured(request);
      const hook = whileAnswering;
      whileAnswering = null;
      if (hook) await hook();
      return result;
    },
    streamText: (request, onText) => mock.streamText(request, onText),
    embed: (texts, options) => mock.embed(texts, options),
  };
  scriptedCore = createCore({
    db: h.t.db,
    gateway,
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
  });
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

describe('triggers', () => {
  it('a completed turn of a standard conversation queues its distillation, delayed by 9 minutes', async () => {
    const id = await conversation(maya, ['We have two libraries interested in a pilot.']);
    h.jobQueue.drain();
    await h.core.distill.afterTurn(maya, id);
    expect(h.jobQueue.jobs).toEqual([
      {
        job: {
          type: 'distill_session',
          sessionId: id,
          tenantId: h.seed.tenantId,
          ventureId: quietquad(),
          turns: 1,
          requestId: maya.requestId,
        },
        deduplicationId: null,
        delaySeconds: 540,
      },
    ]);
    h.jobQueue.drain();
    await h.core.distill.afterEnd(maya, id);
    expect(h.jobQueue.jobs.map((j) => j.delaySeconds)).toEqual([0]);
    h.jobQueue.drain();
  });

  it('never queues a temporary chat, and never fails the request when the queue is down', async () => {
    const temporary = await conversation(maya, ['Just thinking out loud about pricing.'], {
      privacy: 'ephemeral',
    });
    h.jobQueue.drain();
    await h.core.distill.afterTurn(maya, temporary);
    await h.core.distill.afterEnd(maya, temporary);
    expect(h.jobQueue.jobs).toEqual([]);

    const standard = await conversation(maya, ['Pilot timing question.']);
    h.jobQueue.failNext = true;
    await expect(h.core.distill.afterTurn(maya, standard)).resolves.toBeUndefined();
    expect(h.logger.records.some((r) => r.event === 'distill.enqueue_failed')).toBe(true);
    h.jobQueue.drain();
  });

  it('starting a conversation queues the previous one when it is undistilled and idle', async () => {
    const previous = await conversation(devin, ['We could charge per room booked.']);
    await idle(previous, 30);
    const next = await h.core.sessions.create(devin, quietquad(), { mode: 'coach' });
    h.jobQueue.drain();
    await h.core.distill.afterCreate(devin, next);
    expect(
      h.jobQueue.jobs.map((j) => [
        j.job.type,
        'sessionId' in j.job ? j.job.sessionId : null,
        'turns' in j.job ? j.job.turns : null,
        j.delaySeconds,
      ]),
    ).toEqual([['distill_session', previous, 1, 0]]);

    // Still active (a turn 2 minutes ago): its own delayed job covers it.
    await completedTurn(devin, next.id, 'Rooms fill up during exam weeks.');
    await idle(next.id, 2);
    const third = await h.core.sessions.create(devin, quietquad(), { mode: 'coach' });
    h.jobQueue.drain();
    await h.core.distill.afterCreate(devin, third);
    expect(h.jobQueue.jobs).toEqual([]);
  });
});

describe('distillSession', () => {
  let sessionId: string;
  let versionBefore: number;

  it('skips cheaply while the conversation is active, and for temporary or empty ones', async () => {
    sessionId = await conversation(maya, [
      'We ran a pilot with two libraries and saw strong repeat use in the first week.',
      'I will interview five library staff about booking pain points before Friday.',
      'What should we charge libraries for the pilot?',
      'Our biggest risk is that students do not trust the occupancy sensors.',
    ]);
    const temporary = await conversation(maya, ['Private brainstorm.'], { privacy: 'ephemeral' });
    await idle(temporary, 20);
    const empty = await h.core.sessions.create(maya, quietquad(), { mode: 'diagnose' });
    const callsBefore = h.gateway.calls.length;
    expect(await h.core.distill.distillSession(job(sessionId))).toMatchObject({
      status: 'skipped',
      reason: 'active',
    });
    expect((await h.core.distill.distillSession(job(temporary))).reason).toBe('ephemeral');
    expect((await h.core.distill.distillSession(job(empty.id))).reason).toBe('no_turns');
    expect((await h.core.distill.distillSession(job('00000000-0000-4000-8000-000000000000'))).reason).toBe(
      'not_found',
    );
    expect(h.gateway.calls.length).toBe(callsBefore);
  });

  it('writes digest, title, notebook, memory proposals and lesson drafts in one go', async () => {
    versionBefore = (await notebook())?.version ?? 0;
    await idle(sessionId, 10);
    const outcome = await h.core.distill.distillSession(job(sessionId));
    expect(outcome).toMatchObject({ status: 'distilled', reason: null, turns: 4, lessonsDrafted: 1 });
    // The candidate ("Maya plans to interview five library staff…") restates what the second turn proposed
    // ("I will interview five library staff…"): that proposal is raised again instead of a duplicate.
    expect(outcome).toMatchObject({ memoryProposed: 0, memoryRepeated: 1 });

    const stored = await session(sessionId);
    expect(stored?.distillVersion).toBe(4);
    expect(stored?.digest?.summary).toMatch(/Maya came in to talk about/);
    expect(stored?.digest?.commitments.map((c) => c.text)).toEqual([
      'Interview five library staff about booking pain points before Friday',
    ]);
    expect(stored?.title).not.toBeNull();

    const nb = await notebook();
    expect(nb?.version).toBe(versionBefore + 1);
    expect(nb?.lastEditedBy).toBe('veir');
    const commitment = nb?.content.commitments.find((c) => c.sourceSessionId === sessionId);
    expect(commitment?.status).toBe('open');
    expect(commitment?.text).toMatch(/library staff/);
    expect(nb?.content.nextOpener).toMatch(/^Last time you planned to interview five library staff/);
    expect(await personEdits()).toEqual([]);

    const proposals = await proposalsFrom(sessionId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: 'proposed', origin: 'ai' });
    const raised = await h.core.memory.get(maya, proposals[0]?.id ?? '');
    expect(raised.sourceRefs.map((r) => r.kind)).toEqual(expect.arrayContaining(['turn', 'session']));
    expect(raised.content).toMatch(/I will interview five library staff/);
    // The conversation's turn proposals were embedded for the comparison by meaning.
    const unembedded = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM memory_objects m JOIN turns t ON m.source_refs @> jsonb_build_array(
           jsonb_build_object('kind', 'turn', 'id', CAST(t.id AS text)))
         WHERE t.session_id = :id AND m.status = 'proposed' AND m.embedding IS NULL`,
        { id: p.uuid(sessionId) },
      ),
    );
    expect(unembedded.rows[0]).toEqual({ n: 0 });
    const lessons = await distilledLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ status: 'draft', owner_id: null, source_session_id: sessionId });

    // Metered as `distill`, billed to the founder whose conversation it is.
    const usage = await h.t.db.system((sx) =>
      sx.query(`SELECT principal_id, venture_id FROM usage_ledger WHERE purpose = 'distill'`),
    );
    expect(usage.rows).toEqual([{ principal_id: h.people.maya, venture_id: quietquad() }]);

    // Audited with ids and counts only; nothing the founder said reaches the audit or the logs.
    const [event] = await auditFor('session.distilled', sessionId);
    expect(event?.metadata).toMatchObject({
      turns: 4,
      memoryProposed: 0,
      memoryRepeated: 1,
      lessonsDrafted: 1,
      lessonIds: [lessons[0]?.id],
    });
    const leaked = JSON.stringify([event, h.logger.records]);
    expect(leaked).not.toMatch(/booking pain points|occupancy sensors|repeat use/);
  });

  it('is idempotent per turn count: a second job changes nothing and calls no model', async () => {
    const calls = h.gateway.calls.length;
    const version = (await notebook())?.version;
    expect(await h.core.distill.distillSession(job(sessionId))).toMatchObject({
      status: 'skipped',
      reason: 'up_to_date',
    });
    expect(h.gateway.calls.length).toBe(calls);
    expect((await notebook())?.version).toBe(version);
    expect(await proposalsFrom(sessionId)).toHaveLength(1);
    expect(await distilledLessons()).toHaveLength(1);
  });

  it('distils the new turns of a conversation that continued, without duplicating proposals or lessons', async () => {
    await completedTurn(maya, sessionId, 'The library staff said booking is the biggest pain.');
    await idle(sessionId, 12);
    const outcome = await h.core.distill.distillSession(job(sessionId));
    expect(outcome).toMatchObject({ status: 'distilled', turns: 5, memoryProposed: 0, lessonsDrafted: 0 });
    expect(outcome.memoryRepeated).toBe(1);
    expect((await session(sessionId))?.distillVersion).toBe(5);
    expect(await proposalsFrom(sessionId)).toHaveLength(1);
    expect(await distilledLessons()).toHaveLength(1);
  });

  it('skips while AI is paused and when the spend cap is reached, without touching the conversation', async () => {
    const id = await conversation(devin, ['Exam weeks double demand for rooms.']);
    await idle(id, 15);
    await setSettings({ aiEnabled: false });
    try {
      expect(await h.core.distill.distillSession(job(id))).toMatchObject({
        status: 'skipped',
        reason: 'kill_switch',
      });
    } finally {
      await setSettings({ aiEnabled: true });
    }
    await setSettings({ dailyUsdCapPerPrincipal: 0 });
    try {
      expect(await h.core.distill.distillSession(job(id))).toMatchObject({
        status: 'skipped',
        reason: 'spend_cap',
      });
    } finally {
      await setSettings({ dailyUsdCapPerPrincipal: 0.5 });
    }
    expect((await session(id))?.distillVersion).toBe(0);
    expect((await h.core.distill.distillSession(job(id))).status).toBe('distilled');
  });

  it('retries an unavailable model, records an unusable answer so it is not retried until a new turn', async () => {
    const id = await conversation(devin, ['Should we pilot in one more library?']);
    await idle(id, 15);
    h.gateway.scriptNext('unavailable');
    await expect(h.core.distill.distillSession(job(id))).rejects.toBeInstanceOf(RetryableDistillError);
    expect((await session(id))?.distillVersion).toBe(0);

    // An invalid answer gets one more delivery of the queued job, then it is recorded.
    const delivery = (attempt: number) => ({ attempt, maxAttempts: 3 });
    h.gateway.scriptNext('invalid_output');
    await expect(h.core.distill.distillSession(job(id), delivery(1))).rejects.toBeInstanceOf(
      RetryableDistillError,
    );
    expect((await session(id))?.distillVersion).toBe(0);
    h.gateway.scriptNext('invalid_output');
    expect(await h.core.distill.distillSession(job(id), delivery(2))).toMatchObject({
      status: 'failed',
      reason: 'model_output_invalid',
    });
    const after = await session(id);
    expect(after?.distillVersion).toBe(1);
    expect(after?.digest).toBeNull();
    const [event] = await auditFor('session.distill_failed', id);
    expect(event).toMatchObject({ outcome: 'failed', policy_reason: 'model_output_invalid' });
  });

  it('records a configuration error at once, and retries a call cancelled at the deadline', async () => {
    const id = await conversation(devin, ['Is a semester pilot long enough?']);
    await idle(id, 15);
    failNext = new ModelUnavailableError('aborted', 'mock');
    await expect(
      scriptedCore.distill.distillSession(job(id), { attempt: 1, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(RetryableDistillError);
    expect((await session(id))?.distillVersion).toBe(0);
    // Model access not granted: no delivery will fix it, so it does not wait in the queue and the backstop.
    failNext = new ModelUnavailableError('config', 'mock');
    expect(await scriptedCore.distill.distillSession(job(id), { attempt: 1, maxAttempts: 3 })).toMatchObject({
      status: 'failed',
      reason: 'model_unavailable:config',
    });
    expect((await session(id))?.distillVersion).toBe(1);
    // A refused or invalid answer inline (the backstop has no second delivery) is recorded at once.
    const inline = await conversation(devin, ['Should the pilot be free?']);
    await idle(inline, 15);
    failNext = new ModelOutputInvalidError('mock', ['(root): scripted']);
    expect(await scriptedCore.distill.distillSession(job(inline))).toMatchObject({ status: 'failed' });
  });

  it('drops the whole result when it names another venture', async () => {
    const id = await conversation(devin, ['How do other founders price pilots?']);
    await idle(id, 15);
    scripted = (context) => {
      const draft = mockDistillDraft(context);
      return { ...draft, digest: { ...draft.digest, summary: 'They compared notes with BenchTally.' } };
    };
    try {
      expect(await scriptedCore.distill.distillSession(job(id))).toMatchObject({
        status: 'dropped',
        reason: 'cross_venture',
      });
    } finally {
      scripted = null;
    }
    expect((await session(id))?.digest).toBeNull();
    expect((await session(id))?.distillVersion).toBe(1);
  });

  it('never writes a digest for a conversation deleted, or whose digest was deleted, in the meantime', async () => {
    const deleted = await conversation(devin, ['A thought I will delete.']);
    await idle(deleted, 15);
    await h.core.sessions.remove(devin, deleted);
    expect((await h.core.distill.distillSession(job(deleted))).reason).toBe('deleted');

    const digestDeleted = await conversation(devin, ['A conversation whose digest I remove.']);
    await idle(digestDeleted, 15);
    expect((await h.core.distill.distillSession(job(digestDeleted))).status).toBe('distilled');
    await h.core.sessions.deleteDigest(devin, digestDeleted);
    await completedTurn(devin, digestDeleted, 'One more thing.');
    await idle(digestDeleted, 15);
    expect((await h.core.distill.distillSession(job(digestDeleted))).reason).toBe('digest_deleted');
    expect((await session(digestDeleted))?.digest).toBeNull();
  });
});

describe('the notebook merge respects people', () => {
  it('keeps lines a person edited, never writes back removed lines, and clears the marks after', async () => {
    const before = await notebook();
    if (before === null) throw new Error('notebook missing');
    const [kept, removed] = before.content.founderProfile;
    if (kept === undefined || removed === undefined) throw new Error('seed notebook too small');
    const edited = await h.core.notebook.update(maya, quietquad(), {
      expectedVersion: before.version,
      edit: {
        action: 'edit_entry',
        section: 'founderProfile',
        id: kept.id,
        text: 'Prefers voice notes to long emails',
      },
    });
    const trimmed = await h.core.notebook.update(maya, quietquad(), {
      expectedVersion: edited.version,
      edit: { action: 'remove_entry', section: 'founderProfile', id: removed.id },
    });
    await h.core.notebook.update(maya, quietquad(), {
      expectedVersion: trimmed.version,
      edit: { action: 'edit_opener', text: 'How did the staff interviews go?' },
    });
    expect((await personEdits()).sort()).toEqual([kept.id, 'nextOpener'].sort());

    const id = await conversation(maya, ['The staff interviews went well; three of five want the pilot.']);
    await idle(id, 15);
    scripted = (context) => {
      const draft = mockDistillDraft(context);
      return {
        ...draft,
        notebook: {
          ...draft.notebook,
          founder_profile: [
            // The model rewrites the person's correction, and re-proposes the line they removed.
            { id: kept.id, text: 'Likes long, detailed emails' },
            { id: null, text: removed.text },
            { id: null, text: 'Celebrates small wins with the team' },
          ],
          next_opener: 'Did the pilot contract arrive?',
        },
      };
    };
    try {
      expect((await scriptedCore.distill.distillSession(job(id))).status).toBe('distilled');
    } finally {
      scripted = null;
    }
    const after = await notebook();
    const profile = after?.content.founderProfile.map((e) => e.text) ?? [];
    expect(profile).toContain('Prefers voice notes to long emails');
    expect(profile).not.toContain('Likes long, detailed emails');
    expect(profile).not.toContain(removed.text);
    expect(profile).toContain('Celebrates small wins with the team');
    expect(after?.content.nextOpener).toBe('How did the staff interviews go?');
    expect(after?.lastEditedBy).toBe('veir');
    expect(await personEdits()).toEqual([]);
  });

  it('merges a person edit made while the model was writing instead of overwriting it', async () => {
    const id = await conversation(maya, ['We signed one library for the pilot.']);
    await idle(id, 15);
    const before = await notebook();
    const [, second] = before?.content.founderProfile ?? [];
    if (before === null || second === undefined) throw new Error('notebook too small');
    whileAnswering = async () => {
      // A teammate corrects the summary and removes a line the model was shown, mid-call.
      const v1 = await h.core.notebook.update(devin, quietquad(), {
        expectedVersion: before.version,
        edit: { action: 'edit_summary', summary: 'One library signed; the second decides next month.' },
      });
      await h.core.notebook.update(devin, quietquad(), {
        expectedVersion: v1.version,
        edit: { action: 'remove_entry', section: 'founderProfile', id: second.id },
      });
    };
    expect((await scriptedCore.distill.distillSession(job(id))).status).toBe('distilled');
    const after = await notebook();
    expect(after?.version).toBe(before.version + 3);
    expect(after?.lastEditedBy).toBe('veir');
    expect(after?.content.summary).toBe('One library signed; the second decides next month.');
    expect(after?.content.founderProfile.map((e) => e.text)).not.toContain(second.text);
    expect(after?.content.commitments.length).toBeGreaterThan(0);
  });
});

describe('memory hygiene', () => {
  it('raises a pending proposal again instead of duplicating it, and drops restated or rejected items', async () => {
    const pending = await proposal(maya, 'Libraries pay per room', 'Libraries would pay per bookable room.');
    const confirmed = await h.core.memory.create(maya, quietquad(), {
      type: 'decision',
      title: 'Pilot runs during exam weeks',
      content: 'The pilot runs during the two exam weeks.',
    });
    const rejected = await proposal(
      maya,
      'Paper sheets',
      'Students prefer paper sign-up sheets on the door.',
    );
    await h.core.memory.act(maya, rejected, { action: 'reject' });
    // Worded differently from everything, but the same meaning by embedding (cosine 1 here).
    const paraphrase = {
      title: 'Distrust of occupancy readings',
      content: 'Occupancy numbers may not be believed.',
    };
    const [vector] = (await h.gateway.embed([memoryEmbeddingText(paraphrase)], { purpose: 'embedding' }))
      .vectors;
    const embedded = await proposal(
      maya,
      'Sensor trust is the main risk',
      'Students may not trust occupancy data.',
    );
    await h.t.db.system((sx) =>
      sx.query('UPDATE memory_objects SET embedding = CAST(:v AS vector) WHERE id = :id', {
        id: p.uuid(embedded),
        v: p.text(`[${(vector ?? []).join(',')}]`),
      }),
    );

    const id = await conversation(maya, ['Pricing per room seems right.']);
    const fromTurn = (await proposalsFrom(id)).length;
    await idle(id, 15);
    const candidate = (
      type: 'fact' | 'decision' | 'insight',
      title: string,
      content: string,
      confidence = 0.6,
    ) => ({
      type,
      title,
      content,
      evidence_ids: [],
      confidence,
    });
    scripted = (context) => ({
      ...mockDistillDraft(context),
      memory_candidates: [
        candidate('fact', 'Per-room pricing', 'Libraries would pay per bookable room.', 0.9),
        candidate('decision', 'Exam weeks', 'The pilot runs during the two exam weeks.'),
        candidate('insight', paraphrase.title, paraphrase.content),
      ],
      lesson_candidates: [],
    });
    let outcome;
    try {
      outcome = await scriptedCore.distill.distillSession(job(id));
    } finally {
      scripted = null;
    }
    expect(outcome).toMatchObject({ status: 'distilled', memoryProposed: 0, memoryRepeated: 2 });
    const raised = await h.core.memory.get(maya, pending);
    expect(raised.sourceRefs.map((r) => r.id)).toContain(id);
    expect(raised.confidence).toBe(0.9);
    const history = await h.core.memory.history(maya, pending);
    expect(history.at(-1)).toMatchObject({ action: 'proposed', diff: { repeated: true } });
    expect((await h.core.memory.get(maya, embedded)).sourceRefs.map((r) => r.id)).toContain(id);
    expect((await h.core.memory.get(maya, confirmed.id)).sourceRefs.map((r) => r.id)).not.toContain(id);
    expect(await proposalsFrom(id)).toHaveLength(fromTurn + 2);

    // A rejected suggestion is never raised again, even word for word.
    const again = await conversation(maya, ['Paper sheets again?']);
    await idle(again, 15);
    scripted = (context) => ({
      ...mockDistillDraft(context),
      memory_candidates: [candidate('fact', 'Paper', 'Students prefer paper sign-up sheets on the door.')],
      lesson_candidates: [],
    });
    try {
      expect(await scriptedCore.distill.distillSession(job(again))).toMatchObject({
        memoryProposed: 0,
        memoryRepeated: 0,
      });
    } finally {
      scripted = null;
    }
    expect((await h.core.memory.get(maya, rejected)).status).toBe('rejected');
  });

  it('applies the same deduplication to the proposals of turns', async () => {
    const text = 'Our sensors log occupancy every five minutes in each study room.';
    const first = await conversation(maya, [text]);
    const second = await conversation(maya, [text]);
    const [created] = await h.t.db.system((sx) =>
      sx
        .query(
          `SELECT id, source_refs::text AS refs FROM memory_objects
           WHERE venture_id = :v AND origin = 'ai' AND status = 'proposed' AND content LIKE :quote`,
          { v: p.uuid(quietquad()), quote: p.text(`%${text}%`) },
        )
        .then((r) =>
          r.rows.map((row) => ({
            id: String(row.id),
            refs: JSON.parse(String(row.refs)) as { kind: string; id: string }[],
          })),
        ),
    );
    const rows = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM memory_objects
         WHERE venture_id = :v AND origin = 'ai' AND content LIKE :quote`,
        { v: p.uuid(quietquad()), quote: p.text(`%${text}%`) },
      ),
    );
    expect(rows.rows[0]).toEqual({ n: 1 });
    const turns = await h.t.db.system((sx) =>
      sx.query('SELECT id FROM turns WHERE session_id = ANY (:ids)', { ids: p.uuidArray([first, second]) }),
    );
    const refs = (created?.refs ?? []).filter((r) => r.kind === 'turn').map((r) => r.id);
    expect(refs.sort()).toEqual((turns.rows as { id: string }[]).map((t) => t.id).sort());
  });

  it('daily maintenance expires AI proposals nobody acted on for 30 days, and nothing else', async () => {
    const stale = await proposal(maya, 'Old idea about vending machines', 'Vending machines in study rooms.');
    const fresh = await proposal(maya, 'New idea about badges', 'Badges for frequent bookers.');
    const staleConfirmed = await h.core.memory.create(maya, quietquad(), {
      type: 'fact',
      title: 'Founded in spring',
      content: 'The venture started in spring.',
    });
    await h.t.db.system((sx) =>
      sx.query(`UPDATE memory_objects SET updated_at = now() - interval '31 days' WHERE id = ANY (:ids)`, {
        ids: p.uuidArray([stale, staleConfirmed.id]),
      }),
    );
    const report = await h.core.maintenance.runDaily({ requestId: 'maintenance-test' });
    expect(report.proposalsExpired).toBeGreaterThanOrEqual(1);
    const items = await h.t.db.system((sx) =>
      memoryRepo.getMemoryByIds(sx, [stale, fresh, staleConfirmed.id]),
    );
    const status = Object.fromEntries(items.map((m) => [m.id, m.status]));
    expect(status).toEqual({ [stale]: 'expired', [fresh]: 'proposed', [staleConfirmed.id]: 'confirmed' });
    const events = await h.t.db.system((sx) => memoryRepo.listMemoryHistory(sx, stale));
    // Nobody acted: the event says so (it names the person the proposal was for only as its subject).
    expect(events.at(-1)).toMatchObject({
      action: 'expired',
      actor: { id: h.people.maya },
      diff: { system: true, reason: 'not_reviewed' },
    });
    // The approval CHECK still forbids a confirmed AI item without a person.
    await expect(
      h.t.db.system((sx) =>
        sx.query(`UPDATE memory_objects SET status = 'confirmed', approved_by = NULL WHERE id = :id`, {
          id: p.uuid(fresh),
        }),
      ),
    ).rejects.toThrow();
  });

  it('daily maintenance distils idle conversations no trigger covered (the backstop)', async () => {
    const id = await conversation(devin, ['Nobody ended this conversation.']);
    await idle(id, 60);
    const report = await h.core.maintenance.runDaily({ requestId: 'maintenance-backstop' });
    expect(report.distillation.distilled).toBeGreaterThanOrEqual(1);
    expect((await session(id))?.distillVersion).toBe(1);
    // A deadline that leaves no time defers the rest instead of starting a distillation.
    await completedTurn(devin, id, 'One more.');
    await idle(id, 60);
    const deferred = await h.core.distill.backstop({ requestId: 'backstop-deadline', deadline: Date.now() });
    expect(deferred).toMatchObject({ distilled: 0 });
    expect(deferred.deferred).toBeGreaterThanOrEqual(1);
  });
});

describe('batch review of memory proposals', () => {
  it('approves pending proposals of the venture and reports everything else as skipped', async () => {
    const a = await proposal(maya, 'Batch item A', 'First proposal to approve.');
    const b = await proposal(maya, 'Batch item B', 'Second proposal to approve.');
    const confirmed = await h.core.memory.create(maya, quietquad(), {
      type: 'fact',
      title: 'Already confirmed',
      content: 'Confirmed by the founder.',
    });
    const other = (await h.core.memory.list(priya, h.ventures.benchtally.id, { status: 'proposed' }))
      .items[0];
    if (other === undefined) throw new Error('no pending BenchTally proposal');
    const otherVenture = other.id;
    const unknown = '00000000-0000-4000-8000-0000000000aa';
    const result = await h.core.memory.batch(devin, quietquad(), {
      ids: [a, b, confirmed.id, otherVenture, unknown, a],
      action: 'approve',
    });
    expect(result.items.map((i) => MemoryObjectView.parse(i).status)).toEqual(['confirmed', 'confirmed']);
    expect(result.items.map((i) => i.id)).toEqual([a, b]);
    expect(result.items[0]?.approvedBy?.id).toBe(h.people.devin);
    expect(result.skippedIds).toEqual([confirmed.id, otherVenture, unknown]);
    const [event] = await auditFor('memory.approved', a);
    expect(event?.metadata).toMatchObject({ from: 'proposed', to: 'confirmed', batch: true });
    // Untouched in the other venture.
    expect((await h.core.memory.get(priya, otherVenture)).status).toBe('proposed');
  });

  it('rejects in batch', async () => {
    const c = await proposal(maya, 'Batch item C', 'A proposal to reject.');
    const result = await h.core.memory.batch(maya, quietquad(), { ids: [c], action: 'reject' });
    expect(result.items.map((i) => i.status)).toEqual(['rejected']);
    expect(result.skippedIds).toEqual([]);
  });

  it('refuses people who may not write the venture, and audits the denial', async () => {
    const d = await proposal(maya, 'Batch item D', 'Nobody outside may approve this.');
    await expect(
      h.core.memory.batch(priya, quietquad(), { ids: [d], action: 'approve' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.core.memory.batch(graham, h.ventures.solesignal.id, { ids: [d], action: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.core.memory.batch(corin, quietquad(), { ids: [d], action: 'approve' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await h.core.memory.get(maya, d)).status).toBe('proposed');
    const denied = await h.t.db.system((sx) =>
      sx.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action = 'venture.access' AND outcome = 'denied' AND actor_id = :actor`,
        { actor: p.uuid(h.people.priya) },
      ),
    );
    expect((denied.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
  });
});

describe('escalation resolutions feed the notebook', () => {
  async function resolvedEscalation(category: 'expert_judgment' | 'safety_wellbeing', summary: string) {
    const created = await h.core.escalations.create(maya, quietquad(), {
      category,
      priority: 'P2',
      requestedRole: 'eir',
      founderQuestion: 'Should we sign the second library before the pilot ends?',
    });
    await h.core.escalations.act(maya, created.id, { action: 'approve_sharing', sharedMemoryIds: [] });
    await h.core.escalations.act(corin, created.id, { action: 'acknowledge' });
    return h.core.escalations.act(corin, created.id, {
      action: 'resolve',
      resolution: { summary, nextSteps: ['Ask for a letter of intent'] },
    });
  }

  it('adds the resolution as attributed advice the team can correct', async () => {
    const resolved = await resolvedEscalation('expert_judgment', 'Wait for the pilot data before signing');
    const nb = await notebook();
    const line = nb?.content.lastAdvice[0];
    expect(line).toMatchObject({
      id: resolutionEntryId(resolved.id),
      text: 'From Corin Halvorsen (human help): Wait for the pilot data before signing. Next: Ask for a letter of intent',
    });
    expect(nb?.content.lastAdvice.length).toBeLessThanOrEqual(5);
    expect(nb?.lastEditedBy).toBe('person');
    // Pinned for the next distillation, like a person's edit; correctable by the team.
    expect(await personEdits()).toContain(resolutionEntryId(resolved.id));
    const updated = await h.core.notebook.update(maya, quietquad(), {
      expectedVersion: nb?.version ?? 0,
      edit: { action: 'remove_entry', section: 'lastAdvice', id: resolutionEntryId(resolved.id) },
    });
    expect(updated.lastAdvice.some((e) => e.id === resolutionEntryId(resolved.id))).toBe(false);
    const [event] = await auditFor('notebook.advice_added', nb?.id ?? '');
    expect(event?.metadata).toMatchObject({ escalationId: resolved.id, personaId: corinPersona() });
    expect(JSON.stringify(event)).not.toMatch(/pilot data/);
  });

  it('keeps wellbeing matters out of the coaching notebook', async () => {
    const before = (await notebook())?.version;
    const resolved = await resolvedEscalation('safety_wellbeing', 'Talked through the workload with Maya');
    expect(resolved.status).toBe('resolved');
    expect((await notebook())?.version).toBe(before);
  });
});

describe('one model call per conversation', () => {
  it('leaves a job queued at fewer turns to the later turn, without a model call', async () => {
    const id = await conversation(devin, ['Rooms run out in exam weeks.', 'We could text students.']);
    await idle(id, 15);
    const calls = h.gateway.calls.length;
    expect(await h.core.distill.distillSession({ ...job(id), queuedTurns: 1 })).toMatchObject({
      status: 'skipped',
      reason: 'superseded',
    });
    expect(h.gateway.calls.length).toBe(calls);
    expect((await h.core.distill.distillSession({ ...job(id), queuedTurns: 2 })).status).toBe('distilled');
  });

  it('a job arriving while another distils the conversation skips, and pays for nothing', async () => {
    const id = await conversation(devin, ['Booking pain peaks on Sunday nights.']);
    await idle(id, 15);
    const outer = job(id);
    let inner: Awaited<ReturnType<Core['distill']['distillSession']>> | null = null;
    const innerJob = job(id);
    whileAnswering = async () => {
      inner = await scriptedCore.distill.distillSession(innerJob);
    };
    expect((await scriptedCore.distill.distillSession(outer)).status).toBe('distilled');
    expect(inner).toMatchObject({ status: 'skipped', reason: 'in_progress' });
    expect(await ledgerRows('distill', [outer.requestId, innerJob.requestId])).toBe(1);
    // The claim is released after the write.
    const claim = await h.t.db.system((sx) =>
      sx.query('SELECT distill_claim_id, distill_claimed_until FROM coaching_sessions WHERE id = :id', {
        id: p.uuid(id),
      }),
    );
    expect(claim.rows[0]).toEqual({ distill_claim_id: null, distill_claimed_until: null });
  });

  it('jobs started together call the model once', async () => {
    const id = await conversation(devin, ['Two libraries asked for weekly reports.']);
    await idle(id, 15);
    const jobs = [job(id), job(id), job(id)];
    const outcomes = await Promise.all(jobs.map((j) => h.core.distill.distillSession(j)));
    expect(outcomes.filter((o) => o.status === 'distilled')).toHaveLength(1);
    expect(
      await ledgerRows(
        'distill',
        jobs.map((j) => j.requestId),
      ),
    ).toBe(1);
  });

  it('a claim left by a run that died lapses, and the next job distils', async () => {
    const id = await conversation(devin, ['Weekend demand is flat.']);
    await idle(id, 15);
    const hold = (interval: string) =>
      h.t.db.system((sx) =>
        sx.query(
          `UPDATE coaching_sessions SET distill_claim_id = gen_random_uuid(),
             distill_claimed_until = now() + CAST(:i AS interval) WHERE id = :id`,
          { id: p.uuid(id), i: p.text(interval) },
        ),
      );
    await hold('5 minutes');
    expect((await h.core.distill.distillSession(job(id))).reason).toBe('in_progress');
    await hold('-1 second');
    expect((await h.core.distill.distillSession(job(id))).status).toBe('distilled');
  });
});

describe('the persona and its consent', () => {
  const setPersonaStatus = (status: 'active' | 'suspended') =>
    h.t.db.system((sx) =>
      sx.query('UPDATE personas SET status = :status WHERE id = :id', {
        id: p.uuid(corinPersona()),
        status: p.text(status),
      }),
    );

  async function expectNothingWritten(id: string, notebookVersion: number | undefined): Promise<void> {
    expect((await session(id))?.digest).toBeNull();
    // Recorded at its turn count: not retried until a new turn.
    expect((await session(id))?.distillVersion).toBe(2);
    expect((await notebook())?.version).toBe(notebookVersion);
    expect((await distilledLessons()).filter((l) => l.source_session_id === id)).toEqual([]);
    const [event] = await auditFor('session.distill_dropped', id);
    expect(event).toMatchObject({ policy_reason: 'persona_inactive' });
  }

  it('never distils for a suspended persona: no model call, no notes, no lesson drafts', async () => {
    const id = await conversation(devin, ['We should price per semester.', 'Libraries budget per term.']);
    await idle(id, 15);
    const version = (await notebook())?.version;
    const calls = h.gateway.calls.length;
    await setPersonaStatus('suspended');
    try {
      expect(await h.core.distill.distillSession(job(id))).toMatchObject({
        status: 'dropped',
        reason: 'persona_inactive',
      });
    } finally {
      await setPersonaStatus('active');
    }
    expect(h.gateway.calls.length).toBe(calls);
    await expectNothingWritten(id, version);
  });

  it('never distils once the EIR consent lapsed', async () => {
    const id = await conversation(devin, ['Our pilot ends in May.', 'Renewal talks start in April.']);
    await idle(id, 15);
    const version = (await notebook())?.version;
    const lapse = (expired: boolean) =>
      h.t.db.system((sx) =>
        sx.query(
          `UPDATE consents SET expires_at = CASE WHEN :expired THEN now() - interval '1 day' ELSE NULL END
           WHERE id = (SELECT consent_id FROM personas WHERE id = :persona)`,
          { expired: p.bool(expired), persona: p.uuid(corinPersona()) },
        ),
      );
    await lapse(true);
    try {
      expect((await h.core.distill.distillSession(job(id))).reason).toBe('persona_inactive');
    } finally {
      await lapse(false);
    }
    await expectNothingWritten(id, version);
  });

  it('writes nothing when the persona is suspended while the model answers', async () => {
    const id = await conversation(devin, ['We need a second campus.', 'The north campus has two libraries.']);
    await idle(id, 15);
    const version = (await notebook())?.version;
    whileAnswering = () => setPersonaStatus('suspended').then(() => undefined);
    try {
      expect((await scriptedCore.distill.distillSession(job(id))).reason).toBe('persona_inactive');
    } finally {
      await setPersonaStatus('active');
    }
    await expectNothingWritten(id, version);
  });
});

describe('memory hygiene by meaning', () => {
  it('embeds pending proposals first, so a candidate worded differently raises one again', async () => {
    const content =
      'Libraries want weekly occupancy reports for every study room in the main building during the exam period.';
    const pending = await proposal(maya, 'Weekly occupancy reports', content);
    const id = await conversation(maya, ['What should the reports look like?']);
    await idle(id, 15);
    scripted = (context) => ({
      ...mockDistillDraft(context),
      memory_candidates: [
        {
          type: 'fact',
          title: 'Weekly occupancy reports',
          content: content.replace('exam period', 'exam season'),
          evidence_ids: [],
          confidence: 0.7,
        },
      ],
      lesson_candidates: [],
    });
    try {
      expect(await scriptedCore.distill.distillSession(job(id))).toMatchObject({
        status: 'distilled',
        memoryProposed: 0,
        memoryRepeated: 1,
      });
    } finally {
      scripted = null;
    }
    const raised = await h.t.db.system((sx) => memoryRepo.getMemory(sx, pending));
    expect(raised?.hasEmbedding).toBe(true);
    expect(raised?.sourceRefs.map((r) => r.id)).toContain(id);
  });
});

describe('lesson drafts follow their conversation', () => {
  // De-identified like the mock's own lessons (the venture's partners and documents are denylisted).
  const lesson = {
    title: 'Ask for a small deposit before settling a price',
    context:
      'A founder was choosing a price for a first paid pilot before any customer had paid for a comparable solution.',
    signal: 'Prospects praised the idea but became vague whenever payment came up.',
    intervention: 'Ask for a small paid commitment early instead of asking whether people would pay.',
    outcome: 'Talks moved from opinions to commitments.',
    limits: 'Works best when the user and the buyer are the same person.',
  };
  const withLesson = (title: string) => (context: MockGenerateContext) => ({
    ...mockDistillDraft(context),
    lesson_candidates: [{ ...lesson, title }],
  });

  it('deleting the conversation withdraws its drafts; a draft in review stays with the curator', async () => {
    const first = await conversation(devin, ['Renewal is in May.', 'The dean reads the report.']);
    const second = await conversation(devin, ['The pilot ends soon.', 'The budget holder asks for value.']);
    await idle(first, 15);
    await idle(second, 15);
    scripted = withLesson(lesson.title);
    try {
      expect((await scriptedCore.distill.distillSession(job(first))).lessonsDrafted).toBe(1);
      scripted = withLesson('Turn praise into a paid commitment early');
      expect((await scriptedCore.distill.distillSession(job(second))).lessonsDrafted).toBe(1);
    } finally {
      scripted = null;
    }
    const [draft] = (await distilledLessons()).filter((l) => l.source_session_id === first);
    const [reviewed] = (await distilledLessons()).filter((l) => l.source_session_id === second);
    if (draft === undefined || reviewed === undefined) throw new Error('drafts missing');
    await h.t.db.system((sx) =>
      sx.query(`UPDATE patterns SET status = 'in_review' WHERE id = :id`, { id: p.uuid(reviewed.id) }),
    );
    await h.core.sessions.remove(devin, first);
    await h.core.sessions.remove(devin, second);
    const after = new Map((await distilledLessons()).map((l) => [l.id, l.status]));
    expect(after.get(draft.id)).toBe('withdrawn');
    expect(after.get(reviewed.id)).toBe('in_review');
  });

  it('never drafts again a lesson a curator withdrew', async () => {
    const id = await conversation(devin, ['Renewal again.', 'Same report question.']);
    await idle(id, 15);
    scripted = withLesson(lesson.title);
    try {
      expect(await scriptedCore.distill.distillSession(job(id))).toMatchObject({
        status: 'distilled',
        lessonsDrafted: 0,
      });
    } finally {
      scripted = null;
    }
  });
});

describe('two distillations of one notebook', () => {
  it('runs again on the notebook another distillation wrote meanwhile, losing neither', async () => {
    const mine = await conversation(maya, ['We will add a second campus next term.']);
    const theirs = await conversation(devin, ['Should we charge per room or per seat?']);
    await idle(mine, 15);
    await idle(theirs, 15);
    const [reworded] = (await notebook())?.content.founderProfile ?? [];
    if (reworded === undefined) throw new Error('notebook too small');
    const run = job(mine);
    whileAnswering = async () => {
      // The other conversation's distillation rewords a line and adds an open question meanwhile.
      scripted = (context) => {
        const draft = mockDistillDraft(context);
        const profile = draft.notebook.founder_profile.map((n) =>
          n.id === reworded.id ? { id: n.id, text: 'Reasons from numbers before deciding' } : n,
        );
        return { ...draft, notebook: { ...draft.notebook, founder_profile: profile } };
      };
      try {
        expect((await scriptedCore.distill.distillSession(job(theirs))).status).toBe('distilled');
      } finally {
        scripted = null;
      }
    };
    expect((await scriptedCore.distill.distillSession(run)).status).toBe('distilled');

    // Neither the rewording nor the question was taken for a person's removal.
    const after = (await notebook())?.content;
    const profile = after?.founderProfile.map((e) => e.text) ?? [];
    expect(profile).toContain('Reasons from numbers before deciding');
    expect(profile).not.toContain(reworded.text);
    expect(after?.openQuestions.map((e) => e.text)).toContain('Should we charge per room or per seat?');
    expect(after?.commitments.map((c) => c.text)).toContain('Add a second campus next term');
    // The first answer was set aside (the notebook changed under it) and the model asked again.
    expect(await ledgerRows('distill', [run.requestId])).toBe(2);
    expect(h.logger.records.some((r) => r.event === 'distill.notebook_changed')).toBe(true);
  });
});

describe('human help in the notebook', () => {
  it('keeps the advice an EIR gave across distillations until newer advice pushes it out', async () => {
    const created = await h.core.escalations.create(maya, quietquad(), {
      category: 'expert_judgment',
      priority: 'P2',
      requestedRole: 'eir',
      founderQuestion: 'Do we need a data agreement with each library?',
    });
    await h.core.escalations.act(maya, created.id, { action: 'approve_sharing', sharedMemoryIds: [] });
    await h.core.escalations.act(corin, created.id, { action: 'acknowledge' });
    await h.core.escalations.act(corin, created.id, {
      action: 'resolve',
      resolution: { summary: 'Use one data agreement template for every library', nextSteps: [] },
    });
    const line = resolutionEntryId(created.id);
    const advice = async () => (await notebook())?.content.lastAdvice ?? [];
    const original = (await advice()).find((e) => e.id === line);
    expect(original).toBeDefined();

    // Twice the model leaves it out (the second time it is no longer a fresh person edit).
    for (const text of ['Data agreements again.', 'And the template?']) {
      const id = await conversation(maya, [text]);
      await idle(id, 15);
      scripted = (context) => {
        const draft = mockDistillDraft(context);
        return { ...draft, notebook: { ...draft.notebook, last_advice: [] } };
      };
      try {
        expect((await scriptedCore.distill.distillSession(job(id))).status).toBe('distilled');
      } finally {
        scripted = null;
      }
      expect((await advice()).find((e) => e.id === line)).toEqual(original);
      expect(await personEdits()).toEqual([]);
    }

    // Five newer lines of advice push it out, oldest first.
    const id = await conversation(maya, ['What else should we do?']);
    await idle(id, 15);
    scripted = (context) => {
      const draft = mockDistillDraft(context);
      const fresh = [
        'Ship the report',
        'Call the dean',
        'Price per term',
        'Recruit a second campus',
        'Hire help',
      ];
      return {
        ...draft,
        notebook: { ...draft.notebook, last_advice: fresh.map((text) => ({ id: null, text })) },
      };
    };
    try {
      expect((await scriptedCore.distill.distillSession(job(id))).status).toBe('distilled');
    } finally {
      scripted = null;
    }
    expect((await advice()).map((e) => e.id)).not.toContain(line);
    expect(await advice()).toHaveLength(5);
  });
});

describe('daily maintenance', () => {
  it('a failing proposal expiry never undoes the erasure of temporary chats', async () => {
    const id = await conversation(maya, ['A private thought about co-founder equity.'], {
      privacy: 'ephemeral',
    });
    const stale = await proposal(maya, 'Stale idea', 'Sell sensors to gyms.');
    await h.t.db.system(async (sx) => {
      await sx.query(`UPDATE coaching_sessions SET started_at = now() - interval '25 hours' WHERE id = :id`, {
        id: p.uuid(id),
      });
      await sx.query(`UPDATE turns SET created_at = now() - interval '25 hours' WHERE session_id = :id`, {
        id: p.uuid(id),
      });
      await sx.query(`UPDATE memory_objects SET updated_at = now() - interval '40 days' WHERE id = :id`, {
        id: p.uuid(stale),
      });
      await sx.query(`CREATE OR REPLACE FUNCTION public.test_block_expiry() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'expiry blocked'; END $$`);
      await sx.query(`CREATE TRIGGER test_block_expiry BEFORE UPDATE ON memory_objects FOR EACH ROW
        WHEN (OLD.status = 'proposed' AND NEW.status = 'expired') EXECUTE FUNCTION public.test_block_expiry()`);
    });
    try {
      await expect(h.core.maintenance.runDaily({ requestId: 'maintenance-blocked' })).rejects.toThrow();
    } finally {
      await h.t.db.system(async (sx) => {
        await sx.query('DROP TRIGGER test_block_expiry ON memory_objects');
        await sx.query('DROP FUNCTION public.test_block_expiry()');
      });
    }
    const turns = await h.t.db.system((sx) =>
      sx.query('SELECT founder_text FROM turns WHERE session_id = :id', { id: p.uuid(id) }),
    );
    expect(turns.rows).toEqual([{ founder_text: '[ephemeral session: content removed]' }]);
    expect((await session(id))?.status).toBe('ended');
  });
});

describe('what a distillation draws from a conversation, and its deletion', () => {
  const OPENER = 'Last time you planned to ask three libraries for a deposit. How did it go?';
  const scriptOpener = (): void => {
    scripted = (context) => {
      const draft = mockDistillDraft(context);
      return {
        ...draft,
        notebook: { ...draft.notebook, summary: 'Maya is pricing the library pilot.', next_opener: OPENER },
      };
    };
  };
  async function openerOf(sessionId: string): Promise<{ opener: string | null; source: string | null }> {
    const rows = await h.t.db.system((sx) =>
      sx.query('SELECT opener, opener_source_session_id AS source FROM coaching_sessions WHERE id = :id', {
        id: p.uuid(sessionId),
      }),
    );
    return rows.rows[0] as { opener: string | null; source: string | null };
  }

  it('records the conversation behind the summary and opener; deleting it erases them and their copies only', async () => {
    const drawn = await conversation(maya, ['Should we ask the libraries for a deposit up front?']);
    await idle(drawn, 15);
    scriptOpener();
    try {
      expect((await scriptedCore.distill.distillSession(job(drawn))).status).toBe('distilled');
    } finally {
      scripted = null;
    }
    const content = (await notebook())?.content;
    expect(content).toMatchObject({ nextOpener: OPENER, nextOpenerSource: drawn });
    expect(content?.summarySources).toContain(drawn);

    // A later conversation opens with that line, and remembers where it came from.
    const later = await h.core.sessions.create(maya, quietquad(), { mode: 'diagnose' });
    expect(await openerOf(later.id)).toEqual({ opener: OPENER, source: drawn });

    // Deleting another distilled conversation leaves both alone: their sources are known now.
    const other = await conversation(maya, ['Unrelated question about the sensors.']);
    await h.t.db.system((sx) =>
      sx.query('UPDATE coaching_sessions SET distilled_at = now(), distill_version = 1 WHERE id = :id', {
        id: p.uuid(other),
      }),
    );
    await h.core.sessions.remove(maya, other);
    expect((await notebook())?.content).toMatchObject({ nextOpener: OPENER });
    expect((await openerOf(later.id)).opener).toBe(OPENER);

    // Deleting the conversation it was drawn from erases the notebook's opener and summary, and the copy.
    await h.core.sessions.remove(maya, drawn);
    expect((await notebook())?.content).toMatchObject({ nextOpener: null, summary: '' });
    expect(await openerOf(later.id)).toEqual({ opener: null, source: null });
  });

  it('never writes over a notebook it cannot read in full, and still writes the digest', async () => {
    const id = await conversation(maya, ['What should the deposit be?']);
    await idle(id, 15);
    const before = await notebook();
    await h.t.db.system(async (sx) => {
      await sx.query('ALTER TABLE veir_notebooks DROP CONSTRAINT veir_notebooks_content_check');
      await sx.query(
        `UPDATE veir_notebooks SET content = content || jsonb_build_object('founderProfile', :entries)
         WHERE venture_id = :venture AND persona_id = :persona`,
        {
          venture: p.uuid(quietquad()),
          persona: p.uuid(corinPersona()),
          entries: p.json([
            { id: 'fp-x', text: 'Unreadable line', sourceSessionId: 'row-4', createdAt: 'later' },
          ]),
        },
      );
    });
    try {
      const outcome = await h.core.distill.distillSession(job(id));
      expect(outcome).toMatchObject({ status: 'distilled', notebookVersion: null });
      expect((await notebook())?.version).toBe(before?.version);
      expect((await session(id))?.digest).not.toBeNull();
      const [audited] = await auditFor('session.distilled', id);
      expect(audited?.metadata).toMatchObject({ notebookIntact: false, notebookVersion: null });
      expect(h.logger.records.some((r) => r.event === 'distill.notebook_unreadable')).toBe(true);
    } finally {
      await h.t.db.system(async (sx) => {
        await sx.query(
          `UPDATE veir_notebooks SET content = content || '{"founderProfile": []}'::jsonb
           WHERE venture_id = :venture AND persona_id = :persona`,
          { venture: p.uuid(quietquad()), persona: p.uuid(corinPersona()) },
        );
        await sx.query(
          `ALTER TABLE veir_notebooks ADD CONSTRAINT veir_notebooks_content_check
             CHECK (app.notebook_content_valid(content))`,
        );
      });
    }
  });
});
