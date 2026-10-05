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
 * Daily AI spend caps from `platform_settings`, measured on `usage_ledger` for the current UTC day
 * (checked on session create, every turn and session recap). Reaching a cap throws
 * `spend_cap_reached` (retry after UTC midnight) and is audited.
 */
export async function assertWithinSpendCaps(
  kit: Kit,
  ctx: RequestContext,
  settings: Pick<PlatformSettingsView, 'dailyUsdCapGlobal' | 'dailyUsdCapPerPrincipal'>,
  context: { readonly ventureId: string | null; readonly operation: string },
): Promise<void> {
  const state = await kit.system(
    async (sx) => ({
      globalUsd: await usageRepo.spendToday(sx),
      principalUsd: await usageRepo.spendToday(sx, { principalId: ctx.principalId }),
    }),
    { transaction: false },
  );
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
