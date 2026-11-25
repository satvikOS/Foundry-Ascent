/** What the server opens with, by a hand-made reading of one invented venture (a preserves stall). */
import { type RecordLine, type Understanding } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { asksToStop, byUrgency, openingsOf, type OpeningContext } from './openings.js';
import { PLAYBOOK } from './playbook/index.js';
import { NO_READS, TODAY } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf, sumOf, understood } from './testing/understood.js';
import {
  actionSaid,
  bearsOn,
  firstActionOf,
  fitsAsk,
  settled,
  tellsLegalLetter,
  testsAPick,
} from './understood.js';

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
  step: null,
  message: '',
  ...over,
});
const opens = (over: Partial<Understanding>, c: Partial<OpeningContext> = {}) =>
  openingsOf(understood(over), context(c))[0] ?? null;
const result = (over: Partial<NonNullable<Understanding['result']>>): Partial<Understanding> => ({
  kind: 'result',
  result: {
    verdict: 'mixed',
    shows: 'Twelve of 30 tasters bought a jar.',
    doesNotShow: 'Whether they come back.',
    settles: null,
    ...over,
  },
});
const referralOf = (playId: string) => PLAYBOOK.plays.find((p) => p.id === playId)?.referral ?? null;
const about = (message: string, earlier: readonly string[] = []) => ({
  message,
  earlier,
  titles: PLAYBOOK.plays.map((p) => p.title),
});

