/**
 * The vEIR's presence as the server enforces it: the system prompt speaks in the EIR's own voice only while the
 * EIR's consent covers `first_person`, and says the EIR sees the work only when that EIR is the venture's; the
 * venture and the call settings tell clients the same; a volunteered disclaimer is rewritten out of a streamed
 * answer without blocking or counting as an identity violation; the welcome is stored with the person; a call
 * introduces the vEIR only on a first meeting. Its own database: the tests record consents.
 */
import { MockModelGateway, type MockGenerateContext } from '@foundry/ai';
import { TurnStreamEvent } from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { resolveDeps } from '../deps.js';
import { DirectoryCache } from '../internal/directory.js';
import { Kit } from '../internal/kit.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { createOrchestrator, type RunTurnOutcome } from './run-turn.js';

let h: CoreHarness;
let maya: RequestContext;
let lead: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness({
    gatewayOptions: { streamDelayMs: 0 },
    config: { turns: { rateLimit: 500 } },
  });
  maya = await h.ctxFor(h.people.maya);
  lead = await h.ctxFor(h.people.lead);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

interface Run {
  readonly system: string;
  readonly events: TurnStreamEvent[];
  readonly outcome: RunTurnOutcome;
}

/** A typed turn on QuietQuad whose model streams `reply`; returns the system prompt it was given. */
async function turn(
  reply: string,
  text = 'Where do we start?',
  privacy: 'standard' | 'ephemeral' = 'standard',
): Promise<Run> {
  const systems: string[] = [];
  const deps = {
    db: h.t.db,
    gateway: new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: (context: MockGenerateContext) => {
        systems.push(context.system);
        return reply;
      },
    }),
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
  };
  const kit = new Kit(resolveDeps(deps));
  const orchestrator = createOrchestrator(kit, new DirectoryCache(kit), {
    admitVoiceTurn: () => Promise.resolve(),
  });
  const core = createCore(deps);
  const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach', privacy });
  const events: TurnStreamEvent[] = [];
  const outcome = await orchestrator.runTurn(maya, session.id, { text, mode: 'coach' }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  return { system: systems[0] ?? '', events, outcome };
}

const corinPersona = (): string => h.ventures.quietquad.personaId;

