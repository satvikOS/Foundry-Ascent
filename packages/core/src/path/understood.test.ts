/**
 * A turn that rests on the reading of its message: hand-made readings of one invented venture (a preserves stall), what
 * code decides with them, and the reply the founder sees whatever the writer writes.
 */
import { renderGuidance, type RecordLine, type Understanding } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { PLAYBOOK } from './playbook/index.js';
import { NO_READS, TODAY } from './testing/inputs.js';
import { onStep, readTurnOf, replyOf, sumOf, understood } from './testing/understood.js';
import { type PathTurnInput } from './turn.js';
import { openingOf } from './openings.js';
import {
  asksForText,
  asksOfWork,
  asksToMakeUp,
  decides,
  NOTHING,
  PRECEDENCE,
  referralPlayOf,
  speaks,
  type Weighed,
  type WeighedField,
} from './understood.js';

const record = (text: string, kind = 'fact', on: string | null = '2026-11-03'): RecordLine => ({
  key: 'R1',
  kind,
  text,
  on,
  memoryId: null,
});
const BACK = record('Nine of 34 buyers came back in October.', 'evidence');
const PRICING = { reads: { ...NO_READS, steps: [onStep('pricing')] } };

const turn = (message: string, over: Partial<Understanding>, more: Partial<PathTurnInput> = {}) =>
  readTurnOf(message, understood(over), { ...PRICING, ...more });
const seen = (
  message: string,
  over: Partial<Understanding>,
  model: string,
  more: Partial<PathTurnInput> = {},
  channel: 'text' | 'voice' = 'text',
): string => replyOf(turn(message, over, more), message, model, channel);
const steps = (reply: string): number =>
  (reply.match(/\*\*(?:Next|On your path, next is):\*\*/g) ?? []).length;

