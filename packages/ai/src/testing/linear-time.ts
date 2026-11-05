// Test-only helper (not exported from the package index): that a piece of work grows linearly with its input.
import { expect } from 'vitest';

/** `process.threadCpuUsage` (Node 23.9+), which @types/node 22 does not declare. */
interface ThreadCpu {
  threadCpuUsage?: () => { user: number; system: number };
}

/**
 * CPU time of this thread so far, in milliseconds. Other processes on the machine (a parallel test run, a shared CI
 * runner) stretch wall-clock time but not this, and neither do the other test workers. Before Node 23.9: the process.
 */
export function cpuMs(): number {
  const usage = (process as ThreadCpu).threadCpuUsage?.() ?? process.cpuUsage();
  return (usage.user + usage.system) / 1_000;
}

export interface LinearTimeOptions {
  /** How many times larger the large input is than the small one (default 8). */
  factor?: number;
  /**
   * The ratio of the two sizes' times must stay below `factor ** exponent` (default 1.5: 22.6 for a factor of 8):
   * well above linear (8) and well below quadratic (64).
   */
  exponent?: number;
  /** Least CPU time of one sample of the small input, in ms: the work repeats until a sample takes about this long. */
  sampleMs?: number;
  /** Interleaved samples of each size per attempt; the least of each counts (default 5). */
  samples?: number;
  /** Attempts before the check fails (default 2): a super-linear cost fails every one. */
  attempts?: number;
  /**
   * Most CPU time one run of the small input may take, in ms (default: none). A window that bounds what is read
   * makes both sizes cost the same, however slow each is: this catches a cost that is bounded but far too large
   * (a regular expression that backtracks exponentially within the window).
   */
  budgetMs?: number;
}

export interface Scaling {
  /** Least CPU time of a sample of the small and of the large input, in ms. */
  small: number;
  large: number;
  /** `large / small`, and the bound it must stay below. */
  ratio: number;
  bound: number;
  /** Runs of the work in each sample. */
  runs: number;
}

/**
 * The CPU time of the work `prepare(size)` returns, at `size` and at `factor × size`. The input is built outside the
 * timing (`prepare` builds it and returns the work on it). Both sizes are warmed up, then sampled interleaved, so a
 * burst of load or a garbage collection slows one sample, not one size; the least sample of each size counts. Each
 * sample repeats the work until the small one takes about `sampleMs`, so the timer's resolution and fixed costs are
 * small next to it: there is no absolute allowance in the ratio.
 */
export function measureScaling(
  prepare: (size: number) => () => void,
  size: number,
  options: LinearTimeOptions = {},
): Scaling {
  const factor = options.factor ?? 8;
  const bound = factor ** (options.exponent ?? 1.5);
  const smallWork = prepare(size);
  const largeWork = prepare(size * factor);
  for (let i = 0; i < 2; i += 1) {
    smallWork();
    largeWork();
  }
  let runs = 1;
  const sample = (work: () => void): number => {
    const started = cpuMs();
    for (let i = 0; i < runs; i += 1) work();
    return cpuMs() - started;
  };
  // Twice the runs until a sample of the small input takes `sampleMs` (one run, still warming up, can be slow).
  while (runs < 65_536 && sample(smallWork) < (options.sampleMs ?? 25)) runs *= 2;
  let small = Infinity;
  let large = Infinity;
  for (let i = 0; i < (options.samples ?? 5); i += 1) {
    small = Math.min(small, sample(smallWork));
    large = Math.min(large, sample(largeWork));
  }
  return { small, large, ratio: large / Math.max(small, 0.001), bound, runs };
}

/**
 * Expects the work `prepare(size)` returns to take about `factor` times as long at `factor × size` as at `size`, never
 * `factor²` (a quadratic cost: one round per item, or a regular expression that backtracks over what it read): see
 * {@link measureScaling}. A ratio at or above the bound is measured again, up to `attempts` times in all, as a
 * super-linear cost is above it every time and a sample slowed by the machine is not.
 */
export function expectLinearTime(
  prepare: (size: number) => () => void,
  size: number,
  options: LinearTimeOptions = {},
): Scaling {
  let scaling = measureScaling(prepare, size, options);
  for (let attempt = 1; attempt < (options.attempts ?? 2) && scaling.ratio >= scaling.bound; attempt += 1) {
    scaling = measureScaling(prepare, size, options);
  }
  const { small, large, ratio, bound, runs } = scaling;
  const report =
    `${runs} run(s) at size ${size} took ${small.toFixed(1)} ms of CPU and at ${size * (options.factor ?? 8)} ` +
    `${large.toFixed(1)} ms: ${ratio.toFixed(1)} times as long (bound ${bound.toFixed(1)})`;
  if (process.env.LINEAR_TIME_REPORT === '1') console.warn(`linear-time: ${report}`);
  expect(ratio, report).toBeLessThan(bound);
  if (options.budgetMs !== undefined) expect(small / runs, report).toBeLessThan(options.budgetMs);
  return scaling;
}
