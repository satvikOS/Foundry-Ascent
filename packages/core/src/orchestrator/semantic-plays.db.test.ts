/**
 * An ask no rule of the playbook names, matched by meaning in a whole turn: a seeded database, the mock model and a fake
 * embedding that says what each text is near to (deterministic; synthetic wording). The play it means is the turn's as
 * one a rule named would be; a late or failed embedding, the switch or a rule leaves the turn as it was; and no other
 * turn reads the asks or embeds anything more.
 */
import { MockModelGateway, type EmbedOptions, type EmbedResult } from '@foundry/ai';
import { TurnStreamEvent, type TurnGuidance, type TurnView } from '@foundry/contracts';
import { knowledgePack, knowledgeRepo, p, tagEmbedding } from '@foundry/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { coreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { playRefId } from './evidence.js';
import { PLAY_MATCH_WAIT_MS, playAsks } from '../path/semantic.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { TEST_MODEL } from '../path/testing/meaning.js';
import { RecordingLogger } from '../testing/fakes.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';

/** The direction each play lies in; a text is near what the test says of it. */
const AXES = FIXTURE_PLAYBOOK.plays.map((play) => play.id);
function vector(weights: Readonly<Record<string, number>>): number[] {
  const v = new Array<number>(knowledgeRepo.EMBEDDING_DIMENSIONS).fill(0);
  let used = 0;
  for (const [playId, weight] of Object.entries(weights)) {
    v[AXES.indexOf(playId)] = weight;
    used += weight * weight;
  }
  // The rest of a unit vector, along a direction no ask has.
  v[AXES.length] = Math.sqrt(Math.max(0, 1 - used));
  return v;
}

const STICKER = 'Which figure belongs on the sticker of our lab kit box, in your honest view of it all';
const LAWYERLY = 'Does anybody upstairs get a say in our lab kit box before it leaves the building with us';
const UNSURE = 'Is it odd that our lab kit box smells a little of oranges when it rains in November';
const SHORT = 'A figure for the sticker?';
const MEANS: Readonly<Record<string, readonly number[]>> = {
  [STICKER]: vector({ 'price-it': 0.95, 'unit-economics': 0.2 }),
  [SHORT]: vector({ 'price-it': 0.95, 'unit-economics': 0.2 }),
  [LAWYERLY]: vector({ 'who-owns-it': 0.55, 'price-it': 0.2 }),
  [UNSURE]: vector({ 'price-it': 0.3, 'unit-economics': 0.29 }),
};

class FakeEmbeddings extends MockModelGateway {
  readonly embedded: string[] = [];
  delayMs = 0;
  fails = false;
  override readonly info = { ...new MockModelGateway().info, embeddingsModelId: TEST_MODEL };

  override async embed(texts: readonly string[], _options: EmbedOptions): Promise<EmbedResult> {
    this.embedded.push(...texts);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.fails) throw new Error('embedding unavailable');
    return {
      vectors: texts.map((t) => [...(MEANS[t] ?? vector({}))]),
      modelId: TEST_MODEL,
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
    };
  }
}

let h: CoreHarness;
let priya: RequestContext;
let gateway: FakeEmbeddings;
let logger: RecordingLogger;