describe('who decides where the rules and the reading disagree', () => {
  it.each<[WeighedField, Partial<Weighed>, 'rule' | 'reading']>([
    ['kind', {}, 'reading'],
    ['kind', { ownReport: true }, 'rule'],
    ['kind', { turned: true }, 'rule'],
    ['kind', { operation: true }, 'rule'],
    ['recall', { readsRecall: true }, 'reading'],
    ['recall', { recallPhrase: true }, 'rule'],
    ['recall', { recallPhrase: true, readsMore: true }, 'reading'],
    ['play', { referralPhrase: true, namesPlay: true, sure: true }, 'rule'],
    ['play', { heldPhrase: true, namesPlay: true, sure: true }, 'rule'],
    ['play', { heldPush: true, namesPlay: true, sure: true }, 'rule'],
    ['play', { phrase: true, namesPlay: true, sure: true }, 'reading'],
    ['play', { phrase: true, namesPlay: true }, 'rule'],
    ['play', { namesPlay: true }, 'reading'],
    ['play', { refers: true }, 'reading'],
    ['play', {}, 'rule'],
    ['step', { ownReport: true, namesStep: true }, 'rule'],
    ['step', { referralPhrase: true, namesStep: true }, 'rule'],
    ['step', { readsRecall: true, namesStep: true }, 'rule'],
    ['step', { namesStep: true }, 'reading'],
    ['step', { phrase: true }, 'rule'],
    ['step', {}, 'reading'],
    ['referral', { referralPhrase: true, refers: true }, 'rule'],
    ['referral', { refers: true }, 'reading'],
    ['sum', { readSum: true, ruleSum: true, sameSum: true }, 'rule'],
    ['sum', { readSum: true, ruleSum: true }, 'reading'],
    ['sum', { ruleSum: true }, 'rule'],
    ['choice', { picks: true, countsPick: true, samePick: true }, 'rule'],
    ['choice', { picks: true, countsPick: true }, 'reading'],
    ['choice', { countsPick: true }, 'rule'],
    ['lead', { ownReport: true }, 'rule'],
    ['lead', {}, 'reading'],
  ])('%s with %j: the %s', (field, over, by) => {
    expect(decides(field, { ...NOTHING, ...over })).toBe(by);
  });

  it('every field ends in a row that always holds', () => {
    for (const rows of Object.values(PRECEDENCE)) expect(rows.at(-1)?.test(NOTHING)).toBe(true);
  });

  it('with no reading, or one that says nothing, the rules decide, to the byte', () => {
    for (const message of [
      'how should I price a jar',
      'what is left when a jar sells at $8 and costs $3',
      'nine of 34 came back, is that good?',
      'we talked to four shops and two want it',
      'who owns the recipe I made in a university lab?',
      'I feel lost, where do I start',
    ]) {
      const rules = readTurnOf(message, null, PRICING);
      const empty = readTurnOf(message, understood({ ask: 'x' }), PRICING);
      expect(rules.decision.reading).toBeNull();
      expect(rules.prompt.reading).toBeUndefined();
      expect(empty, message).toEqual(rules);
      expect(readTurnOf(message, undefined as never, PRICING)).toEqual(rules);
    }
  });

  it('a phrase of a referral keeps its play, whatever was read', () => {
    const { decision } = turn('I made this while working in a university lab. Who owns the rights to it?', {
      playId: 'pricing',
      stepPlayId: 'pricing',
      sure: true,
      points: ['The recipe came first.'],
    });
    expect([decision.play?.id, decision.referral?.category]).toEqual(['student-ip', 'ip_licensing']);
    expect(decision.step?.view.playId).toBe('student-ip');
  });

  it('a reading adds who decides and never takes it away', () => {
    const added = turn('my aunt would put in 20k for a fifth of it, good deal?', {
      ask: 'whether to take the offer',
      referral: 'valuation',
      points: ['Nobody else has named a price for a part of it.'],
    });
    expect(added.decision.referral?.category).toBe('securities_investment');
    expect(added.decision.step?.view.playId).toMatch(/friends-family-money|valuation/);
    const kept = turn('Should I file a patent for it now?', { points: ['The jar is older than the idea.'] });
    expect(kept.decision.referral?.category).toBe('ip_licensing');
  });

  it('a wellbeing risk gives no task, whatever was read', () => {
    const { decision, prompt } = turn(
      'i cannot sleep and i do not know why i go on',
      { kind: 'next', also: ['feelings'], points: ['Sleep comes first.', 'The stall can wait.'] },
      { riskCategories: ['safety_wellbeing'] },
    );
    expect([decision.step, decision.reading, prompt.reading]).toEqual([null, null, undefined]);
  });

  it('a risk the classifier found keeps its person, whatever play was read', () => {
    const { decision } = turn(
      'the recipe came out of the lab and two of us cooked it',
      { playId: 'equity-split', sure: true, referral: 'equity', points: ['Two of you made it.'] },
      { riskCategories: ['ip_licensing'] },
    );
    expect(decision.referral?.category).toBe('ip_licensing');
  });

  it('a promise inside an argument is no report', () => {
    const { decision, prompt } = turn('no way, I will lower the jar to $5 on friday and then everyone buys', {
      kind: 'pushback',
      ask: 'whether a lower price would make them pay',
      record: [BACK],
      points: ['Nobody was asked at $5 yet.'],
    });
    expect([decision.kind, decision.decidedBy?.lead]).toEqual(['coaching', 'reading']);
    expect([prompt.lead, prompt.reading?.kind]).toEqual([undefined, 'pushback']);
  });

  it('where to start beside what they report is answered, not only counted', () => {
    const { decision } = turn(
      'two of the four shops wrote back and one cleared a shelf, where should I begin',
      {
        kind: 'next',
        also: ['update'],
        points: ['The shelf comes first.', 'Two letters are left.'],
      },
    );
    expect([decision.kind, decision.decidedBy?.lead]).toEqual(['coaching', 'reading']);
  });

  it('a step they report done is written whatever was read', () => {
    const { decision } = turn('Done, I set the price and said it to five buyers.', {
      kind: 'update',
      points: ['Five buyers heard it.'],
    });
    expect(decision.completes?.step.playId).toBe('pricing');
  });

  it('what another founder does is never shared', () => {
    const { decision, prompt } = turn('what does that other jam team over there charge', {
      kind: 'privacy',
      ask: 'what another team charges',
    });
    expect(decision.play?.id).toBe('other-teams-privacy');
    expect(prompt.ask?.keeps).toContain('stays with them');
  });
});

