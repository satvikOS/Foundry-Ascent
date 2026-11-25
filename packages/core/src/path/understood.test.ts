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
import { missingQuestion, openingsOf } from './openings.js';
import {
  asksOfWork,
  decides,
  firstActionOf,
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
    expect(prompt.lead?.text).toMatch(/^Fair:/);
  });

  it('where to start beside what they report is answered, not only counted', () => {
    const { decision } = turn(
      'two of the four letters are out and the shop cleared a shelf, what should I do first',
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
  const opening = (over: Partial<Understanding>, more: Partial<Parameters<typeof openingsOf>[1]> = {}) =>
    openingsOf(understood(over), { yesNo: false, today: TODAY, referral: null, step: null, ...more })[0];

  it('a sum: the figure with its working, on a call without what nobody could follow', () => {
    expect(opening({ kind: 'sum', sums: [sumOf()] })).toEqual({
      kind: 'sum',
      text: 'The market day left you $187.50: 30 × ($8 − $1.25) − $15. It takes off only the costs you named, and counts your own time as free.',
      voice: 'The market day left you $187.50.',
    });
  });

  it('a number that is missing: which, and its question', () => {
    expect(opening({ kind: 'sum', missing: 'what one jar costs you' })?.text).toBe(
      'I cannot give you that figure yet, because one number is missing: what one jar costs you.',
    );
    expect(missingQuestion('what one jar costs you')).toBe('Can you tell me what one jar costs you?');
    expect(missingQuestion('your rent for the kitchen')).toBe('What is your rent for the kitchen?');
    expect(missingQuestion('sugar cost')).toBe('What is the sugar cost?');
  });

  it('a choice, with what would change it', () => {
    expect(
      opening({
        kind: 'choice',
        choice: {
          options: ['the market', 'the gift shop'],
          pick: 'the gift shop',
          because: 'It takes one delivery a month.',
          flipsIf: 'If the owner keeps more than half.',
        },
      }),
    ).toEqual({
      kind: 'choice',
      text: 'My pick: the gift shop. It takes one delivery a month. I’d change my mind if the owner keeps more than half.',
      voice: 'My pick: the gift shop. It takes one delivery a month.',
    });
  });

  it('a result: the verdict, what it shows, what it does not, what settles it', () => {
    expect(
      opening({
        kind: 'result',
        result: {
          verdict: 'weak',
          shows: 'Four of 25 who tasted bought a jar.',
          doesNotShow: 'Whether the others found it too dear.',
          settles: 'What ten of them say stopped them.',
        },
      })?.text,
    ).toMatch(
      /^(?:Weak|That is thin) so far: four of 25 who tasted bought a jar\. (?:It does not tell you|What you still do not know is|That leaves open) whether the others found it too dear\. What settles it is what ten of them say stopped them\.$/,
    );
  });

  it('what their record denies, before anything else', () => {
    const said = opening(
      {
        kind: 'question',
        contradicts: { line: BACK, why: 'Nine of 34 came back, so most did not.' },
        choice: { options: ['a', 'b'], pick: 'a', because: 'It is first.', flipsIf: null },
      },
      { yesNo: true },
    );
    expect(said?.kind).toBe('contradiction');
    expect(said?.text).toBe('Not quite, by your own numbers: nine of 34 buyers came back in October.');
    const changed = opening({
      contradicts: {
        line: record('You decided to sell to gift shops and not at markets.', 'decision'),
        why: 'The market was set aside.',
      },
    });
    expect(changed?.text).toMatch(
      /^That changes something you settled before \(on November 3\): you decided to sell/,
    );
  });

  it('asked for a figure, the figure comes first, and the others go to the writer', () => {
    const { prompt } = turn('what does saturday come to for me, everybody comes back anyway', {
      kind: 'sum',
      sums: [sumOf()],
      contradicts: { line: BACK, why: 'Nine of 34 came back, so most did not.' },
      points: ['The table costs the same whatever you sell.'],
    });
    expect(prompt.lead?.text).toMatch(/^The market day left you \$187\.50/);
    expect(prompt.reading?.points).toEqual([
      'Nine of 34 came back, so most did not',
      'The table costs the same whatever you sell',
    ]);
  });

  it('no canned reading of news opens over what was read', () => {
    const message = 'talked to 12 bakers and 9 of 12 said the lids leak';
    expect(readTurnOf(message, null, PRICING).prompt.lead?.text).toMatch(/more than half is a pattern/);
    const { prompt } = turn(message, {
      kind: 'result',
      result: {
        verdict: 'weak',
        shows: 'Nine of 12 bakers said the lids leak, and you asked them about lids.',
        doesNotShow: 'Whether it costs them anything.',
        settles: null,
      },
      points: ['A leak nobody paid to stop is a small one.'],
    });
    expect(prompt.lead?.text).toMatch(/^(?:Weak|That is thin) so far: nine of 12 bakers/);
    expect(prompt.lead?.text).not.toContain('pattern');
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

  it('a missing number is the one question', () => {
    const reply = seen(
      'what do i make on a jar',
      { kind: 'sum', missing: 'what one jar costs you', points: ['The price is told, and the cost is not.'] },
      'What do you spend on sugar? And on glass?',
    );
    expect(reply).toContain('one number is missing: what one jar costs you.');
    expect(reply.endsWith('Can you tell me what one jar costs you?')).toBe(true);
    expect(reply.match(/\?/g)).toHaveLength(1);
  });

  it('under an opening a sentence stays only when it adds something', () => {
    const reply = seen(
      'ok so 25 people tasted and 4 bought, rest said yum',
      {
        kind: 'result',
        result: {
          verdict: 'weak',
          shows: 'Four of 25 who tasted bought a jar.',
          doesNotShow: null,
          settles: null,
        },
        points: ['A taste is free, so liking it shows nothing yet.'],
      },
      "Good. The numbers show it's good. Four of the 25 bought one. A taste is free, so liking it shows nothing.",
    );
    expect(reply).not.toMatch(/good/i);
    expect(reply).toContain('A taste is free');
    expect(reply.match(/four of/gi)).toHaveLength(1);
  });

  it('a bare verdict goes where nothing opens too', () => {
    const reply = seen(
      'the shop took six jars',
      { kind: 'update', points: ['Six jars on a shelf are not sold yet.'] },
      "That's a great sign. Six jars on a shelf are not sold yet, so ask on Friday how many went.",
    );
    expect(reply).not.toMatch(/great sign/);
    expect(reply).toContain('Six jars on a shelf');
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
    expect(reply).toMatch(/own numbers say otherwise: nine of 34/);
    expect(reply).not.toMatch(/Yes|that's fair|You're right/);
    // What to do with it is said all the same.
    expect(reply).toContain('Tell the shop nine of 34, before she counts them herself.');
  });

  it('a push is owned, with their numbers and the test that decides it', () => {
    const reply = seen(
      'you keep saying that but where is your proof',
      {
        kind: 'pushback',
        ask: 'whether there is any proof',
        record: [BACK],
        result: {
          verdict: 'too_early',
          shows: 'Nine of 34 came back.',
          doesNotShow: null,
          settles: 'Whether 8 of the next 20 come back',
        },
        points: ['Nobody has asked the other 25 why.'],
      },
      "I'm not asserting anything without evidence. The evidence we have is your buyers. Nobody has asked the other 25 why.",
    );
    expect(reply).toMatch(/^Fair: what I said is a judgement, and neither of us has proof yet\./);
    expect(reply).toContain('nine of 34 buyers came back in October');
    expect(reply).toMatch(/What decides it by Monday is whether 8 of the next 20 come back\./);
    expect(reply).not.toMatch(/asserting|evidence we have/);
  });

  it('several things at once are said in order, never only comfort, with one step', () => {
    const over: Partial<Understanding> = {
      kind: 'next',
      also: ['feelings', 'update'],
      ask: 'what to do first',
      referral: 'legal',
      playId: 'cofounder-left',
      stepPlayId: 'cofounder-left',
      points: [
        'The kitchen comes first: without it nothing is cooked next week.',
        'Your partner leaving needs a list of what each of you made and paid.',
        'Sugar can wait until you know where you cook.',
      ],
    };
    const message =
      'my partner moved away and the landlord wants the kitchen back and sugar doubled, I am panicking, what comes first';
    const reply = seen(
      message,
      over,
      "I hear you, that is a lot at once. Let's focus on what you can control.",
    );
    expect(reply).not.toMatch(/what you can control/);
    expect(reply.match(/lot at once/g)).toHaveLength(1);
    expect(reply).toMatch(/1\. The kitchen comes first[^]*2\. Your partner leaving[^]*3\. Sugar can wait/);
    expect(reply).toContain('lawyer');
    expect(steps(reply)).toBe(1);
    // With no word of the writer's at all.
    const bare = seen(message, over, '');
    expect(bare).toMatch(/^That is a lot at once, and it makes sense[^]* In this order:\n\n1\. The kitchen/);
    // Said again in the writer's words, nothing of it is there twice.
    const own = seen(
      message,
      over,
      'That is hard. The kitchen comes first, because without it nothing is cooked next week. Sugar can wait until you know where you cook.',
    );
    expect(own.match(/kitchen comes first/gi)).toHaveLength(1);
    expect(own.match(/Sugar can wait/g)).toHaveLength(1);
    // On a call: one warm sentence, and the first two.
    const heard = turn(message, over, { channel: 'voice' }).prompt.lead?.voice ?? '';
    expect(heard).toMatch(
      /^That is a lot at once\. First, the kitchen comes first[^]* Then, your partner leaving/,
    );
  });

  it('a letter that needs a lawyer is said before what can wait', () => {
    const { prompt } = turn('a lot happened, i am overwhelmed, what is first', {
      kind: 'next',
      also: ['feelings', 'update'],
      points: [
        'The second table needs a card reader.',
        'The letter about your label goes to a lawyer before you answer it.',
        'The jars are due back on Friday.',
      ],
    });
    expect(prompt.lead?.text).toMatch(
      /1\. The letter about your label[^]*2\. The jars are due back[^]*3\. The second table/,
    );
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
    expect(reply).toContain('**Start with:** Take six jars to the dorm lobby tonight');
  });

  it('a record line is added whole, only when the reply names none of them', () => {
    const over: Partial<Understanding> = {
      kind: 'question',
      record: [
        record('First two Saturdays.'),
        record('You are doing this for the first time.', 'founder'),
        record('The program says to price it first with restaurants.'),
        record('You cook on Mondays in a church kitchen.'),
        record('The chef at Orchard House, a restaurant, asked for six jars.'),
      ],
      points: ['A price on a card answers before they ask.'],
    };
    const ask = 'how do i get restaurants to try it';
    const left = seen(
      ask,
      over,
      'A price on a card answers before they ask, so bring one with the jars you show.',
    );
    expect(left).toContain('The chef at Orchard House, a restaurant, asked for six jars.');
    expect(left).not.toMatch(
      /First two Saturdays|Keep (?:this )?in mind|Remember that|first time|program|church kitchen/,
    );
    const named = seen(
      ask,
      over,
      'Start at Orchard House, where the chef asked for six jars, and bring a price on a card.',
    );
    expect(named.match(/Orchard House/g)).toHaveLength(1);
  });

  it('what is on record is told, dated, when they ask for it', () => {
    const reply = seen(
      'remind me why we dropped the cafes',
      {
        kind: 'recall',
        ask: 'why they dropped the cafes',
        record: [record('You decided to stop selling to cafes because they paid after 60 days.', 'decision')],
      },
      '',
    );
    expect(reply).toMatch(
      /^On November 3: you decided to stop selling to cafes because they paid after 60 days\./,
    );
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
      'The owner decides what stands on her shelf.',
    );
    expect(reply).toMatch(
      /\*\*Start with:\*\* Ask the gift shop owner what share she keeps\.\n\n\*\*Next:\*\* Name who decides/,
    );
    expect(steps(reply)).toBe(1);
  });

  it('on a call it is part of the step', () => {
    const t = turn('um how do i get the gift shop to stock it', B2B, { channel: 'voice' });
    expect(replyOf(t, 'um', 'The owner decides what stands on her shelf.', 'voice')).toMatch(
      /Your next step: name who decides in 2 companies and offer one a pilot by [^.]*, and start with this: ask the gift shop owner what share she keeps\.$/,
    );
  });

  it('the writer’s own words for it go', () => {
    const reply = replyOf(
      turn('how do i get the gift shop to stock it', B2B),
      'how do i get the gift shop to stock it',
      'The owner decides what stands on her shelf. Ask the gift shop owner what share she keeps.',
    );
    expect(reply.match(/what share she keeps/g)).toHaveLength(1);
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

  const view = {
    ...(turn('how do i get the gift shop to stock it', B2B).decision.step?.view as never as object),
    standing: false,
  } as Parameters<typeof firstActionOf>[1];
  it.each([
    ['Ask the gift shop owner what share she keeps.', 'Ask the gift shop owner what share she keeps'],
    [
      'Ask the gift shop owner what share she keeps by Friday.',
      'Ask the gift shop owner what share she keeps',
    ],
    ['Think about who might stock the jars.', null],
    ['You could ask the owner what share she keeps.', null],
    ['Ask them.', null],
    ['Name who decides in 2 companies.', null],
  ])('%s -> %s', (firstAction, said) => {
    expect(firstActionOf(understood({ firstAction, stepPlayId: 'b2b-selling' }), view, 'the gift shop')).toBe(
      said,
    );
  });

  it('beside a step that only stands, only what is about the ask', () => {
    const of = (firstAction: string) =>
      turn('what goes on the label of the lid', {
        ask: 'what to write on the lid',
        points: ['The label says what is in it and the day.'],
        firstAction,
      }).prompt;
    expect([
      of('Write the label of one lid by hand.').stepRole,
      of('Write the label of one lid by hand.').firstAction,
    ]).toEqual(['standing', 'Write the label of one lid by hand']);
    expect(of('Ring the bank and open an account.').firstAction).toBeUndefined();
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

describe('what the writer is given', () => {
  it('is shorter than without a reading, and holds what was read', () => {
    const over: Partial<Understanding> = {
      ask: 'how to get restaurants to try it',
      secondAsk: 'what to bring',
      playId: 'b2b-selling',
      sure: true,
      record: [record('The chef at Orchard House asked for six jars.')],
      points: ['Start with the chef at Orchard House.', 'Bring the jars and a price on one card.'],
      avoid: 'Telling them to build a list of fifty.',
    };
    const message = 'how do i sell to restaurants, and what do i bring';
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
    const rules = renderGuidance(readTurnOf(message, null, { reads }).prompt, 'text', { today: TODAY });
    expect(read.length).toBeLessThan(rules.length);
    for (const held of [
      'how to get restaurants to try it',
      'what to bring',
      'Start with the chef at Orchard House',
      'The chef at Orchard House asked for six jars.',
      'Avoid: Telling them to build a list of fifty.',
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
    'Ask your friends to taste it. Start with: ask the shop owner what share she keeps.',
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
            expect(reply.match(/Start with:/g) ?? [], label).toHaveLength(
              t.prompt.firstAction === undefined || channel === 'voice' ? 0 : 1,
            );
            expect(reply, label).not.toMatch(/great sign/);
            if (u.referral === 'valuation') expect(reply, label).not.toMatch(/fair price|take it/i);
            if (u.kind === 'pushback') expect(reply, label).not.toMatch(/not claiming/);
            if (u.kind === 'integrity') expect(reply, label).not.toMatch(/your friends/);
          }
    },
  );
});
