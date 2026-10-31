import { type PlatformSettingsView } from '@foundry/contracts';
import { type auditRepo, usageRepo } from '@foundry/db';

import { type RequestContext } from '../context.js';
import { DomainError } from '../errors.js';
import { type Kit } from '../internal/kit.js';
import { secondsUntilUtcMidnight } from './sampling.js';

export interface SpendState {
  readonly globalUsd: number;
  readonly principalUsd: number;
}

/** Pure cap rule (unit tested): either cap reached → blocked. A cap of 0 blocks all spend. */
export function spendCapExceeded(
  state: SpendState,
  settings: Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'>,
): 'global' | 'principal' | null {
  if (state.globalUsd >= settings.dailyUsdCapGlobal) return 'global';
  if (state.principalUsd >= settings.dailyUsdCapPerPrincipal) return 'principal';
  return null;
}

/**
 * Today's spend (UTC day) on `usage_ledger`: the platform's, and the person's unless `globalOnly` (one
 * autocommit statement each, outside any request transaction).
 */
export async function readSpendState(kit: Kit, ctx: RequestContext, globalOnly = false): Promise<SpendState> {
  return kit.system(
    async (sx) => ({
      globalUsd: await usageRepo.spendToday(sx),
      principalUsd: globalOnly ? 0 : await usageRepo.spendToday(sx, { principalId: ctx.principalId }),
    }),
    { transaction: false },
  );
}

/** Refuses (audited `spend_cap.reached`, `spend_cap_reached` until UTC midnight) when `state` reaches a cap. */
export async function enforceSpendCaps(
  kit: Kit,
  ctx: RequestContext,
  state: SpendState,
  settings: Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'>,
  context: { readonly ventureId: string | null; readonly operation: string },
): Promise<void> {
  const exceeded = spendCapExceeded(state, settings);
  if (exceeded === null) return;
  await kit.flushDeferred(ctx, [
    {
      action: 'spend_cap.reached',
      outcome: 'blocked',
      ventureId: context.ventureId,
      objectType: context.operation,
      policyReason: `${exceeded}_daily_cap`,
      metadata: { scope: exceeded },
    } satisfies auditRepo.AuditEventInput,
  ]);
  throw new DomainError(
    'spend_cap_reached',
    exceeded === 'global'
      ? 'The daily AI budget for the platform has been reached. Coaching resumes tomorrow (UTC).'
      : 'You have reached your daily AI coaching budget. It resets at midnight UTC.',
    { retryAfterSeconds: secondsUntilUtcMidnight(kit.now()), reason: `${exceeded}_daily_cap` },
  );
}

/**
 * Daily AI spend caps from `platform_settings`, measured on `usage_ledger` for the current UTC day
 * (checked on session create and session recap; a turn's admission enforces them under its lock with
 * `app.spend_cap_state`, the same rows and the same refusal). Reaching a cap throws
 * `spend_cap_reached` (retry after UTC midnight) and is audited.
 */
export async function assertWithinSpendCaps(
  kit: Kit,
  ctx: RequestContext,
  settings: Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'>,
  context: {
    readonly ventureId: string | null;
    readonly operation: string;
    /** `global`: only the platform's cap applies (call speech, bounded by call minutes and speech budgets). */
    readonly caps?: 'all' | 'global';
  },
): Promise<void> {
  const state = await readSpendState(kit, ctx, context.caps === 'global');
  await enforceSpendCaps(kit, ctx, state, settings, context);
}
