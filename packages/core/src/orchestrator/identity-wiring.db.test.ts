/**
 * The identity checks as the turn engine wires them: the founder's team are the people a reply may address
 * ("Thanks, Ruth." to a team member called Ruth is not an EIR's sign-off), and on a call every streamed unit is
 * checked as speech before it is said (an EIR's name counts in any case there). Its own database: the tests
 * add a team member named like an EIR.
 */
import { MockModelGateway } from '@foundry/ai';
import { TurnStreamEvent } from '@foundry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { resolveDeps } from '../deps.js';
import { DirectoryCache } from '../internal/directory.js';
import { Kit } from '../internal/kit.js';
import { type VoiceTurnAdmission } from '../services/call-admission.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { createOrchestrator, type RunTurnInput, type RunTurnOutcome } from './run-turn.js';

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

const CALL_ID = '77777777-7777-4777-8777-777777777777';

/** A core whose model streams `reply`, and its orchestrator with call admission stubbed (no call needed). */
function streaming(reply: string): { run: (input: RunTurnInput) => Promise<Run> } {
  const deps = {
    db: h.t.db,
    gateway: new MockModelGateway({ streamDelayMs: 0, streamFixture: () => reply }),
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger: h.logger,
  };
  const kit = new Kit(resolveDeps(deps));
  const admitted: VoiceTurnAdmission[] = [];
  const orchestrator = createOrchestrator(kit, new DirectoryCache(kit), {
    admitVoiceTurn: (_scope, admission) => {
      admitted.push(admission);
      return Promise.resolve();
    },
  });
  const core = createCore(deps);
  return {
    run: async (input) => {
      const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
      const events: TurnStreamEvent[] = [];
      const outcome = await orchestrator.runTurn(maya, session.id, input, (e) => {
        events.push(TurnStreamEvent.parse(e));
      });
      return { events, outcome };
    },
  };
}

interface Run {
  events: TurnStreamEvent[];
  outcome: RunTurnOutcome;
}

const said = (events: readonly TurnStreamEvent[]): string =>
  events
    .flatMap((e) => (e.event === 'turn.speech' ? [e.text] : []))
    .join(' ')
    .toLowerCase();

describe('identity checks in the turn engine', () => {
  it('stops a spoken unit that names the EIR in lower case before it is said, while typed text allows it', async () => {
    const reply = 'Start with the door counts. corin here, by the way. Then count seats for a week.';
    const voice = await streaming(reply).run({
      text: 'Where do we start?',
      mode: 'coach',
      channel: 'voice',
      callId: CALL_ID,
    });
    expect(voice.outcome.status).toBe('blocked');
    expect(voice.events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'identity' });
    expect(said(voice.events)).not.toContain('corin here');

    // In typed text a lower-case "corin" is not read as the name, as the validator decides it.
    const typed = await streaming(reply).run({ text: 'Where do we start?', mode: 'coach' });
    expect(typed.outcome.status).toBe('completed');
  });

  it('reads "Thanks, Ruth." as addressing a team member called Ruth, and as an EIR signing off otherwise', async () => {
    const reply = 'Good progress on the interviews this week. Thanks, Ruth.';
    const before = await streaming(reply).run({ text: 'We finished the interviews.', mode: 'coach' });
    expect(before.outcome.status).toBe('blocked');
    expect(before.events.at(-1)).toMatchObject({ event: 'turn.blocked', reason: 'identity' });

    await h.core.team.invite(lead, h.ventures.quietquad.id, { displayName: 'Ruth Miller', role: 'team' });
    const after = await streaming(reply).run({ text: 'We finished the interviews.', mode: 'coach' });
    expect(after.outcome.status).toBe('completed');
    const completed = after.events.at(-1);
    if (completed?.event !== 'turn.completed') throw new Error('expected turn.completed');
    expect(completed.turn.response?.answer).toContain('Thanks, Ruth.');
    expect(completed.turn.validator?.identityViolation).toBe(false);
  });
});
