/**
 * The streamed turn engine end to end with the mock model: validated `turn.delta` units then the authoritative
 * `turn.completed`, gate stops mid-stream (canary, EIR sign-off), failures before and after the first sentence,
 * replies written whole when the stream is empty or not prose, the streaming and AI kill switches, auto mode,
 * continuity (name, notebook, digests, opener), release pinning, persona lessons, and spoken turns with signed
 * `turn.speech` units, including the message limit a spoken crisis message pays.
 */
import {
  CRISIS_SPOKEN_MESSAGE,
  CROSS_VENTURE_BLOCK_ANSWER,
  MockModelGateway,
  mockCoachResponse,
  type EmbedOptions,
  type EmbedResult,
  type MockGenerateContext,
} from '@foundry/ai';
import { TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { auditRepo, p, personasRepo, resourcesRepo, turnsRepo } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type CoreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { DirectoryCache } from '../internal/directory.js';
import { Kit } from '../internal/kit.js';
import { type VoiceTurnAdmission } from '../services/call-admission.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { RATE_LIMITED_CRISIS_MESSAGE } from './blocked.js';
import { createOrchestrator, type Orchestrator, type RunTurnInput, type RunTurnOutcome } from './run-turn.js';
import { verifySpeechUnit } from './speech-units.js';
import { OPENER_FRAME } from './turn-prompts.js';

let h: CoreHarness;
let maya: RequestContext;
let owner: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness({
    random: () => 0.99,
    gatewayOptions: { streamDelayMs: 0 },
    config: { turns: { rateLimit: 500 } },
  });
  maya = await h.ctxFor(h.people.maya);
  owner = await h.ctxFor(h.people.owner);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

interface Run {
  events: TurnStreamEvent[];
  outcome: RunTurnOutcome;
}

async function run(
  orchestrator: Orchestrator,
  sessionId: string,
  input: RunTurnInput,
  ctx = maya,
): Promise<Run> {
  const events: TurnStreamEvent[] = [];
  const outcome = await orchestrator.runTurn(ctx, sessionId, input, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  return { events, outcome };
}

const shape = (events: readonly TurnStreamEvent[]): string[] =>
  events.map((e) => (e.event === 'turn.status' ? `status:${e.phase}` : e.event));

function deltas(events: readonly TurnStreamEvent[]): Extract<TurnStreamEvent, { event: 'turn.delta' }>[] {
  return events.flatMap((e) => (e.event === 'turn.delta' ? [e] : []));
}

function speechUnits(
  events: readonly TurnStreamEvent[],
): Extract<TurnStreamEvent, { event: 'turn.speech' }>[] {
  return events.flatMap((e) => (e.event === 'turn.speech' ? [e] : []));
}

function completed(events: readonly TurnStreamEvent[]): TurnView {
  const last = events.at(-1);
  if (last?.event !== 'turn.completed')
    throw new Error(`expected turn.completed, got ${last?.event ?? 'nothing'}`);
  return last.turn;
}

async function auditMetadata(objectId: string, action: string): Promise<Record<string, unknown>> {
  const r = await h.t.db.system((sx) =>
    sx.query('SELECT metadata FROM audit_events WHERE object_id = :id AND action = :action', {
      id: p.text(objectId),
      action: p.text(action),
    }),
  );
  const metadata: unknown = r.rows[0]?.metadata;
  if (metadata === undefined) throw new Error(`no ${action} audit for ${objectId}`);
  return (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) as Record<string, unknown>;
}

/** The mock model, recording the texts it was asked to embed (the retrieval queries). */
class EmbedRecorder extends MockModelGateway {
  readonly embedded: string[] = [];

  override embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    this.embedded.push(...texts);
    return super.embed(texts, options);
  }
}

const CALL_ID = '77777777-7777-4777-8777-777777777777';
const CRISIS_TEXT = 'I want to end my life, I cannot do this anymore.';

async function usagePurposes(requestId: string): Promise<string[]> {
  const r = await h.t.db.system((sx) =>
    sx.query(`SELECT purpose FROM usage_ledger WHERE request_id = :rid ORDER BY id`, {
      rid: p.text(requestId),
    }),
  );
  return r.rows.map((row) => String(row.purpose));
}

async function countFor(table: 'turns' | 'escalations', sessionId: string): Promise<number> {
  const r = await h.t.db.system((sx) =>
    sx.query(`SELECT count(*)::int AS n FROM ${table} WHERE session_id = :id`, { id: p.uuid(sessionId) }),
  );
  return Number(r.rows[0]?.n);
}

/** A core (and an orchestrator with stubbed call admission) over the harness database with its own model. */
function coreWith(
  gateway: MockModelGateway,
  admitted: VoiceTurnAdmission[] = [],
  turns: Partial<CoreConfig['turns']> = {},
): { core: Core; orchestrator: Orchestrator; kit: Kit } {
  const deps = {
    db: h.t.db,
    gateway,
    config: { ...h.config, turns: { ...h.config.turns, ...turns } },
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
    random: () => 0.99,
  };
  const kit = new Kit(resolveDeps(deps));
  const orchestrator = createOrchestrator(kit, new DirectoryCache(kit), {
    admitVoiceTurn: (_scope, admission) => {
      admitted.push(admission);
      return Promise.resolve();
    },
  });
  return { core: createCore(deps), orchestrator, kit };
}

/** The default answer (the spoken form on a call), recording what the model saw. */
function recording(seen: MockGenerateContext[]): (context: MockGenerateContext) => string {
  return (context) => {
    seen.push(context);
    const response = mockCoachResponse(context);
    return context.control?.channel === 'voice' ? (response.spoken ?? '') : response.answer;
  };
}

describe('streamed turns', () => {
  it('streams validated deltas, then the authoritative completed turn', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'diagnose' });
    const calls = h.gateway.calls.length;
    const text = 'What did the library staff interviews tell us about quiet seat demand during exam weeks?';
    const { events, outcome } = await run(h.core.orchestrator, session.id, { text, mode: 'diagnose' });
    expect(outcome.status).toBe('completed');

    const kinds = shape(events);
    const firstDelta = kinds.indexOf('turn.delta');
    expect(kinds.slice(0, firstDelta)).toEqual([
      'turn.accepted',
      'status:classifying',
      'status:retrieving',
      'status:retrieving',
      'status:reasoning',
    ]);
    expect(kinds.slice(kinds.lastIndexOf('turn.delta') + 1)).toEqual(['status:validating', 'turn.completed']);
    const units = deltas(events);
    expect(units.length).toBeGreaterThan(2);
    expect(units.map((d) => d.seq)).toEqual(units.map((_, i) => i));
    const turn = completed(events);
    expect(units.every((d) => d.turnId === turn.id)).toBe(true);
    // The streamed units read exactly as the validated answer; turn.completed still carries it in full.
    expect(units.map((d) => d.text).join('')).toBe(turn.response?.answer);
    expect(turn.response?.claims.length).toBeGreaterThan(0);
    expect(turn.usage?.firstTokenMs).toEqual(expect.any(Number));

    // One streamed answer, one annotation call; both metered.
    const made = h.gateway.calls.slice(calls);
    expect(made.map((c) => `${c.kind}:${c.schemaName ?? ''}`)).toEqual([
      'embed:',
      'stream:',
      'generate:CoachAnnotations',
    ]);
    const record = await h.t.db.system((sx) => turnsRepo.getTurn(sx, turn.id));
    expect(record?.firstTokenMs).toEqual(turn.usage?.firstTokenMs);
    const usage = await h.t.db.system((sx) =>
      sx.query(`SELECT purpose FROM usage_ledger WHERE request_id = :rid ORDER BY id`, {
        rid: p.text(maya.requestId),
      }),
    );
    expect(usage.rows.map((r) => r.purpose)).toEqual(expect.arrayContaining(['embedding', 'turn', 'turn']));
    const meta = await auditMetadata(turn.id, 'turn.completed');
    expect(meta).toMatchObject({
      stream: 'streamed',
      deltas: units.length,
      autoMode: false,
      channel: 'text',
    });
    expect(meta.firstTokenMs).toEqual(expect.any(Number));
    // Logs carry ids and counts only.
    expect(h.logger.dump()).not.toContain('library staff interviews');
    expect(h.logger.dump()).not.toContain(units[0]?.text ?? '');
  });

  it('auto mode: without a mode the model picks one of the allowed modes, recorded on the turn', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    const { events } = await run(h.core.orchestrator, session.id, {
      text: 'Can you explain what a kill criterion is for our exam-week rerun?',
    });
    const turn = completed(events);
    expect(turn.mode).toBe('teach');
    expect(turn.response?.mode).toBe('teach');
    expect(await auditMetadata(turn.id, 'turn.completed')).toMatchObject({ autoMode: true, mode: 'teach' });
    expect((await h.core.sessions.get(maya, session.id)).session.mode).toBe('teach');
  });

  it('a rehearsal counterpart without a mode asks for a rehearsal', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    const { events } = await run(h.core.orchestrator, session.id, {
      text: 'We would like to run a two-week seat-count pilot in your library this term.',
      rehearsalCounterpart: 'Head librarian',
    });
    const turn = completed(events);
    expect(turn.mode).toBe('rehearse');
    expect(turn.response?.rehearsal?.counterpart).toBe('Head librarian');
    expect(await auditMetadata(turn.id, 'turn.completed')).toMatchObject({ autoMode: false });
  });

  it('every turn moves the conversation’s last activity, and the first message titles it', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    const first = await run(h.core.orchestrator, session.id, { text: 'How do we size the exam-week pilot?' });
    const after = await h.core.sessions.get(maya, session.id);
    expect(after.session.title).toBe('How do we size the exam-week pilot?');
    expect(Date.parse(after.session.lastActivityAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(session.startedAt),
    );
    await run(h.core.orchestrator, session.id, { text: 'And who should we ask first?' });
    const later = await h.core.sessions.get(maya, session.id);
    expect(Date.parse(later.session.lastActivityAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(after.session.lastActivityAt ?? ''),
    );
    expect(later.session.title).toBe(after.session.title);
    expect(first.outcome.status).toBe('completed');
  });

  it('with streaming switched off, the whole reply arrives in one validated event as before', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    await h.core.admin.updateSettings(owner, { streamingEnabled: false });
    try {
      const calls = h.gateway.calls.length;
      const { events } = await run(h.core.orchestrator, session.id, {
        text: 'Should we run the pilot in one library or two?',
        mode: 'coach',
      });
      expect(shape(events)).toEqual([
        'turn.accepted',
        'status:classifying',
        'status:retrieving',
        'status:retrieving',
        'status:reasoning',
        'status:validating',
        'turn.completed',
      ]);
      expect(completed(events).usage?.firstTokenMs).toBeNull();
      expect(h.gateway.calls.slice(calls).map((c) => `${c.kind}:${c.schemaName ?? ''}`)).toEqual([
        'embed:',
        'generate:CoachResponse',
      ]);
    } finally {
      await h.core.admin.updateSettings(owner, { streamingEnabled: true });
    }
  });

  it('the AI kill switch stops a turn before any model call', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    await h.core.admin.updateSettings(owner, { aiEnabled: false });
    try {
      const calls = h.gateway.calls.length;
      const { events, outcome } = await run(h.core.orchestrator, session.id, { text: 'Are we ready?' });
      expect(outcome).toMatchObject({ status: 'rejected', turnId: null });
      expect(shape(events)).toEqual(['turn.error']);
      expect(h.gateway.calls.length).toBe(calls);
    } finally {
      await h.core.admin.updateSettings(owner, { aiEnabled: true });
    }
  });
});