describe('the server’s one opening', () => {
  const opening = (over: Partial<Understanding>) =>
    openingOf(understood(over), { yesNo: false, today: TODAY, referral: null, message: '' });

  it('a sum: the figure with its working, on a call without what nobody could follow', () => {
    expect(opening({ kind: 'sum', sums: [sumOf()] })).toEqual({
      kind: 'sum',
      text: 'The market day left you $187.50: 30 × ($8 − $1.25) − $15. It takes off only the costs you named, and counts your own time as free.',
      voice: 'The market day left you $187.50.',
    });
  });

  it('a rule that read the counts stands over what was read, and not where friends are counted as proof', () => {
    const counts = 'talked to 12 bakers and 9 of 12 said the lids leak';
    const rule = readTurnOf(counts, null, PRICING).prompt;
    expect(rule.lead?.text).toMatch(/more than half is a pattern/);
    const result = {
      verdict: 'weak' as const,
      shows: 'Nine of 12 said the lids leak.',
      doesNotShow: 'Whether it costs them anything.',
      settles: null,
    };
    expect(turn(counts, { kind: 'result', result, points: ['A leak is small.'] }).prompt).toEqual(rule);
    const message = 'talked to 12 of my classmates and 9 of 12 said the lids leak';
    const { prompt } = turn(message, {
      kind: 'result',
      result: {
        verdict: 'weak',
        shows: 'Nine of 12 classmates said the lids leak, and you asked them about lids.',
        doesNotShow: 'Whether it costs them anything.',
        settles: null,
      },
      points: ['A leak nobody paid to stop is a small one.'],
    });
    expect([prompt.lead, prompt.reading?.result?.verdict]).toEqual([undefined, 'weak']);
  });
});

describe('the reply a founder sees', () => {
  it('an asked sum always says its figure, whatever the writer does', () => {
    for (const model of [
      '',
      "That's a good number.",
      'You made $240. Jars cost $37.50.',
      'So you keep [[240 - 37.5 - 99 dollars]].',
    ]) {
      const reply = seen(
        'what does saturday come to for me',
        { kind: 'sum', sums: [sumOf()], record: [record('A jar sells for $8 and costs you $1.25.')] },
        model,
      );
      expect(reply, model).toContain('$187.50');
      expect(steps(reply)).toBe(1);
    }
    expect(
      seen(
        'um what does saturday come to for me',
        { kind: 'sum', sums: [sumOf()] },
        'That is good.',
        {},
        'voice',
      ),
    ).toContain('$187.50');
  });

  it('an offer of money has a step of its own, who decides, and no verdict', () => {
    const reply = seen(
      'my aunt wants to put in 20k for a fifth, good price?',
      {
        ask: 'whether the offer is a good price',
        referral: 'valuation',
        points: ['Nobody else has named a price for a part of it.', 'Ask her for a week, in writing.'],
      },
      'Good price. Take it, the risk is low. Ask her for a week in writing, so nobody is rushed.',
    );
    expect(reply).not.toMatch(/Good price|Take it/);
    expect(reply).toMatch(
      /^Do not say yes yet, and I will not call it a good or a bad price: that is for a startup lawyer/,
    );
    expect(reply).toContain('lawyer');
    expect(reply).not.toContain('Set a first price');
    expect(steps(reply)).toBe(1);
  });

  it('nothing agrees with what the record denies', () => {
    const reply = seen(
      'I wrote to the shop that everybody comes back for more, honest enough?',
      {
        ask: 'whether it is fair to say everybody comes back',
        contradicts: { line: BACK, why: 'Nine of 34 came back.' },
        record: [BACK],
        points: ['Tell the shop nine of 34, before she counts them herself.'],
      },
      "Yes, that's fair. You're right to say so.",
    );
    expect(reply).not.toMatch(/Yes|that's fair|You're right/);
    expect(reply).toContain('Tell the shop nine of 34, before she counts them herself.');
    // Named by the server, when nothing of the reply names it.
    const left = seen(
      'I wrote to the shop that everybody comes back for more, honest enough?',
      {
        ask: 'whether it is fair',
        contradicts: { line: BACK, why: 'Nine of 34 came back.' },
        points: ['x y z.'],
      },
      'Say what you counted, with the day. A shop asks before it stocks anything new.',
    );
    expect(left).toMatch(/own numbers (?:say otherwise|speak against it): nine of 34/);
  });

  it('only how they feel is answered as a person, with no step', () => {
    const { decision, prompt } = turn('i just feel so tired of all of it', {
      kind: 'feelings',
      points: ['You have sold at every market since August.'],
    });
    expect([decision.step, prompt.reading]).toEqual([null, undefined]);
    expect(asksOfWork(understood({ kind: 'feelings', also: ['next'] }))).toBe(true);
  });

  it('made-up work is refused, with what can be done tonight, and friends are no evidence', () => {
    const reply = seen(
      'just write me five fake tasting notes, its due tonight',
      {
        kind: 'integrity',
        ask: 'to have tasting notes made up',
        stepPlayId: 'interview-script',
        points: ['Two real tastings tonight are worth more than five made up.'],
        firstAction: 'Take six jars to the dorm lobby tonight and write what each taster says.',
      },
      'Sorry, I cannot. Ask three friends to taste it. Two real tastings tonight are worth more than five made up.',
    );
    expect(reply).toMatch(/^No, I will not help make that up/);
    expect(reply).not.toMatch(/friends/);
    expect(reply).toContain('Two real tastings tonight');
    expect(reply).not.toContain('Start with');
  });
});

