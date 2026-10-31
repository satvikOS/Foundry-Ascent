/**
 * Voice calls (migration 0008): one live call per person, a call's fixed identity and limits, minute
 * accounting by the database clock, microphone seconds and speech-to-text grants, who sees and changes calls
 * (RLS), turns joining their call, barge-in records and their redaction, what a call may speak of a turn, the
 * call summary's follow-ups and reaping calls whose client went away.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as callsRepo from './calls.js';
import * as memoryRepo from './memory.js';
import * as sessionsRepo from './sessions.js';
import * as turnsRepo from './turns.js';

let t: TestDatabase;
let seed: SeedResult;
type Ctx = ReturnType<typeof makeContext>;
let maya: Ctx;
let devin: Ctx;
let amara: Ctx;
let graham: Ctx;
let corin: Ctx;
let ruth: Ctx;
let lead: Ctx;

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

function venture(key: string): SeedResult['ventures'][number] {
  return must(seed.ventures.find((v) => v.key === key));
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

async function newSession(ctx: Ctx, ventureKey = 'quietquad'): Promise<string> {
  const v = venture(ventureKey);
  return t.db.withContext(ctx, async (tx) => {
    const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
    const session = await sessionsRepo.createSession(tx, {
      tenantId: seed.tenantId,
      ventureId: v.id,
      assignmentId: resolved.assignment.id,
      personaReleaseId: must(resolved.release).id,
      startedBy: ctx.principalId,
      mode: 'coach',
      privacy: 'standard',
      policyVersion: 'test',
    });
    return session.id;
  });
}

function startInput(ctx: Ctx, sessionId: string, ventureKey = 'quietquad'): callsRepo.StartCallInput {
  const v = venture(ventureKey);
  return {
    tenantId: seed.tenantId,
    ventureId: v.id,
    sessionId,
    personaId: v.personaId,
    startedBy: ctx.principalId,
    provider: 'builtin',
    inputMode: 'transcribe',
    voiceId: 'Matthew',
    maxSeconds: 1800,
  };
}

async function startCall(
  ctx: Ctx,
  sessionId: string,
  ventureKey = 'quietquad',
): Promise<callsRepo.CallRecord> {
  return t.db.withContext(ctx, (tx) => callsRepo.startCall(tx, startInput(ctx, sessionId, ventureKey)));
}

async function endCall(ctx: Ctx, callId: string): Promise<void> {
  await t.db.withContext(ctx, (tx) =>
    callsRepo.endCall(tx, { callId, reason: 'user', detail: 'client_user' }),
  );
}

async function addTurn(ctx: Ctx, sessionId: string, options: { callId?: string; answer?: unknown } = {}) {
  return t.db.withContext(ctx, async (tx) => {
    if (options.callId !== undefined) {
      // A caller naming the call explicitly (the turn path may).
      const r = await tx.query(
        `INSERT INTO turns (tenant_id, venture_id, session_id, ordinal, author_id, mode, founder_text, channel, call_id)
         SELECT :t, s.venture_id, s.id, coalesce((SELECT max(x.ordinal) FROM turns x WHERE x.session_id = s.id), 0) + 1,
                :me, 'coach', 'Spoken words', 'voice', :call
         FROM coaching_sessions s WHERE s.id = :s RETURNING id, call_id`,
        {
          t: p.uuid(seed.tenantId),
          me: p.uuid(ctx.principalId),
          s: p.uuid(sessionId),
          call: p.uuid(options.callId),
        },
      );
      return { id: String(r.rows[0]?.id), callId: r.rows[0]?.call_id ?? null };
    }
    const turn = await turnsRepo.createTurn(tx, {
      tenantId: seed.tenantId,
      ventureId: venture('quietquad').id,
      sessionId,
      authorId: ctx.principalId,
      mode: 'coach',
      founderText: 'Spoken words',
      channel: 'voice',
    });
    if (options.answer !== undefined) {
      await tx.query(
        `UPDATE turns SET status = 'completed', response = :r, completed_at = now() WHERE id = :id`,
        {
          id: p.uuid(turn.id),
          r: p.json(options.answer),
        },
      );
    }
    const r = await tx.query('SELECT call_id FROM turns WHERE id = :id', { id: p.uuid(turn.id) });
    return { id: turn.id, callId: r.rows[0]?.call_id ?? null };
  });
}

/** Moves a call's clock back (owner role), as if it started `minutes` ago with a heartbeat `beatMinutesAgo`. */
async function backdate(callId: string, minutes: number, beatMinutesAgo: number | null): Promise<void> {
  await t.db.system(async (sx) => {
    await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
    await sx.query(
      `UPDATE calls SET started_at = now() - make_interval(mins => :m),
                        last_heartbeat_at = CASE WHEN :b::integer IS NULL THEN NULL
                                                 ELSE now() - make_interval(mins => :b::integer) END
       WHERE id = :id`,
      { id: p.uuid(callId), m: p.int(minutes), b: p.nullable.int(beatMinutesAgo) },
    );
    await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
  });
}

