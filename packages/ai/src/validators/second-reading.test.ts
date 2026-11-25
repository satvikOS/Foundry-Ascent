import { describe, expect, it } from 'vitest';

import type { PromptGuidance } from '../prompts/guidance.js';
import { IP_REFERRAL, STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { methodUnit } from './method.js';
import { ownFactsUnit } from './own-facts.js';
import { checkReplyContract, composeFromGuidance, withoutLabel } from './reply-contract.js';
import { danglingAsk, readsAgain, refusesUnderLead } from './second-reading.js';
import { SentenceGate } from './sentence-gate.js';
import { stemsOf } from './stems.js';

// Synthetic wording of what a live run let through (2026-11-25).
const LEAD =
  'What they do counts more than what they say: they call the loaf small and buy it again, so the size holds for now. It does not show how many walked past without a word. Count that for one week: who picks one up and who then buys.';
const FOUNDER = 'Neighbours tell me the loaf is small and still they buy it again.';
const NEWS: PromptGuidance = { ...STEP_ONLY, kind: 'news', lead: { text: LEAD, voice: LEAD } };
const again = (unit: string, guidance: PromptGuidance = NEWS): boolean =>
  readsAgain(unit, guidance, stemsOf(guidance.lead?.text ?? ''), stemsOf(FOUNDER));

/** The same reply, streamed through the gate and checked whole. */
function both(reply: string, guidance: PromptGuidance): readonly string[] {
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: FOUNDER,
    guidance,
    today: TODAY,
    callerContinues: true,
  });
  const units = [...gate.open().units];
  for (const c of reply.match(/[\s\S]{1,9}/g) ?? []) units.push(...gate.push(c).units);
  units.push(...gate.end().units);
  const lead = guidance.lead?.text ?? '';
  const text = lead === '' ? reply : `${lead}\n\n${reply}`;
  const checked = checkReplyContract({
    reply: text,
    guidance,
    channel: 'text',
    today: TODAY,
    founderText: FOUNDER,
  });
  return [units.map((u) => u.text).join(''), checked.repaired ?? text];
}

