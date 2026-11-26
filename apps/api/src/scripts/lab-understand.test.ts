import { readFile } from 'node:fs/promises';

import {
  MockModelGateway,
  UNDERSTAND_PARTS,
  UNDERSTAND_SCHEMA_NAMES,
  UNDERSTAND_TIMEOUT_MS,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
} from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import {
  CANDIDATES_FILE,
  Case,
  UsageError,
  armsOf,
  chosenArms,
  inTimeParts,
  parseArgs,
  prepareCase,
  runBench,
  sumsKey,
  worstUsd,
  type Arm,
  type PartRow,
} from './lab-understand.js';

const ARMS = armsOf(JSON.parse(await readFile(CANDIDATES_FILE, 'utf8')));
const NOVA = 'us.amazon.nova-2-lite-v1:0';

const bench = (id: string, message: string, over: Partial<Case> = {}): Case =>
  Case.parse({
    id,
    day: '2026-03-04',
    channel: 'text',
    venture: {
      name: 'Harbour Lanterns',
      oneLiner: 'Night walks in an old harbour.',
      stage: 'business_model',
      domain: 'consumer',
      goal: 'Fill one walk a week.',
    },
    founder: 'Ilse Brandt',
    record: [
      { type: 'fact', title: 'Price', content: 'A walk is 24 dollars and a guide gets 9.', daysAgo: 12 },
    ],
    said: [],
    intake: { experience: 'first_time' },
    history: [],
    message,
    ...over,
  });
const CASES = [
  bench('AA-01:1.1', 'how much comes in if 13 people pay $24 for a walk?'),
  bench('AA-01:1.2', 'should I raise it or leave it?', { history: ['we had 13 last night'] }),
  bench('AA-01:2.1', 'who owns the patent?', {
    channel: 'voice',
    said: [{ text: 'We had 13 people.', daysAgo: 7 }],
  }),
];

/** A mock that bills every call, and can fail some. */
class Priced extends MockModelGateway {
  readonly requests: GenerateStructuredRequest<unknown>[] = [];
  constructor(
    private readonly usd: number,
    private readonly fails = false,
    /** Parts whose answer comes after a turn's cap. */
    private readonly slow: readonly string[] = [],
  ) {
    super();
  }
  override async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    this.requests.push(request);
    if (this.slow.includes(request.schemaName)) await new Promise((resolve) => setTimeout(resolve, 120));
    if (this.fails) throw new Error('the provider said secret things');
    const result = await super.generateStructured(request);
    return { ...result, costUsd: this.usd };
  }
}

describe('the candidates', () => {
  it('are models.json’s, each at its efforts', () => {
    expect(ARMS.map((a) => a.key)).toEqual([
      `${NOVA}@none`,
      `${NOVA}@low`,
      'openai.gpt-oss-120b-1:0@low',
      'openai.gpt-oss-20b-1:0@low',
      'qwen.qwen3-next-80b-a3b',
      'us.amazon.nova-micro-v1:0',
      'us.amazon.nova-lite-v1:0',
    ]);
  });

  it('may be narrowed to a model or one of its efforts, and to nothing else', () => {
    expect(chosenArms(ARMS, [NOVA]).map((a) => a.key)).toEqual([`${NOVA}@none`, `${NOVA}@low`]);
    expect(chosenArms(ARMS, [`${NOVA}@low`])).toHaveLength(1);
    expect(chosenArms(ARMS, [])).toHaveLength(ARMS.length);
    expect(() => chosenArms(ARMS, ['us.amazon.nova-pro-v1:0'])).toThrow(UsageError);
  });

  it('reserve more where a model reasons', () => {
    const p = prepareCase(CASES[0] ?? bench('AA-01:1.1', 'x'));
    const of = (key: string): number => {
      const arm = ARMS.find((a) => a.key === key);
      return arm === undefined ? 0 : worstUsd(arm, p);
    };
    expect(of(`${NOVA}@low`)).toBeGreaterThan(of(`${NOVA}@none`));
    expect(of('openai.gpt-oss-20b-1:0@low')).toBeGreaterThan(0);
    // A whole case on every candidate stays small beside the cap.
    expect(ARMS.reduce((n, a) => n + worstUsd(a, p), 0)).toBeLessThan(0.3);
  });
});

describe('a case', () => {
  it('is prepared as a turn would: the record dated, what was told before in it, the lines of the conversation', () => {
    const [, second, third] = CASES.map(prepareCase);
    const text = third?.parts.judge.messages[0]?.content ?? '';
    expect(text).toContain('A walk is 24 dollars and a guide gets 9.');
    expect(text).toContain('2026-02-20');
    expect(text).toContain('You had 13 people.');
    expect(text).toContain('A phone call, as it was transcribed.');
    expect(second?.parts.judge.messages[0]?.content).toContain('Founder: we had 13 last night');
    expect(text).toContain('You are doing this for the first time.');
  });

  it('holds no expectation, and an id of the lab’s form', () => {
    expect(() => Case.parse({ ...CASES[0], id: 'x' })).toThrow();
    expect(Object.keys(Case.shape)).not.toContain('expect');
  });
});