beforeAll(async () => {
  t = await createTestDatabase({ seed: true });
  seed = must(t.seed);
  const ctx = (key: string): Ctx => makeContext(must(seed.principals[key]), seed.tenantId);
  maya = ctx('maya');
  devin = ctx('devin');
  amara = ctx('amara');
  graham = ctx('graham');
  corin = ctx('eir-corin');
  ruth = ctx('eir-ruth');
  lead = makeContext(must(seed.programLeadId), seed.tenantId);
});
afterAll(async () => {
  await t.cleanup();
});

describe('one live call per person', () => {
  it('refuses a second live call until the first ends; other people call at the same time', async () => {
    const session = await newSession(maya);
    const first = await startCall(maya, session);
    expect(first).toMatchObject({ status: 'live', inputMode: 'transcribe', maxSeconds: 1800, sttGrants: 0 });
    expect(first.elapsedSeconds).toBeLessThan(5);
    expect(callsRepo.toCallView(first)).toMatchObject({ durationSeconds: null, endReason: null });
    const other = await newSession(maya);
    expect(await sqlState(startCall(maya, other))).toBe('23505');
    const devinSession = await newSession(devin);
    const devins = await startCall(devin, devinSession);
    await endCall(maya, first.id);
    const second = await startCall(maya, other);
    await t.db.withContext(maya, async (tx) => {
      expect((await callsRepo.getLiveCallOf(tx, maya.principalId))?.id).toBe(second.id);
      const ended = must(await callsRepo.getCall(tx, first.id));
      expect(ended).toMatchObject({ status: 'ended', endReason: 'user', endDetail: 'client_user' });
      expect(callsRepo.toCallView(ended).durationSeconds).toBe(ended.elapsedSeconds);
      // Ending twice changes nothing.
      expect(
        await callsRepo.endCall(tx, { callId: first.id, reason: 'error', detail: 'client_error' }),
      ).toBeNull();
    });
    await endCall(maya, second.id);
    await endCall(devin, devins.id);
  });

  it('keeps a call’s identity, limits and start fixed, and an ended call ended', async () => {
    const session = await newSession(maya);
    const call = await startCall(maya, session);
    const change = (sql: string) =>
      sqlState(t.db.withContext(maya, (tx) => tx.query(sql, { id: p.uuid(call.id) })));
    expect(await change('UPDATE calls SET max_seconds = 9000 WHERE id = :id')).toBe('55000');
    expect(await change('UPDATE calls SET started_at = now() WHERE id = :id')).toBe('55000');
    expect(await change(`UPDATE calls SET voice_id = 'Joanna' WHERE id = :id`)).toBe('55000');
    await endCall(maya, call.id);
    expect(
      await change(`UPDATE calls SET status = 'live', ended_at = NULL, end_reason = NULL WHERE id = :id`),
    ).toBe('55000');
    expect(await change(`UPDATE calls SET end_reason = 'budget' WHERE id = :id`)).toBe('55000');
    await t.db.withContext(maya, async (tx) => {
      // Counters still move after the end (speech billed for the last unit).
      await callsRepo.addSpeechCharacters(tx, { callId: call.id, characters: 42 });
      expect((await callsRepo.getCall(tx, call.id))?.speechCharacters).toBe(42);
    });
  });
});

