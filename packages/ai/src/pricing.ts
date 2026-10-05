import type { ModelUsage } from './gateway/types.js';

/** USD per one million tokens. */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Fractional surcharge applied to the whole call (0.10 = +10 %), e.g. in-region Mantle premium. */
  premium?: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

/**
 * List prices (Amazon Bedrock, us-east-1) at the time of writing. Operators override them through
 * gateway configuration; do not edit code to change a price.
 */
export const DEFAULT_MODEL_PRICES: PricingTable = {
  'openai.gpt-6-luna': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, premium: 0.1 },
  'amazon.nova-2-lite-v1:0': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
  'amazon.titan-embed-text-v2:0': { inputPerMillionUsd: 0.02, outputPerMillionUsd: 0 },
  mock: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'mock-fallback': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'mock-embeddings': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
};

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|us-gov|global)\./;

/** `us.amazon.nova-2-lite-v1:0` → `amazon.nova-2-lite-v1:0`; ARNs → their final id segment. */
export function normalizeModelId(modelId: string): string {
  const id = modelId.includes('/') ? (modelId.split('/').at(-1) ?? modelId) : modelId;
  return id.replace(GEO_PREFIX, '');
}

/** Merges price overrides (keys are model ids) over the defaults. */
export function createPricingTable(overrides?: Readonly<Record<string, ModelPrice>>): PricingTable {
  const table: Record<string, ModelPrice> = { ...DEFAULT_MODEL_PRICES };
  for (const [id, price] of Object.entries(overrides ?? {})) {
    if (!(price.inputPerMillionUsd >= 0 && price.outputPerMillionUsd >= 0 && (price.premium ?? 0) >= 0)) {
      throw new RangeError(`Invalid price for model ${id}`);
    }
    table[normalizeModelId(id)] = price;
  }
  return table;
}

function effective(price: ModelPrice): { input: number; output: number } {
  const factor = 1 + (price.premium ?? 0);
  return { input: price.inputPerMillionUsd * factor, output: price.outputPerMillionUsd * factor };
}

/**
 * Price used for ids missing from the table: the most expensive known rate. Unknown models are
 * never free, so spend caps cannot be bypassed by a configuration typo.
 */
function conservativePrice(table: PricingTable): ModelPrice {
  let input = 0;
  let output = 0;
  for (const price of Object.values(table)) {
    const e = effective(price);
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
 * so many tiny calls never round to zero.
 */
export function costFor(
  modelId: string,
  usage: ModelUsage,
  table: PricingTable = DEFAULT_MODEL_PRICES,
): number {
  const { price } = priceFor(modelId, table);
  const e = effective(price);
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const raw = (input * e.input + output * e.output) / 1_000_000;
  if (raw <= 0) return 0;
  return Math.ceil(raw * 1_000_000 - 1e-6) / 1_000_000;
}

/** Sums micro-dollar amounts without accumulating floating-point drift. */
export function sumUsd(amounts: readonly number[]): number {
  return Math.round(amounts.reduce((acc, a) => acc + Math.round(a * 1_000_000), 0)) / 1_000_000;
}
