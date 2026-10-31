/**
 * A turn's conversation context read beside its checks (orchestrator/turn-context.ts): the persona's presence, the
 * founder, the vEIR's notes, the earlier conversations and the venture, started in a transaction of their own when the
 * process knows the conversation's keys (its call started here, or an earlier turn ran here).
 *
 * - The prompt is byte for byte what the same turn is told when everything is read in the preflight.
 * - Nothing is cached but the keys: a note written between two turns of a call is in the next turn's prompt.
 * - Keys that no longer match fall back to reading in the preflight; a call's start fills the keys, so its first turn
 *   uses the early reads.
 */
import { MockModelGateway, type MockGenerateContext } from '@foundry/ai';
import { StartCallResponse, TurnStreamEvent } from '@foundry/contracts';
import { type Db, notebooksRepo, p } from '@foundry/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RequestContext } from '../context.js';
import { createCore } from '../core.js';
import { resolveDeps } from '../deps.js';
import { DirectoryCache } from '../internal/directory.js';
import { Kit } from '../internal/kit.js';
import { FakeSpeechSynthesizer, RecordingLogger } from '../testing/fakes.js';
import { type CoreHarness, createCoreHarness } from '../testing/harness.js';
import { createOrchestrator, type Orchestrator } from './run-turn.js';
import { TurnContextKeyring, type TurnContextKeys } from './turn-context.js';

let h: CoreHarness;
let maya: RequestContext;

beforeAll(async () => {
  h = await createCoreHarness();
  maya = await h.ctxFor(h.people.maya);
}, 180_000);

afterAll(async () => {
  await h.cleanup();
});

/** What the model was told on a turn's streamed reply: its system prompt and messages, byte for byte. */
type Told = string;

interface Rig {
  readonly orchestrator: Orchestrator;
  readonly keyring: TurnContextKeyring;
  readonly logger: RecordingLogger;
  readonly told: Told[];
}

/**
 * An orchestrator on the shared database with its own keyring. `fail`: the model call fails once the prompt is seen,
 * so the turn completes nothing (the conversation stays as it was for the next run).
 */
function rig(options: { readonly fail: boolean; readonly db?: Db }): Rig {
  const told: Told[] = [];
  const capture = (context: MockGenerateContext): string => {
    // The reply written anew after the gate leaves a sentence out is not the turn's prompt.
    const last = context.messages.at(-1)?.content ?? '';
    if (!last.includes('<continue_request>')) told.push(JSON.stringify([context.system, context.messages]));
    if (options.fail) throw new Error('model unavailable (test)');
    return 'Start with the riskiest assumption. What would prove it wrong in two weeks?';
  };
  const logger = new RecordingLogger();
  const deps = {
    db: options.db ?? h.t.db,
    gateway: new MockModelGateway({
      streamDelayMs: 0,
      streamFixture: capture,
      ...(options.fail
        ? {
            fixtures: {
              CoachResponse: () => {
                throw new Error('model unavailable (test)');
              },
            },
          }
        : {}),
    }),
    config: h.config,
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger,
  };
  const kit = new Kit(resolveDeps(deps));
  const keyring = new TurnContextKeyring();
  const orchestrator = createOrchestrator(kit, new DirectoryCache(kit), { turnContexts: keyring });
  return { orchestrator, keyring, logger, told };
}

/**
 * A new conversation on QuietQuad. Each new conversation is offered its own opener; the two arms of a comparison run
 * on two of them, so they open with none.
 */
async function newConversation(): Promise<string> {
  const id = (await h.core.sessions.create(maya, h.ventures.quietquad.id, {})).id;
  await h.t.db.system((sx) =>
    sx.query('UPDATE coaching_sessions SET opener = NULL WHERE id = :id', { id: p.uuid(id) }),
  );
  return id;
}

async function say(
  r: Rig,
  sessionId: string,
  text: string,
  call?: string,
): Promise<{ last: TurnStreamEvent | undefined; source: unknown }> {
  const events: TurnStreamEvent[] = [];
  await r.orchestrator.runTurn(
    maya,
    sessionId,
    call === undefined ? { text } : { text, channel: 'voice', callId: call },
    (e) => {
      events.push(TurnStreamEvent.parse(e));
    },
  );
  const source = r.logger.records.filter((x) => x.event === 'turn.context').at(-1)?.fields.source;
  return { last: events.at(-1), source };
}

/** The keys a turn of `sessionId` resolves to (read from a preflight that ran on a throwaway conversation). */
async function keysFor(sessionId: string): Promise<TurnContextKeys> {
  const probe = rig({ fail: true });
  const other = await newConversation();
  await say(probe, other, 'Where do we start?');
  const keys = probe.keyring.get(maya.tenantId, maya.principalId, other);
  if (keys === null) throw new Error('the preflight remembered no keys');
  return { ...keys, sessionId };
}

/** The prompt with the conversation's own id made neutral (the two arms run on two new, identical conversations). */
function neutral(told: Told | undefined, sessionId: string): string {
  return (told ?? '').replaceAll(sessionId, '<session>');
}