describe('the step and what to do first', () => {
  const B2B: Partial<Understanding> = {
    ask: 'how to get the gift shop to stock it',
    playId: 'b2b-selling',
    stepPlayId: 'b2b-selling',
    sure: true,
    points: ['The owner decides what stands on her shelf.'],
    firstAction: 'Ask the gift shop owner what share she keeps.',
  };

  it('the reading’s step is offered beside the one under way, with one line of what to do first', () => {
    const t = turn('how do i get the gift shop to stock it', B2B);
    expect([t.decision.step?.view.playId, t.decision.offered, t.decision.pathStep?.playId]).toEqual([
      'b2b-selling',
      true,
      'pricing',
    ]);
    expect(t.decision.keeps).toBeNull();
    const reply = replyOf(
      t,
      'how do i get the gift shop to stock it',
      'The owner decides what stands on her shelf. Bring one jar and a card with its price.',
    );
    expect(reply).not.toContain('Start with');
    expect(steps(reply)).toBe(1);
  });

  it('a step of a far stage is not given, one under way about the same thing stays', () => {
    const far = turn('which way of selling first', { stepPlayId: 'retention', points: ['Nobody left yet.'] });
    expect(far.decision.step?.view.playId).toBe('pricing');
    const same = turn('is eight dollars the right price to say to buyers', {
      stepPlayId: 'price-test',
      points: ['No buyer has answered it.'],
    });
    expect(same.decision.step?.view.playId).toBe('pricing');
  });

  it('a figure brings no step of sums to who only asks what is theirs', () => {
    const { decision, prompt } = turn('is it even worth it, what am i paid an hour', {
      kind: 'sum',
      also: ['feelings'],
      sums: [
        sumOf({ label: 'what an hour brings you', value: 6.25, said: '$6.25', working: '$187.50 ÷ 30' }),
      ],
      playId: 'unit-economics',
      stepPlayId: 'unit-economics',
    });
    expect(decision.step?.view.playId).toBe('pricing');
    expect(prompt.stepRole).toBe('standing');
  });

  it('a step in their own words is never displaced', () => {
    const own = onStep('pricing', {
      origin: 'founder',
      title: 'Email the five clubs',
      playId: null,
      criterionId: null,
      items: [],
      doneWhen: 'Five emails are out.',
    });
    const { decision } = turn('how do i get the gift shop to stock it', B2B, {
      reads: { ...NO_READS, steps: [own] },
    });
    expect([decision.keeps, decision.offered, decision.pathStep?.title]).toEqual([
      null,
      true,
      'Email the five clubs',
    ]);
  });
});

describe('who decides, by what was read', () => {
  it.each([
    ['ip', 'is it mine', 'student-ip'],
    ['ip', 'do i file a patent', 'patent-now-or-wait'],
    ['legal', 'nine pages to sign', 'contracts-and-insurance'],
    ['valuation', 'good price for a tenth', 'valuation'],
    ['equity', 'is 60 40 fair', 'equity-split'],
    ['immigration', 'can i be paid', 'international-student'],
    ['regulatory', 'can i say it heals', 'medical-rules'],
    ['regulatory', 'may i sell from my kitchen', 'permits-food'],
    ['irb', 'can i test it on people', 'regulated-data'],
    ['grants', 'is this allowed in the budget', null],
    ['wellbeing', 'i am done', null],
  ] as const)('%s, "%s": %s', (referral, message, playId) => {
    expect(referralPlayOf(PLAYBOOK, understood({ referral }), message)?.id ?? null).toBe(playId);
  });

  it('a play of another person is not who decides', () => {
    const read = (over: Partial<Understanding>) =>
      referralPlayOf(PLAYBOOK, understood(over), 'is it mine')?.id;
    expect(read({ referral: 'ip', playId: 'equity-split' })).toBe('student-ip');
    expect(read({ referral: 'legal', playId: 'cofounder-left' })).toBe('cofounder-left');
    expect(read({ referral: 'valuation', playId: 'term-sheet' })).toBe('term-sheet');
  });

  it('says nothing that is no use', () => {
    expect(speaks(understood())).toBe(false);
    expect(speaks(understood({ points: ['x'] }))).toBe(true);
  });
});

