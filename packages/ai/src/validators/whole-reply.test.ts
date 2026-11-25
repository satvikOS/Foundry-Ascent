import { describe, expect, it } from 'vitest';

import { renderGuidance, type PromptGuidance } from '../prompts/guidance.js';
import { STEP_ONLY, TODAY } from '../testing/path-fixtures.js';
import { buildSupportIndex } from './citation-support.js';
import { validateCoachResponse } from './coach-response.js';
import { checkStep, readNext, splitNext, withFitted } from './fitted-step.js';
import { SentenceGate } from './sentence-gate.js';
import { isWholeReply, missingOf, repairBrief } from './whole-reply.js';

/** A potter with one rented kiln, whose message was read: the writer writes the whole reply and its step. */

type Reading = NonNullable<PromptGuidance['reading']>;
const SAID =
  'I rent one kiln at $40 a week. 14 students used it in October and 2 of them waited a day. I have 4 hours a week. Should I rent a second one?';
const FIT: NonNullable<PromptGuidance['fit']> = {
  title: 'Ask 20 people to pay and count who does',
  parts: ['Write the offer with its price', 'Ask 20 people', 'Count who pays'],
  doneWhen: '20 people were asked, and the number who paid is next to the pass line',
  trap: 'Counting friends',
  way: 'Ask the two who waited what a day of waiting cost them',
  open: { title: 'List 12 studios in town', doneWhen: 'The 12 are on one page', dueOn: '2026-11-28' },
  hours: null,
  dueOn: '2026-12-02',
};
const guidance = (over: Partial<Reading> = {}, more: Partial<PromptGuidance> = {}): PromptGuidance => ({
  ...STEP_ONLY,
  firstTime: false,
  said: SAID,
  reading: {
    kind: 'question',
    ask: 'whether a second kiln pays',
    secondAsk: null,
    points: ['Two of 14 waited, once.', 'A second kiln costs $40 a week more.'],
    record: [],
    avoid: null,
    opened: null,
    referral: null,
    inOrder: false,
    ...over,
  },
  fit: FIT,
  ...more,
});
interface Wrote {
  readonly text: string;
  readonly gate: SentenceGate;
}
function write(
  draft: string,
  g: PromptGuidance = guidance(),
  options: { readonly channel?: 'text' | 'voice'; readonly repairs?: boolean; readonly by?: number } = {},
): Wrote {
  const voice = options.channel === 'voice';
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: SAID,
    guidance: g,
    today: TODAY,
    keepDropped: true,
    knownFigures: SAID,
    support: buildSupportIndex({ evidence: [], founderText: SAID, guidanceText: FIT.title }),
    ...(options.repairs === true ? { repairs: true } : {}),
    ...(voice ? { spoken: true, spokenWordBudget: 70 } : {}),
  });
  const units = [...gate.open().units];
  const by = options.by ?? draft.length;
  for (let i = 0; i < draft.length; i += by) units.push(...gate.push(draft.slice(i, i + by)).units);
  units.push(...gate.end().units);
  return { gate, text: units.map((u) => (voice ? u.spoken : u.text)).join(voice ? ' ' : '') };
}
const why = (w: Wrote): string[] => w.gate.trace.dropped.map((d) => d.why ?? d.reason);

const GOOD = `Not yet: 2 of 14 waited one day, so one kiln still holds. What you do not know is what that day cost them.

If 3 of the next 10 would pay $40 more to skip the wait, rent it; if fewer, book the free days better.
NEXT: Ask the 2 who waited what that day cost them | DONE: Both answered, and you know if 1 of 2 would pay`;

