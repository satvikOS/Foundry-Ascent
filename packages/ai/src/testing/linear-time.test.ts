import { describe, expect, it } from 'vitest';

import { cpuMs, expectLinearTime, measureScaling } from './linear-time.js';

/** Where the work leaves its result, so that it is never optimised away. */
let sink = 0;

/** One pass over the input. */
const linear = (n: number) => {
  const items = Array.from({ length: n * 64 }, (_, i) => i);
  return () => {
    let sum = 0;
    for (const item of items) sum += item;
    sink += sum;
  };
};

/** One pass over everything before each item: one round per item. */
const quadratic = (n: number) => () => {
  let sum = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) sum += i ^ j;
  sink += sum;
};

/** A regular expression that, unanchored, reads the rest of the text from every position and never matches. */
const backtracking = (n: number) => {
  const text = 'a'.repeat(n);
  return () => {
    if (/a+b/u.test(text)) sink += 1;
  };
};

describe('expectLinearTime', () => {
  it('counts CPU time, which only goes forward', () => {
    const before = cpuMs();
    linear(1_000)();
    expect(cpuMs()).toBeGreaterThanOrEqual(before);
  });

  it('passes work that grows linearly with its input', () => {
    const scaling = expectLinearTime(linear, 500);
    expect(scaling.ratio).toBeLessThan(scaling.bound);
    expect(sink).toBeGreaterThan(0);
  }, 120_000);

  it.each([
    ['one round per item', quadratic, 400],
    ['a regular expression that backtracks', backtracking, 400],
  ] as const)(
    'fails work that grows quadratically: %s',
    (_what, work, size) => {
      const scaling = measureScaling(work, size);
      expect(scaling.ratio).toBeGreaterThan(scaling.bound);
      expect(() => expectLinearTime(work, size, { attempts: 1 })).toThrow(/times as long/);
    },
    120_000,
  );
});
