import { describe, expect, it } from 'vitest';

import type { PromptGuidance } from '../prompts/guidance.js';
import { IP_REFERRAL, SERVICE_OR_PRODUCT, SOCIAL, STEP, STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { validateCoachResponse } from './coach-response.js';
import {
  StepTalk,
  anchored,
  checkReplyContract,
  isServerText,
  mayRepeat,
  opensStep,
  overTyped,
  pointsNowhere,
  repeatsReferral,
  rulesOnIt,
  saysNothing,
  stepLine,
  withoutLabel,
} from './reply-contract.js';
import { SentenceGate, type SentenceGateOptions } from './sentence-gate.js';

/** A reply as it is shown, streamed unit by unit, and as a whole reply is repaired. Synthetic wording. */
function stream(text: string, options: Partial<SentenceGateOptions> = {}) {
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: 'How do I do it?',
    guidance: STEP_ONLY,
    today: TODAY,
    callerContinues: true,
    ...options,
  });
  const out = [gate.open(), ...(text.match(/[\s\S]{1,9}/gu) ?? []).map((c) => gate.push(c)), gate.end()];
  return out
    .flatMap((o) => o.units)
    .map((u) => (options.spoken === true ? u.spoken : u.text))
    .join(options.spoken === true ? ' ' : '');
}
const whole = (reply: string, guidance: PromptGuidance = STEP_ONLY, channel: 'text' | 'voice' = 'text') => {
  const out = checkReplyContract({ reply, guidance, channel, today: TODAY, founderText: 'How do I do it?' });
  return { ...out, text: out.repaired ?? reply };
};
const NEXT = stepLine(STEP, 'text', TODAY);
const ANSWER =
  'Run it by hand as a paid service for three offices that still file on paper, because they lose the hours every week. The last invoice that went wrong there shows what it costs.';

describe('what the conversation said already is not said again', () => {
  const before = `${ANSWER} Start with the two who wrote to you.\n\n${NEXT}`;
  const more = [
    'Deliver the first one in two days.',
    'Ask for one name when they are happiest.',
    'One trap: doing it for free.',
    'Founders who wait lose the buyer.',
  ];

  it('a streamed reply that says it again gets what is new of the answer', () => {
    const text = stream(ANSWER, { previousReply: before, guidance: { ...SERVICE_OR_PRODUCT, more } });
    expect(text).not.toContain('Run it by hand');
    expect(text).toContain('Deliver the first one in two days. Ask for one name when they are happiest.');
    expect(text.endsWith(NEXT)).toBe(true);
    // No second model call is needed for it.
    expect(text).not.toContain('Founders who wait');
  });

  it('on a call it is one piece of it', () => {
    const text = stream(ANSWER, {
      previousReply: before,
      spoken: true,
      guidance: { ...SERVICE_OR_PRODUCT, more },
    });
    expect(text).toContain('Deliver the first one in two days.');
    expect(text).not.toContain('One trap');
  });

  it('in mostly the same words is the same, when there is more to say', () => {
    const near = 'The first offer goes to the office manager you know best and can reach today.';
    const again = 'The first pilot is sold to the office manager you know best and can reach.';
    const options = { previousReply: `${near}\n\n${NEXT}` };
    expect(stream(again, { ...options, guidance: { ...SERVICE_OR_PRODUCT, more } })).not.toContain(
      'first pilot',
    );
    expect(stream(`${again} ${ANSWER}`, options)).toContain('first pilot');
  });

  it('a whole reply keeps only what is new of it', () => {
    const out = validateCoachResponse(
      {
        mode: 'coach',
        answer: `${ANSWER} Then write down what each one paid for it last month.`,
        claims: [],
        uncertainty: [],
        challenge: null,
        next_actions: [],
        escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
        memory_candidates: [],
        follow_up_questions: [],
        rehearsal: null,
        spoken: null,
      },
      {
        evidenceKeys: new Set<string>(),
        preRisk: { categories: [] },
        otherVentureNames: [],
        otherVentureCanaries: [],
        personaName: 'Thomas',
        coverageThreshold: 0.6,
        founderText: 'How do I do it?',
        previousReply: before,
        guidance: STEP_ONLY,
        today: TODAY,
      },
    );
    expect(JSON.stringify(out)).toContain('what each one paid for it last month');
    expect(JSON.stringify(out)).not.toContain('Run it by hand');
  });

  it('nor within one reply', () => {
    const text = stream(
      `${ANSWER} Offer each one a date. The last invoice that went wrong there shows what it costs.`,
    );
    expect(text.match(/last invoice that/g)).toHaveLength(1);
    expect(
      whole(`${ANSWER} Offer each one a date. The last invoice that went wrong there shows what it costs.`)
        .text,
    ).toBe(`${ANSWER} Offer each one a date.\n\n${NEXT}`);
  });

  it('a lead, a working, the step line and who decides may be', () => {
    const guidance: PromptGuidance = { ...IP_REFERRAL, calc: ['$9 x 3 = $27'] };
    expect(mayRepeat('$9 x 3 = $27', guidance)).toBe(true);
    expect(mayRepeat('Ask the university technology transfer office.', guidance)).toBe(true);
    expect(mayRepeat('Ownership usually turns on who paid for the work.', guidance)).toBe(false);
    expect(mayRepeat('Ask the university technology transfer office.', SOCIAL)).toBe(false);
  });

  it('the program’s answer is not added twice when the reply holds its line in quotes', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      ask: {
        title: 'The hard question',
        answer: 'The first one for you: "Only 12: how do you know it was your doing?"',
        why: '',
        traps: [],
        evidenceKeys: [],
      },
    };
    const reply = 'They will ask this: "Only 12: how do you know it was your doing?"';
    expect(stream(reply, { guidance, spoken: true }).match(/Only 12/g)).toHaveLength(1);
  });

  it('a reply said again in plain words does not come back in its own', () => {
    const previous =
      'The north orders more for each boat you asked, so the demand there is stronger and worth going after first.';
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      restate: { how: 'plain', reply: previous },
      lead: {
        text: 'Go with the north. Out of ten you asked there, three said yes.',
        voice: 'Go with the north.',
      },
    };
    const out = stream('The north orders more for each boat you asked, so demand is stronger there.', {
      previousReply: previous,
      guidance,
    });
    expect(out).not.toContain('orders more for each boat');
  });
});