describe('the writer’s whole reply', () => {
  it('stands as it was written, and ends with its own step and code’s day', () => {
    const w = write(GOOD);
    expect(w.text).toBe(
      `Not yet: 2 of 14 waited one day, so one kiln still holds. What you do not know is what that day cost them.

If 3 of the next 10 would pay $40 more to skip the wait, rent it; if fewer, book the free days better.

**Next:** Ask the 2 who waited what that day cost them by Wednesday, December 2. Done when both answered, and you know if 1 of 2 would pay.`,
    );
    expect(w.gate.step?.fitted).toEqual({
      title: 'Ask the 2 who waited what that day cost them',
      doneWhen: 'Both answered, and you know if 1 of 2 would pay',
    });
    expect(why(w)).toEqual([]);
  });

  it.each([1, 3, 7, 50])(
    'whatever the stream is cut into (%d), the step line is never shown as it came',
    (by) => {
      const w = write(GOOD, guidance(), { by, repairs: true });
      expect(w.text).toBe(write(GOOD).text);
      expect(w.text).not.toMatch(/NEXT|DONE|\|/);
    },
  );

  it('what was streamed is what is stored', () => {
    const { text, gate } = write(GOOD);
    const out = validateCoachResponse(
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
        evidenceKeys: new Set<string>(),
        preRisk: { categories: [] },
        otherVentureNames: [],
        otherVentureCanaries: [],
        personaName: 'Thomas',
        mentor: true,
        coverageThreshold: 0.6,
        founderText: SAID,
        guidance: withFitted(guidance(), gate.step?.fitted ?? null),
        today: TODAY,
        knownFigures: SAID,
        released: true,
      },
    );
    expect(out.response.answer).toBe(text);
  });

  it('a sentence goes for what is false, with what goes on from it, and nothing else', () => {
    const w = write(
      `Not yet: 2 of 14 waited, so one kiln holds. The founder has room for two. That means they need one more. Your renters pay $75 a month. Good. Ask both what it cost them.`,
    );
    expect(why(w)).toEqual(expect.arrayContaining(['works', 'leans']));
    expect(w.text).not.toMatch(/founder|one more|\$75/);
    expect(w.text).toMatch(/^Not yet: 2 of 14 waited/);
    expect(w.text).toContain('Ask both what it cost them.');
  });

  it('the same sentence is not said twice, nor a figure the server said', () => {
    const lead = { text: 'You pay $160 a month: 4 × $40.', voice: 'You pay $160 a month.' };
    const w = write(
      'You pay $160 a month: 4 × $40. That is for one kiln, used by 14 students. That is for one kiln, used by 14 students.',
      guidance(
        { kind: 'sum', opened: 'sum', figures: [{ value: 160, unit: '$' }] },
        { lead, calc: [lead.text] },
      ),
    );
    expect(w.text.match(/\$160/g)).toHaveLength(1);
    expect(w.text.match(/used by 14/g)).toHaveLength(1);
    expect(why(w)).toEqual(['said', 'said']);
  });

  it('words asked for are the answer', () => {
    const w = write(
      'Say this: "Two of you waited last month. What did that day cost you?"\nNEXT: same',
      guidance({ kind: 'draft', words: true }),
      { repairs: true },
    );
    expect(w.text).toContain('"Two of you waited last month. What did that day cost you?"');
    expect(w.gate.repair).toBeNull();
    expect(w.text).toMatch(/\*\*Next:\*\* List 12 studios in town by /);
  });

  it('on a call the step line is waited for, past what can be said', () => {
    const long = Array.from({ length: 14 }, (_, i) => `One kiln holds for week ${String(i + 1)} too.`).join(
      ' ',
    );
    const w = write(
      `Not yet: 2 of 14 waited. ${long}\nNEXT: Ask the 2 who waited what it cost them | DONE: Both answered`,
      guidance(),
      {
        channel: 'voice',
        by: 20,
      },
    );
    expect(w.text).toMatch(
      /Your next step: ask the 2 who waited what it cost them by [A-Z]\w+day, December 2\.$/,
    );
    expect(w.text.split(' ').length).toBeLessThan(90);
  });
});

