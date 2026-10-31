/**
 * The API process's start-up warm-up (warm-up.ts): it waits for the turn engine's warm-up at most its budget, and a
 * warm-up that fails, throws or never ends never fails the start.
 */
import { describe, expect, it } from 'vitest';

import { createJsonLogger } from '../logging.js';
import { warmApiProcess } from './warm-up.js';

function recordingLogger(): {
  logger: ReturnType<typeof createJsonLogger>;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const logger = createJsonLogger({
    level: 'info',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('warming the API process at start', () => {
  it('waits for the warm-up and logs how long it took', async () => {
    const { logger, lines } = recordingLogger();
    let ran = false;
    await warmApiProcess(logger, {
      warm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        ran = true;
      },
    });
    expect(ran).toBe(true);
    const line = lines.find((l) => l.event === 'api.init_warm_up');
    expect(line?.outcome).toBe('done');
    expect(typeof line?.ms).toBe('number');
  });

  it.each([
    ['rejects', 'failed', () => Promise.reject(new Error('warm-up failed'))],
    [
      'throws',
      'failed',
      () => {
        throw new Error('warm-up failed at once');
      },
    ],
    ['never ends', 'timed_out', () => new Promise<void>(() => undefined)],
  ] as const)('starts all the same when the warm-up %s', async (_what, outcome, warm) => {
    const { logger, lines } = recordingLogger();
    const started = performance.now();
    await expect(warmApiProcess(logger, { warm, budgetMs: 50 })).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(lines.find((l) => l.event === 'api.init_warm_up')?.outcome).toBe(outcome);
  });
});
