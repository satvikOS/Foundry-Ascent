/** What the server opens with, by a hand-made reading of one invented venture (a preserves stall). */
import { type RecordLine, type Understanding } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import {
  asksToStop,
  byUrgency,
  contradictionSaid,
  isItSaid,
  listPick,
  openingOf,
  recallSaid,
  type OpeningContext,
} from './openings.js';
import { PLAYBOOK } from './playbook/index.js';
import { NO_READS, TODAY } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf, sumOf, understood } from './testing/understood.js';
import { fitTurn } from './turn.js';
import { fitsAsk, settled, tellsLegalLetter, testsAPick } from './understood.js';

const line = (text: string, kind = 'fact'): RecordLine => ({
  key: 'R1',
  kind,
  text,
  on: '2026-11-03',
  memoryId: null,
});
const context = (over: Partial<OpeningContext> = {}): OpeningContext => ({
  yesNo: false,
  today: TODAY,
  referral: null,
  message: '',
  ...over,
});
const opens = (over: Partial<Understanding>, c: Partial<OpeningContext> = {}) =>
  openingOf(understood(over), context(c));
const referralOf = (playId: string) => PLAYBOOK.plays.find((p) => p.id === playId)?.referral ?? null;
const about = (message: string, earlier: readonly string[] = []) => ({
  message,
  earlier,
  titles: PLAYBOOK.plays.map((p) => p.title),
});

describe('what a person decides is nobody’s pick', () => {
  const choose = (options: string[], pick: string, over: Partial<Understanding> = {}): Understanding =>
    understood({
      kind: 'choice',
      ask: 'which one',
      choice: { options, pick, because: 'You made most of it.', flipsIf: null },
      ...over,
    });
  it.each([
    [['60/40', '50/50'], '60/40', 'equity'],
    [['an llc', 'stay as we are'], 'an llc', 'legal'],
    [['sign it now', 'ask for a week'], 'sign it now', 'legal'],
    [['file a patent now', 'wait'], 'file a patent now', 'ip'],
    [['take the investment', 'go on alone'], 'take the investment', 'valuation'],
    [['work on an F-1 visa', 'wait for opt status'], 'work on an F-1 visa', 'immigration'],
  ])('%j', (options, pick, referral) => {
    const u = settled(choose(options, pick), about(`${options.join(' or ')}?`));
    expect([u.choice, u.referral]).toEqual([null, referral]);
  });
  it.each([
    [['the market', 'the gift shop'], 'the gift shop'],
    [['two small paid pilots', 'all nine for nothing'], 'two small paid pilots'],
    [['sign up 20 tasters', 'print cards'], 'sign up 20 tasters'],
    [['sell 10-12 jars', 'sell 20'], 'sell 20'],
  ])('%j is theirs to have picked', (options, pick) => {
    const u = settled(choose(options, pick), about(`${options.join(' or ')}?`));
    expect([u.choice?.pick, u.referral]).toEqual([pick, null]);
  });

  it('says what can be said, who decides and nothing of the pick', () => {
    const message = 'my sister says 60/40, i say 50/50, which number is it';
    const t = readTurnOf(message, choose(['60/40', '50/50'], '60/40'), {
      reads: { ...NO_READS, steps: [onStep('pricing')] },
    });
    const reply = replyOf(
      t,
      message,
      'My pick: 60/40. You made most of it, so your work is the main value. I would change my mind if she paid for it. Write down what each of you put in since August.',
    );
    expect(reply).toMatch(/^I will not decide that for you/);
    expect(reply).not.toMatch(/My pick|60\/40|main value|change my mind/);
    expect(reply).toContain('Write down what each of you put in since August.');
    expect(reply).toMatch(/lawyer/);
    expect(t.decision.step?.view.playId).toBe('equity-split');
  });

  it('a paper to sign, and a form of company', () => {
    const c = { referral: referralOf('contracts-and-insurance') };
    expect(opens({ kind: 'choice', ask: 'whether to sign the lease', referral: 'legal' }, c)?.text).toMatch(
      /^Do not say yes or no to that yet: a business lawyer reads it with you first/,
    );
    expect(opens({ kind: 'choice', ask: 'llc or not', referral: 'legal' }, c)?.text).toBe(
      'I will not pick that for you: a business lawyer settles it with you, from what you do and plan.',
    );
  });
});

