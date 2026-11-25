/**
 * What the server says itself on a turn (founder path, contract of 2026-11-26): the sum, what news means, where they
 * stand, the first part of a step, and what a line written for them may hold. Real playbook, synthetic wording.
 */
import { type pathRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { guidanceWords } from './ai-adapter.js';
import { decide, guidanceOf, type DecideInput } from './engine.js';
import { asksHowTo, saysFirstTime, smallerOf } from './kinds.js';
import { PLAYBOOK } from './playbook/index.js';
import { doneWhenOf, smallerStep } from './steps.js';
import { fresh, input, memory, NO_READS, storedStep, TODAY, VENTURE_ID } from './testing/inputs.js';
import { fillTemplate, followUpsOf, pathTurn } from './turn.js';

const path = (over: Partial<pathRepo.PathRecord> = {}): pathRepo.PathRecord => ({
  ventureId: VENTURE_ID,
  stage: 'idea',
  intake: null,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 1,
  ...over,
});
const real = (over: Partial<DecideInput> = {}): Partial<DecideInput> =>
  fresh({ playbook: PLAYBOOK, ...over });
const turnOf = (
  message: string,
  over: Partial<DecideInput> = {},
  earlierMessages: string[] = [],
  earlierReplies: string[] = [],
) => pathTurn({ ...input(message, real(over)), continuity: {}, earlierMessages, earlierReplies });

describe('a sum they ask for', () => {
  const SOAP = 'I sell soap boxes at 9 dollars each and each costs me 4 dollars 50.';

  it('is worked out by code and opens the reply, on a call as it is heard', () => {
    const { prompt } = turnOf(`${SOAP} What is my margin?`);
    expect(prompt.calc).toEqual([
      '$9 price - $4.50 cost = $4.50 left per box.',
      'Margin: $4.50 of $9 = 50% of the price.',
    ]);
    expect(prompt.lead?.text).toBe(prompt.calc?.join(' '));
    expect(prompt.lead?.voice).toBe(
      '$9 price minus $4.50 cost is $4.50 left per box. Margin: $4.50 of $9 is 50% of the price.',
    );
    // Its figures may be said by the reply.
    expect(guidanceWords(prompt)).toContain('$4.50 left per box');
  });

  it('is not told when its words can be read two ways: the model is asked for it', () => {
    const { prompt } = turnOf('What do I make on one soap?', {}, ['A soap is 9 dollars. I sell it for 20.']);
    expect([prompt.lead, prompt.calc, prompt.askBack, prompt.asksSum]).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
    expect(turnOf(`${SOAP} What is my margin?`).prompt.asksSum).toBeUndefined();
  });

  it('a working said a moment ago is not said again', () => {
    const line = '$9 price - $4.50 cost = $4.50 left per box.';
    const ask = 'What do I make on 10 boxes?';
    expect(turnOf(ask, {}, [SOAP]).prompt.lead?.text).toBe(
      `10 boxes x $4.50 left per box = $45 before other costs. ${line}`,
    );
    expect(turnOf(ask, {}, [SOAP], [line]).prompt.lead?.text).toBe(
      '10 boxes x $4.50 left per box = $45 before other costs.',
    );
  });

  it('with a number missing, the one question is that number', () => {
    const { prompt } = turnOf('What is my break even?', {}, [SOAP]);
    expect(prompt.calc).toEqual(['$9 price - $4.50 cost = $4.50 left per box.']);
    expect(prompt.askBack).toBe('What is the one-time cost you want to earn back?');
  });

  it('is no one’s business on a turn that asks for none', () => {
    const { prompt } = turnOf('How should I price it?');
    expect([prompt.calc, prompt.askBack, prompt.lead]).toEqual([undefined, undefined, undefined]);
  });
});

describe('news', () => {
  it('told with nothing asked: what it means first, its own step offered, and the path’s stands', () => {
    const { decision, prompt } = turnOf(
      'Nobody on campus paid, but three salons said they pay for this already.',
    );
    expect([decision.kind, prompt.kind]).toEqual(['news', 'news']);
    expect(prompt.lead?.text).toMatch(
      /^Campus did not pay and three salons say they pay: salons are the customer/,
    );
    expect(decision.step?.view.title).toBe('Ask 20 people to pay and count who does');
    expect([decision.offered, decision.pathStep?.title]).toEqual([true, 'Put the idea on one page']);
    expect(decision.applied).toBeNull();
  });

  it('"Is that good?" is answered with the rate, the pass line and what would make it good', () => {
    const { prompt } = turnOf('Is that good?', { started: true }, [
      'I sold 13 of 25 soap boxes on Saturday.',
    ]);
    expect(prompt.lead?.text).toMatch(
      /^13 of 25 is 52%\. No pass line \(the number that means it worked\) was set/,
    );
    expect(prompt.lead?.text).toContain('It is good if strangers repeat it');
    // A word is explained once.
    expect(prompt.lead?.text.match(/the number that means it worked/g)).toHaveLength(1);
  });

  it('with a question, the question is answered', () => {
    expect(turnOf('13 of 25 sold on Saturday. How should I price it?').decision.kind).toBe('coaching');
  });
});

describe('how to do the step just given', () => {
  it.each([
    'how do I do that?',
    'What would I do first for that?',
    'walk me through it',
    'how exactly?',
    'Where do I start with this?',
  ])('%s', (message) => {
    expect(asksHowTo(message)).toBe(true);
  });
  it.each([
    'how do I price it?',
    'How do I do that faster?',
    'What do I do first?',
    'how do customers do that',
  ])('%s is another question', (message) => {
    expect(asksHowTo(message)).toBe(false);
  });

  it('is its first part explained, with its template filled in from what they told', () => {
    const first = turnOf('What next?');
    const { decision, prompt } = turnOf(
      'How do I do that?',
      {
        started: true,
        previous: guidanceOf(PLAYBOOK, first.decision),
        reads: {
          ...NO_READS,
          path: path({
            intake: {
              idea: 'Soap in refill pouches',
              customer: '',
              studies: '',
              experience: null,
              hoursPerWeek: null,
              deadline: null,
              doneSoFar: '',
              block: '',
            },
          }),
        },
      },
      ['What next?'],
    );
    expect([decision.howTo, prompt.howTo, decision.step?.view.title]).toEqual([
      true,
      true,
      first.decision.step?.view.title,
    ]);
    const item = decision.step?.view.items[0];
    expect(prompt.lead?.text).toContain((item?.do ?? '?').slice(1).replace(/\.$/, ''));
    expect(prompt.lead?.text).toContain(item?.how ?? '?');
    expect(prompt.lead?.text).toContain('soap in refill pouches');
    // What they did not tell stays in its brackets.
    expect(prompt.lead?.text).toMatch(/\[[^\]]+\]/);
  });
});

