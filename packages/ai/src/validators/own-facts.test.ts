import { describe, expect, it } from 'vitest';

import { STEP, STEP_ONLY } from '../testing/path-fixtures.js';
import type { PromptGuidance } from '../prompts/guidance.js';
import { ownFactsUnit } from './own-facts.js';

// First live run on Nova 2 Lite (synthetic wording): templates filled with facts nobody told, a sum of money out of the
// air, customers a venture did not have, and "the playbook says".
const GUIDANCE: PromptGuidance = {
  ...STEP_ONLY,
  said: 'I work the desk at the dorm. Students lose their laundry cards. I sold 9 pouches at 4 dollars. The fee is 450.',
  step: {
    ...STEP,
    template: {
      title: 'One page',
      body: 'Who: [one type of person]\nProblem: [what goes wrong, and how often] (seen / guess)\nIdea: [what you would do]\nWhy me: [what you know, have or can reach]\nOpening: "Would you show me how you do it?"',
    },
  },
};
const of = (unit: string, guidance: PromptGuidance | null = GUIDANCE) => ownFactsUnit(unit, guidance);

describe('a sum shown step by step', () => {
  it('each step may build on the one before it, and on no other', () => {
    const guidance: PromptGuidance = {
      ...GUIDANCE,
      said: 'A lamp leaves me 13 dollars. The stall is 95 dollars. 20 lamps.',
    };
    const right = 'At $13 a lamp, 20 lamps bring $260, and after the $95 stall you keep $165.';
    expect(of(right, guidance).text).toBe(right);
    expect(of('You keep $165 of it.', guidance).text).toBe('');
    expect(of('At $13 a lamp, 20 lamps bring $260, and you keep $171.', guidance).text).toBe('');
  });
});

describe('a line of a template written for them', () => {
  it.each([
    ['Why me: I study chemistry and know the gym kitchens', 'Why me: [what you know, have or can reach]'],
    ['5. **Why me:** I have run two startups', '5. **Why me:** [what you know, have or can reach]'],
    [
      'Problem: nurses skip lunch four times a week (guess)',
      'Problem: [what goes wrong, and how often] (seen / guess)',
    ],
    ['Price: $12 a month', 'Price: [price]'],
  ])('%s', (unit, out) => {
    expect(of(unit)).toEqual({ text: out, findings: ['template_bracketed'] });
  });

  it.each([
    'Why me: I work the desk at the dorm',
    'Problem: students lose their laundry cards',
    'Who: [one type of person]',
    'Why me: [what you know, have or can reach]',
    // A script is the program's, or theirs to change.
    'Opening: "Would you show me how you do the laundry?"',
    'One thing matters most: the talks.',
  ])('%s stands', (unit) => {
    expect(of(unit)).toEqual({ text: unit, findings: [] });
  });

  it('a mark a dropped line left behind goes', () => {
    expect(of('(guess)').text).toBe('');
  });
});

describe('what they are said to have', () => {
  it.each([
    'You already have customers who pay.',
    'You already have a strong waitlist.',
    'You have 3 pilots running.',
  ])('%s goes: nothing of theirs mentions it', (unit) => {
    const guidance = { ...GUIDANCE, said: 'I have an idea for laundry cards.' };
    expect(of(unit, guidance)).toEqual({ text: '', findings: ['traction_unsupported'] });
  });

  it.each([
    'You already have sales: nine pouches.',
    'Once you have paying customers, raise the price.',
    'You have no customers yet, and that is fine.',
    'Do you have customers?',
    'You can have customers by spring.',
  ])('%s stands', (unit) => {
    const said = unit.includes('pouches') ? GUIDANCE.said : 'I have an idea for laundry cards.';
    expect(of(unit, { ...GUIDANCE, said: said ?? '' }).text).toBe(unit);
  });
});

describe('money', () => {
  it.each(['They lose maybe $30–$60 a month.', 'Offer 45 to eight next month.', 'Ask for 60 dollars.'])(
    '%s goes: nobody gave it',
    (unit) => {
      expect(of(unit)).toEqual({ text: '', findings: ['money_unsupported'] });
    },
  );

  it.each([
    'You sold them at $4.',
    'Nine pouches at $4 is $36.',
    'Keep the fee at $450.',
    'Email 20 people by Friday.',
    'Price it at what they use now.',
  ])('%s stands: theirs, or worked out from theirs', (unit) => {
    expect(of(unit)).toEqual({ text: unit, findings: [] });
  });

  it('a sum the program gave stands', () => {
    expect(
      of('That leaves $17.25 a box.', { ...GUIDANCE, calc: ['$20 - $2.75 = $17.25 left per box.'] }).text,
    ).toBe('That leaves $17.25 a box.');
    expect(ownFactsUnit('A filing costs $65.', GUIDANCE, { known: 'A provisional costs $65.' }).text).toBe(
      'A filing costs $65.',
    );
  });
});

describe('our own words', () => {
  it.each([
    ['The playbook says to talk to ten people first.', 'Talk to ten people first.'],
    ['Talk to ten people, exactly what the playbook says.', 'Talk to ten people.'],
    ['According to the playbook, price comes second.', 'Price comes second.'],
  ])('%s', (unit, out) => {
    expect(of(unit)).toEqual({ text: out, findings: ['own_words'] });
  });

  it('no path, nothing changed', () => {
    expect(of('The playbook says so. You have paying customers at $90.', null).text).toContain(
      'The playbook says so',
    );
  });
});