describe('the sentence gate mid-stream', () => {
  it('stops at another venture’s canary: earlier sentences were shown, nothing of the leak, and the turn is blocked', async () => {
    const canary = h.ventures.emberloop.canary;
    const gateway = new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: () =>
        [
          'Your door counts are the clearest signal you have so far, and they point at exam weeks.',
          'The next test should be cheap and fast, so keep it to the two libraries you already know well.',
          'Write down the number that would make you stop before you start counting again next week.',
          `Another team logged ${canary} in its notes last term.`,
          'That is all for now.',
        ].join(' '),
    });
    const { core } = coreWith(gateway);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await run(core.orchestrator, session.id, {
      text: 'Summarise our evidence.',
      mode: 'coach',
    });
    expect(outcome.status).toBe('blocked');
    expect(deltas(events).length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(canary);
    expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'policy' });
    // No annotations were asked for a stopped answer.
    expect(gateway.calls.map((c) => c.kind)).toEqual(['embed', 'stream']);
    const record = await h.t.db.system((sx) => turnsRepo.getTurn(sx, outcome.turnId ?? ''));
    expect(record?.response?.answer).toBe(CROSS_VENTURE_BLOCK_ANSWER);
    expect(record?.validatorResults?.notes).toContain('stream_gate_blocked');
    expect(record && turnsRepo.blockedReason(record)).toBe('cross_venture');
  });

  it('stops before a sign-off as the EIR and blocks the turn for identity', async () => {
    const gateway = new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: () => 'Good luck with the interviews this week, Maya.\n\nBest,\nCorin',
    });
    const { core } = coreWith(gateway);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await run(core.orchestrator, session.id, { text: 'Thanks!', mode: 'coach' });
    expect(outcome.status).toBe('blocked');
    expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'identity' });
    expect(
      deltas(events)
        .map((d) => d.text)
        .join(''),
    ).not.toMatch(/Corin/);
  });
});