describe('where they stand', () => {
  it('"get me organized" is said by a mentor: the stage, what is missing in short names, the start', () => {
    const { prompt } = turnOf('Can you help me get organized?');
    expect(prompt.lead?.text).toBe(
      [
        'You are on stage 1 of 7 with New venture, pinning down the idea. Still missing: the idea on one page, the user and the payer by name, and the thing most likely to sink it. Start with this: write the five lines in plain words.',
        '',
        'Here it is to fill in, and the [brackets] are yours:',
        '',
        '1. Who: [type of person] (seen / guess)',
        '2. Problem: [what goes wrong, how often] (seen / guess)',
        '3. Today: [what they do now and what it costs them] (seen / guess)',
        '4. Idea: [what I would do, in one sentence] (seen / guess)',
        '5. Why me: [what I know or can reach] (seen / guess)',
        'Check first: line [number], with [name], on [day]',
      ].join('\n'),
    );
    expect(prompt.lead?.voice.split(' ').length).toBeLessThanOrEqual(45);
  });

  it('is not said again a moment later: only where to start, with how', () => {
    const first = turnOf('Can you help me get organized?');
    const { prompt } = turnOf(
      'Where do I even begin?',
      { started: true },
      [],
      [first.prompt.lead?.text ?? ''],
    );
    expect(prompt.lead?.text).toMatch(
      /^The step starts with one blank, "Who": type of person\. Write it in one plain line/,
    );
    expect(prompt.lead?.text).not.toContain('1. Who:');
    expect(prompt.lead?.text).not.toContain('stage 1 of 7');
  });

  it('an idea told with a bare "help?" gets the step as what to do about it', () => {
    expect(turnOf('I want to mend umbrellas for people in dorms. help?').prompt.stepRole).toBeUndefined();
  });

  it('a plan is a numbered list on the screen and a sequence on a call', () => {
    const { prompt } = turnOf('make me a plan for this week');
    expect(prompt.lead?.text).toMatch(
      /In this order:\n\n1\. Write the five lines in plain words \(30 min\)\.\n2\. /,
    );
    expect(prompt.lead?.voice).not.toMatch(/\n|\d\. /);
    expect(prompt.lead?.voice).toContain('Start with this: write the five lines in plain words. Then ');
  });

  it('a first-timer is told that is fine, in half a line, when they say so and never after', () => {
    const said = turnOf("I've never ever done this before, can you help me get organized?");
    expect(said.prompt.firstTimeNow).toBe(true);
    expect(said.prompt.lead?.text).toMatch(
      /^Never having done this is fine: we take it one part at a time\. You are on/,
    );
    const later = turnOf('Can you help me get organized?', {}, ["I've never done this before"]);
    expect([later.prompt.firstTime, later.prompt.firstTimeNow]).toEqual([true, undefined]);
    expect(later.prompt.lead?.text).not.toContain('is fine');
    expect(saysFirstTime("we've never ever run one")).toBe(true);
  });
});