beforeAll(async () => {
  h = await createCoreHarness({ playbook: FIXTURE_PLAYBOOK });
  priya = await h.ctxFor(h.people.priya);
  await h.t.db.system(async (sx) => {
    await knowledgePack.syncPlayAsksToTenants(sx, playAsks(FIXTURE_PLAYBOOK));
    const rows = await sx.query(`SELECT id, locator FROM knowledge_chunks WHERE source_id = :id`, {
      id: p.uuid(knowledgePack.playAsksSourceId(h.seed.tenantId)),
    });
    await knowledgeRepo.setChunkEmbeddings(
      sx,
      rows.rows.map((r) => ({
        id: String(r.id),
        embedding: tagEmbedding(
          vector({ [String(r.locator).slice(knowledgePack.PLAY_ASK_LOCATOR.length)]: 1 }),
          TEST_MODEL,
        ),
      })),
    );
  });
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(() => {
  gateway = new FakeEmbeddings({ streamDelayMs: 0 });
  logger = new RecordingLogger();
});

const coreWith = (turns: { founderPath?: boolean; semanticPlays?: boolean } = {}): Core =>
  createCore({
    db: h.t.db,
    gateway,
    config: coreConfig({ appEnv: 'test', turns: { founderPath: true, rateLimit: 500, ...turns } }),
    objectStore: h.objectStore,
    jobQueue: h.jobQueue,
    logger,
    random: () => 0.99,
    playbook: FIXTURE_PLAYBOOK,
  });

interface Run {
  readonly names: string[];
  readonly guidance: TurnGuidance[];
  readonly turn: TurnView;
  readonly sessionId: string;
  readonly path: Record<string, unknown>;
}

async function say(core: Core, text: string, sessionId?: string): Promise<Run> {
  const session =
    sessionId ?? (await core.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'ephemeral' })).id;
  const events: TurnStreamEvent[] = [];
  await core.orchestrator.runTurn(priya, session, { text }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.findLast((e) => e.event === 'turn.completed');
  if (last?.event !== 'turn.completed') throw new Error(`not completed: ${JSON.stringify(events.at(-1))}`);
  const path = logger.records.findLast((r) => r.event === 'turn.path')?.fields ?? {};
  return {
    names: events.map((e) => (e.event === 'turn.status' ? `${e.event}:${e.phase}` : e.event)),
    guidance: events.flatMap((e) => (e.event === 'turn.guidance' ? [e.guidance] : [])),
    turn: last.turn,
    sessionId: session,
    path: { ...path },
  };
}

describe('a turn matched by meaning', () => {
  it('is answered with the play it means: shown once, before the reply, with the play as evidence', async () => {
    const core = coreWith();
    const run = await say(core, STICKER);
    expect(run.guidance).toHaveLength(1);
    expect(run.guidance[0]).toMatchObject({
      intent: 'pricing',
      playId: 'price-it',
      step: { playId: 'price-it' },
    });
    expect(run.turn.guidance).toEqual(run.guidance[0]);
    const at = (name: string) => run.names.indexOf(name);
    expect(at('turn.guidance')).toBeGreaterThan(at('turn.status:classifying'));
    expect(at('turn.guidance')).toBeLessThan(at('turn.status:reasoning'));
    expect(at('turn.guidance')).toBeLessThan(at('turn.delta'));
    expect(run.turn.evidence[0]?.refId).toBe(playRefId('price-it'));
    expect(run.path).toMatchObject({ intent: 'pricing', matched: 'semantic', playId: 'price-it' });
    expect(run.path.score).toBeCloseTo(0.95, 3);
    expect(String(run.path.nearest)).toMatch(/^price-it:0\.950,unit-economics:0\.200,[\w-]+:0\.000$/);
    // Ids and scores only.
    expect(JSON.stringify(run.path)).not.toContain('sticker');
    // One embedding: the search's own.
    expect(gateway.embedded).toEqual([STICKER]);
    // The same message, the same step; its embedding is not made again.
    const again = await say(core, STICKER);
    expect(again.guidance[0]?.step?.id).toBe(run.guidance[0]?.step?.id);
    expect(gateway.embedded).toEqual([STICKER]);
  });

  it('embeds the founder’s own words when the search’s query adds to them', async () => {
    const core = coreWith();
    const run = await say(core, SHORT);
    expect(run.guidance[0]).toMatchObject({ intent: 'pricing', playId: 'price-it' });
    expect(gateway.embedded).toContain(SHORT);
  });

  it('a referral play under the floor of one brings its person, and no answer', async () => {
    const run = await say(coreWith(), LAWYERLY);
    // Under the higher floor of a referral: no answer, and the person is named.
    expect(run.path).toMatchObject({ matched: null, intent: null });
    expect(run.guidance[0]?.referral?.who).toBe('The technology transfer office');
    expect(run.guidance[0]?.step?.playId).not.toBe('who-owns-it');
  });

  it('is the path’s own step when no play is near enough', async () => {
    const run = await say(coreWith(), UNSURE);
    const plain = await say(coreWith({ semanticPlays: false }), UNSURE);
    expect(run.path).toMatchObject({ matched: null, intent: null });
    expect(run.guidance).toEqual(plain.guidance);
    expect(plain.path.nearest).toBeUndefined();
  });
});

describe('what it never holds up', () => {
  it('a rule’s turn embeds its query once and compares nothing', async () => {
    const run = await say(coreWith(), 'What should I charge the two labs of our pilot for the lab kit box');
    expect(run.path).toMatchObject({ intent: 'pricing', matched: 'phrase', score: null });
    expect(run.path.nearest).toBeUndefined();
    expect(gateway.embedded).toHaveLength(1);
    expect(run.names.indexOf('turn.guidance')).toBeLessThan(run.names.indexOf('turn.status:retrieving'));
  });

  it('a late embedding leaves the turn to the rules, and the search still uses it', async () => {
    gateway.delayMs = PLAY_MATCH_WAIT_MS + 250;
    const core = coreWith();
    const run = await say(core, STICKER);
    expect(run.path).toMatchObject({ matched: null, nearest: 'none' });
    expect(run.guidance).toHaveLength(1);
    expect(run.guidance[0]?.playId).not.toBe('price-it');
    // It is there for the next time they ask.
    gateway.delayMs = 0;
    expect((await say(core, STICKER)).path).toMatchObject({ matched: 'semantic' });
  });

  it('a failed embedding leaves the turn to the rules', async () => {
    gateway.fails = true;
    const run = await say(coreWith(), STICKER);
    expect(run.path).toMatchObject({ matched: null, nearest: 'none' });
    expect(run.guidance).toHaveLength(1);
  });

  it('nor do the asks without a vector, or the switch', async () => {
    expect((await say(coreWith({ semanticPlays: false }), STICKER)).path).toMatchObject({ matched: null });
    await h.t.db.system((sx) =>
      sx.query(`UPDATE knowledge_sources SET status = 'withdrawn' WHERE id = :id`, {
        id: p.uuid(knowledgePack.playAsksSourceId(h.seed.tenantId)),
      }),
    );
    const run = await say(coreWith(), STICKER);
    expect(run.path).toMatchObject({ matched: null, nearest: 'none' });
    expect(run.guidance).toHaveLength(1);
  });
});

describe('a question nothing of the program answers', () => {
  it('is answered first, and the path’s step only stands: once in three turns, never as the answer', async () => {
    const core = coreWith();
    const ODD = [
      'Is it odd that the corridor smells of oranges on rainy November mornings?',
      'Which of the two lifts is slower when everybody leaves at noon?',
      'Why does the vending machine hum so loudly after ten at night?',
      'Does the green sofa upstairs belong to the choir or to the chess club?',
    ];
    const said: string[] = [];
    let sessionId: string | undefined;
    for (const text of ODD) {
      const run = await say(core, text, sessionId);
      sessionId = run.sessionId;
      expect(run.path, text).toMatchObject({ matched: null, intent: null });
      // The card under the reply is the path's own step, every time.
      expect(run.guidance[0]?.step, text).not.toBeNull();
      said.push(run.turn.response?.answer ?? '');
    }
    const standing = said.map((answer) => answer.includes('On your path, next is: '));
    expect(standing).toEqual([true, false, false, true]);
    for (const answer of said) expect(answer).not.toMatch(/^Next: |\nNext: |Done when/);
    for (const answer of said) expect(answer.split(/On your path/)[0]?.trim()).not.toBe('');
  });
});