describe('call minutes', () => {
  const GRACE = 30;
  const secondsToday = (ctx: Ctx, principalId: string) =>
    t.db.withContext(ctx, (tx) => callsRepo.callSecondsToday(tx, { principalId, graceSeconds: GRACE }));

  it('counts ended calls, live calls until now, and abandoned calls until shortly after their last heartbeat', async () => {
    const ctx = makeContext(must(seed.principals.tomasz), seed.tenantId);
    expect(await secondsToday(ctx, ctx.principalId)).toBe(0);
    const sessionId = await newSession(ctx, 'benchtally');
    const ended = await startCall(ctx, sessionId, 'benchtally');
    await backdate(ended.id, 12, 2);
    await endCall(ctx, ended.id);
    const live = await startCall(ctx, sessionId, 'benchtally');
    await backdate(live.id, 5, 0);
    const seconds = await secondsToday(ctx, ctx.principalId);
    const startOfDay = await t.db.system(async (sx) => {
      const r = await sx.query(
        `SELECT floor(extract(epoch FROM now() - (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')))::integer AS s`,
      );
      return Number(r.rows[0]?.s);
    });
    // Near midnight UTC part of each call fell on yesterday; otherwise 12 + 5 minutes.
    expect(seconds).toBeGreaterThanOrEqual(Math.min(17 * 60, startOfDay) - 2);
    expect(seconds).toBeLessThanOrEqual(17 * 60 + 2);
    // The live call's client went away 4 minutes ago: it counts until the grace after its last heartbeat …
    await backdate(live.id, 5, 4);
    const abandoned = await secondsToday(ctx, ctx.principalId);
    if (startOfDay >= 17 * 60 + 60) {
      expect(abandoned).toBeLessThanOrEqual(seconds - 4 * 60 + GRACE + 2);
      expect(abandoned).toBeGreaterThanOrEqual(seconds - 4 * 60 + GRACE - 2);
    } else {
      // Within minutes of midnight UTC the calls straddle two days: only today's part counts, so the drop from
      // the client going away is clipped at midnight. Still never more than before, never negative.
      expect(abandoned).toBeLessThanOrEqual(seconds);
      expect(abandoned).toBeGreaterThanOrEqual(0);
    }
    // … which is where reaping closes it: the count is the same before and after.
    await t.db.system((sx) => callsRepo.reapStaleCalls(sx, { staleSeconds: 60, graceSeconds: GRACE }));
    expect(await secondsToday(ctx, ctx.principalId)).toBe(abandoned);
    // Other people's minutes are their own.
    expect(await secondsToday(maya, ctx.principalId)).toBe(0);
  });

  it('adds the microphone seconds a heartbeat reports, never beyond the wall time since the previous one', async () => {
    const ctx = makeContext(must(seed.principals.priya), seed.tenantId);
    const session = await newSession(ctx, 'benchtally');
    const call = await startCall(ctx, session, 'benchtally');
    const beat = (mic: number) =>
      t.db.withContext(ctx, async (tx) =>
        must(
          await callsRepo.recordHeartbeat(tx, { callId: call.id, state: 'listening', micOpenSeconds: mic }),
        ),
      );
    // Fresh call, a few seconds old: a client claiming an hour gets the wall time plus the slack.
    const first = await beat(3600);
    expect(first.micSecondsAdded).toBeLessThanOrEqual(callsRepo.MIC_SECONDS_SLACK + 2);
    expect(first.call.micOpenSeconds).toBe(first.micSecondsAdded);
    expect(first.call.lastHeartbeatAt).not.toBeNull();
    expect(first.call.idleSeconds).toBeLessThan(5);
    // Twenty seconds later the honest total (+12) is taken whole; a lower total adds nothing.
    await t.db.system(async (sx) => {
      await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
      await sx.query(
        `UPDATE calls SET started_at = started_at - interval '20 seconds',
                          last_heartbeat_at = now() - interval '20 seconds'
         WHERE id = :id`,
        { id: p.uuid(call.id) },
      );
      await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
    });
    const second = await beat(first.call.micOpenSeconds + 12);
    expect(second.micSecondsAdded).toBe(12);
    expect((await beat(0)).micSecondsAdded).toBe(0);
    await endCall(ctx, call.id);
    // Speech-to-text grants of the calls the person started today.
    await t.db.withContext(ctx, async (tx) => {
      const other = await callsRepo.startCall(tx, startInput(ctx, session, 'benchtally'));
      await callsRepo.recordSttGrant(tx, { callId: other.id, maxGrants: 20 });
      await callsRepo.recordSttGrant(tx, { callId: other.id, maxGrants: 20 });
      expect(await callsRepo.sttGrantsToday(tx, ctx.principalId)).toBe(2);
      expect(await callsRepo.sttGrantsToday(tx, maya.principalId)).toBe(0);
      await callsRepo.endCall(tx, { callId: other.id, reason: 'user', detail: 'client_user' });
    });
  });

  it('never credits more microphone seconds than the call has lasted, however fast or concurrent the heartbeats', async () => {
    const ctx = makeContext(must(seed.principals.priya), seed.tenantId);
    const session = await newSession(ctx, 'benchtally');
    const call = await startCall(ctx, session, 'benchtally');
    const beat = (mic: number, holdSeconds = 0) =>
      t.db.withContext(ctx, async (tx) => {
        const recorded = must(
          await callsRepo.recordHeartbeat(tx, { callId: call.id, state: 'listening', micOpenSeconds: mic }),
        );
        // Keeps the row locked, so a concurrent heartbeat on another connection waits for this one.
        if (holdSeconds > 0) await tx.query('SELECT pg_sleep(:s)', { s: p.num(holdSeconds) });
        return recorded;
      });
    const lasted = async (): Promise<callsRepo.CallRecord> =>
      must(await t.db.withContext(ctx, (tx) => callsRepo.getCall(tx, call.id)));
    // A client claiming a whole day on every beat, beat after beat, gets the wall time plus one slack.
    for (let i = 0; i < 30; i += 1) await beat(86_400);
    // Two connections at once: the second waits for the first's lock, then is bounded the same way.
    await Promise.all([beat(86_400, 0.3), beat(86_400), beat(86_400)]);
    const now = await lasted();
    expect(now.micOpenSeconds).toBeLessThanOrEqual(now.elapsedSeconds + 1 + callsRepo.MIC_SECONDS_SLACK);
    // A minute on, that minute can be claimed, and still no more than the call has lasted.
    await t.db.system(async (sx) => {
      await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
      await sx.query(
        `UPDATE calls SET started_at = started_at - interval '60 seconds',
                          last_heartbeat_at = last_heartbeat_at - interval '60 seconds'
         WHERE id = :id`,
        { id: p.uuid(call.id) },
      );
      await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
    });
    for (let i = 0; i < 10; i += 1) await beat(86_400);
    const later = await lasted();
    expect(later.micOpenSeconds).toBeGreaterThanOrEqual(60);
    expect(later.micOpenSeconds).toBeLessThanOrEqual(later.elapsedSeconds + 1 + callsRepo.MIC_SECONDS_SLACK);
    await endCall(ctx, call.id);
  });
});