describe('the vEIR’s presence, enforced by the server', () => {
  it('speaks in Corin’s own voice while Corin’s consent covers first_person, and says Corin sees the work', async () => {
    const venture = await h.core.ventures.get(maya, h.ventures.quietquad.id);
    expect(venture.persona).toMatchObject({ eirFirstName: 'Corin', firstPerson: true, eirSeesWork: true });
    const config = await h.core.veir.callConfig(maya, h.ventures.quietquad.id);
    expect(config.veir).toMatchObject({ firstPerson: true, eirSeesWork: true });

    const { system, outcome } = await turn('Start with the door counts.');
    expect(outcome.status).toBe('completed');
    expect(system).toContain(
      "Be present, like Corin on a video call: first person, in Corin's voice and style",
    );
    expect(system).toContain('Corin sees what you and the founder work on here.');
    expect(system).toContain('Never claim to be human or Corin in person');
  });

  it('credits the method to Corin and shows "Corin’s vEIR" once the consent no longer covers first_person', async () => {
    await h.core.personas.recordConsent(lead, corinPersona(), {
      assetTypes: ['doctrine', 'style', 'voice', 'cases'],
    });
    const venture = await h.core.ventures.get(maya, h.ventures.quietquad.id);
    expect(venture.persona).toMatchObject({ eirFirstName: 'Corin', firstPerson: false, eirSeesWork: true });
    expect((await h.core.veir.callConfig(maya, h.ventures.quietquad.id)).veir.firstPerson).toBe(false);
    const { system } = await turn('Start with the door counts.');
    expect(system).toContain('credit the method to Corin ("Corin\'s rule');
    expect(system).not.toContain('like Corin on a video call');
    // The hard lines never move with the consent.
    expect(system).toContain('Never claim to be human or Corin in person');

    // Recorded again with the scope, the twin is back under Corin's first name.
    await h.core.personas.recordConsent(lead, corinPersona(), {
      assetTypes: ['doctrine', 'style', 'voice', 'cases', 'first_person'],
    });
    expect((await h.core.ventures.get(maya, h.ventures.quietquad.id)).persona?.firstPerson).toBe(true);
  });

  it('never says Corin sees the work in a private conversation, which Corin never reads', async () => {
    const { system, outcome } = await turn('Start with the door counts.', 'Where do we start?', 'ephemeral');
    expect(outcome.status).toBe('completed');
    expect(system).toContain(
      "Be present, like Corin on a video call: first person, in Corin's voice and style",
    );
    expect(system).not.toContain('Corin sees what');
    expect(system).not.toContain('sees what we work on');
  });

  it('keeps a real model’s honest answer, streamed and validated, and lets it stand when the founder asked', async () => {
    const reply = "Honestly? I'm just an AI. Start with the door counts.";
    const completedAnswer = (run: Run): string | undefined => {
      const last = run.events.at(-1);
      if (last?.event !== 'turn.completed') throw new Error('expected turn.completed');
      return last.turn.response?.answer;
    };
    const shownOf = (run: Run): string =>
      run.events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join('');
    const asked = await turn(reply, 'Wait, are you real?');
    expect(completedAnswer(asked)).toBe(reply);
    expect(shownOf(asked)).toBe(reply);
    const unasked = await turn(reply, 'Where do we start?');
    const honest =
      "Honestly? I'm Corin's digital twin, built from how Corin coaches. Start with the door counts.";
    expect(completedAnswer(unasked)).toBe(honest);
    expect(shownOf(unasked)).toBe(honest);
  });

  it('rewrites a volunteered disclaimer out of the streamed answer, without blocking or an identity violation', async () => {
    const { events, outcome } = await turn(
      "As an AI, I don't have a life. But here's the plan: count the door traffic for a week.",
      'Do you even have a life?',
    );
    expect(outcome.status).toBe('completed');
    const shown = events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join('');
    expect(shown).not.toMatch(/as an AI|have a life/i);
    const completed = events.at(-1);
    if (completed?.event !== 'turn.completed') throw new Error('expected turn.completed');
    expect(completed.turn.response?.answer).toBe("Here's the plan: count the door traffic for a week.");
    expect(completed.turn.validator?.identityViolation).toBe(false);
  });
});

describe('a call introduces the vEIR only on a first meeting', () => {
  it('introduces it in a person’s first conversation, then greets once that conversation is under way', async () => {
    const devin = await h.ctxFor(h.people.devin);
    const session = await h.core.sessions.create(devin, h.ventures.quietquad.id, { mode: 'coach' });
    const first = await h.core.calls.start(devin, session.id, { inputMode: 'typed' });
    expect(first.intro?.text).toMatch(/^Hi Devin, I'm Corin's vEIR, Corin's digital twin\. /);
    await h.core.calls.end(devin, first.call.id, { reason: 'user' });
    // Devin chats by text in this, his only conversation, then presses Call: they have met.
    const typed = await h.core.orchestrator.runTurn(
      devin,
      session.id,
      { text: 'Where do we start?', mode: 'coach' },
      () => undefined,
    );
    expect(typed.status).toBe('completed');
    const again = await h.core.calls.start(devin, session.id, { inputMode: 'typed' });
    expect(again.intro?.text).toBe('Hi Devin, where would you like to pick up?');
    await h.core.calls.end(devin, again.call.id, { reason: 'user' });
  });
});

describe('the welcome that introduces the vEIR', () => {
  it('is stored with the person, once, and reported by /me', async () => {
    expect((await h.core.me.get(maya)).veirWelcomeAcknowledgedAt).toBeNull();
    const first = await h.core.me.acknowledgeVeirWelcome(maya);
    const again = await h.core.me.acknowledgeVeirWelcome(maya);
    expect(again).toEqual(first);
    expect((await h.core.me.get(maya)).veirWelcomeAcknowledgedAt).toBe(first.acknowledgedAt);
    const devin = await h.ctxFor(h.people.devin);
    expect((await h.core.me.get(devin)).veirWelcomeAcknowledgedAt).toBeNull();
  });
});
