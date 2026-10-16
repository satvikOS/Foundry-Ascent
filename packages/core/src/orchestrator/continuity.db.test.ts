/**
 * Continuity across conversations, on a seeded database with the mock model (owner report 2026-10-16: "on the
 * second call, when I asked do you remember what we talked about last time, the answer was the same as the
 * first one"). A second call minutes after the first must know what was said in it before any distillation
 * ran: its opening line, its spoken intro and its first answer all pick up the first call. Every way a call
 * ends distils its conversation at once; a private (temporary) conversation, chat or call, leaves nothing
 * behind; "Where you left off" reads only the venture's own standard, undeleted conversations and stays within
 * its budget; and what the vEIR learns is kept without an approval, for the founder to edit or forget.
 */
import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  MockModelGateway,
  mockCoachResponse,
  mockDistillDraft,
  type EmbedOptions,
  type EmbedResult,
  type MockGenerateContext,
} from '@foundry/ai';
import { StartCallResponse, TurnStreamEvent, type MemoryCandidate, type TurnView } from '@foundry/contracts';
import { lastQuestionOf } from '@foundry/ai';
import { memoryRepo, notebooksRepo, p, sessionsRepo } from '@foundry/db';
import { makeContext } from '@foundry/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { LEFT_OFF_HEADING, LEFT_OFF_MAX_CHARS, renderLeftOffSection } from './continuity-prompt.js';
import { loadLeftOff } from './continuity.js';

let h: CoreHarness;
let maya: RequestContext;
let devin: RequestContext;
let priya: RequestContext;

/** What each streamed model call was given (the founder message carries "Where you left off"). */
const seen: MockGenerateContext[] = [];

/**
 * The model, as far as these tests need it: asked to remember, it says what "Where you left off" holds (the
 * first founder line of the latest conversation), or that this is the first conversation.
 */
function recallingModel(context: MockGenerateContext): string {
  seen.push(context);
  const last = context.messages.at(-1)?.content ?? '';
  const start = last.indexOf(`${LEFT_OFF_HEADING}\n<where_you_left_off>`);
  if (start < 0) return 'This looks like our first conversation. What would you like to work on?';
  const section = last.slice(start, last.indexOf('</where_you_left_off>', start));
  const said = /<founder>([^<\n]*)<\/founder>/.exec(section)?.[1];
  const topic = /<topics>([^<\n]*)<\/topics>/.exec(section)?.[1];
  return `Yes. Last time we were on ${said ?? topic ?? 'something else'}. How did it go?`;
}

const quietquad = (): string => h.ventures.quietquad.id;