describe('who sees and changes calls', () => {
  it('shows a call to its caller, the venture team and its assigned EIR only', async () => {
    const session = await newSession(maya);
    const call = await startCall(maya, session);
    const visible = (ctx: Ctx) =>
      t.db.withContext(ctx, async (tx) => (await callsRepo.getCall(tx, call.id)) !== null);
    expect(await visible(maya)).toBe(true);
    expect(await visible(devin)).toBe(true);
    expect(await visible(corin)).toBe(true);
    expect(await visible(ruth)).toBe(false);
    expect(await visible(amara)).toBe(false);
    expect(await visible(graham)).toBe(false);
    expect(await visible(lead)).toBe(false);
    expect(await visible(makeContext(maya.principalId, randomUUID()))).toBe(false);
    // Only the caller changes it.
    await t.db.withContext(devin, async (tx) => {
      expect(
        await callsRepo.endCall(tx, { callId: call.id, reason: 'user', detail: 'client_user' }),
      ).toBeNull();
      expect(
        await callsRepo.recordHeartbeat(tx, { callId: call.id, state: 'idle', micOpenSeconds: 1 }),
      ).toBeNull();
    });
    await t.db.withContext(maya, async (tx) => {
      const beat = must(
        await callsRepo.recordHeartbeat(tx, { callId: call.id, state: 'listening', micOpenSeconds: 30 }),
      );
      expect(beat.call.lastHeartbeatAt).not.toBeNull();
      expect(beat.call.idleSeconds).toBeLessThan(5);
      const granted = must(await callsRepo.recordSttGrant(tx, { callId: call.id, maxGrants: 2 }));
      expect(granted.sttGrants).toBe(1);
      expect(must(await callsRepo.recordSttGrant(tx, { callId: call.id, maxGrants: 2 })).sttGrants).toBe(2);
      expect(await callsRepo.recordSttGrant(tx, { callId: call.id, maxGrants: 2 })).toBeNull();
    });
    await endCall(maya, call.id);
  });

  it('starts calls only as oneself, on an active conversation of one’s own venture', async () => {
    const session = await newSession(maya);
    await t.db.withContext(maya, async (tx) => {
      expect(await sqlState(callsRepo.startCall(tx, { ...startInput(devin, session) }))).toBe('42501');
    });
    // Amara (SoleSignal) cannot start a call on a QuietQuad conversation.
    await t.db.withContext(amara, async (tx) => {
      expect(await sqlState(callsRepo.startCall(tx, startInput(amara, session)))).toBe('42501');
    });
    // An ended conversation takes no calls.
    await t.db.withContext(maya, async (tx) => {
      await sessionsRepo.endSession(tx, { sessionId: session, recap: null });
      expect(await sqlState(callsRepo.startCall(tx, startInput(maya, session)))).toBe('42501');
    });
  });
});

