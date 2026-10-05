import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_PRICES,
  costFor,
  createPricingTable,
  normalizeModelId,
  priceFor,
  sumUsd,
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
    expect(costFor('amazon.nova-2-lite-v1:0', { inputTokens: 1_000, outputTokens: 1_000 })).toBeCloseTo(
      0.0028,
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
    expect(price.outputPerMillionUsd).toBe(2.5);
    expect(costFor('some.unknown-model', { inputTokens: M, outputTokens: 0 })).toBeGreaterThan(0);
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
