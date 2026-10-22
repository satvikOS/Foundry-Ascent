import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_PRICES,
  DEFAULT_SPEECH_PRICES,
  costFor,
  createPricingTable,
  normalizeModelId,
  priceFor,
  speechAttempt,
  speechCharacters,
  speechCostFor,
  speechModelId,
  sumUsd,
  type SpeechEngine,
} from './pricing.js';

const M = 1_000_000;

describe('pricing', () => {
  it('prices Luna with the 10 % in-region premium', () => {
    expect(costFor('openai.gpt-6-luna', { inputTokens: M, outputTokens: M })).toBeCloseTo(
      (0.1 + 0.5) * 1.1,
      9,
    );
    expect(costFor('openai.gpt-6-luna', { inputTokens: 10_000, outputTokens: 2_000 })).toBeCloseTo(
      ((10_000 * 0.1 + 2_000 * 0.5) * 1.1) / M,
      9,
    );
  });

  it('prices Nova 2 Lite and Titan embeddings', () => {
    // Global $0.30 / $2.50; the `us.` profile production uses (and a bare id, served in one region) is 10 % more.
    expect(
      costFor('global.amazon.nova-2-lite-v1:0', { inputTokens: 1_000, outputTokens: 1_000 }),
    ).toBeCloseTo(0.0028, 9);
    expect(costFor('us.amazon.nova-2-lite-v1:0', { inputTokens: 1_000, outputTokens: 1_000 })).toBeCloseTo(
      0.00308,
      9,
    );
    expect(costFor('amazon.titan-embed-text-v2:0', { inputTokens: M, outputTokens: 0 })).toBeCloseTo(0.02, 9);
  });

  it('treats inference-profile ids and ARNs like their base model', () => {
    expect(normalizeModelId('us.amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
    expect(normalizeModelId('arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0')).toBe(
      'amazon.titan-embed-text-v2:0',
    );
    const usage = { inputTokens: 5_000, outputTokens: 700 };
    expect(costFor('us.amazon.nova-2-lite-v1:0', usage)).toBe(costFor('amazon.nova-2-lite-v1:0', usage));
  });

  it('rounds up to the micro-dollar so tiny calls are never free', () => {
    expect(costFor('openai.gpt-6-luna', { inputTokens: 1, outputTokens: 0 })).toBe(0.000001);
    expect(costFor('openai.gpt-6-luna', { inputTokens: 0, outputTokens: 0 })).toBe(0);
    const cost = costFor('amazon.nova-2-lite-v1:0', { inputTokens: 1_234, outputTokens: 567 });
    expect(Math.round(cost * M)).toBe(cost * M);
  });

  it('prices unknown models at the most expensive known rate', () => {
    const { known, price } = priceFor('some.unknown-model');
    expect(known).toBe(false);
    // Claude Opus at a regional endpoint: $25 per million output tokens plus 10 %.
    expect(price.outputPerMillionUsd).toBeCloseTo(27.5, 9);
    expect(costFor('some.unknown-model', { inputTokens: M, outputTokens: 0 })).toBeGreaterThan(0);
  });

  it('prices Claude at list price on global endpoints and 10 % more on regional ones', () => {
    const usage = { inputTokens: M, outputTokens: M };
    expect(priceFor('global.anthropic.claude-sonnet-4-6').known).toBe(true);
    expect(costFor('global.anthropic.claude-sonnet-4-6', usage)).toBeCloseTo(3 + 15, 9);
    expect(costFor('us.anthropic.claude-sonnet-4-6', usage)).toBeCloseTo((3 + 15) * 1.1, 9);
    expect(costFor('anthropic.claude-sonnet-4-6', usage)).toBeCloseTo((3 + 15) * 1.1, 9);
    expect(
      costFor(
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1',
        usage,
      ),
    ).toBeCloseTo(5 + 25, 9);
    expect(costFor('global.anthropic.claude-haiku-4-5-20251001-v1:0', usage)).toBeCloseTo(1 + 5, 9);
    expect(costFor('global.anthropic.claude-opus-5-5', usage)).toBeCloseTo(4 + 20, 9);
    expect(costFor('global.anthropic.claude-sonnet-5-5', usage)).toBeCloseTo(2 + 10, 9);
    expect(costFor('global.anthropic.claude-haiku-5-5', usage)).toBeCloseTo(0.1 + 0.5, 9);
    // Models without a regional premium are unaffected by the endpoint.
    expect(costFor('us.amazon.titan-embed-text-v2:0', usage)).toBe(
      costFor('global.amazon.titan-embed-text-v2:0', usage),
    );
  });

  it('accepts configuration overrides and validates them', () => {
    const table = createPricingTable({
      'us.openai.gpt-6-luna': { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });
    expect(costFor('openai.gpt-6-luna', { inputTokens: M, outputTokens: M }, table)).toBe(3);
    expect(DEFAULT_MODEL_PRICES['openai.gpt-6-luna']?.inputPerMillionUsd).toBe(0.1);
    expect(() => createPricingTable({ x: { inputPerMillionUsd: -1, outputPerMillionUsd: 0 } })).toThrow(
      RangeError,
    );
    expect(() =>
      createPricingTable({ x: { inputPerMillionUsd: 1, outputPerMillionUsd: 1, regionalPremium: -0.1 } }),
    ).toThrow(RangeError);
    expect(() =>
      createPricingTable({ x: { inputPerMillionUsd: Number.NaN, outputPerMillionUsd: 0 } }),
    ).toThrow(RangeError);
  });

  it('sums micro-dollar amounts without drift', () => {
    expect(sumUsd([0.000001, 0.000002, 0.1, 0.2])).toBe(0.300003);
    expect(sumUsd([])).toBe(0);
  });

  it('prices mock models at zero', () => {
    expect(costFor('mock', { inputTokens: M, outputTokens: M })).toBe(0);
    expect(costFor('mock-fallback', { inputTokens: M, outputTokens: M })).toBe(0);
    expect(costFor('mock-embeddings', { inputTokens: M, outputTokens: 0 })).toBe(0);
  });
});

describe('speech pricing (Amazon Polly, per character)', () => {
  it('prices neural at $16 and generative at $30 per million characters', () => {
    expect(DEFAULT_SPEECH_PRICES).toEqual({ neural: 16, generative: 30 });
    expect(speechCostFor('neural', M)).toBe(16);
    expect(speechCostFor('generative', M)).toBe(30);
    expect(speechCostFor('neural', 350)).toBe(0.0056);
    expect(speechCostFor('generative', 350)).toBe(0.0105);
  });

  it('rounds up to the micro-dollar and never prices nothing', () => {
    expect(speechCostFor('neural', 1)).toBe(0.000016);
    expect(speechCostFor('neural', 0)).toBe(0);
    expect(speechCostFor('neural', -5)).toBe(0);
  });

  it('prices an unknown engine at the most expensive rate and accepts overrides', () => {
    expect(speechCostFor('long-form' as SpeechEngine, M)).toBe(30);
    expect(speechCostFor('neural', M, { neural: 20, generative: 40 })).toBe(20);
  });

  it('counts characters as Polly bills them (code points)', () => {
    expect(speechCharacters('Hi Maya')).toBe(7);
    expect(speechCharacters('café 👋')).toBe(6);
  });

  it('records a call as a billable ledger attempt (purpose speech)', () => {
    expect(speechModelId('generative')).toBe('polly.generative');
    expect(speechAttempt({ engine: 'neural', characters: 1_000, latencyMs: 412.6 })).toEqual({
      provider: 'polly',
      modelId: 'polly.neural',
      kind: 'initial',
      outcome: 'ok',
      latencyMs: 413,
      usage: { inputTokens: 1_000, outputTokens: 0 },
      errorName: null,
      costUsd: 0.016,
    });
    // Refused requests are free; anything that may have been synthesised is billed.
    expect(
      speechAttempt({ engine: 'neural', characters: 1_000, latencyMs: 5, outcome: 'throttled' }).costUsd,
    ).toBe(0);
    expect(
      speechAttempt({ engine: 'neural', characters: 1_000, latencyMs: 5, outcome: 'client_error' }).costUsd,
    ).toBe(0);
    expect(
      speechAttempt({ engine: 'neural', characters: 1_000, latencyMs: 5, outcome: 'aborted' }).costUsd,
    ).toBe(0.016);
  });
});
