import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { conversationCraftRules } from '../prompts/craft.js';
import { inventedFigures, withoutExampleFigures } from './figures.js';

/**
 * The figure cases the product and the lab's live checks read the same way (evals/tests/fixtures/figure_cases.json;
 * ops/lab tests/test_live_pipeline.py reads the same file through `run_checks`).
 */
interface FigureCase {
  readonly reply: string;
  readonly known: string;
  readonly unsourced: number;
  readonly proposed: number;
}
const CASES = (
  JSON.parse(
    readFileSync(new URL('../../../../evals/tests/fixtures/figure_cases.json', import.meta.url), 'utf8'),
  ) as { cases: FigureCase[] }
).cases;

describe('figures nobody gave, read as the lab reads them (lab run 42238272157: "say, 50–100 cedis an hour")', () => {
  it.each(CASES.map((c) => [c.reply, c] as const))('%s', (_reply, c) => {
    const found = inventedFigures(c.reply, c.known);
    expect({ unsourced: found.unsourced.length, proposed: found.proposed.length }).toEqual({
      unsourced: c.unsourced,
      proposed: c.proposed,
    });
  });

  it('reads a local currency by its word, code or sign, and a range as one figure', () => {
    expect(inventedFigures('a local tutor at, say, 50–100 cedis an hour', '').unsourced).toEqual([
      '50–100 cedis',
    ]);
    expect(inventedFigures('about GHS 80 a session', '').unsourced).toEqual(['GHS 80']);
    expect(inventedFigures('₦5,000 a month', '').unsourced).toEqual(['₦5,000']);
    expect(inventedFigures('KSh 200 each', '').unsourced).toEqual(['KSh 200']);
    // Theirs, both ends of the range: nothing is invented.
    expect(
      inventedFigures('Between 50 and 100 cedis, as you said: 50–100 cedis.', 'we charge 50 to 100 cedis'),
    ).toEqual({
      unsourced: [],
      proposed: [],
    });
    // One end of a range nobody gave makes the range made up.
    expect(inventedFigures('50–120 cedis', 'we charge 50 cedis').unsourced).toEqual(['50–120 cedis']);
  });

  it('leaves out an example price set off by commas, and the preposition it hung from', () => {
    expect(
      withoutExampleFigures('Compare it with a local tutor at, say, 50–100 cedis an hour.', '').text,
    ).toBe('Compare it with a local tutor.');
    expect(withoutExampleFigures('Charge, say, $5 a crate, and see who keeps them.', '').text).toBe(
      'Charge, and see who keeps them.',
    );
    expect(
      withoutExampleFigures('A tutor at, for example, GHS 80 a session would still lose to free videos.', '')
        .text,
    ).toBe('A tutor would still lose to free videos.');
    // Their own figure stays, and so does a proposed bar.
    expect(
      withoutExampleFigures(
        'Price it at, say, 40 cedis a session, as you planned.',
        'we plan 40 cedis a session',
      ).removed,
    ).toBe(0);
    expect(withoutExampleFigures('Pick a bar, say 30% reordering.', '').removed).toBe(0);
  });

  it('is asked of the prompt: no local rate, market price, size or statistic of its own, and how to find one', () => {
    const rules = conversationCraftRules('text');
    expect(rules).toMatch(/local rate/);
    expect(rules).toMatch(/market size/);
    expect(rules).toMatch(/how to find/);
    expect(rules).toMatch(/not even as an example/);
  });
});