describe('failures', () => {
  it('a stream that fails before any sentence fails the turn', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    h.gateway.scriptNext('unavailable');
    const { events, outcome } = await run(h.core.orchestrator, session.id, { text: 'What next?' });
    expect(outcome.status).toBe('failed');
    expect(deltas(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: 'turn.error', code: 'model_unavailable', retryable: true });
  });

  it('a stream that breaks after sentences were shown is regenerated whole; turn.completed replaces them', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    h.gateway.scriptStream('fail_midway');
    const calls = h.gateway.calls.length;
    const { events, outcome } = await run(h.core.orchestrator, session.id, {
      text: 'Which library should we start with?',
      mode: 'coach',
    });
    expect(outcome.status).toBe('completed');
    expect(deltas(events).length).toBeGreaterThan(0);
    const turn = completed(events);
    expect(turn.response?.answer.length).toBeGreaterThan(0);
    expect(turn.validator?.notes).toContain('stream_interrupted');
    expect(h.gateway.calls.slice(calls).map((c) => `${c.kind}:${c.schemaName ?? ''}`)).toEqual([
      'embed:',
      'stream:',
      'generate:CoachResponse',
    ]);
  });

  it('an empty streamed reply is written whole instead of completing with a placeholder', async () => {
    const gateway = new MockModelGateway({ streamDelayMs: 0, streamFixture: () => '   \n\n  ' });
    const { core } = coreWith(gateway);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await run(core.orchestrator, session.id, {
      text: 'Which library should we start with?',
      mode: 'coach',
    });
    expect(outcome.status).toBe('completed');
    expect(deltas(events)).toEqual([]);
    const turn = completed(events);
    expect(turn.validator?.notes).toContain('stream_empty');
    expect(turn.validator?.notes).not.toContain('empty_answer_replaced');
    expect(turn.response?.answer.trim()).not.toBe('');
    expect(gateway.calls.map((c) => `${c.kind}:${c.schemaName ?? ''}`)).toEqual([
      'embed:',
      'stream:',
      'generate:CoachResponse',
    ]);
  });

  it('a streamed reply that opens like JSON is stopped unseen and written whole', async () => {
    const gateway = new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: () =>
        '{"mode": "coach", "answer": "Start with the door counts. Then call the library. Then decide."}',
    });
    const { core } = coreWith(gateway);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await run(core.orchestrator, session.id, {
      text: 'What should we do first?',
      mode: 'coach',
    });
    expect(outcome.status).toBe('completed');
    expect(deltas(events)).toEqual([]);
    const turn = completed(events);
    expect(turn.validator?.notes).toContain('stream_structured_output');
    expect(turn.response?.answer).not.toContain('{');
    expect(gateway.calls.map((c) => `${c.kind}:${c.schemaName ?? ''}`)).toEqual([
      'embed:',
      'stream:',
      'generate:CoachResponse',
    ]);
    expect(await auditMetadata(turn.id, 'turn.completed')).toMatchObject({
      stream: 'structured_output',
      firstTokenMs: null,
    });
  });

  it('annotations that fail leave the streamed reply standing', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    h.gateway.scriptNext('fallback', 'unavailable'); // the stream succeeds (on the fallback), annotations fail
    const { events, outcome } = await run(h.core.orchestrator, session.id, {
      text: 'Is a two-week test long enough?',
      mode: 'coach',
    });
    expect(outcome.status).toBe('completed');
    const turn = completed(events);
    expect(turn.response?.answer).toBe(
      deltas(events)
        .map((d) => d.text)
        .join(''),
    );
    expect(turn.response?.claims).toEqual([]);
    expect(turn.validator?.notes).toContain('annotations_unavailable');
    expect(turn.usage?.fallbackUsed).toBe(true);
  });
});

