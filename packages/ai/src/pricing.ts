import type { ModelUsage } from './gateway/types.js';

/** USD per one million tokens. */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Input tokens read from the prompt cache (`ModelUsage.cacheReadInputTokens`). Default: the input rate. */
  cacheReadPerMillionUsd?: number;
  /** Input tokens written to the prompt cache (`ModelUsage.cacheWriteInputTokens`). Default: the input rate. */
  cacheWritePerMillionUsd?: number;
  /** Fractional surcharge applied to the whole call (0.10 = +10 %), e.g. in-region Mantle premium. */
  premium?: number;
  /**
   * Extra surcharge when the call goes to a regional endpoint instead of the global one: a geography
   * inference profile (`us.`, `eu.`, …) or the bare model id served in one region. Global profiles
   * (`global.`) do not pay it.
   */
  regionalPremium?: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

/**
 * Claude on Bedrock: list price at the global endpoint, +10 % at regional ones (Claude 4.5 and later), and the
 * prompt-cache rates where they were checked.
 */
function claude(
  inputPerMillionUsd: number,
  outputPerMillionUsd: number,
  cache?: { readonly read: number; readonly write: number },
): ModelPrice {
  return {
    inputPerMillionUsd,
    outputPerMillionUsd,
    ...(cache ? { cacheReadPerMillionUsd: cache.read, cacheWritePerMillionUsd: cache.write } : {}),
    regionalPremium: 0.1,
  };
}

/** Claude Haiku 4.5's cache rates (global): reads a tenth of the input rate, 5-minute writes 1.25 times it. */
const HAIKU_4_5_CACHE = { read: 0.1, write: 1.25 } as const;

/**
 * List prices (Amazon Bedrock, us-east-1) at the time of writing. Operators override them through
 * gateway configuration; do not edit code to change a price.
 *
 * Claude rows are Anthropic's list prices (platform.claude.com pricing, checked 2026-10-16), which Bedrock's
 * global endpoints charge; regional endpoints add 10 %; and Claude Haiku 5.5 is priced at its rate for prompts up to
 * 100,000 tokens (turn prompts stay far below).
 *
 * Prompt cache: Nova 2 Lite reads from the cache at a quarter of its input rate ($0.075 per million against $0.30)
 * and writes to it for $0 (the AWS Price List API for AmazonBedrock, us-east-1, published 2026-10-16:
 * `Nova2.0Lite-cache-read-input-token-count-cross-region-global` $0.000075 and `…-cache-write-…` $0.00 per 1K tokens;
 * the gateway sends Nova its cache checkpoints, nova.ts). A model without cache rates counts every cached token at
 * its input rate, so the caps never under-count it.
 *
 * Claude Haiku 4.5, the production coach (us-east-1, AWS Price List API offer `AmazonBedrockFoundationModels`,
 * "Claude Haiku 4.5 (Amazon Bedrock Edition)", published 2026-10-12; the Amazon Bedrock pricing page,
 * https://aws.amazon.com/bedrock/pricing/, lists the same, checked 2026-11-06), USD per million tokens:
 *
 * | Tokens                    | Global (`global.`) | Regional (`us.`, what production calls) |
 * | ------------------------- | ------------------ | ---------------------------------------- |
 * | Input                     | 1.00               | 1.10                                     |
 * | Output                    | 5.00               | 5.50                                     |
 * | Cache write (5-minute)    | 1.25               | 1.375                                    |
 * | Cache read                | 0.10               | 0.11                                     |
 *
 * The regional column is the global one plus the 10 % regional premium, so the row below holds the global rates. The
 * gateway sends Haiku 4.5 cache checkpoints (nova.ts `usesCachePoints`); other Claude rows have no cache rates yet, so
 * they get none.
 *
 * Bedrock serves Opus 4.6, Sonnet 4.6 and Haiku 4.5 through Converse with the ARN-versioned ids; later models use the
 * short `anthropic.claude-…` ids.
 */
export const DEFAULT_MODEL_PRICES: PricingTable = {
  'openai.gpt-6-luna': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, premium: 0.1 },
  // Global rates; the `us.` profile production uses is listed 10 % higher ($0.33 / $2.75, cache reads $0.0825).
  'amazon.nova-2-lite-v1:0': {
    inputPerMillionUsd: 0.3,
    outputPerMillionUsd: 2.5,
    cacheReadPerMillionUsd: 0.075,
    cacheWritePerMillionUsd: 0,
    regionalPremium: 0.1,
  },
  'amazon.titan-embed-text-v2:0': { inputPerMillionUsd: 0.02, outputPerMillionUsd: 0 },
  'anthropic.claude-opus-4-6-v1': claude(5, 25),
  'anthropic.claude-sonnet-4-6': claude(3, 15),
  'anthropic.claude-haiku-4-5-20251001-v1:0': claude(1, 5, HAIKU_4_5_CACHE),
  'anthropic.claude-haiku-4-5': claude(1, 5, HAIKU_4_5_CACHE),
  'anthropic.claude-opus-4-7': claude(5, 25),
  'anthropic.claude-opus-4-8': claude(5, 25),
  'anthropic.claude-opus-5': claude(5, 25),
  'anthropic.claude-opus-5-5': claude(4, 20),
  'anthropic.claude-sonnet-5': claude(2, 10),
  'anthropic.claude-sonnet-5-5': claude(2, 10),
  'anthropic.claude-haiku-5-5': claude(0.1, 0.5),
  mock: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'mock-fallback': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'mock-embeddings': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
};

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;