describe('a pick', () => {
  const u = (pick: string, over: Partial<NonNullable<Understanding['choice']>> = {}): Understanding =>
    understood({
      kind: 'choice',
      ask: 'which one to keep',
      choice: {
        options: ['plum', 'quince', 'fig'],
        pick,
        because: 'Plum sold out twice.',
        flipsIf: null,
        ...over,
      },
    });
  const message = 'i can only cook one of plum, quince or fig, which';

  it('is one of theirs, never a step’s title', () => {
    expect(settled(u('plum'), about(message)).choice?.pick).toBe('plum');
    expect(settled(u('write your idea in five lines'), about(message)).choice).toBeNull();
    expect(
      settled(u('quince', { options: ['write one page', 'talk to 10 people'] }), about(message)).choice,
    ).toBeNull();
  });
  it('is none when they only tell what they will do', () => {
    const told = u('email more shops', { options: ['email 4 shops', 'email more shops'] });
    expect(settled(told, about('so i am emailing 4 shops on monday')).choice).toBeNull();
  });
  it.each([
    ['ten of the next 40 ask for quince', true],
    ['the orchard says no', true],
    ['plum stops to sell out', true],
    ['plum sold out', false],
    ['quince were the better idea', false],
    [null, false],
  ])('what would change it: %s (%s)', (flipsIf, kept) => {
    expect(settled(u('plum', { flipsIf }), about(message)).choice?.flipsIf !== null).toBe(kept);
  });
});

describe('what is not said to them', () => {
  it.each([
    "The mentor cites the founder's own data.",
    'The founder has sold 12 jars.',
    'The opening says to wait.',
    'R3 shows nine of 34.',
  ])('%s', (text) => {
    const u = settled(understood({ points: [text, 'Nine of 34 came back.'] }), about('hm'));
    expect(u.points.join(' ')).not.toMatch(/mentor|the founder|opening|R3/);
    expect(u.points).toContain('Nine of 34 came back.');
  });
  it('a line of the program, or that they are new to it, is no fact of theirs', () => {
    const u = settled(
      understood({
        record: [
          line('You are doing this for the first time.', 'founder'),
          line("The program's method is to fill the two right-hand boxes first."),
          line('You sell at the corner table.'),
        ],
      }),
      about('where do i sell'),
    );
    expect(u.record.map((r) => r.text)).toEqual(['You sell at the corner table.']);
  });
  it('nothing throws on an empty reading', () => {
    const empty = understood({
      ask: '',
      choice: { options: [], pick: '', because: '', flipsIf: '' },
      result: { verdict: 'mixed', shows: '', doesNotShow: '', settles: '' },
      contradicts: { line: line(''), why: '' },
      missing: '',
      points: [''],
      firstAction: '',
      sums: [sumOf({ label: '', working: '' })],
      referral: 'legal',
    });
    for (const kind of [
      'question',
      'choice',
      'sum',
      'result',
      'pushback',
      'integrity',
      'recall',
      'next',
      'feelings',
    ] as const) {
      const t = readTurnOf(
        'so what now?',
        { ...empty, kind },
        { reads: { ...NO_READS, steps: [onStep('pricing')] } },
      );
      for (const channel of ['text', 'voice'] as const)
        expect(
          replyOf(
            t,
            'so what now?',
            'Write the deal on one page in plain words, who does what, when and for how much, and ask two buyers what they paid before.',
            channel,
          ),
        ).toBeTruthy();
    }
  });
});

