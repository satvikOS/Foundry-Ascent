import { readFile } from 'node:fs/promises';

import {
  MockModelGateway,
  UNDERSTAND_SCHEMA_NAME,
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
  parseArgs,
  prepareCase,
  runBench,
  worstUsd,
  type Arm,
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
  ) {
    super();
  }
  override async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    this.requests.push(request);
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
    expect(ARMS.reduce((n, a) => n + worstUsd(a, p), 0)).toBeLessThan(0.2);
  });
});

describe('a case', () => {
  it('is prepared as a turn would: the record dated, what was told before in it, the lines of the conversation', () => {
    const [, second, third] = CASES.map(prepareCase);
    const text = third?.messages[0]?.content ?? '';
    expect(text).toContain('A walk is 24 dollars and a guide gets 9.');
    expect(text).toContain('2026-02-20');
    expect(text).toContain('You had 13 people.');
    expect(text).toContain('A phone call, as it was transcribed.');
    expect(second?.messages[0]?.content).toContain('Founder: we had 13 last night');
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
    expect(run).toMatchObject({ budgetReached: false, casesRead: 3, spentUsd: 0.006 });
    const sum = run.rows.find((r) => r.caseId === 'AA-01:1.1');
    expect(sum?.understanding?.sums[0]).toMatchObject({ said: '$312', working: '13 × $24' });
    expect(sum?.report?.inputs).toEqual({ named: 2, found: 2, anywhere: 2 });
    expect(run.rows.find((r) => r.caseId === 'AA-01:2.1')?.understanding?.referral).toBe('ip');
    for (const g of gateways)
      for (const r of g.requests)
        expect(r).toMatchObject({ purpose: 'turn', schemaName: UNDERSTAND_SCHEMA_NAME, route: 'understand' });
    expect(gateways[0]?.requests[0]).not.toHaveProperty('think');
    expect(gateways[1]?.requests[0]).toHaveProperty('think', 'low');
  });

  it('begins no case it could not pay on every arm', async () => {
    const each = new Map(arms.map((a) => [a.key, 0.4]));
    const run = await runBench(arms, CASES, {
      budgetUsd: 1,
      concurrency: 1,
      worst: (arm) => each.get(arm.key) ?? 0,
      gatewayFor: () => new Priced(0.15),
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

describe('the command line', () => {
  it('needs its files and stays under the owner’s cap', () => {
    const ok = ['--cases', 'c', '--out', 'o', '--budget-usd', '2', '--candidates', 'a,b'];
    expect(parseArgs(ok)).toEqual({
      cases: 'c',
      out: 'o',
      budgetUsd: 2,
      concurrency: 3,
      candidates: ['a', 'b'],
    });
    for (const bad of [
      ['--cases', 'c'],
      ['--cases', 'c', '--out', 'o', '--budget-usd', '2.01'],
      ['--cases', 'c', '--out', 'o', '--budget-usd', 'x'],
      ['--cases', 'c', '--out', 'o', '--concurrency', '9'],
      ['--what', 'c'],
      ['--cases'],
    ])
      expect(() => parseArgs(bad), bad.join(' ')).toThrow(UsageError);
  });
});
