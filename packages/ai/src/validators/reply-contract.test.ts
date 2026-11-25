import { describe, expect, it } from 'vitest';

import type { PromptGuidance, ReplyContractFinding } from '../prompts/guidance.js';
import {
  IP_REFERRAL,
  NEW_IDEA,
  RECALL,
  REHEARSAL,
  REPORT,
  SERVICE_OR_PRODUCT,
  SOCIAL,
  STEP_ONLY,
  TODAY,
  STEP,
} from '../testing/path-fixtures.js';
import {
  carriesContract,
  checkReplyContract,
  composeFromGuidance,
  contractTail,
  firstUnitVerdict,
  isOtherNextLine,
  namesStep,
  playKey,
  shortAnswer,
  spokenReserve,
  stepLine,
  withPathDay,
} from './reply-contract.js';
import { unitsOf, wordsIn } from './units.js';

const check = (
  reply: string,
  guidance: PromptGuidance = SERVICE_OR_PRODUCT,
  channel: 'text' | 'voice' = 'text',
  founderText = 'Helpers that sort invoices for small shops. Service, software, or both?',
) => checkReplyContract({ reply, guidance, channel, today: TODAY, founderText });

const NEXT =
  'Next: list 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names and two calls booked.';
const GOOD_ANSWER =
  'Both, in order: run it by hand as a paid service for your first three companies, then turn the part you keep repeating into software. A service pays you while you watch the real workflow [E1].';

describe('a reply that keeps the contract is left alone', () => {
  const good: [name: string, reply: string, guidance?: PromptGuidance, channel?: 'text' | 'voice'][] = [
    ['answer, why, step', `${GOOD_ANSWER}\n\n${NEXT}`],
    ['one question after the step', `${GOOD_ANSWER}\n\n${NEXT}\n\nWhich office do you know best?`],
    [
      'numbered how-to with a script to send',
      `${GOOD_ANSWER}\n\n1. Write 20 names.\n2. Message five: "Hi, could I watch you do the filing once?"\n3. Book two calls.\n\n${NEXT}`,
    ],
    [
      'questions to ask someone else are prep, not stacked',
      `${GOOD_ANSWER}\n\nAsk each of them:\n1. "When did you last do this by hand?"\n2. "What did it cost you?"\n3. "Who else touches it?"\n\n${NEXT}`,
    ],
    [
      '"before you build" is advice',
      `${GOOD_ANSWER} Before you write code, watch three of them do it.\n\n${NEXT}`,
    ],
    ['"before we talk next" is a date', `${GOOD_ANSWER} Have the list ready before we talk next.\n\n${NEXT}`],
    [
      '"it depends" with the rule',
      `${GOOD_ANSWER} How long you stay manual depends on one thing: if two companies want the same task done the same way, automate that part.\n\n${NEXT}`,
    ],
    [
      'it depends, then the rule',
      `It depends on what you repeat. If three companies ask for the same task, turn it into software; until then sell it as a paid service by hand, because the service shows you the workflow.\n\n${NEXT}`,
    ],
    [
      'a rhetorical question answered at once',
      `${GOOD_ANSWER} Why by hand? Nobody has shown you the workflow yet.\n\n${NEXT}`,
    ],
    [
      'a compliment on something specific',
      `You got two paid pilots in a month: that is real demand. ${GOOD_ANSWER}\n\n${NEXT}`,
    ],
    [
      'step named with its weekday and date',
      `${GOOD_ANSWER}\n\n${NEXT.replace('by Thursday', 'by Thursday, November 26')}`,
    ],
    [
      'step with no "Next:" line',
      `${GOOD_ANSWER}\n\nBy Thursday, list 20 office managers who run admin by hand and message five of them. Done when you have 20 names and two calls booked.`,
    ],
    ['no ask: the step alone', `Start with people, not code: they show you the work. ${NEXT}`, STEP_ONLY],
    [
      'a call: answer, reason, step, day',
      'Do both, in order: run it by hand as a paid service for three companies, then automate what repeats. You get paid to see the real workflow. Your next step: list 20 office managers who run admin by hand and message five, by Thursday.',
      SERVICE_OR_PRODUCT,
      'voice',
    ],
    [
      'the referral said in its own words',
      'Assume the university may own part of it until the technology transfer office tells you; ownership usually turns on who paid, whose equipment you used and what you signed. They decide it, so see the technology transfer office with the lab agreement and grant terms, and a lawyer before signing.\n\nNext: write a one-page invention history and book the technology transfer office by Monday. Done when the page is written and the meeting has a date.',
      IP_REFERRAL,
    ],
    [
      'a new idea: the venture, its fact, both options, the first step',
      `That is a different idea from BenchTally, which has 2 paid pilots at $40 per lab per month. You can make it a change of direction or ask the program lead for a separate workspace. For the new one: run it by hand as a paid service for three companies, then automate what repeats.\n\n${NEXT}`,
      NEW_IDEA,
    ],
  ];
  it.each(good)('%s', (...[, reply, guidance, channel]) => {
    const out = check(reply, guidance, channel);
    expect(out.findings).toEqual([]);
    expect(out).toEqual({ ok: true, findings: [], repaired: null });
  });

  it('social turns and role-play are exempt, and no path holds a reply to nothing', () => {
    for (const guidance of [SOCIAL, REHEARSAL]) {
      expect(check('Good to see you. How was the exam?', guidance).ok).toBe(true);
      expect(check('Why should I fund you? Who buys this? What is your price?', guidance).ok).toBe(true);
    }
    expect(checkReplyContract({ reply: 'What do you think?', guidance: null, channel: 'text' }).ok).toBe(
      true,
    );
  });

  it('a recall need not name the step', () => {
    expect(
      check(
        'Your idea is BenchTally: tracking shared lab equipment. On October 20 you decided to sell to lab managers.',
        RECALL,
      ).ok,
    ).toBe(true);
  });
});

