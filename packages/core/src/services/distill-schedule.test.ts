import { describe, expect, it } from 'vitest';

import { DEFAULT_CORE_CONFIG } from '../config.js';
import { distillSkipReason } from './distill-rules.js';

/**
 * LAB-K1: how soon a chat's memory lands, and what it costs, under the distillation schedule. Each completed turn
 * queues a job `turnDelaySeconds` later carrying its turn count; a job distils (one model call) unless a later turn
 * superseded it, there is nothing new, or the chat had a turn within `activeWindowSeconds` (distillSkipReason, the
 * production rule). Founder pauses between messages: a quick exchange, one with reading and thinking pauses of
 * two to four minutes, and one with a ten-minute break.
 */
const CHATS: Readonly<Record<string, readonly number[]>> = {
  quick: [30, 45, 40, 60, 35],
  reading: [60, 150, 90, 240, 45, 180],
  break: [40, 600, 50, 70],
};

interface Schedule {
  readonly turnDelaySeconds: number;
  readonly activeWindowSeconds: number;
}

/** Distillation calls one chat makes, and seconds from its first turn to the first distillation. */
function simulate(gaps: readonly number[], schedule: Schedule): { calls: number; firstAfter: number } {
  const times = gaps.reduce<number[]>((acc, gap) => [...acc, (acc.at(-1) ?? 0) + gap], [0]);
  const jobs = times
    .map((t, i) => ({ at: t + schedule.turnDelaySeconds, queued: i + 1 }))
    .sort((a, b) => a.at - b.at);
  let version = 0;
  let calls = 0;
  let firstAfter = Number.POSITIVE_INFINITY;
  for (const job of jobs) {
    const done = times.filter((t) => t <= job.at);
    const state = {
      privacy: 'standard' as const,
      deletedAt: null,
      digestDeletedAt: null,
      completedTurns: done.length,
      distillVersion: version,
      status: 'active' as const,
      lastActivityAt: new Date((done.at(-1) ?? 0) * 1000).toISOString(),
    };
    if (
      distillSkipReason(state, new Date(job.at * 1000), schedule.activeWindowSeconds, job.queued) !== null
    ) {
      continue;
    }
    calls += 1;
    version = done.length;
    firstAfter = Math.min(firstAfter, job.at);
  }
  return { calls, firstAfter };
}

describe('distillation schedule (LAB-K1: why chats keep their schedule)', () => {
  const current = DEFAULT_CORE_CONFIG.distillation;
  const sooner: Schedule = { turnDelaySeconds: 120, activeWindowSeconds: 100 };

  it('distils a chat about once today, nine minutes after its last turn', () => {
    expect(current).toMatchObject({ turnDelaySeconds: 540, activeWindowSeconds: 480 });
    const runs = Object.values(CHATS).map((gaps) => simulate(gaps, current));
    expect(runs.map((r) => r.calls)).toEqual([1, 1, 2]);
  });

  it('would distil it about 75 % more often after a two-minute idle: every longer pause splits it', () => {
    const today = Object.values(CHATS).map((gaps) => simulate(gaps, current).calls);
    const idle = Object.values(CHATS).map((gaps) => simulate(gaps, sooner).calls);
    expect(idle).toEqual([1, 4, 2]);
    const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
    // 7 calls instead of 4 for the same three chats: the notebook is rewritten on each.
    expect(sum(idle) / sum(today)).toBeCloseTo(1.75, 2);
    // Memory still lands minutes into a chat, not with the turn that stated it.
    expect(
      Math.min(...Object.values(CHATS).map((gaps) => simulate(gaps, sooner).firstAfter)),
    ).toBeGreaterThanOrEqual(120);
  });
});