describe('stopping, made-up work, several things', () => {
  it.each([
    ['tell me it is ok to quit', true],
    ["is it wrong to just stop? i'm so tired", true],
    ['am i selfish to give it up, is it wrong', true],
    ['the shop wants us to stop using the crest, is that ok', false],
    ['ok so we stopped at 40 jars', false],
    ['i quit my job for this', false],
  ])('asks leave to stop: "%s" %s', (message, asks) => {
    expect(asksToStop(message)).toBe(asks);
  });

  it('what is urgent comes first, the rest as it was', () => {
    expect(
      byUrgency([
        'Sugar can wait.',
        'The jars are due on Friday.',
        'A lawyer reads the letter.',
        'Print cards.',
      ]),
    ).toEqual([
      'A lawyer reads the letter.',
      'The jars are due on Friday.',
      'Sugar can wait.',
      'Print cards.',
    ]);
  });

  it.each([
    ['the orchard wrote a letter that we must stop using the crest', true],
    ['a lawyer wrote us about the name', true],
    ['we got an email from a company about trademark', true],
    ['i wrote a letter to the shop', false],
    ['should i get a lawyer', false],
    ['the newsletter stopped', false],
  ])('a letter for a lawyer: "%s" %s', (message, is) => {
    expect(tellsLegalLetter(message)).toBe(is);
  });
  it('brings the letter to a lawyer, whatever was read', () => {
    const message =
      'a letter came from the orchard, we must stop using the crest on the jars, what comes first';
    const { prompt } = readTurnOf(
      message,
      understood({ kind: 'next', points: ['Take the jars with the crest off the table.'] }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] } },
    );
    expect(prompt.referral?.who).toMatch(/lawyer/i);
    expect(prompt.referral?.bring).toMatch(/^The letter/);
    expect(prompt.referral?.before).toBe('you answer it');
  });
});

describe('a step that fits', () => {
  const title = (id: string) => PLAYBOOK.plays.find((p) => p.id === id) ?? { title: '', doneWhen: '' };
  it.each([
    ['price-test', 'what should one jar cost', true],
    ['price-test', 'whether to add Sunday mornings', false],
    ['valuation', 'what the offer says the stall is worth', true],
    ['retention', 'why buyers do not come back', true],
    ['after-graduation', 'who takes it over in June', true],
    ['interview-script', 'what to say when i meet the cook', true],
    ['hiring', 'find out why they left', false],
    ['beachhead', 'is everyone who eats jam a beachhead', true],
  ])('%s for "%s": %s', (id, asked, fits) => {
    expect(fitsAsk(title(id), asked)).toBe(fits);
  });

  it('an either-or that is not about money is tested small, and named for the pick', () => {
    const message = 'sundays at the pier or jars in the dorm shop? only one of them';
    const t = readTurnOf(
      message,
      understood({
        kind: 'choice',
        ask: 'the pier on Sundays or the dorm shop',
        choice: {
          options: ['sundays at the pier', 'jars in the dorm shop'],
          pick: 'sundays at the pier',
          because: 'You sold 31 there.',
          flipsIf: null,
        },
        playId: 'price-test',
        stepPlayId: 'price-test',
        points: ['You sold 31 there in one morning.'],
      }),
      { reads: { ...NO_READS, steps: [onStep('price-test')] } },
    );
    expect(t.decision.step?.view.playId).toBe('smallest-test');
    expect(t.decision.step?.view.title).toBe('Run one small test of your pick (sundays at the pier)');
    expect(t.decision.pathStep?.playId).toBe('price-test');
    expect(
      testsAPick(
        understood({
          choice: { options: ['charge 5', 'free for now'], pick: 'free for now', because: '', flipsIf: null },
        }),
      ),
    ).toBe(false);
  });

  it('handing it over has the hand-over page', () => {
    const message = 'shut the stall, or let the orchard people take it over?';
    const { decision } = readTurnOf(
      message,
      understood({
        kind: 'choice',
        ask: 'shut it or let others take it over',
        choice: {
          options: ['shut the stall', 'let the orchard people take it over'],
          pick: 'let the orchard people take it over',
          because: 'They asked twice.',
          flipsIf: null,
        },
        stepPlayId: 'quit-or-continue',
      }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] } },
    );
    expect(decision.step?.view.playId).toBe('after-graduation');
  });

  it('a step for something else only stands', () => {
    const { prompt } = readTurnOf(
      'a mother wrote that her son hides the jar, good or bad?',
      understood({
        kind: 'result',
        ask: 'whether the letter is good news',
        result: { verdict: 'promising', shows: 'One boy hides the jar.', doesNotShow: null, settles: null },
        stepPlayId: 'retention',
        sure: true,
        playId: 'retention',
      }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] } },
    );
    expect([prompt.step?.title, prompt.stepRole]).toEqual([
      'Set a first price and say it to 5 buyers',
      'standing',
    ]);
  });

  it('the day their class sets is the step’s', () => {
    const { decision } = readTurnOf(
      'the canvas for class is due Friday, what goes in it',
      understood({
        ask: 'what goes in the canvas boxes',
        playId: 'business-model-canvas',
        stepPlayId: 'business-model-canvas',
        sure: true,
        points: ['Nine boxes.'],
      }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] } },
    );
    expect([decision.step?.view.playId, decision.step?.view.dueOn]).toEqual([
      'business-model-canvas',
      '2026-11-27',
    ]);
  });
});