async function talk(
  ctx: RequestContext,
  sessionId: string,
  text: string,
  callId?: string,
): Promise<TurnView> {
  const events: TurnStreamEvent[] = [];
  await h.core.orchestrator.runTurn(
    ctx,
    sessionId,
    callId === undefined ? { text } : { text, channel: 'voice', callId },
    (e) => {
      events.push(TurnStreamEvent.parse(e));
    },
  );
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${JSON.stringify(last)}`);
  return last.turn;
}

async function startCall(ctx: RequestContext, sessionId: string): Promise<StartCallResponse> {
  return StartCallResponse.parse(await h.core.calls.start(ctx, sessionId, { inputMode: 'typed' }));
}

/** Moves a conversation's last activity into the past (as if nobody said anything for `minutes`). */
async function idle(sessionId: string, minutes: number): Promise<void> {
  await h.t.db.system((sx) =>
    sx.query(
      'UPDATE coaching_sessions SET last_activity_at = now() - make_interval(mins => :m) WHERE id = :id',
      {
        id: p.uuid(sessionId),
        m: p.int(minutes),
      },
    ),
  );
}

/** The distillation jobs queued since the last drain: [session, settled, delay]. */
function distillJobs(): [string, boolean, number][] {
  return h.jobQueue
    .drain()
    .flatMap((job) =>
      job.type === 'distill_session'
        ? [[job.sessionId, job.settled === true, 0] as [string, boolean, number]]
        : [],
    );
}

/** Everything the vEIR could have drawn from a conversation (none for a temporary one). */
async function drawnFrom(sessionId: string): Promise<Record<string, number>> {
  const rows = await h.t.db.system((sx) =>
    sx.query(
      `SELECT
         (SELECT count(*)::int FROM memory_objects m
           WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(m.source_refs) r (ref)
                         WHERE r.ref ->> 'id' = CAST(:id AS text)
                            OR r.ref ->> 'id' IN (SELECT CAST(t.id AS text) FROM turns t WHERE t.session_id = :id)))
           AS memory,
         (SELECT count(*)::int FROM patterns WHERE source_session_id = :id) AS lessons,
         (SELECT count(*)::int FROM coaching_sessions WHERE id = :id AND (digest IS NOT NULL OR distill_version > 0))
           AS digests,
         (SELECT count(*)::int FROM veir_notebooks n WHERE strpos(n.content::text, CAST(:id AS text)) > 0)
           AS notebook`,
      { id: p.uuid(sessionId) },
    ),
  );
  return rows.rows[0] as Record<string, number>;
}

/** Candidates the model proposes for a founder message, by its first word (the scripted core below). */
const proposals: Record<string, MemoryCandidate[]> = {};
/** The memory candidates the next distillation drafts (null: the mock's own). */
let distilling: MemoryCandidate[] | null = null;
/** What the scripted gateway did, in order: when a memory embedding started and finished. */
const timeline: string[] = [];
/** How long the scripted gateway takes to embed memory (the reply must never wait for it). */
let memoryEmbedMs = 0;
/** The thread the next scripted distillation notes to come back to (undefined: the mock's own). */
let nextTopic: string | null | undefined;

/** Wordings that mean the same thing share one vector: the pilot budget, and the founder's money goal. */
const MEANINGS: readonly RegExp[] = [/\bpilot (?:budget|spend)/i, /\b(?:rich|wealth\w*|money)\b/i];

/** The mock model, with embeddings that know {@link MEANINGS} and a clock for memory embeddings. */
class MeaningGateway extends MockModelGateway {
  override async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    const memory = texts.some((t) => t.includes('\n\n'));
    if (memory) timeline.push('memory-embed-start');
    if (memory && memoryEmbedMs > 0) await new Promise((resolve) => setTimeout(resolve, memoryEmbedMs));
    const result = await super.embed(texts, options);
    if (memory) timeline.push('memory-embed-done');
    const dim = result.vectors[0]?.length ?? 0;
    return {
      ...result,
      vectors: result.vectors.map((v, i) => {
        const meaning = MEANINGS.findIndex((m) => m.test(texts[i] ?? ''));
        return meaning < 0 ? v : Array.from({ length: dim }, (_, j) => (j === meaning ? 1 : 0));
      }),
    };
  }
}

const candidate = (title: string, content: string, source?: MemoryCandidate['source']): MemoryCandidate => ({
  type: 'fact',
  title,
  content,
  evidence_ids: [],
  confidence: 0.7,
  ...(source === undefined ? {} : { source }),
});

let scripted: ReturnType<typeof createCore>;

beforeAll(async () => {
  // Many messages from one founder in a few minutes: the per-person message limit is not what is tested here.
  h = await createCoreHarness({
    gatewayOptions: { streamFixture: recallingModel },
    config: { turns: { rateLimit: 500 } },
  });
  maya = await h.ctxFor(h.people.maya);
  devin = await h.ctxFor(h.people.devin);
  priya = await h.ctxFor(h.people.priya);
  await h.core.calls.acknowledgeNotice(maya);
  // The same database with a scripted model: what each message proposes to remember, what a distillation drafts.
  const gateway = new MeaningGateway({
    streamDelayMs: 0,
    fixtures: {
      [COACH_ANNOTATIONS_SCHEMA_NAME]: (context: MockGenerateContext) => {
        const { answer: _answer, spoken: _spoken, ...annotations } = mockCoachResponse(context);
        const key = context.founderText.split(/\s+/)[0] ?? '';
        return { ...annotations, memory_candidates: proposals[key] ?? [] };
      },
      DistillDraft: (context: MockGenerateContext) => {
        const draft = mockDistillDraft(context);
        return {
          ...draft,
          ...(distilling === null ? {} : { memory_candidates: distilling }),
          notebook: { ...draft.notebook, ...(nextTopic === undefined ? {} : { next_topic: nextTopic }) },
        };
      },
    },
  });
  scripted = createCore({
    db: h.t.db,
    gateway,
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
  });
});
afterAll(async () => {
  await h.cleanup();
});

describe('a second call minutes after the first', () => {
  it('opens, introduces itself and answers knowing the first call, before any distillation ran', async () => {
    const question = 'Should we price per library or per seat for the pilot?';
    const first = await h.core.sessions.create(maya, quietquad(), {});
    const call1 = await startCall(maya, first.id);
    await talk(maya, first.id, question, call1.call.id);
    await h.core.calls.end(maya, call1.call.id, { reason: 'user' });
    // Hanging up queued the conversation's distillation now, settled (never skipped as active)…
    expect(distillJobs()).toEqual([[first.id, true, 0]]);
    // …but the worker has not run it yet: nothing is distilled when the founder calls again, 3 minutes later.
    await idle(first.id, 3);
    expect(await drawnFrom(first.id)).toMatchObject({ digests: 0 });

    // New chat can greet with it before anything is sent: the preview is the line the conversation opens with.
    const preview = await h.core.sessions.previewOpener(maya, quietquad());
    expect(preview.lastConversation).toMatchObject({ sessionId: first.id, channel: 'call', title: question });
    const second = await h.core.sessions.create(maya, quietquad(), {});
    expect(second.opener).toBe(preview.opener);
    expect(second.opener).toContain(question);
    expect(second.opener).toMatch(/about 3 minutes ago, on a call/i);
    // Starting it distils the first at once too (it is well inside the 8-minute active window).
    await h.core.distill.afterCreate(maya, second);
    expect(distillJobs()).toEqual([[first.id, true, 0]]);

    const call2 = await startCall(maya, second.id);
    expect(call2.intro?.text).toMatch(/^Hi Maya, this is Corin's vEIR, an AI coach\. /);
    expect(call2.intro?.text).toContain(question);

    const turn = await talk(
      maya,
      second.id,
      'Do you remember what we talked about last time?',
      call2.call.id,
    );
    expect(turn.response?.answer).toContain(question);
    // What the model was given: the first call, as said, in "Where you left off".
    const prompt = seen.at(-1)?.messages.at(-1)?.content ?? '';
    expect(prompt.startsWith(`${LEFT_OFF_HEADING}\n<where_you_left_off>`)).toBe(true);
    expect(prompt).toMatch(/<conversation when="about 3 minutes ago" kind="call" with="you"/);
    expect(prompt).toContain(`<founder>${question}</founder>`);
    expect(prompt).toContain('<last_exchanges note="as said; not summarised yet">');
    await h.core.calls.end(maya, call2.call.id, { reason: 'user' });
    h.jobQueue.drain();

    // Once distilled, the next conversation reads the digest instead of the raw exchanges.
    const outcome = await h.core.distill.distillSession({
      sessionId: first.id,
      requestId: 'distill-first-call',
      settled: true,
    });
    expect(outcome.status).toBe('distilled');
    const state = await h.t.db.withContext(makeContext(maya.principalId, maya.tenantId), (tx) =>
      loadLeftOff(tx, {
        ventureId: quietquad(),
        personaId: h.ventures.quietquad.personaId,
        sessionId: null,
        principalId: maya.principalId,
        privacy: 'standard',
      }),
    );
    const firstSeen = state?.conversations.find((c) => c.sessionId === first.id);
    // The second call is newer and Maya's own; the first is distilled.
    expect(state?.conversations[0]?.sessionId).toBe(second.id);
    expect(firstSeen === undefined || firstSeen.exchanges.length === 0).toBe(true);
  });
});

describe('every way a call ends distils its conversation now', () => {
  it('a server stop, a replacement elsewhere and the daily reaper; never a reload in the same conversation', async () => {
    const a = await h.core.sessions.create(maya, quietquad(), {});
    const callA = await startCall(maya, a.id);
    await talk(maya, a.id, 'We booked two rooms for the pilot.', callA.call.id);
    h.jobQueue.drain();

    // A reload (the same conversation calls again) leaves the conversation going: nothing queued.
    const reload = await startCall(maya, a.id);
    expect(distillJobs()).toEqual([]);

    // Calls switched off: the next heartbeat ends the call, and its conversation is distilled.
    await h.t.db.system((sx) =>
      sx.query(`UPDATE platform_settings SET value = 'false'::jsonb WHERE key = 'calls_enabled'`),
    );
    try {
      const beat = await h.core.calls.heartbeat(maya, reload.call.id, {
        state: 'listening',
        micOpenSeconds: 0,
      });
      expect(beat).toMatchObject({ action: 'terminate' });
    } finally {
      await h.t.db.system((sx) =>
        sx.query(`UPDATE platform_settings SET value = 'true'::jsonb WHERE key = 'calls_enabled'`),
      );
    }
    expect(distillJobs()).toEqual([[a.id, true, 0]]);

    // A call replaced from another conversation: the one it left is distilled.
    const callA2 = await startCall(maya, a.id);
    const b = await h.core.sessions.create(maya, quietquad(), {});
    h.jobQueue.drain();
    const callB = StartCallResponse.parse(
      await h.core.calls.start(maya, b.id, { inputMode: 'typed', replace: true }),
    );
    expect(distillJobs()).toEqual([[a.id, true, 0]]);
    expect((await h.core.calls.get(maya, callA2.call.id)).call.status).toBe('ended');

    // A call whose client went away, closed by the daily maintenance: distilled inline right after.
    await talk(maya, b.id, 'The second library wants a trial.', callB.call.id);
    await h.t.db.system(async (sx) => {
      await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
      await sx.query(
        `UPDATE calls SET last_heartbeat_at = now() - interval '10 minutes', started_at = now() - interval '12 minutes'
         WHERE id = :id`,
        { id: p.uuid(callB.call.id) },
      );
      await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
    });
    const report = await h.core.maintenance.runDaily({ requestId: 'maintenance-reaper' });
    expect(report.staleCallsEnded).toBeGreaterThanOrEqual(1);
    expect(report.endedCallsDistilled).toBeGreaterThanOrEqual(1);
    expect(await drawnFrom(b.id)).toMatchObject({ digests: 1 });
  });
});

describe('a private (temporary) conversation', () => {
  it('chat or call, it writes nothing to memory, notebook, digests or lessons, and is never picked up', async () => {
    const notebookBefore = await h.core.notebook.get(maya, quietquad());
    const secret = 'A private worry about my co-founder leaving.';
    const temporary = await h.core.sessions.create(maya, quietquad(), { privacy: 'ephemeral' });
    expect(temporary.opener).toBeNull();
    const call = await startCall(maya, temporary.id);
    // A private call opens without picking anything up either.
    expect(call.intro?.text).toBe(
      "Hi Maya, this is Corin's vEIR, an AI coach. What would you like to work on?",
    );
    const turn = await talk(maya, temporary.id, secret, call.call.id);
    // Nothing from "Where you left off" reaches a temporary conversation.
    expect(seen.at(-1)?.messages.at(-1)?.content).not.toContain(LEFT_OFF_HEADING);
    expect(turn.response?.answer).toContain('first conversation');
    const ended = await h.core.calls.end(maya, call.call.id, { reason: 'user' });
    expect(ended.summary).toMatchObject({ memoryProposalIds: [], memoryKeptIds: [] });
    expect(distillJobs()).toEqual([]);
    await h.core.distill.afterTurn(maya, temporary.id);
    await h.core.distill.afterEnd(maya, temporary.id);
    expect(distillJobs()).toEqual([]);
    expect(
      (await h.core.distill.distillSession({ sessionId: temporary.id, requestId: 'x', settled: true }))
        .reason,
    ).toBe('ephemeral');
    await h.core.sessions.end(maya, temporary.id);
    expect(await drawnFrom(temporary.id)).toEqual({ memory: 0, lessons: 0, digests: 0, notebook: 0 });
    expect((await h.core.notebook.get(maya, quietquad())).version).toBe(notebookBefore.version);

    // The next conversation never mentions it: neither its opening line nor the model's prompt.
    const next = await h.core.sessions.create(maya, quietquad(), {});
    expect(next.opener ?? '').not.toContain('co-founder');
    await talk(maya, next.id, 'Where were we?');
    expect(seen.at(-1)?.messages.at(-1)?.content).not.toContain('co-founder');
  });
});

describe('"Where you left off"', () => {
  it('reads only this venture’s standard, undeleted conversations, a teammate’s too, within its budget', async () => {
    // Everything said in QuietQuad so far (the tests above) happened two days ago.
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - interval '2 days' WHERE venture_id = :v`,
        {
          v: p.uuid(quietquad()),
        },
      ),
    );
    const long = 'We went through the library budget line by line. '.repeat(30);
    const own = await h.core.sessions.create(maya, quietquad(), {});
    for (let i = 0; i < 7; i += 1) await talk(maya, own.id, `${String(i)} ${long}`);
    await idle(own.id, 30);
    // Newer than it: a teammate's conversation, a deleted one, a temporary one, and another venture's.
    const teammate = await h.core.sessions.create(devin, quietquad(), {});
    await talk(devin, teammate.id, 'Devin here: the sensors arrive Monday.');
    await idle(teammate.id, 20);
    const deleted = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, deleted.id, 'Something I will delete about payroll.');
    await h.core.sessions.remove(maya, deleted.id);
    const temporary = await h.core.sessions.create(maya, quietquad(), { privacy: 'ephemeral' });
    await talk(maya, temporary.id, 'A temporary note about payroll.');
    const elsewhere = await h.core.sessions.create(priya, h.ventures.benchtally.id, {});
    await talk(priya, elsewhere.id, 'BenchTally pricing for workshops.');

    const current = await h.core.sessions.create(maya, quietquad(), {});
    const data = await h.t.db.withContext(makeContext(maya.principalId, maya.tenantId), (tx) =>
      loadLeftOff(tx, {
        ventureId: quietquad(),
        personaId: h.ventures.quietquad.personaId,
        sessionId: current.id,
        principalId: maya.principalId,
        privacy: 'standard',
      }),
    );
    expect(data?.conversations.map((c) => c.sessionId)).toEqual([teammate.id, own.id]);
    expect(data?.conversations[0]).toMatchObject({ withCaller: false, teammateFirstName: 'Devin' });
    // The last six exchanges of the founder's own conversation, oldest first.
    expect(data?.conversations[1]?.exchanges.map((x) => x.founder.slice(0, 2))).toEqual([
      '1 ',
      '2 ',
      '3 ',
      '4 ',
      '5 ',
      '6 ',
    ]);
    const section = renderLeftOffSection(data, { now: new Date() });
    expect(section.length).toBeLessThanOrEqual(LEFT_OFF_MAX_CHARS);
    expect(section).not.toMatch(/payroll|BenchTally|workshops/);
    // A temporary conversation reads nothing at all.
    expect(
      await h.t.db.withContext(makeContext(maya.principalId, maya.tenantId), (tx) =>
        loadLeftOff(tx, {
          ventureId: quietquad(),
          personaId: h.ventures.quietquad.personaId,
          sessionId: temporary.id,
          principalId: maya.principalId,
          privacy: 'ephemeral',
        }),
      ),
    ).toBeNull();
    // Every turn of a conversation carries it, not only the first.
    await talk(maya, current.id, 'First.');
    await talk(maya, current.id, 'Second.');
    // (Within the budget the founder's own conversation is kept first: this one is long.)
    expect(seen.at(-1)?.messages.at(-1)?.content).toContain('<founder>6 We went through the library budget');
  });
});

