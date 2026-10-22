import { describe, expect, it } from 'vitest';

import { affirms, isAboutThread, mentions, threadWords, tookUp, untakenThread } from './threads.js';

/** The founder's lines of the lab's agenda suite (ops/lab/scenarios/agenda.json; synthetic). */
const AG1 = [
  "Hey. I've got a bit of time today.",
  "I don't know. You tell me.",
  "That's the thing, I don't know. You tell me what I should ask.",
  "idk I'm blank, help me get started, I'm writing it all down.",
];
const AG2 = [
  "Can you help me prepare for my pitch next week? It's a five-minute slot at the health innovation competition.",
  'Honestly I want to make a lot of money from this. How do I position myself?',
  'My cofounder wants to quit his job and go full-time in January.',
];
const NAMES = ['Idris Okafor', "Corin's vEIR", 'Corin Halvorsen'];

describe('threadWords: what an opener raises, without its frame', () => {
  it('reads the thread of the openers the lab heard, without greetings, endings or names', () => {
    expect(
      [
        ...threadWords(
          'Good to have you back. I wanted to come back to the advisor session and your three questions. How is it going?',
          NAMES,
        ),
      ].sort(),
    ).toEqual(['advisor', 'question', 'session', 'thre']);
    expect([...threadWords('Hi Idris, shall we pick up booking the advisor session?', NAMES)].sort()).toEqual(
      ['advisor', 'book', 'session'],
    );
  });

  it('finds no thread in a plain invitation or a first-meeting hello', () => {
    for (const line of [
      'Good to talk again. Want to pick up where we left off yesterday, or start on something new?',
      'Nice to hear from you again. Want to pick up where we left off about 20 minutes ago, or start on something new?',
      'Good to have you here. Want to pick up where your last conversation here left off on 2 September, or start on something new?',
      'Hi Idris, where would you like to pick up?',
      'Hi Idris, what would you like to work on?',
      "Hi Idris, I'm Corin's vEIR, Corin's digital twin. What would you like to work on?",
    ]) {
      expect([...threadWords(line, NAMES)], line).toEqual([]);
    }
  });
});

describe('tookUp: whether the founder took up what was raised', () => {
  const advisor = threadWords(
    'Hi Idris, where are things with the advisor session and your three questions?',
    NAMES,
  );

  it('AG-1 and AG-2: the founder ignored the advisor thread', () => {
    expect(tookUp(advisor, AG1)).toBe(false);
    expect(tookUp(advisor, AG2)).toBe(false);
    expect(
      untakenThread('Hi Idris, shall we pick up booking the advisor session?', AG2, NAMES),
    ).not.toBeNull();
  });

  it('counts a message that holds two of its words, or a short yes right after it', () => {
    expect(tookUp(advisor, ['I booked the advisor session for Thursday.'])).toBe(true);
    expect(tookUp(advisor, ['Sure, go ahead.'])).toBe(true);
    expect(tookUp(advisor, ["Yes, let's."])).toBe(true);
    // A yes later on answers something else; a yes that turns away takes nothing up.
    expect(tookUp(advisor, ['Can we do my pitch?', 'ok'])).toBe(false);
    expect(tookUp(advisor, ['Sure, but first my pitch.'])).toBe(false);
    expect(affirms('No, not today.')).toBe(false);
    // A plain invitation raises nothing to take up.
    expect(tookUp(new Set(), AG1)).toBe(true);
    expect(
      untakenThread(
        'Good to talk again. Want to pick up where we left off yesterday, or start on something new?',
        AG1,
        NAMES,
      ),
    ).toBeNull();
  });

  it('mentions needs two of a thread’s words (one when it has one)', () => {
    expect(mentions(new Set(['advisor', 'session']), ['I met the advisor last week, actually.'])).toBe(false);
    expect(mentions(new Set(['advisor']), ['I met the advisor last week, actually.'])).toBe(true);
    expect(mentions(new Set(), AG2)).toBe(false);
  });
});

describe('isAboutThread', () => {
  const raised = threadWords(
    'Good to have you back. I wanted to come back to the advisor session and your three questions. How is it going?',
    NAMES,
  );

  it('recognises the same thread in other words (the lab’s next topics)', () => {
    expect(isAboutThread('booking the advisor session', raised)).toBe(true);
    expect(isAboutThread('the three advisor questions you drafted', raised)).toBe(true);
    expect(
      isAboutThread(
        'You mentioned you’d write down the three questions I suggested, how did that go, and are you ready for the advisor session now?',
        raised,
      ),
    ).toBe(true);
  });

  it('never takes another subject for it', () => {
    expect(isAboutThread("the cofounder's full-time commitment requirements", raised)).toBe(false);
    expect(isAboutThread('your five-minute pitch at the health innovation competition', raised)).toBe(false);
    expect(isAboutThread('what the advisor said about device clearance', raised)).toBe(false);
    expect(isAboutThread('Good to talk again. How has it gone since?', raised)).toBe(false);
  });
});