describe('a run', () => {
  const arms: Arm[] = ARMS.slice(0, 2);

  it('reads every case on every arm, with the checks and the sums of a turn', async () => {
    const gateways: Priced[] = [];
    const run = await runBench(arms, CASES, {
      budgetUsd: 2,
      concurrency: 2,
      gatewayFor: () => {
        const g = new Priced(0.001);
        gateways.push(g);
        return g;
      },
    });
    expect(run.rows).toHaveLength(6);
    // Three calls a case.
    expect(run).toMatchObject({ budgetReached: false, casesRead: 3, spentUsd: 0.018 });
    const sum = run.rows.find((r) => r.caseId === 'AA-01:1.1');
    expect(sum?.understanding?.sums[0]).toMatchObject({ said: '$312', working: '13 × $24' });
    expect(sum?.report?.inputs).toEqual({ named: 2, found: 2, anywhere: 2 });
    expect(sum?.inTime).toEqual(sum?.understanding);
    for (const part of UNDERSTAND_PARTS) expect(sum?.parts[part]).toMatchObject({ code: 'ok', late: false });
    expect(run.rows.find((r) => r.caseId === 'AA-01:2.1')?.understanding?.referral).toBe('ip');
    for (const g of gateways) {
      expect(g.requests).toHaveLength(9);
      for (const r of g.requests) {
        expect(r).toMatchObject({
          purpose: 'turn',
          route: r.schemaName === UNDERSTAND_SCHEMA_NAMES.sums ? 'understand_sums' : 'understand',
        });
        expect(Object.values(UNDERSTAND_SCHEMA_NAMES)).toContain(r.schemaName);
      }
    }
    expect(gateways[0]?.requests[0]).not.toHaveProperty('think');
    expect(gateways[1]?.requests[0]).toHaveProperty('think', 'low');
  });

  it('reads a SUMS model beside each arm’s own, on the arm’s ROUTE and JUDGE, and bills those once', async () => {
    const own = new Priced(0.001);
    const beside = new Priced(0.002);
    const sums: Arm = { key: 'openai.gpt-oss-120b-1:0', modelId: 'openai.gpt-oss-120b-1:0', effort: null };
    const run = await runBench(arms.slice(0, 1), CASES, {
      budgetUsd: 2,
      concurrency: 1,
      gatewayFor: () => own,
      sums: { arm: sums, gateway: () => beside },
    });
    const [arm] = arms;
    if (arm === undefined) throw new Error('no arm');
    const key = sumsKey(arm, sums);
    expect(run.rows.map((r) => r.arm)).toEqual(CASES.flatMap(() => [arm.key, key]));
    expect(beside.requests.every((r) => r.schemaName === UNDERSTAND_SCHEMA_NAMES.sums)).toBe(true);
    expect(beside.requests.every((r) => r.route === 'understand_sums')).toBe(true);
    const [first, second] = run.rows;
    expect(second?.parts.route).toEqual(first?.parts.route);
    expect(second?.parts.sums.costUsd).toBe(0.002);
    expect(second?.understanding?.sums[0]).toMatchObject({ said: '$312' });
    // Three calls a case on the arm, one beside it.
    expect(run.spentUsd).toBeCloseTo(3 * 0.003 + 3 * 0.002, 6);
  });

  it('reads each case again as a turn at the caps would have', async () => {
    const run = await runBench(arms.slice(0, 1), CASES.slice(0, 1), {
      budgetUsd: 1,
      concurrency: 1,
      caps: { text: 60, voice: 60 },
      gatewayFor: () =>
        new Priced(0.001, false, [UNDERSTAND_SCHEMA_NAMES.sums, UNDERSTAND_SCHEMA_NAMES.judge]),
    });
    const [row] = run.rows;
    expect(row?.late).toBe(true);
    expect(UNDERSTAND_PARTS.map((part) => row?.parts[part].late)).toEqual([false, true, true]);
    expect(row?.understanding?.sums).toHaveLength(1);
    expect(row?.inTime).toMatchObject({ kind: 'sum', sums: [], points: [] });
  });

  it('asks SUMS once more for a plan and no sum, and pays for both', async () => {
    const plan = { q: 'what comes in', w: 'people by price', s: [], m: null };
    class Planning extends Priced {
      override generateStructured<T>(
        request: GenerateStructuredRequest<T>,
      ): Promise<GenerateStructuredResult<T>> {
        const made = super.generateStructured(request);
        return request.schemaName === UNDERSTAND_SCHEMA_NAMES.sums
          ? made.then((r) => ({ ...r, value: plan as T }))
          : made;
      }
    }
    const gateway = new Planning(0.001);
    const run = await runBench(arms.slice(0, 1), CASES.slice(0, 1), {
      budgetUsd: 1,
      concurrency: 1,
      gatewayFor: () => gateway,
    });
    expect(gateway.requests).toHaveLength(4);
    expect(run.rows[0]?.parts.sums).toMatchObject({ again: 'plan', costUsd: 0.002 });
    expect(run.rows[0]?.parts.route).not.toHaveProperty('again');
  });

  it('a part a turn would not make is none, and costs nothing', async () => {
    const none = bench('AA-02:1.1', 'where do we meet people', { record: [] });
    const run = await runBench(arms.slice(0, 1), [none], {
      budgetUsd: 1,
      concurrency: 1,
      gatewayFor: () => new Priced(0.001),
    });
    expect(run.rows[0]?.parts.sums).toMatchObject({ code: 'skipped', costUsd: 0, late: false });
    expect(run.spentUsd).toBe(0.002);
  });

  it('begins no case it could not pay on every arm', async () => {
    const each = new Map(arms.map((a) => [a.key, 0.4]));
    const run = await runBench(arms, CASES, {
      budgetUsd: 1,
      concurrency: 1,
      worst: (arm) => each.get(arm.key) ?? 0,
      gatewayFor: () => new Priced(0.05),
    });
    expect(run.budgetReached).toBe(true);
    expect(run.casesRead).toBe(1);
    expect(new Set(run.rows.map((r) => r.arm)).size).toBe(2);
    expect(run.spentUsd).toBeLessThanOrEqual(1);
  });

  it('counts a failed call as one, by its code', async () => {
    const run = await runBench(arms, CASES.slice(0, 1), {
      budgetUsd: 1,
      concurrency: 1,
      gatewayFor: () => new Priced(0, true),
    });
    expect(run.rows.map((r) => [r.code, r.understanding])).toEqual([
      ['error', null],
      ['error', null],
    ]);
    expect(JSON.stringify(run.rows)).not.toContain('secret');
  });
});

