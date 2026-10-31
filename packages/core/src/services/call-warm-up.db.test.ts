/**
 * The turn engine's warm-up (orchestrator/warm-up.ts) when a call starts and when the call screen opens: handed to the
 * host to run after the response, with the call's own guard names, and never in the way: a warm-up that throws,
 * rejects or never settles leaves the call starting exactly as before, with its greeting.
 */
import { MockModelGateway } from '@foundry/ai';
import { StartCallResponse } from '@foundry/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import type * as WarmUp from '../orchestrator/warm-up.js';
import { type TurnWarmUpGuards } from '../orchestrator/warm-up.js';
import { FakeSpeechSynthesizer, RecordingLogger } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';

type Behaviour = 'resolve' | 'reject' | 'throw' | 'hang';

/** What the mocked warm-up was called with, and what it does on its next calls. */
const warmUp = vi.hoisted(() => {
  const state: { calls: (TurnWarmUpGuards | undefined)[]; behaviour: Behaviour } = {
    calls: [],
    behaviour: 'resolve',
  };
  return state;
});

vi.mock('../orchestrator/warm-up.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WarmUp>();
  return {
    ...actual,
    warmTurnEngine: (guards?: TurnWarmUpGuards): Promise<void> => {
      warmUp.calls.push(guards);
      switch (warmUp.behaviour) {
        case 'resolve':
          return Promise.resolve();
        case 'reject':
          return Promise.reject(new Error('warm-up failed'));
        case 'throw':
          throw new Error('warm-up failed at once');
        case 'hang':
          return new Promise<void>(() => undefined);
      }
    },
  };
});

let h: CoreHarness;
let maya: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(() => {
  warmUp.calls.length = 0;
  warmUp.behaviour = 'resolve';
});

/** A core whose work after the response is collected (as the API host keeps it), with its own log. */
function coreWithHost(): { core: Core; after: Promise<unknown>[]; logger: RecordingLogger } {
  const after: Promise<unknown>[] = [];
  const logger = new RecordingLogger();
  const core = createCore({
    db: h.t.db,
    gateway: new MockModelGateway({ streamDelayMs: 0 }),
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger,
    speech: new FakeSpeechSynthesizer(),
    afterResponse: (task) => {
      after.push(task);
    },
  });
  return { core, after, logger };
}

async function startOn(core: Core): Promise<StartCallResponse> {
  const session = await h.core.sessions.create(maya, h.ventures.quietquad.id, {});
  return StartCallResponse.parse(await core.calls.start(maya, session.id, { inputMode: 'typed' }));
}

describe('warming the turn engine when a call starts', () => {
  it('runs after the greeting is ready, with the names the call’s turns are guarded with', async () => {
    const { core, after, logger } = coreWithHost();
    const started = await startOn(core);
    expect(started.intro).not.toBeNull();
    expect(after).toHaveLength(1);
    await after[0];
    expect(warmUp.calls).toHaveLength(1);
    const guards = warmUp.calls[0];
    expect(guards?.personaName).toEqual(expect.any(String));
    expect(guards?.personaName).not.toBe('');
    // The other ventures of the tenant, never the caller's own.
    expect(guards?.otherVentureNames).toContain(h.ventures.solesignal.name);
    expect(guards?.otherVentureNames).not.toContain(h.ventures.quietquad.name);
    expect(guards?.otherVentureCanaries).toContain(h.ventures.solesignal.canary);
    const logged = logger.records.find((r) => r.event === 'call.turn_warm_up');
    expect(logged?.fields.callId).toBe(started.call.id);
    expect(typeof logged?.fields.ms).toBe('number');
    await core.calls.end(maya, started.call.id, { reason: 'user' });
  });

  it.each(['reject', 'throw', 'hang'] as const)(
    'starts the call with its greeting all the same when the warm-up does %s',
    async (behaviour) => {
      warmUp.behaviour = behaviour;
      const { core, after, logger } = coreWithHost();
      const started = await startOn(core);
      expect(started.call.status).toBe('live');
      expect(started.intro?.text).toEqual(expect.any(String));
      expect(after).toHaveLength(1);
      if (behaviour !== 'hang') {
        // What the host keeps alive settles, and never rejects.
        await expect(after[0]).resolves.toBeUndefined();
        expect(logger.records.some((r) => r.event === 'call.turn_warm_up_failed')).toBe(true);
      }
      await vi.waitFor(() => {
        expect(warmUp.calls).toHaveLength(1);
      });
      await core.calls.end(maya, started.call.id, { reason: 'user' });
    },
  );
});

describe('warming the turn engine when the call screen opens', () => {
  it('hands the warm-up to the host after the call settings are read', async () => {
    const { core, after } = coreWithHost();
    const config = await core.veir.callConfig(maya, h.ventures.quietquad.id);
    expect(config.callsEnabled).toBe(true);
    expect(after).toHaveLength(1);
    await after[0];
    // Synthetic names: the call (and its guards) does not exist yet.
    expect(warmUp.calls).toEqual([undefined]);
  });

  it('answers the call settings all the same when the warm-up throws', async () => {
    warmUp.behaviour = 'throw';
    const { core } = coreWithHost();
    await expect(core.veir.callConfig(maya, h.ventures.quietquad.id)).resolves.toMatchObject({
      callsEnabled: true,
    });
  });
});
