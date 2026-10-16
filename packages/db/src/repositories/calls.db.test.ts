/**
 * Voice calls (migration 0008): one live call per person, a call's fixed identity and limits, minute
 * accounting by the database clock, who sees and changes calls (RLS), turns joining their call, barge-in
 * records, the call summary's follow-ups and reaping calls whose client went away.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DbError } from '../errors.js';
import { p } from '../params.js';
import { type SeedResult } from '../seed/seed.js';
import { createTestDatabase, makeContext, type TestDatabase } from '../testing/test-database.js';
import * as assignmentsRepo from './assignments.js';
import * as callsRepo from './calls.js';
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
  it('counts ended calls, live calls until now, and abandoned calls until their last heartbeat', async () => {
    const ctx = makeContext(must(seed.principals.tomasz), seed.tenantId);
    const before = await t.db.withContext(ctx, (tx) =>
      callsRepo.callSecondsToday(tx, { principalId: ctx.principalId, staleSeconds: 60 }),
    );
    expect(before).toBe(0);
    const sessionId = await newSession(ctx, 'benchtally');
    const ended = await startCall(ctx, sessionId, 'benchtally');
    await backdate(ended.id, 12, 2);
    await endCall(ctx, ended.id);
    const live = await startCall(ctx, sessionId, 'benchtally');
    await backdate(live.id, 5, 0);
    const seconds = await t.db.withContext(ctx, (tx) =>
      callsRepo.callSecondsToday(tx, { principalId: ctx.principalId, staleSeconds: 60 }),
    );
    const startOfDay = await t.db.system(async (sx) => {
      const r = await sx.query(
        `SELECT floor(extract(epoch FROM now() - (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')))::integer AS s`,
      );
      return Number(r.rows[0]?.s);
    });
    // Near midnight UTC part of each call fell on yesterday; otherwise 12 + 5 minutes.
    expect(seconds).toBeGreaterThanOrEqual(Math.min(17 * 60, startOfDay) - 2);
    expect(seconds).toBeLessThanOrEqual(17 * 60 + 2);
    // The live call's client went away 4 minutes ago: it counts until a minute after its last heartbeat.
    await backdate(live.id, 5, 4);
    const abandoned = await t.db.withContext(ctx, (tx) =>
      callsRepo.callSecondsToday(tx, { principalId: ctx.principalId, staleSeconds: 60 }),
    );
    expect(abandoned).toBeLessThanOrEqual(seconds - 3 * 60 + 2);
    // Other people's minutes are their own.
    expect(
      await t.db.withContext(maya, (tx) =>
        callsRepo.callSecondsToday(tx, { principalId: ctx.principalId, staleSeconds: 60 }),
      ),
    ).toBe(0);
    await t.db.system((sx) => callsRepo.reapStaleCalls(sx, { staleSeconds: 60, graceSeconds: 15 }));
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
      expect(beat.lastHeartbeatAt).not.toBeNull();
      expect(beat.idleSeconds).toBeLessThan(5);
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
        }),
      );
      expect(marked.heardSeq).toBe(0);
      // The first record wins.
      const again = must(
        await callsRepo.markTurnInterrupted(tx, {
          turnId: first.id,
          callId: call.id,
          authorId: maya.principalId,
          heardSeq: 3,
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
    // The turn's checks hold in the database too.
    expect(
      await sqlState(
        t.db.system((sx) =>
          sx.query('UPDATE turns SET heard_seq = 2 WHERE id = :id', { id: p.uuid(before.id) }),
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
    await t.db.withContext(maya, async (tx) => {
      const refs = await callsRepo.callFollowUps(tx, {
        ventureId: venture('quietquad').id,
        turnIds: [first.id, explicit.id],
      });
      expect(refs).toEqual({ memoryProposalIds: [followUps], escalationIds: [] });
      expect(await callsRepo.callFollowUps(tx, { ventureId: venture('quietquad').id, turnIds: [] })).toEqual({
        memoryProposalIds: [],
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

describe('reaping', () => {
  it('ends calls whose client went away, at their last heartbeat plus the grace', async () => {
    const session = await newSession(amara, 'solesignal');
    const stale = await startCall(amara, session, 'solesignal');
    await backdate(stale.id, 10, 5);
    const reaped = await t.db.system((sx) =>
      callsRepo.reapStaleCalls(sx, { staleSeconds: 60, graceSeconds: 15 }),
    );
    expect(reaped).toBeGreaterThanOrEqual(1);
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