function lastIdSegment(modelId: string): string {
  return modelId.includes('/') ? (modelId.split('/').at(-1) ?? modelId) : modelId;
}

/** `us.amazon.nova-2-lite-v1:0` → `amazon.nova-2-lite-v1:0`; ARNs → their final id segment. */
export function normalizeModelId(modelId: string): string {
  return lastIdSegment(modelId).replace(GEO_PREFIX, '');
}

/** Whether a model id names a regional endpoint: anything but a `global.` inference profile. */
export function isRegionalModelId(modelId: string): boolean {
  return !lastIdSegment(modelId).startsWith('global.');
}

/** Merges price overrides (keys are model ids) over the defaults. */
export function createPricingTable(overrides?: Readonly<Record<string, ModelPrice>>): PricingTable {
  const table: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  for (const [id, price] of Object.entries(overrides ?? {})) {
    if (!(
      price.inputPerMillionUsd >= 0 &&
      price.outputPerMillionUsd >= 0 &&
      (price.cacheReadPerMillionUsd ?? 0) >= 0 &&
      (price.cacheWritePerMillionUsd ?? 0) >= 0 &&
      (price.premium ?? 0) >= 0 &&
      (price.regionalPremium ?? 0) >= 0
    )) {
      throw new RangeError(`Invalid price for model ${id}`);
    }
    table[normalizeModelId(id)] = price;
  }
  return table;
}

interface EffectivePrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

function effective(price: ModelPrice, regional: boolean): EffectivePrice {
  const factor = 1 + (price.premium ?? 0) + (regional ? (price.regionalPremium ?? 0) : 0);
  return {
    input: price.inputPerMillionUsd * factor,
    output: price.outputPerMillionUsd * factor,
    cacheRead: (price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd) * factor,
    cacheWrite: (price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd) * factor,
  };
}

/**
 * Price used for ids missing from the table: the most expensive known rate. Unknown models are
 * never free, so spend caps cannot be bypassed by a configuration typo.
 */
function conservativePrice(table: PricingTable): ModelPrice {
  let input = 0;
  let output = 0;
  for (const price of Object.values(table)) {
    const e = effective(price, true);
    input = Math.max(input, e.input);
    output = Math.max(output, e.output);
  }
  return { inputPerMillionUsd: input, outputPerMillionUsd: output };
}

export function priceFor(
  modelId: string,
  table: PricingTable = DEFAULT_MODEL_PRICES,
): { price: ModelPrice; known: boolean } {
  const price = table[normalizeModelId(modelId)] ?? table[modelId];
  return price ? { price, known: true } : { price: conservativePrice(table), known: false };
}

/**
 * Cost in USD of one call, rounded **up** to the micro-dollar (the `numeric(10, 6)` ledger columns),
 * so many tiny calls never round to zero. Input tokens read from or written to the prompt cache (part of
 * `inputTokens`) are priced at the model's cache rates.
 */
export function costFor(
  modelId: string,
  usage: ModelUsage,
  table: PricingTable = DEFAULT_MODEL_PRICES,
): number {
  const { price } = priceFor(modelId, table);
  const e = effective(price, isRegionalModelId(modelId));
  const input = Math.max(0, usage.inputTokens);
  const read = Math.min(input, Math.max(0, usage.cacheReadInputTokens ?? 0));
  const write = Math.min(input - read, Math.max(0, usage.cacheWriteInputTokens ?? 0));
  const output = Math.max(0, usage.outputTokens);
  const raw =
    ((input - read - write) * e.input + read * e.cacheRead + write * e.cacheWrite + output * e.output) /
    1_000_000;
  if (raw <= 0) return 0;
  return Math.ceil(raw * 1_000_000 - 1e-6) / 1_000_000;
}

/** Sums micro-dollar amounts without accumulating floating-point drift. */
export function sumUsd(amounts: readonly number[]): number {
  return Math.round(amounts.reduce((acc, a) => acc + Math.round(a * 1_000_000), 0)) / 1_000_000;
}
