import { describe, expect, it } from 'vitest';

import { STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { buildSupportIndex } from './citation-support.js';
import { heldStyle } from './model-style.js';
import { SentenceGate } from './sentence-gate.js';

/** What a writer adds in its own manner, held the same whichever model writes. A lab-kit venture of an invented student. */

const SAID = 'Two labs pay $40 a month each. How do I get a third lab to sign? I have 6 hours this week.';
const ctx = { quoted: false, founderText: SAID, founderName: 'Priya', known: SAID };

function write(draft: string): { text: string; dropped: string[] } {
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: SAID,
    founderName: 'Priya',
    guidance: { ...STEP_ONLY, said: SAID },
    today: TODAY,
    keepDropped: true,
    knownFigures: SAID,
    support: buildSupportIndex({
      evidence: [],
      founderText: SAID,
      guidanceText: STEP_ONLY.step?.title ?? '',
    }),
  });
  const units = [...gate.open().units, ...gate.push(draft).units, ...gate.end().units];
  return {
    text: units.map((u) => u.text).join(''),
    dropped: gate.trace.dropped.map((d) => d.why ?? d.reason),
  };
}

describe('a stage direction', () => {
  it('is not said', () => {
    expect(heldStyle('*leans back, arms crossed*', ctx).cut).toBe('stage');
    expect(heldStyle('_nods slowly_', ctx).cut).toBe('stage');
    expect(heldStyle('*Two labs* pay already.', ctx).cut).toBeNull();
  });

  it('nor the quotation marks a whole reply came in, as if said aloud', () => {
    const { text } = write(
      '*leans forward*\n\n"A third lab signs when its manager sees the first two use it. Ask one of them to show it on a call this week."',
    );
    expect(text).not.toMatch(/leans forward|^"|"\s*$/u);
    expect(text).toMatch(/^A third lab signs when its manager sees the first two use it\./u);
  });
});

describe('a check of its own beside the step', () => {
  it('is no second done-when', () => {
    expect(heldStyle('You are done when three managers say the same thing.', ctx).text).toBe(
      'It is usually enough when three managers say the same thing.',
    );
  });
});

describe('words to send', () => {
  it('set no day of their own, and the founder introduces themself', () => {
    const quoted = { ...ctx, quoted: true };
    expect(heldStyle('Could you tell me by Friday? I’m Priya, a student.', quoted).text).toBe(
      'Could you tell me by [day]? This is Priya, a student.',
    );
    expect(heldStyle('The point is a deadline ("reply by tomorrow").', ctx).text).toBe(
      'The point is a deadline ("reply by [day]").',
    );
  });

  it('are shown whole or not at all', () => {
    const { text, dropped } = write(
      'Send this to the third lab:\n\n"Hi, two labs pay $40 a month for the kit. A fourth pays [[95 - 40 dollars]] more and loves it. Could we talk for 15 minutes?"\n\nThen wait two days before you write again.',
    );
    expect(text).not.toMatch(/Hi, two labs|Could we talk/u);
    expect(dropped).toContain('quote');
    expect(text).toMatch(/Then wait two days/u);
  });
});

describe('a figure nobody gave', () => {
  it('as an example, or as the value of a sum, goes', () => {
    expect(heldStyle('Example: if a lab costs you $22 to win, two months pay it back.', ctx).cut).toBe(
      'example',
    );
    expect(heldStyle('Labs = 12 on your campus, price = $40.', ctx).cut).toBe('made_up_value');
    expect(heldStyle('Example: two labs at $40 bring $80.', ctx).cut).toBeNull();
  });
});

describe('a thing of theirs said as done', () => {
  it('is said as what may have been', () => {
    expect(heldStyle('Bring any forms you signed and the grants list.', ctx).text).toBe(
      'Bring any forms you may have signed and the grants list.',
    );
    expect(heldStyle('Bring the feedback you got.', ctx).text).toBe('Bring the feedback you got.');
  });
});

describe('an announcement with only a paragraph after it', () => {
  it('goes', () => {
    const { text } = write(
      'Two labs already pay, so a third is close. Here is what to do today:\n\nAsk one of the two to show the kit to a manager they know.',
    );
    expect(text).not.toMatch(/what to do today/u);
    expect(text).toMatch(/Ask one of the two/u);
  });
});

describe('a wait of its own', () => {
  it('is said in days, unless they gave the hours', () => {
    expect(heldStyle('If you hear nothing in 48 hours, write once more.', ctx).text).toBe(
      'If you hear nothing in two days, write once more.',
    );
    expect(heldStyle('Reply within 48 hours.', { ...ctx, founderText: 'they said 48 hours' }).text).toBe(
      'Reply within 48 hours.',
    );
  });

  it('and a draft that opens in a unit and goes on is the founder’s too', () => {
    expect(heldStyle('In the body:\n"Hi Sam,\nI’m Priya, a student. Reply by Friday.', ctx).text).toBe(
      'In the body:\n"Hi Sam,\nThis is Priya, a student. Reply by [day].',
    );
  });
});