describe('two things asked, and what they set', () => {
  const guidance: PromptGuidance = {
    ...STEP_ONLY,
    parts: [
      {
        ask: 'who do I call',
        text: 'Call the office managers who file by hand.',
        voice: 'Call office managers.',
      },
      {
        ask: 'what do I charge',
        text: 'Charge what one lost invoice costs them today, for one month.',
        voice: 'Charge what one lost invoice costs them.',
      },
    ],
    limits: [{ said: 'this month', text: 'That is ten talks this month, so about three a week.' }],
  };

  it('a part left out is said by the server, and so is what they set', () => {
    const out = whole(
      'Call the office managers who file by hand, because the hours they lose come back weekly.',
      guidance,
    );
    expect(out.findings).toContain('missing_part');
    expect(out.text).toContain('Charge what one lost invoice costs them today');
    expect(out.text).toContain('ten talks this month');
    expect(out.text.match(/Call the office managers/g)).toHaveLength(1);
    // Nothing more to add the second time.
    expect(whole(out.text, guidance)).toMatchObject({ ok: true });
  });

  it('a reply that answers both, within it, is left alone', () => {
    const reply =
      'Call the office managers who file by hand. Charge what one lost invoice costs them for one month, and hold the ten talks this month.';
    expect(whole(reply, guidance).findings).not.toContain('missing_part');
  });

  it('on a call the part is said short', () => {
    expect(stream('Call office managers who file by hand.', { guidance, spoken: true })).toContain(
      'Charge what one lost invoice costs them.',
    );
  });
});

describe('one next thing in a reply', () => {
  it.each([
    'One small step: write ten names tonight.',
    'What to do now: send the note to two of them.',
    'Test that first: offer it to one loft.',
    'Your first step is to write ten names.',
    'The first step is to settle who holds it.',
    'The smallest thing you can do is call one loft.',
    'So the next concrete step is a call.',
  ])('%s', (unit) => {
    expect(opensStep(unit)).toBe(true);
    expect(stream(`${ANSWER}\n\n${unit}`)).toBe(`${ANSWER}\n\n${NEXT}`);
  });
  it.each([
    'A good first step shows people what you mean.',
    'One thing stands out: they pay twice.',
    'Testing that with five lofts took them a week.',
    'The smallest lofts pay first.',
  ])('%s is none', (unit) => {
    expect(opensStep(unit)).toBe(false);
  });

  it('where the server gives the one thing to do, the model gives no other', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      orders: true,
      lead: { text: 'So one thing: write five lines in plain words.', voice: 'One thing: write five lines.' },
    };
    const text = stream(
      'The least risky move is to talk to two lofts. Draft a survey and post it. Spend the first hour on the wording.\n\nThe page counts because it shows what is a guess.',
      { guidance },
    );
    expect(text).not.toMatch(/survey|two lofts|first hour/);
    expect(text).toContain('it shows what is a guess');
    // Any other turn may say what to do.
    expect(new StepTalk(STEP_ONLY).drops('Draft the note and post it.')).toBe(false);
  });

  it('a recall says the step with the day it was due and the new one', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      kind: 'recall',
      step: { ...STEP, wasDue: '2026-11-20' },
    };
    expect(
      whole('You were going to list 20 office managers and message 5 of them.', guidance).text,
    ).toContain('by Thursday, November 26. It was due Friday, November 20.');
  });
});

