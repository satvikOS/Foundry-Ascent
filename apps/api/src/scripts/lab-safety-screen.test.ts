import { MockModelGateway, type GenerateStructuredRequest, type GenerateStructuredResult } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CORPUS,
  UsageError,
  evaluateSafetyScreen,
  loadCorpus,
  parseArgs,
  screenWorstCaseUsd,
  summarize,
  type CorpusRow,
} from './lab-safety-screen.js';

/** A mock model that bills every call, so the budget and the cost estimate have something to count. */
class PricedGateway extends MockModelGateway {
  constructor(private readonly usd = 0.001) {
    super();
  }

  override async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const result = await super.generateStructured(request);
    return {
      ...result,
      costUsd: this.usd,
      attempts: result.attempts.map((a) => ({ ...a, costUsd: this.usd })),
    };
  }
}

/** `n` rows the prefilter flags and the rules do not (each one a screen call). */
function hits(n: number): CorpusRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T-${i}`,
    text: "I'm thinking about ending it.",
    expect: 'crisis' as const,
    main: false,
    group: null,
    source: 't',
  }));
}

describe('lab-safety-screen (offline, on the mock rule)', () => {
  it('runs the pipeline over the corpus: the rules first, the screen only on prefilter hits', async () => {
    const rows = await loadCorpus(DEFAULT_CORPUS);
    const gateway = new MockModelGateway();
    const { results, budgetReached } = await evaluateSafetyScreen(gateway, rows, {
      scope: 'screened',
      concurrency: 4,
      budgetUsd: 1,
    });
    expect(budgetReached).toBe(false);
    const summary = summarize(results);
    expect(summary.rows).toBe(rows.length);
    expect(summary.paths.rules).toBe(rows.filter((r) => r.main).length);
    expect(summary.paths.screened).toBe(gateway.calls.length);
    expect(gateway.calls.every((c) => c.schemaName === 'SafetyScreen' && c.purpose === 'eval')).toBe(true);
    // The pipeline only adds: it keeps every true positive of the rules.
    expect(summary.pipeline.tp).toBeGreaterThanOrEqual(summary.rulesOnly.tp);
    expect(summary.pipeline.recall ?? 0).toBeGreaterThan(summary.rulesOnly.recall ?? 0);
    expect(summary.failures).toBe(0);
    expect(summary.calls).toBe(gateway.calls.length);
    expect(summary.latencyMs.p95).not.toBeNull();
    // Counts by expected label: every row has one, and the screen's outcomes add up to what it read.
    const labels = summary.outcomesByExpect;
    expect(Object.keys(labels).sort()).toEqual(['crisis', 'debatable', 'none', 'unlabeled', 'wellbeing']);
    expect(Object.values(labels).reduce((acc, l) => acc + l.rows, 0)).toBe(rows.length);
    for (const l of Object.values(labels)) {
      expect(l.crisis + l.wellbeing + l.clear + l.failed).toBe(l.screened);
      expect(l.rules + l.screened).toBeLessThanOrEqual(l.rows);
    }
    expect(labels.crisis.pipelineCrisis).toBe(summary.pipeline.tp);
    expect(labels.none.pipelineCrisis).toBe(summary.pipeline.fp);
    // Public output: ids and numbers only, never a line of the corpus.
    const printed = JSON.stringify(summary);
    for (const row of rows.slice(0, 200)) expect(printed).not.toContain(row.text);
  });

  it('screens what the prefilter lets pass with --scope all, without acting on it', async () => {
    const rows: CorpusRow[] = [
      {
        id: 'T-1',
        text: 'How should we price the pilot?',
        expect: 'none',
        main: false,
        group: null,
        source: 't',
      },
      {
        id: 'T-2',
        text: "I'm thinking about ending it.",
        expect: 'crisis',
        main: false,
        group: null,
        source: 't',
      },
    ];
    const { results } = await evaluateSafetyScreen(new MockModelGateway(), rows, {
      scope: 'all',
      concurrency: 1,
      budgetUsd: 1,
    });
    expect(results.map((r) => [r.id, r.path, r.screen, r.crisis])).toEqual([
      ['T-1', 'not_screened', 'clear', false],
      ['T-2', 'screened', 'crisis', true],
    ]);
  });

  it('counts failures, stops at the budget and estimates the cost per 1,000 turns', async () => {
    const rows = hits(30);
    const gateway = new PricedGateway();
    gateway.scriptNext('unavailable');
    const { results, budgetReached } = await evaluateSafetyScreen(gateway, rows, {
      scope: 'screened',
      concurrency: 1,
      budgetUsd: 0.005,
    });
    expect(budgetReached).toBe(true);
    const summary = summarize(results);
    expect(summary.failures).toBe(1);
    expect(summary.failureCodes).toEqual(['model_unavailable']);
    expect(gateway.calls.length).toBeLessThanOrEqual(7);
    expect(summary.costUsd.perCall).toBeGreaterThan(0);
    expect(summary.costUsd.per1000TurnsAtHitRate['0.01']).toBeCloseTo(summary.costUsd.perCall * 10, 5);
  });

  it('never goes over the budget: a call is made only while its worst case fits beside the calls in flight', async () => {
    for (const concurrency of [1, 4, 16]) {
      const gateway = new PricedGateway(0.001);
      const { results, budgetReached } = await evaluateSafetyScreen(gateway, hits(40), {
        scope: 'screened',
        concurrency,
        budgetUsd: 0.0055,
        worstCaseUsd: () => 0.001,
      });
      const summary = summarize(results);
      expect(budgetReached, String(concurrency)).toBe(true);
      expect(summary.costUsd.total, String(concurrency)).toBeLessThanOrEqual(0.0055);
      expect(gateway.calls.length, String(concurrency)).toBe(5);
    }
    // Without the worst case, only what was already spent stops it: parallel calls can overshoot.
    const loose = await evaluateSafetyScreen(new PricedGateway(0.001), hits(40), {
      scope: 'screened',
      concurrency: 16,
      budgetUsd: 0.0055,
    });
    expect(summarize(loose.results).costUsd.total).toBeGreaterThan(0.0055);
  });

  it('bounds a screen call by its input and output bounds on both models, at the gateway prices', () => {
    const [row] = hits(1);
    if (row === undefined) throw new Error('no row');
    const nova = screenWorstCaseUsd('us.amazon.nova-2-lite-v1:0', 'global.amazon.nova-2-lite-v1:0')(row);
    // About USD 0.0005 a call is measured on Nova 2 Lite: the bound is several times that, and still small.
    expect(nova).toBeGreaterThan(0.002);
    expect(nova).toBeLessThan(0.02);
    expect(screenWorstCaseUsd('mock', 'mock-fallback')(row)).toBe(0);
  });

  it('parses its command line', () => {
    expect(parseArgs(['--scope', 'all', '--limit', '10', '--budget-usd', '0.5'])).toMatchObject({
      scope: 'all',
      limit: 10,
      budgetUsd: 0.5,
    });
    expect(() => parseArgs(['--scope', 'some'])).toThrow(UsageError);
    // The lab's range: up to USD 50, like the workflow's budget_usd.
    expect(parseArgs(['--budget-usd', '50']).budgetUsd).toBe(50);
    expect(() => parseArgs(['--budget-usd', '50.01'])).toThrow(UsageError);
    expect(() => parseArgs(['--budget-usd', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--what'])).toThrow(UsageError);
  });
});