describe('what is said of a step', () => {
  it('what they said they would do is done when it can be counted', () => {
    expect(turnOf('I will ask 5 caterers by Friday').prompt.step).toMatchObject({
      title: 'Ask 5 caterers',
      doneWhen: 'You have asked 5 caterers and can say how many said yes.',
    });
    expect(doneWhenOf('Email the two labs')).toBe(
      'You have emailed the two labs and can say how many answered.',
    );
    expect(doneWhenOf('Write the one-pager')).toBe('You have written the one-pager.');
    expect(doneWhenOf('Go to the fair')).toBe(
      'You have done it, and can say in one line what came of it: go to the fair.',
    );
  });

  it('a smaller one is one of them, in words that read', () => {
    const view = storedStep({
      title: 'Email the theatre groups',
      items: [{ do: 'Email the five theatre groups', how: 'Use the note', minutes: 60, done: false }],
    });
    expect(smallerStep(view, { minutes: null, strict: true, today: false }, TODAY)?.items[0]?.do).toBe(
      'Email one of the five theatre groups',
    );
  });

  it('a step cut to one part is done when that part can be checked', () => {
    const step = storedStep({
      origin: 'founder',
      playId: null,
      criterionId: null,
      title: 'Email the five theatre groups',
      items: [{ do: 'Email the five theatre groups', how: 'Use the note', minutes: 60, done: false }],
    });
    const reads = { ...NO_READS, path: path(), steps: [step] };
    const { prompt } = turnOf("That's too much. What's the smallest thing I can do today?", { reads });
    expect(prompt.step).toMatchObject({
      said: 'Email one of the five theatre groups',
      doneWhen: 'You have emailed one of the five theatre groups and can say what came back.',
    });
  });

  it('a capstone of the course waits for the venture’s own evidence, unless its deadline is theirs', () => {
    const met = PLAYBOOK.criteria
      .filter((c) => ['idea', 'discovery', 'validation'].includes(c.stage))
      .map((c) => ({
        criterionId: c.id,
        status: 'met' as const,
        evidence: 'x',
        stepId: null,
        sourceSessionId: null,
        updatedAt: '2026-11-10T00:00:00.000Z',
      }));
    const playOf = (deadline: { what: string; on: string } | null) =>
      decide(
        input(
          'What next?',
          real({
            reads: {
              ...NO_READS,
              criteria: met,
              path: path({
                stage: 'business_model',
                intake: {
                  idea: 'soap',
                  customer: '',
                  studies: '',
                  experience: null,
                  hoursPerWeek: null,
                  deadline,
                  doneSoFar: '',
                  block: '',
                },
              }),
            },
          }),
        ),
      ).step?.view.playId;
    expect(playOf(null)).toBe('price-test');
    expect(playOf({ what: 'Holiday market', on: '2026-12-05' })).toBe('price-test');
    expect(playOf({ what: 'Module 1 capstone', on: '2026-12-05' })).toBe('ain-canvas-capstone');
    expect(playOf({ what: 'Module 1 capstone', on: '2026-11-01' })).toBe('price-test');
  });
});

describe('what they may tap to send next', () => {
  it('is about the step, and is what the path reads as its own', () => {
    const first = turnOf('What next?');
    const [how, smaller] = followUpsOf(first.decision);
    expect(followUpsOf(first.decision)).toHaveLength(2);
    expect(asksHowTo(how ?? '')).toBe(true);
    expect(smallerOf(smaller ?? '')).not.toBeNull();
    const on = { started: true, previous: guidanceOf(PLAYBOOK, first.decision) };
    const asked = turnOf(how ?? '', on, ['What next?']);
    expect([asked.decision.howTo, followUpsOf(asked.decision)]).toEqual([true, [smaller]]);
    const cut = turnOf(smaller ?? '', on, ['What next?']);
    expect([cut.decision.smaller === null, followUpsOf(cut.decision)]).toEqual([false, [how]]);
  });

  it('nothing after a thanks or a recall', () => {
    for (const message of ['thanks!', 'What was my idea again?'])
      expect(followUpsOf(turnOf(message).decision), message).toEqual([]);
  });
});

describe('what the model may say of them', () => {
  it('a template is filled only with what they told', () => {
    const body =
      'Hi [name], I am [your first name] and I make [my idea] for [customer] at [venture]. [price]';
    expect(
      fillTemplate(body, { idea: 'Soap refills', customer: 'Salons', venture: 'SudsUp', founder: 'Ines' }),
    ).toBe('Hi [name], I am Ines and I make soap refills for salons at SudsUp. [price]');
    expect(fillTemplate(body, { idea: null, customer: null, venture: null, founder: null })).toBe(body);
  });

  it('the words on record and of this conversation are what a line for them may claim', () => {
    const { prompt } = turnOf(
      'How should I price it?',
      {
        reads: {
          ...NO_READS,
          memory: [memory({ type: 'evidence', title: 'Salons', content: 'Two salons pay.' })],
        },
      },
      ['I work at the dorm desk.'],
    );
    for (const told of ['I work at the dorm desk.', 'Two salons pay.', 'How should I price it?'])
      expect(prompt.said).toContain(told);
    expect(prompt.prior?.fact).toBe('two salons pay');
  });

  it('nothing of it on a social turn', () => {
    const { prompt } = turnOf('thanks!', {
      reads: {
        ...NO_READS,
        memory: [memory({ type: 'evidence', title: 'Salons', content: 'Two salons pay.' })],
      },
    });
    expect([prompt.prior, prompt.lead, prompt.said]).toEqual([undefined, undefined, undefined]);
  });
});