describe('what nobody asked for', () => {
  const guidance: PromptGuidance = { ...STEP_ONLY, template: 'shown' };
  it('the step’s own message, its blanks and its signature are left out of a reply', () => {
    const text = stream(
      `${ANSWER}\n\nHi there, I am a student looking at how offices handle filing. I would be glad to come by. Priya\n\nAsk them about one lost paper.`,
      { guidance },
    );
    expect(text).not.toMatch(/I am a student|glad to come|Priya/);
    expect(text).toContain('Ask them about one lost paper.');
  });

  it('unless they asked to have it written', () => {
    const draft: PromptGuidance = { ...STEP_ONLY, draft: true };
    expect(
      stream('"Hi there, I am a student looking at how offices handle filing."', { guidance: draft }),
    ).toContain('I am a student');
  });

  it.each([
    'If X or more agree, go on.',
    'What you found, in your own words: they file by hand.',
    "Here's the template:",
    'Here it is to fill in.',
    'Use the note below to book the first calls.',
  ])('%s says nothing', (unit) => {
    expect(saysNothing(unit, guidance)).toBe(true);
  });
  it.each([
    'Here is what it costs them: a day a week.',
    'Plan X was the first one.',
    'Ten or more yeses is enough.',
  ])('%s does', (unit) => {
    expect(saysNothing(unit, guidance)).toBe(false);
  });

  it('a label of the reading is said as a sentence', () => {
    expect(withoutLabel('What it does not show: whether they pay.')).toBe(
      'It does not show whether they pay.',
    );
    expect(withoutLabel('**What it means for your idea:** there is a first group.')).toBe(
      'There is a first group.',
    );
    expect(withoutLabel('What it costs them: a day a week.')).toBe('What it costs them: a day a week.');
  });

  it('a question about what went is not asked', () => {
    expect(pointsNowhere('When can you start those talks?', 'Write five lines.')).toBe(true);
    expect(pointsNowhere('When can you start those talks?', 'Hold ten talks.')).toBe(false);
    expect(pointsNowhere('When can you start?', 'Write five lines.')).toBe(false);
    expect(stream(`${ANSWER}\n\nWhich day can you start those interviews?`)).toBe(`${ANSWER}\n\n${NEXT}`);
  });
});