describe('the conversation context read beside the turn’s checks', () => {
  it('tells the model byte for byte what reading it in the preflight does', async () => {
    const text = 'We interviewed twelve customers this week. What should we test first?';
    const early = rig({ fail: true });
    const inline = rig({ fail: true });
    const first = await newConversation();
    const second = await newConversation();
    early.keyring.remember(await keysFor(first));

    const a = await say(early, first, text);
    const b = await say(inline, second, text);
    // The arms differ in how the context was read, and in nothing the model is told.
    expect(a.source).toBe('prefetched');
    expect(b.source).toBe('read');
    expect(a.last?.event).toBe('turn.error');
    expect(early.told).toHaveLength(1);
    expect(inline.told).toHaveLength(1);
    expect(neutral(early.told[0], first)).toBe(neutral(inline.told[0], second));
    // The context is there to compare: the venture and its vEIR's notes.
    expect(early.told[0]).toContain(h.ventures.quietquad.name);
  });

  it('reads a note written between two turns of the same conversation in the next turn', async () => {
    const r = rig({ fail: false });
    const sessionId = await newConversation();
    const one = await say(r, sessionId, 'Where do we start?');
    expect(one.last?.event).toBe('turn.completed');
    expect(one.source).toBe('read');

    const marker = 'Weekly pilot review moved to Thursdays with the hospital champion';
    await h.t.db.system(async (sx) => {
      const key = { ventureId: h.ventures.quietquad.id, personaId: h.ventures.quietquad.personaId };
      const current = await notebooksRepo.getNotebook(sx, key);
      const saved = await notebooksRepo.saveNotebook(sx, {
        tenantId: h.seed.tenantId,
        ...key,
        expectedVersion: current?.version ?? 0,
        content: { ...(current?.content ?? notebooksRepo.EMPTY_NOTEBOOK), summary: `${marker}.` },
        suppressed: current?.suppressed ?? [],
        editedBy: 'veir',
      });
      if (saved === null) throw new Error('the notebook changed meanwhile');
    });

    const two = await say(r, sessionId, 'And after that?');
    expect(two.last?.event).toBe('turn.completed');
    expect(two.source).toBe('prefetched');
    expect(r.told.at(-2)).not.toContain(marker);
    expect(r.told.at(-1)).toContain(marker);
  });

  it('reads the context in the preflight when the remembered keys no longer match', async () => {
    const text = 'How should we price the pilot?';
    const stale = rig({ fail: true });
    const inline = rig({ fail: true });
    const first = await newConversation();
    const second = await newConversation();
    // Another vEIR's keys: what the turn's own checks resolve to wins.
    stale.keyring.remember({ ...(await keysFor(first)), personaId: '00000000-0000-4000-8000-00000000c0de' });

    const a = await say(stale, first, text);
    const b = await say(inline, second, text);
    expect(a.source).toBe('keys_changed');
    expect(b.source).toBe('read');
    expect(neutral(stale.told[0], first)).toBe(neutral(inline.told[0], second));
    // And the turn's keys are what is remembered now.
    expect(stale.keyring.get(maya.tenantId, maya.principalId, first)?.personaId).toBe(
      h.ventures.quietquad.personaId,
    );
  });

  it('reads the context itself when the prefetch fails, and the turn goes on', async () => {
    const text = 'What should the pilot prove?';
    // The turn's first transaction is its prefetch: that one fails.
    let failNext = false;
    const db: Db = {
      driver: h.t.db.driver,
      withContext: (ctx, fn) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('connection reset (test)'));
        }
        return h.t.db.withContext(ctx, fn);
      },
      system: (fn, opts) => h.t.db.system(fn, opts),
      ping: (opts) => h.t.db.ping(opts),
      close: () => Promise.resolve(),
    };
    const failing = rig({ fail: true, db });
    const inline = rig({ fail: true });
    const first = await newConversation();
    const second = await newConversation();
    failing.keyring.remember(await keysFor(first));

    failNext = true;
    const a = await say(failing, first, text);
    const b = await say(inline, second, text);
    expect(failNext).toBe(false);
    expect(a.source).toBe('prefetch_failed');
    expect(b.source).toBe('read');
    expect(neutral(failing.told[0], first)).toBe(neutral(inline.told[0], second));
  });
});

describe('a call’s start', () => {
  it('fills the keys, so the call’s first turn reads its context beside its checks', async () => {
    const logger = new RecordingLogger();
    const core = createCore({
      db: h.t.db,
      gateway: new MockModelGateway({ streamDelayMs: 0 }),
      config: h.config,
      objectStore: h.objectStore,
      jobQueue: h.jobQueue,
      logger,
      speech: new FakeSpeechSynthesizer(),
    });
    const sessionId = await newConversation();
    const started = StartCallResponse.parse(await core.calls.start(maya, sessionId, { inputMode: 'typed' }));
    try {
      const events: TurnStreamEvent[] = [];
      await core.orchestrator.runTurn(
        maya,
        sessionId,
        { text: 'Can we go over the pilot?', channel: 'voice', callId: started.call.id },
        (e) => {
          events.push(TurnStreamEvent.parse(e));
        },
      );
      expect(events.at(-1)?.event).toBe('turn.completed');
      expect(logger.records.find((r) => r.event === 'turn.context')?.fields.source).toBe('prefetched');
    } finally {
      await core.calls.end(maya, started.call.id, { reason: 'user' });
    }
  });
});
