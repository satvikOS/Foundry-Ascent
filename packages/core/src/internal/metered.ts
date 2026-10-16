import {
  isModelGatewayError,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type ModelAttempt,
  type ModelPurpose,
} from '@foundry/ai';

import { type RequestContext } from '../context.js';
import { type Kit } from './kit.js';

/** Who a metered call is billed to: the usage-ledger row of every attempt (spend caps read the ledger). */
export interface Meter {
  readonly ctx: Pick<RequestContext, 'tenantId' | 'requestId'> & { readonly principalId: string | null };
  readonly ventureId: string | null;
  readonly purpose: ModelPurpose;
}

/** The billable attempts a call reports: their model, usage and cost. */
export type MeteredAttempt = Pick<ModelAttempt, 'modelId' | 'usage' | 'costUsd'>;

/**
 * Runs a billable call and records one usage-ledger row per attempt, on success and on failure alike: a failed
 * call may still have been billed (a timed-out or invalid model answer costs tokens). `attemptsOnError` reads
 * the attempts a failure carries (default: a `ModelGatewayError`'s `attempts`); the error is rethrown.
 *
 * Ledger writes never throw (`Kit.recordUsage`). Callers check the kill switch and the spend caps first.
 */
export async function metered<T extends { readonly attempts: readonly MeteredAttempt[] }>(
  kit: Kit,
  meter: Meter,
  call: () => Promise<T>,
  attemptsOnError: (err: unknown) => readonly MeteredAttempt[] = (err) =>
    isModelGatewayError(err) ? err.attempts : [],
): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (err) {
    await kit.recordUsage({ ...meter, attempts: attemptsOnError(err) });
    throw err;
  }
  await kit.recordUsage({ ...meter, attempts: result.attempts });
  return result;
}

/** `gateway.generateStructured` for `meter.purpose`, metered (see {@link metered}). */
export function meteredStructured<T>(
  kit: Kit,
  meter: Meter,
  request: Omit<GenerateStructuredRequest<T>, 'purpose' | 'requestId'>,
): Promise<GenerateStructuredResult<T>> {
  return metered(kit, meter, () =>
    kit.deps.gateway.generateStructured({
      ...request,
      purpose: meter.purpose,
      requestId: meter.ctx.requestId,
    }),
  );
}

/** `gateway.embed` for `meter.purpose` (`embedding`), metered as one call (see {@link metered}). */
export async function meteredEmbed(kit: Kit, meter: Meter, texts: readonly string[]): Promise<EmbedResult> {
  return metered(kit, meter, async () => {
    const embedded = await kit.deps.gateway.embed(texts, {
      purpose: meter.purpose,
      requestId: meter.ctx.requestId,
    });
    return {
      ...embedded,
      attempts: [{ modelId: embedded.modelId, usage: embedded.usage, costUsd: embedded.costUsd }],
    };
  });
}