describe('nothing leans on what went', () => {
  it('a first sentence says of what it speaks', () => {
    expect(anchored("It doesn't yet prove that they pay.")).toBe(
      "What you told me doesn't yet prove that they pay.",
    );
    expect(anchored('It takes a week.')).toBe('It takes a week.');
  });

  it('what follows a line that went goes with it', () => {
    const lead = {
      text: 'Put it on one page: what you saw and what is a guess.',
      voice: 'Put it on one page.',
    };
    const text = stream(
      'It is on one page: what you saw and what is a guess. It also shows what you still have to learn from the people who decide. Two lofts pay 40 dollars.',
      { guidance: { ...STEP_ONLY, lead } },
    );
    expect(text).not.toContain('It also shows');
    expect(text).toContain('Two lofts pay 40 dollars.');
  });

  it('an announcement goes when what it announced went', () => {
    const text = stream(
      `${ANSWER}\n\nHere is a quick way to run it:\n\nNext: build a landing page by Friday.`,
    );
    expect(text).toBe(`${ANSWER}\n\n${NEXT}`);
    const kept = stream(`${ANSWER}\n\nHere is what they lose:\n\n- a day a week\n- two invoices a month`);
    expect(kept).toContain('Here is what they lose:\n\n- a day a week');
    // At the end of a reply it announces nothing.
    expect(stream(`${ANSWER} Here is a quick canvas for it:`)).toBe(`${ANSWER}\n\n${NEXT}`);
  });

  it('a question is asked last, also when everything after it went', () => {
    const asked = `${ANSWER}\n\nWhich office do you know best?\n\nNext: build a landing page by Friday.`;
    for (const text of [stream(asked), whole(asked).text])
      expect(text).toBe(`${ANSWER}\n\n${NEXT}\n\nWhich office do you know best?`);
    const before = `${ANSWER}\n\nWhich office do you know best?\n\nStart there, because they will pick up.`;
    expect(stream(before)).toBe(`${before}\n\n${NEXT}`);
  });

  it('a numbered list that lost an item counts on, and a fence is no part of a reply', () => {
    const text = stream(
      `${ANSWER}\n\nHere is the order:\n\n1. Call two offices.\n2. Ask if they would use it.\n3. Offer a date.\n\n\`\`\`\nSubject: A question\n\`\`\``,
    );
    expect(text).toContain('1. Call two offices.');
    expect(text).not.toContain('```');
    expect(text.match(/^\d\./gm)).toEqual(text.includes('3.') ? ['1.', '2.', '3.'] : ['1.', '2.']);
  });

  it('a question inside a letter written for them stays in it', () => {
    const letter = 'Send this:\n\nHi [name],\n\nCould I watch you file once?\n\nThanks,\nPriya';
    const guidance = { ...STEP_ONLY, draft: true } as PromptGuidance;
    expect(stream(letter, { guidance })).toContain('Could I watch you file once?\n\nThanks');
  });
});

describe('who decides', () => {
  it('is not ruled on by the reply', () => {
    for (const unit of [
      'So it looks like the lab owns it.',
      'That means the lab likely owns the patch.',
      'The grant paid, so ownership lies with the lab.',
    ])
      expect(rulesOnIt(unit, IP_REFERRAL), unit).toBe(true);
    for (const unit of [
      'The policy says the University owns what its money paid for.',
      'Whether the university owns it depends on who paid.',
    ])
      expect(rulesOnIt(unit, IP_REFERRAL), unit).toBe(false);
    expect(rulesOnIt('So it looks like the lab owns it.', STEP_ONLY)).toBe(false);
  });

  it('a name alone, after it was said, goes', () => {
    const before =
      'Ask the university technology transfer office, and a lawyer before you sign. Bring the invention history page, the lab agreement and any grant terms.';
    expect(repeatsReferral('The university technology transfer office.', before, IP_REFERRAL)).toBe(true);
    expect(repeatsReferral('Email the two people who built it.', before, IP_REFERRAL)).toBe(false);
  });
});

describe('the length of a typed answer', () => {
  const sentence =
    'Each of them told you what the filing cost last month in hours and money, so compare those two numbers first. ';
  const long = Array.from({ length: 9 }, (_, i) => sentence.replace('two', String(i + 2))).join('');

  it('a sentence that goes over is left out whole, and so is what comes after', () => {
    const words = (t: string) => (t.split('\n\n**Next')[0] ?? '').split(/\s+/).length;
    for (const text of [stream(long), whole(long).text]) {
      expect(words(text)).toBeLessThanOrEqual(120);
      expect(words(text)).toBeGreaterThan(60);
      expect(text.split('\n\n**Next')[0]).toMatch(/\.$/);
    }
  });

  it('less of it stands beside what the server says first, and always one sentence', () => {
    const lead = { text: Array.from({ length: 120 }, (_, i) => `w${String(i)}`).join(' '), voice: 'Short.' };
    expect(overTyped(sentence, 0, '', { ...STEP_ONLY, lead })).toBe(false);
    expect(overTyped(sentence, 24, 'x', { ...STEP_ONLY, lead })).toBe(true);
    expect(overTyped(sentence, 24, 'x', STEP_ONLY)).toBe(false);
  });

  it('a list goes on to its end, and what they asked to have written is as long as it is', () => {
    expect(overTyped('- and one more thing to write', 108, 'The list:\n- one', STEP_ONLY)).toBe(false);
    expect(overTyped(sentence, 108, 'x', { ...STEP_ONLY, draft: true })).toBe(false);
    expect(isServerText('Ownership usually turns on who paid for the work', IP_REFERRAL, 'text')).toBe(true);
    expect(
      overTyped(
        'Ownership usually turns on who paid for the work, whose equipment you used and what you signed.',
        108,
        'x',
        IP_REFERRAL,
      ),
    ).toBe(false);
  });
});