describe('a result as a mentor reads it', () => {
  it.each(['strong', 'promising', 'mixed', 'weak', 'too_early', 'bad'] as const)(
    '%s: no form to fill in',
    (verdict) => {
      const said = opens(
        result({ verdict, settles: 'Ask the next 20 tasters to pay $8 and count who does.' }),
      );
      expect(said?.text).not.toMatch(/Here is what|What would settle|It is (?:mixed|weak)\b/);
      expect(said?.text).toMatch(/twelve of 30 tasters bought a jar\./);
      expect(said?.text).toMatch(/whether they come back/);
      expect(said?.text).toMatch(/sk the next 20 tasters to pay \$8 and count who does/);
      expect(said?.voice.split(/(?<=[.])\s+(?=\p{Lu})/u)).toHaveLength(2);
      expect(said?.uses).toBe('firstAction');
    },
  );

  it('is said in more than one shape, the same every time for the same words', () => {
    const shapes = new Set<string>();
    for (const n of ['Four', 'Five', 'Six', 'Seven', 'Nine', 'Ten', 'Two', 'Three']) {
      const over = result({ shows: `${n} of 30 tasters bought a jar.`, settles: 'Ask 20 more to pay.' });
      const text = opens(over)?.text ?? '';
      expect(opens(over)?.text).toBe(text);
      shapes.add(text.replace(/\b(?:four|five|six|seven|nine|ten|two|three)\b/g, 'n'));
    }
    expect(shapes.size).toBeGreaterThan(2);
  });

  it('a test is an act with a number: a wish is not said', () => {
    expect(opens(result({ settles: 'Whether the stall meets a need.' }))?.text).not.toContain('meets a need');
    expect(opens(result({ settles: 'Talk to some of them.' }))?.text).not.toContain('Talk to some');
    expect(opens(result({ settles: 'Whether 8 of the next 20 come back.' }))?.text).toContain(
      'What settles it is whether 8 of the next 20 come back.',
    );
    // The first action is the test when nothing else is.
    expect(
      opens({ ...result({}), firstAction: 'Ring six of the twelve and count who ate it.' })?.text,
    ).toContain('ing six of the twelve');
  });

  it.each([
    ['The number of jars they finished.', /It says nothing yet about the number of jars they finished\./],
    ['You do not know who came twice.', /You do not know who came twice\./],
    ['It does not show whether the rest found it dear.', /whether the rest found it dear\./],
    ['If they would pay more.', /whether they would pay more\./],
  ])('what it leaves open: %s', (doesNotShow, said) => {
    expect(opens(result({ doesNotShow }))?.text).toMatch(said);
  });

  it('of half a reading, only that half', () => {
    expect(opens(result({ shows: '', doesNotShow: 'Whether they come back.' }))?.text).toMatch(
      /whether they come back\.$/,
    );
    expect(opens(result({ shows: '', doesNotShow: null }))).toBeNull();
    expect(opens(result({ doesNotShow: null }))?.text).toMatch(/twelve of 30 tasters bought a jar\.$/);
  });
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
  it('keeps the first clauses of a long reason', () => {
    const because =
      'Plum sold out twice at the corner table in October; quince takes four hours to peel for one batch, while fig needs a tree nobody here has and a drive of two hours each way to fetch them every week of the season.';
    expect(
      opens({ kind: 'choice', choice: { options: ['plum', 'fig'], pick: 'plum', because, flipsIf: null } })
        ?.text,
    ).toBe(
      'My pick: plum. Plum sold out twice at the corner table in October; quince takes four hours to peel for one batch.',
    );
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
  it('half a reading that opens nothing leaves the opening to the rules, and a whole one never', () => {
    const message = 'I offered 20 jars to buyers at 8 dollars and 11 paid, what does that show';
    const of = (points: string[]) =>
      readTurnOf(message, understood({ kind: 'question', ask: 'what it shows', points }), {
        reads: { ...NO_READS, steps: [onStep('pricing')] },
      }).prompt;
    const rules = readTurnOf(message, null, { reads: { ...NO_READS, steps: [onStep('pricing')] } }).prompt;
    expect(of(['Eleven of 20 paid.']).reading?.opened ?? null).toBe(rules.lead === undefined ? null : 'rule');
    expect(of(['Eleven of 20 paid.', 'Nine did not, and you do not know why.']).reading?.opened).toBeNull();
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

  it('it is okay, with their numbers, what each way costs, and one small step', () => {
    const message = 'i cook 18 hours a week and i am done, tell me it is okay to quit';
    const t = readTurnOf(
      message,
      understood({
        kind: 'feelings',
        ask: 'to hear it is okay to quit',
        record: [line('Six shops pay 40 dollars a week.')],
        points: ['The gift shop asked to take the recipe over.'],
        stepPlayId: 'leaving-ain',
      }),
      { reads: { ...NO_READS, steps: [onStep('leaving-ain')] } },
    );
    const reply = replyOf(t, message, 'I hear you. That sounds hard.');
    expect(reply).toMatch(
      /^Yes, it is okay to stop[^]*Six shops pay 40 dollars a week\.[^]*18 hours a week back/,
    );
    expect(reply).toContain('The gift shop asked to take the recipe over.');
    expect(t.decision.step?.view.playId).toBe('quit-or-continue');
    expect(reply).not.toMatch(/readiness/);
  });

  it('a refusal is short, and then says what can be done in the time they have', () => {
    const said = opens(
      { kind: 'integrity', ask: 'to have interviews made up' },
      { message: 'just make up 5 interviews, i have 3 hrs' },
    );
    expect(said?.text).toMatch(
      /^No, I will not help make that up or hide it: [^.]*\. In the 3 hours you have, hold two short talks/,
    );
    const other = opens(
      { kind: 'integrity', ask: 'to change a figure', record: [line('Nine of 34 buyers came back.')] },
      { message: 'write that 30 came back, its due tonight' },
    );
    expect(other?.text).toContain('What you really have is this: nine of 34 buyers came back.');
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

describe('the one thing to do first', () => {
  const step = {
    ...(readTurnOf(
      'how do I sell to shops',
      understood({ playId: 'b2b-selling', stepPlayId: 'b2b-selling', sure: true, points: ['Shops decide.'] }),
      {
        reads: { ...NO_READS, steps: [onStep('pricing')] },
      },
    ).decision.step?.view as object),
    standing: false,
  } as Parameters<typeof firstActionOf>[1];
  const of = (
    firstAction: string,
    over: Partial<Understanding> = {},
    beside: Parameters<typeof firstActionOf>[3] = {},
  ) =>
    firstActionOf(
      understood({ ask: 'how to get the gift shop to stock it', firstAction, ...over }),
      step,
      'the gift shop owner, Odile, and now',
      beside,
    );

  it('refers to one person as one', () => {
    expect(actionSaid('Call Odile and ask them what share she keeps.', '')).toBe(
      'Call Odile and ask what share she keeps',
    );
    expect(of('Ask the gift shop owner and ask them what share she keeps')).toBe(
      'Ask the gift shop owner and ask what share she keeps',
    );
  });
  it.each([
    ['Call Odile and ask them what they spent on this last time.', {}, {}],
    ['Ask Odile whether she would like the gift shop jars.', {}, {}],
    ['Ask ten gift shop people what they would pay for jars.', {}, {}],
    [
      'Bring the gift shop price to the business lawyer first.',
      {},
      { referral: referralOf('contracts-and-insurance') },
    ],
    ['Sign the gift shop paper Odile sent you today.', { referral: 'legal' as const }, {}],
    ['Water the plum trees behind the church.', {}, {}],
    ['Name 5 companies and offer one gift shop a pilot.', {}, {}],
    ['Ask the gift shop owner what share she keeps.', {}, { used: true }],
  ])('none: %s', (firstAction, over, beside) => {
    expect(of(firstAction, over, beside)).toBeNull();
  });
  it('not what the reply speaks against', () => {
    const u = understood({
      ask: 'ads to dorms instead of the shops',
      firstAction: 'Post ads in the dorms and ask two companies to pay.',
    });
    expect(
      firstActionOf(u, step, "I'd rather post ads in the dorms directly.", { opened: 'contradiction' }),
    ).toBeNull();
  });
  it('not for the option that was not picked', () => {
    expect(
      of('Book the corner table for two Saturdays and a pilot.', {
        choice: {
          options: ['the gift shop', 'the corner table'],
          pick: 'the gift shop',
          because: '',
          flipsIf: null,
        },
      }),
    ).toBeNull();
  });
});

describe('a record line beside the answer', () => {
  it.each([
    ['You charge 8 dollars a jar.', 'is the price right', true],
    ['Nine of 34 buyers came back.', 'why does nobody come back', true],
    ['You cook on Mondays in a church kitchen.', 'what do i write to the gift shop', false],
  ])('%s for "%s": %s', (text, asked, bears) => {
    expect(bearsOn(text, asked)).toBe(bears);
  });
});