describe('a second reading under the server’s', () => {
  it.each([
    'What those neighbours show is that the loaf still sells.',
    "What they don't show yet is whether strangers would pay for it.",
    "This doesn't prove the size is perfect yet.",
    'If they call it small but still buy, it shows the size might be okay for now, but some are hesitating.',
    "You'll need to watch how many people walk past without buying to see if the size holds them back.",
  ])('%s', (unit) => {
    expect(again(unit)).toBe(true);
  });

  it.each([
    'Put a tally sheet beside the till and ask a friend to mark each stop.',
    'Three of the twelve came back on Tuesday.',
    'Would you bake a bigger one?',
    '- Count who picks one up and who buys.',
  ])('what says something of its own stands: %s', (unit) => {
    expect(again(unit)).toBe(false);
  });

  it('stands where the server read nothing: a lead that shows no result, or none', () => {
    const unit = "What they don't show yet is whether strangers would pay for it.";
    expect(readsAgain(unit, NEWS, new Set(), stemsOf(FOUNDER))).toBe(false);
    expect(again(unit, { ...NEWS, kind: 'coaching' })).toBe(false);
    const bare = { text: 'Two of four paid.', voice: 'Two of four paid.' };
    expect(again(unit, { ...NEWS, lead: bare })).toBe(false);
    // What came of it, read for them on another kind of turn.
    expect(again(unit, { ...NEWS, kind: 'coaching', finding: 'they call it small and buy it' })).toBe(true);
  });

  it('goes, streamed and whole, and what it says of its own stays', () => {
    for (const shown of both(
      "What those neighbours mean is that the loaf still sells. This doesn't prove the size is perfect yet.\n\nPut a tally sheet beside the till this Saturday and mark each stop.",
      NEWS,
    )) {
      expect(shown).not.toMatch(/What those neighbours|doesn['’]t prove/);
      expect(shown).toContain('Put a tally sheet beside the till');
      expect(shown.match(/walked past without a word/g)).toHaveLength(1);
    }
  });

  it('under a sum, what its figures mean again', () => {
    const sum = '40 loaves x $3 left per loaf = $120 before other costs.';
    const SUM: PromptGuidance = { ...STEP_ONLY, lead: { text: sum, voice: sum }, calc: [sum] };
    expect(again('Your $3 left per loaf means each loaf adds $3 before costs.', SUM)).toBe(true);
    expect(again('This shows what is left, but rent still comes off that $120.', SUM)).toBe(true);
    // A figure of its own, or a way on, is no second reading.
    expect(again('That means 80 loaves leave $240.', SUM)).toBe(false);
    expect(again('Write the rent beside it before you bake the next batch.', SUM)).toBe(false);
  });
});

describe('what only the server’s lead may say', () => {
  it('a number refused goes under a lead that gives the way to it, and stands without one', () => {
    const refusal = 'I can’t give a rough estimate because it would be a guess.';
    expect(refusesUnderLead(refusal, stemsOf(LEAD))).toBe(true);
    expect(refusesUnderLead(refusal, new Set())).toBe(false);
    expect(refusesUnderLead('You can give a rough estimate of it.', stemsOf(LEAD))).toBe(false);
    for (const shown of both(`${refusal} Put a tally sheet beside the till.`, {
      ...STEP_ONLY,
      lead: { text: LEAD, voice: LEAD },
    }))
      expect(shown).not.toContain('rough estimate');
  });

  it('a question of something nobody told of is not asked', () => {
    expect(danglingAsk('What was hard about it?', STEP_ONLY)).toBe(true);
    expect(danglingAsk('What was the hardest part of it?', NEWS)).toBe(true);
    expect(danglingAsk('What was hard about it?', { ...STEP_ONLY, kind: 'report' })).toBe(false);
    expect(danglingAsk('What was hard about the ward round?', STEP_ONLY)).toBe(false);
    for (const shown of both(
      'Use what the bakers told you to shape the questions you put to the parents on the square this week.\n\nWhat was hard about it?',
      STEP_ONLY,
    ))
      expect(shown).not.toContain('What was hard');
  });
});

describe('their own message', () => {
  it('is not said back to them as it is', () => {
    for (const shown of both(
      `${FOUNDER}\n\nPut a tally sheet beside the till this Saturday and mark each stop.`,
      NEWS,
    )) {
      expect(shown).not.toContain(FOUNDER);
      expect(shown).toContain('Put a tally sheet');
    }
  });
});

describe('our words, labels and empty plans', () => {
  it.each([
    ['The program’s playbook says to count three numbers with sources.', 'Count three numbers with sources.'],
    ['The programme playbook suggests that you ask five of them.', 'You ask five of them.'],
    ['According to the program’s playbook, start with ten people.', 'Start with ten people.'],
  ])('%s', (unit, said) => {
    expect(
      ownFactsUnit(unit, { ...STEP_ONLY, said: 'three numbers, five, ten people' }, { known: '' }).text,
    ).toBe(said);
  });

  it('a sum needs no name', () => {
    expect(withoutLabel('Your math: 40 x $3 = $120.')).toBe('40 x $3 = $120.');
    expect(withoutLabel('**Your math:** forty loaves leave $120.')).toBe('Forty loaves leave $120.');
    expect(withoutLabel('Your math class: use it.')).toBe('Your math class: use it.');
  });

  it('a plan with nobody and no day in it goes; a no to one price proves nothing of the other', () => {
    const vague =
      "You'll need to document the trial results and discuss next steps with the engineer to decide on the funding.";
    expect(methodUnit(vague, {}).text).toBe('');
    const dated = 'Meet the engineer on Friday and discuss next steps: the 2 bridges and who pays.';
    expect(methodUnit(dated, {}).text).toBe(dated);
    expect(methodUnit("If they don't, you'll know $25 was the right price.", {}).text).toBe('');
    expect(methodUnit('If they do not, ask them what stopped them.', {}).text).not.toBe('');
  });
});

describe('who decides, as a person says it', () => {
  const says = (who: string, before?: string): string =>
    composeFromGuidance(
      {
        ...IP_REFERRAL,
        ask: null,
        referral: { who, bring: 'The sheet, and any draft.', ...(before === undefined ? {} : { before }) },
      },
      'text',
      TODAY,
    );
  it('who to talk to, before what, how to reach them, and what to bring', () => {
    expect(says('A business lawyer; ask the program lead for a referral', 'you sign anything')).toContain(
      'Talk to a business lawyer before you sign anything. Ask the program lead for a referral. Bring them the sheet, and any draft.',
    );
    expect(says('A startup lawyer who handles shares, before you talk terms; start with your EIR')).toContain(
      'Talk to a startup lawyer who handles shares before you talk terms. Start with your EIR. Bring them the sheet',
    );
    expect(says('Harbor Ventures, the transfer office', 'you show it')).toContain(
      'Talk to Harbor Ventures, the transfer office, before you show it.',
    );
    expect(says('The program lead')).toContain('Talk to the program lead before you decide.');
  });
});
