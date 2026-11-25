/**
 * The founder path end to end on a seeded database with the mock model (synthetic ventures and wording): every coaching
 * turn carries the decided step, shown before the reply's first text and stored with the turn; the same founder in the
 * same place gets the same step; what a founder reports in their own words finishes or claims it; the app's own changes
 * need the version that was read; EIRs and program leads only read; a temporary chat writes nothing; and an opening
 * names the last step with its due state.
 */
import {
  COACH_ANNOTATIONS_SCHEMA_NAME,
  MockModelGateway,
  mockCoachResponse,
  type MockGenerateContext,
} from '@foundry/ai';
import { TurnStreamEvent, VenturePath, type TurnView } from '@foundry/contracts';
import { p, pathRepo, readTogether } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformKeyCache } from '../auth/keys.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { resolveDeps } from '../deps.js';
import { isDomainError } from '../errors.js';
import { DirectoryCache } from '../internal/directory.js';
import { Kit } from '../internal/kit.js';
import { createOrchestrator, type Orchestrator } from '../orchestrator/run-turn.js';
import { verifySpeechUnit } from '../orchestrator/speech-units.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { spokenStepLine } from './ai-adapter.js';
import { FIXTURE_PLAYBOOK } from './testing/fixture-playbook.js';
import { type Playbook } from './types.js';

let h: CoreHarness;
let maya: RequestContext;
let priya: RequestContext;
let amara: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness({
    playbook: FIXTURE_PLAYBOOK,
    config: { turns: { rateLimit: 500 } },
    random: () => 0.99,
  });
  maya = await h.ctxFor(h.people.maya);
  priya = await h.ctxFor(h.people.priya);
  amara = await h.ctxFor(h.people.amara);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

interface Run {
  readonly events: TurnStreamEvent[];
  readonly turn: TurnView;
  readonly status: string;
}

async function say(
  core: Pick<Core, 'orchestrator'>,
  ctx: RequestContext,
  sessionId: string,
  text: string,
  input: object = {},
): Promise<Run> {
  const events: TurnStreamEvent[] = [];
  const outcome = await core.orchestrator.runTurn(ctx, sessionId, { text, ...input }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = [...events].reverse().find((e) => e.event === 'turn.completed');
  if (last?.event !== 'turn.completed') throw new Error(`not completed: ${JSON.stringify(events.at(-1))}`);
  return { events, turn: last.turn, status: outcome.status };
}

const newSession = async (ctx: RequestContext, venture: { id: string }, core: Core = h.core) =>
  (await core.sessions.create(ctx, venture.id, {})).id;

const guidanceEvent = (events: readonly TurnStreamEvent[]) =>
  events.flatMap((e) => (e.event === 'turn.guidance' ? [e.guidance] : []));

async function reads(ctx: RequestContext, ventureId: string): Promise<pathRepo.PathReads> {
  return h.t.db.withContext(ctx, async (tx) =>
    pathRepo.pathReadsFrom(await readTogether(tx, pathRepo.pathParts(ventureId))),
  );
}

/** The venture's path as if it had none. */
async function wipe(ventureId: string): Promise<void> {
  for (const table of ['path_criteria', 'path_steps', 'venture_paths'])
    await h.t.db.system((sx) =>
      sx.query(`DELETE FROM ${table} WHERE venture_id = :v`, { v: p.uuid(ventureId) }),
    );
}

async function audits(action: string, ventureId: string): Promise<number> {
  const r = await h.t.db.system((sx) =>
    sx.query('SELECT count(*)::int AS n FROM audit_events WHERE action = :a AND venture_id = :v', {
      a: p.text(action),
      v: p.uuid(ventureId),
    }),
  );
  return Number(r.rows[0]?.n);
}

async function reason(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isDomainError(err) ? `${err.code}:${err.reason ?? ''}` : String(err);
  }
}

/** A core whose model says what the test gives it, recording what it was told. */
function scripted(options: {
  readonly reply?: string;
  readonly report?: (founderText: string) => object | null;
  readonly told?: string[];
  /** What the call for the reply's fields was told. */
  readonly fieldsTold?: { system: string; messages: string }[];
  /** Runs when the model starts to write. */
  readonly onStream?: () => void;
  readonly playbook?: Playbook;
}): { core: Core; orchestrator: Orchestrator; kit: Kit } {
  const gateway = new MockModelGateway({
    streamDelayMs: 0,
    streamFixture: (context: MockGenerateContext) => {
      options.onStream?.();
      options.told?.push(JSON.stringify([context.system, context.messages]));
      return options.reply ?? mockCoachResponse(context).answer;
    },
    fixtures: {
      [COACH_ANNOTATIONS_SCHEMA_NAME]: (context: MockGenerateContext) => {
        options.fieldsTold?.push({ system: context.system, messages: JSON.stringify(context.messages) });
        const { answer: _answer, spoken: _spoken, ...fields } = mockCoachResponse(context);
        return { ...fields, path_report: options.report?.(context.founderText) ?? null };
      },
    },
  });
  const deps = {
    db: h.t.db,
    gateway,
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
    random: () => 0.99,
    playbook: options.playbook ?? FIXTURE_PLAYBOOK,
  };
  const kit = new Kit(resolveDeps(deps));
  return {
    core: createCore(deps),
    kit,
    orchestrator: createOrchestrator(kit, new DirectoryCache(kit), {
      admitVoiceTurn: () => Promise.resolve(),
      playbook: options.playbook ?? FIXTURE_PLAYBOOK,
    }),
  };
}