describe('turns of a call', () => {
  it('joins turns to the live call of their author and conversation, records barge-in, and summarizes', async () => {
    const session = await newSession(maya);
    const before = await addTurn(maya, session);
    expect(before.callId).toBeNull();
    const call = await startCall(maya, session);
    const answer = {
      answer: 'Run it.',
      spoken: 'Run it in exam weeks. Then compare.',
      next_actions: [{ owner: 'Maya', action: 'Book two libraries', target_date: null }],
    };
    const first = await addTurn(maya, session, { answer });
    expect(first.callId).toBe(call.id);
    // A teammate's turn in the same conversation is theirs, not part of Maya's call.
    const devinTurn = await addTurn(devin, session);
    expect(devinTurn.callId).toBeNull();
    // Naming another person's or an ended call is refused.
    const explicit = await addTurn(maya, session, { callId: call.id });
    expect(explicit.callId).toBe(call.id);
    expect(await sqlState(addTurn(devin, session, { callId: call.id }))).toBe('23514');

    await t.db.withContext(maya, async (tx) => {
      expect(await callsRepo.countCallTurns(tx, call.id)).toBe(2);
      const marked = must(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: first.id,
          callId: call.id,
          authorId: maya.principalId,
          heardSeq: 0,
          heardText: 'Run it in exam weeks.',
        }),
      );
      expect(marked).toMatchObject({ heardSeq: 0, heardText: 'Run it in exam weeks.' });
      // The first record wins.
      const again = must(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: first.id,
          callId: call.id,
          authorId: maya.principalId,
          heardSeq: 3,
          heardText: 'Run it in exam weeks. Then compare.',
        }),
      );
      expect(again).toEqual(marked);
      // A turn outside the call is not interrupted through it.
      expect(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: before.id,
          callId: call.id,
          authorId: maya.principalId,
          heardSeq: 1,
          heardText: null,
        }),
      ).toBeNull();
      const interruptions = await callsRepo.listTurnInterruptions(tx, [first.id, before.id, explicit.id]);
      expect([...interruptions.keys()]).toEqual([first.id]);
      const turns = await callsRepo.listCallTurns(tx, call.id);
      expect(turns.map((x) => x.id)).toEqual([first.id, explicit.id]);
      expect(turns[0]?.nextActions).toEqual(answer.next_actions);
      expect(turns[1]?.nextActions).toEqual([]);
      expect(
        await callsRepo.countRecentVoiceTurns(tx, { authorId: maya.principalId, windowSeconds: 600 }),
      ).toBeGreaterThanOrEqual(3);
    });
    // The turn's checks hold in the database too: no heard record without its time, no words for a reply
    // the founder heard none of.
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query('UPDATE turns SET heard_seq = 2 WHERE id = :id', { id: p.uuid(before.id) }),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query(
            `UPDATE turns SET heard_seq = -1, interrupted_at = now(), heard_text = 'Words' WHERE id = :id`,
            { id: p.uuid(before.id) },
          ),
        ),
      ),
    ).toBe('23514');

    // Follow-ups: AI proposals still awaiting review and escalations from the call's turns.
    const followUps = await t.db.system(async (sx) => {
      const memory = await sx.query(
        `INSERT INTO memory_objects (tenant_id, venture_id, type, title, content, origin, created_by, source_refs)
         VALUES (:t, :v, 'fact', 'Exam weeks', 'Demand peaks in exam weeks.', 'ai', :maya, :refs) RETURNING id`,
        {
          t: p.uuid(seed.tenantId),
          v: p.uuid(venture('quietquad').id),
          maya: p.uuid(maya.principalId),
          refs: p.json([{ kind: 'turn', id: first.id }]),
        },
      );
      return String(memory.rows[0]?.id);
    });
    // What the vEIR kept by itself from the call is listed apart from proposals (migration 0013).
    const kept = await t.db.withContext(maya, async (tx) =>
      memoryRepo.createMemory(tx, {
        tenantId: seed.tenantId,
        ventureId: venture('quietquad').id,
        type: 'fact',
        title: 'Two libraries',
        content: 'The pilot runs in two libraries.',
        origin: 'ai',
        keptAutomatically: true,
        createdBy: maya.principalId,
        sourceRefs: [{ kind: 'turn', id: explicit.id }],
      }),
    );
    await t.db.withContext(maya, async (tx) => {
      const refs = await callsRepo.callFollowUps(tx, {
        ventureId: venture('quietquad').id,
        turnIds: [first.id, explicit.id],
      });
      expect(refs).toEqual({ memoryProposalIds: [followUps], memoryKeptIds: [kept.id], escalationIds: [] });
      expect(await callsRepo.callFollowUps(tx, { ventureId: venture('quietquad').id, turnIds: [] })).toEqual({
        memoryProposalIds: [],
        memoryKeptIds: [],
        escalationIds: [],
      });
    });
    await endCall(maya, call.id);
    expect((await addTurn(maya, session)).callId).toBeNull();
  });

  it('does not join turns to a call whose client went away', async () => {
    const session = await newSession(devin);
    const call = await startCall(devin, session);
    await backdate(call.id, 3, 2);
    expect((await addTurn(devin, session)).callId).toBeNull();
    await endCall(devin, call.id);
  });
});

