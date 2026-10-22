/**
 * The safety screen in the turn pipeline, end to end with the mock model (whose screen is a narrow deterministic rule:
 * packages/ai gateway/mock-safety-screen.ts). A message the ideation prefilter flags and the crisis rules do not is
 * read by one metered `SafetyScreen` call once the turn is admitted: a crisis takes the crisis path exactly as a rule's
 * would (the fixed support message, no coaching call, a P1 safety escalation), wellbeing adds the wellbeing flag, and
 * an error or a slow model leaves the turn as the rules decided. A request a gate refuses (call admission, the message
 * limit, the spend caps) never buys a screen call, and every other message never calls it.
 */
import { randomUUID } from 'node:crypto';

import {
  CRISIS_SUPPORT_MESSAGE,
  MockModelGateway,
  ModelUnavailableError,
  SAFETY_SCREEN_SCHEMA_NAME,
  classifyRisk,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
} from '@foundry/ai';
import { CoachResponse, TestTurnResponse, TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { p, personasRepo, settingsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { type RunTurnInput, type RunTurnOutcome } from './run-turn.js';

let h: CoreHarness;
let maya: RequestContext;

/** Indirect ideation the crisis rules do not flag and the mock screen reads as a crisis. */
const INDIRECT = "I keep thinking about ending it. Nobody would even notice if I wasn't here.";
/** A bare "can't do this anymore": the mock screen's wellbeing case. */
const STRAIN = "I can't do this anymore.";
/** A prefilter hit ("end it") the mock screen reads as a wrap-up. */
const CLEAR_HIT = "Ok I'll end it here for today, thanks!";

beforeAll(async () => {
  h = await createCoreHarness({ random: () => 0.99, gatewayOptions: { streamDelayMs: 0 } });
  maya = await h.ctxFor(h.people.maya);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

async function fresh(): Promise<RequestContext> {
  return h.ctxFor(maya.principalId);
}

async function runTurn(
  core: Core,
  ctx: RequestContext,
  sessionId: string,
  input: RunTurnInput,
): Promise<{ events: TurnStreamEvent[]; outcome: RunTurnOutcome }> {
  const events: TurnStreamEvent[] = [];
  const outcome = await core.orchestrator.runTurn(ctx, sessionId, input, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  return { events, outcome };
}

function completedTurn(events: readonly TurnStreamEvent[]): TurnView {
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'nothing'}`);
  return last.turn;
}

/** The mock gateway's calls since `from`, as `kind:schema:purpose`. */
function callsSince(gateway: MockModelGateway, from: number): string[] {
  return gateway.calls.slice(from).map((c) => `${c.kind}:${c.schemaName ?? '-'}:${c.purpose}`);
}

function screenLogs(requestId: string): { level: string; event: string; fields: Record<string, unknown> }[] {
  return h.logger.records
    .filter((r) => r.event.startsWith('turn.safety_screen') && r.fields.requestId === requestId)
    .map((r) => ({ level: r.level, event: r.event, fields: { ...r.fields } }));
}

/** Runs `body` with platform settings changed, then restores them. */
async function withSettings(
  patch: Parameters<typeof settingsRepo.updatePlatformSettings>[1],
  body: () => Promise<void>,
): Promise<void> {
  const before = await h.t.db.system((sx) => settingsRepo.getPlatformSettings(sx));
  await h.t.db.system((sx) => settingsRepo.updatePlatformSettings(sx, patch, h.people.owner));
  try {
    await body();
  } finally {
    const restore = Object.fromEntries(
      Object.keys(patch).map((k) => [k, before[k as keyof typeof before]]),
    ) as typeof patch;
    await h.t.db.system((sx) => settingsRepo.updatePlatformSettings(sx, restore, h.people.owner));
  }
}

/** The safety screen calls among the mock gateway's calls since `from`. */
function screenCallsSince(gateway: MockModelGateway, from: number): number {
  return gateway.calls.slice(from).filter((c) => c.schemaName === SAFETY_SCREEN_SCHEMA_NAME).length;
}

async function ledgerPurposes(requestId: string): Promise<string[]> {
  const r = await h.t.db.system((sx) =>
    sx.query(`SELECT purpose FROM usage_ledger WHERE request_id = :rid ORDER BY id`, {
      rid: p.text(requestId),
    }),
  );
  return r.rows.map((row) => String(row.purpose));
}

/** What a turn stored about its risk (founders never see the categories: participantValidator). */
async function turnRow(
  turnId: string,
): Promise<{ riskLabel: string; riskCategories: string[]; channel: string; validatorCategories: unknown }> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT risk_label, risk_categories, channel, validator_results -> 'riskCategories' AS validator_categories
         FROM turns WHERE id = :id`,
      { id: p.uuid(turnId) },
    ),
  );
  const row = r.rows[0];
  const parse = (raw: unknown): unknown => (typeof raw === 'string' ? JSON.parse(raw) : raw);
  return {
    riskLabel: String(row?.risk_label),
    riskCategories: (row?.risk_categories as string[] | undefined) ?? [],
    channel: String(row?.channel),
    validatorCategories: parse(row?.validator_categories),
  };
}

/** The metadata of a turn's audit event `action` (null when there is none). */
async function auditMetadata(turnId: string, action: string): Promise<Record<string, unknown> | null> {
  const r = await h.t.db.system((sx) =>
    sx.query(
      `SELECT metadata FROM audit_events WHERE object_id = :id AND action = :action ORDER BY id LIMIT 1`,
      {
        id: p.text(turnId),
        action: p.text(action),
      },
    ),
  );
  const raw: unknown = r.rows[0]?.metadata;
  if (raw === undefined || raw === null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

describe('the safety screen in a turn', () => {
  it('a prefilter hit the screen reads as a crisis takes the crisis path, like a crisis rule', async () => {
    expect(classifyRisk(INDIRECT).crisis).toBe(false);
    const ctx = await fresh();
    const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, {});
    const from = h.gateway.calls.length;
    const { events, outcome } = await runTurn(h.core, ctx, session.id, { text: INDIRECT });

    expect(outcome.status).toBe('blocked');
    // One screen call, metered as classification; no coaching call, no stream, no retrieval embedding.
    expect(callsSince(h.gateway, from)).toEqual([`generate:${SAFETY_SCREEN_SCHEMA_NAME}:classification`]);
    expect(await ledgerPurposes(ctx.requestId)).toEqual(['classification']);
    const last = events.at(-1);
    if (last?.event !== 'turn.blocked') throw new Error('expected turn.blocked');
    expect(last).toMatchObject({ reason: 'crisis_support', supportMessage: CRISIS_SUPPORT_MESSAGE });
    expect(last.escalationId).not.toBeNull();

    const escalations = await h.core.escalations.list(ctx, h.ventures.quietquad.id);
    expect(escalations.find((e) => e.id === last.escalationId)).toMatchObject({
      status: 'draft',
      category: 'safety_wellbeing',
      priority: 'P1',
      requestedRole: 'university_support',
    });
    const detail = await h.core.sessions.get(ctx, session.id);
    expect(detail.turns[0]).toMatchObject({ status: 'blocked' });
    expect(detail.turns[0]?.validator?.notes).toEqual(['crisis_support', 'no_model_call', 'safety_screen']);
    expect(await turnRow(last.turnId)).toEqual({
      riskLabel: 'crisis',
      riskCategories: ['safety_wellbeing'],
      channel: 'text',
      validatorCategories: ['safety_wellbeing'],
    });
    expect(await auditMetadata(last.turnId, 'turn.crisis_support')).toMatchObject({
      modelCalled: false,
      safetyScreen: true,
    });
    // Admitted as an ordinary message (every gate applied), then screened: the turn keeps the final label.
    expect(await auditMetadata(last.turnId, 'turn.accepted')).toMatchObject({
      riskLabel: 'none',
      riskRules: [],
    });
    const logs = screenLogs(ctx.requestId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'info',
      event: 'turn.safety_screen',
      fields: { outcome: 'crisis', purpose: 'classification', families: 'ending,presence,burden' },
    });
    expect(h.logger.dump()).not.toContain('ending it');
  });

  it('a screen error leaves the turn as the rules decided (no flag) and is logged', async () => {
    for (const failure of ['unavailable', 'timeout', 'invalid_output'] as const) {
      const ctx = await fresh();
      const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, { mode: 'coach' });
      h.gateway.scriptNext(failure);
      const { events, outcome } = await runTurn(h.core, ctx, session.id, { text: INDIRECT });
      expect(outcome.status, failure).toBe('completed');
      const turn = completedTurn(events);
      expect(await turnRow(turn.id), failure).toMatchObject({ riskLabel: 'none', riskCategories: [] });
      const logs = screenLogs(ctx.requestId);
      expect(logs, failure).toHaveLength(1);
      expect(logs[0], failure).toMatchObject({
        level: 'warn',
        event: 'turn.safety_screen_failed',
        fields: { timedOut: false, cancelled: false },
      });
      // The failed call was still metered (a failed model call can be billed).
      expect(await ledgerPurposes(ctx.requestId), failure).toContain('classification');
    }
  });

  it('a screen slower than its budget is abandoned: the turn goes on as the rules decided', async () => {
    /** A model that never answers the screen (it gives up only when the call is aborted). */
    class SlowScreen extends MockModelGateway {
      override generateStructured<T>(
        request: GenerateStructuredRequest<T>,
      ): Promise<GenerateStructuredResult<T>> {
        if (request.schemaName !== SAFETY_SCREEN_SCHEMA_NAME) return super.generateStructured(request);
        this.calls.push({
          kind: 'generate',
          purpose: request.purpose,
          requestId: request.requestId,
          schemaName: request.schemaName,
          count: 1,
        });
        const { signal } = request;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new ModelUnavailableError('aborted', 'mock'));
          });
        });
      }
    }
    const gateway = new SlowScreen({ streamDelayMs: 0 });
    const core = createCore({
      db: h.t.db,
      gateway,
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger: h.logger,
      random: () => 0.99,
    });
    const ctx = await fresh();
    const session = await core.sessions.create(ctx, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await runTurn(core, ctx, session.id, { text: INDIRECT });
    expect(outcome.status).toBe('completed');
    expect(await turnRow(completedTurn(events).id)).toMatchObject({ riskLabel: 'none', riskCategories: [] });
    const logs = screenLogs(ctx.requestId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      event: 'turn.safety_screen_failed',
      fields: { code: 'model_unavailable', timedOut: true, cancelled: false },
    });
  }, 30_000);

  it('wellbeing adds the wellbeing flag: the turn is answered, with a P1 safety escalation', async () => {
    expect(classifyRisk(STRAIN).categories).toEqual([]);
    const ctx = await fresh();
    const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, { mode: 'coach' });
    const from = h.gateway.calls.length;
    const { events, outcome } = await runTurn(h.core, ctx, session.id, { text: STRAIN });
    expect(outcome.status).toBe('completed');
    expect(callsSince(h.gateway, from)[0]).toBe(`generate:${SAFETY_SCREEN_SCHEMA_NAME}:classification`);
    const turn = completedTurn(events);
    // The policy flags the topic for the model, and the validator holds the escalation to it.
    expect(CoachResponse.parse(turn.response).escalation).toMatchObject({
      required: true,
      category: 'safety_wellbeing',
      priority: 'P1',
    });
    expect(await turnRow(turn.id)).toEqual({
      riskLabel: 'high',
      riskCategories: ['safety_wellbeing'],
      channel: 'text',
      validatorCategories: ['safety_wellbeing'],
    });
    const escalations = await h.core.escalations.list(ctx, h.ventures.quietquad.id);
    expect(escalations.find((e) => e.turnId === turn.id)).toMatchObject({ category: 'safety_wellbeing' });
  });

  it('a clear screen changes nothing', async () => {
    const ctx = await fresh();
    const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, { mode: 'coach' });
    // "end it" reaches the screen; the mock reads "for today, thanks" as a wrap-up.
    const { events, outcome } = await runTurn(h.core, ctx, session.id, { text: CLEAR_HIT });
    expect(outcome.status).toBe('completed');
    const turn = completedTurn(events);
    expect(await turnRow(turn.id)).toMatchObject({ riskLabel: 'none', riskCategories: [] });
    const logs = screenLogs(ctx.requestId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'turn.safety_screen', fields: { outcome: 'clear' } });
  });

  it('a sign-off is answered as one in mock mode: "goodbye" and "ok let\'s end it there" get no crisis message', async () => {
    for (const text of ['goodbye', "ok let's end it there", 'ok goodbye', "i think i'm done"]) {
      const ctx = await fresh();
      const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, { mode: 'coach' });
      await runTurn(h.core, await fresh(), session.id, {
        text: 'How should we price the two-library pilot?',
      });
      const { events, outcome } = await runTurn(h.core, ctx, session.id, { text });
      expect(outcome.status, text).toBe('completed');
      const turn = completedTurn(events);
      expect(await turnRow(turn.id), text).toMatchObject({ riskLabel: 'none', riskCategories: [] });
      expect(CoachResponse.parse(turn.response).escalation.required, text).toBe(false);
      const escalations = await h.core.escalations.list(ctx, h.ventures.quietquad.id);
      expect(
        escalations.filter((e) => e.turnId === turn.id),
        text,
      ).toEqual([]);
    }
  });

  it('never calls the screen for a message the prefilter does not flag, or one the rules already flag', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const from = h.gateway.calls.length;
    for (const text of [
      'How should we price the two-library pilot?',
      'Last time you said the dean has the budget. Where do we start?',
      'ok thanks, goodbye!',
    ]) {
      const { outcome } = await runTurn(h.core, await fresh(), session.id, { text });
      expect(outcome.status, text).toBe('completed');
    }
    const crisis = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    const { outcome } = await runTurn(h.core, await fresh(), crisis.id, {
      text: 'I want to kill myself tonight.',
    });
    expect(outcome.status).toBe('blocked');
    expect(h.gateway.calls.slice(from).filter((c) => c.schemaName === SAFETY_SCREEN_SCHEMA_NAME)).toEqual([]);
  });

  it('a spoken message outside a live call is refused before it buys a screen call, as on main', async () => {
    // The audit's case: a voice turn with no call (a client loop, a crafted request) bought a billed screen call
    // before call admission refused it. With no call id, and with a stale one.
    const loose = h.withConfig({ turns: { rateLimit: 500 } });
    for (const text of [CLEAR_HIT, 'um yeah so i keep thinking about ending it like for real']) {
      for (const callId of [undefined, randomUUID()]) {
        const ctx = await fresh();
        const session = await loose.sessions.create(ctx, h.ventures.quietquad.id, {});
        const from = h.gateway.calls.length;
        const { outcome } = await runTurn(loose, ctx, session.id, {
          text,
          channel: 'voice',
          ...(callId === undefined ? {} : { callId }),
        });
        expect(outcome.status, text).toBe('rejected');
        if (callId === undefined) expect(outcome.error?.reason, text).toBe('call_required');
        expect(callsSince(h.gateway, from), text).toEqual([]);
        expect(await ledgerPurposes(ctx.requestId), text).toEqual([]);
      }
    }
  });

  it('on a live call, a spoken message the screen flags takes the crisis path and says the support message', async () => {
    await h.core.calls.acknowledgeNotice(maya);
    const ctx = await fresh();
    const session = await h.core.sessions.create(ctx, h.ventures.quietquad.id, {});
    const { call } = await h.core.calls.start(ctx, session.id, { inputMode: 'typed' });
    try {
      const from = h.gateway.calls.length;
      const { events, outcome } = await runTurn(h.core, await fresh(), session.id, {
        text: 'um yeah so i keep thinking about ending it like for real',
        channel: 'voice',
        callId: call.id,
      });
      expect(outcome.status).toBe('blocked');
      expect(callsSince(h.gateway, from)).toEqual([`generate:${SAFETY_SCREEN_SCHEMA_NAME}:classification`]);
      expect(events.filter((e) => e.event === 'turn.speech').length).toBeGreaterThan(0);
      expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'crisis_support' });
      if (outcome.turnId === null) throw new Error('expected a turn');
      expect(await turnRow(outcome.turnId)).toMatchObject({ riskLabel: 'crisis', channel: 'voice' });
    } finally {
      await h.core.calls.end(ctx, call.id, { reason: 'user' });
    }
  });

  it('a founder past the spend cap is refused before the screen, as on main', async () => {
    const loose = h.withConfig({ turns: { rateLimit: 500 } });
    const session = await loose.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    await withSettings({ dailyUsdCapPerPrincipal: 0 }, async () => {
      for (const text of [CLEAR_HIT, INDIRECT]) {
        const ctx = await fresh();
        const from = h.gateway.calls.length;
        const { outcome } = await runTurn(loose, ctx, session.id, { text });
        expect(outcome.error?.code, text).toBe('spend_cap_reached');
        expect(screenCallsSince(h.gateway, from), text).toBe(0);
        expect(await ledgerPurposes(ctx.requestId), text).toEqual([]);
      }
    });
  });

  it('a burst over the message limit buys a screen call only for the messages admitted', async () => {
    const tight = h.withConfig({ turns: { rateLimit: 3 } });
    const ctxP = (): Promise<RequestContext> => h.ctxFor(h.people.devin);
    const session = await tight.sessions.create(await ctxP(), h.ventures.quietquad.id, { mode: 'coach' });
    const from = h.gateway.calls.length;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, async () => runTurn(tight, await ctxP(), session.id, { text: CLEAR_HIT })),
    );
    const admitted = outcomes.filter((r) => r.outcome.status !== 'rejected').length;
    expect(admitted).toBeLessThanOrEqual(3);
    expect(outcomes.filter((r) => r.outcome.status === 'rejected').length).toBeGreaterThanOrEqual(5);
    expect(screenCallsSince(h.gateway, from)).toBe(admitted);
  });
});

