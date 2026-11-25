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
  composedAnswer,
  firstUnitVerdict,
  isServerText,
  isTemplateLine,
  namesStep,
  opensStep,
  playKey,
  saysDue,
  shortAnswer,
  spokenReserve,
  stepLine,
  subSteps,
  withoutDeadline,
  StepTalk,
} from './reply-contract.js';
import { unitsOf, wordsIn } from './units.js';

const check = (
  reply: string,
  guidance: PromptGuidance = SERVICE_OR_PRODUCT,
  channel: 'text' | 'voice' = 'text',
  founderText = 'Helpers that sort invoices for small shops. Service, software, or both?',
) => checkReplyContract({ reply, guidance, channel, today: TODAY, founderText });

/** The step line as the server writes it, and as the model used to. */
const NEXT = stepLine(STEP, 'text', TODAY);
const OWN_NEXT =
  'Next: list 20 office managers who run admin by hand and message 5 of them by Thursday. Done when you have 20 names and two calls booked.';
const IP_STEP = IP_REFERRAL.step ?? STEP;
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
      'no ask: what the model said, and the step',
      `Start with people, not code: they show you the work, and the work tells you what to build.\n\n${NEXT}`,
      STEP_ONLY,
    ],
    [
      'a call: answer, reason, step, day',
      `Do both, in order: run it by hand as a paid service for three companies, then automate what repeats. You get paid to see the real workflow. ${stepLine(STEP, 'voice', TODAY)}`,
      SERVICE_OR_PRODUCT,
      'voice',
    ],
    [
      'the referral said in its own words',
      'Assume the university may own part of it until the technology transfer office tells you; ownership usually turns on who paid, whose equipment you used and what you signed. They decide it, so see the technology transfer office with the lab agreement and grant terms, and a lawyer before signing.\n\n' +
        stepLine(IP_STEP, 'text', TODAY),
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

  it('a recall ends on the step too, with the day it had when that day has passed', () => {
    const record =
      'Your idea is BenchTally: tracking shared lab equipment. On October 20 you decided to sell to lab managers.';
    expect(check(record, RECALL).repaired).toBe(`${record}\n\n${NEXT}`);
    expect(check(`${record}\n\n${NEXT}`, RECALL).ok).toBe(true);
    const late = { ...RECALL, step: { ...STEP, dueOn: '2020-01-03' } };
    expect(check(record, late).repaired).toMatch(/\. It was due Friday, January 3\. Done when /);
    expect(check(record, late, 'voice').repaired).toMatch(/ It was due Friday, January 3\.$/);
    expect(check(check(record, late).repaired ?? '', late).ok).toBe(true);
  });
});

