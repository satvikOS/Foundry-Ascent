import { describe, expect, it } from 'vitest';

import { ReasoningFilter, stripReasoning } from './reasoning-filter.js';

/** Feeds `text` in chunks of `size` characters and returns what the filter handed on. */
function streamed(text: string, size: number): { out: string; dropped: number } {
  const filter = new ReasoningFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
  out += filter.end();
  return { out, dropped: filter.dropped };
}

// LAB-M1 (run 39081466804, SM-13): Nova 2 Lite's reasoning, paraphrased, as it reached a call.
const THINKING =
  "<thinking>Okay, let's see. The founder says they have five interviews. First, I need to figure out the mode.</thinking>";
const REPLY = 'Five interviews is a solid start. What surprised you most?';

describe('ReasoningFilter', () => {
  it('drops a reasoning block before the reply, whatever the chunking', () => {
    for (const size of [1, 2, 3, 7, 16, 1_000]) {
      const { out, dropped } = streamed(`${THINKING}\n\n${REPLY}`, size);
      expect(out, `chunks of ${String(size)}`).toBe(REPLY);
      expect(dropped).toBeGreaterThan(THINKING.length - 1);
    }
  });

  it('drops blocks in the middle and every tag spelling, and keeps the reply around them', () => {
    expect(stripReasoning(`Start small. <THINK>the rules say one question</THINK>What did they pay?`)).toBe(
      'Start small. What did they pay?',
    );
    expect(stripReasoning('<reasoning type="internal">plan</reasoning>Hi Maya.')).toBe('Hi Maya.');
  });

  it('drops the rest of a stream whose block never closes', () => {
    for (const size of [1, 5, 1_000]) {
      expect(streamed(`<thinking>The founder says hi. I need to`, size).out).toBe('');
    }
  });

  it('never holds back or changes a "<" that does not open a reasoning tag', () => {
    const prose = 'Keep churn < 5% and use <b>bold</b> sparingly; a <think-tank> is fine too.';
    for (const size of [1, 4, 1_000]) expect(streamed(prose, size).out).toBe(prose);
    // A partial tag is held only until it is known, and handed on at the end when it never completed.
    const filter = new ReasoningFilter();
    expect(filter.push('Margins <thin')).toBe('Margins ');
    expect(filter.end()).toBe('<thin');
  });
});