describe('what the founder heard', () => {
  const heardOf = (turnId: string) =>
    t.db.system(async (sx) => (await callsRepo.listTurnInterruptions(sx, [turnId])).get(turnId) ?? null);

  async function interrupted(ctx: Ctx, privacy: 'standard' | 'ephemeral' = 'standard') {
    const v = venture('quietquad');
    const session = await t.db.withContext(ctx, async (tx) => {
      const resolved = must(await assignmentsRepo.resolveActiveAssignment(tx, v.id));
      return (
        await sessionsRepo.createSession(tx, {
          tenantId: seed.tenantId,
          ventureId: v.id,
          assignmentId: resolved.assignment.id,
          personaReleaseId: must(resolved.release).id,
          startedBy: ctx.principalId,
          mode: 'coach',
          privacy,
          policyVersion: 'test',
        })
      ).id;
    });
    const call = await startCall(ctx, session);
    const turn = await addTurn(ctx, session, {
      answer: { answer: 'Run it.', spoken: 'Run it. Then compare.' },
    });
    await t.db.withContext(ctx, async (tx) => {
      must(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: turn.id,
          callId: call.id,
          authorId: ctx.principalId,
          heardSeq: 0,
          heardText: 'Run it.',
        }),
      );
    });
    return { session, call, turn };
  }

  it('goes with the conversation’s words when they are redacted or deleted', async () => {
    // A deleted conversation.
    const deleted = await interrupted(maya);
    expect((await heardOf(deleted.turn.id))?.heardText).toBe('Run it.');
    await endCall(maya, deleted.call.id);
    expect(await t.db.withContext(maya, (tx) => sessionsRepo.softDeleteSession(tx, deleted.session))).toBe(
      true,
    );
    expect(await heardOf(deleted.turn.id)).toMatchObject({ heardSeq: 0, heardText: null });
    // An ended temporary chat.
    const temporary = await interrupted(devin, 'ephemeral');
    await endCall(devin, temporary.call.id);
    await t.db.withContext(devin, (tx) => turnsRepo.redactSessionTurns(tx, temporary.session));
    expect(await heardOf(temporary.turn.id)).toMatchObject({ heardSeq: 0, heardText: null });
  });

  it('is recorded only while the conversation is active', async () => {
    const { session, call, turn } = await interrupted(devin);
    const other = await addTurn(devin, session, { answer: { answer: 'More.', spoken: 'More.' } });
    await t.db.withContext(devin, async (tx) => {
      await sessionsRepo.endSession(tx, { sessionId: session, recap: null });
      expect(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: other.id,
          callId: call.id,
          authorId: devin.principalId,
          heardSeq: 0,
          heardText: 'More.',
        }),
      ).toBeNull();
    });
    expect(await heardOf(other.id)).toBeNull();
    expect((await heardOf(turn.id))?.heardText).toBe('Run it.');
    await endCall(devin, call.id);
  });
});

describe('what a call may speak of a turn', () => {
  it('reads a turn’s spoken form, its call and whether it was answered with crisis support', async () => {
    const session = await newSession(maya);
    const call = await startCall(maya, session);
    const turn = await addTurn(maya, session, {
      answer: { answer: 'The **full** answer [E1].', spoken: 'The short spoken answer.' },
    });
    await t.db.withContext(maya, async (tx) => {
      const spoken = must(await callsRepo.getSpokenTurn(tx, turn.id));
      expect(spoken).toMatchObject({
        turnId: turn.id,
        sessionId: session,
        ventureId: venture('quietquad').id,
        authorId: maya.principalId,
        callId: call.id,
        status: 'completed',
        spoken: 'The short spoken answer.',
        crisisSupport: false,
      });
      expect(spoken.ageSeconds).toBeLessThan(5);
    });
    await t.db.system((sx) =>
      sx.query(
        `UPDATE turns SET status = 'blocked', validator_results = '{"notes": ["crisis_support", "no_model_call"]}'
         WHERE id = :id`,
        { id: p.uuid(turn.id) },
      ),
    );
    await t.db.withContext(maya, async (tx) => {
      expect(await callsRepo.getSpokenTurn(tx, turn.id)).toMatchObject({
        status: 'blocked',
        crisisSupport: true,
      });
    });
    // Another venture's founder sees nothing.
    await t.db.withContext(amara, async (tx) => {
      expect(await callsRepo.getSpokenTurn(tx, turn.id)).toBeNull();
    });
    await endCall(maya, call.id);
  });
});

