/**
 * Shared notes near the founder's own words in a whole turn: a seeded database, the mock model and a fake embedding that
 * says what each text is near to. A note no gate names is evidence of a turn that asks, of no other turn; what the reply
 * cites of it has to support its sentence; and the reranker, when there is one, only chooses.
 */
import {
  MockModelGateway,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type Reranker,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from '@foundry/ai';
import { TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { knowledgeRepo, p, tagEmbedding } from '@foundry/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { coreConfig } from '../config.js';
import { type RequestContext } from '../context.js';
import { createCore, type Core } from '../core.js';
import { FIXTURE_PLAYBOOK } from '../path/testing/fixture-playbook.js';
import { RecordingLogger } from '../testing/fakes.js';
import { createCoreHarness, type CoreHarness } from '../testing/harness.js';
import { RERANK_TIMEOUT_MS } from './retrieval.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
/** A unit vector at cosine `c` from the message's direction (or `axis`). */
function at(c: number, axis = 0): number[] {
  const v = new Array<number>(knowledgeRepo.EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = c;
  v[500] = Math.sqrt(1 - c * c);
  return v;
}

/** No topic of the corpus, no vocabulary and no phrase of the playbook names it. */
const ASK = 'How come the folks upstairs never sign off on our lab kit box?';
const FAR = 'How come the corridor smells of oranges on rainy November mornings?';
const LIBRARY = 'library:sba-structure';

class FakeGateway extends MockModelGateway {
  override readonly info = { ...new MockModelGateway().info, embeddingsModelId: TITAN };
  reranker?: Reranker;
  /** What the model says, instead of the mock's own words. */
  says: string | null = null;
  readonly prompts: string[] = [];

  override embed(texts: readonly string[], _options: EmbedOptions): Promise<EmbedResult> {
    return Promise.resolve({
      vectors: texts.map((text) => (text.includes('oranges') ? at(1, 7) : at(1))),
      modelId: TITAN,
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
    });
  }

  override async streamText(request: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
    this.prompts.push(`${request.system}\n${request.messages.map((m) => m.content).join('\n')}`);
    const { says } = this;
    if (says === null) return super.streamText(request, onText);
    let given = false;
    const result = await super.streamText(request, async () => {
      if (given) return;
      given = true;
      await onText(says);
    });
    return { ...result, text: says };
  }

  override generateStructured<T>(request: GenerateStructuredRequest<T>) {
    return super.generateStructured(request);
  }
}

let h: CoreHarness;
let priya: RequestContext;
let gateway: FakeGateway;
let logger: RecordingLogger;
/** The near note's passage, and one a little further. */
let nearId = '';
let otherId = '';
/** A passage of the reference library, which no gate brings to these messages. */
let caseId = '';

beforeAll(async () => {
  h = await createCoreHarness({ playbook: FIXTURE_PLAYBOOK });
  priya = await h.ctxFor(h.people.priya);
  await h.t.db.system(async (sx) => {
    const chunk = async (uri: string, ordinal: number): Promise<string> => {
      const r = await sx.query(
        `SELECT c.id FROM knowledge_chunks c JOIN knowledge_sources s ON s.id = c.source_id
         WHERE s.uri = :uri AND s.tenant_id = :t AND c.ordinal = :n`,
        { uri: p.text(uri), t: p.uuid(h.seed.tenantId), n: p.int(ordinal) },
      );
      return String(r.rows[0]?.id);
    };
    nearId = await chunk(LIBRARY, 2);
    otherId = await chunk('library:irs-ein', 1);
    caseId = await chunk('urn:foundry:startup-knowledge-base:case/SC23', 1);
    await knowledgeRepo.setChunkEmbeddings(sx, [
      { id: caseId, embedding: tagEmbedding(at(0.48), TITAN) },
      { id: nearId, embedding: tagEmbedding(at(0.5), TITAN) },
      { id: otherId, embedding: tagEmbedding(at(0.3), TITAN) },
    ]);
  });
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});
beforeEach(() => {
  gateway = new FakeGateway({ streamDelayMs: 0 });
  logger = new RecordingLogger();
});

const coreWith = (turns: { semanticNotes?: boolean; rerank?: boolean } = {}): Core =>
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

async function say(
  core: Core,
  text: string,
  extra: { mode?: 'rehearse' } = {},
  sessionId?: string,
): Promise<{ turn: TurnView; sessionId: string }> {
  const session =
    sessionId ?? (await core.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'ephemeral' })).id;
  const events: TurnStreamEvent[] = [];
  await core.orchestrator.runTurn(priya, session, { text, ...extra }, (e) => {
    events.push(TurnStreamEvent.parse(e));
  });
  const last = events.findLast((e) => e.event === 'turn.completed');
  if (last?.event !== 'turn.completed') throw new Error(`not completed: ${JSON.stringify(events.at(-1))}`);
  return { turn: last.turn, sessionId: session };
}
const refs = (turn: TurnView): string[] => turn.evidence.map((e) => e.refId);

describe('a turn that asks', () => {
  it('is shown the note near its words, by no gate, and none without the switch', async () => {
    const { turn } = await say(coreWith(), ASK);
    expect(refs(turn)).toContain(nearId);
    const item = turn.evidence.find((e) => e.refId === nearId);
    expect(item?.citation).toMatchObject({ kind: 'passage' });
    expect(refs(turn)).toContain(caseId);
    expect(refs((await say(coreWith({ semanticNotes: false }), ASK)).turn)).not.toContain(caseId);
  });

  it('gets nothing when no note is near it', async () => {
    const { turn } = await say(coreWith(), FAR);
    expect(refs(turn)).not.toContain(nearId);
    expect(refs(turn)).not.toContain(otherId);
  });
});

describe('a turn that asks nothing of the kind', () => {
  it('gets none: courtesy, a rehearsal, what was said before, what they did', async () => {
    const core = coreWith();
    const { sessionId } = await say(core, ASK);
    for (const [text, extra] of [
      ['Thanks so much, talk to you tomorrow', {}],
      ['You are the buyer: tell me why you will not sign for our lab kit box', { mode: 'rehearse' as const }],
      ['What did we speak about last time?', {}],
      ['I emailed four labs about the lab kit box today.', {}],
    ] as const) {
      const { turn } = await say(core, text, extra, sessionId);
      expect(refs(turn), text).not.toContain(nearId);
    }
  });

  it('gets none when someone may be in danger', async () => {
    const events: TurnStreamEvent[] = [];
    const core = coreWith();
    const session = await core.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'ephemeral' });
    await core.orchestrator.runTurn(
      priya,
      session.id,
      { text: 'I want to kill myself, how do I tell them upstairs?' },
      (e) => {
        events.push(TurnStreamEvent.parse(e));
      },
    );
    expect(JSON.stringify(events)).not.toContain(nearId);
    expect(gateway.prompts).toEqual([]);
  });
});

