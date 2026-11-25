import { describe, expect, it } from 'vitest';

import { READING_EXAMPLE, type PromptGuidance } from '../prompts/guidance.js';
import { REHEARSAL, SOCIAL, STEP, STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { validateCoachResponse } from './coach-response.js';
import {
  ALSO_CONTRADICTS,
  ALSO_FOLLOWS,
  CONTRADICTS,
  FOLLOWS,
  HYPOTHETICAL,
} from './method-sentences.fixture.js';
import { TO_FILL, methodText, methodUnit, type MethodFinding } from './method.js';
import { stepLine } from './reply-contract.js';
import { SentenceGate } from './sentence-gate.js';

const emptyResponse = {
  mode: 'coach',
  claims: [],
  uncertainty: [],
  challenge: null,
  next_actions: [],
  escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
  memory_candidates: [],
  follow_up_questions: [],
  rehearsal: null,
  spoken: null,
};

const positives = Object.entries(CONTRADICTS).flatMap(([finding, all]) =>
  all.map((s) => [finding as MethodFinding, s] as const),
);

describe('the method lint', () => {
  it('holds enough sentences on both sides', () => {
    expect(positives.length + HYPOTHETICAL.length).toBeGreaterThanOrEqual(150);
    expect(FOLLOWS.length).toBeGreaterThanOrEqual(150);
    expect(new Set(FOLLOWS).size).toBe(FOLLOWS.length);
  });

  it.each(positives)('%s: %s', (_finding, sentence) => {
    const read = methodUnit(sentence);
    expect(read.findings.length).toBeGreaterThan(0);
    expect(read.text).not.toContain(sentence);
  });

  it.each(HYPOTHETICAL)('%j %j -> %j', (before, unit, becomes) => {
    const read = methodUnit(unit, { before });
    expect(read).toEqual({ text: becomes, findings: ['hypothetical_question'] });
    // What it becomes is the method's own: read again, it stays.
    expect(methodUnit(becomes, { before }).findings).toEqual([]);
  });

  it.each(ALSO_CONTRADICTS)('goes: %s', (sentence) => {
    expect(methodUnit(sentence).text).not.toContain(sentence);
  });

  it.each([...FOLLOWS, ...ALSO_FOLLOWS])('stays: %s', (sentence) => {
    expect(methodUnit(sentence)).toEqual({ text: sentence, findings: [] });
  });
});

describe('a whole text, and the sentence it is read in', () => {
  it('keeps what a mixed sentence says of its own', () => {
    expect(methodUnit('That’s a solid start, but none of the twelve paid anything.').text).toBe(
      'None of the twelve paid anything.',
    );
    expect(methodUnit('Great news: two of the six paid thirty dollars.').text).toBe(
      'Two of the six paid thirty dollars.',
    );
    expect(methodUnit('It tells us people care, but it does not show they would pay.').findings).toEqual([]);
  });

  it('reads a count of payments as they told it', () => {
    const claim = 'That shows real demand for the box.';
    expect(methodUnit(claim, { founderText: 'Two people paid.' }).findings).toEqual(['over_claim']);
    expect(methodUnit(claim, { founderText: '40 of the 60 paid last week.' }).findings).toEqual([]);
    expect(methodUnit(claim, { founderText: 'forty of them signed up' }).findings).toEqual(['over_claim']);
    expect(methodUnit(claim, { founderText: 'It costs $40 and nobody paid.' }).findings).toEqual([
      'over_claim',
    ]);
  });

  it('leaves an empty bracket out, and gives a template’s line one plain blank', () => {
    expect(methodUnit('Pains: [ ], [ ], [ ]').text).toBe(`Pains: ${TO_FILL}`);
    expect(methodUnit('- **Gains**: [ ], [ ] and [...]').text).toBe(`- **Gains**: ${TO_FILL}`);
    expect(methodUnit('Your offer saves them [ ] hours a week.').text).toBe('');
    expect(methodUnit(`Pains: ${TO_FILL}`).findings).toEqual([]);
    expect(methodUnit('Who: [one type of person]').findings).toEqual([]);
  });

  it('never asks what they just told', () => {
    for (const [founderText, question] of [
      ['I asked 14 club captains and three paid.', 'How many club captains did you ask?'],
      ['She says the marina has a booking system already.', 'What did she say about the marina system?'],
      ['They stopped because the season ended.', 'Why did they stop?'],
    ] as const) {
      expect(methodUnit(question, { founderText }), question).toEqual({
        text: '',
        findings: ['answered_question'],
      });
    }
    for (const [founderText, question] of [
      ['I asked some club captains.', 'How many club captains did you ask?'],
      ['The harbor master turned us down.', 'What did the harbor master say about the price?'],
      ['They stopped.', 'Why did they stop?'],
      ['Three captains paid.', 'Which of the three came back?'],
    ] as const) {
      expect(methodUnit(question, { founderText }).findings, question).toEqual([]);
    }
  });

  it('reads a reply unit by unit, keeps its paragraphs and what is protected, and is idempotent', () => {
    const reply = [
      'Twelve sign-ups from 300 views shows real interest.',
      ' It does not show anyone would pay.',
      '\n\nAsk them two things:\n1. How much would you pay for it?\n2. Would you pay monthly?',
      '\n\nA spoken yes is not a sale.',
      '\n\nLet’s keep moving forward.',
    ].join('');
    const read = methodText(reply);
    expect(read.text).toBe(
      'It does not show anyone would pay.\n\nAsk them two things:\n1. What did you spend on this last time, in money or hours?\n2. What have you paid for to deal with this so far?\n\nA spoken yes is not a sale.',
    );
    expect(methodText(read.text)).toEqual({ text: read.text, findings: [] });
    expect(methodText('Great job!', { protect: () => true }).findings).toEqual([]);
  });

  it('leaves out the prompt’s own example when it comes back word for word', () => {
    for (const s of READING_EXAMPLE.match(/[^.]+\./g) ?? []) expect(methodUnit(s.trim()).text).toBe('');
  });
});

describe('where the lint runs', () => {
  const NEWS: PromptGuidance = {
    ...STEP_ONLY,
    kind: 'news',
    lead: {
      text: '12 of 300 (4%) raised a hand, and none of that is money yet.',
      voice: '12 raised a hand.',
    },
    fallback: { text: 'You told me this: twelve left an address.', voice: 'One fact.' },
    said: '300 people saw the page and 12 left an address.',
  };
  const OPTIONS = {
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: 'I put up a page. 300 people saw it and 12 left an address.',
    today: TODAY,
  } as const;
  const gated = (text: string, guidance: PromptGuidance | null, spoken = false): string => {
    const gate = new SentenceGate({ ...OPTIONS, guidance, spoken });
    const units = [...gate.open().units];
    for (const c of text.match(/[\s\S]{1,9}/g) ?? []) units.push(...gate.push(c).units);
    units.push(...gate.end().units);
    return units.map((u) => u.text).join('');
  };
  const whole = (answer: string, guidance: PromptGuidance, released = false): string =>
    validateCoachResponse(
      { ...emptyResponse, answer },
      {
        ...OPTIONS,
        guidance,
        released,
        evidenceKeys: new Set(),
        preRisk: { categories: [] },
        coverageThreshold: 0.6,
        expectedMode: 'coach',
      },
    ).response.answer;
  const REPLY =
    'A dozen addresses shows real interest. It does not show that one of them would pay, and an address costs nothing.\n\nNext, let’s send a quick survey. Ask them two things:\n1. How much would you pay?\n2. Would you use it?\n\nThis will show us what price works.';

  it('a streamed reply, its whole reply and the released one end the same, with no second plan beside the step', () => {
    const shown = gated(REPLY, NEWS);
    expect(shown).toBe(
      `${NEWS.lead?.text ?? ''}\n\nIt does not show that one of them would pay, and an address costs nothing.\n\n${stepLine(STEP, 'text', TODAY)}`,
    );
    expect(whole(REPLY, NEWS)).toBe(shown);
    expect(whole(shown, NEWS, true)).toBe(shown);
  });

  it('when nothing is left, the server’s own answer stands', () => {
    const { lead: _lead, ...open } = NEWS;
    const shown = gated('Great news! That’s a strong signal. Let’s keep moving forward.', open);
    expect(shown).toBe(`${NEWS.fallback?.text ?? ''}\n\n${stepLine(STEP, 'text', TODAY)}`);
    expect(whole('Great news! That’s a strong signal. Let’s keep moving forward.', open)).toBe(shown);
  });

  it('a social turn, role-play and a turn off the path are as they were', () => {
    const said = 'That is a strong signal, thank you.';
    for (const guidance of [SOCIAL, REHEARSAL, null])
      expect(gated(said, guidance)).toContain('strong signal');
  });

  it('the program’s own answer is never touched, whatever its words', () => {
    const answer =
      'You have a customer segment when ten say they would pay. Two sales prove demand, so run a survey next.';
    const guidance = { ...STEP_ONLY, ask: { title: 'x', answer, why: 'y', traps: [], evidenceKeys: [] } };
    expect(gated(answer, guidance)).toContain(answer);
  });

  it('its own sequence keeps its "Next,", and a second plan goes', () => {
    const first =
      'First, name who decides. Next, ask what they signed last year. Then say your price and stop talking.';
    expect(gated(first, STEP_ONLY)).toContain('Next, ask what they signed last year.');
    expect(
      gated(
        'Sell it by hand to three offices before you write any software.\n\nNext, build a landing page and share it.',
        STEP_ONLY,
      ),
    ).not.toContain('landing page');
  });

  it('a template line of blanks alone gets one blank', () => {
    const guidance: PromptGuidance = {
      ...STEP_ONLY,
      said: 'we park vans',
      step: { ...STEP, template: { title: 'Promise', body: 'Jobs: [ ], [ ]\nPains: [ ], [ ], [ ]' } },
    };
    const out = gated('Write it down by kind.\n\nPains: late trucks, lost keys and wet boxes.', guidance);
    expect(out).toContain(`Pains: ${TO_FILL}`);
    expect(out).not.toContain('[ ]');
  });

  it('under a sum code worked out, a number of the model’s own is a second sum: it goes, in a question too', () => {
    const calc = ['$120 stall / $8 left per poster = 15 posters to pay for it.'];
    const sum: PromptGuidance = {
      ...STEP_ONLY,
      calc,
      lead: { text: calc[0] ?? '', voice: calc[0] ?? '' },
      said: 'A poster sells for 18 dollars, paper is 7 and the tube 3. The stall is 120 dollars.',
    };
    const known = { knownFigures: sum.said ?? '' };
    const say = (text: string): string => {
      const gate = new SentenceGate({
        ...OPTIONS,
        ...known,
        founderText: 'How many posters pay for the stall?',
        guidance: sum,
      });
      const units = [...gate.open().units, ...gate.push(`${text} `).units, ...gate.end().units];
      return units.map((u) => u.text).join('');
    };
    const bare = `${calc[0] ?? ''}\n\n${stepLine(STEP, 'text', TODAY)}`;
    expect(say('At 18 dollars a poster it takes 7 of them to cover it (120 / 18 = 6.67, rounded up).')).toBe(
      bare,
    );
    expect(say('Every poster after that is money you keep, and none of it pays for your hours.')).toContain(
      'your hours',
    );
    expect(say('The stall is paid only if people stop at it. Is 540 dollars enough for you?')).not.toContain(
      '540',
    );
  });

  it('another count of the same whole than the lead gives is not said', () => {
    const counted = {
      ...NEWS,
      lead: {
        text: 'Two of four paid. That is 2 of the 5 commitments from strangers, 3 to go.',
        voice: 'Two paid.',
      },
    };
    expect(gated('You are at 4 of the 5 commitments now, so one to go.', counted)).not.toContain(
      '4 of the 5',
    );
    expect(gated('The other 3 of 5 have to come from people you never met.', counted)).toContain('3 of 5');
  });

  it('never repeats a template or a message the lead already gave, nor their own words back', () => {
    const start = {
      ...STEP_ONLY,
      lead: {
        text: 'Here it is to fill in.\n\n1. Who: [type of person]\n2. Problem: [what goes wrong]',
        voice: 'Start.',
      },
    };
    const again = gated(
      'Fill in what you saw yourself before anything you only guess about them.\n\n1. Who: beginners\n2. Problem: they stop',
      start,
    );
    expect(again.match(/Who:/g)).toHaveLength(1);
    expect(again).toContain('Fill in what you saw yourself');
    const sent = {
      ...STEP_ONLY,
      lead: {
        text: 'Here is the message. Put in what is true:\n\n"Hi [name], could I ask you?"',
        voice: 'Keep it short.',
      },
    };
    const draft = gated(
      'Send it to one person first. Here’s a short email you can send:\n\nHi [Name],\n\nI saw that your club lends boats.\n\nThanks,\nAna',
      sent,
    );
    expect(draft).toContain('Send it to one person first.');
    expect(draft).not.toContain('I saw that');
    const told = {
      ...NEWS,
      lead: { text: 'The no comes with its reason: they have an app.', voice: 'A no.' },
    };
    const gate = new SentenceGate({
      ...OPTIONS,
      founderText: 'The league turned it down. He says the league already has an app.',
      guidance: told,
    });
    const units = [
      ...gate.open().units,
      ...gate.push(
        'The league already has an app, he said, which makes sense. Find one club where it fails today. ',
      ).units,
      ...gate.end().units,
    ];
    expect(units.map((u) => u.text).join('')).not.toContain('makes sense');
    expect(units.map((u) => u.text).join('')).toContain('Find one club');
  });

  it('a question that hands their own question back is not asked', () => {
    const founderText = 'How many of the trial riders came back in spring?';
    expect(methodUnit('How many trial riders do you think came back in spring?', { founderText }).text).toBe(
      '',
    );
    expect(methodUnit('Who rode in the snow?', { founderText }).findings).toEqual([]);
  });
});