describe('what is asked for comes first', () => {
  const PRICING = { reads: { ...NO_READS, steps: [onStep('pricing')] } };
  it('the figure, whatever a person decides', () => {
    const message = 'my aunt offered 20k for 5%, on paper what is the stall worth then';
    const t = readTurnOf(
      message,
      understood({ ask: 'what the offer makes the stall worth', referral: 'valuation' }),
      PRICING,
    );
    const reply = replyOf(
      t,
      message,
      'A startup lawyer who handles securities, and you start with your Ain Center EIR.',
    );
    expect(reply).toMatch(/^On paper that makes the whole venture worth \$400,000: \$20,000 ÷ 0\.05\./);
    expect(reply.match(/Talk to/g)).toHaveLength(1);
    expect(reply).not.toMatch(/Do not say yes yet/);
  });

  it('asked earn or lose, the word answers, and the figure before stands beside it', () => {
    const message = 'with two helpers and not one, am i still earning or losing';
    const t = readTurnOf(
      message,
      understood({
        kind: 'sum',
        also: ['result'],
        sums: [
          sumOf({ label: 'monthly profit or loss', value: 30, said: '$30', working: '10 × $9 − 2 × $30' }),
        ],
        record: [line('You pay one helper 30 dollars a month.')],
      }),
      {
        ...PRICING,
        earlierMessages: ['what is left each month'],
        earlierReplies: ['$60 is left each month: 10 × $9 − $30.'],
      },
    );
    const reply = replyOf(
      t,
      message,
      'You pay one helper each month. Ask the second one what a Saturday is worth to her.',
    );
    expect(reply).toMatch(/^You still earn: \$30 is left a month, down from \$60: 10 × \$9/);
    expect(reply.match(/You still earn/g)).toHaveLength(1);
  });

  it('a supposed figure is said as one', () => {
    expect(
      opens(
        {
          kind: 'sum',
          sums: [sumOf({ label: 'what comes in', value: 900, said: '$900', working: '100 × $9' })],
        },
        { message: 'just say everybody on campus buys a jar' },
      )?.text,
    ).toMatch(/^If all of that came true, \$900 comes in: /);
  });

  it('what it would cover is worked out when the reading could not, and nothing is concluded beside it', () => {
    const message = 'what is the fewest jars so im not paying to stand there';
    const t = readTurnOf(
      message,
      understood({ kind: 'sum', also: ['result'], ask: 'fewest jars to not lose' }),
      {
        reads: {
          ...NO_READS,
          steps: [onStep('pricing')],
          memory: [
            {
              id: 'aaaaaaaa-0000-4000-8000-000000000001',
              type: 'fact',
              title: 'A jar',
              content:
                'A jar sells for 8 dollars; plums are 1 dollar, the glass 1 dollar; the market takes 45 dollars a day.',
              attributes: {},
              status: 'confirmed',
              origin: 'founder',
              pinned: false,
              createdAt: '2026-11-10T09:00:00.000Z',
            },
          ],
        },
      },
    );
    const reply = replyOf(
      t,
      message,
      'The fewest you can sell is 30, because 30 × 6 − 45 = 135, which is positive.',
    );
    expect(reply).toMatch(/^You need 8 jars to cover the \$45: \$45 ÷ \(\$8 − \$1 − \$1\)\./);
    expect(reply).not.toContain('135');
  });

  it('a recap is the words alone, with what they took back left out', () => {
    const message = 'my professor wants a recap: who, price, table. 3 lines';
    const t = readTurnOf(
      message,
      understood({
        kind: 'update',
        also: ['result', 'recall'],
        record: [line('Runa left for a job in another city.'), line('A jar is 9 dollars.')],
        result: {
          verdict: 'weak',
          shows: 'Six of 50 bought.',
          doesNotShow: 'Whether they come back.',
          settles: null,
        },
        points: ['Six bought.'],
        firstAction: 'Ask six of them to come back on Saturday.',
      }),
      {
        ...PRICING,
        earlierMessages: [
          'runa is coming back in spring, so that she left is not true any more. a jar is 9 dollars now. 50 stopped, 6 bought',
        ],
      },
    );
    const reply = replyOf(
      t,
      message,
      'Team: you and Runa.\nPrice: $9.\nTable: 50 stopped, 6 bought.',
      'text',
      '9 dollars 50 stopped 6 bought',
    );
    expect(reply).toMatch(/^Team: you and Runa\.\s+Price: \$9\.\s+Table: 50 stopped, 6 bought\.\n\n\*\*/);
    expect(reply).not.toMatch(/Weak|thin|Runa left|Start with/);
    expect(t.prompt.reading).toMatchObject({ words: true, contradicts: null });
  });
});

