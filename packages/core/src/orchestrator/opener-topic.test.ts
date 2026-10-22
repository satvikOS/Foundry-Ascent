import { describe, expect, it } from 'vitest';

import {
  addressFounder,
  isTopicLine,
  properNounsIn,
  readsAsSubject,
  topicOf,
  withoutDiscourseWords,
} from './opener-topic.js';

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
  it('accepts noun phrases, single nouns and names, activities, questions and plans with their verb', () => {
    for (const subject of [
      'the Hartwell pilot',
      'per-library pricing',
      'pricing and pilot design',
      'Noor',
      'Hartwell',
      'FDA clearance',
      // A single common noun is a subject (the mock's "Last time we talked about pricing", e2e calls.spec.ts:518).
      'pricing',
      'hiring',
      'fundraising',
      'follow-up',
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

  it('rejects a lone date or time, a word that only describes, a plan without a verb and other fragments', () => {
    for (const fragment of [
      'January',
      'May',
      'next week',
      'the end of the month',
      'a few minutes',
      '$900',
      'full-time',
      'long-term',
      'two-week',
      'ready',
      'quickly',
      'Monday',
      'you',
      'yourself',
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

/** The adverbs and discourse words of a founder's line that say how, when or how sure, never what. */
const DISCOURSE = [
  'instead',
  'too',
  'also',
  'anyway',
  'though',
  'then',
  'again',
  'either',
  'yet',
  'already',
  'now',
  'later',
  'first',
  'really',
  'maybe',
  'probably',
  'just',
  'actually',
  'basically',
  'honestly',
] as const;

describe('a subject never ends or opens on an adverb or a discourse word (the voice suite on 9a2a41f)', () => {
  it('rejects one that ends on one ("Hi Maya, want to carry on with a short pilot instead?")', () => {
    for (const word of DISCOURSE) {
      for (const subject of [
        `a short pilot ${word}`,
        `per-library pricing ${word}`,
        `your plan to call facilities ${word}`,
        `whether to charge per seat ${word}`,
        `the Hartwell pilot, ${word}`,
        word,
      ]) {
        expect(readsAsSubject(subject), subject).toBe(false);
      }
    }
    for (const subject of [
      'annual pricing as well',
      'a short pilot or something',
      'the pilot pricing for now',
      'the pitch deck so far',
    ]) {
      expect(readsAsSubject(subject), subject).toBe(false);
    }
  });

  it('rejects one that opens on one ("actually the pilot pricing")', () => {
    for (const word of DISCOURSE) {
      expect(readsAsSubject(`${word} the pilot pricing`), word).toBe(false);
      expect(readsAsSubject(`${word}, per-library pricing`), word).toBe(false);
    }
    for (const subject of ['honestly per-seat pricing', 'maybe Hartwell', 'probably fundraising']) {
      expect(readsAsSubject(subject), subject).toBe(false);
    }
  });

  it('keeps an adverb that belongs to the subject: an alternative, a word that modifies the next', () => {
    for (const subject of [
      'whether to hire a salesperson now or later',
      'whether to raise sooner rather than later',
      'the first library',
      'first customers',
      'the later stages of the pilot',
      'your plan to call facilities on Monday',
    ]) {
      expect(readsAsSubject(subject), subject).toBe(true);
    }
  });

  it.each([
    ['a short pilot instead', 'a short pilot'],
    ['annual pricing too', 'annual pricing'],
    ['the investor pitch again, honestly', 'the investor pitch'],
    ['actually the pilot pricing', 'the pilot pricing'],
    ['maybe a short pilot instead', 'a short pilot'],
    ['honestly, per-seat pricing', 'per-seat pricing'],
    ['annual pricing as well', 'annual pricing'],
    ['a short pilot or something', 'a short pilot'],
    ['your plan to call facilities now', 'your plan to call facilities'],
    ['whether to hire a salesperson now or later', 'whether to hire a salesperson now or later'],
    ['the first library', 'the first library'],
    ['first customers', 'first customers'],
    ['the Hartwell pilot', 'the Hartwell pilot'],
    ['instead', ''],
  ])('withoutDiscourseWords(%j) is %j', (text, shorter) => {
    expect(withoutDiscourseWords(text)).toBe(shorter);
  });
});

describe('topicOf: never a splice of the founder’s line (the voice suite on 9a2a41f)', () => {
  it.each([
    // The lab's call: "Hi Maya, want to carry on with a short pilot instead?"
    ['Maybe we should do a short pilot instead.', 'a short pilot', false],
    ['What if we ran a short pilot instead?', 'a short pilot', false],
    ["Let's do a two-week pilot instead.", 'a two-week pilot', false],
    ['We might bring on a part-time designer instead.', 'a part-time designer', false],
    ['We could run a free pilot first.', 'a free pilot', false],
    ['We probably need a pilot contract first.', 'a pilot contract', false],
    ['We should practise the investor pitch again.', 'the investor pitch', false],
    ['Should we charge per seat instead?', 'whether to charge per seat', true],
    ['Should we maybe run the pilot with Hartwell first?', 'whether to run the pilot with Hartwell', true],
    ['Is the Hartwell pilot ready yet?', 'whether the Hartwell pilot is ready', true],
    // An adverb between "I" and the verb of a plan or a decision.
    ['I still need to finish the investor update.', 'your plan to finish the investor update', false],
    ["We've finally decided to hire a designer.", 'your decision to hire a designer', false],
    // A deliberation names what is weighed, never "weighing …" (e2e calls.spec.ts:518 still hears "pric…").
    ['We are weighing per-library pricing for the pilot.', 'per-library pricing for the pilot', false],
    ["We're thinking about annual pricing too.", 'annual pricing', false],
    ["We're thinking of raising a pre-seed round later.", 'raising a pre-seed round', false],
    ["We're considering whether to raise now or later.", 'whether to raise now or later', true],
    // A number keeps its thousands: never "raising the price to $1".
    ['We raised the price to $1,200 per semester.', 'raising the price to $1,200 per semester', false],
    // A sentence's first word in its everyday case: never "shall we pick up Fundraising?".
    ['Fundraising is taking too much of my time though.', 'fundraising', false],
    // A count is said as the one the founder told of: "the five customer interviews".
    ['I did five customer interviews yesterday.', 'the five customer interviews', false],
  ])('%s', (line, text, question) => {
    expect(topicOf(line)).toMatchObject({ text, question });
  });

  it('never makes a plan of a line that names nothing to do ("your plan to talk")', () => {
    expect(topicOf('We really need to talk about it soon.')?.text ?? null).toBeNull();
    // A plan that names something still is one.
    expect(topicOf('We really need to talk to the dean about the pilot.')?.text).toBe(
      'your plan to talk to the dean about the pilot',
    );
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
