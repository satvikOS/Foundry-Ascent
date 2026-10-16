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
  type EmbedOptions,
  type EmbedResult,
  type MockGenerateContext,
} from '@foundry/ai';
import { StartCallResponse, TurnStreamEvent, type MemoryCandidate, type TurnView } from '@foundry/contracts';
import { lastQuestionOf } from '@foundry/ai';
import { memoryRepo, notebooksRepo, p } from '@foundry/db';
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

describe('memory kept automatically', () => {
  it('is visible to the team at once, editable and forgettable, and goes with its conversation', async () => {
    const session = await h.core.sessions.create(maya, quietquad(), {});
    const turn = await talk(maya, session.id, 'Two libraries agreed to a pilot in November.');
    const kept = (await h.core.memory.list(devin, quietquad(), { status: 'confirmed' })).items.filter((m) =>
      m.sourceRefs.some((r) => r.kind === 'turn' && r.id === turn.id),
    );
    expect(kept.length).toBeGreaterThan(0);
    const [item] = kept;
    if (item === undefined) throw new Error('nothing kept');
    expect(item).toMatchObject({
      origin: 'ai',
      keptAutomatically: true,
      approvedBy: null,
      visibility: 'team',
    });
    // It names the conversation it was learned from (and the turn); one learned before names that one first.
    expect(item.sourceRefs).toEqual(
      expect.arrayContaining([
        { kind: 'session', id: session.id, label: 'Learned from the conversation' },
        { kind: 'turn', id: turn.id },
      ]),
    );
    // Nothing waits for an approval.
    expect(
      (await h.core.memory.list(maya, quietquad(), { status: 'proposed' })).items.filter(
        (m) => m.origin === 'ai',
      ),
    ).toEqual([]);
    // The founder corrects it: the correction is hers (and survives the conversation's deletion).
    const corrected = await h.core.memory.act(maya, item.id, {
      action: 'correct',
      patch: { content: 'Two libraries agreed to a pilot in December.' },
    });
    expect(corrected).toMatchObject({ approvedBy: { id: maya.principalId }, keptAutomatically: false });
    await h.core.sessions.remove(maya, session.id);
    expect((await h.core.memory.get(maya, corrected?.id ?? '')).status).toBe('confirmed');
    // What was kept from that conversation alone is gone with it; what others also taught stays, unlinked.
    const conversational = (m: (typeof kept)[number]) =>
      m.sourceRefs.filter((r) => r.kind === 'session' || r.kind === 'turn');
    for (const m of kept.slice(1)) {
      if (conversational(m).every((r) => r.id === session.id || r.id === turn.id)) {
        await expect(h.core.memory.get(maya, m.id)).rejects.toMatchObject({ code: 'not_found' });
      } else {
        const after = await h.core.memory.get(maya, m.id);
        expect(after.sourceRefs.map((r) => r.id)).not.toContain(session.id);
      }
    }
    // Forgetting is the founder's at any time.
    const again = await h.core.sessions.create(maya, quietquad(), {});
    const t2 = await talk(maya, again.id, 'We hired a part-time researcher.');
    const learned = (await h.core.memory.list(maya, quietquad(), { status: 'confirmed' })).items.find((m) =>
      m.sourceRefs.some((r) => r.kind === 'turn' && r.id === t2.id),
    );
    if (learned === undefined) throw new Error('nothing kept');
    expect(await h.core.memory.act(maya, learned.id, { action: 'delete' })).toBeNull();
    await expect(h.core.memory.get(maya, learned.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('what the vEIR keeps', () => {
  /** Candidates the model proposes for a founder message (by its first word), with the mock's other fields. */
  const proposals: Record<string, MemoryCandidate[]> = {};
  /** Embeddings that know two wordings of the pilot budget mean the same thing. */
  class MeaningGateway extends MockModelGateway {
    override async embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
      const result = await super.embed(texts, options);
      const budget = result.vectors[0]?.map((_, i) => (i === 0 ? 1 : 0)) ?? [];
      return {
        ...result,
        vectors: result.vectors.map((v, i) => (/pilot (budget|spend)/i.test(texts[i] ?? '') ? budget : v)),
      };
    }
  }
  const candidate = (title: string, content: string): MemoryCandidate => ({
    type: 'fact',
    title,
    content,
    evidence_ids: [],
    confidence: 0.7,
  });

  it('keeps the founder’s own words, never the coach’s advice alone, and each thing once by meaning', async () => {
    const gateway = new MeaningGateway({
      streamDelayMs: 0,
      fixtures: {
        [COACH_ANNOTATIONS_SCHEMA_NAME]: (context: MockGenerateContext) => {
          const { answer: _answer, spoken: _spoken, ...annotations } = mockCoachResponse(context);
          const key = context.founderText.split(/\s+/)[0] ?? '';
          return { ...annotations, memory_candidates: proposals[key] ?? [] };
        },
      },
    });
    const core = createCore({
      db: h.t.db,
      gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger: h.logger,
    });
    const say = async (sessionId: string, text: string): Promise<TurnView> => {
      const events: TurnStreamEvent[] = [];
      await core.orchestrator.runTurn(maya, sessionId, { text }, (e) => {
        events.push(TurnStreamEvent.parse(e));
      });
      const last = events.at(-1);
      if (last?.event !== 'turn.completed')
        throw new Error(`expected turn.completed, got ${last?.event ?? 'none'}`);
      return last.turn;
    };
    const learnedFrom = async (turnId: string) =>
      (await h.t.db.system((sx) => memoryRepo.listMemory(sx, { ventureId: quietquad(), limit: 500 }))).filter(
        (m) => m.sourceRefs.some((r) => r.kind === 'turn' && r.id === turnId),
      );

    // The founder's own goal is kept (embedded, so "do you remember…" finds it by meaning); the coach's
    // standing advice, which nothing the founder said supports, is not.
    proposals.Honestly = [
      candidate('Personal goal', 'Maya wants the startup to make her rich quickly.'),
      candidate(
        'Regulatory pathway undecided',
        'The regulatory classification and reimbursement pathway are undecided.',
      ),
    ];
    const first = await core.sessions.create(maya, quietquad(), {});
    const goalTurn = await say(first.id, 'Honestly I just want this startup to make me rich, quickly.');
    const kept = await learnedFrom(goalTurn.id);
    expect(kept.map((m) => m.title)).toEqual(['Personal goal']);
    expect(kept[0]).toMatchObject({ keptAutomatically: true, hasEmbedding: true });

    // The same thing said another way in a later conversation is not kept twice: it names the new conversation.
    proposals.Our = [candidate('Pilot budget', 'The pilot budget is capped at five thousand.')];
    const budgetTurn = await say(first.id, 'Our pilot budget is capped at five thousand.');
    const [budget] = await learnedFrom(budgetTurn.id);
    if (budget === undefined) throw new Error('the budget was not kept');
    proposals.We = [candidate('Pilot spending limit', 'Pilot spending cannot go beyond the cap we agreed.')];
    const second = await core.sessions.create(maya, quietquad(), {});
    const againTurn = await say(second.id, 'We cannot let pilot spending go beyond the cap.');
    const again = await learnedFrom(againTurn.id);
    expect(again.map((m) => m.id)).toEqual([budget.id]);
    expect(again[0]?.sourceRefs).toEqual(
      expect.arrayContaining([{ kind: 'session', id: second.id, label: 'Learned from the conversation' }]),
    );
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
