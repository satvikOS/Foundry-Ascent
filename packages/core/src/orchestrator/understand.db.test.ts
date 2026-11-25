/**
 * The understand calls in a whole turn (docs/architecture/understand.md): a seeded database and the mock model. Off, a turn
 * makes the same calls, writes and events as without them; on, its three metered calls are made beside the query's embedding,
 * the step is shown once, after them, what came in time is used, and a late, failed or empty reading leaves the turn to its
 * rules.
 */
import {
  MockModelGateway,
  ModelUnavailableError,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMA_NAMES,
  UNDERSTAND_TIMEOUT_MS,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type UnderstandPart,
} from '@foundry/ai';
import { TurnStreamEvent, type TurnGuidance, type TurnView } from '@foundry/contracts';
import { p } from '@foundry/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { coreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { RecordingLogger } from '../testing/fakes.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

const ASK = 'What should I charge the two labs of our pilot for the lab kit box';

type Behaviour = 'answers' | 'hangs' | 'fails' | 'stops when told';

class ReadingGateway extends MockModelGateway {
  readonly requests: GenerateStructuredRequest<unknown>[] = [];
  readonly cancelled: UnderstandPart[] = [];
  behaviour: Partial<Record<UnderstandPart, Behaviour>> = {};
  every(behaviour: Behaviour): void {
    this.behaviour = { route: behaviour, sums: behaviour, judge: behaviour };
  }

  override generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const part = UNDERSTAND_PARTS.find((x) => UNDERSTAND_SCHEMA_NAMES[x] === request.schemaName);
    if (part === undefined) return super.generateStructured(request);
    this.requests.push(request);
    request.signal?.addEventListener('abort', () => this.cancelled.push(part), { once: true });
    switch (this.behaviour[part]) {
      case 'fails':
        return Promise.reject(new ModelUnavailableError('throttled', 'mock'));
      // A provider that does not even hear its cancellation.
      case 'hangs':
        return new Promise(() => undefined);
      case 'stops when told':
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              const error = new ModelUnavailableError('aborted', 'mock');
              error.attempts = [
                {
                  kind: 'initial',
                  modelId: 'mock-cut',
                  outcome: 'aborted',
                  latencyMs: 1,
                  usage: { inputTokens: 100, outputTokens: 0 },
                  costUsd: 0.0001,
                  errorName: 'AbortError',
                } as unknown as (typeof error.attempts)[number],
              ];
              reject(error);
            },
            { once: true },
          );
        });
      default:
        return super.generateStructured(request);
    }
  }
}
/** A cap the tests can wait for. */
const CAPS = { understandTypedMs: 600, understandVoiceMs: 600 };

let h: CoreHarness;
let priya: RequestContext;
let gateway: ReadingGateway;
let logger: RecordingLogger;

