import type { ModelAttempt, ModelUsage } from './gateway/types.js';

/** USD per one million tokens. */
export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
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

/** Claude on Bedrock: list price at the global endpoint, +10 % at regional ones (Claude 4.5 and later). */
function claude(inputPerMillionUsd: number, outputPerMillionUsd: number): ModelPrice {
  return { inputPerMillionUsd, outputPerMillionUsd, regionalPremium: 0.1 };
}

/**
 * List prices (Amazon Bedrock, us-east-1) at the time of writing. Operators override them through
 * gateway configuration; do not edit code to change a price.
 *
 * Claude rows are Anthropic's list prices (platform.claude.com pricing, checked 2026-10-16), which Bedrock's
 * global endpoints charge; regional endpoints add 10 %. Prompt-cache rates are not modelled: the gateway sends
 * no cache breakpoints, and the tokens a model reads from or writes to its own cache are counted at the input
 * rate (`billedInputTokens`), so the caps never under-count; and Claude Haiku 5.5 is priced at its rate for prompts up to 100,000 tokens
 * (turn prompts stay far below). Bedrock serves Opus 4.6, Sonnet 4.6 and Haiku 4.5 through Converse with
 * the ARN-versioned ids; later models use the short `anthropic.claude-…` ids.
 */
export const DEFAULT_MODEL_PRICES: PricingTable = {
  'openai.gpt-6-luna': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, premium: 0.1 },
  'amazon.nova-2-lite-v1:0': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
  'amazon.titan-embed-text-v2:0': { inputPerMillionUsd: 0.02, outputPerMillionUsd: 0 },
  'anthropic.claude-opus-4-6-v1': claude(5, 25),
  'anthropic.claude-sonnet-4-6': claude(3, 15),
  'anthropic.claude-haiku-4-5-20251001-v1:0': claude(1, 5),
  'anthropic.claude-haiku-4-5': claude(1, 5),
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
      (price.premium ?? 0) >= 0 &&
      (price.regionalPremium ?? 0) >= 0
    )) {
      throw new RangeError(`Invalid price for model ${id}`);
    }
    table[normalizeModelId(id)] = price;
  }
  return table;
}

function effective(price: ModelPrice, regional: boolean): { input: number; output: number } {
  const factor = 1 + (price.premium ?? 0) + (regional ? (price.regionalPremium ?? 0) : 0);
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
 * so many tiny calls never round to zero.
 */
export function costFor(
  modelId: string,
  usage: ModelUsage,
  table: PricingTable = DEFAULT_MODEL_PRICES,
): number {
  const { price } = priceFor(modelId, table);
  const e = effective(price, isRegionalModelId(modelId));
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

// Speech (calls) -------------------------------------------------------------------------------------

/** Amazon Polly engines the platform uses for calls. */
export type SpeechEngine = 'neural' | 'generative';

/** USD per one million characters synthesised. */
export type SpeechPricingTable = Readonly<Record<SpeechEngine, number>>;

/**
 * Amazon Polly list prices per one million characters (https://aws.amazon.com/polly/pricing/, on-demand,
 * us-east-1, checked 2026-10-16): Neural $16.00, Generative $30.00. Polly bills every character of the
 * request text (SSML tags excluded), with no free tier assumed here. Operators override them through
 * configuration; do not edit code to change a price.
 */
export const DEFAULT_SPEECH_PRICES: SpeechPricingTable = {
  neural: 16,
  generative: 30,
};

/** Ledger model id for a speech call (`usage_ledger.model_id`), e.g. `polly.neural`. */
export function speechModelId(engine: SpeechEngine): string {
  return `polly.${engine}`;
}

/** Characters Polly bills for `text` (Unicode code points; SSML is never sent). */
export function speechCharacters(text: string): number {
  return Array.from(text).length;
}

/**
 * Cost in USD of synthesising `characters` characters, rounded **up** to the micro-dollar like model
 * calls. An unknown engine is priced at the most expensive known rate.
 */
export function speechCostFor(
  engine: SpeechEngine,
  characters: number,
  table: SpeechPricingTable = DEFAULT_SPEECH_PRICES,
): number {
  const known: number | undefined = Object.hasOwn(table, engine) ? table[engine] : undefined;
  const perMillion = known ?? Math.max(...Object.values(table));
  const raw = (Math.max(0, characters) * perMillion) / 1_000_000;
  if (raw <= 0) return 0;
  return Math.ceil(raw * 1_000_000 - 1e-6) / 1_000_000;
}

const UNBILLED_SPEECH_OUTCOMES: ReadonlySet<ModelAttempt['outcome']> = new Set(['throttled', 'client_error']);

/**
 * One priced, billable speech call as a `ModelAttempt`, so it is written to `usage_ledger` (purpose
 * `speech`) and counted against the spend caps exactly like a model call. Characters are recorded as
 * input units; there is no output count.
 */
export function speechAttempt(args: {
  engine: SpeechEngine;
  characters: number;
  latencyMs: number;
  outcome?: ModelAttempt['outcome'];
  errorName?: string | null;
  table?: SpeechPricingTable;
}): ModelAttempt {
  const outcome = args.outcome ?? 'ok';
  const characters = Math.max(0, Math.round(args.characters));
  return {
    provider: 'polly',
    modelId: speechModelId(args.engine),
    kind: 'initial',
    outcome,
    latencyMs: Math.max(0, Math.round(args.latencyMs)),
    usage: { inputTokens: characters, outputTokens: 0 },
    errorName: args.errorName ?? null,
    // A request Polly refused (throttled, rejected as invalid) is not billed. Anything that may have been
    // synthesised (served, aborted mid-stream, failed in transit) is, so the caps never under-count.
    costUsd: UNBILLED_SPEECH_OUTCOMES.has(outcome) ? 0 : speechCostFor(args.engine, characters, args.table),
  };
}