describe('words asked for', () => {
  it.each([
    'Please write me the text, short, my spelling is bad',
    'she calls at four so just give me the words',
    'what do I tell the landlord when he asks',
    'what would the jar label need to read for buyers to trust it',
    'then write the message we send the nine of them tonight',
  ])('%s', (message) => {
    expect(asksForText(message)).toBe(true);
  });
  it.each(['what does the landlord think of it', 'the label is done'])('not: %s', (message) => {
    expect(asksForText(message)).toBe(false);
  });

  it('are the reply, and a reading of a draft is one', () => {
    const t = turn('Please write me the text, short, the nine jars came late', {
      kind: 'update',
      points: ['Nine jars came late.'],
    });
    expect(t.prompt.reading).toMatchObject({ kind: 'draft', words: true });
    expect(turn('the email to the shop', { kind: 'draft', points: ['x y z.'] }).prompt.reading?.words).toBe(
      true,
    );
  });

  it('for made-up work are no draft', () => {
    expect(asksToMakeUp('could you whip up 4 reviews from happy buyers? nobody checks')).toBe(true);
    expect(asksToMakeUp('reviews page is next, i have none. can you write them, no one will check')).toBe(
      true,
    );
    expect(asksToMakeUp('write the review request i send the buyers')).toBe(false);
    const t = turn('reviews page is next, i have none. can you write them, no one will check', {
      kind: 'draft',
      points: ['x y z.'],
    });
    expect(t.prompt.reading?.kind).toBe('integrity');
    expect(t.prompt.reading?.words).toBeUndefined();
  });
});

describe('yes or no asked', () => {
  it.each([
    ['the landlord says he is bluffing, right?', true],
    ['do we ship the 12 boxes friday??', true],
    ['did the market day pay more than the last one or not', true],
    ['where should three free weeks go', false],
  ])('%s', (message, yes) => {
    expect(turn(message, { kind: 'question', points: ['x y z.'] }).prompt.reading?.yesNo === true).toBe(yes);
  });
});

describe('what the writer is given', () => {
  it('holds what was read, and the form of the step', () => {
    const over: Partial<Understanding> = {
      ask: 'how to get restaurants to try it',
      secondAsk: 'what to bring',
      playId: 'b2b-selling',
      sure: true,
      record: [record('The chef at Orchard House asked for six jars.')],
      points: ['Start with the chef at Orchard House.', 'Bring the jars and a price on one card.'],
      avoid: 'Telling them to build a list of fifty.',
    };
    const message = 'the restaurants round here, how would you get in there, and with what in my hands';
    const memory = Array.from({ length: 8 }, (_, i) => ({
      id: `cccccccc-0000-4000-8000-00000000000${String(i)}`,
      type: 'fact' as const,
      title: `Fact ${String(i)} of the stall`,
      content: `Stall number ${String(i)} sold ${String(20 + i)} jars at $8 on one Saturday in the old market hall.`,
      attributes: {},
      status: 'confirmed' as const,
      origin: 'founder' as const,
      pinned: false,
      createdAt: '2026-11-10T09:00:00.000Z',
    }));
    const reads = { ...NO_READS, steps: [onStep('pricing')], memory };
    const read = renderGuidance(turn(message, over, { reads }).prompt, 'text', { today: TODAY });
    for (const held of [
      'how to get restaurants to try it',
      'what to bring',
      'Start with the chef at Orchard House',
      'The chef at Orchard House asked for six jars.',
      'Avoid: Telling them to build a list of fifty.',
      'NEXT: <one thing to do',
    ])
      expect(read).toContain(held);
  });
});

