import { asksForJudgement, type ThinkEffort } from '@foundry/ai';
import { type TurnChannel } from '@foundry/contracts';

import { type PathPromptGuidance } from '../path/ai-adapter.js';

/**
 * Which turns let the model reason before it answers (`CORE_THINK`, off by default): `judgement`, typed turns that read a
 * fact (news, a judgement asked for, an ask with no answer of the program's and nothing the server opens with); `typed`,
 * every typed turn that coaches. Never a call (its first word is heard), a recall (the record is the answer), a social turn,
 * role-play or a crisis.
 */
export const THINK_MODES = ['off', 'judgement', 'typed'] as const;
export type ThinkMode = (typeof THINK_MODES)[number];

export function thinkFor(
  mode: ThinkMode,
  turn: {
    readonly channel: TurnChannel;
    readonly guidance: PathPromptGuidance | null;
    /** The turn coaches: no social turn, wrap-up, safety flag, distress or question about the coach. */
    readonly coaches: boolean;
  },
): ThinkEffort | null {
  const { guidance } = turn;
  if (mode === 'off' || turn.channel !== 'text' || !turn.coaches || guidance === null) return null;
  if (guidance.kind === 'recall' || guidance.kind === 'social' || guidance.kind === 'rehearsal') return null;
  return mode === 'typed' || asksForJudgement(guidance) ? 'low' : null;
}