describe('a reply that does not help is repaired from the path (the client’s live test, re-created)', () => {
  it('refused to answer and asked instead', () => {
    const out = check(
      "Before we pick a structure, I'd want to understand who feels this pain most. What's your plan to reach someone like that?",
    );
    expect(out.findings).toEqual(
      expect.arrayContaining<ReplyContractFinding>([
        'question_only',
        'deferral',
        'missing_answer',
        'missing_step',
      ]),
    );
    expect(out.repaired).toContain('Both, in this order: do it by hand as a paid service');
    expect(out.repaired).toContain('[E1]');
    expect(out.repaired).toContain(
      'Next: List 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names written down and two calls booked.',
    );
    expect(out.repaired).not.toMatch(/before we|your plan for|\?/i);
    expect(check(out.repaired ?? '').ok).toBe(true);
  });

  it('asked two questions and gave no plan', () => {
    const out = check('What have you built so far? And who is it for?', STEP_ONLY);
    expect(out.findings).toContain('question_only');
    expect(out.findings).toContain('stacked_questions');
    // The step leads; the last question may stay, after it.
    expect(out.repaired?.startsWith('Next: List 20 office managers')).toBe(true);
    expect(out.repaired?.endsWith('And who is it for?')).toBe(true);
  });

  it.each([
    'Tell me more about what you have in mind.',
    'Got it. Walk me through what you have so far.',
    "I'd love to understand the problem better. Who has it?",
    'Great question. What do you think customers want?',
    "Okay. Let's figure out who the customer is first. Who do you have in mind?",
    'It depends.',
    "It's hard to say without knowing more. What have you tried?",
    'To answer that, I need to know a bit more about your market. What is it?',
    '1. What is the problem?\n2. Who has it?\n3. What have you tried?',
    '',
  ])('question-only or deferring: %s', (reply) => {
    const out = check(reply);
    expect(out.findings).toContain('question_only');
    expect(out.repaired).toContain('Both, in this order');
    expect(out.repaired).toContain('Next: List 20 office managers');
    expect(check(out.repaired ?? '').findings).toEqual([]);
  });

  it('keeps what the model said and drops only what puts it off', () => {
    const out = check(
      `Before we decide that, sell it by hand as a paid service to three companies, then automate what repeats. ${NEXT}`,
    );
    expect(out.findings).toEqual(['deferral']);
    expect(out.repaired).toBe(
      `Sell it by hand as a paid service to three companies, then automate what repeats. ${NEXT}`,
    );
  });

  it('drops a pure deferral in front of a full answer', () => {
    const out = check(`Before we dive in, I need to understand your market. ${GOOD_ANSWER}\n\n${NEXT}`);
    expect(out.findings).toEqual(['deferral']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
  });

  it('adds the step, before a trailing question, when only the answer was given', () => {
    const out = check(`${GOOD_ANSWER}\n\nWhich office do you know best?`);
    expect(out.findings).toEqual(['missing_step']);
    expect(out.repaired).toBe(
      `${GOOD_ANSWER}\n\nNext: List 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names written down and two calls booked.\n\nWhich office do you know best?`,
    );
  });

  it('replaces a step of the model’s own with the path’s', () => {
    const out = check(`${GOOD_ANSWER}\n\nNext: build a landing page by Friday. Done when it is live.`);
    expect(out.findings).toContain('missing_step');
    expect(out.repaired).not.toContain('landing page');
    expect(out.repaired).toContain('Next: List 20 office managers');
  });

  it('leads with the answer when the reply talked around it', () => {
    const out = check(
      `Admin work is a big market and many teams are entering it now with new tools.\n\n${NEXT}`,
    );
    expect(out.findings).toEqual(['missing_answer']);
    expect(out.repaired?.startsWith('Both, in this order: do it by hand as a paid service')).toBe(true);
    expect(out.repaired).toContain('Admin work is a big market');
    expect(out.repaired).toContain(NEXT);
  });

  it('gives the day, and what done means, when the step was named without them', () => {
    const out = check(
      `${GOOD_ANSWER}\n\nNext: list 20 office managers who run admin by hand and message five of them.`,
    );
    expect(out.findings).toEqual(['missing_step']);
    expect(out.repaired).toBe(
      `${GOOD_ANSWER}\n\nNext: list 20 office managers who run admin by hand and message five of them. Do it by Thursday. Done when you have 20 names written down and two calls booked.`,
    );
  });

  it('corrects a day the path did not set', () => {
    const out = check(`${GOOD_ANSWER}\n\n${NEXT.replace('by Thursday', 'by Friday')}`);
    expect(out.findings).toEqual(['wrong_date']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
    expect(check(`${GOOD_ANSWER}\n\n${NEXT.replace('by Thursday', 'by December 3')}`).repaired).toContain(
      'by Thursday',
    );
  });

  it('leaves at most one question', () => {
    const out = check(
      `${GOOD_ANSWER} Who would you call first? ${NEXT} Do you know any office managers? And do they have a budget?`,
    );
    expect(out.findings).toEqual(['stacked_questions']);
    expect(out.repaired).not.toContain('Who would you call first?');
    expect(out.repaired?.match(/\?/g)).toHaveLength(1);
    expect(out.repaired?.endsWith('And do they have a budget?')).toBe(true);
  });

  it('"Or …?" goes on from the question before it', () => {
    expect(check(`${GOOD_ANSWER}\n\n${NEXT}\n\nIs it offices? Or clinics?`).ok).toBe(true);
  });

  it.each([
    "That's a great idea!",
    'What a fantastic concept.',
    'I love this idea.',
    "I'm so impressed by what you have done.",
    "I'd be happy to help with that.",
    'Great question!',
  ])('never flatters: %s', (line) => {
    const out = check(`${line} ${GOOD_ANSWER}\n\n${NEXT}`);
    expect(out.findings).toEqual(['flattery']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
  });

  it('keeps the concern behind a compliment', () => {
    const out = check(`That's a great idea, but nobody has paid for it yet. ${GOOD_ANSWER}\n\n${NEXT}`);
    expect(out.findings).toEqual(['flattery']);
    expect(out.repaired?.startsWith('Nobody has paid for it yet.')).toBe(true);
  });

  it.each([
    "I won't tell you it is a great idea: nobody has paid yet.",
    'Friends saying they love it is not evidence.',
    'A great idea is one somebody pays for.',
    'You did five interviews in a week: good work getting them done.',
  ])('is no flattery: %s', (line) => {
    expect(check(`${line} ${GOOD_ANSWER}\n\n${NEXT}`).findings).not.toContain('flattery');
  });

  it('says who decides when a qualified person must', () => {
    const out = check(
      'Assume the university may own part of it until you know; ownership usually turns on who paid for the work, whose equipment you used and what you signed.\n\nNext: write a one-page invention history and book the meeting by Monday. Done when the page is written and the meeting has a date.',
      IP_REFERRAL,
    );
    expect(out.findings).toContain('missing_referral');
    expect(out.repaired).toContain(
      'A qualified person decides this: the university technology transfer office',
    );
    expect(out.repaired).toContain('Bring the invention history page');
  });

  it('never drops a new idea or the venture silently', () => {
    const out = check(
      `Run it by hand as a paid service for three companies, then automate what repeats.\n\n${NEXT}`,
      NEW_IDEA,
    );
    expect(out.findings).toEqual(['missing_answer']);
    expect(out.repaired).toContain(
      'This is a different idea from BenchTally (2 paid pilots at $40 per lab per month). You can make it a change of direction for BenchTally, or ask your program lead for a separate workspace',
    );
  });

  it('adds only what a new idea’s reply left out: the fact, or the two ways on', () => {
    const answer = `For the new one, run it by hand as a paid service for three companies, then automate what repeats.\n\n${NEXT}`;
    const noFact = check(
      `This is another idea than BenchTally: make it a pivot, or ask for a separate workspace. ${answer}`,
      NEW_IDEA,
    );
    expect(noFact.findings).toEqual(['missing_answer']);
    expect(noFact.repaired).toContain(
      'BenchTally has this on record: 2 paid pilots at $40 per lab per month.',
    );
    expect(noFact.repaired).not.toContain('This is a different idea');
    const noWays = check(`This is another idea than BenchTally and its 2 paid pilots. ${answer}`, NEW_IDEA);
    expect(noWays.repaired).toContain(
      'You can make it a change of direction for BenchTally, or ask your program lead for a separate workspace.',
    );
    expect(noWays.repaired).not.toContain('on record');
  });

  it('gives the step once when the path’s own answer already gives it', () => {
    const asked = SERVICE_OR_PRODUCT.ask;
    if (asked === null) throw new Error('the fixture has an ask');
    const report: PromptGuidance = {
      ...REPORT,
      ask: {
        ...asked,
        answer:
          'That counts as evidence. Next: List 20 office managers who run admin by hand and message 5 of them, due Thursday.',
        why: '',
        evidenceKeys: [],
      },
    };
    const out = composeFromGuidance(report, 'text', TODAY);
    expect(out.match(/Next:/g)).toHaveLength(1);
    expect(out).toContain('Done when you have 20 names written down and two calls booked.');
    expect(composeFromGuidance(report, 'voice', TODAY)).not.toContain('Your next step:');
  });

  it('a report that only asks back is answered with the step that follows', () => {
    const out = check('How did it go? What did they say?', REPORT, 'text', 'I sent the email on Monday.');
    expect(out.findings).toContain('question_only');
    expect(out.repaired).toContain('Next: List 20 office managers');
  });
});

describe('the answer the server says', () => {
  const ask = (answer: string, evidenceKeys: readonly string[] = ['E1', 'E2']): PromptGuidance => ({
    ...SERVICE_OR_PRODUCT,
    ask: {
      title: 'Is praise enough?',
      answer,
      why: 'A yes that costs nothing tells you little.',
      traps: [],
      evidenceKeys,
    },
  });
  const PRAISE =
    'No, praise is not enough. People who like you are kind about it. What counts is a stranger who pays, signs or gives an hour. Set a small number and a date for that. Then count who did. Then decide.';
  const tailOf = (guidance: PromptGuidance, channel: 'text' | 'voice' = 'text'): string =>
    contractTail({
      released: `There is a lot going on in this area at the moment. ${NEXT}`,
      guidance,
      channel,
      today: TODAY,
      founderText: 'My classmates like it. Is that enough?',
    });

  it('carries what would prove it, in up to four whole sentences, with no lead-in', () => {
    expect(tailOf(ask(PRAISE))).toBe(
      'No, praise is not enough. People who like you are kind about it. What counts is a stranger who pays, signs or gives an hour. Set a small number and a date for that [E1].',
    );
    const long = `Start with the smallest thing that could fail. ${'Every extra week before the test costs you one week of learning and some of the money that you have left. '.repeat(6)}`;
    expect(tailOf(ask(long)).length).toBeLessThanOrEqual(430);
    expect(tailOf(ask(long))).not.toMatch(/short answer/i);
  });

  it('is two sentences on a call, the second what would prove or sink it, with no key', () => {
    // A verdict of a few words takes no sentence's place.
    expect(tailOf(ask(PRAISE), 'voice')).toBe(
      'No, praise is not enough. People who like you are kind about it. What counts is a stranger who pays, signs or gives an hour.',
    );
    const spoken = (answer: string): string => shortAnswer({ answer }, 'voice');
    expect(
      spoken(
        'I will not call it great, because nobody has paid yet. Great is a word for later. It has a clear moment of need. Its weak spot is that no stranger wants it enough to pay. Sell ten.',
      ),
    ).toBe(
      'I will not call it great, because nobody has paid yet. Its weak spot is that no stranger wants it enough to pay.',
    );
    // Nothing weighty, or only what leans on the sentence left out: the next one.
    expect(spoken('Price from what they pay today for the same job. Go just under it. Say it aloud.')).toBe(
      'Price from what they pay today for the same job. Go just under it.',
    );
    expect(spoken('Price from what they pay today for the same job. Go just under it. That proves it.')).toBe(
      'Price from what they pay today for the same job. Go just under it.',
    );
    expect(spoken('Do it by hand.')).toBe('Do it by hand.');
    expect(spoken('')).toBe('');
  });

  it('leaves the play’s own steps to the card', () => {
    const out = tailOf(ask('Charge strangers a small deposit. How: 1) List ten; 2) Ask five.'));
    expect(out).toBe('Charge strangers a small deposit [E1].');
  });

  it('cites the play alone, never the notes pinned beside it', () => {
    const whole = composeFromGuidance(ask(PRAISE), 'text', TODAY);
    // On the last sentence with something of its own to check, never on "Then decide."
    expect(whole).toContain('Set a small number and a date for that [E1]. Then count who did. Then decide.');
    expect(whole).toContain('A yes that costs nothing tells you little [E1].');
    expect(whole).not.toContain('E2');
    expect(composeFromGuidance(ask(PRAISE, []), 'text', TODAY)).not.toContain('[');
    expect(playKey(ask(PRAISE))).toBe('E1');
    expect(playKey(STEP_ONLY)).toBeNull();
  });

  it('is never a repeat: every sentence of it stays', () => {
    const guidance = ask(PRAISE);
    for (const unit of unitsOf(PRAISE))
      if (wordsIn(unit.text) > 6)
        expect([unit.text, carriesContract(unit.text, guidance)]).toEqual([unit.text, true]);
  });
});

describe('a next step that is not the path’s', () => {
  const OTHERS = [
    'A good next step: run five interviews about the last time it happened.',
    'Your next step is to build a landing page and collect emails.',
    'Here’s your next move: rewrite the pitch for investors this week.',
    'So the best next step would be a survey of two hundred students.',
    '**Next step:** design a logo and a name.',
  ];
  it.each(OTHERS)('goes: %s', (line) => {
    expect(isOtherNextLine(line, SERVICE_OR_PRODUCT)).toBe(true);
    const out = check(`${GOOD_ANSWER} ${line}\n\n${NEXT}`);
    expect(out.findings).toEqual(['other_step']);
    expect(out.repaired).toContain('Both, in order');
    expect(out.repaired).not.toContain(line.replace(/\*/g, '').slice(0, 30));
    expect(out.repaired).toContain(NEXT);
  });

  it.each([
    'Your next step is below.',
    'Your next step: list 20 office managers who run admin by hand and message five.',
    'After that, the next step is to watch three of them do the task.',
    'The next stage of the path is validation.',
    '1. Name the assumption in one sentence.',
    'Is your next step to build a page?',
    'A good first step is to write the names down tonight.',
  ])('stays: %s', (line) => {
    expect(isOtherNextLine(line, SERVICE_OR_PRODUCT)).toBe(false);
    expect(check(`${GOOD_ANSWER} ${line}\n\n${NEXT}`).findings).not.toContain('other_step');
  });

  it('leaves a reply that was only that to the path', () => {
    const out = check('Your next step is to build a landing page and collect emails.');
    expect(out.repaired).not.toContain('landing page');
    expect(out.repaired).toContain('Next: List 20 office managers');
  });
});

describe('who decides', () => {
  const ANSWER =
    'Assume the university may own part of it until you know; ownership usually turns on who paid for the work, whose equipment you used and what you signed.';
  const IP_NEXT =
    'Next: write a one-page invention history and book the meeting by Monday. Done when the page is written and the meeting has a date.';

  it('is said with what to bring, once, on a call too', () => {
    const out = check(
      `${ANSWER} Your next step: write a one-page invention history, by Monday.`,
      IP_REFERRAL,
      'voice',
    );
    expect(out.findings).toContain('missing_referral');
    expect(out.repaired?.match(/A qualified person decides this/g)).toHaveLength(1);
    expect(out.repaired).toContain('the university technology transfer office');
    expect(out.repaired).toContain(
      'Bring the invention history page, the lab agreement and any grant terms.',
    );
    expect(check(out.repaired ?? '', IP_REFERRAL, 'voice').findings).not.toContain('missing_referral');
  });

  it('adds only what to bring when the reply named who', () => {
    const out = check(`${ANSWER} The technology transfer office decides it.\n\n${IP_NEXT}`, IP_REFERRAL);
    expect(out.findings).toEqual(['missing_referral']);
    expect(out.repaired).not.toContain('A qualified person');
    expect(out.repaired).toContain(
      'Bring the invention history page, the lab agreement and any grant terms.',
    );
  });

  it('is short on a call however long its list is', () => {
    const long: PromptGuidance = {
      ...IP_REFERRAL,
      referral: {
        who: 'a tax adviser',
        bring:
          'a one-page timeline, the lab and its funding, everyone involved, papers you signed, and any talk or post already made about it',
      },
    };
    const line = /Bring [^.]*\./.exec(composeFromGuidance(long, 'voice', TODAY))?.[0] ?? '';
    expect(line).toBe(
      'Bring a one-page timeline, the lab and its funding, everyone involved, papers you signed.',
    );
    expect(composeFromGuidance(long, 'text', TODAY)).toContain('any talk or post already made about it');
  });

  it('is said every turn that needs it: its line is never a repeat, and a call keeps room for it', () => {
    expect(carriesContract('See the technology transfer office about it.', IP_REFERRAL)).toBe(true);
    expect(carriesContract('See the dean about it.', IP_REFERRAL)).toBe(false);
    expect(spokenReserve(IP_REFERRAL, '', TODAY)).toBeGreaterThan(
      spokenReserve({ ...IP_REFERRAL, referral: null }, '', TODAY),
    );
    expect(
      contractTail({
        released: `${ANSWER} ${IP_NEXT}`,
        guidance: IP_REFERRAL,
        channel: 'text',
        today: TODAY,
      }),
    ).toBe(
      'A qualified person decides this: the university technology transfer office, and a lawyer before you sign anything. Bring the invention history page, the lab agreement and any grant terms.',
    );
  });
});

describe('a recall the record answers', () => {
  const RECORD: PromptGuidance = {
    ...RECALL,
    ask: {
      title: 'What you told me',
      answer:
        'Your venture is BenchTally, which tracks shared lab equipment. On October 20 you decided to sell to lab managers. Two labs have paid 40 dollars a month since October 12.',
      why: '',
      traps: [],
      evidenceKeys: [],
    },
  };
  const asked = 'What is my startup, and what did we decide?';

  it('is said when the reply leaves it out, text and call', () => {
    const out = check('How would you apply that this week?', RECORD, 'text', asked);
    expect(out.repaired).toContain('On October 20 you decided to sell to lab managers.');
    const part = check(
      'We were on pricing the last time that we talked about it all.',
      RECORD,
      'text',
      asked,
    );
    expect(part.findings).toEqual(['missing_answer']);
    expect(part.repaired).toContain('Your venture is BenchTally');
    const call = contractTail({
      released: 'Yes, I do.',
      guidance: RECORD,
      channel: 'voice',
      today: TODAY,
      founderText: asked,
    });
    expect(call).toContain('Two labs have paid 40 dollars a month');
  });

  it('is left alone when it was said in other words', () => {
    expect(
      check(
        'BenchTally: you track shared lab equipment, and two labs pay you 40 dollars a month. You decided on October 20 that lab managers are the buyer.',
        RECORD,
        'text',
        asked,
      ).findings,
    ).toEqual([]);
  });
});

describe('a call', () => {
  it('is repaired in speech: the answer, then the step and its day, no Markdown or ids', () => {
    const out = check('Before we get into that, who is your customer?', SERVICE_OR_PRODUCT, 'voice');
    expect(out.repaired).toBe(
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code. Your next step: list 20 office managers who run admin by hand and message 5 of them, by Thursday.',
    );
    expect((out.repaired ?? '').split(/\s+/).length).toBeLessThanOrEqual(75);
  });

  it('adds only the day when the step was said without it', () => {
    const out = check(
      'Do both, in order: a paid service by hand for three companies, then automate what repeats. So list 20 office managers who run admin by hand and message five.',
      SERVICE_OR_PRODUCT,
      'voice',
    );
    expect(out.findings).toEqual(['missing_step']);
    expect(out.repaired?.endsWith('message five. Have that done by Thursday.')).toBe(true);
  });
});

describe('streaming: the early gate and the tail', () => {
  it('releases a good first sentence at once, and holds nothing but questions and deferrals', () => {
    for (const unit of [
      'Both, in this order: a paid service first.',
      'Charge the lab manager, not the student.',
      'Two paid pilots is real evidence.',
      'Before you build, watch three of them.',
      '1. List 20 names.',
      '"When did you last do this?"',
      'It depends on who pays: if the lab does, charge per bench.',
      'It depends.',
    ]) {
      expect(firstUnitVerdict('', unit, SERVICE_OR_PRODUCT), unit).toEqual({ action: 'release' });
    }
    expect(firstUnitVerdict('', 'Who is your customer?', SERVICE_OR_PRODUCT)).toEqual({ action: 'hold' });
    expect(
      firstUnitVerdict(
        '',
        "Before we pick a structure, I'd like to understand the market.",
        SERVICE_OR_PRODUCT,
      ),
    ).toEqual({
      action: 'drop',
      finding: 'deferral',
    });
    expect(firstUnitVerdict('', 'Tell me more about the problem.', SERVICE_OR_PRODUCT)).toEqual({
      action: 'drop',
      finding: 'question_only',
    });
    expect(
      firstUnitVerdict('', "What's your plan to reach someone like that?", SERVICE_OR_PRODUCT).action,
    ).toBe('drop');
    expect(firstUnitVerdict('', 'That is a fantastic idea!', SERVICE_OR_PRODUCT)).toEqual({
      action: 'drop',
      finding: 'flattery',
    });
    expect(firstUnitVerdict('', 'Before we decide, sell it as a service.', SERVICE_OR_PRODUCT)).toEqual({
      action: 'replace',
      text: 'Sell it as a service.',
    });
    // Exempt turns, and no path.
    expect(firstUnitVerdict('', 'Who is your customer?', SOCIAL)).toEqual({ action: 'release' });
    expect(firstUnitVerdict('', 'Who is your customer?', null)).toEqual({ action: 'release' });
  });

  it('the tail adds only what is missing', () => {
    const tail = (
      released: string,
      guidance: PromptGuidance = SERVICE_OR_PRODUCT,
      channel: 'text' | 'voice' = 'text',
    ) => contractTail({ released, guidance, channel, today: TODAY, founderText: 'Service or product?' });
    expect(tail(`${GOOD_ANSWER}\n\n${NEXT}`)).toBe('');
    expect(tail(GOOD_ANSWER)).toBe(stepLine(STEP, 'text', TODAY));
    expect(tail('')).toBe(composeFromGuidance(SERVICE_OR_PRODUCT, 'text', TODAY));
    expect(tail(`Admin work is a big market with many new tools in it. ${NEXT}`)).toBe(
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code [E1].',
    );
    expect(tail('', SOCIAL)).toBe('');
    expect(tail(GOOD_ANSWER, SERVICE_OR_PRODUCT, 'voice')).toBe(
      'Your next step: list 20 office managers who run admin by hand and message 5 of them, by Thursday.',
    );
  });

  it('the step and the answer are never repeats, a check-in question is no step', () => {
    expect(carriesContract(NEXT, SERVICE_OR_PRODUCT)).toBe(true);
    expect(carriesContract('Done when you have 20 names.', SERVICE_OR_PRODUCT)).toBe(true);
    expect(carriesContract('Did you message the office managers?', SERVICE_OR_PRODUCT)).toBe(false);
    expect(carriesContract('Pricing follows the buyer.', SERVICE_OR_PRODUCT)).toBe(false);
    expect(carriesContract(NEXT, SOCIAL)).toBe(false);
  });

  it('reads a "Next:" line of another step, and the path’s day', () => {
    expect(isOtherNextLine('Next: build a landing page by Friday.', SERVICE_OR_PRODUCT)).toBe(true);
    expect(isOtherNextLine(NEXT, SERVICE_OR_PRODUCT)).toBe(false);
    expect(
      withPathDay('Next: list 20 office managers and message 5 by Sunday.', SERVICE_OR_PRODUCT, TODAY),
    ).toBe('Next: list 20 office managers and message 5 by Thursday.');
    expect(withPathDay('The exam is by Sunday.', SERVICE_OR_PRODUCT, TODAY)).toBe('The exam is by Sunday.');
  });
});

describe('the step line', () => {
  const step = STEP;
  it.each([
    ['2026-11-24', 'by the end of today'],
    ['2026-11-25', 'by tomorrow'],
    ['2026-11-26', 'by Thursday'],
    ['2026-11-30', 'by Monday'],
    ['2026-12-04', 'by Friday, December 4'],
  ])('says %s as "%s"', (dueOn, said) => {
    expect(stepLine({ ...step, dueOn }, 'text', TODAY)).toContain(said);
  });
  it('says no day when the step has none', () => {
    expect(stepLine({ ...step, dueOn: null }, 'text', TODAY)).toBe(
      'Next: List 20 office managers who run admin by hand and message 5 of them. Done when you have 20 names written down and two calls booked.',
    );
  });
  it('keeps a name or an acronym at the start of what done means', () => {
    expect(stepLine({ ...step, doneWhen: 'IRB office has replied.' }, 'text', TODAY)).toContain(
      'Done when IRB office has replied.',
    );
  });
  it.each([
    ['List twenty office managers doing admin by hand, message five', true],
    ['Message five of them with the short note', true],
    ['Write 20 names from your network and campus offices', true],
    ['Build a landing page', false],
    ['Talk to your manager', false],
    ['Admin work is a big market', false],
  ])('namesStep(%s) = %s', (text, expected) => {
    expect(namesStep(text, step)).toBe(expected);
  });
});

describe('the same reply and decision always give the same result', () => {
  it('is deterministic and idempotent', () => {
    const reply = 'What do you want to build? Who is it for?';
    const first = check(reply);
    expect(check(reply)).toEqual(first);
    expect(check(first.repaired ?? '').ok).toBe(true);
  });

  it('stays linear on a long reply', () => {
    const long = 'We could look at that from many sides and weigh each of them. '.repeat(400);
    const started = performance.now();
    check(long);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