describe('a reply that is none', () => {
  it('is kept back, with what was cut, and completed from its claims when nothing better comes', () => {
    const w = write('The founder has two kilns. Good.', guidance(), { repairs: true });
    expect(w.text).toBe('');
    expect(w.gate.repair).toEqual([{ text: 'The founder has two kilns.', why: 'works' }]);
    expect(repairBrief('The founder has two kilns. Good.', w.gate.repair ?? [])).toMatch(
      /"The founder has two kilns\.": it speaks of how the reply was prepared\n/,
    );
    const rest = w.gate
      .settle()
      .units.map((u) => u.text)
      .join('');
    expect(rest).toContain('List 20 office managers');
    expect(w.gate.repair).toBeNull();
  });

  it('two sentences of a typed reply are one; a figure, a call and words asked for need fewer', () => {
    expect(isWholeReply('Not yet: 2 of 14 waited.', guidance(), 'text')).toBe(false);
    expect(isWholeReply('Not yet: 2 of 14 waited. Ask both what it cost.', guidance(), 'text')).toBe(true);
    expect(isWholeReply('Not yet: 2 of 14 waited.', guidance(), 'voice')).toBe(true);
    expect(isWholeReply('Not yet: 2 of 14 waited.', guidance({ words: true }), 'text')).toBe(true);
    expect(isWholeReply('', guidance({ opened: 'sum' }), 'text')).toBe(true);
  });

  it('nothing is shown before two sentences stand, and all of it then', () => {
    const gate = write('', guidance(), { repairs: true }).gate;
    expect(gate.repair).toEqual([]);
    const streamed = new SentenceGate({
      personaName: 'Thomas',
      otherVentureNames: [],
      otherVentureCanaries: [],
      founderText: SAID,
      guidance: guidance(),
      today: TODAY,
      repairs: true,
    });
    expect(streamed.push('Not yet: 2 of 14 waited one day. ').units).toEqual([]);
    expect(
      streamed
        .push('Ask both what it cost them today. And then ')
        .units.map((u) => u.text)
        .join(''),
    ).toContain('Not yet: 2 of 14 waited one day.');
  });
});

describe('what is missing is added whole', () => {
  it('what the record denies, when the reply does not name it', () => {
    const g = guidance({
      contradicts: {
        line: 'Two of 14 waited in October.',
        says: 'Your own numbers say otherwise: two of 14 waited.',
      },
    });
    expect(missingOf('Rent it.', g, 'text')).toEqual(['Your own numbers say otherwise: two of 14 waited.']);
    expect(missingOf('Two of your 14 waited in October, so no.', g, 'text')).toEqual([]);
  });
  it('who decides, and what to bring', () => {
    const g = guidance(
      { referral: 'legal' },
      {
        referral: { who: 'A business lawyer', bring: 'The lease and what was promised', before: 'you sign' },
      },
    );
    expect(missingOf('Read it twice.', g, 'text')).toEqual([
      'Talk to a business lawyer before you sign. Bring them the lease and what was promised.',
    ]);
  });
});