describe('what the reply cites of it', () => {
  const keyOf = (turn: TurnView): string => turn.evidence.find((e) => e.refId === nearId)?.key ?? 'none';

  it('has to support its sentence: an irrelevant note’s marker goes', async () => {
    const core = coreWith();
    const key = keyOf((await say(core, ASK)).turn);
    gateway.says = `Ask the dean's assistant who reads the request first, and bring one page about the box [${key}].`;
    const { turn } = await say(core, ASK);
    expect(turn.response?.answer).toContain('dean');
    expect(turn.response?.answer).not.toContain(`[${key}]`);
  });

  it('stands when it does', async () => {
    const core = coreWith();
    const first = (await say(core, ASK)).turn;
    const note = first.evidence.find((e) => e.refId === nearId);
    const sentence = (note?.excerpt ?? '').split(/(?<=\.)\s/)[0] ?? '';
    expect(sentence.length).toBeGreaterThan(20);
    gateway.says = `${sentence.replace(/\.$/, '')} [${keyOf(first)}].`;
    const { turn } = await say(core, ASK);
    expect(turn.response?.answer).toContain(`[${keyOf(first)}]`);
  });
});

describe('the reranker', () => {
  const fake = (rerank: Reranker['rerank']): Reranker & { asked: string[][] } => {
    const asked: string[][] = [];
    return {
      asked,
      modelId: 'amazon.rerank-v1:0',
      costUsd: () => 0.001,
      rerank: (query: string, documents: readonly string[], signal: AbortSignal) => {
        asked.push([query, ...documents]);
        return rerank(query, documents, signal);
      },
    };
  };
  const billed = async (): Promise<number> => {
    const r = await h.t.db.system((sx) =>
      sx.query(`SELECT count(*)::int AS n FROM usage_ledger WHERE model_id = 'amazon.rerank-v1:0'`),
    );
    return Number(r.rows[0]?.n);
  };

  it('is off unless the switch and the gateway have it, and never on a call', async () => {
    const reranker = fake(() => Promise.resolve([]));
    gateway.reranker = reranker;
    await say(coreWith(), ASK);
    expect(reranker.asked).toEqual([]);
    const core = coreWith({ rerank: true });
    const session = await core.sessions.create(priya, h.ventures.benchtally.id, { privacy: 'ephemeral' });
    await core.orchestrator.runTurn(priya, session.id, { text: ASK, channel: 'voice' }, () => undefined);
    expect(reranker.asked).toEqual([]);
  });

  it('chooses among the notes near their words, and is metered', async () => {
    const before = await billed();
    const reranker = fake((_q: string, documents: readonly string[]) =>
      Promise.resolve(documents.map((d) => (d.includes('EIN') ? 0.9 : 0.1))),
    );
    gateway.reranker = reranker;
    const { turn } = await say(coreWith({ rerank: true }), ASK);
    expect(reranker.asked).toHaveLength(1);
    expect(reranker.asked[0]?.[0]).toBe(ASK);
    expect(refs(turn)).toContain(otherId);
    expect(refs(turn)).not.toContain(nearId);
    expect(await billed()).toBe(before + 1);
  });

  it('that is late or fails leaves the choice to the similarity', async () => {
    for (const rerank of [
      () => Promise.reject(new Error('down')),
      () => new Promise<readonly number[]>((resolve) => setTimeout(resolve, RERANK_TIMEOUT_MS * 4, [])),
    ]) {
      gateway.reranker = fake(rerank);
      const { turn } = await say(coreWith({ rerank: true }), ASK);
      expect(refs(turn)).toContain(nearId);
    }
  });
});

/** Last: it takes the venture's own record away, so the notes are the turn's first evidence. */
describe('a note that is the first evidence of a turn', () => {
  it('is not cited by the mock, which cites whatever comes first', async () => {
    await h.t.db.system(async (sx) => {
      const venture = { v: p.uuid(h.ventures.benchtally.id) };
      await sx.query(`UPDATE memory_objects SET status = 'rejected' WHERE venture_id = :v`, venture);
      await sx.query(`DELETE FROM knowledge_chunks WHERE venture_id = :v`, venture);
    });
    const { turn } = await say(coreWith(), ASK);
    expect(turn.evidence[0]?.refId).toBe(nearId);
    expect(turn.response?.answer.length).toBeGreaterThan(20);
    expect(turn.response?.answer).not.toMatch(/\[E\d+\]/);
  });
});