describe('what a call synthesizes', () => {
  const budget: callsRepo.SpeechBudget = {
    charactersPerSecond: 15,
    headroomCharacters: 100,
    dailyCharacters: 1_000,
  };
  const tomasz = (): Ctx => makeContext(must(seed.principals.tomasz), seed.tenantId);
  const reserve = (
    ctx: Ctx,
    callId: string,
    unit: callsRepo.SpeechUnitKey,
    characters: number,
    options: { maxPlays?: number; budget?: callsRepo.SpeechBudget } = {},
  ) =>
    t.db.system((sx) =>
      callsRepo.reserveCallSpeech(sx, {
        callId,
        principalId: ctx.principalId,
        unit,
        characters,
        maxPlays: options.maxPlays ?? 1,
        budget: options.budget ?? budget,
      }),
    );
  const spoken = async (callId: string): Promise<number> =>
    must(await t.db.system((sx) => callsRepo.getCall(sx, callId))).speechCharacters;
  /** Moves the call's start back by `seconds` (owner role). */
  const age = (callId: string, seconds: number) =>
    t.db.system(async (sx) => {
      await sx.query('ALTER TABLE calls DISABLE TRIGGER calls_guard');
      await sx.query('UPDATE calls SET started_at = started_at - make_interval(secs => :s) WHERE id = :id', {
        id: p.uuid(callId),
        s: p.int(seconds),
      });
      await sx.query('ALTER TABLE calls ENABLE TRIGGER calls_guard');
    });

  /**
   * How far back a call can be moved and still have started today (UTC): the day's budget counts the calls
   * started today, so near midnight an hour back would move them into yesterday. Waits out the first two
   * minutes of a day so there is always room.
   */
  const ageWithinToday = async (seconds: number): Promise<number> => {
    const sinceMidnight = async () =>
      t.db.system(async (sx) => {
        const r = await sx.query(
          `SELECT floor(extract(epoch FROM now() - (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')))::integer AS s`,
        );
        return Number(r.rows[0]?.s);
      });
    let since = await sinceMidnight();
    if (since < 120) {
      await new Promise((resolve) => setTimeout(resolve, (121 - since) * 1000));
      since = await sinceMidnight();
    }
    return Math.min(seconds, since - 30);
  };

  it('speaks each unit its number of times, within the call’s and the day’s character budgets', async () => {
    const ctx = tomasz();
    const session = await newSession(ctx, 'benchtally');
    const call = await startCall(ctx, session, 'benchtally');
    const turnId = randomUUID();
    // The intro once: a replay is refused and changes nothing.
    expect(await reserve(ctx, call.id, { kind: 'intro' }, 60)).toEqual({ ok: true, plays: 1 });
    expect(await reserve(ctx, call.id, { kind: 'intro' }, 60)).toEqual({
      ok: false,
      reason: 'already_played',
    });
    expect(await spoken(call.id)).toBe(60);
    // A run of stored sentences as many times as allowed.
    const run: callsRepo.SpeechUnitKey = { kind: 'run', turnId, first: 0, last: 1 };
    expect(await reserve(ctx, call.id, run, 10, { maxPlays: 2 })).toEqual({ ok: true, plays: 1 });
    expect(await reserve(ctx, call.id, run, 10, { maxPlays: 2 })).toEqual({ ok: true, plays: 2 });
    expect(await reserve(ctx, call.id, run, 10, { maxPlays: 2 })).toEqual({
      ok: false,
      reason: 'already_played',
    });
    expect(await t.db.system((sx) => callsRepo.speechPlays(sx, { callId: call.id, unit: run }))).toBe(2);
    // A call that has hardly started has the headroom only: 80 of 100 are used.
    const unit = (seq: number): callsRepo.SpeechUnitKey => ({ kind: 'unit', turnId, seq });
    expect(await reserve(ctx, call.id, unit(0), 21)).toEqual({ ok: false, reason: 'call_budget' });
    expect(await reserve(ctx, call.id, unit(0), 20)).toEqual({ ok: true, plays: 1 });
    expect(await spoken(call.id)).toBe(100);
    // Ten seconds on, 150 more (15 a second), and not one more.
    await age(call.id, 10);
    expect(await reserve(ctx, call.id, unit(1), 151)).toEqual({ ok: false, reason: 'call_budget' });
    expect(await reserve(ctx, call.id, unit(1), 150)).toEqual({ ok: true, plays: 1 });
    // A synthesis that failed gives its play and characters back; one billed differently is corrected.
    await t.db.system((sx) =>
      callsRepo.settleCallSpeech(sx, {
        callId: call.id,
        unit: unit(1),
        reservedCharacters: 150,
        characters: null,
      }),
    );
    expect(await spoken(call.id)).toBe(100);
    expect(await reserve(ctx, call.id, unit(1), 150)).toEqual({ ok: true, plays: 1 });
    await t.db.system((sx) =>
      callsRepo.settleCallSpeech(sx, {
        callId: call.id,
        unit: unit(1),
        reservedCharacters: 150,
        characters: 140,
      }),
    );
    expect(await spoken(call.id)).toBe(240);
    // Only the caller's own live call.
    expect(await reserve(maya, call.id, unit(2), 1)).toEqual({ ok: false, reason: 'call_not_active' });
    await endCall(ctx, call.id);
    expect(await reserve(ctx, call.id, unit(2), 1)).toEqual({ ok: false, reason: 'call_not_active' });
    expect(await spoken(call.id)).toBe(240);

    // However long a call lasts, never more than the rate over its time limit (here 4 s: 60 characters).
    const short = await t.db.withContext(ctx, (tx) =>
      callsRepo.startCall(tx, { ...startInput(ctx, session, 'benchtally'), maxSeconds: 4 }),
    );
    await age(short.id, await ageWithinToday(3_600));
    expect(await reserve(ctx, short.id, unit(3), 61)).toEqual({ ok: false, reason: 'call_budget' });
    expect(await reserve(ctx, short.id, unit(3), 60)).toEqual({ ok: true, plays: 1 });
    await endCall(ctx, short.id);

    // The person's day: what their other calls today synthesized counts (240 + 60 so far).
    const next = await startCall(ctx, session, 'benchtally');
    await age(next.id, await ageWithinToday(3_600));
    const day = { ...budget, dailyCharacters: 400 };
    expect(await reserve(ctx, next.id, unit(4), 101, { budget: day })).toEqual({
      ok: false,
      reason: 'daily_budget',
    });
    expect(await reserve(ctx, next.id, unit(4), 100, { budget: day })).toEqual({ ok: true, plays: 1 });
    expect(await reserve(ctx, next.id, unit(5), 1, { budget: day })).toEqual({
      ok: false,
      reason: 'daily_budget',
    });
    // Someone else's day is their own.
    const priya = makeContext(must(seed.principals.priya), seed.tenantId);
    const theirs = await startCall(priya, await newSession(priya, 'benchtally'), 'benchtally');
    expect(await reserve(priya, theirs.id, unit(4), 100, { budget: day })).toEqual({ ok: true, plays: 1 });
    await endCall(priya, theirs.id);
    await endCall(ctx, next.id);
  }, 180_000);

  it('serialises concurrent requests on two connections: a unit is not replayed and a budget not overrun', async () => {
    const ctx = tomasz();
    const session = await newSession(ctx, 'benchtally');
    const call = await startCall(ctx, session, 'benchtally');
    const turnId = randomUUID();
    const unit = (seq: number): callsRepo.SpeechUnitKey => ({ kind: 'unit', turnId, seq });
    /** Reserves on one connection and keeps the transaction (and the call's row lock) open for a while. */
    const held = (key: callsRepo.SpeechUnitKey, characters: number) =>
      t.db.system(async (sx) => {
        const result = await callsRepo.reserveCallSpeech(sx, {
          callId: call.id,
          principalId: ctx.principalId,
          unit: key,
          characters,
          maxPlays: 1,
          budget,
        });
        await sx.query('SELECT pg_sleep(0.3)');
        return result;
      });
    const later = <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          fn().then(resolve, reject);
        }, 50);
      });
    // The same unit twice at once: the second waits for the first, then finds it played.
    const [first, second] = await Promise.all([
      held(unit(0), 30),
      later(() => reserve(ctx, call.id, unit(0), 30)),
    ]);
    expect(first).toEqual({ ok: true, plays: 1 });
    expect(second).toEqual({ ok: false, reason: 'already_played' });
    // Two units that each fit the headroom but not together: the second sees the first's characters.
    const [a, b] = await Promise.all([held(unit(1), 60), later(() => reserve(ctx, call.id, unit(2), 60))]);
    expect(a).toEqual({ ok: true, plays: 1 });
    expect(b).toEqual({ ok: false, reason: 'call_budget' });
    expect(await spoken(call.id)).toBe(90);
    // Many at once: exactly one play of a unit.
    const burst = await Promise.all(Array.from({ length: 12 }, () => reserve(ctx, call.id, unit(3), 1)));
    expect(burst.filter((r) => r.ok)).toHaveLength(1);
    await endCall(ctx, call.id);

    // A crisis message on an ended call: at most `maxPlays`, however many ask at once.
    const crisisTurn = randomUUID();
    const crisis = await Promise.all(
      Array.from({ length: 12 }, () =>
        t.db.system((sx) =>
          callsRepo.reserveCrisisSpeech(sx, {
            callId: call.id,
            principalId: ctx.principalId,
            turnId: crisisTurn,
            characters: 10,
            maxPlays: 5,
          }),
        ),
      ),
    );
    expect(crisis.filter((plays) => plays !== null).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await spoken(call.id)).toBe(141);
    // Only the turn's author.
    expect(
      await t.db.system((sx) =>
        callsRepo.reserveCrisisSpeech(sx, {
          callId: call.id,
          principalId: maya.principalId,
          turnId: randomUUID(),
          characters: 10,
          maxPlays: 5,
        }),
      ),
    ).toBeNull();
  });
});