describe('what the writer writes from', () => {
  const PRICING = { reads: { ...NO_READS, steps: [onStep('pricing')] } };
  const notes = (message: string, over: Partial<Understanding>, more: object = {}) =>
    readTurnOf(message, understood(over), { ...PRICING, ...more }).prompt;

  it('a result, a pick and a denial are notes, and nothing of them opens', () => {
    const read = notes('a few took a jar home and paid, the rest said yum', {
      kind: 'result',
      result: {
        verdict: 'weak',
        shows: 'Four bought.',
        doesNotShow: 'Whether they come back.',
        settles: 'Ask 20 more to pay.',
      },
      points: ['A taste is free.'],
    });
    expect(read.lead).toBeUndefined();
    expect(read.reading).toMatchObject({
      opened: null,
      result: { verdict: 'weak', shows: 'Four bought.', settles: 'Ask 20 more to pay.' },
    });
    const pick = notes('sundays at the pier or the dorm shop, one of them', {
      kind: 'choice',
      choice: {
        options: ['sundays at the pier', 'the dorm shop'],
        pick: 'sundays at the pier',
        because: 'You sold 31 there.',
        flipsIf: 'the pier says no',
      },
    });
    expect([pick.lead, pick.reading?.choice]).toEqual([
      undefined,
      { pick: 'sundays at the pier', because: 'You sold 31 there.', flipsIf: 'the pier says no' },
    ]);
  });

  it('a verdict is a note only over an outcome', () => {
    const over: Partial<Understanding> = {
      kind: 'result',
      result: { verdict: 'weak', shows: 'Six of 50 bought.', doesNotShow: null, settles: null },
      points: ['x y z.'],
    };
    expect(notes('my two evenings are mine again', over).reading?.result ?? null).toBeNull();
    expect(notes('what should the label say, just give me the words', over).reading).toMatchObject({
      words: true,
    });
  });

  it('their record denies it: the line, and as the server says it when the reply does not', () => {
    const c = { today: TODAY, yesNo: true };
    const held = line('Nine of 34 buyers came back in October.');
    expect(contradictionSaid(understood({ contradicts: { line: held, why: 'Nine came back.' } }), c)).toEqual(
      {
        line: 'Nine of 34 buyers came back in October.',
        says: 'Not quite, by your own numbers: nine of 34 buyers came back in October.',
      },
    );
    const decided = line('You decided to sell to gift shops and not at markets.', 'decision');
    const of = (kind: Understanding['kind']) =>
      contradictionSaid(understood({ kind, contradicts: { line: decided, why: 'It was set aside.' } }), c);
    expect(of('update')?.says).toMatch(/^That changes something you settled before \(on November 3\)/);
    expect(of('question')).toBeNull();
  });

  it('what taking it for free, a grant or a letter is, is a claim, and the opposite of it is cut', () => {
    expect(isItSaid('a hotel takes it every week, not paying. is it a customer then')).toMatch(
      /^Not a customer yet/,
    );
    expect(isItSaid('does a grant count as traction')).toMatch(/^A grant is not a customer/);
    expect(isItSaid('the hotel takes it every week')).toBeNull();
    const message = 'a hotel takes it every week, not paying. is it a customer then, and now what';
    const t = readTurnOf(
      message,
      understood({ ask: 'whether it is a customer', points: ['The hotel pays nothing.'] }),
      PRICING,
    );
    expect(replyOf(t, message, 'Yes, that is a customer. Ask the hotel for a price this week.')).not.toMatch(
      /Yes/,
    );
  });

  it('counts and one of so many are claims when nothing else read them', () => {
    const counts = notes('um i did six. three said they would buy, one gets hers for free, is that bad', {
      kind: 'result',
      also: ['pushback'],
      playId: 'honest-read',
      sure: true,
    });
    expect(counts.reading?.points[0]).toMatch(/^Three of six said they would buy/);
    expect(
      listPick(understood({ kind: 'choice' }), 'if i had to keep only one of the four', [
        'it does everything: plums, quince, figs, honey. we start in may',
      ])?.pick,
    ).toBe('plums');
  });

  it('going on alone is the writer’s, with what is true of the product and who decides', () => {
    const t = readTurnOf(
      'off the record, i think i go on alone in may, would that be wrong',
      understood({
        kind: 'choice',
        referral: 'equity',
        record: [line('You and Runa are co-founders; no split is written down.')],
        stepPlayId: 'cofounder-left',
      }),
      PRICING,
    );
    expect(t.prompt.lead).toBeUndefined();
    expect(t.prompt.reading?.says?.[0]).toMatch(/team can see what I keep/);
    expect(t.decision.step?.view.playId).toBe('team-conflict');
  });

  it('what is on record is what stands when a recall is not written', () => {
    const u = understood({ kind: 'recall', record: [line('You decided to stop at cafes.', 'decision')] });
    expect(recallSaid(u, TODAY)).toEqual(['On November 3: you decided to stop at cafes.']);
  });
});

