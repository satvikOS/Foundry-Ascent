import { type DistillService, type Orchestrator } from '@foundry/core';

/**
 * The turn route's orchestrator with distillation queued after every completed turn: the single call site of
 * the turn trigger, so the orchestrator itself stays unaware of it. `runTurn` resolves after the turn is
 * committed and its final event emitted; the trigger then queues the conversation's distillation, delayed
 * (core `distill.afterTurn`: standard conversations only, never failing the turn). Replayed turns queue
 * nothing new.
 */
export function distillAfterTurn(
  orchestrator: Pick<Orchestrator, 'runTurn'>,
  distill: Pick<DistillService, 'afterTurn'>,
): Pick<Orchestrator, 'runTurn'> {
  return {
    runTurn: async (ctx, sessionId, input, emit, options) => {
      const outcome = await orchestrator.runTurn(ctx, sessionId, input, emit, options);
      if (outcome.status === 'completed' && !outcome.replayed) await distill.afterTurn(ctx, sessionId);
      return outcome;
    },
  };
}