describe('continuity', () => {
  it('opens with the notebook opener and gives the model the name, notes, digests and the opener', async () => {
    const seen: MockGenerateContext[] = [];
    const gateway = new EmbedRecorder({ streamDelayMs: 0, streamFixture: recording(seen) });
    const { core } = coreWith(gateway);
    const notebook = await core.notebook.get(maya, h.ventures.quietquad.id);
    expect(notebook.nextOpener).toMatch(/library-staff interviews/);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, {});
    expect(session.opener).toBe(notebook.nextOpener);

    await run(core.orchestrator, session.id, { text: 'We did three of them.' });
    const context = seen.at(-1);
    if (!context) throw new Error('the model was not called');
    expect(context.control).toMatchObject({ founder: 'Maya', persona: "Corin's vEIR" });
    expect(context.system).toContain('Corin Halvorsen');
    expect(context.messages[0]).toEqual({ role: 'user', content: OPENER_FRAME });
    expect(context.messages[1]).toEqual({ role: 'assistant', content: notebook.nextOpener });
    const last = context.messages.at(-1)?.content ?? '';
    expect(last).toContain('<your_notes>');
    expect(last).toContain('exam-week seat scarcity');
    expect(last).toContain('<open_commitments>');
    expect(last).toContain('<previous_conversations>');
    // The mock does not greet again: the opener already did.
    expect(context.historyTurns).toBe(1);
    // The short reply is retrieved together with the opener's question it answers.
    expect(gateway.embedded.at(-1)).toContain('How many have you done');
  });

  it('temporary chats have no opener and use no notes', async () => {
    const seen: MockGenerateContext[] = [];
    const { core } = coreWith(new MockModelGateway({ streamDelayMs: 0, streamFixture: recording(seen) }));
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { privacy: 'ephemeral' });
    expect(session.opener).toBeNull();
    await run(core.orchestrator, session.id, { text: 'Private idea about pricing tiers.' });
    const last = seen.at(-1)?.messages.at(-1)?.content ?? '';
    expect(last).not.toContain('<your_notes>');
    expect(seen.at(-1)?.control?.founder).toBe('Maya');
  });

  it('the vEIR’s published lessons are retrieved, another vEIR’s are not', async () => {
    const corin = h.ventures.quietquad.personaId;
    const ruth = h.ventures.benchtally.personaId;
    const lesson = (personaId: string, title: string) =>
      h.t.db.system((sx) =>
        resourcesRepo.createPattern(sx, {
          tenantId: h.seed.tenantId,
          personaId,
          title,
          context: 'Founders piloting quokka turnstile counters in campus libraries.',
          signal: 'Quokka counters undercount groups arriving together.',
          intervention: 'Pair the quokka counter with a two-day manual tally.',
          outcome: 'Counts matched within ten percent.',
          limits: 'Seen in two libraries only.',
          sourceClass: 'synthetic',
          status: 'published',
        }),
      );
    await lesson(corin, 'Calibrate quokka counters against a manual tally');
    await lesson(ruth, 'Ruth on quokka counter calibration');
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events } = await run(h.core.orchestrator, session.id, {
      text: 'Our quokka counters undercount groups. How should we calibrate the quokka counter?',
      mode: 'coach',
    });
    const titles = completed(events)
      .evidence.filter((e) => e.kind === 'pattern')
      .map((e) => e.title);
    expect(titles).toContain('Calibrate quokka counters against a manual tally');
    expect(titles).not.toContain('Ruth on quokka counter calibration');
  });
});