/** A turn on the scripted core; returns the completed turn (and records `turn.completed` in the timeline). */
async function say(ctx: RequestContext, sessionId: string, text: string): Promise<TurnView> {
  const events: TurnStreamEvent[] = [];
  await scripted.orchestrator.runTurn(ctx, sessionId, { text }, (e) => {
    const event = TurnStreamEvent.parse(e);
    if (event.event === 'turn.completed') timeline.push('turn.completed');
    events.push(event);
  });
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'none'}`);
  return last.turn;
}

/** The venture's items (any status) whose sources name `refId` (a turn or a conversation). */
async function learnedFrom(refId: string): Promise<memoryRepo.MemoryRecord[]> {
  return (
    await h.t.db.system((sx) =>
      memoryRepo.listMemory(sx, {
        ventureId: quietquad(),
        statuses: ['proposed', 'confirmed', 'disputed', 'superseded', 'rejected', 'expired'],
        limit: 500,
      }),
    )
  ).filter((m) => m.sourceRefs.some((r) => r.id === refId));
}

/** The status of an item as stored (deleted items too). */
async function statusOf(id: string): Promise<string> {
  const rows = await h.t.db.system((sx) =>
    sx.query('SELECT status FROM memory_objects WHERE id = :id', { id: p.uuid(id) }),
  );
  return String(rows.rows[0]?.status);
}

/** Live items of the venture with this title. */
async function liveTitled(title: string): Promise<memoryRepo.MemoryRecord[]> {
  return (
    await h.t.db.system((sx) =>
      memoryRepo.listMemory(sx, {
        ventureId: quietquad(),
        statuses: ['proposed', 'confirmed', 'disputed'],
        limit: 500,
      }),
    )
  ).filter((m) => m.title === title);
}

describe('memory kept automatically', () => {
  it('is visible to the team at once, editable and forgettable, and goes with its conversation', async () => {
    proposals.Two = [
      candidate('Pilot agreement', 'Two libraries agreed to a pilot in November.'),
      candidate('Pilot libraries', 'The two pilot libraries agreed to share door-counter data.'),
    ];
    const session = await scripted.sessions.create(maya, quietquad(), {});
    const turn = await say(
      maya,
      session.id,
      'Two libraries agreed to a pilot in November and to share door-counter data.',
    );
    const kept = (await scripted.memory.list(devin, quietquad(), { status: 'confirmed' })).items.filter((m) =>
      m.sourceRefs.some((r) => r.kind === 'turn' && r.id === turn.id),
    );
    expect(kept.map((m) => m.title).sort()).toEqual(['Pilot agreement', 'Pilot libraries']);
    const item = kept.find((m) => m.title === 'Pilot agreement');
    const other = kept.find((m) => m.title === 'Pilot libraries');
    if (item === undefined || other === undefined) throw new Error('nothing kept');
    expect(item).toMatchObject({
      origin: 'ai',
      keptAutomatically: true,
      approvedBy: null,
      visibility: 'team',
    });
    // It names the conversation it was learned from (and the turn).
    expect(item.sourceRefs).toEqual(
      expect.arrayContaining([
        { kind: 'session', id: session.id, label: 'Learned from the conversation' },
        { kind: 'turn', id: turn.id },
      ]),
    );
    // Nothing waits for an approval.
    expect(
      (await scripted.memory.list(maya, quietquad(), { status: 'proposed' })).items.filter(
        (m) => m.origin === 'ai',
      ),
    ).toEqual([]);
    // The founder corrects one: the correction is hers, and survives the conversation's deletion.
    const corrected = await scripted.memory.act(maya, item.id, {
      action: 'correct',
      patch: { content: 'Two libraries agreed to a pilot in December.' },
    });
    expect(corrected).toMatchObject({ approvedBy: { id: maya.principalId }, keptAutomatically: false });
    expect(await statusOf(item.id)).toBe('superseded');
    await scripted.sessions.remove(maya, session.id);
    expect((await scripted.memory.get(maya, corrected?.id ?? '')).status).toBe('confirmed');
    // What the vEIR kept from that conversation alone is gone with it: the version it kept (the founder corrected
    // it), and the other item nobody touched.
    expect(await statusOf(item.id)).toBe('deleted');
    expect(await statusOf(other.id)).toBe('deleted');
    await expect(scripted.memory.get(maya, other.id)).rejects.toMatchObject({ code: 'not_found' });
    // Forgetting is the founder's at any time.
    proposals.We = [candidate('Researcher hired', 'We hired a part-time researcher for the pilot.')];
    const again = await scripted.sessions.create(maya, quietquad(), {});
    const t2 = await say(maya, again.id, 'We hired a part-time researcher for the pilot.');
    const [learned] = await learnedFrom(t2.id);
    if (learned === undefined) throw new Error('nothing kept');
    expect(await scripted.memory.act(maya, learned.id, { action: 'delete' })).toBeNull();
    await expect(scripted.memory.get(maya, learned.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stays forgotten: distilling the same conversation never keeps it again (review)', async () => {
    proposals.Honestly = [
      candidate('Personal goal', 'Maya wants the startup to make her rich quickly.', 'founder_stated'),
    ];
    const session = await scripted.sessions.create(maya, quietquad(), {});
    const turn = await say(maya, session.id, 'Honestly I just want this startup to make me rich, quickly.');
    const [goal] = await learnedFrom(turn.id);
    if (goal === undefined) throw new Error('the goal was not kept');
    expect(goal).toMatchObject({ title: 'Personal goal', keptAutomatically: true, hasEmbedding: true });
    // Maya makes the vEIR forget it, and the conversation ends: its distillation drafts the same item, then the
    // same goal in other words. Neither is kept, nothing has to be said again for it to come back otherwise.
    expect(await scripted.memory.act(maya, goal.id, { action: 'delete' })).toBeNull();
    await scripted.sessions.end(maya, session.id);
    h.jobQueue.drain();
    distilling = [
      candidate('Personal goal', 'Maya wants the startup to make her rich quickly.', 'founder_stated'),
      candidate(
        'Financial goal',
        'The founder hopes to become wealthy fast through the company.',
        'founder_stated',
      ),
    ];
    try {
      const outcome = await scripted.distill.distillSession({
        sessionId: session.id,
        requestId: 'distill-forgotten',
        settled: true,
      });
      expect(outcome).toMatchObject({ status: 'distilled', memoryProposed: 0 });
    } finally {
      distilling = null;
    }
    expect(await liveTitled('Personal goal')).toEqual([]);
    expect(await liveTitled('Financial goal')).toEqual([]);
    // Nothing of it is kept as text: only hashes and a meaning signature, per conversation.
    const stored = await h.t.db.system((sx) =>
      sx.query('SELECT * FROM memory_forgotten WHERE session_id = :id', { id: p.uuid(session.id) }),
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored.rows)).not.toMatch(/rich|Maya|goal/i);
  });

  it('a correction stays: the old words never come back as a new item (review)', async () => {
    proposals.Our = [
      candidate('Pilot budget', 'The pilot budget is capped at five thousand.', 'founder_stated'),
    ];
    const session = await scripted.sessions.create(maya, quietquad(), {});
    const turn = await say(maya, session.id, 'Our pilot budget is capped at five thousand.');
    const [budget] = await learnedFrom(turn.id);
    if (budget === undefined) throw new Error('the budget was not kept');
    await scripted.memory.act(maya, budget.id, {
      action: 'correct',
      patch: { content: 'The pilot budget is capped at six thousand, from the city grant.' },
    });
    await scripted.sessions.end(maya, session.id);
    h.jobQueue.drain();
    distilling = [
      candidate('Pilot budget', 'The pilot budget is capped at five thousand.', 'founder_stated'),
      candidate('Pilot spending', 'Pilot spending cannot go beyond five thousand.', 'founder_stated'),
    ];
    try {
      const outcome = await scripted.distill.distillSession({
        sessionId: session.id,
        requestId: 'distill-corrected',
        settled: true,
      });
      expect(outcome).toMatchObject({ status: 'distilled', memoryProposed: 0 });
    } finally {
      distilling = null;
    }
    expect((await liveTitled('Pilot budget')).map((m) => m.content)).toEqual([
      'The pilot budget is capped at six thousand, from the city grant.',
    ]);
    expect(await liveTitled('Pilot spending')).toEqual([]);
    await scripted.sessions.remove(maya, session.id);
  });

  it('never makes the reply wait for an embedding: the turn completes first (review)', async () => {
    proposals.Libraries = [
      candidate(
        'Weekly reports',
        'Libraries want weekly occupancy reports for every study room.',
        'founder_stated',
      ),
    ];
    const session = await scripted.sessions.create(maya, quietquad(), {});
    timeline.length = 0;
    memoryEmbedMs = 250;
    try {
      const turn = await say(
        maya,
        session.id,
        'Libraries want weekly occupancy reports for every study room.',
      );
      // The reply was complete before the memory it taught was even embedded; it is embedded by the time the
      // turn's work is done.
      expect(timeline).toEqual(['turn.completed', 'memory-embed-start', 'memory-embed-done']);
      const [reports] = await learnedFrom(turn.id);
      expect(reports).toMatchObject({ keptAutomatically: true, hasEmbedding: true });
    } finally {
      memoryEmbedMs = 0;
    }
  });
});

describe('what the vEIR keeps', () => {
  it('keeps the founder’s own words, never the coach’s advice alone, and each thing once by meaning', async () => {
    // The founder's own goal is kept (embedded, so "do you remember…" finds it by meaning); the coach's
    // standing advice, which nothing the founder said supports, is not.
    proposals.Frankly = [
      candidate('Money goal', 'Maya wants the company to make her a lot of money fast.'),
      candidate(
        'Regulatory pathway undecided',
        'The regulatory classification and reimbursement pathway are undecided.',
      ),
      candidate('Advisor meeting', 'Book the regulatory advisor before the pilot.', 'coach_advice'),
    ];
    const first = await scripted.sessions.create(maya, quietquad(), {});
    const goalTurn = await say(maya, first.id, 'Frankly I want the company to make me a lot of money fast.');
    const kept = await learnedFrom(goalTurn.id);
    expect(kept.map((m) => m.title)).toEqual(['Money goal']);
    expect(kept[0]).toMatchObject({ keptAutomatically: true, hasEmbedding: true });

    // The same thing said another way in a later conversation is not kept twice: it names the new conversation.
    proposals.Pilot = [candidate('Pilot budget cap', 'The pilot budget is limited to five thousand.')];
    const budgetTurn = await say(maya, first.id, 'Pilot budget is limited to five thousand.');
    const [budget] = await learnedFrom(budgetTurn.id);
    if (budget === undefined) throw new Error('the budget was not kept');
    proposals.We = [
      candidate('Pilot spending limit', 'Pilot spending cannot go beyond the five thousand cap.'),
    ];
    const second = await scripted.sessions.create(maya, quietquad(), {});
    const againTurn = await say(
      maya,
      second.id,
      'We cannot let pilot spending go beyond the five thousand cap.',
    );
    const again = (await learnedFrom(againTurn.id)).filter((m) => m.status !== 'deleted');
    expect(again.map((m) => m.id)).toEqual([budget.id]);
    expect(again[0]?.sourceRefs).toEqual(
      expect.arrayContaining([{ kind: 'session', id: second.id, label: 'Learned from the conversation' }]),
    );
    // A different number is a different fact, however close the meaning.
    proposals.Actually = [candidate('Pilot budget raised', 'The pilot budget is limited to 7000 now.')];
    const raisedTurn = await say(maya, second.id, 'Actually the pilot budget is limited to 7000 now.');
    expect((await learnedFrom(raisedTurn.id)).map((m) => m.title)).toEqual(['Pilot budget raised']);
  });

  it('settles the proposals left from before automatic memory with the same checks (review)', async () => {
    const session = await scripted.sessions.create(maya, quietquad(), {});
    await say(
      maya,
      session.id,
      'My goal is ten paying libraries by June, and we cannot hire before the pilot.',
    );
    const legacy = async (title: string, content: string, created: string): Promise<string> =>
      h.t.db.system(async (sx) => {
        const record = await memoryRepo.createMemory(sx, {
          tenantId: h.seed.tenantId,
          ventureId: quietquad(),
          type: 'insight',
          title,
          content,
          status: 'proposed',
          visibility: 'team',
          origin: 'ai',
          createdBy: maya.principalId,
          sourceRefs: [{ kind: 'session', id: session.id, label: 'Learned from the conversation' }],
        });
        await sx.query('UPDATE memory_objects SET created_at = CAST(:at AS timestamptz) WHERE id = :id', {
          id: p.uuid(record.id),
          at: p.text(created),
        });
        return record.id;
      });
    const goal = await legacy(
      'Paying libraries goal',
      'Maya aims for ten paying libraries by June.',
      '2026-10-01',
    );
    const advice = await legacy(
      'Advisor meeting',
      'Book the advisor meeting before the redesign.',
      '2026-10-02',
    );
    const restated = await legacy(
      'Libraries goal',
      'Maya aims for ten paying libraries by June!',
      '2026-10-03',
    );
    const constraint = await legacy('No hiring yet', 'The team cannot hire before the pilot.', '2026-10-04');
    const report = await scripted.maintenance.runDaily({ requestId: 'maintenance-legacy' });
    expect(report.pendingProposals).toMatchObject({ kept: 2, duplicates: 1, notTheFounders: 1 });
    expect(await statusOf(goal)).toBe('confirmed');
    expect(await statusOf(constraint)).toBe('confirmed');
    expect(await statusOf(advice)).toBe('expired');
    expect(await statusOf(restated)).toBe('expired');
    const kept = await h.t.db.system((sx) => memoryRepo.getMemory(sx, goal));
    expect(kept).toMatchObject({ keptAutomatically: true, approvedBy: null });
    // Run again: nothing left to settle.
    expect(
      (await scripted.maintenance.runDaily({ requestId: 'maintenance-legacy-2' })).pendingProposals,
    ).toEqual({
      kept: 0,
      duplicates: 0,
      notTheFounders: 0,
    });
  });
});

describe('how a new conversation opens', () => {
  /** Everything said in QuietQuad so far happened days ago (each test starts from a clean recent history). */
  async function ageEverything(days: number): Promise<void> {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - make_interval(days => :d) WHERE venture_id = :v`,
        { v: p.uuid(quietquad()), d: p.int(days) },
      ),
    );
  }

  it('a call started later in a conversation created earlier opens with what is true now', async () => {
    await ageEverything(3);
    const empty = await h.core.sessions.create(maya, quietquad(), {});
    const meanwhile = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, meanwhile.id, 'We booked the auditorium for demo day.');
    const call = await startCall(maya, empty.id);
    expect(call.intro?.text).toContain('“We booked the auditorium for demo day”');
    // The conversation keeps that line as its first message: the vEIR's history says what the call said.
    const opener = (await h.core.sessions.get(maya, empty.id)).session.opener ?? '';
    expect(call.intro?.text.endsWith(opener)).toBe(true);
    await h.core.calls.end(maya, call.call.id, { reason: 'user' });
    h.jobQueue.drain();
  });

  it('never opens by repeating the question the last conversation ended on', async () => {
    await ageEverything(3);
    const last = await h.core.sessions.create(maya, quietquad(), {});
    const turn = await talk(maya, last.id, 'Should we charge libraries per seat?');
    const question = lastQuestionOf(turn.response?.answer ?? '');
    if (question === null) throw new Error('the answer asks nothing');
    // The notebook's opener, drawn from that conversation, is its closing question word for word.
    await h.t.db.system(async (sx) => {
      const key = { ventureId: quietquad(), personaId: h.ventures.quietquad.personaId };
      const current = await notebooksRepo.getNotebook(sx, key);
      await notebooksRepo.saveNotebook(sx, {
        tenantId: h.seed.tenantId,
        ...key,
        expectedVersion: current?.version ?? 0,
        content: { ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK), nextOpener: question },
        suppressed: current?.suppressed ?? [],
        editedBy: 'veir',
        sourceSessionId: last.id,
      });
    });
    const next = await h.core.sessions.create(maya, quietquad(), {});
    expect(next.opener).not.toBe(question);
    expect(next.opener).toContain('“Should we charge libraries per seat?”');
  });

  it('carries over a conversation the venture had with its previous coach, as the founder’s, never as its own', async () => {
    await ageEverything(3);
    const before = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, before.id, 'Our goal is ten paying libraries by June.');
    // The venture talked to the program guide then (its vEIR changed since).
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET persona_release_id = (
           SELECT r.id FROM persona_releases r JOIN personas pe ON pe.id = r.persona_id
           WHERE pe.kind = 'neutral_guide' AND r.status = 'approved' ORDER BY r.version DESC LIMIT 1)
         WHERE id = :id`,
        { id: p.uuid(before.id) },
      ),
    );
    const now = await h.core.sessions.create(maya, quietquad(), {});
    expect(now.opener).toMatch(/^Good to have you here\. Your last conversation here \(a moment ago\)/);
    expect(now.opener).toContain('“Our goal is ten paying libraries by June”');
    await talk(maya, now.id, 'Do you remember my goal?');
    const prompt = seen.at(-1)?.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('coach="another coach of this venture"');
    expect(prompt).toContain('<founder>Our goal is ten paying libraries by June.</founder>');
    expect(prompt).toMatch(/<other_coach>[^<]+<\/other_coach>/);
  });
});

describe('continuity keyed by the venture and the founder (review)', () => {
  /** Everything said in QuietQuad so far happened days ago. */
  async function ageAll(days: number): Promise<void> {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - make_interval(days => :d) WHERE venture_id = :v`,
        { v: p.uuid(quietquad()), d: p.int(days) },
      ),
    );
  }
  const leftOffFor = (ctx: RequestContext, sessionId: string | null, ownOnly = false) =>
    h.t.db.withContext(makeContext(ctx.principalId, ctx.tenantId), (tx) =>
      loadLeftOff(tx, {
        ventureId: quietquad(),
        personaId: h.ventures.quietquad.personaId,
        sessionId,
        principalId: ctx.principalId,
        privacy: 'standard',
        ownOnly,
      }),
    );

  it('never loses the founder’s own last conversation behind a teammate’s newer ones', async () => {
    await ageAll(4);
    const own = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, own.id, 'We decided to price per library, not per seat.');
    await idle(own.id, 60);
    for (let i = 0; i < 5; i += 1) {
      const mate = await h.core.sessions.create(devin, quietquad(), {});
      await talk(devin, mate.id, `Devin note ${String(i)} about the sensors.`);
      await idle(mate.id, 50 - i);
    }
    const data = await leftOffFor(maya, null);
    expect(data?.conversations.map((c) => [c.withCaller, c.teammateFirstName])).toEqual([
      [false, 'Devin'],
      [true, null],
    ]);
    expect(data?.conversations[1]?.sessionId).toBe(own.id);
    expect(data?.conversations[1]?.exchanges[0]?.founder).toBe(
      'We decided to price per library, not per seat.',
    );
    // Her next conversation opens with her own, never the teammate's or the notebook's older line.
    expect((await leftOffFor(maya, null, true))?.conversations.map((c) => c.sessionId)).toEqual([own.id]);
    const next = await h.core.sessions.create(maya, quietquad(), {});
    expect(next.opener).toContain('“We decided to price per library, not per seat”');
    expect(next.opener).not.toMatch(/sensors|Devin/);
  });

  it('reads only the last exchanges of a long conversation, never the whole of it (review)', async () => {
    const long = await h.core.sessions.create(maya, quietquad(), {});
    await h.t.db.system((sx) =>
      sx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, status, response)
         SELECT :tenant, :venture, :session, n, :author, 'coach', 'Message ' || n, 'completed',
                jsonb_build_object('answer', repeat('A long answer. ', 200))
         FROM generate_series(1, 40) AS n`,
        {
          tenant: p.uuid(h.seed.tenantId),
          venture: p.uuid(quietquad()),
          session: p.uuid(long.id),
          author: p.uuid(maya.principalId),
        },
      ),
    );
    const plan = await h.t.db.system((sx) =>
      sx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sessionsRepo.LAST_EXCHANGES_SQL}`, {
        ids: p.uuidArray([long.id]),
        perSession: p.int(6),
        founderChars: p.int(600),
        answerChars: p.int(900),
      }),
    );
    const raw = plan.rows[0]?.['QUERY PLAN'];
    const root = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: Record<string, unknown> }[];
    /** Rows read from `turns`, every node and loop. */
    const read = (node: Record<string, unknown>): number =>
      (node['Relation Name'] === 'turns'
        ? (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) * Number(node['Actual Loops'])
        : 0) + ((node.Plans as Record<string, unknown>[] | undefined) ?? []).reduce((n, c) => n + read(c), 0);
    const plans = root[0]?.Plan;
    if (plans === undefined) throw new Error('no plan');
    expect(read(plans)).toBeGreaterThanOrEqual(6);
    expect(read(plans)).toBeLessThanOrEqual(7);
    const exchanges = await h.t.db.system((sx) =>
      sessionsRepo.listLastExchanges(sx, { sessionIds: [long.id], perSession: 6 }),
    );
    expect(exchanges.map((x) => x.founderText)).toEqual(
      [35, 36, 37, 38, 39, 40].map((n) => `Message ${String(n)}`),
    );
    expect(exchanges.map((x) => x.fromEnd)).toEqual([6, 5, 4, 3, 2, 1]);
    await h.core.sessions.remove(maya, long.id);
  });

  it('reads a reply the founder spoke over as they heard it, and nothing of one they never heard', async () => {
    await ageAll(4);
    const earlier = await h.core.sessions.create(maya, quietquad(), {});
    const heard = await talk(maya, earlier.id, 'Should the pilot run in two libraries or three?');
    const unheard = await talk(maya, earlier.id, 'What would a third library cost us?');
    await h.t.db.system(async (sx) => {
      await sx.query(
        `UPDATE turns SET heard_seq = 0, interrupted_at = now(), heard_text = 'Two is enough to start.' WHERE id = :id`,
        { id: p.uuid(heard.id) },
      );
      await sx.query(`UPDATE turns SET heard_seq = -1, interrupted_at = now() WHERE id = :id`, {
        id: p.uuid(unheard.id),
      });
    });
    const data = await leftOffFor(maya, null);
    expect(data?.conversations[0]?.exchanges).toEqual([
      { founder: 'Should the pilot run in two libraries or three?', answer: 'Two is enough to start.' },
      { founder: 'What would a third library cost us?', answer: null },
    ]);
    const section = renderLeftOffSection(data, { now: new Date() });
    expect(section).toContain('<you>Two is enough to start.</you>');
    expect(section).not.toContain(heard.response?.answer.slice(0, 40) ?? '#');
    expect(section).not.toContain(unheard.response?.answer.slice(0, 40) ?? '#');
  });

  it('sends each earlier conversation once, and marks another coach’s in the notes as well', async () => {
    await ageAll(6);
    // An older conversation the venture had with its previous coach, and Maya's latest with this one, distilled.
    const older = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, older.id, 'Our goal is ten paying libraries by June.');
    const latest = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, latest.id, 'We chose per-library pricing for the pilot.');
    for (const [id, name] of [
      [older.id, 'older'],
      [latest.id, 'latest'],
    ] as const) {
      expect(
        (await h.core.distill.distillSession({ sessionId: id, requestId: `distill-${name}`, settled: true }))
          .status,
      ).toBe('distilled');
    }
    await h.t.db.system(async (sx) => {
      await sx.query(
        `UPDATE coaching_sessions SET persona_release_id = (
           SELECT r.id FROM persona_releases r JOIN personas pe ON pe.id = r.persona_id
           WHERE pe.kind = 'neutral_guide' AND r.status = 'approved' ORDER BY r.version DESC LIMIT 1),
           last_activity_at = now() - interval '2 days'
         WHERE id = :id`,
        { id: p.uuid(older.id) },
      );
      await sx.query(
        `UPDATE coaching_sessions SET last_activity_at = now() - interval '1 hour' WHERE id = :id`,
        {
          id: p.uuid(latest.id),
        },
      );
    });
    // Distinct titles, to count where each conversation appears.
    const latestTitle = 'Choosing per-library pricing';
    const olderTitle = 'Ten paying libraries by June';
    for (const [id, title] of [
      [latest.id, latestTitle],
      [older.id, olderTitle],
    ] as const) {
      await h.t.db.system((sx) =>
        sx.query('UPDATE coaching_sessions SET title = :t WHERE id = :id', {
          id: p.uuid(id),
          t: p.text(title),
        }),
      );
    }
    const now = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, now.id, 'Where were we?');
    const prompt = seen.at(-1)?.messages.at(-1)?.content ?? '';
    const notes = prompt.slice(prompt.indexOf('<your_notes>'));
    // The latest conversation is in "Where you left off" only, not again in the notes.
    expect(prompt.split(`title="${latestTitle}"`).length - 1).toBe(1);
    expect(notes).not.toContain(`title="${latestTitle}"`);
    // The previous coach's conversation is in the notes, marked as that coach's.
    expect(notes).toMatch(
      new RegExp(
        `<conversation [^>]*coach="another coach of this venture" title="${olderTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
      ),
    );
    expect(notes).toContain('never your own conversation');
  });

  it('greets around the thread it noted, afresh each time; the thread goes with its opener', async () => {
    await ageAll(8);
    const before = await scripted.sessions.create(maya, quietquad(), {});
    await say(maya, before.id, 'I will interview five library staff before Friday.');
    nextTopic = 'The five library-staff interviews you planned.';
    try {
      expect(
        (
          await scripted.distill.distillSession({
            sessionId: before.id,
            requestId: 'distill-topic',
            settled: true,
          })
        ).status,
      ).toBe('distilled');
    } finally {
      nextTopic = undefined;
    }
    const notebook = await scripted.notebook.get(maya, quietquad());
    expect(notebook.nextTopic).toBe('The five library-staff interviews you planned');
    const stored = notebook.nextOpener ?? '';
    const first = await scripted.sessions.create(maya, quietquad(), {});
    const second = await scripted.sessions.create(maya, quietquad(), {});
    for (const opened of [first, second]) {
      expect(opened.opener).toContain('the five library-staff interviews you planned');
      expect(opened.opener).not.toBe(stored);
    }
    // Opening one conversation after another never greets the same way twice.
    expect(second.opener).not.toBe(first.opener);
    // A person who rewrites the opener chose what to open with: the thread goes.
    await scripted.notebook.update(maya, quietquad(), {
      expectedVersion: notebook.version,
      edit: { action: 'edit_opener', text: 'How are the staff interviews going?' },
    });
    const edited = await scripted.notebook.get(maya, quietquad());
    expect(edited.nextTopic ?? null).toBeNull();
    expect((await scripted.sessions.create(maya, quietquad(), {})).opener).toBe(
      'How are the staff interviews going?',
    );
  });

  it('deleting the conversation the thread came from clears it with the opener', async () => {
    await ageAll(9);
    // Nothing a person chose stands in the way (the test before rewrote the opener).
    const current = await scripted.notebook.get(maya, quietquad());
    await scripted.notebook.update(maya, quietquad(), {
      expectedVersion: current.version,
      edit: { action: 'remove_opener' },
    });
    const source = await scripted.sessions.create(maya, quietquad(), {});
    await say(maya, source.id, 'I will call the second library about the trial.');
    nextTopic = 'the call with the second library';
    try {
      await scripted.distill.distillSession({
        sessionId: source.id,
        requestId: 'distill-topic-2',
        settled: true,
      });
    } finally {
      nextTopic = undefined;
    }
    expect((await scripted.notebook.get(maya, quietquad())).nextTopic).toBe(
      'the call with the second library',
    );
    await scripted.sessions.remove(maya, source.id);
    const after = await scripted.notebook.get(maya, quietquad());
    expect(after.nextOpener).toBeNull();
    expect(after.nextTopic ?? null).toBeNull();
  });

  it('never opens with a greeting the founder said, but with what they brought (review)', async () => {
    await ageAll(10);
    const call = await h.core.sessions.create(maya, quietquad(), {});
    await talk(maya, call.id, 'Hi');
    await talk(maya, call.id, 'Should the pilot run in two libraries or three?');
    await talk(maya, call.id, 'ok');
    const next = await h.core.sessions.create(maya, quietquad(), {});
    expect(next.opener).not.toMatch(/“Hi”|“ok”/);
    expect(next.opener).toContain('you asked “Should the pilot run in two libraries or three?”');
  });
});
