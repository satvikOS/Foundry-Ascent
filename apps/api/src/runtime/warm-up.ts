import { warmTurnEngine } from '@foundry/core';

import { type Logger } from '../logging.js';

/** How long a process start waits for the turn engine's warm-up (it takes ~0.3-0.5 s of CPU). */
export const INIT_WARM_UP_BUDGET_MS = 3_000;

export interface WarmApiProcessOptions {
  /** The warm-up (default: the turn engine's, packages/core orchestrator/warm-up.ts). */
  readonly warm?: () => Promise<void>;
  readonly budgetMs?: number;
}

/**
 * Warms the turn engine when the API process starts (docs/runbooks/latency.md, "The first turn a process serves"): in
 * the Lambda's init phase, which runs before the container takes any request, and in the dev server before it
 * listens. A warm-up after a response instead runs in the invocation's drain, and a Lambda container that is draining
 * takes no other request, so the call screen's next requests would go to another, perhaps cold, container.
 *
 * Waits at most `budgetMs`; a warm-up that fails or runs over is logged and never fails the start (what it did not
 * finish, the call start or the first turn does). Logs `api.init_warm_up` (`outcome`, `ms`).
 */
export async function warmApiProcess(logger: Logger, options: WarmApiProcessOptions = {}): Promise<void> {
  const started = performance.now();
  const warm = options.warm ?? (() => warmTurnEngine());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.resolve()
      .then(warm)
      .then(
        () => 'done' as const,
        () => 'failed' as const,
      ),
    new Promise<'timed_out'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timed_out');
      }, options.budgetMs ?? INIT_WARM_UP_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  logger.info('api.init_warm_up', { outcome, ms: Math.round(performance.now() - started) });
}