describe('spoken turns', () => {
  it('refuses spoken turns the calls service does not admit, without any model call', async () => {
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    // No call named, and a call that is not the caller's live call in this conversation.
    for (const [callId, code, reason] of [
      [undefined, 'conflict', 'call_required'],
      [CALL_ID, 'not_found', undefined],
    ] as const) {
      const ctx = await h.ctxFor(h.people.maya);
      const calls = h.gateway.calls.length;
      const { outcome } = await run(
        h.core.orchestrator,
        session.id,
        { text: 'We did three interviews.', channel: 'voice', ...(callId === undefined ? {} : { callId }) },
        ctx,
      );
      expect(outcome).toMatchObject({ status: 'rejected', turnId: null, error: { code } });
      if (reason !== undefined) expect(outcome.error?.reason).toBe(reason);
      // The query embedding starts only once a turn is admitted.
      expect(h.gateway.calls.slice(calls)).toEqual([]);
      expect(await usagePurposes(ctx.requestId)).toEqual([]);
    }
    expect(await countFor('turns', session.id)).toBe(0);
  });

  it('streams captions and signed speech units of the short spoken reply', async () => {
    const admitted: VoiceTurnAdmission[] = [];
    const { core, orchestrator, kit } = coreWith(new MockModelGateway({ streamDelayMs: 0 }), admitted);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const callId = '77777777-7777-4777-8777-777777777777';
    const { events, outcome } = await run(orchestrator, session.id, {
      text: 'We did three of the library interviews. What should we ask next?',
      mode: 'coach',
      channel: 'voice',
      callId,
    });
    expect(outcome.status).toBe('completed');
    expect(admitted).toEqual([{ sessionId: session.id, callId, now: expect.any(Date) as Date }]);
    const units = speechUnits(events);
    expect(units.length).toBeGreaterThan(0);
    expect(units.map((u) => u.seq)).toEqual(units.map((_, i) => i));
    expect(units.map((u) => u.final)).toEqual(units.map((_, i) => i === units.length - 1));
    const keys = await new PlatformKeyCache(kit, 3_600).verificationKeys();
    const turn = completed(events);
    for (const u of units) {
      expect(u.text).not.toMatch(/\[E\d|\*\*|https?:/);
      expect(
        verifySpeechUnit(keys, { sessionId: session.id, turnId: turn.id, seq: u.seq, text: u.text }, u.sig),
      ).toBe(true);
    }
    expect(
      units
        .map((u) => u.text)
        .join(' ')
        .split(/\s+/).length,
    ).toBeLessThanOrEqual(70);
    expect(deltas(events).length).toBeGreaterThan(0);
    expect(turn.channel).toBe('voice');
    expect(turn.response?.spoken).toEqual(expect.any(String));
    expect((await core.sessions.get(maya, session.id)).session.hasCalls).toBe(true);
  });

  it('a crisis on a call speaks the fixed support message, without call admission or a model call', async () => {
    const admitted: VoiceTurnAdmission[] = [];
    const gateway = new MockModelGateway({ streamDelayMs: 0 });
    const { core, orchestrator } = coreWith(gateway, admitted);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, {});
    const { call } = await core.calls.start(maya, session.id, { inputMode: 'typed' });
    try {
      const { events, outcome } = await run(orchestrator, session.id, {
        text: CRISIS_TEXT,
        channel: 'voice',
        callId: call.id,
      });
      expect(outcome.status).toBe('blocked');
      expect(admitted).toEqual([]);
      expect(gateway.calls.filter((c) => c.kind !== 'embed')).toEqual([]);
      expect(speechUnits(events).map((u) => [u.seq, u.text, u.final])).toEqual([
        [0, CRISIS_SPOKEN_MESSAGE, true],
      ]);
      expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'crisis_support' });
      const stored = await h.t.db.system((sx) =>
        sx.query('SELECT channel, call_id FROM turns WHERE session_id = :id', { id: p.uuid(session.id) }),
      );
      expect(stored.rows).toEqual([{ channel: 'voice', call_id: call.id }]);
    } finally {
      await core.calls.end(maya, call.id, { reason: 'user' });
    }
  });

  it('a spoken crisis message naming no live call of the caller is answered as a typed one', async () => {
    const admitted: VoiceTurnAdmission[] = [];
    const { core, orchestrator } = coreWith(new MockModelGateway({ streamDelayMs: 0 }), admitted);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, {});
    const { events, outcome } = await run(orchestrator, session.id, {
      text: CRISIS_TEXT,
      channel: 'voice',
      callId: CALL_ID,
    });
    // Support is still given, but nothing pretends a call took place: no speech unit, no voice turn, no call
    // marked on the conversation.
    expect(outcome.status).toBe('blocked');
    expect(admitted).toEqual([]);
    expect(speechUnits(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'crisis_support' });
    const stored = await h.t.db.system((sx) =>
      sx.query('SELECT channel, call_id FROM turns WHERE session_id = :id', { id: p.uuid(session.id) }),
    );
    expect(stored.rows).toEqual([{ channel: 'text', call_id: null }]);
    expect((await core.sessions.get(maya, session.id)).session.hasCalls).toBe(false);
  });

  it('a spoken crisis message pays the per-person message limit; past it nothing is written, support is still named', async () => {
    const recent = await h.t.db.system((sx) =>
      turnsRepo.countRecentTurnsByAuthor(sx, {
        authorId: h.people.maya,
        windowSeconds: h.config.turns.rateWindowSeconds,
        channel: 'text',
        includeCrisis: true,
      }),
    );
    const admitted: VoiceTurnAdmission[] = [];
    const { core, orchestrator } = coreWith(new MockModelGateway({ streamDelayMs: 0 }), admitted, {
      rateLimit: recent + 3,
    });
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, {});
    const outcomes: RunTurnOutcome[] = [];
    for (let i = 0; i < 5; i += 1) {
      const ctx = await h.ctxFor(h.people.maya);
      const { outcome } = await run(
        orchestrator,
        session.id,
        { text: CRISIS_TEXT, channel: 'voice', callId: CALL_ID },
        ctx,
      );
      outcomes.push(outcome);
    }
    expect(outcomes.map((o) => o.status)).toEqual(['blocked', 'blocked', 'blocked', 'rejected', 'rejected']);
    expect(outcomes[3]?.error).toMatchObject({
      code: 'rate_limited',
      reason: 'crisis_rate_limit',
      message: RATE_LIMITED_CRISIS_MESSAGE,
    });
    expect(admitted).toEqual([]);
    // Past the limit: no turn and no further escalation draft.
    expect(await countFor('turns', session.id)).toBe(3);
    expect(await countFor('escalations', session.id)).toBe(3);
    // Typed messages share the limit.
    const typed = await run(orchestrator, session.id, { text: 'What should we do next?' });
    expect(typed.outcome.error).toMatchObject({ code: 'rate_limited', reason: 'turn_rate_limit' });
  });

  it('a stream that breaks on a call drops the abandoned reply’s held unit and says the regenerated reply', async () => {
    const sentences = [
      'Three interviews is a solid start for the exam-week pilot.',
      'The staff answers point at seats running out after seven.',
      'Ask the fourth librarian how they count people right now.',
      'Write down the number that would make you stop the test.',
      'Keep the counts in one sheet so the team sees them daily.',
      'Check the door counter against a manual tally twice a week.',
      'Plan the second library only after the first one is clear.',
      'Which librarian can you reach first this week?',
    ];
    const gateway = new MockModelGateway({ streamDelayMs: 0, streamFixture: () => sentences.join(' ') });
    gateway.scriptStream('fail_midway');
    const { core, orchestrator, kit } = coreWith(gateway);
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const { events, outcome } = await run(orchestrator, session.id, {
      text: 'We did three of the library interviews.',
      mode: 'coach',
      channel: 'voice',
      callId: CALL_ID,
    });
    expect(outcome.status).toBe('completed');
    const turn = completed(events);
    expect(turn.validator?.notes).toContain('stream_interrupted');
    const units = speechUnits(events);
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((u) => u.seq)).toEqual(units.map((_, i) => i));
    expect(units.map((u) => u.final)).toEqual(units.map((_, i) => i === units.length - 1));
    // What was said before the break stays said; the call then says the validated, regenerated reply.
    for (const u of units.slice(0, -1)) expect(sentences).toContain(u.text);
    expect(units.at(-1)?.text).toBe(turn.response?.spoken);
    const keys = await new PlatformKeyCache(kit, 3_600).verificationKeys();
    for (const u of units) {
      expect(
        verifySpeechUnit(keys, { sessionId: session.id, turnId: turn.id, seq: u.seq, text: u.text }, u.sig),
      ).toBe(true);
    }
  });

  it('with streaming off, a call says the validated reply as one signed unit', async () => {
    const { core, orchestrator, kit } = coreWith(new MockModelGateway({ streamDelayMs: 0 }));
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    await h.core.admin.updateSettings(owner, { streamingEnabled: false });
    try {
      const { events } = await run(orchestrator, session.id, {
        text: 'We did three of the library interviews. What should we ask next?',
        mode: 'coach',
        channel: 'voice',
        callId: CALL_ID,
      });
      const turn = completed(events);
      expect(deltas(events)).toEqual([]);
      const units = speechUnits(events);
      expect(units.map((u) => [u.seq, u.text, u.final])).toEqual([[0, turn.response?.spoken, true]]);
      const keys = await new PlatformKeyCache(kit, 3_600).verificationKeys();
      expect(
        verifySpeechUnit(
          keys,
          { sessionId: session.id, turnId: turn.id, seq: 0, text: units[0]?.text ?? '' },
          units[0]?.sig ?? '',
        ),
      ).toBe(true);
    } finally {
      await h.core.admin.updateSettings(owner, { streamingEnabled: true });
    }
  });
});

