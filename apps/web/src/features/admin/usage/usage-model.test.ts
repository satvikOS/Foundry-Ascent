import { describe, expect, it } from 'vitest';

import { capState, describeModel, fillDays, niceCeil } from './usage-model';

const NOW = Date.parse('2026-10-05T15:30:00Z');

describe('usage model', () => {
  it('fills a continuous 30-day UTC series ending today, merging duplicate days', () => {
    const series = fillDays(
      [
        { day: '2026-10-05', usd: 0.25, turns: 3 },
        { day: '2026-10-01', usd: 1.5, turns: 10 },
        { day: '2026-10-01', usd: 0.5, turns: 2 },
        { day: '2026-08-01', usd: 9, turns: 99 }, // outside the window
      ],
      30,
      NOW,
    );
    expect(series).toHaveLength(30);
    expect(series[0]?.day).toBe('2026-09-06');
    expect(series.at(-1)).toEqual({ day: '2026-10-05', usd: 0.25, turns: 3 });
    expect(series.find((p) => p.day === '2026-10-01')).toEqual({ day: '2026-10-01', usd: 2, turns: 12 });
    expect(series.find((p) => p.day === '2026-10-02')).toEqual({ day: '2026-10-02', usd: 0, turns: 0 });
    expect(series.reduce((sum, p) => sum + p.turns, 0)).toBe(15);
  });

  it('rounds axis maxima to clean values', () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(0.37)).toBeCloseTo(0.4);
    expect(niceCeil(5.5)).toBe(6);
    expect(niceCeil(2.2)).toBe(2.5);
    expect(niceCeil(48)).toBe(50);
    expect(niceCeil(81)).toBe(100);
  });

  it('classifies spend against the cap', () => {
    expect(capState(1, 5)).toBe('ok');
    expect(capState(4, 5)).toBe('approaching');
    expect(capState(5, 5)).toBe('reached');
    expect(capState(0, 0)).toBe('ok');
  });

  it('names the configured Bedrock models', () => {
    expect(describeModel('us.amazon.nova-2-lite-v1:0')).toEqual({
      name: 'Nova 2 Lite (US profile)',
      role: 'Primary reasoning',
    });
    expect(describeModel('global.amazon.nova-2-lite-v1:0').role).toBe('Fallback reasoning');
    expect(describeModel('openai.gpt-6-luna').role).toMatch(/disabled/);
    expect(describeModel('amazon.titan-embed-text-v2:0').role).toBe('Embeddings');
    expect(describeModel('mock-fallback').name).toBe('Mock provider (fallback)');
    expect(describeModel('something-else')).toEqual({ name: 'something-else', role: 'Other' });
  });
});
