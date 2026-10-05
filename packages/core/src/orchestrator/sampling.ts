import { type CoachResponse, type ValidatorResults } from '@foundry/contracts';

/**
 * EIR calibration sampling: every high-risk turn (pre-classified high risk, forced escalation, or a
 * P0/P1 escalation proposed by the coach) plus `rate` of ordinary completed turns. Blocked, failed and
 * crisis turns are never sampled (nothing to calibrate, and crisis content stays with the founder).
 */
export function shouldSampleForReview(args: {
  readonly status: 'completed' | 'blocked' | 'failed';
  readonly riskLabel: string;
  readonly validator: Pick<ValidatorResults, 'escalationForced'> | null;
  readonly response: Pick<CoachResponse, 'escalation'> | null;
  readonly rate: number;
  readonly random: () => number;
}): boolean {
  if (args.status !== 'completed' || args.riskLabel === 'crisis') return false;
  const escalation = args.response?.escalation;
  const highRisk =
    args.riskLabel === 'high' ||
    args.validator?.escalationForced === true ||
    (escalation?.required === true && (escalation.priority === 'P0' || escalation.priority === 'P1'));
  if (highRisk) return true;
  return args.random() < args.rate;
}

/** Seconds until the next UTC midnight (daily spend caps reset then). */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