describe('the model writes the answer, the server the one step line', () => {
  it('writes the step line under an answer, before the one question', () => {
    const out = check(`${GOOD_ANSWER}\n\nWhich office do you know best?`);
    expect(out.findings).toEqual(['missing_step']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}\n\nWhich office do you know best?`);
  });

  it.each([
    ['the step in other words', OWN_NEXT],
    ['a step of its own', 'Next: build a landing page by Friday. Done when it is live.'],
    [
      'a step line run on into its parts',
      'Next: Write the list: names, jobs and emails. One page. The emails come from their site. Done when you have the list written, by Monday.',
    ],
    ['a step line in bold', '**Next step:** design a logo and a name. Do it by Monday.'],
    [
      'a sentence that says the next step',
      'Your next step is to build a landing page and collect emails. Put it online by Friday. Done when ten people signed up.',
    ],
    ['two step lines', `${OWN_NEXT}\n\nNext: Find the pattern by Monday. Done when the table is written.`],
    [
      'a question inside it',
      'Next: Text one neighbour tonight and ask: “How did you handle it last time?” in 10 minutes. Done when they reply.',
    ],
    ['the list under it', 'Next:\n\n1. Build a page.\n2. Buy a domain.\n3. Post it.'],
    [
      'only when and done',
      'Do it by Wednesday, December 2. Done when one sentence exists that 4 of 5 people can say back.',
    ],
    ['a deadline alone', 'Do this by Thursday.'],
    ['a done-when alone', '**Done when:** five lines are written and one talk is booked.'],
  ])('drops %s, whole', (_, talk) => {
    const out = check(`${GOOD_ANSWER}\n\n${talk}`);
    expect(out.findings).toContain('step_talk');
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
    expect(out.repaired?.match(/Next:/g)).toHaveLength(1);
    expect(out.repaired?.match(/Done when/g)).toHaveLength(1);
  });

  it('drops the step’s own parts as a list, with the line that announces them', () => {
    const items = STEP.items.map((i, n) => `${String(n + 1)}. ${i.do}. ${i.how}`).join('\n');
    const out = check(`${GOOD_ANSWER}\n\nHere’s what to do:\n\n${items}\n\nDone when you have them.`);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
  });

  it('keeps a list that is no step of the path’s, whole, and a draft or a template', () => {
    const list = '1. Start by hand.\n2. Charge for it.\n3. Automate what repeats.';
    expect(check(`${GOOD_ANSWER}\n\n${list}`).repaired).toBe(`${GOOD_ANSWER}\n\n${list}\n\n${NEXT}`);
    const template =
      'Here is the page:\n\n1. Who: office managers\n2. Problem: [what goes wrong]\n3. Why me: [what I know]';
    expect(check(`${GOOD_ANSWER}\n\n${template}`).repaired).toBe(`${GOOD_ANSWER}\n\n${template}\n\n${NEXT}`);
  });

  it('never drops what the answer says next to a step line: the paragraph after it stays', () => {
    const out = check(
      `${GOOD_ANSWER}\n\n${OWN_NEXT}\n\nA short note to send: "Could I watch you do the filing once?"`,
    );
    expect(out.repaired).toBe(
      `${GOOD_ANSWER}\n\nA short note to send: "Could I watch you do the filing once?"\n\n${NEXT}`,
    );
  });

  it('"Next," in an order of slides is no step line', () => {
    const order =
      'Open with the person and the problem. Next, who you serve first and how you get paid. Then the money in one sale.';
    expect(check(`${GOOD_ANSWER} ${order}`).repaired).toContain(order);
  });

  it('a reply that was only step talk gets the program’s answer, never a step line alone', () => {
    for (const reply of [
      'Do it by Wednesday, December 2. Done when one sentence exists that 4 of 5 people can say back.',
      'One card. Done when you have the offer written, by Monday.',
      OWN_NEXT,
      'Your next step is to build a landing page and collect emails.',
    ]) {
      const out = check(reply).repaired ?? '';
      expect(out).toContain('Both, in this order: do it by hand as a paid service');
      expect(out.endsWith(NEXT)).toBe(true);
      expect(out).not.toMatch(/landing page|Wednesday/);
    }
  });

  it('with no answer of the program’s, what is left too short is said with the step’s parts, and no stage nobody asked for', () => {
    const out = check('Okay.', STEP_ONLY, 'text', 'ok so').repaired ?? '';
    expect(out).toContain('Here is how the step goes:');
    expect(out).not.toContain('You are at ');
    expect(out).toContain('\n\n1. Write 20 names');
    expect(out.endsWith(NEXT)).toBe(true);
    expect(subSteps(STEP, 'voice')).toMatch(/^First write 20 names[^.]*, then [^.]*\.$/);
    expect(subSteps(STEP, 'text').split('\n')).toHaveLength(STEP.items.length);
  });

  it('a reply is never given a date that is not the step’s', () => {
    const out = check(`${GOOD_ANSWER} Send the first five notes by Sunday, November 29.`);
    expect(out.findings).toContain('wrong_date');
    expect(out.repaired).toContain('Send the first five notes.');
    expect(out.repaired).not.toContain('November 29');
    // Their own day stays.
    const theirs: PromptGuidance = { ...SERVICE_OR_PRODUCT, said: 'I have a class demo by December 1.' };
    expect(withoutDeadline('Have the demo ready by December 1.', theirs, TODAY)).toBe(
      'Have the demo ready by December 1.',
    );
    expect(withoutDeadline('You said you would call them by Sunday.', SERVICE_OR_PRODUCT, TODAY)).toContain(
      'by Sunday',
    );
  });

  it('a template filled with their idea is a template line; a label of no template is not', () => {
    expect(isTemplateLine('5. **Why me**: [what I know]', SERVICE_OR_PRODUCT)).toBe(true);
    expect(isTemplateLine('Today: they call around', null)).toBe(true);
    expect(isTemplateLine('Remember: charge for it', SERVICE_OR_PRODUCT)).toBe(false);
  });

  it('a step that asks "how do I do that?" keeps its first part, explained', () => {
    const how: PromptGuidance = { ...STEP_ONLY, howTo: true };
    const reply = `Start with the first part: ${STEP.items[0]?.do.toLowerCase() ?? ''}. ${STEP.items[0]?.how ?? ''}`;
    expect(
      check(`${reply} It is the part you can finish today, and it shows who to write to.`, how).repaired,
    ).toContain(reply);
  });

  it('reads a streamed reply unit by unit the same way', () => {
    const talk = new StepTalk(SERVICE_OR_PRODUCT);
    expect(talk.drops('Both, in this order.')).toBe(false);
    expect(talk.drops('\n\nNext: build a page.')).toBe(true);
    expect(talk.drops(' One page.')).toBe(true);
    expect(talk.drops('\n1. Buy a domain.')).toBe(true);
    expect(talk.drops('\n\nCharge the buyer.')).toBe(false);
    expect(talk.drops(' Done when it is live.')).toBe(true);
    expect(talk.drops(' Then tell them.')).toBe(true);
    for (const line of [
      'Next: x y z',
      'Your next step is below.',
      'What to do next: sell.',
      'A good next move: run five talks.',
    ])
      expect(opensStep(line), line).toBe(true);
    for (const line of [
      'After that, sell it.',
      'The next stage is validation.',
      'Is your next step to build a page?',
      'A good first step is to write names.',
    ])
      expect(opensStep(line), line).toBe(false);
    for (const line of [
      'Do it by Monday.',
      'By Friday, December 5.',
      'Done when it is live.',
      'Do this in 20 minutes.',
    ])
      expect(saysDue(line), line).toBe(true);
    for (const line of ['Sell by hand.', 'By hand you learn more.', 'Ask by email.'])
      expect(saysDue(line), line).toBe(false);
  });
});

describe('what the server says first', () => {
  const LEAD: PromptGuidance = {
    ...SERVICE_OR_PRODUCT,
    kind: 'news',
    ask: null,
    lead: {
      text: '13 of 25 paid, 52%. You set no number to beat first, so treat it as a first reading.',
      voice: '13 of 25 paid, 52%. It is a first reading.',
    },
  };
  const AFTER = 'The yes came from people who walked past at noon, and that is the moment to sell at.';

  it('opens the reply, word for word, before what the model adds, and the step ends it', () => {
    const out = check(AFTER, LEAD, 'text', '13 of 25 sold');
    expect(out.findings).toEqual(['missing_lead', 'missing_step']);
    expect(out.repaired).toBe(`${LEAD.lead?.text ?? ''}\n\n${AFTER}\n\n${NEXT}`);
    expect(check(out.repaired ?? '', LEAD, 'text', '13 of 25 sold')).toEqual({
      ok: true,
      findings: [],
      repaired: null,
    });
    expect(check(AFTER, LEAD, 'voice', '13 of 25 sold').repaired).toBe(
      `${LEAD.lead?.voice ?? ''} ${AFTER} ${stepLine(STEP, 'voice', TODAY)}`,
    );
  });

  it('is never said again by the model, in its words or with the same figures, nor answered with a verdict alone', () => {
    const out = check(
      `Got it. That’s a strong signal. 13 of 25 paid, which is 52%, and that is a first reading. ${AFTER}`,
      LEAD,
      'text',
      '13 of 25 sold',
    );
    expect(out.repaired).toBe(`${LEAD.lead?.text ?? ''}\n\n${AFTER}\n\n${NEXT}`);
  });

  it('is the whole answer when the model adds nothing', () => {
    expect(check('', LEAD, 'text', '13 of 25 sold').repaired).toBe(`${LEAD.lead?.text ?? ''}\n\n${NEXT}`);
    expect(composedAnswer(LEAD, 'text')).toBe(LEAD.lead?.text);
  });
});

describe('the one number that is missing, and the one thing on record', () => {
  it('asks for the number as the one question, whatever the model asks', () => {
    const lacks: PromptGuidance = {
      ...SERVICE_OR_PRODUCT,
      askBack: 'What does one box cost you to make and deliver?',
    };
    const out = check(`${GOOD_ANSWER}\n\nWhich office do you know best?`, lacks);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}\n\nWhat does one box cost you to make and deliver?`);
    expect(check(out.repaired ?? '', lacks)).toEqual({ ok: true, findings: [], repaired: null });
  });

  const PRIOR: PromptGuidance = {
    ...SERVICE_OR_PRODUCT,
    prior: {
      fact: 'two offices pay 30 dollars a month since the pilot began',
      sentence: 'Build on what you have: two offices pay 30 dollars a month since the pilot began.',
    },
  };

  it('says the prior fact on a typed turn that left it out, before the step', () => {
    const out = check(GOOD_ANSWER, PRIOR);
    expect(out.findings).toEqual(['missing_step', 'missing_prior']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${PRIOR.prior?.sentence ?? ''}\n\n${NEXT}`);
    expect(check(out.repaired ?? '', PRIOR).repaired).toBeNull();
  });

  it('never when the reply says it in its own words, on a call, or with nothing to say', () => {
    const woven = `${GOOD_ANSWER} Two offices already pay you 30 dollars, so ask them first.`;
    expect(check(woven, PRIOR).repaired).toBe(`${woven}\n\n${NEXT}`);
    expect(check(GOOD_ANSWER, PRIOR, 'voice').repaired).not.toContain('Build on what you have');
    // On a call only what is meant for one: their idea, asked about itself.
    const idea: PromptGuidance = {
      ...PRIOR,
      prior: {
        fact: 'invoices for small shops',
        sentence: 'x',
        spoken: 'That is for your idea: invoices for small shops.',
      },
    };
    expect(check(GOOD_ANSWER, idea, 'voice').repaired).toContain(
      ' That is for your idea: invoices for small shops. Your',
    );
    const silent: PromptGuidance = { ...PRIOR, prior: { fact: 'invoices for small shops', sentence: '' } };
    expect(check(GOOD_ANSWER, silent).findings).toEqual(['missing_step']);
  });
});

describe('a reply that does not help is repaired from the path (the client’s live test, re-created)', () => {
  it('refused to answer and asked instead', () => {
    const out = check(
      "Before we pick a structure, I'd want to understand who feels this pain most. What's your plan to reach someone like that?",
    );
    expect(out.findings).toEqual(
      expect.arrayContaining<ReplyContractFinding>(['question_only', 'deferral', 'missing_step']),
    );
    expect(out.repaired).toContain('Both, in this order: do it by hand as a paid service');
    expect(out.repaired).toContain('[E1]');
    expect(out.repaired).toContain(NEXT);
    expect(out.repaired).not.toMatch(/before we|your plan for|\?/i);
    expect(check(out.repaired ?? '').ok).toBe(true);
  });

  it('asked two questions and gave no plan', () => {
    const out = check('What have you built so far? And who is it for?', STEP_ONLY);
    expect(out.findings).toContain('question_only');
    expect(out.findings).toContain('stacked_questions');
    // The step's parts lead; the last question may stay, after them.
    expect(out.repaired?.startsWith('Here is how the step goes:')).toBe(true);
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
    expect(out.repaired).toContain(NEXT);
    expect(check(out.repaired ?? '').repaired).toBeNull();
  });

  it('keeps what the model said and drops only what puts it off', () => {
    const out = check(
      `Before we decide that, sell it by hand as a paid service to three companies, then automate what repeats.\n\n${NEXT}`,
    );
    expect(out.findings).toEqual(['deferral']);
    expect(out.repaired).toBe(
      `Sell it by hand as a paid service to three companies, then automate what repeats.\n\n${NEXT}`,
    );
  });

  it('drops a pure deferral in front of a full answer', () => {
    const out = check(`Before we dive in, I need to understand your market. ${GOOD_ANSWER}\n\n${NEXT}`);
    expect(out.findings).toEqual(['deferral']);
    expect(out.repaired).toBe(`${GOOD_ANSWER}\n\n${NEXT}`);
  });

  it('adds the answer when the reply talked around it', () => {
    const out = check(
      `Admin work is a big market and many teams are entering it now with new tools.\n\n${NEXT}`,
    );
    expect(out.findings).toEqual(['missing_answer']);
    expect(out.repaired).toContain('Both, in this order: do it by hand as a paid service');
    expect(out.repaired).toContain('Admin work is a big market');
    expect(out.repaired).toContain(NEXT);
  });

  it('leaves at most one question', () => {
    const out = check(
      `${GOOD_ANSWER} Who would you call first? Do you know any office managers? And do they have a budget?`,
    );
    expect(out.findings).toContain('stacked_questions');
    expect(out.repaired).not.toContain('Who would you call first?');
    expect(out.repaired?.match(/\?/g)).toHaveLength(1);
    expect(out.repaired?.endsWith('And do they have a budget?')).toBe(true);
  });

  it('"Or …?" goes on from the question before it', () => {
    expect(check(`${GOOD_ANSWER}\n\nIs it offices? Or clinics?`).findings).toEqual(['missing_step']);
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
      'Assume the university may own part of it until you know; ownership usually turns on who paid for the work, whose equipment you used and what you signed.',
      IP_REFERRAL,
    );
    expect(out.findings).toContain('missing_referral');
    expect(out.repaired).toContain(
      'A qualified person decides this: the university technology transfer office',
    );
    expect(out.repaired).toContain('bring them the invention history page');
  });

  it('never drops a new idea or the venture silently, in one sentence', () => {
    const out = check(
      `Run it by hand as a paid service for three companies, then automate what repeats.\n\n${NEXT}`,
      NEW_IDEA,
    );
    expect(out.findings).toEqual(['missing_answer']);
    expect(out.repaired).toContain(
      'This is a different idea from BenchTally, where 2 paid pilots at $40 per lab per month: make it a change of direction for BenchTally, or ask your program lead for a separate workspace.',
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
      'That is not BenchTally, where 2 paid pilots at $40 per lab per month.',
    );
    expect(noFact.repaired).not.toContain('This is a different idea');
    const noWays = check(`This is another idea than BenchTally and its 2 paid pilots. ${answer}`, NEW_IDEA);
    expect(noWays.repaired).toContain(
      'Make it a change of direction for BenchTally, or ask your program lead for a separate workspace.',
    );
    expect(noWays.repaired).not.toContain('That is not BenchTally');
  });

  it('a report that only asks back is answered with the step that follows', () => {
    const out = check('How did it go? What did they say?', REPORT, 'text', 'I sent the email on Monday.');
    expect(out.findings).toContain('question_only');
    expect(out.repaired).toContain(NEXT);
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
      released: 'There is a lot going on in this area at the moment, and many teams are in it.',
      answerWords: 16,
      guidance,
      channel,
      today: TODAY,
      founderText: 'My classmates like it. Is that enough?',
    }).before;

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

describe('who decides', () => {
  const ANSWER =
    'Assume the university may own part of it until you know; ownership usually turns on who paid for the work, whose equipment you used and what you signed.';
  const IP_NEXT = stepLine(IP_STEP, 'text', TODAY);

  it('is said with what to bring, once, on a call too', () => {
    const out = check(ANSWER, IP_REFERRAL, 'voice');
    expect(out.findings).toContain('missing_referral');
    expect(out.repaired?.match(/A qualified person decides this/g)).toHaveLength(1);
    expect(out.repaired).toContain('the university technology transfer office');
    expect(out.repaired).toContain(
      'bring them the invention history page, the lab agreement and any grant terms.',
    );
    expect(check(out.repaired ?? '', IP_REFERRAL, 'voice').findings).not.toContain('missing_referral');
  });

  it('adds only what to bring when the reply named who', () => {
    const out = check(`${ANSWER} The technology transfer office decides it.\n\n${IP_NEXT}`, IP_REFERRAL);
    expect(out.findings).toEqual(['missing_referral']);
    expect(out.repaired).not.toContain('A qualified person');
    // To them, in the same sentence: never "Bring …" to nobody.
    expect(out.repaired).toContain(
      'Bring the university technology transfer office the invention history page, the lab agreement and any grant terms.',
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
    const line = /bring [^.]*\./i.exec(composeFromGuidance(long, 'voice', TODAY))?.[0] ?? '';
    expect(line).toBe(
      'bring them a one-page timeline, the lab and its funding, everyone involved, papers you signed.',
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
        released: ANSWER,
        answerWords: wordsIn(ANSWER),
        guidance: IP_REFERRAL,
        channel: 'text',
        today: TODAY,
      }).before,
    ).toBe(
      'A qualified person decides this: the university technology transfer office, and a lawyer before you sign anything; bring them the invention history page, the lab agreement and any grant terms.',
    );
  });
});

describe('a recall the record answers', () => {
  const RECORD: PromptGuidance = {
    ...RECALL,
    lead: {
      text: 'Your idea is BenchTally: tracking shared lab equipment. On October 20 you decided to sell to lab managers.',
      voice:
        'Your idea is BenchTally: tracking shared lab equipment. On October 20 you decided to sell to lab managers.',
    },
  };
  const asked = 'What is my startup, and what did we decide?';

  it('is said first, text and call, with the step line under it', () => {
    const out = check('How would you apply that this week?', RECORD, 'text', asked);
    expect(out.repaired?.startsWith(RECORD.lead?.text ?? '-')).toBe(true);
    expect(out.repaired).toContain(NEXT);
    const call = check('Yes, I do remember all of it.', RECORD, 'voice', asked);
    expect(call.repaired).toContain('On October 20 you decided to sell to lab managers.');
  });

  it('is left alone once it opens the reply', () => {
    const reply = `${RECORD.lead?.text ?? ''}\n\nThe buyer you chose is the one who signs for equipment.\n\n${NEXT}`;
    expect(check(reply, RECORD, 'text', asked)).toEqual({ ok: true, findings: [], repaired: null });
  });
});

describe('a call', () => {
  it('is repaired in speech: the answer, then the step and its day, no Markdown or ids', () => {
    const out = check('Before we get into that, who is your customer?', SERVICE_OR_PRODUCT, 'voice');
    expect(out.repaired).toBe(
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code. Your next step: list 20 office managers who run admin by hand and message 5 of them by Thursday.',
    );
    expect((out.repaired ?? '').split(/\s+/).length).toBeLessThanOrEqual(65);
  });

  it('takes the model’s own step out of what is said, and says the step once, in one sentence', () => {
    const out = check(
      'Do both, in order: a paid service by hand for three companies, then automate what repeats. Your next step: list 20 office managers by Friday.',
      SERVICE_OR_PRODUCT,
      'voice',
    );
    expect(out.repaired).toBe(
      `Do both, in order: a paid service by hand for three companies, then automate what repeats. ${stepLine(STEP, 'voice', TODAY)}`,
    );
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

  it('the tail adds what is missing of the answer, then the step line', () => {
    const tail = (
      released: string,
      guidance: PromptGuidance = SERVICE_OR_PRODUCT,
      channel: 'text' | 'voice' = 'text',
    ) =>
      contractTail({
        released,
        answerWords: wordsIn(released),
        guidance,
        channel,
        today: TODAY,
        founderText: 'Service or product?',
      });
    expect(tail(GOOD_ANSWER)).toEqual({ before: '', step: NEXT, findings: [] });
    expect(tail('').before).toBe(composedAnswer(SERVICE_OR_PRODUCT, 'text'));
    expect(tail('').findings).toEqual(['question_only']);
    expect(tail('Admin work is a big market with many new tools in it, and more come.').before).toBe(
      'Both, in this order: do it by hand as a paid service for the first three companies, then turn the part you repeat into software. A service earns money and shows you the real workflow before you write code [E1].',
    );
    expect(tail('', SOCIAL)).toEqual({ before: '', step: '', findings: [] });
    expect(tail(GOOD_ANSWER, SERVICE_OR_PRODUCT, 'voice').step).toBe(
      'Your next step: list 20 office managers who run admin by hand and message 5 of them by Thursday.',
    );
  });

  it('the step and the answer are never repeats, a check-in question is no step', () => {
    expect(carriesContract(NEXT, SERVICE_OR_PRODUCT)).toBe(true);
    expect(carriesContract('Done when you have 20 names written down.', SERVICE_OR_PRODUCT)).toBe(true);
    expect(
      isServerText(
        'A service earns money and shows you the real workflow before you write code.',
        SERVICE_OR_PRODUCT,
        'text',
      ),
    ).toBe(true);
    expect(isServerText('A landing page comes first.', SERVICE_OR_PRODUCT, 'text')).toBe(false);
    expect(carriesContract('Did you message the office managers?', SERVICE_OR_PRODUCT)).toBe(false);
    expect(carriesContract('Pricing follows the buyer.', SERVICE_OR_PRODUCT)).toBe(false);
    expect(carriesContract(NEXT, SOCIAL)).toBe(false);
  });
});

describe('the step line', () => {
  const step = STEP;
  it.each([
    ['2026-11-24', 'message 5 of them today. Done'],
    ['2026-11-25', 'by tomorrow. Done'],
    ['2026-11-26', 'by Thursday, November 26. Done'],
    ['2026-11-30', 'by Monday, November 30. Done'],
    ['2026-12-04', 'by Friday, December 4. Done'],
  ])('says %s as "%s"', (dueOn, said) => {
    expect(stepLine({ ...step, dueOn }, 'text', TODAY)).toContain(said);
  });
  it('says no day when the step has none', () => {
    expect(stepLine({ ...step, dueOn: null }, 'text', TODAY)).toBe(
      '**Next:** List 20 office managers who run admin by hand and message 5 of them. Done when you have 20 names written down and two calls booked.',
    );
  });
  it('is one short sentence on a call, and reads "today"', () => {
    expect(stepLine({ ...step, dueOn: TODAY }, 'voice', TODAY)).toBe(
      'Your next step: list 20 office managers who run admin by hand and message 5 of them today.',
    );
    expect(
      stepLine({ ...step, said: 'Write the pitch (what you say in 30 seconds)' }, 'text', TODAY),
    ).toContain('**Next:** Write the pitch (what you say in 30 seconds) by Thursday, November 26.');
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

describe('an answer found by meaning: a way out', () => {
  const MEANT: PromptGuidance = { ...SERVICE_OR_PRODUCT, matched: 'semantic' };
  const founder = 'My invoices keep coming back unpaid from the school, what do I do with them?';
  const OWN =
    'Ring the payables desk and ask which reference number is missing, because a school ignores an invoice without one. Send it again the same afternoon with that number at the top.';

  it('is never forced into a reply that answers something else with substance', () => {
    for (const channel of ['text', 'voice'] as const) {
      const out = check(OWN, MEANT, channel, founder);
      expect(out.findings).not.toContain('missing_answer');
      expect(out.repaired ?? '').not.toContain('paid service');
      // The step line is kept, and nothing else of the path.
      expect(out.repaired).toContain('20 office managers');
      const tail = contractTail({
        released: OWN,
        answerWords: wordsIn(OWN),
        guidance: MEANT,
        channel,
        today: TODAY,
        founderText: founder,
      });
      expect(tail.step).toContain('20 office managers');
      expect(tail.before).toBe('');
    }
    // An ask a phrase named is answered from the program, as before.
    expect(check(OWN, SERVICE_OR_PRODUCT, 'text', founder).findings).toContain('missing_answer');
  });

  it.each([
    ['only asks', 'What do you sell to them? And who signs?'],
    [
      'puts it off',
      'Before we get into that, I need to know more about the school. It is important to be clear.',
    ],
    ['says nothing', 'Good point.'],
    ['is empty', ''],
  ])('is said for a reply that %s', (_, reply) => {
    const out = check(reply, MEANT, 'text', founder);
    expect(out.findings.some((f) => f === 'missing_answer' || f === 'question_only')).toBe(true);
    expect(out.repaired).toContain('paid service');
  });
});

describe('a step that is not about what they asked', () => {
  const asked = 'My invoices keep coming back unpaid from the school, what do I do with them?';
  const OWN =
    'Ring the payables desk and ask which purchase order number is missing, because a school pays nothing without one.';
  const STANDING: PromptGuidance = { ...STEP_ONLY, matched: 'none', stepRole: 'standing' };
  const QUIET: PromptGuidance = { ...STEP_ONLY, matched: 'none', stepRole: 'quiet' };
  const STANDS =
    '**On your path, next is:** List 20 office managers who run admin by hand and message 5 of them by Thursday, November 26.';
  const tail = (guidance: PromptGuidance, channel: 'text' | 'voice') =>
    contractTail({ released: OWN, answerWords: wordsIn(OWN), guidance, channel, today: TODAY });

  it('is said once, last, as what stands on their path', () => {
    const out = check(OWN, STANDING, 'text', asked);
    expect(out.repaired).toBe(`${OWN}\n\n${STANDS}`);
    expect(check(`${OWN}\n\n${STANDS}`, STANDING, 'text', asked)).toEqual({
      ok: true,
      findings: [],
      repaired: null,
    });
    expect(tail(STANDING, 'text')).toEqual({ before: '', step: STANDS, findings: [] });
    expect(tail(STANDING, 'voice').step).toBe(
      'On your path, next is: list 20 office managers who run admin by hand and message 5 of them by Thursday.',
    );
  });

  it('is never given as if it answered them', () => {
    const out = check(`${OWN}\n\n${OWN_NEXT}`, STANDING, 'text', asked);
    expect(out.findings).toContain('step_talk');
    expect(out.repaired).toBe(`${OWN}\n\n${STANDS}`);
  });

  it('said in the reply before, a call does not say it again; a typed reply always has it', () => {
    const line = tail(STANDING, 'text').step;
    expect(line).toMatch(/^\*\*On your path, next is:\*\* /);
    expect(check(OWN, QUIET, 'text', asked).repaired).toBe(`${OWN}\n\n${line}`);
    expect(check(`${OWN}\n\n${line}`, QUIET, 'text', asked).ok).toBe(true);
    expect(tail(QUIET, 'voice')).toEqual({ before: '', step: '', findings: [] });
    expect(check(OWN, QUIET, 'voice', asked)).toEqual({ ok: true, findings: [], repaired: null });
    expect(spokenReserve(QUIET, '', TODAY)).toBe(0);
    expect(spokenReserve(STANDING, '', TODAY)).toBeGreaterThan(5);
  });

  it('is deterministic and idempotent', () => {
    for (const guidance of [STANDING, QUIET]) {
      const once = check(`${OWN}\n\n${OWN_NEXT}`, guidance, 'text', asked).repaired ?? '';
      expect(check(once, guidance, 'text', asked).repaired).toBeNull();
    }
  });
});

describe('a choice they ask to have made', () => {
  const choosing = (options: string[], kind: 'either' | 'yes_no' | 'which' = 'either'): PromptGuidance => ({
    ...STEP_ONLY,
    matched: 'none',
    choice: { kind, options },
  });
  const finds = (reply: string, guidance: PromptGuidance): boolean =>
    checkReplyContract({ reply, guidance, channel: 'text', today: TODAY }).findings.includes('missing_pick');

  it.each<[string, boolean]>([
    ['Sell to the museum first. Visitors use it, and the museum pays for it every month.', false],
    ['Both, in this order: the museum pays, and the visitors show that it works for them.', false],
    ['Neither: nobody has paid yet, so ask five of each group for a deposit this week first.', false],
    ['There are good reasons on each side, and it all comes down to who has the money here.', true],
    ['People pay for what saves them time, so look at who loses the most of it in a week.', true],
  ])('%s', (reply, missing) => {
    expect(finds(reply, choosing(['to the museum', 'to visitors']))).toBe(missing);
  });

  it.each<[string, boolean]>([
    ['Yes, your cousin can do the list, and you do the talks, because the talks are the work.', false],
    ['Not yet: a pilot counts as a sale only when it is paid, and this one is free so far.', false],
    ['A pilot that could prove you wrong can be smaller than founders expect it to be at first.', true],
  ])('yes or no: %s', (reply, missing) => {
    expect(finds(reply, choosing(['yes', 'no'], 'yes_no'))).toBe(missing);
  });

  it('is not asked of a reply that opens with the pick, or where no option is known', () => {
    const lead = { text: 'East: 6 of 20 (30%), against 11 of 60 (18%) for the other.', voice: 'East.' };
    expect(
      finds('People there buy more often than anyone else does, so stay there.', {
        ...choosing(['east', 'west']),
        lead,
      }),
    ).toBe(false);
    expect(
      finds('Look at who loses the most time in a week, and stay with them.', choosing([], 'which')),
    ).toBe(false);
  });
});

describe('who decides is said once', () => {
  it('a second time in one reply goes, and stays out', () => {
    const who = 'Ask the university technology transfer office, and a lawyer before you sign anything.';
    const bring = 'Bring the invention history page, the lab agreement and any grant terms.';
    const again =
      'That one is for the university technology transfer office, and a lawyer before you sign anything. Bring the invention history page, the lab agreement and any grant terms.';
    const reply = `${IP_REFERRAL.ask?.answer ?? ''} ${who} ${bring}\n\n${again}`;
    const out = check(reply, IP_REFERRAL).repaired ?? '';
    expect(out.match(/a lawyer before you sign anything/g)).toHaveLength(1);
    expect(out.match(/invention history page/g)).toHaveLength(1);
    expect(check(out, IP_REFERRAL).repaired).toBeNull();
  });

  it('told before, the office alone is enough', () => {
    const told: PromptGuidance = {
      ...IP_REFERRAL,
      ask: {
        ...IP_REFERRAL.ask,
        title: 'x',
        answer:
          'Only the university technology transfer office can say, and a yes or no from me would be a guess.',
        why: '',
        traps: [],
        evidenceKeys: [],
      },
      referral: { ...(IP_REFERRAL.referral ?? { who: '', bring: '' }), told: true },
    };
    const reply =
      'Only the university technology transfer office can say, and a yes or no from me would be a guess today.';
    expect(check(reply, told).repaired).not.toContain('Bring');
    expect(check(reply, told).repaired).not.toContain('A qualified person decides');
  });
});

describe('what the server says in place of too little', () => {
  it('is what the path gives for it, never the list of a moment ago', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      fallback: {
        text: 'One part, then: Book two calls. Offer two times this week.',
        voice: 'Book two calls.',
      },
    };
    const out = check('Okay.', guidance, 'text', 'again').repaired ?? '';
    expect(out).toContain('One part, then: Book two calls.');
    expect(out).not.toContain('Here is how the step goes');
  });

  it('a step cut to parts says which, when they fit a line', () => {
    const step = { ...STEP, doneWhen: 'These 3 parts are done: write it; mark it; choose one.' };
    expect(stepLine(step, 'text', TODAY)).toMatch(
      /Done when these 3 parts are done: write it; mark it; choose one\.$/,
    );
    const long = { ...STEP, doneWhen: `These 3 parts are done: ${'write the page in words; '.repeat(9)}` };
    expect(stepLine(long, 'text', TODAY)).toMatch(/Done when these 3 parts are done\.$/);
  });
});
