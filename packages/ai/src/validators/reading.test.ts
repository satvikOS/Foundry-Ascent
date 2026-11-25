import { describe, expect, it } from 'vitest';

import { renderGuidance, type PromptGuidance } from '../prompts/guidance.js';
import { STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { againstFigure, bareVerdict, deniesClaim, falseUnit, ofTheWorks, withoutWorks } from './reading.js';
import { checkReplyContract, contractApplies, wholeApplies } from './reply-contract.js';

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

describe('what is cut from a reply whose message was read', () => {
  it.each([
    [{ contradicts: { line: 'You rent one kiln.', says: 'x' } }, 'Yes, you can tell them that.', 'agrees'],
    [
      { contradicts: { line: 'You rent one kiln.', says: 'x' } },
      'Tell them two of 14, and say who waited.',
      null,
    ],
    [{ referral: 'valuation' as const }, 'That is a good price for a round like this.', 'rules'],
    [{ referral: 'equity' as const }, '60/40 is fair.', 'rules'],
    [{ referral: 'legal' as const }, 'Take it before they change their mind.', 'rules'],
    [
      { referral: 'legal' as const },
      'Whether the price is fair is for the lawyer to say before you sign.',
      null,
    ],
    [{ kind: 'integrity' as const }, 'Ask three friends to answer the questions.', 'friends'],
    [{ kind: 'integrity' as const }, 'Ask two people who are not friends of yours.', null],
    [{}, 'Your roommates love the bowls, which shows real demand.', 'friends'],
    [{}, 'Your roommates love the bowls, and that shows nothing yet, not even a sale.', null],
    [{ gone: [14] }, 'All 14 students waited for the kiln.', 'gone'],
    [{}, 'You need 38 firings to cover the rent.', null],
  ])('%j: %s', (over, unit, why) => {
    expect(falseUnit(unit, guidance(over))).toBe(why);
  });

  it('a figure nobody worked out is not concluded', () => {
    const asks = guidance({ kind: 'sum' }, { asksSum: true, said: 'You rent the kiln at $40 a week.' });
    expect(falseUnit('You need to sell 38 bowls to cover the kiln.', asks)).toBe('own_sum');
    expect(falseUnit('You need to sell [[40 / 5 units]] to cover the kiln.', asks)).toBeNull();
  });

  it('how it is written is the writer’s: nothing else goes', () => {
    for (const unit of [
      'That is a good sign.',
      'One kiln is the way to go here.',
      "I'm not asserting anything without evidence.",
      "Let's focus on what you can control.",
      'Start with this: ask the two who waited.',
      '"That keeps costs where they are."',
    ])
      expect(falseUnit(unit, guidance()), unit).toBeNull();
  });

  it('a reply with no reading is never touched by it, and the contract never by one', () => {
    expect(falseUnit('The founder has two kilns.', STEP_ONLY)).toBeNull();
    expect([contractApplies(guidance()), wholeApplies(guidance())]).toEqual([false, true]);
    expect([contractApplies(STEP_ONLY), wholeApplies(STEP_ONLY)]).toEqual([true, false]);
    const said = "I'm completely overwhelmed and exhausted, what comes first";
    expect(contractApplies(STEP_ONLY, said)).toBe(false);
    expect(
      checkReplyContract({ reply: 'One.', guidance: guidance(), channel: 'text', today: TODAY }).findings,
    ).toEqual([]);
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
    expect(falseUnit(unit, guidance()) === 'works').toBe(is);
  });
  it('the prompt of a read message names nothing that could be told', () => {
    const out = renderGuidance(
      guidance({ opened: 'sum' }, { lead: { text: 'You keep $9.', voice: 'You keep $9.' } }),
      'text',
      { today: TODAY },
    );
    expect(out).not.toMatch(/Your reply already opens|the opening did not|The program's method|<opens>/);
    expect(out).toContain('<you_said>You keep $9.</you_said>');
  });
});

describe('beside a figure, a claim, a verdict', () => {
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
    ['If you fire it twice, the loss will get bigger.', gain, true],
    ['If two of them stopped, the loss would be $12.', gain, false],
    ['If you fire it twice, the loss will get bigger.', loss, false],
    ['You make money on it.', loss, true],
    ['You lose money on each firing.', loss, false],
    ['The wire costs $20.', gain, false],
    ['You still lose money overall.', [], false],
  ])('%s', (unit, figures, against) => {
    expect(againstFigure(unit, figures)).toBe(against);
    if (against) expect(falseUnit(unit, guidance({ figures }))).toBe('against_figure');
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

  it('what a person decides is not picked', () => {
    const held = guidance(
      { opened: 'held', referral: 'equity', heldOptions: ['60/40', '50/50'] },
      {
        referral: {
          who: 'A business lawyer; ask the program lead',
          bring: 'Both sheets and anything promised',
        },
      },
    );
    expect(falseUnit('My pick: 60/40.', held)).toBe('rules');
    expect(falseUnit('60/40 fits, since you built the kiln.', held)).toBe('rules');
    expect(falseUnit('Your work is the main value here.', held)).toBe('rules');
    expect(falseUnit('Write down the hours each of you put in since May.', held)).toBeNull();
  });
});

describe('what ends a reply', () => {
  const reply = 'Two of your 14 students waited for the kiln last month, so one kiln is enough for now.';
  const ends = (question: string, g: PromptGuidance): string =>
    checkReplyContract({ reply: `${reply} ${question}`, guidance: g, channel: 'text', today: TODAY })
      .repaired ?? '';

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