describe('whatever the writer writes', () => {
  const READINGS: readonly Partial<Understanding>[] = [
    { kind: 'sum', sums: [sumOf()], points: ['The table costs $15 whatever you sell.'] },
    { kind: 'sum', missing: 'what one jar costs you', points: ['The price is $8.'] },
    {
      ask: 'whether the offer is a good price',
      referral: 'valuation',
      points: ['Nobody else has named a price.', 'Ask her for a week, in writing.'],
      firstAction: 'Write your aunt that you need a week.',
    },
    {
      contradicts: { line: BACK, why: 'Nine of 34 came back, so most did not.' },
      record: [BACK],
      points: ['Say nine of 34.'],
    },
    {
      kind: 'choice',
      choice: {
        options: ['the market', 'the shop'],
        pick: 'the shop',
        because: 'It takes one delivery a month.',
        flipsIf: 'the owner keeps more than half.',
      },
      points: ['Each Saturday is a day you do not study.'],
    },
    {
      kind: 'result',
      result: {
        verdict: 'mixed',
        shows: 'Four of 25 bought.',
        doesNotShow: 'Whether the rest found it dear.',
        settles: 'What ten of them say.',
      },
      points: ['A taste is free.'],
      stepPlayId: 'read-results',
      firstAction: 'Ring two of the four and ask what they did with the jar.',
    },
    {
      kind: 'pushback',
      record: [BACK],
      points: ['Nobody asked the 25 why.'],
      firstAction: 'Ask 8 of the 25 what they bought instead.',
    },
    {
      kind: 'next',
      also: ['feelings', 'update'],
      referral: 'legal',
      playId: 'cofounder-left',
      points: [
        'The kitchen comes first, you cook there on Monday.',
        'Your partner leaving needs a list.',
        'Sugar can wait.',
      ],
    },
    { kind: 'integrity', points: ['Two real tastings tonight are worth more.'] },
    {
      playId: 'b2b-selling',
      stepPlayId: 'b2b-selling',
      sure: true,
      record: [record('The chef asked for six jars.')],
      points: ['The owner decides.', 'Bring a card with the price.'],
      firstAction: 'Ask the shop owner what share she keeps.',
    },
    { kind: 'update', points: ['Six jars on a shelf are not sold yet.'] },
    { kind: 'draft', points: ['Say who you are and what a jar costs.'] },
    { kind: 'privacy', points: [] },
    { kind: 'recall', record: [BACK], points: [] },
  ];
  const MODELS = [
    '',
    'Yes.',
    "Good. That's a great sign.",
    'Yes, take it. It is a fair price. Ask her for a week in writing.',
    'The owner decides what stands there, so ask her first. Bring a card with the price on it.\n\n1. Write the price on a card.\n2. Take it to the owner.\n3. Ask what share she keeps.',
    'You made $240 and jars cost $37.50, so you keep $187.50. That is $6.25 a jar.',
    "I'm not claiming anything without evidence. Nobody asked the 25 why they left, so ask eight of them this week by Friday.\n\nNext: call eight people by Friday. Done when eight answered.",
    'Ask your friends to taste it. Say it costs $8, and ask for the money.\nNEXT: Ask the shop owner what share she keeps | DONE: She named a share',
    'One jar is eight dollars, and a shelf is not a sale. Ask on Friday how many went.\nNEXT: same',
  ];
  const message = 'so what do i make of that, the shop and all of it?';

  it.each(READINGS.map((u) => [u.kind ?? 'question', u] as const))(
    '%s: one step, what opens whole, and stored as shown',
    (_kind, u) => {
      for (const model of MODELS)
        for (const reads of [PRICING.reads, NO_READS])
          for (const channel of ['text', 'voice'] as const) {
            const t = turn(message, u, { reads, channel });
            const reply = replyOf(t, message, model, channel);
            const label = `${channel}: ${model}`;
            const said =
              reply.match(
                /\*\*(?:Next|On your path, next is):\*\*|Your next step:|On your path, next is:/g,
              ) ?? [];
            expect(said, label).toHaveLength(1);
            const { lead } = t.prompt;
            if (lead !== undefined && channel === 'text')
              expect(reply.startsWith(lead.text), label).toBe(true);
            expect(reply, label).not.toMatch(/NEXT|DONE\b/);
            if (u.referral === 'valuation') expect(reply, label).not.toMatch(/fair price|take it/i);
            if (u.kind === 'integrity') expect(reply, label).not.toMatch(/Ask your friends/);
          }
    },
  );
});