describe('reaping', () => {
  it('ends calls whose client went away, at their last heartbeat plus the grace', async () => {
    const session = await newSession(amara, 'solesignal');
    const stale = await startCall(amara, session, 'solesignal');
    await backdate(stale.id, 10, 5);
    const reaped = await t.db.system((sx) =>
      callsRepo.reapStaleCalls(sx, { staleSeconds: 60, graceSeconds: 15 }),
    );
    // The conversation each reaped call was in comes back with it (maintenance distils it next), and its venture
    // (the face's end is audited there).
    expect(reaped).toContainEqual({ callId: stale.id, sessionId: session, ventureId: stale.ventureId });
    await t.db.withContext(amara, async (tx) => {
      const call = must(await callsRepo.getCall(tx, stale.id));
      expect(call).toMatchObject({ status: 'ended', endReason: 'timeout', endDetail: 'stale_heartbeat' });
      // Five minutes (start to last heartbeat) plus the 15 s grace.
      expect(call.elapsedSeconds).toBeGreaterThanOrEqual(5 * 60 + 14);
      expect(call.elapsedSeconds).toBeLessThanOrEqual(5 * 60 + 16);
    });
    // A healthy live call is left alone.
    const fresh = await startCall(amara, session, 'solesignal');
    await t.db.withContext(amara, (tx) =>
      callsRepo.recordHeartbeat(tx, { callId: fresh.id, state: 'speaking', micOpenSeconds: 3 }),
    );
    await t.db.system((sx) => callsRepo.reapStaleCalls(sx, { staleSeconds: 60, graceSeconds: 15 }));
    await t.db.withContext(amara, async (tx) => {
      expect((await callsRepo.getCall(tx, fresh.id))?.status).toBe('live');
    });
    await endCall(amara, fresh.id);
  });
});
