import { describe, expect, it } from 'vitest';

import { addressFounder, properNounsIn } from './address-founder.js';

const PEOPLE = { founder: 'Maya Patel', team: ['Maya Patel', 'Noor Haddad'] };

describe('addressFounder (LAB-U2: said to the founder, names in their real case)', () => {
  it.each([
    ['the facility budget numbers maya will get', 'the facility budget numbers you will get'],
    ['Maya plans to call facilities about the budget.', 'You plan to call facilities about the budget.'],
    ['Maya is waiting on the dean.', 'You are waiting on the dean.'],
    ["the founder's pilot with two libraries", 'your pilot with two libraries'],
    ['Last time the founder said the dean has the budget.', 'Last time you said the dean has the budget.'],
    ['what maya patel has to send the dean', 'what you have to send the dean'],
    ["noor's first task", "Noor's first task"],
    ['the five library-staff interviews you planned', 'the five library-staff interviews you planned'],
  ])('%s', (line, said) => {
    expect(addressFounder(line, PEOPLE)).toBe(said);
  });

  it('drops a line that still speaks of the founder in the third person', () => {
    expect(addressFounder('whether she will sign the purchase order', PEOPLE)).toBeNull();
    expect(addressFounder('his plan for the pilot', PEOPLE)).toBeNull();
  });

  it('still addresses "the founder" when the founder’s name is unknown', () => {
    expect(addressFounder('the numbers the founder will get', { founder: null })).toBe(
      'the numbers you will get',
    );
  });
});

describe('names in their real case where the founder typed them in lower case (wave 7, item 2)', () => {
  it('reads the proper nouns the vEIR wrote, never a sentence’s first word', () => {
    expect(
      properNounsIn([
        'Booking Harbour Hall early is smart. Ask Hartwell whether QuietQuad can use it on Monday.',
      ]),
    ).toEqual(expect.arrayContaining(['Harbour Hall', 'Hartwell', 'QuietQuad']));
    expect(properNounsIn(['Booking early is smart. The pilot starts soon.'])).toEqual([]);
  });

  it('gives a line the case the conversation wrote the names in', () => {
    expect(
      addressFounder('your plan to book the harbour hall study room with hartwell', {
        ...PEOPLE,
        names: ['Harbour Hall', 'Hartwell'],
      }),
    ).toBe('your plan to book the Harbour Hall study room with Hartwell');
  });
});

describe('a name’s first everyday word keeps the capital the vEIR wrote it with (the review of e9e49fb)', () => {
  it('gives a subject’s first everyday word the capital the vEIR wrote it with as a name, only there', () => {
    // Before: "canvas integration", "discord servers", "square payments" (the review of e9e49fb).
    const names = properNounsIn([
      'You could pitch it to Target first, then Canvas. Next steps: Book the room.',
      'A Discord server is cheap to run. The Square fees add up.',
      'Is Signal where your pilot users already are?\nPricing comes later.',
    ]);
    expect(names).toEqual(expect.arrayContaining(['Target', 'Canvas', 'Discord', 'Square', 'Signal']));
    // A sentence's first word, after a colon or a line break, is no name.
    for (const word of ['Book', 'Next', 'Pricing', 'You', 'Is']) expect(names, word).not.toContain(word);
    const people = { founder: null, names };
    for (const [subject, said] of [
      ['target stores', 'Target stores'],
      ['canvas integration', 'Canvas integration'],
      ['discord servers', 'Discord servers'],
      ['square payments', 'Square payments'],
      ['signal groups', 'Signal groups'],
      // Only where the subject opens with it: "target" and "book" are words everywhere else.
      ['your target market', 'your target market'],
      ['your plan to book the room', 'your plan to book the room'],
    ] as const) {
      expect(addressFounder(subject, people), subject).toBe(said);
    }
  });
});
