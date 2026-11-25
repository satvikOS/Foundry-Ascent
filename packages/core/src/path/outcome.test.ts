import { describe, expect, it } from 'vitest';

import { readsOutcome, reportsOutcome } from './outcome.js';

describe('what reports an outcome', () => {
  it.each([
    'We sold 26 jars on Saturday and ran out by noon.',
    'I asked nine cooks, and the glass is too heavy for four, they said.',
    'The hotel buyer turned us down, they have a supplier.',
    'nobody bought, but two shops said the pits cost them money to clear',
    'A chef wrote me that her kitchen needs it every week.',
    'Six of 50 bought.',
    'My neighbours bought the first crate and came back.',
    'we tried two prices on sunday, 12 sold',
    'Three shops are paying us now and one cancelled.',
    'she said it is interesting and to send a page',
    'the page went up, 90 looked and 4 left an address',
    'the market opened a stall with the same jam, for free',
  ])('%s', (message) => {
    expect(reportsOutcome(message)).toBe(true);
  });
  it.each([
    'Plum jam for hotels, that is the whole thought for now.',
    "I didn't write to the hotels. My sister's wedding took the week.",
    "Harvest is done. My two evenings are free again. What's next?",
    'I think six hotels in town would want it.',
    "I'll call the six hotels by Friday.",
    'Plumline sells preserves from backyard trees.',
    "I've drawn the label and the box.",
    'What is different about the plan now?',
    'Change it: a jar is 9 dollars, not 8.',
    'We decided to turn to hotels, five of them this week.',
    'Tell me the jam is wonderful.',
    'I have only two evenings a week and an exam soon. Where do I begin?',
    'if a hotel says no, what then?',
    'That is too general. Something I can use, please.',
  ])('none: %s', (message) => {
    expect(reportsOutcome(message)).toBe(false);
  });
  it('asked what to make of it, what they told before is read', () => {
    expect(readsOutcome('is that a good sign?', ['I asked 20, 11 bought.'])).toBe(true);
    expect(readsOutcome('is that a good sign?', ['Jam for hotels.'])).toBe(false);
    expect(readsOutcome('what should a jar cost?', ['I asked 20, 11 bought.'])).toBe(false);
  });
});