describe('what a turn would have had', () => {
  const part = (ms: number, raw: unknown = null): PartRow => ({
    code: 'ok',
    ms,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    raw,
  });
  const route = (k: string) => ({
    a: 'x',
    b: null,
    k: [k],
    r: [],
    c: null,
    f: null,
    p: null,
    s: null,
    h: false,
  });
  const caps = UNDERSTAND_TIMEOUT_MS;
  const kept = (k: string, judgeMs: number, routeMs = 900) =>
    UNDERSTAND_PARTS.filter(
      inTimeParts({ route: part(routeMs, route(k)), sums: part(1_000), judge: part(judgeMs) }, 'text', caps),
    );
  it('is what came within the cap, JUDGE only for as long as it is waited for', () => {
    expect(kept('question', 1_500)).toEqual(['route', 'sums', 'judge']);
    expect(kept('question', 2_400)).toEqual(['route', 'sums']);
    expect(kept('choice', 2_400)).toEqual(['route', 'sums', 'judge']);
    expect(kept('choice', caps.text + 1)).toEqual(['route', 'sums']);
    expect(kept('question', 2_400, caps.text + 1)).toEqual(['sums', 'judge']);
  });
});

describe('the command line', () => {
  it('needs its files and stays under the owner’s cap', () => {
    const ok = ['--cases', 'c', '--out', 'o', '--budget-usd', '2', '--candidates', 'a,b'];
    expect(parseArgs(ok)).toEqual({
      cases: 'c',
      out: 'o',
      budgetUsd: 2,
      concurrency: 3,
      candidates: ['a', 'b'],
      caps: UNDERSTAND_TIMEOUT_MS,
      sumsModel: null,
    });
    expect(parseArgs([...ok, '--sums-model', 'openai.gpt-oss-120b-1:0']).sumsModel).toBe(
      'openai.gpt-oss-120b-1:0',
    );
    expect(parseArgs([...ok, '--typed-ms', '4500', '--voice-ms', '2000']).caps).toEqual({
      text: 4_500,
      voice: 2_000,
    });
    for (const bad of [
      ['--cases', 'c'],
      ['--cases', 'c', '--out', 'o', '--budget-usd', '2.01'],
      ['--cases', 'c', '--out', 'o', '--budget-usd', 'x'],
      ['--cases', 'c', '--out', 'o', '--concurrency', '9'],
      ['--cases', 'c', '--out', 'o', '--typed-ms', '20000'],
      ['--cases', 'c', '--out', 'o', '--voice-ms', '100'],
      ['--what', 'c'],
      ['--cases'],
    ])
      expect(() => parseArgs(bad), bad.join(' ')).toThrow(UsageError);
  });
});
