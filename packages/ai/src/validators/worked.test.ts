import { describe, expect, it } from 'vitest';

import type { PromptGuidance } from '../prompts/guidance.js';
import { STEP, STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { buildSupportIndex } from './citation-support.js';
import { validateCoachResponse } from './coach-response.js';
import { stepLine } from './reply-contract.js';
import { SentenceGate } from './sentence-gate.js';
import { operandsIn, workedFrom, workedShape } from './worked.js';

const FALLBACK = 'Here is how the step goes.';

/** A reply to a sum code could not read one way, as it streams (no reading of the message). */
function shown(messages: readonly string[], reply: string, record = '', asksSum = true): string {
  const said = [...messages, record].join('\n');
  const guidance: PromptGuidance = {
    ...STEP_ONLY,
    firstTime: false,
    brief: record,
    said,
    ...(asksSum ? { asksSum: true } : {}),
    fallback: { text: FALLBACK, voice: FALLBACK },
  };
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: messages.at(-1) ?? '',
    guidance,
    today: TODAY,
    callerContinues: true,
    knownFigures: said,
    support: buildSupportIndex({ evidence: [], founderText: said, guidanceText: record }),
  });
  const text = [...gate.push(reply).units, ...gate.end().units].map((u) => u.text).join('');
  // What was streamed is what is stored.
  const kept = validateCoachResponse(
    {
      mode: 'coach',
      answer: text,
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
      allowedModes: ['coach'],
      fallbackMode: 'coach',
      evidenceKeys: new Set<string>(),
      personaName: 'Thomas',
      mentor: true,
      otherVentureNames: [],
      otherVentureCanaries: [],
      preRisk: { categories: [], crisis: false, injection: false } as never,
      founderText: messages.at(-1) ?? '',
      guidance,
      today: TODAY,
      knownFigures: said,
      support: buildSupportIndex({ evidence: [], founderText: said, guidanceText: record }),
      released: true,
    } as never,
  ).response.answer;
  expect(kept).toBe(text);
  return text.replace(stepLine(STEP, 'text', TODAY), '').trim();
}

const OFFER = ['an uncle of mine offered 90k for 15%', 'which number would that make the business'];
const STORE = [
  'if 50k listeners each paid 3.99 and the platform held back 20 percent, what would I end up with',
];
const GRANT = [
  'the contest pays at most 220k and our host adds 45% to what we spend ourselves. how much can we spend?',
];
const STALL = ['once the room is paid, 60, and the cups too: what did last night leave me?'];
const STALL_RECORD =
  'You sell a cup at $9. One cup costs $2.80 for tea and $0.45 for the cup. Last night you sold 44 cups.';

describe('a sum they asked for keeps its figure (no reading of the message)', () => {
  it.each([
    [OFFER, "That's 90k divided by 15%, which is $600,000.", '$600,000'],
    [OFFER, "That's 90k divided by 15%, so [[90k / 15%]].", '90,000 / 15% = 600,000'],
    [OFFER, "That's 90k divided by 15%, which is [[$90,000 / 15 percent]].", '90,000 / 15% = $600,000'],
    [OFFER, "That's 90k divided by 15%, or $0.6 million.", '$0.6 million'],
    [
      STORE,
      'Your math: 50,000 users at $3.99 each is $199,500. The store takes 20%, which is $39,900, so you keep $159,600.',
      '$159,600',
    ],
    [
      STORE,
      '50,000 people at $3.99 is $199,500. After the store takes 20%, $159,600 reaches your account.',
      '$159,600',
    ],
    [GRANT, 'The work money is [[220000 / 1.45 dollars]].', '$151,724.14'],
    [GRANT, 'The work money is [[220000 / (1 + 45%) dollars]].', '$151,724.14'],
    [GRANT, 'The work money is $220,000 / 1.45 = $151,724.', '$151,724'],
  ] as const)('%j: %s', (messages, reply, figure) => {
    const text = shown(messages, reply);
    expect(text).toContain(figure);
    // The figure is the whole answer: nothing of the step stands in its place.
    expect(text).not.toContain(FALLBACK);
    // Nor where no rule saw that a sum is asked for.
    const unseen = shown(messages, reply, '', false);
    expect(unseen).toContain(figure);
    expect(unseen).not.toContain(FALLBACK);
  });

  it.each([
    'From 44 cups at $9 each, you made $396. Tea and cups cost $143, and the room took $60. That leaves $193 in your pocket.',
    '44 cups at $9 is $396. Minus $143 for tea and cups and $60 for the room, you keep $193.',
    'You made $396, spent $143 on tea and cups and $60 on the room, so $193 is yours.',
    'Each cup leaves $5.75, so 44 cups leave $253, and after the $60 room you keep $193.',
    'Your pocket: [[44 * 9 - 44 * 3.25 - 60 dollars]].',
  ])('%s', (reply) => {
    const text = shown(STALL, reply, STALL_RECORD);
    expect(text).toContain('193');
    expect(text).not.toContain(FALLBACK);
  });

  it('a figure nothing given comes to still goes', () => {
    expect(shown(OFFER, 'He says the whole company is worth $750,000.')).not.toContain('750,000');
    expect(
      shown(STALL, 'You made $396 and spent $143, so $211 is yours after the room.', STALL_RECORD),
    ).not.toContain('211');
    // With no sum asked for, the shape of one is no licence.
    expect(
      shown(['how do I price it'], 'Offer it at $37.35 to the next ten.', STALL_RECORD, false),
    ).not.toContain('37.35');
  });
});

describe('worked out from what is shown', () => {
  it('a share of an amount, an amount over a share, three numbers in a row', () => {
    expect(workedFrom(39_900, operandsIn('$199,500 and 20%'))).toBe(true);
    expect(workedFrom(600_000, operandsIn('90k and 15%'))).toBe(true);
    expect(workedFrom(193, operandsIn('$396, $143 and $60'))).toBe(true);
    expect(workedFrom(195, operandsIn('$396, $143 and $60'))).toBe(false);
    // Small round numbers come from two steps by chance.
    expect(workedFrom(8, operandsIn('9, 85 and 22'))).toBe(false);
  });

  it('the shapes of a sum of theirs, and nothing near them', () => {
    const given = [9, 2.8, 0.45, 44, 60];
    expect(workedShape(143, given)).toBe(true);
    expect(workedShape(5.75, given)).toBe(true);
    expect(workedShape(253, given)).toBe(true);
    expect(workedShape(146.5, given)).toBe(false);
  });
});
