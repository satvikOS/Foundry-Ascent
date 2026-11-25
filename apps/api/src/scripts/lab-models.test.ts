import {
  MockModelGateway,
  createModelGateway,
  type InvokeModelFn,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from '@foundry/ai';
import { PLAYBOOK } from '@foundry/core';
import { benchmarkPassages, benchmarkQueries } from '@foundry/db/retrieval-benchmark';
import { describe, expect, it } from 'vitest';

import { FOUNDER_MESSAGES, benchmarkMessages, benchmarkSystemPrompt } from './lab-models-prompt.js';
import {
  Budget,
  MAX_BUDGET_USD,
  UsageError,
  failureCode,
  failureMessage,
  loadCandidates,
  maskAws,
  mockClients,
  parseArgs,
  reasoningWorstUsd,
  runModelsBenchmark,
  type Candidates,
  type Clients,
} from './lab-models.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
const LUNA = 'us.openai.gpt-6-luna';
const CANDIDATES: Candidates = {
  reasoning: [
    { id: LUNA, efforts: ['none', 'low'] },
    { id: 'us.amazon.nova-2-lite-v1:0', efforts: [] },
  ],
  embeddings: [
    { id: TITAN, dimensions: [256, 1024] },
    { id: 'us.cohere.embed-v4:0', dimensions: [1024] },
  ],
  rerankers: [
    { id: 'cohere.rerank-v3-5:0', region: 'us-east-1', usdPerThousandQueries: 2 },
    { id: 'amazon.rerank-v1:0', region: 'us-west-2', usdPerThousandQueries: 1 },
  ],
};
const OPTIONS = { region: 'us-east-1', budgetUsd: 2, requests: 2, structured: 2, rerankQueries: 20 };

/** The mock clients without the mock's streaming delays. */
function clients(change: Partial<Clients> = {}): Clients {
  const gateway = new MockModelGateway({ streamDelayMs: 0 });
  return { ...mockClients(), gateway: () => gateway, ...change };
}

const awsError = (name: string): Error =>
  Object.assign(new Error('arn:aws:bedrock:us-east-1:123456789012:secret'), { name });

describe('lab-models (offline, on the mock)', () => {
  it('measures every candidate, and prints ids, codes and numbers only', async () => {
    const { report, private: kept } = await runModelsBenchmark(clients(), CANDIDATES, OPTIONS);
    expect(report.access.map((a) => [a.kind, a.ok, a.code])).toEqual([
      ['reasoning', true, null],
      ['reasoning', true, null],
      ['embedding', true, null],
      ['embedding', true, null],
      ['rerank', true, null],
      ['rerank', true, null],
    ]);
    expect(report.reasoning.map((r) => [r.id, r.effort, r.requests, r.failures])).toEqual([
      [LUNA, 'none', 2, 0],
      [LUNA, 'low', 2, 0],
      ['us.amazon.nova-2-lite-v1:0', null, 2, 0],
    ]);
    for (const r of report.reasoning) {
      expect(r.firstTokenMs.p50).not.toBeNull();
      expect(r.structured).toMatchObject({ requests: 2, validFirst: 2, failed: 0 });
    }
    expect(report.embeddings.map((e) => [e.id, e.dimensions, e.code, e.tokensReported])).toEqual([
      [TITAN, 256, null, true],
      [TITAN, 1024, null, true],
      ['us.cohere.embed-v4:0', 1024, null, false],
    ]);
    expect(report.lexical.answerable).toBe(report.corpus.answerable);
    for (const e of report.embeddings) {
      expect(e.vector?.answerable).toBe(report.corpus.answerable);
      expect(e.hybrid?.recallAt20 ?? 0).toBeGreaterThan(0);
      expect(e.hybrid?.noAnswerAuc).toBeNull();
    }
    expect(report.rerank.base).not.toBeNull();
    expect(report.rerank.models.map((m) => [m.id, m.code, m.quality === null])).toEqual([
      ['cohere.rerank-v3-5:0', null, false],
      ['amazon.rerank-v1:0', null, false],
    ]);
    // 2 probes and 2 x 20 questions, per query: 2 and 1 dollars per thousand.
    expect(report.costUsd.rerank).toBeCloseTo(21 * 0.002 + 21 * 0.001, 9);
    expect(report.budgetReached).toBe(false);
    // Without a database production's search is not measured.
    expect(report.search).toEqual([]);

    const printed = JSON.stringify(report);
    for (const q of benchmarkQueries()) expect(printed).not.toContain(q.query);
    for (const p of benchmarkPassages(PLAYBOOK.plays)) expect(printed).not.toContain(p.text.slice(0, 60));
    for (const r of kept.replies) expect(printed).not.toContain(r.text.slice(0, 40));
    expect(kept.replies).toHaveLength(6);
  });

  it('reports a candidate the account may not call by its AWS code, and measures the others', async () => {
    const invoke =
      (region: string): InvokeModelFn =>
      (input, signal) => {
        if (input.modelId.includes('cohere.embed')) return Promise.reject(awsError('AccessDeniedException'));
        if (region === 'us-west-2') return Promise.reject(awsError('ResourceNotFoundException'));
        return mockClients().invoke(region)(input, signal);
      };
    const denied = new MockModelGateway({ streamDelayMs: 0 });
    denied.streamText = () => Promise.reject(awsError('AccessDeniedException'));
    const ok = new MockModelGateway({ streamDelayMs: 0 });
    const { report, private: kept } = await runModelsBenchmark(
      clients({ invoke, gateway: (id) => (id === LUNA ? denied : ok) }),
      CANDIDATES,
      OPTIONS,
    );
    expect(Object.fromEntries(report.access.map((a) => [a.id, a.code]))).toEqual({
      [LUNA]: 'AccessDeniedException',
      'us.amazon.nova-2-lite-v1:0': null,
      [TITAN]: null,
      'us.cohere.embed-v4:0': 'AccessDeniedException',
      'cohere.rerank-v3-5:0': null,
      'amazon.rerank-v1:0': 'ResourceNotFoundException',
    });
    expect(report.reasoning.map((r) => r.id)).toEqual(['us.amazon.nova-2-lite-v1:0']);
    expect(report.embeddings.map((e) => e.id)).toEqual([TITAN, TITAN]);
    expect(report.rerank.models.map((m) => m.id)).toEqual(['cohere.rerank-v3-5:0']);
    expect(JSON.stringify(report)).not.toMatch(/arn:|123456789012/);
    // What AWS said is kept for the sealed report only, the account masked; nothing a refusal says is printed.
    expect(kept.refusals).toContainEqual({
      part: 'access',
      id: 'us.cohere.embed-v4:0',
      code: 'AccessDeniedException',
      httpStatus: null,
      message: 'arn:aws:bedrock:us-east-1:<account>:secret',
    });
    expect(kept.refusals.map((r) => r.id)).toEqual([LUNA, 'us.cohere.embed-v4:0', 'amazon.rerank-v1:0']);
    expect(JSON.stringify(kept)).not.toContain('123456789012');
    expect(JSON.stringify(report)).not.toContain('<account>');
  });

  it('reports a model that fails half way, ungraded, without stopping the run', async () => {
    let calls = 0;
    const invoke =
      (region: string): InvokeModelFn =>
      (input, signal) => {
        if (input.modelId === TITAN && (calls += 1) > 60)
          return Promise.reject(awsError('ThrottlingException'));
        return mockClients().invoke(region)(input, signal);
      };
    const { report } = await runModelsBenchmark(
      clients({ invoke }),
      { ...CANDIDATES, reasoning: [] },
      OPTIONS,
    );
    expect(report.embeddings.map((e) => [e.id, e.code, e.vector === null])).toEqual([
      [TITAN, 'ThrottlingException', true],
      [TITAN, 'ThrottlingException', true],
      ['us.cohere.embed-v4:0', null, false],
    ]);
    expect(report.rerank.base).toEqual({ id: 'us.cohere.embed-v4:0', dimensions: 1024, by: 'fused' });
  });

  it('counts a structured answer that needed a repair and one that never came', async () => {
    const gateway = new MockModelGateway({ streamDelayMs: 0 });
    let call = 0;
    const generate = gateway.generateStructured.bind(gateway);
    gateway.generateStructured = async (request) => {
      call += 1;
      if (call === 2) throw awsError('ValidationException');
      const result = await generate(request);
      const [attempt] = result.attempts;
      if (call !== 1 || attempt === undefined) return result;
      return { ...result, attempts: [{ ...attempt, outcome: 'invalid_output' }, attempt] };
    };
    const { report } = await runModelsBenchmark(
      clients({ gateway: () => gateway }),
      { ...CANDIDATES, reasoning: [{ id: LUNA, efforts: [] }], embeddings: [], rerankers: [] },
      { ...OPTIONS, structured: 3 },
    );
    expect(report.reasoning[0]?.structured).toMatchObject({
      requests: 3,
      validFirst: 1,
      validRepaired: 1,
      failed: 1,
      codes: ['ValidationException'],
    });
  });
});

describe('the budget', () => {
  it('makes a call only when its worst case fits beside what was spent and what is in flight', async () => {
    const budget = new Budget(1);
    let release: (() => void) | undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = budget.run(
      'a',
      0.7,
      () => open,
      () => 0.1,
      () => 0,
    );
    expect(
      await budget.run(
        'a',
        0.4,
        () => Promise.resolve(1),
        () => 0.4,
        () => 0,
      ),
    ).toBeNull();
    expect(budget.reached).toBe(true);
    release?.();
    await held;
    expect(
      await budget.run(
        'a',
        0.4,
        () => Promise.resolve(1),
        () => 0.4,
        () => 0,
      ),
    ).toBe(1);
    expect(budget.spent).toBeCloseTo(0.5, 9);
    await expect(
      budget.run(
        'b',
        0.2,
        () => Promise.reject(new Error('x')),
        () => 0,
        () => 0.05,
      ),
    ).rejects.toThrow('x');
    expect(budget.part('b')).toBeCloseTo(0.05, 9);
  });

  it('stops a whole run: no reasoning call is made past it', async () => {
    class Priced extends MockModelGateway {
      streamed = 0;
      override async streamText(r: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
        this.streamed += 1;
        return { ...(await super.streamText(r, onText)), costUsd: 0.02 };
      }
    }
    const gateway = new Priced({ streamDelayMs: 0 });
    const { report } = await runModelsBenchmark(
      clients({ gateway: () => gateway }),
      { ...CANDIDATES, embeddings: [], rerankers: [] },
      { ...OPTIONS, budgetUsd: 0.06, requests: 20 },
    );
    expect(report.budgetReached).toBe(true);
    expect(report.costUsd.total).toBeLessThanOrEqual(0.06);
    expect(gateway.streamed).toBeLessThan(10);
  });

  it('bounds a reasoning call by a write to the cache, a repair and the fallback', () => {
    const worst = reasoningWorstUsd('us.anthropic.claude-haiku-4-5-20251001-v1:0', 24_000, 400);
    // 8,016 input tokens at the cache-write rate alone.
    expect(worst).toBeGreaterThan((8_016 * 1.375) / 1e6);
    expect(worst).toBeLessThan(0.1);
  });
});

describe('the benchmark’s questions', () => {
  it('names passages that exist, plays included, and covers what the app answers from', () => {
    const passages = benchmarkPassages(PLAYBOOK.plays);
    const ids = new Set(passages.map((p) => p.id));
    const queries = benchmarkQueries();
    for (const q of queries)
      for (const id of [...q.expected, ...q.hardNegatives])
        expect([q.id, id, ids.has(id)]).toEqual([q.id, id, true]);
    expect(queries.length).toBeGreaterThanOrEqual(300);
    expect(queries.filter((q) => q.kind === 'no_answer').length).toBeGreaterThanOrEqual(60);
    for (const prefix of [
      'skb/',
      'curriculum/',
      'notes/',
      'open/',
      'method/',
      'doctrine/',
      'library/',
      'play/',
    ])
      expect(queries.some((q) => q.expected.some((id) => id.startsWith(prefix)))).toBe(true);
    // A play's passage is its title, answer and why.
    const play = PLAYBOOK.plays[0];
    const stored = passages.find((p) => p.id === `play/${play?.id ?? ''}`);
    expect(stored?.embedText).toBe(`${play?.title ?? ''}\n\n${play?.answer ?? ''} ${play?.why ?? ''}`);
  });
});

describe('the command line and its inputs', () => {
  it('caps a run at USD 2', () => {
    expect(parseArgs([])).toEqual({
      budgetUsd: MAX_BUDGET_USD,
      requests: 6,
      structured: 4,
      rerankQueries: 60,
      out: null,
    });
    expect(parseArgs(['--budget-usd', '0.5', '--requests', '3', '--out', 'x'])).toMatchObject({
      budgetUsd: 0.5,
      requests: 3,
      out: 'x',
    });
    for (const bad of [
      ['--budget-usd', '2.01'],
      ['--budget-usd', '0'],
      ['--budget-usd', 'lots'],
      ['--requests', '-1'],
      ['--requests', '21'],
      ['--frob', '1'],
      ['--out'],
    ]) {
      expect(() => parseArgs(bad)).toThrow(UsageError);
    }
  });

  it('reads the committed candidates, each priced and each size one the model offers', async () => {
    const candidates = await loadCandidates();
    expect(candidates.reasoning.map((r) => r.id)).toContain(LUNA);
    expect(candidates.embeddings.find((e) => e.id === TITAN)?.dimensions).toEqual([256, 512, 1024]);
    expect(candidates.rerankers).toHaveLength(2);
  });

  it('keeps what a refusal said, whatever wraps it, without account or key ids', async () => {
    const said = Object.assign(
      new Error(
        'User: arn:aws:sts::123456789012:assumed-role/Lab/run is not authorized to perform: aws-marketplace:Subscribe',
      ),
      { name: 'AccessDeniedException' },
    );
    const wrapped = new Error('Model x unavailable: client_error', {
      cause: new Error('mid', { cause: said }),
    });
    expect(failureMessage(wrapped)).toBe(
      'User: arn:aws:sts::<account>:assumed-role/Lab/run is not authorized to perform: aws-marketplace:Subscribe',
    );
    // Through the app's gateway, whose own errors never carry the provider's words.
    const refuse = (): Promise<never> => Promise.reject(said);
    const gateway = createModelGateway({
      provider: 'bedrock',
      region: 'us-east-1',
      primaryModelId: LUNA,
      fallbackModelId: LUNA,
      embeddingsModelId: TITAN,
      transports: { converse: refuse, converseStream: refuse, invokeModel: refuse },
    });
    const refused: unknown = await gateway
      .streamText(
        {
          purpose: 'turn',
          system: 'x',
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 8,
          timeoutMs: 1_000,
          requestId: 'r',
        },
        () => undefined,
      )
      .catch((error: unknown) => error);
    expect(failureCode(refused)).toBe('AccessDeniedException');
    expect(failureMessage(refused)).toContain('aws-marketplace:Subscribe');
    expect(maskAws(['1234-5678-9012 ASIA', 'ABCDEFGHIJKLMNOP end'].join(''))).toBe('<account> <key> end');
    expect(maskAws(`token ${'a'.repeat(120)}`)).toBe('token <token>');
    expect(failureMessage(new Error('x'.repeat(3_000).replaceAll('x', 'x ')))).toHaveLength(1_000);
    expect(failureMessage('text')).toBe('');
  });

  it('keeps error names only', () => {
    expect(failureCode(awsError('AccessDeniedException'))).toBe('AccessDeniedException');
    expect(failureCode(awsError('arn:aws:bedrock::123456789012'))).toBe('Error');
    expect(failureCode('text')).toBe('Error');
  });

  it('writes a prompt of about 6,000 tokens that is the same every time', () => {
    const system = benchmarkSystemPrompt(benchmarkPassages());
    const chars = system.length + benchmarkMessages(0).reduce((acc, m) => acc + m.content.length, 0);
    expect(chars / 4).toBeGreaterThan(5_500);
    expect(chars / 4).toBeLessThan(6_500);
    expect(system).toBe(benchmarkSystemPrompt(benchmarkPassages()));
    expect(system).toMatch(/\[E20\]/);
    expect(system).not.toContain('https://');
    expect(new Set(FOUNDER_MESSAGES).size).toBe(6);
    expect(benchmarkMessages(0).at(-1)).toEqual({ role: 'user', content: FOUNDER_MESSAGES[0] });
  });
});
