/**
 * The reference library (the startup knowledge base, scope `public`) in real coaching turns: a passage only when the
 * founder's own message names its subject (never because the vEIR's last question or the venture goal did), and an
 * item cited once in a conversation is not shown again (coaching diagnosis C1: retrieval fixation).
 */
import { MockModelGateway } from '@foundry/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

let h: CoreHarness;
let maya: RequestContext;
let core: Core;

/** What the vEIR "says": a question that names a framework (unit economics, CAC payback). */
const COACH_QUESTION = 'Should we look at your unit economics and CAC payback first?';

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
  const gateway = new MockModelGateway({
    streamDelayMs: 0,
    streamFixture: (context) =>
      (context.messages.at(-1)?.content ?? '').includes('<continue_request>')
        ? 'Start with the number you trust most.'
        : COACH_QUESTION,
  });
  core = createCore({
    db: h.t.db,
    gateway,
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
  });
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

async function referenceTitles(sessionId: string, text: string): Promise<string[]> {
  const accepted = await core.orchestrator.runTurn(maya, sessionId, { text }, () => undefined);
  const evidence = await core.sessions.getTurnEvidence(maya, accepted.turnId ?? '');
  return evidence
    .filter((item) => item.source?.scope === 'public')
    .map((item) => item.title.split(' — ')[0] ?? '');
}

describe('reference library in coaching turns', () => {
  it('a short reply to a question that names a framework retrieves no reference', async () => {
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    // First turn: the vEIR answers with a question about unit economics.
    expect(await referenceTitles(session.id, 'We have 40 paying students and 3 cafés interested.')).toEqual(
      [],
    );
    // "yes" is read with that question for the program's guidance, but the library reads only the founder's words.
    expect(await referenceTitles(session.id, 'yes')).toEqual([]);
    // Asked in their own words, it is shown.
    expect(await referenceTitles(session.id, 'How do I calculate CAC payback for a subscription?')).toEqual([
      'Unit Economics: Contribution, CAC, LTV and Payback (framework)',
    ]);
  });

  it('an item cited in the conversation is not shown again in it, and is in a new one', async () => {
    const session = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    const dropbox = 'Dropbox: Turning a personal frustration into a reliable service';
    expect(await referenceTitles(session.id, 'How did Dropbox grow?')).toEqual([dropbox]);
    expect(await referenceTitles(session.id, 'What did Dropbox do with its referral program?')).toEqual([]);
    const fresh = await core.sessions.create(maya, h.ventures.quietquad.id, { mode: 'coach' });
    expect(await referenceTitles(fresh.id, 'What did Dropbox do with its referral program?')).toEqual([
      dropbox,
    ]);
  });
});
