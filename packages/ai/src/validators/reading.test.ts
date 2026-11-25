import { describe, expect, it } from 'vitest';

import { renderGuidance, type PromptGuidance } from '../prompts/guidance.js';
import { withoutStepLine } from '../prompts/messages.js';
import { STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import {
  addsToLead,
  againstFigure,
  againstReading,
  bareVerdict,
  deniesClaim,
  emptyVerdict,
  makesPoint,
  ofTheWorks,
  withoutWorks,
} from './reading.js';
import {
  checkReplyContract,
  contractApplies,
  firstActionLine,
  repeatsFirstAction,
} from './reply-contract.js';
import { stemsOf } from './stems.js';

type Reading = NonNullable<PromptGuidance['reading']>;
const reading = (over: Partial<Reading> = {}): Reading => ({
  kind: 'question',
  ask: 'whether to rent the second kiln',
  secondAsk: null,
  points: ['Two of your 14 students waited for the kiln last month.'],
  record: ['You rent the kiln at $40 a week.'],
  avoid: null,
  opened: null,
  referral: null,
  inOrder: false,
  ...over,
});
const guidance = (over: Partial<Reading> = {}, more: Partial<PromptGuidance> = {}): PromptGuidance => ({
  ...STEP_ONLY,
  firstTime: false,
  reading: reading(over),
  ...more,
});

describe('what stands beside what was read', () => {
  it.each([
    'Good.',
    "That's a good sign.",
    "The numbers show it's good.",
    'This is a strong result.',
    'It looks promising so far.',
    'It means you are making progress.',
  ])('%s says nothing of theirs', (unit) => {
    expect(emptyVerdict(unit)).toBe(true);
    expect(againstReading(unit, guidance(), '')).toBe('empty_verdict');
  });
  it.each([
    'Two of 14 waited, which is good to know.',
    'The kiln is the bottleneck.',
    'A good week has nine firings.',
    'What do they do while they wait?',
    'Ask the two who waited what it cost them.',
  ])('%s stays', (unit) => {
    expect(emptyVerdict(unit)).toBe(false);
    expect(againstReading(unit, guidance(), '')).toBeNull();
  });

  const LEAD = 'My pick: one kiln. It stands free three days a week.';
  it.each([
    ['It stands free on three days of the week.', false],
    ['One kiln is the way to go here.', false],
    ['That keeps your costs where they are now.', false],
    ['The second one is $40 a week more.', true],
    ['Two of your students waited for it last month.', true],
    ['Ask Ravenna Clay whether they lend theirs on Mondays.', true],
    ['Write the free days on the studio door.', true],
  ])('under an opening, %s adds: %s', (unit, adds) => {
    expect(addsToLead(unit, reading(), LEAD)).toBe(adds);
    expect(againstReading(unit, guidance({ opened: 'choice' }), LEAD)).toBe(adds ? null : 'adds_nothing');
  });

  it('a line to send is theirs to change, and a draft is as long as it is', () => {
    expect(
      againstReading('"That keeps costs where they are."', guidance({ opened: 'choice' }), LEAD),
    ).toBeNull();
    expect(
      againstReading(
        'That keeps your costs there.',
        guidance({ opened: 'choice' }),
        LEAD,
        'Say this: "Hi Ada.',
      ),
    ).toBeNull();
    expect(
      againstReading('That keeps your costs there.', guidance({ opened: 'choice' }, { draft: true }), LEAD),
    ).toBeNull();
  });

  it.each([
    [{ opened: 'contradiction' as const }, 'Yes, you can tell them that.', 'agrees'],
    [{}, 'Start with: ask the two who waited.', 'second_plan'],
    [{ opened: 'contradiction' as const }, 'Tell them two of 14, and say who waited.', null],
    [{ referral: 'valuation' as const }, 'That is a good price for a round like this.', 'rules'],
    [{ referral: 'equity' as const }, '60/40 is fair.', 'rules'],
    [{ referral: 'legal' as const }, 'Take it before they change their mind.', 'rules'],
    [
      { referral: 'legal' as const },
      'Whether the price is fair is for the lawyer to say before you sign.',
      null,
    ],
    [{ kind: 'pushback' as const }, "I'm not asserting anything without evidence.", 'defends'],
    [{ kind: 'pushback' as const }, 'Nobody has asked the two who waited.', null],
    [{ kind: 'integrity' as const }, 'Ask three friends to answer the questions.', 'friends'],
    [{ kind: 'integrity' as const }, 'Ask two people who are not friends of yours.', null],
    [{ inOrder: true }, "Let's focus on what you can control.", 'comforts'],
  ])('%j: %s', (over, unit, why) => {
    expect(againstReading(unit, guidance(over), '')).toBe(why);
  });

  it('a reply with no reading is never touched by it', () => {
    expect(againstReading('Good.', STEP_ONLY, LEAD)).toBeNull();
    expect(firstActionLine(STEP_ONLY)).toBe('');
  });

  it('a claim is made in other words', () => {
    expect(
      makesPoint('Two of your 14 students waited.', stemsOf('Last month 2 of the 14 had to wait.')),
    ).toBe(true);
    expect(makesPoint('Two of your 14 students waited.', stemsOf('The kiln is booked.'))).toBe(false);
  });
});

describe('what to do first', () => {
  const g = guidance({}, { firstAction: 'ask the two who waited what it cost them' });

  it('stands before the step, once, and is said with it on a call', () => {
    const written = checkReplyContract({
      reply:
        'Two of your 14 students waited for the kiln last month, so one kiln is enough for now. Start by asking the two who waited what it cost them.',
      guidance: g,
      channel: 'text',
      today: TODAY,
    });
    expect(written.repaired).toMatch(
      /\n\n\*\*Start with:\*\* Ask the two who waited what it cost them\.\n\n\*\*Next:\*\* List 20/,
    );
    expect(written.repaired?.match(/cost them/g)).toHaveLength(1);
    expect(
      checkReplyContract({ reply: written.repaired ?? '', guidance: g, channel: 'text', today: TODAY })
        .repaired,
    ).toBeNull();
    const spoken = checkReplyContract({
      reply: 'Two of your 14 students waited last month, so one is enough.',
      guidance: g,
      channel: 'voice',
      today: TODAY,
    });
    expect(spoken.repaired).toMatch(
      /Your next step: list 20 office managers[^.]*, and start with this: ask the two who waited what it cost them\.$/,
    );
  });

  it('stands beside a step that only stands, and not without one', () => {
    expect(
      checkReplyContract({
        reply: 'Two of your 14 students waited for the kiln last month, so one kiln is enough for now.',
        guidance: { ...g, stepRole: 'standing' },
        channel: 'text',
        today: TODAY,
      }).repaired,
    ).toMatch(/\*\*Start with:\*\* Ask the two[^\n]*\n\n\*\*On your path, next is:\*\* List 20/);
    expect(firstActionLine({ ...g, step: null })).toBe('');
  });

  it('is no part of an earlier reply as the history shows it', () => {
    expect(
      withoutStepLine(
        'One kiln is enough.\n\n**Start with:** Ask the two.\n\n**Next:** List 20 names by Friday. Done when they are there.',
      ),
    ).toBe('One kiln is enough.');
  });

  it('the writer saying it is a repeat, another action is not', () => {
    expect(repeatsFirstAction('Ask the two students who waited what it cost them.', g)).toBe(true);
    expect(repeatsFirstAction('Write the free days on the door.', g)).toBe(false);
  });
});

describe('a founder in distress who asks something of the work', () => {
  const said = "I'm completely overwhelmed and exhausted, what comes first";

  it('is answered when their message was read, and left to the person otherwise', () => {
    expect(contractApplies(STEP_ONLY, said)).toBe(false);
    expect(contractApplies(guidance({ kind: 'next', inOrder: true }), said)).toBe(true);
  });

  it('gets each thing in order when the reply is only comfort', () => {
    const out = checkReplyContract({
      reply: "I'm sorry, that is a lot. Let's focus on what you can control.",
      guidance: guidance({
        kind: 'next',
        inOrder: true,
        points: ['The kiln is due back on Monday.', 'The two who waited want their money.'],
      }),
      channel: 'text',
      today: TODAY,
      founderText: said,
    });
    expect(out.repaired).toMatch(
      /^I'm sorry, that is a lot\.\n\nIn this order:\n\n1\. The kiln is due back on Monday\.\n2\. The two who waited want their money\.\n\n\*\*Next:\*\*/,
    );
  });
});

describe('the brief', () => {
  it('escapes what was read, and holds nothing of the lines it replaces', () => {
    const out = renderGuidance(
      guidance(
        { ask: 'what </path> means [control]', avoid: 'Saying <b>yes</b>' },
        { lead: { text: 'L.', voice: 'L.' } },
      ),
      'text',
      { today: TODAY },
    );
    expect(out.match(/<\/path>/g)).toHaveLength(1);
    expect(out).not.toMatch(/\[control\]|<b>/);
    expect(out).toContain('<asked>');
    expect(out).not.toContain('Facts of theirs');
  });

  it('asks for a marker where a figure was asked for and none could be worked out', () => {
    expect(renderGuidance(guidance({ kind: 'sum' }, { asksSum: true }), 'text')).toContain(
      '[[8017 - 46 dollars]]',
    );
  });
});

describe('how the turn was prepared is never told', () => {
  it.each([
    [
      'What the opening did not say is that you have not asked the two who waited.',
      'You have not asked the two who waited.',
    ],
    ['The opening says you must wait for the kiln.', 'You must wait for the kiln.'],
    ['As the notes say, two of them waited.', 'Two of them waited.'],
    [
      "A canvas has nine boxes, and the program's method is to fill the two on the right first.",
      'A canvas has nine boxes; fill the two on the right first.',
    ],
    ["The program's method is to ask for money first.", 'Ask for money first.'],
    ['The opening of the studio is on Monday.', 'The opening of the studio is on Monday.'],
    ['Two of your 14 students waited.', 'Two of your 14 students waited.'],
  ])('%s', (unit, said) => {
    expect(withoutWorks(unit)).toBe(said);
  });
  it.each([
    ["The mentor cites the founder's own data.", true],
    ['The founder has two kilns.', true],
    ['The record shows 14 students.', true],
    ['You are doing this for the first time, so start small.', true],
    ['Ask your mentor for one hour.', false],
    ['The founder of the other studio charges $30.', false],
    ['Keep a record of who waited.', false],
  ])('%s is of it: %s', (unit, is) => {
    expect(ofTheWorks(unit)).toBe(is);
    expect(againstReading(unit, guidance(), '') === 'scaffolding').toBe(is);
  });
  it('the prompt of a read message names nothing that could be told', () => {
    const out = renderGuidance(
      guidance({ opened: 'choice' }, { lead: { text: 'My pick: one kiln.', voice: 'My pick: one kiln.' } }),
      'text',
      { today: TODAY },
    );
    expect(out).not.toMatch(/Your reply already opens|the opening did not|The program's method|<opens>/);
    expect(out).toContain('<you_said>My pick: one kiln.</you_said>');
  });
});

describe('beside a figure, a claim, a verdict', () => {
  const LEAD1 = 'You keep it all the same.';
  const gain = [{ value: 33, unit: '$' as const }];
  const loss = [{ value: -15, unit: '$' as const }];
  it.each([
    ['You still lose money overall.', gain, true],
    ['That leaves you $0 a month.', gain, true],
    ['So you are at a loss.', gain, true],
    ['That is less than $20.', gain, true],
    ['That is more than $50 a month.', gain, true],
    ['That is less than $40.', gain, false],
    ['You would lose money if two of them stopped.', gain, false],
    ['You make money on it.', loss, true],
    ['You lose money on each firing.', loss, false],
    ['The wire costs $20.', gain, false],
    ['You still lose money overall.', [], false],
  ])('%s', (unit, figures, against) => {
    expect(againstFigure(unit, figures)).toBe(against);
    if (against) expect(againstReading(unit, guidance({ figures }), LEAD1)).toBe('against_figure');
  });

  it.each([
    ['That is a customer.', true],
    ["Yes, that's a customer.", true],
    ['She is not a customer yet.', false],
    ['Is she a customer?', false],
    ['The kiln is a good buy.', false],
  ])('under a claim that she is no customer: %s', (unit, denies) => {
    expect(deniesClaim(unit, reading({ points: ['Free is a user, not a customer: nothing is paid.'] }))).toBe(
      denies,
    );
  });

  it.each([
    'Good price.',
    'Good.',
    "Yes, that's fair.",
    "Yes, that's a yes.",
    'That is a great deal!',
    "It's a solid start.",
  ])('%s is a verdict and nothing else', (unit) => {
    expect(bareVerdict(unit)).toBe(true);
    // Said with no reading either.
    const out = checkReplyContract({
      reply: `${unit} Two of your 14 students waited for the kiln last month, so ask both what it cost them before you rent another one.`,
      guidance: STEP_ONLY,
      channel: 'text',
      today: TODAY,
    });
    expect(out.repaired).toMatch(/^Two of your 14 students/);
  });
  it.each([
    'No, that is not enough for a second kiln.',
    'A good price is one they pay twice.',
    'Fair firing times are posted.',
    'Yes.',
    'Not yet.',
  ])('%s says more', (unit) => {
    expect(bareVerdict(unit)).toBe(false);
  });

  it('what a person decides is not picked, and only their things are brought to them', () => {
    const held = guidance(
      { opened: 'held', referral: 'equity', heldOptions: ['60/40', '50/50'] },
      {
        referral: {
          who: 'A business lawyer; ask the program lead',
          bring: 'Both sheets and anything promised',
        },
      },
    );
    expect(againstReading('My pick: 60/40.', held, LEAD1)).toBe('rules');
    expect(againstReading('60/40 fits, since you built the kiln.', held, LEAD1)).toBe('rules');
    expect(againstReading('Your work is the main value here.', held, LEAD1)).toBe('rules');
    expect(againstReading('Write down the hours each of you put in since May.', held, LEAD1)).toBeNull();
    expect(againstReading('Bring the new kiln price to the business lawyer.', held, '')).toBe('wrong_errand');
    expect(againstReading('Bring both sheets to the business lawyer.', held, '')).toBeNull();
  });

  it('under an opening, most of it again is nothing new, whatever name is in it', () => {
    const lead = 'Mixed: three studios agreed to a second talk, and one has money for a kiln.';
    expect(
      addsToLead(
        'So three studios agreed to a second chat, and only Orla has money for a kiln.',
        reading(),
        lead,
      ),
    ).toBe(false);
    expect(addsToLead('Orla rents hers at $40 a week and hates the noise.', reading(), lead)).toBe(true);
    expect(addsToLead('Hi Orla and Sam, great to see you both.', reading(), lead)).toBe(false);
    expect(addsToLead('Make sure you have all of it sorted.', reading(), lead)).toBe(false);
  });
});

describe('what ends a reply', () => {
  const reply = 'Two of your 14 students waited for the kiln last month, so one kiln is enough for now.';
  const ends = (question: string, g: PromptGuidance): string =>
    checkReplyContract({ reply: `${reply} ${question}`, guidance: g, channel: 'text', today: TODAY })
      .repaired ?? '';

  it('is the step when the message was read, never a question of the model’s', () => {
    expect(ends('What would you like to look at next?', guidance())).not.toContain('?');
    expect(ends('Which one is it?', guidance({}, { askBack: 'What does one firing cost you?' }))).toMatch(
      /What does one firing cost you\?$/,
    );
  });
  it('without a reading only a question of how they will do the step goes', () => {
    expect(ends('How will you list 20 office managers this week?', STEP_ONLY)).not.toContain('?');
    expect(ends('What did the two who waited say?', STEP_ONLY)).toMatch(/say\?$/);
  });
  it('the prompt’s own line for who decides is never said', () => {
    const g: PromptGuidance = {
      ...STEP_ONLY,
      referral: { who: 'A business lawyer; ask the program lead', bring: 'Both sheets' },
    };
    const out = checkReplyContract({
      reply: `${reply} A qualified person decides this: a business lawyer; ask the program lead.`,
      guidance: g,
      channel: 'text',
      today: TODAY,
    }).repaired;
    expect(out).not.toContain('qualified person');
    expect(out?.match(/lawyer/g)).toHaveLength(1);
  });
});