describe('the step the writer fits', () => {
  const B2B: Partial<Understanding> = {
    ask: 'how to get the gift shop to stock it',
    playId: 'b2b-selling',
    stepPlayId: 'b2b-selling',
    sure: true,
    points: ['The owner decides what stands on her shelf.', 'Bring a card.'],
    firstAction: 'Ask the gift shop owner what share she keeps.',
  };
  const message = 'the gift shop owner, how would you get in there';
  const on = (steps: ReturnType<typeof onStep>[]) => ({ reads: { ...NO_READS, steps } });

  it('is given the method, the open step, the hours they have and one way', () => {
    const { prompt } = readTurnOf(`${message}, i have 3 hours`, understood(B2B), on([onStep('pricing')]));
    expect(prompt.fit).toMatchObject({
      title: 'Name who decides in 2 companies and offer one a pilot',
      way: 'Ask the gift shop owner what share she keeps.',
      hours: 3,
      open: { title: 'Set a first price and say it to 5 buyers' },
    });
    expect(
      readTurnOf('what did we decide', understood({ kind: 'recall', record: [line('x')] })).prompt.fit,
    ).toBeUndefined();
  });

  it('is due before a meeting they name', () => {
    const { prompt } = readTurnOf(
      'i meet the gift shop owner on Saturday, what do i bring',
      understood(B2B),
      on([onStep('pricing')]),
    );
    expect(prompt.fit?.dueOn).toBe('2026-11-27');
  });

  it('is kept as the step they are on, with the method’s parts, and said the same on every repeat', () => {
    const turn = readTurnOf(message, understood(B2B), on([onStep('pricing')]));
    const fitted = {
      title: 'Ask the gift shop owner to stock 6 jars',
      doneWhen: '6 jars stand on her shelf',
    };
    const kept = fitTurn(PLAYBOOK, turn, fitted);
    expect(kept.decision.keeps).toMatchObject({
      write: 'insert',
      fitted: true,
      view: {
        playId: 'b2b-selling',
        status: 'now',
        title: fitted.title,
        doneWhen: '6 jars stand on her shelf.',
      },
    });
    expect(kept.guidance?.step).toMatchObject({ title: fitted.title, status: 'now' });
    expect(kept.guidance?.step?.items.length).toBeGreaterThan(1);
    expect(kept.guidance?.offered).toBeUndefined();
    expect(kept.prompt.step?.title).toBe(fitted.title);
    // Asked next turn, the rules say the stored row.
    const row = onStep('b2b-selling', { title: fitted.title, doneWhen: '6 jars stand on her shelf.' });
    const again = readTurnOf("what's my next step?", null, on([row]));
    expect(again.prompt.step?.title).toBe(fitted.title);
    // Asked again with no news, in a fresh session too: the stored step stands, whatever the writer fitted.
    const kept2 = fitTurn(PLAYBOOK, readTurnOf(message, understood(B2B), on([row])), {
      title: 'Ask her for the two jars by the till',
      doneWhen: '2 jars stand there',
    });
    expect([kept2.decision.keeps, kept2.guidance?.step?.title]).toEqual([null, fitted.title]);
    // With news, fitted again on the step they are on: its row is changed.
    const news = 'the gift shop owner called back and offered the two jars by the till';
    const refit = fitTurn(PLAYBOOK, readTurnOf(news, understood(B2B), on([row])), {
      title: 'Ask her for the two jars by the till',
      doneWhen: '2 jars stand there',
    });
    expect(refit.decision.keeps).toMatchObject({ write: 'change', storedVersion: 1, fitted: true });
  });

  it('same keeps the open step; none, the turn’s own', () => {
    const turn = readTurnOf(message, understood(B2B), on([onStep('pricing')]));
    const same = fitTurn(PLAYBOOK, turn, 'same');
    expect([same.decision.step?.view.playId, same.decision.offered, same.decision.keeps]).toEqual([
      'pricing',
      false,
      null,
    ]);
    expect(fitTurn(PLAYBOOK, turn, null)).toBe(turn);
  });

  it('beside one that only stands, it goes to a small test, and their own words are never displaced', () => {
    const asks: Partial<Understanding> = {
      ask: 'what to write on the lid',
      points: ['The label says the day.', 'And what is in it.'],
    };
    const stands = readTurnOf('what goes on the label of the lid', understood(asks), on([onStep('pricing')]));
    expect([stands.prompt.stepRole, stands.prompt.fit?.title]).toEqual([
      'standing',
      'Run one small test with 10 people who are not friends',
    ]);
    const theirs = onStep('pricing', {
      origin: 'founder',
      title: 'Email the five clubs',
      playId: null,
      criterionId: null,
      items: [],
    });
    const turn = readTurnOf(message, understood(B2B), on([theirs]));
    expect(
      fitTurn(PLAYBOOK, turn, { title: 'Ask the owner to stock 6 jars', doneWhen: '6 stand there' }).decision
        .keeps?.view.status,
    ).toBe('next');
  });
});