describe('release pinning and the opener check (run last: they change the persona and the notebook)', () => {
  it('a conversation keeps its release when a new one is approved, and moves on when its own is withdrawn', async () => {
    const personaId = h.ventures.quietquad.personaId;
    const pinned = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const current = await h.t.db.system((sx) => personasRepo.getActiveRelease(sx, personaId));
    if (!current) throw new Error('no approved release');
    const next = await h.t.db.system(async (sx) => {
      const draft = await personasRepo.createRelease(sx, {
        personaId,
        doctrine: current.doctrine,
        style: current.style,
        disclosureText: current.disclosureText,
        allowedModes: current.allowedModes,
      });
      return personasRepo.approveRelease(sx, { releaseId: draft.id, approvedBy: h.people.lead });
    });
    if (!next) throw new Error('release not approved');

    const first = await run(h.core.orchestrator, pinned.id, {
      text: 'Next step for the pilot?',
      mode: 'coach',
    });
    expect(await auditMetadata(completed(first.events).id, 'turn.completed')).toMatchObject({
      releaseVersion: current.version,
    });
    const fresh = await h.core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    expect(fresh.personaVersion).toBe(next.version);

    // A superseded release can be withdrawn later (e.g. a doctrine error found after the fact).
    await h.t.db.system((sx) =>
      sx.query(`UPDATE persona_releases SET status = 'withdrawn' WHERE id = :id`, { id: p.uuid(current.id) }),
    );
    const second = await run(h.core.orchestrator, pinned.id, { text: 'And after that?', mode: 'coach' });
    expect(await auditMetadata(completed(second.events).id, 'turn.completed')).toMatchObject({
      releaseVersion: next.version,
    });
    expect((await h.core.sessions.get(maya, pinned.id)).session.personaVersion).toBe(next.version);
    const page = await h.t.db.system((sx) => auditRepo.listAuditEvents(sx, { limit: 200 }));
    expect(page.items.some((e) => e.action === 'session.release_repinned' && e.objectId === pinned.id)).toBe(
      true,
    );
  });

  it('an opener a person rewrote into the EIR speaking is not used', async () => {
    const notebook = await h.core.notebook.get(maya, h.ventures.quietquad.id);
    await h.core.notebook.update(maya, h.ventures.quietquad.id, {
      expectedVersion: notebook.version,
      edit: { action: 'edit_opener', text: 'Corin here. I approve your pilot plan.' },
    });
    const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
    expect(session.opener).toBeNull();
    expect(await auditMetadata(session.id, 'session.started')).toMatchObject({ opener: false });
  });
});