describe('the safety screen on the EIR studio test bench', () => {
  it('answers what the screen reads as a crisis with crisis support, metered as test_bench', async () => {
    const corin = await h.ctxFor(h.people.eirCorin);
    const personaId = h.ventures.quietquad.personaId;
    const active = await h.t.db.system((sx) => personasRepo.getActiveRelease(sx, personaId));
    if (active === null) throw new Error('Corin’s vEIR has no active release');
    const from = h.gateway.calls.length;
    const response = TestTurnResponse.parse(
      await h.core.testBench.runTestTurn(corin, personaId, { releaseId: active.id, text: INDIRECT }),
    );
    expect(response).toMatchObject({
      status: 'blocked',
      response: null,
      blocked: { reason: 'crisis_support', supportMessage: CRISIS_SUPPORT_MESSAGE },
      validator: { riskCategories: ['safety_wellbeing'], escalationForced: true },
    });
    // The same note as the founder's turn: a curator can tell a screened crisis from a rule's.
    expect(response.validator.notes).toEqual(['crisis_support', 'no_model_call', 'safety_screen']);
    expect(callsSince(h.gateway, from)).toEqual([`generate:${SAFETY_SCREEN_SCHEMA_NAME}:test_bench`]);
    expect(await ledgerPurposes(corin.requestId)).toEqual(['test_bench']);
  });
});