describe('who decides, once', () => {
  const told = [
    'Talk to a business lawyer before you sign anything. Ask the Ain Center program lead for a legal referral. Bring them the one-page deal.',
  ];
  it('is not said again for another ask, and is for the same decision', () => {
    const other = readTurnOf(
      'ok and how do i get the gift shop to call me back',
      understood({
        ask: 'how to get a call back',
        playId: 'contracts-and-insurance',
        points: ['Ring at nine.'],
      }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] }, earlierReplies: told },
    );
    expect(other.prompt.referral).toBeNull();
    const same = readTurnOf(
      'so should i sign their paper now',
      understood({ ask: 'whether to sign the paper', referral: 'legal', points: ['They want it today.'] }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] }, earlierReplies: told },
    );
    expect(same.prompt.referral?.who).toMatch(/lawyer/i);
  });

  it('a letter has its own step', () => {
    const { decision } = readTurnOf(
      'the orchard sent a letter that we must stop using the crest, what is first',
      understood({
        kind: 'result',
        also: ['update'],
        points: ['Take the crest off.'],
        stepPlayId: 'contracts-and-insurance',
      }),
      { reads: { ...NO_READS, steps: [onStep('pricing')] } },
    );
    expect(decision.step?.view.title).toBe('Have a lawyer read the letter before you answer it');
    expect(decision.step?.view.doneWhen).toMatch(/^A lawyer has read the letter/);
  });
});
