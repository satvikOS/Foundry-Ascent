import { describe, expect, it } from 'vitest';

import { addressFounder, isTopicLine, topicOf } from './opener-topic.js';

const PEOPLE = { founder: 'Maya Patel', team: ['Maya Patel', 'Noor Haddad'] };

describe('isTopicLine (LAB-R3: never a subject)', () => {
  it('rejects greetings, checks, recall and memory questions, questions about the vEIR, thanks and wrap-ups', () => {
    for (const line of [
      'Hey, do you remember what we talked about last time?',
      'What did I tell you in our chat about the student union?',
      'Remind me what we decided to test first?',
      'Where were we?',
      'Hi!',
      'Hey, can you hear me?',
      'Am I talking to a bot?',
      'Is this really Corin?',
      'Are you a real person?',
      'Do you even have a life?',
      'Thanks, that helps.',
      "Great, thanks. That's all for today.",
      'ok',
    ]) {
      expect(isTopicLine(line), line).toBe(false);
    }
  });

  it('accepts what the founder brought', () => {
    for (const line of [
      "We're pricing the Hartwell pilot at $900 per semester.",
      'Should we price per library or per seat?',
      'The student union offered a group booking discount.',
      'Hi! Quick one, we finished five library-staff interviews this week.',
    ]) {
      expect(isTopicLine(line), line).toBe(true);
    }
  });
});

describe('topicOf: summarised, never quoted', () => {
  it.each([
    ['Should we price per library or per seat?', 'whether to price per library or per seat', true],
    ['How should we price the Hartwell pilot?', 'how to price the Hartwell pilot', true],
    [
      'Do we need a second library before the pilot?',
      'whether you need a second library before the pilot',
      true,
    ],
    ['We decided to price per library, not per seat.', 'your decision to price per library', false],
    [
      "I'm planning to call facilities about our budget tomorrow.",
      'your plan to call facilities about your budget tomorrow',
      false,
    ],
    [
      "We're pricing the Hartwell pilot at $900 per semester.",
      'pricing the Hartwell pilot at $900 per semester',
      false,
    ],
    ['We booked the auditorium for demo day.', 'booking the auditorium for demo day', false],
    ['Our goal is ten paying libraries by June.', 'your goal of ten paying libraries by June', false],
    ['The student union offered a group booking discount.', 'the student union', false],
    ['We signed the first library!', 'signing the first library', false],
    ['The first library signed!', 'the first library', false],
    ['Is a two-week test enough?', 'whether a two-week test is enough', true],
    [
      'Should the pilot run in two libraries or three?',
      'whether the pilot should run in two libraries or three',
      true,
    ],
    ['Noor starts Monday. What should her first task be?', 'Noor', false],
  ])('%s', (line, text, question) => {
    expect(topicOf(line)).toMatchObject({ text, question });
  });

  it('finds nothing to name in filler', () => {
    expect(topicOf('Hi there, ok')).toBeNull();
  });
});

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
