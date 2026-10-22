import { MockModelGateway, type GenerateStructuredRequest, type GenerateStructuredResult } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CORPUS,
  UsageError,
  evaluateSafetyScreen,
  loadCorpus,
  parseArgs,
  summarize,
  type CorpusRow,
} from './lab-safety-screen.js';

/** A mock model that bills every call, so the budget and the cost estimate have something to count. */
class PricedGateway extends MockModelGateway {
  override async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const result = await super.generateStructured(request);
    return { ...result, costUsd: 0.001, attempts: result.attempts.map((a) => ({ ...a, costUsd: 0.001 })) };
  }
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
    const rows: CorpusRow[] = Array.from({ length: 30 }, (_, i) => ({
      id: `T-${i}`,
      text: "I'm thinking about ending it.",
      expect: 'crisis' as const,
      main: false,
      group: null,
      source: 't',
    }));
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

  it('parses its command line', () => {
    expect(parseArgs(['--scope', 'all', '--limit', '10', '--budget-usd', '0.5'])).toMatchObject({
      scope: 'all',
      limit: 10,
      budgetUsd: 0.5,
    });
    expect(() => parseArgs(['--scope', 'some'])).toThrow(UsageError);
    expect(() => parseArgs(['--budget-usd', '50'])).toThrow(UsageError);
    expect(() => parseArgs(['--what'])).toThrow(UsageError);
  });
});