describe('the fitted step', () => {
  const step = (line: string, g = guidance(), founderText = SAID) =>
    checkStep(line, g, { founderText, known: SAID });

  it('is read in its form, however it is marked up', () => {
    expect(splitNext('One. NEXT: Ask two | DONE: both').body).toBe('One. ');
    expect(readNext('**NEXT:** Ask the 2 who waited | **DONE:** when both answered.')).toEqual({
      title: 'Ask the 2 who waited',
      doneWhen: 'Both answered',
    });
    expect(readNext('NEXT: same')).toBe('same');
    expect(readNext('NEXT: Ask the 2 who waited')).toBeNull();
  });

  it.each([
    ['', 'missing'],
    ['NEXT: Ask the 2 who waited', 'form'],
    ['NEXT: You should ask the 2 who waited | DONE: both answered', 'verb'],
    ['NEXT: Consider asking the 2 who waited | DONE: both answered', 'verb'],
    ['NEXT: Asking the 2 who waited | DONE: both answered', 'verb'],
    ['NEXT: Ask the 2 who waited, then rent a kiln | DONE: both answered', 'two'],
    ['NEXT: Ask the 2 who waited. Rent a kiln | DONE: both answered', 'two'],
    ['NEXT: Ask the 2 who waited on Friday what it cost | DONE: both answered', 'date'],
    ['NEXT: Offer 10 renters a key at $75 a month | DONE: 3 of 10 paid', 'figure'],
    ['NEXT: Ask 60 renters what they would change | DONE: 60 answered', 'figure'],
    ['NEXT: Ask Maribel at the studio for a key | DONE: she answered', 'name'],
    ['NEXT: Sign the lease for the second kiln | DONE: it is signed', 'person'],
    [`NEXT: ${'Ask the 2 who waited what it cost them and why '.repeat(4)} | DONE: both answered`, 'long'],
  ] as const)('%s: %s', (line, reason) => {
    const g =
      reason === 'person'
        ? guidance({}, { referral: { who: 'A business lawyer', bring: 'The lease' } })
        : guidance();
    expect(step(line, g)).toEqual({ fitted: null, reason });
  });

  it('a day at its end is code’s to give, one they named stays', () => {
    expect(
      step('NEXT: Ask the 2 who waited what it cost by Friday | DONE: both answered by Friday').fitted,
    ).toEqual({
      title: 'Ask the 2 who waited what it cost',
      doneWhen: 'Both answered',
    });
    const named = 'On Saturday I see both of them, with which questions?';
    expect(
      step('NEXT: Ask both on Saturday morning what it cost them | DONE: both answered', guidance(), named)
        .reason,
    ).toBeNull();
  });

  it('a count may be new up to the method’s own, and within their hours', () => {
    expect(step('NEXT: Ask 20 renters to pay $40 for a key | DONE: 5 of 20 paid').reason).toBeNull();
    const short = guidance({}, { fit: { ...FIT, hours: 2 } });
    expect(step('NEXT: Ask 20 renters to pay $40 for a key | DONE: 5 of 20 paid', short).reason).toBe(
      'hours',
    );
    expect(step('NEXT: Ask 10 renters to pay $40 for a key | DONE: 3 of 10 paid', short).reason).toBeNull();
  });

  it('is never what they refused, said is done, or were to avoid', () => {
    expect(
      step(
        'NEXT: Post the key offer on the dorm board | DONE: 3 replies',
        guidance(),
        'Nobody reads the dorm board, I will not post there.',
      ).reason,
    ).toBe('refused');
    expect(step('NEXT: Emailed studios list | DONE: 3 replies', guidance(), 'x').reason).toBe('verb');
    expect(
      step(
        'NEXT: Print new kiln labels | DONE: they hang',
        guidance(),
        'We already printed the new kiln labels.',
      ).reason,
    ).toBe('closed');
    expect(
      step(
        'NEXT: List every studio in the county | DONE: all listed',
        guidance({ avoid: 'Listing every studio in the county' }),
      ).reason,
    ).toBe('refused');
  });

  it('same keeps the open step, and there is none to keep without one', () => {
    expect(step('NEXT: same').fitted).toBe('same');
    expect(step('NEXT: same', guidance({}, { fit: { ...FIT, open: null } })).reason).toBe('form');
    expect(withFitted(guidance(), 'same').step).toMatchObject({
      title: 'List 12 studios in town',
      dueOn: '2026-11-28',
    });
    expect(withFitted(guidance(), null).step).toEqual(guidance().step);
  });

  it('is asked for in one form, with the method, the open step and what they have', () => {
    const out = renderGuidance(guidance({}, { fit: { ...FIT, hours: 4 } }), 'text', { today: TODAY });
    expect(out).toContain('NEXT: <one thing to do');
    expect(out).toContain('NEXT: same');
    expect(out).toContain('They have 4 hours.');
    expect(out).toContain('<method title="Ask 20 people to pay and count who does"');
    expect(out).not.toContain('Never write a next step');
    expect(renderGuidance(guidance({}, { fit: { ...FIT, open: null } }), 'text')).not.toContain('NEXT: same');
  });
});