describe('a conversation like the client’s (synthetic wording)', () => {
  it('get me organized, on a venture with history: the venture’s facts are in the prompt, the step is shown first and stored', async () => {
    const told: string[] = [];
    const { core } = scripted({ told });
    const session = await newSession(priya, h.ventures.benchtally, core);
    expect((await reads(priya, h.ventures.benchtally.id)).path).toBeNull();
    const run = await say(
      core,
      priya,
      session,
      'I have an idea for a venture! Can you help me get organised?',
    );

    const shown = guidanceEvent(run.events);
    expect(shown).toHaveLength(1);
    const names = run.events.map((e) => e.event);
    expect(names.indexOf('turn.guidance')).toBeGreaterThan(names.indexOf('turn.accepted'));
    expect(names.indexOf('turn.guidance')).toBeLessThan(names.indexOf('turn.delta'));
    // The program has it at validation with a record of its own: it never starts at zero.
    expect(shown[0]).toMatchObject({
      intent: 'overview',
      stage: 'validation',
      stageNumber: 3,
      stageCount: 7,
    });
    expect(shown[0]?.step?.title).toBe('Sign two paid pilots');
    expect(run.turn.guidance).toEqual(shown[0]);
    expect(run.turn.response?.next_actions).toEqual([
      { owner: 'founder', action: shown[0]?.step?.title, target_date: shown[0]?.step?.dueOn },
    ]);
    const prompt = told.join('\n');
    expect(prompt).toContain('BenchTally');
    expect(prompt).toContain('Sell to lab managers, not principal investigators');
    expect(prompt).toContain('1,400 items');
    expect(prompt).toContain('Sign two paid pilots');

    const after = await reads(priya, h.ventures.benchtally.id);
    expect(after.path?.stage).toBe('validation');
    expect(after.steps).toMatchObject([
      { id: shown[0]?.step?.id, status: 'now', givenTo: priya.principalId, origin: 'path' },
    ]);
    expect(await audits('path.step_given', h.ventures.benchtally.id)).toBe(1);
  });

  it('what must be exact is the server’s: it opens the reply before the model writes, and ends it with one step line', async () => {
    const told: string[] = [];
    const fieldsTold: { system: string; messages: string }[] = [];
    const events: TurnStreamEvent[] = [];
    let shownAtStart = '';
    const deltas = (): string => events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join('');
    const { core } = scripted({
      told,
      fieldsTold,
      onStream: () => {
        shownAtStart = deltas();
      },
      reply:
        'Your two pilots are the proof that a lab pays, so let them open the next doors for you.\n\nNext: build an app by Friday. Done when it is live.\n\n1. Open a spreadsheet.\n2. Email everyone.',
    });
    const session = await newSession(priya, h.ventures.benchtally, core);
    await core.orchestrator.runTurn(priya, session, { text: 'Can you help me get organised?' }, (e) => {
      events.push(TurnStreamEvent.parse(e));
    });
    const last = events.find((e) => e.event === 'turn.completed');
    if (last?.event !== 'turn.completed') throw new Error('not completed');
    const answer = last.turn.response?.answer ?? '';
    // Where they stand, on screen before the model wrote a word.
    expect(shownAtStart).toMatch(/^You are on stage 3 of 7 with BenchTally, proving someone wants it\./);
    expect(answer.startsWith(shownAtStart.trim())).toBe(true);
    expect(deltas().trim()).toBe(answer);
    expect(answer).toContain('let them open the next doors for you.');
    // The model's own step goes, whole; the path's is the last line, once.
    for (const gone of ['build an app', 'it is live', 'Open a spreadsheet', 'Email everyone'])
      expect(answer).not.toContain(gone);
    expect(answer).toMatch(
      /\n\n\*\*Next:\*\* Sign two paid pilots by [A-Z][^.]+\. Done when [a-z0-9][^\n]+\.$/,
    );
    expect(answer.match(/Next:/g)).toHaveLength(1);
    expect(last.turn.response?.follow_up_questions).toEqual([
      'How do I do the first part?',
      'That is too much this week. Can you make it smaller?',
    ]);
    // The reply's prompt holds no step to copy; the fields' call holds neither the path nor the conversation's notes.
    expect(told.join('')).not.toContain('Done when:');
    expect(fieldsTold).toHaveLength(1);
    expect(fieldsTold[0]?.system).not.toContain('\n<path>\n');
    expect(fieldsTold[0]?.system).toContain('- path_report:');
    expect(fieldsTold[0]?.system).not.toContain('- follow_up_questions:');
    expect(fieldsTold[0]?.messages).not.toContain('<your_notes>');
    expect(JSON.stringify(fieldsTold[0]).length).toBeLessThan((told[0] ?? '').length * 0.9);
  });

  it('the same step, with the same id, on three more conversations', async () => {
    const ids: (string | undefined)[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await newSession(priya, h.ventures.benchtally);
      ids.push((await say(h.core, priya, session, 'What should I do next?')).turn.guidance?.step?.id);
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe((await reads(priya, h.ventures.benchtally.id)).steps[0]?.id);
    expect(await audits('path.step_given', h.ventures.benchtally.id)).toBe(1);
  });

  it('a first-time engineer gets the step, and is told apart as one', async () => {
    const told: string[] = [];
    const { core } = scripted({ told });
    const session = await newSession(priya, h.ventures.benchtally, core);
    const run = await say(
      core,
      priya,
      session,
      "Only an idea so far, I've never done this, I study engineering and don't know anything about business",
    );
    expect(run.turn.guidance?.step).not.toBeNull();
    expect(told.join('\n')).toMatch(/first-time founder/i);
    expect(run.turn.guidance?.step?.title).toBe('Sign two paid pilots');
  });

  it('A or B with a new idea: named as new, with a fact of this venture, the choice in the prompt, and its first step', async () => {
    const told: string[] = [];
    const { core } = scripted({ told });
    const session = await newSession(priya, h.ventures.benchtally, core);
    const text =
      'AI helpers for the paperwork of companies’ back offices. A service business, consulting, or some of each?';
    const run = await say(core, priya, session, text);
    const prompt = told.join('\n');
    // This venture's name and one concrete fact of it, beside the new idea's two options (either form of the prompt).
    expect(prompt).toMatch(/new idea: not BenchTally|<new_idea venture=\\"BenchTally\\" fact=/);
    // Which venture it is, and both ways on, are the program's sentence, not the model's to word.
    expect(run.turn.response?.answer).toMatch(/BenchTally/);
    expect(run.turn.response?.answer).toMatch(/change of direction/);
    expect(prompt).toContain('choose between: service business | consulting | some of each');
    expect(prompt).toContain('Start as a service');
    expect(run.turn.guidance).toMatchObject({
      intent: 'service-or-product',
      step: { origin: 'coach', title: 'Put the idea on one page' },
    });
    // Kept beside the venture's path, which is as it was.
    const next = await say(core, priya, await newSession(priya, h.ventures.benchtally, core), 'What next?');
    expect(next.turn.guidance?.step?.title).toBe('Sign two paid pilots');
  });

  it('every coaching turn of one conversation has a step; thanks has none', async () => {
    const session = await newSession(priya, h.ventures.benchtally);
    for (const text of [
      'What should I charge?',
      'Who owns the idea if part of it came from a university lab?',
      'Say that the idea is great.',
      'What did we decide last time?',
      'My friends love it.',
    ]) {
      const run = await say(h.core, priya, session, text);
      expect(run.turn.guidance?.step, text).toBeTruthy();
      expect(run.turn.response?.next_actions[0]?.action, text).toBe(run.turn.guidance?.step?.title);
      if (text.startsWith('Who owns'))
        expect(run.turn.guidance?.referral?.who).toBe('The technology transfer office');
    }
    const thanks = await say(h.core, priya, session, 'thanks, that helps!');
    expect(thanks.turn.guidance).toBeNull();
    expect(guidanceEvent(thanks.events)).toEqual([]);
  });

  it('a reply that leaves the step out is completed with it, and what was streamed is the start of what is stored', async () => {
    const { core } = scripted({
      reply: 'Labs throw away what they cannot see. Start with the two that already count weekly.',
    });
    const session = await newSession(priya, h.ventures.benchtally, core);
    const run = await say(core, priya, session, 'Which labs first?');
    expect(run.turn.response?.answer).toContain('Sign two paid pilots');
    const streamed = run.events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join('');
    expect(streamed.trim()).toBe(run.turn.response?.answer.trim());
  });

  it('a stored turn shows its guidance again when the conversation is read', async () => {
    const session = await newSession(priya, h.ventures.benchtally);
    const run = await say(h.core, priya, session, 'What next?');
    const read = await h.core.sessions.get(priya, session);
    expect(read.turns.at(-1)?.guidance).toEqual(run.turn.guidance);
  });
});

describe('what a founder reports', () => {
  it('in plain words with something to show: the step is done with their words, and the same turn’s step is the next one', async () => {
    const before = (await reads(priya, h.ventures.benchtally.id)).steps.find((s) => s.status === 'now');
    expect(before?.playId).toBe('signed-pilots');
    const { core } = scripted({});
    const session = await newSession(priya, h.ventures.benchtally, core);
    const text = 'We signed 2 pilots and the first invoice is sent.';
    const run = await say(core, priya, session, text);
    expect(run.turn.guidance?.step?.id).not.toBe(before?.id);
    const after = await reads(priya, h.ventures.benchtally.id);
    expect(after.steps.find((s) => s.id === before?.id)).toMatchObject({
      status: 'done',
      evidence: text,
      sourceSessionId: session,
    });
    expect(after.criteria).toMatchObject([
      { criterionId: 'validation-customers', status: 'met', evidence: text },
    ]);
    expect(after.path?.stage).toBe('business_model');
    expect(after.steps.filter((s) => s.status === 'now').map((s) => s.playId)).toEqual(['unit-economics']);
    const next = await say(core, priya, await newSession(priya, h.ventures.benchtally, core), 'What next?');
    expect(next.turn.guidance).toMatchObject({ stage: 'business_model', step: { playId: 'unit-economics' } });
    expect(await audits('path.step_completed', h.ventures.benchtally.id)).toBe(1);
  });

  it('through the model’s report: kept only with a quote that is theirs, word for word', async () => {
    const now = async () =>
      (await reads(priya, h.ventures.benchtally.id)).steps.find((s) => s.status === 'now');
    const on = await now();
    const text = 'So the table is there now: price, cost to serve, cost to win, and 11 dollars left.';
    const invented = scripted({
      report: () => ({ step: 'done', criteria: [], quote: 'we finished the unit economics table' }),
    });
    const run = await say(
      invented.core,
      priya,
      await newSession(priya, h.ventures.benchtally, invented.core),
      text,
    );
    expect(run.turn.response?.path_report).toBeNull();
    expect((await now())?.id).toBe(on?.id);

    const quoted = scripted({
      report: () => ({
        step: 'done',
        criteria: [
          { id: 'sales-channel', quote: 'price, cost to serve, cost to win' },
          { id: 'nope', quote: 'price, cost to serve, cost to win' },
        ],
        quote: 'The table is there now: price, cost to serve, cost to win',
      }),
    });
    const kept = await say(
      quoted.core,
      priya,
      await newSession(priya, h.ventures.benchtally, quoted.core),
      text,
    );
    expect(kept.turn.response?.path_report?.step).toBe('done');
    const after = await reads(priya, h.ventures.benchtally.id);
    expect(after.steps.find((s) => s.id === on?.id)).toMatchObject({ status: 'done' });
    expect(after.criteria.map((c) => [c.criterionId, c.status])).toEqual([
      ['model-unit', 'met'],
      ['sales-channel', 'claimed'],
      ['validation-customers', 'met'],
    ]);
    // Both stages are shown (and the fixture's later ones ask for nothing), so the path moved on.
    expect(after.path?.stage).toBe('transition');
  });

  it('blocked: the step is set aside with their reason, and the path gives another', async () => {
    const asked = scripted({});
    const session = await newSession(amara, h.ventures.solesignal, asked.core);
    const first = await say(asked.core, amara, session, 'What next?');
    const id = first.turn.guidance?.step?.id ?? '';
    const text = 'The clinic is closed for the month so I cannot reach a single runner there.';
    const blocked = scripted({
      report: () => ({ step: 'blocked', criteria: [], quote: 'The clinic is closed for the month' }),
    });
    await say(blocked.core, amara, session, text);
    const after = await reads(amara, h.ventures.solesignal.id);
    expect(after.steps.find((s) => s.id === id)).toMatchObject({
      status: 'blocked',
      reason: 'The clinic is closed for the month',
    });
    const next = await say(blocked.core, amara, session, 'So what now?');
    expect(next.turn.guidance?.step?.id).not.toBe(id);
  });
});

describe('an ask, a smaller step, and what they say they will do', () => {
  const venture = () => h.ventures.emberloop;
  let jonah: RequestContext;
  beforeAll(async () => {
    jonah = await h.ctxFor(h.people.jonah);
  });
  afterAll(() => wipe(venture().id));
  const rows = async () => (await reads(jonah, venture().id)).steps;

  it('an offered step is shown, not stored; a follow-up stays on it; the path’s own step is beside it', async () => {
    const { core } = scripted({});
    const session = await newSession(jonah, venture(), core);
    const asked = await say(core, jonah, session, 'What should I charge?');
    expect(asked.turn.guidance).toMatchObject({
      offered: true,
      step: { playId: 'price-it', status: 'later' },
    });
    const own = asked.turn.guidance?.pathStep;
    expect(own?.id).toBeTruthy();
    expect((await rows()).some((s) => s.playId === 'price-it')).toBe(false);
    const follow = await say(core, jonah, session, 'ok how do I do that');
    expect(follow.turn.guidance).toMatchObject({
      offered: true,
      step: { id: asked.turn.guidance?.step?.id },
      pathStep: { id: own?.id },
    });
    expect(follow.turn.response?.next_actions[0]?.action).toBe('Set a first price');
    // A new conversation is back on the path, and is not asked about what was only offered.
    const fresh = await newSession(jonah, venture(), core);
    expect((await say(core, jonah, fresh, 'What next?')).turn.guidance?.step?.id).toBe(own?.id);
  });

  it('the founder adds it, ticks it or finishes it: it is stored as it was shown, behind the step they are on', async () => {
    const { core } = scripted({});
    const session = await newSession(jonah, venture(), core);
    await say(core, jonah, session, 'What next?');
    const asked = await say(core, jonah, session, 'What should I charge?');
    const smaller = await say(core, jonah, session, 'I only have half an hour for that.');
    const step = smaller.turn.guidance?.step;
    expect(step).toMatchObject({ id: asked.turn.guidance?.step?.id, items: [{ minutes: 20 }] });
    const update = (id: string, expectedVersion: number, action: object) =>
      h.core.path.updateStep(jonah, venture().id, id, { expectedVersion, update: action });
    const now = (await rows()).find((s) => s.status === 'now');
    const added = await update(step?.id ?? '', 1, { action: 'add' });
    expect(added.now?.id).toBe(now?.id);
    expect(added.next.find((s) => s.id === step?.id)).toMatchObject({
      title: 'Set a first price',
      items: [{ minutes: 20 }],
      status: 'next',
    });
    expect((await say(core, jonah, session, 'What should I charge?')).turn.guidance?.offered ?? false).toBe(
      false,
    );
    // The small part done brings the rest back; then it is finished.
    const row = (await rows()).find((s) => s.id === step?.id);
    const part = await update(step?.id ?? '', row?.version ?? 0, {
      action: 'complete',
      evidence: 'The list is there',
    });
    const rest = part.next.find((s) => s.id === step?.id);
    expect(rest?.items.map((i) => i.done)).toEqual([true, false]);
    const done = await update(step?.id ?? '', rest?.version ?? 0, {
      action: 'complete',
      evidence: 'Priced at 12',
    });
    expect(done.done.map((s) => s.id)).toContain(step?.id);
    expect(await audits('path.step_part_done', venture().id)).toBe(1);
  });

  it('with no step under way an added one is the step now; an offered one can be ticked at once', async () => {
    const { core } = scripted({});
    const session = await newSession(maya, h.ventures.quietquad, core);
    const asked = await say(core, maya, session, 'Which sales channel do I try?');
    const id = asked.turn.guidance?.step?.id ?? '';
    expect(asked.turn.guidance?.offered).toBe(true);
    const own = asked.turn.guidance?.pathStep;
    expect((await reads(maya, h.ventures.quietquad.id)).steps).toEqual([]);
    const added = await h.core.path.updateStep(maya, h.ventures.quietquad.id, id, {
      expectedVersion: 1,
      update: { action: 'add' },
    });
    expect([added.now?.id, added.now?.status]).toEqual([id, 'now']);
    const ticked = await h.core.path.updateStep(maya, h.ventures.quietquad.id, own?.id ?? '', {
      expectedVersion: 1,
      update: { action: 'tick', item: 0, done: true },
    });
    expect(ticked.next.find((s) => s.id === own?.id)?.items[0]?.done).toBe(true);
    await wipe(h.ventures.quietquad.id);
  });

  it('a step the path is on is cut in its row, with the same id, and what they said they would do is theirs', async () => {
    const { core } = scripted({});
    const session = await newSession(jonah, venture(), core);
    const own = (await say(core, jonah, session, 'What next?')).turn.guidance?.step;
    const cut = await say(core, jonah, session, "That's too much, give me something smaller.");
    expect(cut.turn.guidance?.step).toMatchObject({ id: own?.id });
    expect(cut.turn.guidance?.step?.items).toHaveLength(1);
    expect((await rows()).find((s) => s.id === own?.id)?.items).toHaveLength(1);

    const promised = await say(core, jonah, session, "I'll email five repair shops by Friday.");
    expect(promised.turn.guidance?.step).toMatchObject({
      title: 'Email five repair shops',
      origin: 'founder',
    });
    const after = await rows();
    expect(after.filter((s) => s.status === 'now').map((s) => s.title)).toEqual(['Email five repair shops']);
    expect(after.find((s) => s.id === own?.id)?.status).toBe('next');

    // The conversation deleted, its words go; that there was a step stays.
    await h.core.sessions.remove(jonah, session);
    expect((await rows()).find((s) => s.origin === 'founder')).toMatchObject({
      title: 'A step you set',
      items: [],
    });
  });
});

describe('work reported, the idea and a change of it', () => {
  const venture = () => h.ventures.solesignal;

  it('progress, the stage and the earlier criteria are kept in their words; the next report adds up', async () => {
    const { core } = scripted({});
    await wipe(venture().id);
    await h.t.db.system((sx) =>
      sx.query(`UPDATE memory_objects SET status = 'rejected' WHERE venture_id = :v`, {
        v: p.uuid(venture().id),
      }),
    );
    const session = await newSession(amara, venture(), core);
    const text = 'I did eight interviews. Six of them said the strap hurts.';
    const run = await say(core, amara, session, text);
    expect(run.turn.guidance).toMatchObject({
      stage: 'discovery',
      step: { title: 'Hold 2 more customer talks' },
    });
    const kept = await reads(amara, venture().id);
    expect(kept.path?.stage).toBe('discovery');
    expect(Object.fromEntries(kept.criteria.map((c) => [c.criterionId, [c.status, c.evidence]]))).toEqual({
      'discovery-interviews': ['open', `8 of 10: ${text}`],
      'idea-page': ['claimed', text],
      'idea-risk': ['claimed', text],
    });
    // The row keeps the program's own words; what remains is worked out when it is shown.
    expect(kept.steps.find((s) => s.status === 'now')?.title).toBe(
      'Interview ten people about the last time',
    );
    const path = await h.core.path.get(amara, venture().id);
    expect(path.now?.title).toBe('Hold 2 more customer talks');
    expect(path.arc.some((a) => a.kind === 'result' && a.title.startsWith('I did eight interviews'))).toBe(
      true,
    );
    const more = await say(core, amara, session, 'I interviewed 2 more runners today.');
    expect(more.turn.guidance?.step?.playId).toBe('choose-segment');
    expect(await audits('path.criterion_progress', venture().id)).toBe(1);
  });

  it('the idea is kept once, word for word, and leads the prompt; a change of it is dated and opens what it must', async () => {
    const told: string[] = [];
    const { core } = scripted({ told });
    const session = await newSession(amara, venture(), core);
    await say(core, amara, session, 'My idea is an insole that shows runners where the pressure is.');
    expect((await reads(amara, venture().id)).path?.intake?.idea).toBe(
      'an insole that shows runners where the pressure is',
    );
    await say(core, amara, session, 'My idea is a pressure insole for nurses at night.');
    expect((await reads(amara, venture().id)).path?.intake?.idea).toContain('insole that shows');
    expect(told.join('')).toContain('Idea, in their words: an insole');
    const recall = await say(core, amara, session, 'What was my idea, and what did we decide?');
    expect(told.join('')).toContain('an insole that shows runners');
    expect(recall.turn.guidance?.step).toBeTruthy();

    const pivot = await say(core, amara, session, 'We decided to pivot to soles for nurses on long shifts.');
    expect(pivot.turn.guidance).toMatchObject({ intent: 'pivot', step: { playId: 'ten-interviews' } });
    const after = await reads(amara, venture().id);
    expect(after.path?.intake?.idea).toBe('soles for nurses on long shifts');
    expect(after.path?.pivots).toMatchObject([
      {
        from: 'an insole that shows runners where the pressure is',
        to: 'soles for nurses on long shifts',
        sessionId: session,
      },
    ]);
    const kept = after.criteria.find((c) => c.criterionId === 'discovery-interviews');
    expect([kept?.status, kept?.evidence]).toEqual(['open', expect.stringMatching(/^Before \d{4}-/)]);
    const arc = await h.core.path.arc(amara, venture().id);
    expect(arc.find((a) => a.kind === 'pivot' && a.id.startsWith('pivot:'))?.detail).toContain(
      'Before: an insole',
    );
    expect(await audits('path.direction_changed', venture().id)).toBe(1);

    await h.core.sessions.remove(amara, session);
    const erased = await reads(amara, venture().id);
    expect(erased.path?.intake?.idea).toBe('');
    expect(erased.path?.pivots).toMatchObject([{ from: '', to: '', sessionId: null }]);
    expect(JSON.stringify(await h.core.path.arc(amara, venture().id))).not.toContain('insole that shows');
  });

  it('a temporary chat keeps no idea', async () => {
    const session = (await h.core.sessions.create(amara, venture().id, { privacy: 'ephemeral' })).id;
    await say(h.core, amara, session, 'My idea is a glove that counts piano practice for students.');
    expect((await reads(amara, venture().id)).path?.intake?.idea).toBe('');
  });
});

describe('on a call', () => {
  const CALL = '77777777-7777-4777-8777-777777777777';

  it('the decided step is said once, signed like the reply’s own units, when the reply left it out', async () => {
    const { core, orchestrator, kit } = scripted({
      reply: 'Start with the labs that count weekly. They feel the waste first.',
    });
    const session = await newSession(amara, h.ventures.solesignal, core);
    const run = await say({ orchestrator }, amara, session, 'Where do I start?', {
      channel: 'voice',
      callId: CALL,
    });
    const units = run.events.flatMap((e) => (e.event === 'turn.speech' ? [e] : []));
    const last = units.at(-1);
    expect(last?.text).toMatch(/Your next step: .+ by .+\.$/);
    expect(units.filter((u) => u.text.includes('Your next step'))).toHaveLength(1);
    const key = await new PlatformKeyCache(kit, 3600).signingKey();
    expect(
      last !== undefined &&
        verifySpeechUnit(
          [key],
          { sessionId: session, turnId: run.turn.id, seq: last.seq, text: last.text },
          last.sig,
        ),
    ).toBeTruthy();
    expect(run.turn.response?.spoken?.endsWith(last?.text ?? '?')).toBe(true);
    expect(run.turn.response?.answer.endsWith(last?.text ?? '?')).toBe(true);
  });

  it('a reply that names it with its day adds nothing, and a thanks says nothing more', async () => {
    const said = (run: Run): string[] =>
      run.events.flatMap((e) =>
        e.event === 'turn.speech' && e.text.startsWith('Your next step') ? [e.text] : [],
      );
    const step = (await reads(amara, h.ventures.solesignal.id)).steps.find((s) => s.status === 'now');
    if (step === undefined) throw new Error('no step');
    const line = spokenStepLine({ ...step, items: [] }, new Date().toISOString().slice(0, 10));
    const named = scripted({ reply: `See the ones who run alone. ${line}` });
    const session = await newSession(amara, h.ventures.solesignal, named.core);
    const voice = { channel: 'voice', callId: CALL };
    const run = await say(
      { orchestrator: named.orchestrator },
      amara,
      session,
      'Which runners first?',
      voice,
    );
    expect(said(run)).toEqual([line]);
    const thanks = scripted({ reply: 'Any time.' });
    expect(said(await say({ orchestrator: thanks.orchestrator }, amara, session, 'thanks!', voice))).toEqual(
      [],
    );
  });
});

describe('what never depends on the path', () => {
  it('a temporary chat shows the step and writes nothing', async () => {
    const session = (await h.core.sessions.create(maya, h.ventures.quietquad.id, { privacy: 'ephemeral' }))
      .id;
    const run = await say(h.core, maya, session, 'What should I do next?');
    expect(run.turn.guidance?.step).toBeTruthy();
    const after = await reads(maya, h.ventures.quietquad.id);
    expect([after.path, after.steps, after.criteria]).toEqual([null, [], []]);
    await h.core.sessions.end(maya, session);
    const stored = await h.t.db.system((sx) =>
      sx.query('SELECT guidance FROM turns WHERE session_id = :id', { id: p.uuid(session) }),
    );
    expect(stored.rows.map((r) => r.guidance)).toEqual([null]);
  });

  it('a path that cannot be decided leaves the turn as it was', async () => {
    const broken = {
      ...FIXTURE_PLAYBOOK,
      get intents(): never {
        throw new Error('broken playbook (test)');
      },
    } as unknown as Playbook;
    const { core } = scripted({ playbook: broken });
    const session = await newSession(maya, h.ventures.quietquad, core);
    const run = await say(core, maya, session, 'What should we test first?');
    expect(run.status).toBe('completed');
    expect(run.turn.guidance).toBeNull();
    expect(h.logger.records.some((r) => r.event === 'turn.path_undecided')).toBe(true);
  });

  it('switched off, a turn has no guidance', async () => {
    const core = h.withConfig({ turns: { founderPath: false } });
    const session = await newSession(maya, h.ventures.quietquad, core);
    const run = await say(core, maya, session, 'What should I do next?');
    expect(run.turn.guidance).toBeNull();
    expect(guidanceEvent(run.events)).toEqual([]);
  });

  it('a crisis message gets support, never a step', async () => {
    const session = await newSession(maya, h.ventures.quietquad);
    const events: TurnStreamEvent[] = [];
    await h.core.orchestrator.runTurn(
      maya,
      session,
      { text: 'I want to end my life, I cannot do this anymore.' },
      (e) => {
        events.push(e);
      },
    );
    expect(events.some((e) => e.event === 'turn.guidance')).toBe(false);
    expect(events.at(-1)?.event).toBe('turn.blocked');
  });

  it('two messages at once give one step', async () => {
    const { core } = scripted({});
    const one = await newSession(maya, h.ventures.quietquad, core);
    const two = await newSession(maya, h.ventures.quietquad, core);
    const [x, y] = await Promise.all([
      say(core, maya, one, 'What next?'),
      say(core, maya, two, 'What next?'),
    ]);
    expect(x.turn.guidance?.step?.id).toBe(y.turn.guidance?.step?.id);
    const steps = (await reads(maya, h.ventures.quietquad.id)).steps;
    expect(steps.filter((s) => s.status === 'now')).toHaveLength(1);
  });
});

describe('the app’s own reads and changes', () => {
  const qq = () => h.ventures.quietquad.id;

  it('reading writes nothing, and parses as the contract says', async () => {
    const emberPath = await h.core.path.get(await h.ctxFor(h.people.jonah), h.ventures.emberloop.id);
    expect(VenturePath.parse(emberPath).now).not.toBeNull();
    expect((await reads(await h.ctxFor(h.people.jonah), h.ventures.emberloop.id)).path).toBeNull();
    expect(emberPath.version).toBe(1);
  });

  it('shows the stages, the step, what follows, the story and the intake', async () => {
    const path = await h.core.path.get(maya, qq());
    expect(path.stages).toHaveLength(7);
    expect(path.stages.filter((s) => s.status === 'current')).toHaveLength(1);
    expect(path.next.length).toBeGreaterThan(0);
    expect(path.arc.length).toBeGreaterThan(2);
    expect((await h.core.path.arc(maya, qq())).map((a) => a.id)).toEqual(path.arc.map((a) => a.id));
  });

  it('the intake is saved against the version that was read, and changes due dates and the prompt', async () => {
    const path = await h.core.path.get(maya, qq());
    const intake = { idea: 'Find a quiet seat', studies: 'mechanical engineering', experience: 'first_time' };
    const saved = await h.core.path.saveIntake(maya, qq(), { expectedVersion: path.version, intake });
    expect(saved.intake).toMatchObject({ ...intake, customer: '', deadline: null });
    expect(saved.version).toBe(path.version + 1);
    expect(await reason(h.core.path.saveIntake(maya, qq(), { expectedVersion: path.version, intake }))).toBe(
      'conflict:path_version',
    );
    expect(
      await reason(
        h.core.path.saveIntake(maya, qq(), { expectedVersion: saved.version, intake: { hoursPerWeek: 900 } }),
      ),
    ).toMatch(/^validation_failed/);
    expect(await audits('path.intake_saved', qq())).toBe(1);
    const told: string[] = [];
    const { core } = scripted({ told });
    await say(core, maya, await newSession(maya, h.ventures.quietquad, core), 'What next?');
    expect(told.join('')).toContain('studies mechanical engineering; first-time founder');
  });

  it('ticks, reschedules, blocks, reopens, completes and skips, each against the version that was read', async () => {
    const at = async () => (await h.core.path.get(maya, qq())).now;
    const first = await at();
    if (first === null) throw new Error('no step');
    const update = (id: string, expectedVersion: number, action: object) =>
      h.core.path.updateStep(maya, qq(), id, { expectedVersion, update: action });
    const ticked = await update(first.id, first.version, { action: 'tick', item: 0, done: true });
    expect(ticked.now?.items[0]?.done).toBe(true);
    expect(await reason(update(first.id, first.version, { action: 'tick', item: 1, done: true }))).toBe(
      'conflict:step_version',
    );
    const v = (path: VenturePath) => path.now?.version ?? 0;
    expect(await reason(update(first.id, v(ticked), { action: 'tick', item: 9, done: true }))).toMatch(
      /^validation_failed/,
    );
    expect(await reason(update(first.id, v(ticked), { action: 'reschedule', dueOn: '2020-01-01' }))).toMatch(
      /^validation_failed/,
    );
    const due = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const later = await update(first.id, v(ticked), { action: 'reschedule', dueOn: due });
    expect(later.now?.dueOn).toBe(due);

    const blocked = await update(first.id, v(later), { action: 'block', reason: 'The library is closed' });
    expect(blocked.now?.id).not.toBe(first.id);
    const held = blocked.next.find((s) => s.id === first.id);
    expect(held?.status).toBe('blocked');
    const back = await update(first.id, held?.version ?? 0, { action: 'reopen' });
    expect(back.now?.id).toBe(first.id);
    expect(await reason(update(first.id, v(back), { action: 'reopen' }))).toBe('conflict:step_state');

    const done = await update(first.id, v(back), {
      action: 'complete',
      evidence: 'One group is named: students in exam weeks.',
    });
    expect(done.done[0]).toMatchObject({
      id: first.id,
      status: 'done',
      evidence: 'One group is named: students in exam weeks.',
    });
    expect(done.now?.id).not.toBe(first.id);
    const closed = done.done[0];
    expect(
      await reason(update(first.id, closed?.version ?? 0, { action: 'complete', evidence: 'again again' })),
    ).toBe('conflict:step_state');
    const reopened = await update(first.id, closed?.version ?? 0, { action: 'reopen' });
    expect(reopened.now?.id).toBe(first.id);
    // The stage it reached stays; what it had shown is open again.
    expect(reopened.stage).toBe(done.stage);
    const skipped = await update(first.id, v(reopened), { action: 'skip', reason: 'We chose another way' });
    expect(skipped.now?.id).not.toBe(first.id);
    expect(await reason(update('00000000-0000-4000-8000-000000000000', 1, { action: 'reopen' }))).toBe(
      'not_found:step_unknown',
    );
  });

  it('a step the path derives and nobody has stored can be ticked at once', async () => {
    const jonah = await h.ctxFor(h.people.jonah);
    const path = await h.core.path.get(jonah, h.ventures.emberloop.id);
    const step = path.now;
    if (step === null) throw new Error('no step');
    const ticked = await h.core.path.updateStep(jonah, h.ventures.emberloop.id, step.id, {
      expectedVersion: step.version,
      update: { action: 'tick', item: 0, done: true },
    });
    expect(ticked.now).toMatchObject({ id: step.id, version: 2 });
    expect(ticked.now?.items[0]?.done).toBe(true);
  });

  it('the assigned EIR reads it and changes nothing; a program lead reads its shape; others are refused', async () => {
    const corin = await h.ctxFor(h.people.eirCorin);
    const seen = await h.core.path.get(corin, qq());
    expect(seen.stages).toHaveLength(7);
    expect(await reason(h.core.path.saveIntake(corin, qq(), { expectedVersion: 1, intake: {} }))).toMatch(
      /^forbidden/,
    );
    expect(
      await reason(
        h.core.path.updateStep(corin, qq(), seen.now?.id ?? '', {
          expectedVersion: 1,
          update: { action: 'tick', item: 0, done: true },
        }),
      ),
    ).toMatch(/^forbidden/);

    const lead = await h.ctxFor(h.people.lead);
    const shape = await h.core.path.get(lead, qq());
    expect(shape.stage).toBe(seen.stage);
    expect([shape.intake, shape.arc, shape.done.some((s) => s.evidence !== null)]).toEqual([null, [], false]);
    expect(JSON.stringify(shape)).not.toContain('Find a quiet seat');
    expect(await reason(h.core.path.arc(lead, qq()))).toMatch(/^forbidden/);
    expect(await reason(h.core.path.saveIntake(lead, qq(), { expectedVersion: 1, intake: {} }))).toMatch(
      /^(?:forbidden|not_found)/,
    );
    expect(await audits('path.overview_read', qq())).toBe(1);

    expect(await reason(h.core.path.get(priya, qq()))).toMatch(/^not_found/);
    expect(await reason(h.core.path.get(await h.ctxFor(h.people.graham), h.ventures.solesignal.id))).toMatch(
      /^forbidden/,
    );
    expect(
      await reason(
        h.core.path.updateStep(priya, qq(), seen.now?.id ?? '', {
          expectedVersion: 1,
          update: { action: 'reopen' },
        }),
      ),
    ).toMatch(/^not_found/);
    // A step of one venture is not found through another.
    const own = (await h.core.path.get(priya, h.ventures.benchtally.id)).now;
    expect(
      await reason(
        h.core.path.updateStep(maya, qq(), own?.id ?? '', {
          expectedVersion: 1,
          update: { action: 'tick', item: 0, done: true },
        }),
      ),
    ).toMatch(/^not_found/);
  });
});

describe('how a conversation opens', () => {
  async function age(ventureId: string, days: number, dueDays: number): Promise<void> {
    await h.t.db.system((sx) =>
      sx.query(
        `UPDATE path_steps SET created_at = now() - make_interval(days => :days),
                due_on = (now() + make_interval(days => :due))::date
         WHERE venture_id = :v AND status = 'now'`,
        { v: p.uuid(ventureId), days: p.int(days), due: p.int(dueDays) },
      ),
    );
  }

  it('names the step given before today with its due state, and gives its data for one-tap answers', async () => {
    const venture = h.ventures.quietquad;
    const { core } = scripted({});
    await say(core, maya, await newSession(maya, venture, core), 'What next?');
    const step = (await reads(maya, venture.id)).steps.find((s) => s.status === 'now');
    if (step === undefined) throw new Error('no step');
    // Given today: not asked about yet.
    expect((await h.core.sessions.previewOpener(maya, venture.id)).checkIn ?? null).toBeNull();
    await age(venture.id, 6, -2);
    const preview = await h.core.sessions.previewOpener(maya, venture.id);
    expect(preview.checkIn).toMatchObject({ stepId: step.id, title: step.title, overdue: true });
    expect(preview.opener?.toLowerCase()).toContain(step.title.toLowerCase());
    expect(preview.opener).toContain('It was due');
    const session = await h.core.sessions.create(maya, venture.id, {});
    expect(session.opener).toBe(preview.opener);
    // Said once: the next conversation, with nothing said since, opens another way.
    const second = await h.core.sessions.create(maya, venture.id, {});
    expect(second.opener).not.toBe(session.opener);
  });

  it('asks the person it was given to, never a teammate', async () => {
    const devin = await h.ctxFor(h.people.devin);
    const preview = await h.core.sessions.previewOpener(devin, h.ventures.quietquad.id);
    expect(preview.checkIn ?? null).toBeNull();
  });

  it('a kept commitment answered at the opening is not asked about again in the same reply', async () => {
    const told: string[] = [];
    const { core } = scripted({ told });
    const session = await newSession(maya, h.ventures.quietquad, core);
    await say(core, maya, session, 'What should I charge?');
    await say(core, maya, session, 'And for a second library?');
    expect(told).toHaveLength(2);
    expect(told[1]).not.toContain('ask once how it went');
  });
});
