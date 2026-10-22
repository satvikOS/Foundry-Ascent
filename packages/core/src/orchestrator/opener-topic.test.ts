import { describe, expect, it } from 'vitest';

import { addressFounder, isTopicLine, properNounsIn, readsAsSubject, topicOf } from './opener-topic.js';

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

  it('never makes a topic of a clause fragment: a pronoun and its verb are no noun phrase (LAB-R3b)', () => {
    for (const line of [
      "They'll promote QuietQuad if we add group booking.",
      "The student union said they'll promote QuietQuad if we add group booking.",
      'Big news! The union will promote us if we add group booking.',
      "She'll review the budget on Friday.",
      "It's the SSO question that worries them.",
    ]) {
      const topic = topicOf(line)?.text ?? '';
      expect(topic, line).not.toMatch(
        /^(?:they|they'll|she'll|he'll|it's|it'll|we|we'll|you'll|i|i'll)\b|^(?:promote|add|review)\b/i,
      );
    }
    expect(topicOf("They'll promote QuietQuad if we add group booking.")?.text).toMatch(
      /QuietQuad|group booking/,
    );
    // "Big news!" names nothing: the news itself does.
    expect(topicOf('Big news! The union will promote us if we add group booking.')?.text).toBe(
      'group booking',
    );
  });
});

describe('readsAsSubject: only what an opener can say it was about (lab run 39780304879, voice suite on acc50c6)', () => {
  it('accepts noun phrases, activities, questions, names and plans with their verb', () => {
    for (const subject of [
      'the Hartwell pilot',
      'per-library pricing',
      'pricing and pilot design',
      'Noor',
      'FDA clearance',
      'booking the auditorium for demo day',
      'whether to price per library or per seat',
      'how to position yourself',
      'your plan to call facilities about your budget tomorrow',
      "your cofounder's plan to go full-time in January",
      'your goal of ten paying libraries by June',
      'the five library-staff interviews you planned',
      'the facility budget numbers you will get',
      "the cofounder's full-time commitment requirements",
      'the advisor session and your three questions',
    ]) {
      expect(readsAsSubject(subject), subject).toBe(true);
    }
  });

  it('rejects a lone date or month, a word that is no name, a plan without a verb and other fragments', () => {
    for (const fragment of [
      'January',
      'May',
      'next week',
      'the end of the month',
      'a few minutes',
      '$900',
      'full-time',
      'pricing',
      'you',
      'your plan to a few minutes before your next class',
      'your plan to the pilot',
      'to a few minutes before your next class',
      'in January',
      'and the pitch',
      'the study room for',
      'your plan to',
      'the advisor last',
      "they'll promote QuietQuad",
      '',
    ]) {
      expect(readsAsSubject(fragment), fragment).toBe(false);
    }
  });
});

describe('topicOf: never a fragment (lab run 39780304879, voice suite on acc50c6)', () => {
  it('reads "My cofounder wants to quit his job and go full-time in January." as their plan, never "January"', () => {
    // Before: the most telling noun phrase was the capitalised "January" (a month is no everyday word), and the
    // next call said "Hi Idris, want to carry on with January?".
    expect(topicOf('My cofounder wants to quit his job and go full-time in January.')).toMatchObject({
      text: "your cofounder's plan to go full-time in January",
      question: false,
    });
  });

  it('never reads how much time the founder has as a plan ("your plan to a few minutes…")', () => {
    for (const line of [
      "Hi, it's Maya. I have a few minutes before my next class, so let's be quick.",
      'I have a few minutes before my next class.',
      "Hey. I've got a bit of time today.",
      "I've only got a few minutes, can we be quick?",
    ]) {
      expect(topicOf(line)?.text ?? '', line).not.toMatch(/your plan to|minutes|time today/);
    }
    // A plan still is one.
    expect(topicOf('I have to call facilities about the budget.')?.text).toBe(
      'your plan to call facilities about the budget',
    );
    expect(topicOf('I want to make a lot of money from this.')?.text).toBe(
      'your plan to make a lot of money from this',
    );
  });

  it('never ends a phrase on the start of a time ("the advisor last")', () => {
    expect(topicOf('I met the advisor last week, actually.')?.text ?? '').not.toMatch(/\blast$/);
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