beforeAll(async () => {
  h = await createCoreHarness({ playbook: FIXTURE_PLAYBOOK });
  priya = await h.ctxFor(h.people.priya);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(() => {
  gateway = new ReadingGateway({ streamDelayMs: 0 });
  logger = new RecordingLogger();
});

const coreWith = (
  understand: boolean,
  over: {
    founderPath?: boolean;
    safetyScreen?: boolean;
    understandTypedMs?: number;
    understandVoiceMs?: number;
  } = {},
): Core =>
  createCore({
    db: h.t.db,
    gateway,
    config: coreConfig({ appEnv: 'test', turns: { founderPath: true, rateLimit: 500, understand, ...over } }),
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger,
    random: () => 0.99,
    playbook: FIXTURE_PLAYBOOK,
  });

interface Run {
  readonly names: string[];
  readonly guidance: TurnGuidance[];
  readonly turn: TurnView | null;
  readonly ledger: { readonly purpose: string; readonly usd: number }[];
  readonly read: Record<string, unknown> | null;
}

async function say(core: Core, text: string): Promise<Run> {
  const session = await core.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'ephemeral' });
  const events: TurnStreamEvent[] = [];
  const ctx = { ...priya, requestId: crypto.randomUUID() };
  await core.orchestrator.runTurn(ctx, session.id, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const rows = await h.t.db.system((sx) =>
    sx.query(`SELECT purpose, cost_usd FROM usage_ledger WHERE request_id = :rid ORDER BY id`, {
      rid: p.text(ctx.requestId),
    }),
  );
  const last = events.findLast((e) => e.event === 'turn.completed');
  return {
    names: events.map((e) => (e.event === 'turn.status' ? `${e.event}:${e.phase}` : e.event)),
    guidance: events.flatMap((e) => (e.event === 'turn.guidance' ? [e.guidance] : [])),
    turn: last?.event === 'turn.completed' ? last.turn : null,
    ledger: rows.rows.map((r) => ({ purpose: String(r.purpose), usd: Number(r.cost_usd) })),
    read: logger.records.findLast((r) => r.event === 'turn.understand')?.fields ?? null,
  };
}

const plain = (g: readonly TurnGuidance[]) =>
  g.map(({ step, ...rest }) => ({ ...rest, step: step?.playId ?? null }));

describe('off (the default)', () => {
  it('makes no call, writes nothing and sends the events it always did', async () => {
    const run = await say(coreWith(false), ASK);
    expect(gateway.requests).toEqual([]);
    expect(
      gateway.calls.some((c) => Object.values(UNDERSTAND_SCHEMA_NAMES).some((n) => n === c.schemaName)),
    ).toBe(false);
    expect(run.read).toBeNull();
    expect(run.guidance).toHaveLength(1);
    // The step a rule named is shown before anything is looked for.
    expect(run.names.indexOf('turn.guidance')).toBeLessThan(run.names.indexOf('turn.status:retrieving'));
    expect(run.ledger.filter((r) => r.purpose === 'turn')).toHaveLength(
      gateway.calls.filter((c) => c.purpose === 'turn').length,
    );
    expect(logger.records.some((r) => r.event === 'turn.path' && 'understood' in r.fields)).toBe(false);
  });

  it('nothing is read without the path, whatever the switch says', async () => {
    const run = await say(coreWith(true, { founderPath: false }), ASK);
    expect(gateway.requests).toEqual([]);
    expect(run.turn).not.toBeNull();
  });
});

describe('on', () => {
  it('reads the message once, in its parts at once, beside the embedding, and shows the step once, after it', async () => {
    const off = await say(coreWith(false), ASK);
    const run = await say(coreWith(true), ASK);
    expect(gateway.requests.map((r) => r.schemaName).sort()).toEqual(
      Object.values(UNDERSTAND_SCHEMA_NAMES).sort(),
    );
    for (const request of gateway.requests) {
      expect(request).toMatchObject({
        purpose: 'turn',
        route: 'understand',
        timeoutMs: UNDERSTAND_TIMEOUT_MS.text,
        estimateCut: true,
      });
      expect(request.promptCache?.systemChars).toBe(request.system.length);
      expect(request.messages[0]?.content).toContain(`<message>\n${ASK}\n</message>`);
    }
    expect(run.guidance).toHaveLength(1);
    expect(run.turn?.guidance).toEqual(run.guidance[0]);
    expect(run.names.indexOf('turn.guidance')).toBeGreaterThan(run.names.indexOf('turn.status:retrieving'));
    expect(run.names.indexOf('turn.guidance')).toBeLessThan(run.names.indexOf('turn.status:reasoning'));
    expect(run.names.filter((n) => n !== 'turn.guidance' && n !== 'turn.delta')).toEqual(
      off.names.filter((n) => n !== 'turn.guidance' && n !== 'turn.delta'),
    );
    expect(run.read).toMatchObject({
      code: 'ok',
      kind: 'question',
      purpose: 'turn',
      routeCode: 'ok',
      sumsCode: 'ok',
      judgeCode: 'ok',
    });
    for (const part of UNDERSTAND_PARTS) expect(typeof run.read?.[`${part}Ms`]).toBe('number');
    expect(logger.records.findLast((r) => r.event === 'turn.path')?.fields).toMatchObject({
      understood: true,
    });
  });

  it('is metered like every call: a row of the ledger each, which the caps count', async () => {
    const off = await say(coreWith(false), ASK);
    const run = await say(coreWith(true), ASK);
    const turns = (r: Run) => r.ledger.filter((x) => x.purpose === 'turn').length;
    expect(turns(run)).toBe(turns(off) + 3);
  });

  it('a part that was cut off is metered too', async () => {
    const off = await say(coreWith(false), ASK);
    gateway.behaviour = { judge: 'stops when told' };
    const run = await say(coreWith(true, CAPS), ASK);
    expect(run.read).toMatchObject({ code: 'partial', judgeCode: 'late' });
    const turns = (r: Run) => r.ledger.filter((x) => x.purpose === 'turn').length;
    expect(turns(run)).toBe(turns(off) + 3);
  });

  it('logs ids, codes and milliseconds, never words', async () => {
    const run = await say(coreWith(true), 'What should I charge for the zebra-striped lab kit box');
    expect(JSON.stringify(run.read)).not.toMatch(/zebra|striped|charge/i);
    expect(typeof run.read?.ms).toBe('number');
  });

  it('a failed reading leaves the turn to its rules', async () => {
    const off = await say(coreWith(false), ASK);
    gateway.every('fails');
    const run = await say(coreWith(true), ASK);
    expect(run.read).toMatchObject({ code: 'model_unavailable', routeCode: 'model_unavailable' });
    expect(plain(run.guidance)).toEqual(plain(off.guidance));
    expect(run.turn?.status).toBe('completed');
  });

  it('a reading that says nothing leaves it to them too', async () => {
    gateway = new ReadingGateway({
      streamDelayMs: 0,
      fixtures: Object.fromEntries(Object.values(UNDERSTAND_SCHEMA_NAMES).map((n) => [n, () => 'nothing'])),
    });
    const run = await say(coreWith(true), ASK);
    expect(run.read?.code).toBe('model_output_invalid');
    expect(run.guidance).toHaveLength(1);
  });

  it('uses the parts that came, and cancels the one that is late', async () => {
    gateway.behaviour = { judge: 'hangs' };
    const started = performance.now();
    const run = await say(coreWith(true), ASK);
    expect(run.read).toMatchObject({ code: 'partial', kind: 'question', routeCode: 'ok', judgeCode: 'late' });
    expect(gateway.cancelled).toEqual(expect.arrayContaining(['judge']));
    // The reply does not open on what JUDGE says of a question: it is not waited for to the end.
    expect(performance.now() - started).toBeLessThan(UNDERSTAND_TIMEOUT_MS.text);
    expect(run.turn?.status).toBe('completed');
  });

  it('waits for JUDGE to the end of the budget where the reply opens on it', async () => {
    gateway.behaviour = { judge: 'hangs' };
    const run = await say(coreWith(true, CAPS), 'Two labs paid us $40 each today, was that a good result?');
    expect(run.read).toMatchObject({ code: 'partial', judgeCode: 'late' });
    expect(Number(run.read?.ms)).toBeGreaterThanOrEqual(CAPS.understandTypedMs - 50);
  });

  it('SUMS that wrote a plan and no sum is asked once more, metered, and no more', async () => {
    const off = await say(coreWith(false), ASK);
    const plan = { q: 'what comes in', w: 'labs times the fee', n: ['labs=13@message'], s: [], m: null };
    gateway = new ReadingGateway({
      streamDelayMs: 0,
      fixtures: { [UNDERSTAND_SCHEMA_NAMES.sums]: () => plan },
    });
    const run = await say(coreWith(true), 'how much comes in if 13 labs pay $24 each?');
    const sums = gateway.requests.filter((r) => r.schemaName === UNDERSTAND_SCHEMA_NAMES.sums);
    expect(sums).toHaveLength(2);
    expect(sums[1]?.messages[0]?.content).toContain('write the sum in s');
    expect(sums[1]?.timeoutMs).toBeLessThan(UNDERSTAND_TIMEOUT_MS.text);
    expect(run.read).toMatchObject({ code: 'ok', sumsAgain: true, sums: 0 });
    const turns = (r: Run) => r.ledger.filter((x) => x.purpose === 'turn').length;
    expect(turns(run)).toBe(turns(off) + 4);
    gateway = new ReadingGateway({ streamDelayMs: 0 });
    const plain = await say(coreWith(true), 'how much comes in if 13 labs pay $24 each?');
    expect(plain.read).toMatchObject({ sumsAgain: false, sums: 1 });
    expect(gateway.requests).toHaveLength(3);
  });

  it('without ROUTE, what the others say of a figure stands', async () => {
    gateway.behaviour = { route: 'fails' };
    const run = await say(coreWith(true), 'how much comes in if 13 labs pay $24 each?');
    expect(run.read).toMatchObject({ code: 'partial', kind: 'sum', sums: 1, routeCode: 'model_unavailable' });
    expect(run.turn?.status).toBe('completed');
  });

  it('without ROUTE and nothing of theirs, it is none', async () => {
    gateway.behaviour = { route: 'fails' };
    const run = await say(coreWith(true), ASK);
    expect(run.read?.code).toBe('nothing_held');
    expect(run.turn?.status).toBe('completed');
  });

  it('a late one is not waited for beyond its budget', async () => {
    gateway.every('hangs');
    const started = performance.now();
    const run = await say(coreWith(true, CAPS), ASK);
    const took = performance.now() - started;
    expect(run.read).toMatchObject({ code: 'late', routeCode: 'late', sumsCode: 'late', judgeCode: 'late' });
    expect(took).toBeGreaterThanOrEqual(CAPS.understandTypedMs - 50);
    expect(took).toBeLessThan(CAPS.understandTypedMs + 2_500);
    expect(new Set(gateway.cancelled)).toEqual(new Set(UNDERSTAND_PARTS));
    expect(run.guidance).toHaveLength(1);
    expect(run.turn?.status).toBe('completed');
  }, 20_000);

  it.each(['hi there!', 'thanks so much, bye'])('%s is not read', async (text) => {
    const run = await say(coreWith(true), text);
    expect(gateway.requests).toEqual([]);
    expect(run.turn).not.toBeNull();
  });

  it('a crisis is not read', async () => {
    const run = await say(coreWith(true), 'I want to kill myself');
    expect(gateway.requests).toEqual([]);
    expect(run.names.at(-1)).toBe('turn.blocked');
  });

  it('a message the safety screen reads first is read after it, and a screened crisis never', async () => {
    const core = coreWith(true, { safetyScreen: true });
    const screened = await say(core, 'i dont want to be here anymore');
    expect(screened.names.at(-1)).toBe('turn.blocked');
    expect(gateway.requests).toEqual([]);
    const clear = await say(
      core,
      'I am thinking about ending it, the pilot with the agency. What should I charge instead?',
    );
    expect(gateway.requests).toHaveLength(3);
    expect(clear.turn).not.toBeNull();
  });
});
