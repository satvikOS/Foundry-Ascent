import {
  SAFETY_SCREEN_MAX_OUTPUT_TOKENS,
  SAFETY_SCREEN_SCHEMA_NAME,
  SAFETY_SCREEN_SYSTEM_PROMPT,
  SAFETY_SCREEN_TIMEOUT_MS,
  SafetyScreenVerdict,
  buildSafetyScreenMessages,
  ideationPrefilter,
  isModelGatewayError,
  safetyScreenOutcome,
  type SafetyScreenOutcome,
} from '@foundry/ai';

import { type Kit } from '../internal/kit.js';
import { meteredStructured, type Meter } from '../internal/metered.js';

export interface SafetyScreenArgs {
  /** Who the call is billed to (`classification` for a founder's turn, `test_bench` in the EIR studio). */
  readonly meter: Meter;
  readonly founderText: string;
  /** The vEIR's previous reply as the founder heard it (or the opener); null when there is none. */
  readonly previousReply: string | null;
  /** The deterministic rules already found a crisis: the screen has nothing to add and never runs. */
  readonly crisis: boolean;
  /** The caller's cancellation (client gone). */
  readonly signal?: AbortSignal;
}

/**
 * The second opinion on indirect suicidal ideation (packages/ai risk/safety-screen.ts): when the deterministic rules
 * found no crisis and the ideation prefilter flags the founder's words, a short structured call on the primary model
 * (with the gateway's fallback, inside one {@link SAFETY_SCREEN_TIMEOUT_MS} budget) reads the message with the vEIR's
 * previous reply.
 *
 * Returns null when it did not run (no prefilter hit, or already a crisis), which is almost every message: they pay
 * for neither a call nor any latency. `failed` (an error, a refusal, invalid output or the time running out) adds no
 * flag, so the turn goes on exactly as the rules decided, and is logged as `turn.safety_screen_failed`. The call is
 * metered like every model call (its usage-ledger rows count towards the spend caps). Logs carry ids, families,
 * codes and timings, never text.
 */
export async function screenIndirectIdeation(
  kit: Kit,
  args: SafetyScreenArgs,
): Promise<SafetyScreenOutcome | null> {
  if (args.crisis) return null;
  const prefilter = ideationPrefilter(args.founderText);
  if (!prefilter.hit) return null;
  const { logger } = kit.deps;
  const started = performance.now();
  const timeout = AbortSignal.timeout(SAFETY_SCREEN_TIMEOUT_MS);
  const fields = {
    requestId: args.meter.ctx.requestId,
    purpose: args.meter.purpose,
    families: prefilter.families.join(','),
  };
  try {
    const result = await meteredStructured(kit, args.meter, {
      system: SAFETY_SCREEN_SYSTEM_PROMPT,
      messages: buildSafetyScreenMessages({
        founderText: args.founderText,
        previousReply: args.previousReply,
      }),
      schemaName: SAFETY_SCREEN_SCHEMA_NAME,
      zodSchema: SafetyScreenVerdict,
      maxOutputTokens: SAFETY_SCREEN_MAX_OUTPUT_TOKENS,
      timeoutMs: SAFETY_SCREEN_TIMEOUT_MS,
      // One budget for the primary model and the fallback: the router gives the fallback its own, longer one.
      signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout,
    });
    const outcome = safetyScreenOutcome(result.value);
    logger.info('turn.safety_screen', {
      ...fields,
      outcome,
      modelId: result.modelId,
      fallbackUsed: result.fallbackUsed,
      latencyMs: Math.round(performance.now() - started),
    });
    return outcome;
  } catch (err) {
    logger.warn('turn.safety_screen_failed', {
      ...fields,
      code: isModelGatewayError(err) ? err.code : err instanceof Error ? err.name : 'unknown',
      timedOut: timeout.aborted,
      cancelled: args.signal?.aborted === true,
      latencyMs: Math.round(performance.now() - started),
    });
    return 'failed';
  }
}
