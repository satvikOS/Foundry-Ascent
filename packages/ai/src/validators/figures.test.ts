import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { conversationCraftRules } from '../prompts/craft.js';
import {
  inventedFigures,
  spelledNumbersIn,
  withoutExampleFigures,
  withoutInventedFigures,
} from './figures.js';

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
    // A bare verb keeps its object, said by its role, and never reads clipped ("Charge, and see…").
    expect(withoutExampleFigures('Charge, say, $5 a crate, and see who keeps them.', '').text).toBe(
      'Charge a set price per crate, and see who keeps them.',
    );
    expect(withoutExampleFigures('Charge, say, $5 a crate and see who keeps them.', '').text).toBe(
      'Charge a set price per crate and see who keeps them.',
    );
    expect(withoutExampleFigures('Price it at, say, 200 naira, and see who pays.', '').text).toBe(
      'Price it and see who pays.',
    );
    expect(
      withoutExampleFigures('Try a price, for example, 40 cedis a session, and see who signs up.', '').text,
    ).toBe('Try a price per session, and see who signs up.');
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

  it("never says Thomas's arithmetic on their numbers, or a figure they gave before, by its role (review of B1)", () => {
    const keep = (reply: string, known: string): void => {
      expect(withoutInventedFigures(reply, known)).toEqual({ text: reply, removed: 0 });
    };
    // A day's takings over a week, and a product of three of their numbers.
    keep(
      "If you sell 20 boxes a day at ₦500, you'd make ₦70,000 a week.",
      '20 boxes a day at 500 naira each',
    );
    keep(
      "If you sell 3 crates a day at 5 cedis, that's 105 cedis a week.",
      'we rent 3 crates a day at 5 cedis',
    );
    keep('At ₦500 a day, that is ₦3,500 a week.', 'we make 500 naira a day');
    // A result clause is never a price offered, even on numbers nobody gave (the offered one still is).
    expect(
      withoutInventedFigures("If you charge 5 cedis a box, you'd make 900 cedis a month.", 'we sell fruit')
        .text,
    ).toBe("If you charge a set price per box, you'd make 900 cedis a month.");
    // Remembered from an earlier conversation (the notes are part of what is known: orchestrator/answer.ts).
    keep(
      'Would parents pay 40 cedis a session, the price you settled on last time?',
      'Parents agreed to 40 cedis a session at the pilot school.',
    );
    // A count times a period, with no arithmetic shown, is not a monthly figure by chance.
    expect(
      inventedFigures('Rent alone is likely $1,200 a month.', 'We sell 40 crates a week.').unsourced,
    ).toEqual(['$1,200']);
    // A made-up price offered is still said by its role.
    expect(withoutInventedFigures('Would they pay $2 a month for it?', 'we lend crates').text).toBe(
      'Would they pay a monthly price for it?',
    );
  });

  it('leaves the range they asked for as written, and counts it (review of B1: "Charge a set price per session")', () => {
    const reply =
      'Charge around $15 a session to start, assuming parents compare you to a private tutor. Price it at 40 cedis per session for the group class.';
    const known = 'How much should I charge per session for the tutoring?';
    expect(withoutInventedFigures(reply, known, true)).toEqual({ text: reply, removed: 0 });
    expect(withoutExampleFigures('Charge, say, $15 a session.', known, true).removed).toBe(0);
    expect(inventedFigures(reply, known).unsourced).toEqual(['$15', '40 cedis']);
    // Unasked, the price is said by its role, and the hedge or "at" before it goes with it.
    expect(withoutInventedFigures(reply, 'I tutor.').text).toBe(
      'Charge a set price per session to start, assuming parents compare you to a private tutor. Price it per session for the group class.',
    );
    expect(withoutInventedFigures('Price it at $10 a month and see who stays.', 'we lend crates').text).toBe(
      'Price it monthly and see who stays.',
    );
    expect(
      withoutInventedFigures('Charge 5 dollars a crate and see who keeps them.', 'we lend crates').text,
    ).toBe('Charge a set price per crate and see who keeps them.');
    // A local rate or a market size stated as a fact is measured, not removed: the sentence needs its number.
    const fact = 'Tutors in Accra usually charge 50 to 100 cedis an hour, so you are cheap.';
    expect(withoutInventedFigures(fact, 'I sell tutoring.')).toEqual({ text: fact, removed: 0 });
    expect(inventedFigures(fact, 'I sell tutoring.').unsourced).toEqual(['50 to 100 cedis']);
  });

  it('reads a number they spelled out as theirs (review of B1: "fifty cedis" said back as a set price)', () => {
    expect(
      spelledNumbersIn('fifty cedis, two hundred and fifty a term, a thousand, twenty-five, the one I sell'),
    ).toEqual([50, 250, 1000, 25]);
    const reply = 'So at 50 cedis a session, charge 50 cedis a session to the next ten and see who returns.';
    expect(withoutInventedFigures(reply, 'I charge fifty cedis per session to students.')).toEqual({
      text: reply,
      removed: 0,
    });
  });

  it('is asked of the prompt: no local rate, market price, size or statistic of its own, and how to find one', () => {
    const rules = conversationCraftRules('text');
    expect(rules).toMatch(/local rate/);
    expect(rules).toMatch(/market size/);
    expect(rules).toMatch(/how to find/);
    expect(rules).toMatch(/not even as an example/);
  });
});
