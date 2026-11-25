/**
 * Whole conversations through `decide()` with the real playbook (synthetic ventures and wording): the turn's step is the
 * one the message is about, a smaller step keeps its id, reported work moves the path, the idea and its changes are kept,
 * and who decides is always named.
 */
import { type RiskCategory, type TurnGuidance } from '@foundry/contracts';
import { type pathRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { daySaid } from './dates.js';
import { decide, guidanceOf, type DecideInput, type Decision } from './engine.js';
import { commitmentOf, pivotOf, smallerOf, statedIdea } from './kinds.js';
import { PLAYBOOK } from './playbook/index.js';
import { CLIENT_QUESTIONS, PROTOCOL_ASKS } from './playbook/test-fixtures.js';
import { smallerStep } from './steps.js';
import { fresh, input, memory, NO_READS, storedStep, TODAY, VENTURE_ID } from './testing/inputs.js';
import { TEST_MODEL } from './testing/meaning.js';
import { pathTurn } from './turn.js';

const path = (over: Partial<pathRepo.PathRecord> = {}): pathRepo.PathRecord => ({
  ventureId: VENTURE_ID,
  stage: 'idea',
  intake: null,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 1,
  ...over,
});
const real = (over: Partial<DecideInput> = {}): Partial<DecideInput> =>
  fresh({ playbook: PLAYBOOK, ...over });
const at = (message: string, over: Partial<DecideInput> = {}): Decision => decide(input(message, real(over)));
const guidance = (d: Decision): TurnGuidance | null => guidanceOf(PLAYBOOK, d);
const turnOf = (message: string, over: Partial<DecideInput> = {}) =>
  pathTurn({ ...input(message, real(over)), continuity: {}, earlierMessages: [] });

/** What one turn leaves for the next one of its conversation. */
function next(before: Decision, reads: pathRepo.PathReads = NO_READS): Partial<DecideInput> {
  const kept = before.keeps?.view;
  return {
    started: true,
    previous: guidance(before),
    reads: {
      ...reads,
      path: reads.path ?? path({ stage: before.state.stage }),
      steps: [
        ...reads.steps
          .filter((s) => s.id !== kept?.id)
          .map((s) => (kept?.status === 'now' && s.status === 'now' ? { ...s, status: 'next' as const } : s)),
        ...(kept === undefined
          ? []
          : [storedStep({ ...kept, citations: [], createdAt: `${TODAY}T09:00:00.000Z` })]),
      ],
    },
  };
}

describe('the evaluation’s questions and protocol, as a first message (kept: H)', () => {
  const REFERRED = new Set([
    'grants-angels-vc',
    'investor-meeting',
    'valuation',
    'student-ip',
    'patent-now-or-wait',
    'equity-split',
    'leaving-ain',
    'biotech-path',
  ]);

  it.each(CLIENT_QUESTIONS)('%s -> %s', (ask, playId) => {
    const d = at(ask);
    if (playId === 'after-a-pivot') {
      // What was agreed is recalled from the record, with the path's own step.
      expect([d.kind, d.step?.view.playId, d.offered]).toEqual(['recall', 'idea-on-a-page', false]);
      return;
    }
    expect([d.kind, d.intent, d.play?.id, d.step?.view.playId]).toEqual(['coaching', playId, playId, playId]);
    expect(d.referral !== null, 'referral').toBe(REFERRED.has(playId));
    const g = guidance(d);
    const step = g?.step;
    expect(step?.doneWhen).toBeTruthy();
    expect(step?.dueOn).toMatch(/^2026-1[12]-/);
    expect(step?.items.length).toBeGreaterThanOrEqual(2);
    // An idea-stage criterion's play is the step; another stage's is offered beside the path's own.
    const here = PLAYBOOK.criteria.some(
      (c) => c.stage === 'idea' && (c.playId === playId || d.play?.criteria.includes(c.id)),
    );
    expect([d.offered, g?.pathStep?.playId ?? null]).toEqual(here ? [false, null] : [true, 'idea-on-a-page']);
    // The same step, every time.
    expect(new Set([1, 2, 3].map(() => at(ask).step?.view.id)).size).toBe(1);
  });

  it.each(PROTOCOL_ASKS)('%s -> %s', (ask, playId) => {
    const d = at(ask);
    const overview = playId === 'get-organized' || playId === 'start-from-zero';
    expect([d.intent, d.kind]).toEqual([
      d.overview && d.intent === 'overview' ? 'overview' : playId,
      'coaching',
    ]);
    expect(d.step?.view.playId).toBe(overview ? 'idea-on-a-page' : playId);
    expect(d.overview).toBe(overview);
    expect(d.referral?.category ?? null).toBe(playId === 'student-ip' ? 'ip_licensing' : null);
  });
});

describe('a conversation stays on what it is about', () => {
  it('a follow-up with no ask of its own keeps the step of the turn before; "what next" returns to the path', () => {
    const priced = at('How should I price it?');
    expect([priced.step?.view.playId, priced.offered]).toEqual(['pricing', true]);
    let before = priced;
    for (const message of [
      'ok how do I do that',
      'what do I say to them',
      'can you write it',
      'We make each one for about three dollars in my kitchen.',
    ]) {
      const d = at(message, next(before));
      expect([d.carried, d.step?.view.id, d.offered], message).toEqual([true, priced.step?.view.id, true]);
      expect(d.pathStep?.playId, message).toBe('idea-on-a-page');
      before = d;
    }
    const back = at('So what do I do next?', next(before));
    expect([back.overview, back.step?.view.playId, back.offered]).toEqual([true, 'idea-on-a-page', false]);
  });

  it('"what would I do first for that?" is about that, never the whole path', () => {
    const asked = at('Which marketing channel do I work on first?');
    const d = at('Okay, and what would I do first for that?', next(asked));
    expect([d.overview, d.step?.view.playId]).toEqual([false, 'channel-choice']);
  });

  it('thanks and small talk give no step, and lose none', () => {
    const asked = at('How should I price it?');
    expect(at('thanks!', next(asked)).kind).toBe('social');
    expect(at("What's the weather like where you are?", next(asked)).kind).toBe('social');
  });

  it('taking up the step just given stores it, now, on their day', () => {
    const asked = at('Who should I talk to first, and how do I find ten people to interview?');
    expect(asked.offered).toBe(true);
    const d = at("Got it, I'll do eight of those this week.", next(asked));
    expect(d.kind).toBe('social');
    expect(d.keeps).toMatchObject({
      write: 'insert',
      view: { id: asked.step?.view.id, status: 'now', dueOn: '2026-11-27' },
    });
    expect(at('Thanks, sounds good.', next(asked)).keeps).toBeNull();
  });
});

describe('too big', () => {
  it.each([
    ["That's too much", null, true],
    ['I only have an hour', 60, false],
    ['I have one evening', 120, false],
    ["It's exam week", null, true],
    ['Can you give me something smaller?', null, true],
    ['What can I do in 20 minutes?', 20, false],
    ['I have half an hour tonight', 30, false],
  ])('%s', (message, minutes, strict) => {
    expect(smallerOf(message)).toMatchObject({ minutes, strict });
  });

  it.each([
    'That is too much money',
    'We sell exam review packs',
    'I have two hours of interviews recorded',
    'Delivery takes an hour on weekends',
  ])('%s asks for nothing smaller', (message) => {
    expect(smallerOf(message)).toBeNull();
  });

  it('the same step, its first items that fit, done when they are, due soon', () => {
    const first = at('What should I do next?');
    const d = at("That's too much, I only have half an hour.", next(first));
    expect(d.step?.view).toMatchObject({
      id: first.step?.view.id,
      playId: 'idea-on-a-page',
      dueOn: '2026-11-25',
    });
    expect(d.step?.view.items.map((i) => i.minutes)).toEqual([30]);
    expect(d.step?.view.doneWhen).toBe('This one part is done: write the five lines in plain words.');
    expect(d.keeps?.write).toBe('change');
    expect(turnOf("That's too much, I only have half an hour.", next(first)).prompt.ask?.answer).toContain(
      'Make it smaller: write the five lines in plain words. That is about 30 minutes',
    );
  });

  it('is cut to the minutes they have, never below the first doable part, and left alone when it fits', () => {
    const view = at('What should I do next?').step?.view;
    if (view === undefined) throw new Error('no step');
    const ask = (minutes: number | null, strict = false) =>
      smallerStep(view, { minutes, strict, today: false }, TODAY);
    expect(ask(120)).toBeNull();
    expect(ask(120, true)?.items).toHaveLength(view.items.length - 1);
    expect(ask(40)?.items).toHaveLength(2);
    expect(ask(15)?.items).toMatchObject([
      { do: expect.stringContaining('First 15 minutes of:') as string, minutes: 15 },
    ]);
    expect(ask(null, true)?.items).toHaveLength(1);
    expect(ask(60)?.id).toBe(view.id);
  });

  it('what is done stays ticked, and the small part done brings the rest back', () => {
    const cutRow = storedStep({
      id: at('What should I do next?').step?.view.id ?? '',
      playId: 'idea-on-a-page',
      criterionId: 'idea-one-page',
      title: 'Put the idea on one page',
      items: [{ do: 'Write the five lines in plain words', how: '', minutes: 30, done: false }],
      doneWhen: 'This one part is done: write the five lines in plain words.',
      createdAt: `${TODAY}T08:00:00.000Z`,
    });
    const d = at('Done, I wrote the five lines in plain words this morning.', {
      reads: { ...NO_READS, path: path(), steps: [cutRow] },
    });
    expect(d.completes?.rest?.items.map((i) => i.done)).toEqual([true, false, false, false]);
    expect(d.step?.view).toMatchObject({
      id: cutRow.id,
      doneWhen: expect.stringContaining('Five lines are written') as string,
    });
  });

  it('an offered step is cut too, and stays offered', () => {
    const asked = at('How should I price it?');
    const d = at('I only have an hour.', next(asked));
    expect([d.step?.view.id, d.offered]).toEqual([asked.step?.view.id, true]);
    expect((d.step?.view.items ?? []).reduce((n, i) => n + (i.minutes ?? 0), 0)).toBeLessThanOrEqual(60);
  });
});

describe('reports', () => {
  const told = 'I did eight interviews. Six of them said the problem is the missing microwave, not the food.';

  it('work of a later stage moves the path there, with progress, the finding, and what remains as the step', () => {
    const d = at(told);
    expect([d.kind, d.state.stage]).toEqual(['report', 'discovery']);
    expect(d.step?.view).toMatchObject({
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      title: 'Hold 2 more customer talks',
    });
    expect(d.step?.view.doneWhen).toContain('2 more make 10 in all');
    // The row keeps the play's own words: what remains is worked out when it is shown.
    expect(d.keeps?.view.title).toBe('Write five interview questions and start the talks');
    expect(d.then[0]?.playId).toBe('synthesize-interviews');
    const rows = Object.fromEntries((d.applied?.rows ?? []).map((r) => [r.criterionId, r]));
    expect(rows['discovery-ten-conversations']).toMatchObject({
      status: 'open',
      evidence: `8 of 10: ${told}`,
    });
    expect(rows['idea-one-page']).toMatchObject({ status: 'claimed', evidence: told });
    const { prompt } = turnOf(told);
    // What it shows, by the code: the share, what that means, what it does not show, and how far they are.
    expect(prompt.lead?.text).toBe(
      '6 of 8 (75%) said the problem is the missing microwave, not the food: more than half is a pattern, so it leads now. It shows the problem, not yet that they would pay to have it gone. That is 8 of the 10 customer talks, 2 to go.',
    );
    expect(prompt.brief).toContain(`They reported (8 of 10 done): "${told}"`);
  });

  const eight = {
    ...NO_READS,
    path: path({ stage: 'discovery' }),
    criteria: [
      {
        criterionId: 'discovery-ten-conversations',
        status: 'open' as const,
        evidence: `8 of 10: ${told}`,
        stepId: null,
        sourceSessionId: null,
        updatedAt: '2026-11-20T10:00:00.000Z',
      },
    ],
  };

  it('what is reported next adds up: two more finish it, and the step is the pattern', () => {
    expect(at('What next?', { reads: eight }).step?.view.title).toBe('Hold 2 more customer talks');
    const d = at('I interviewed two more nurses on Monday.', { reads: eight });
    expect(d.applied?.rows).toMatchObject([
      { criterionId: 'discovery-ten-conversations', status: 'claimed' },
    ]);
    expect(d.step?.view.playId).toBe('synthesize-interviews');
    expect(at('I did ten interviews by now.', { reads: eight }).step?.view.playId).toBe(
      'synthesize-interviews',
    );
    // Said again, it is still eight.
    expect(at('As I said, I did eight interviews.', { reads: eight }).applied?.rows[0]?.evidence).toContain(
      '8 of 10',
    );
  });

  it('a plan, a question or a wish is no work done', () => {
    for (const message of [
      'I will interview eight people',
      'Should I have done eight interviews?',
      'If I did eight interviews, would it be enough?',
      'I want to talk to ten people',
    ])
      expect(at(message).applied, message).toBeNull();
  });

  it('counts are theirs: money, days and percentages are none', () => {
    expect(at('I talked to people for 12 days about it.').applied).toBeNull();
    expect(
      at('I ran a price test. 20 jars offered at 6 dollars, 11 sold in one day.').work.map(
        (w) => w.criterion.id,
      ),
    ).toEqual(expect.arrayContaining(['validation-commitment', 'model-price']));
  });

  it('not done: the same step on a day they can make, with the smaller one offered', () => {
    const late = storedStep({
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      title: 'Run a problem interview',
      items: [
        { do: 'Write five questions about the last time', how: '', minutes: 15, done: false },
        { do: 'Hold the talks', how: '', minutes: 90, done: false },
      ],
      dueOn: '2026-11-20',
    });
    const reads = { ...NO_READS, path: path({ stage: 'discovery' as const }), steps: [late] };
    const d = at("I didn't get to it. Midterms ate the week.", { reads });
    expect([d.kind, d.step?.view.id, d.movedTo]).toEqual(['report', late.id, '2026-12-01']);
    expect(d.keeps).toMatchObject({ write: 'change', storedVersion: 1, view: { dueOn: '2026-12-01' } });
    const answer = turnOf("I didn't get to it. Midterms ate the week.", { reads }).prompt.ask?.answer;
    expect(answer).toContain('the step moves to December 1');
    expect(answer).toContain('do one thing only: write five questions about the last time');
  });

  it('an overdue step is never named with a day that has passed; a recall says the day it had', () => {
    const late = storedStep({
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      dueOn: '2026-11-20',
    });
    const reads = { ...NO_READS, path: path({ stage: 'discovery' as const }), steps: [late] };
    const d = at('What should I do next?', { reads });
    expect((d.step?.view.dueOn ?? '') >= TODAY).toBe(true);
    expect(d.checkIn?.overdue).toBe(true);
    // Recalled, it is the same step on a day they can still make, and the day it had is said.
    const recalled = at('What did we decide last time?', { reads });
    expect((recalled.step?.view.dueOn ?? '') >= TODAY).toBe(true);
    expect(recalled.wasDue).toBe('2026-11-20');
  });

  it('what they say they will do is their step, in their words, with the method of its play', () => {
    const d = at("I'll talk to ten teaching assistants by Sunday.");
    expect([d.kind, d.keeps?.write]).toEqual(['report', 'insert']);
    expect(d.step?.view).toMatchObject({
      title: 'Talk to ten teaching assistants',
      origin: 'founder',
      playId: 'interview-script',
      criterionId: 'discovery-ten-conversations',
      dueOn: '2026-11-29',
      status: 'now',
    });
    expect(at("I'll talk to ten teaching assistants by Sunday.").step?.view.id).toBe(d.step?.view.id);
    const done = at(
      'Done. I talked to all ten teaching assistants and four asked when they could start.',
      next(d),
    );
    expect(done.completes?.step.id).toBe(d.step?.view.id);
    expect([done.state.stage, done.step?.view.playId]).toEqual(['discovery', 'synthesize-interviews']);
  });

  it.each([
    ["I'll think about it", null],
    ["If it rains I'll call them", null],
    ['Should I email the clubs by Friday?', null],
    ["I'll email the five clubs by Friday.", ['email the five clubs', '2026-11-27']],
    ["We're going to visit two shops tomorrow", ['visit two shops', '2026-11-25']],
    ['The plan is to ask 5 caterers this week.', ['ask 5 caterers', '2026-11-27']],
  ])('%s', (message, wanted) => {
    const c = commitmentOf(message, TODAY);
    expect(wanted === null ? c : [c?.clause, c?.dueOn]).toEqual(wanted);
  });

  it('days as they are said, from today', () => {
    expect(
      [
        'by Friday',
        'next Tuesday',
        'tomorrow',
        'in three days',
        'by December 3',
        'this weekend',
        'next week',
        'soon',
      ].map((t) => daySaid(t, TODAY)),
    ).toEqual([
      '2026-11-27',
      '2026-12-01',
      '2026-11-25',
      '2026-11-27',
      '2026-12-03',
      '2026-11-29',
      '2026-12-04',
      null,
    ]);
  });
});

describe('the idea, kept in their words', () => {
  it.each([
    [
      "It's called NapNook: an app where students rent quiet chairs between classes.",
      'NapNook: an app where students rent quiet chairs between classes',
    ],
    ['My idea is a van that repairs bikes at the dorm door.', 'a van that repairs bikes at the dorm door'],
    ["We're building a tracker for lab keys that go missing.", 'a tracker for lab keys that go missing'],
    [
      'We sell warm lunches to nursing students on placement.',
      'sell warm lunches to nursing students on placement',
    ],
    ['ReagentLoop tracks bottles in university labs.', 'ReagentLoop tracks bottles in university labs'],
    ['My idea is really good', null],
    ["I'm building a landing page this week", null],
    ['Is my idea a van that repairs bikes?', null],
    ['I want to make a survey for customers', null],
  ])('%s', (message, wanted) => {
    expect(statedIdea(message, 'ReagentLoop')).toBe(wanted);
  });

  it('is kept when the venture has none, and never over one they wrote', () => {
    const message = 'My idea is a van that repairs bikes at the dorm door.';
    expect(at(message).idea).toBe('a van that repairs bikes at the dorm door');
    const intake = {
      idea: 'Bike repair at the dorm',
      customer: '',
      studies: '',
      experience: null,
      hoursPerWeek: null,
      deadline: null,
      doneSoFar: '',
      block: '',
    };
    expect(at(message, { reads: { ...NO_READS, path: path({ intake }) } }).idea).toBeNull();
    expect(turnOf(message).prompt.brief.split('\n')[0]).toBe(
      'Idea, in their words: a van that repairs bikes at the dorm door',
    );
  });

  it('a recall carries the facts: the idea, what was decided, and the open step with its day', () => {
    const intake = {
      idea: 'NapNook, an app that rents quiet chairs to students',
      customer: '',
      studies: '',
      experience: null,
      hoursPerWeek: null,
      deadline: null,
      doneSoFar: '',
      block: '',
    };
    const reads = {
      ...NO_READS,
      path: path({ intake, stage: 'discovery' }),
      steps: [
        storedStep({
          playId: 'interview-script',
          criterionId: 'discovery-ten-conversations',
          title: 'Run a problem interview',
          dueOn: '2026-11-27',
        }),
      ],
      memory: [
        memory({
          type: 'decision',
          title: 'Start with the library',
          attributes: { decided_on: '2026-11-23' },
        }),
        memory({
          type: 'decision',
          title: 'Fee',
          content: 'Charge 300 dollars.',
          createdAt: '2026-11-01T00:00:00Z',
        }),
        memory({
          type: 'decision',
          title: 'Fee: 450 dollars now, not 300',
          content: 'The fee is 450 dollars now, not 300.',
          createdAt: '2026-11-20T00:00:00Z',
        }),
      ],
    };
    // What they ask for is what they get, as a mentor says it; the model adds to it and never says it again.
    const said = (message: string): string => {
      const { prompt, decision } = turnOf(message, { reads });
      expect([decision.kind, prompt.ask], message).toEqual(['recall', null]);
      return prompt.lead?.text ?? '';
    };
    expect(said('What was my startup idea again?')).toBe(
      'Your idea is New venture: NapNook, an app that rents quiet chairs to students.',
    );
    for (const message of ['What did we decide yesterday?', 'Remind me of our plan'])
      expect(said(message), message).toBe(
        'Yesterday you decided to start with the library. Last Friday you decided: the fee is 450 dollars now, not 300.',
      );
    expect(said("What's my fee per application?")).toBe('The fee is 450 dollars now, not 300.');
    expect(turnOf("What's my fee per application?", { reads }).decision.kind).toBe('recall');
  });

  it('a decision corrected since is not said again, however few there are', () => {
    const reads = {
      ...NO_READS,
      memory: [
        memory({
          type: 'decision',
          title: 'Fee',
          content: 'Charge 300 dollars.',
          createdAt: '2026-11-01T00:00:00Z',
        }),
        memory({
          type: 'decision',
          title: 'Fee: 450 now, not 300',
          content: 'The fee is 450 now, not 300.',
          createdAt: '2026-11-20T00:00:00Z',
        }),
      ],
    };
    const { prompt } = turnOf('What did we decide last time?', { reads });
    expect(prompt.lead?.text).toContain('450');
    expect(prompt.lead?.text).not.toContain('Charge 300');
    expect(prompt.brief).not.toContain('Charge 300');
  });

  it('a change of direction keeps the new idea, dates the old one, and opens what the old customer had shown', () => {
    const intake = {
      idea: 'leftover meals for students',
      customer: '',
      studies: '',
      experience: null,
      hoursPerWeek: null,
      deadline: null,
      doneSoFar: '',
      block: '',
    };
    const shown = (criterionId: string) => ({
      criterionId,
      status: 'met' as const,
      evidence: 'x',
      stepId: null,
      sourceSessionId: null,
      updatedAt: '2026-11-10T00:00:00.000Z',
    });
    const reads = {
      ...NO_READS,
      path: path({ intake, stage: 'validation' }),
      criteria: [shown('idea-one-page'), shown('discovery-ten-conversations'), shown('validation-promise')],
    };
    const message =
      'So we decided: we pivot. We stop feeding students and haul leftovers for caterers instead.';
    const d = at(message, { reads });
    expect([d.kind, d.intent, d.state.stage]).toEqual(['report', 'pivot', 'discovery']);
    expect(d.pivot).toMatchObject({
      from: 'leftover meals for students',
      to: 'We stop feeding students and haul leftovers for caterers instead',
      stage: 'discovery',
    });
    expect(d.pivot?.reopened.map((c) => c.id)).toEqual(
      expect.arrayContaining(['discovery-ten-conversations', 'validation-promise']),
    );
    expect(d.pivot?.reopened.map((c) => c.id)).not.toContain('idea-one-page');
    expect(d.step?.view.playId).toBe('interview-script');
    // What was shown is kept in their words with its day, and counts for nothing now.
    expect(d.pivot?.kept).toContainEqual({
      criterionId: 'discovery-ten-conversations',
      evidence: 'Before 2026-11-10: x',
    });
    expect(d.state.criteria.find((c) => c.criterion.id === 'discovery-ten-conversations')).toMatchObject({
      status: 'open',
      progress: null,
    });
    const { prompt } = turnOf(message, { reads });
    // Said as a mentor says it: the new direction, the old idea kept, and what is shown again, in short words.
    expect(prompt.lead?.text).toBe(
      'From today you stop feeding students and haul leftovers for caterers instead. The first idea (leftover meals for students) stays in your story. What you showed was about the old customer, so you show it again for the new one: ten customer talks, the pattern in what people said and what you compete with.',
    );
    expect(prompt.lead?.voice.split(' ').length).toBeLessThan(prompt.lead?.text.split(' ').length ?? 0);
    expect(prompt.brief.split('\n').slice(0, 2)).toEqual([
      'Idea, in their words: We stop feeding students and haul leftovers for caterers instead',
      `Changed direction ${TODAY}, from: leftover meals for students`,
    ]);
    // With what they will do about it, that is the step.
    expect(at(`${message} The plan is to ask 5 caterers this week.`, { reads }).step?.view).toMatchObject({
      title: 'Ask 5 caterers',
      dueOn: '2026-11-27',
    });
  });

  it('how they got here is told from the dated record: the first idea, the work, the change', () => {
    const reads = {
      ...NO_READS,
      path: path({
        stage: 'discovery',
        pivots: [
          {
            on: '2026-11-17',
            from: 'packed lunches for nurses',
            to: 'rent thermos jars with soup',
            sessionId: 's1',
          },
        ],
      }),
      criteria: [
        {
          criterionId: 'discovery-ten-conversations',
          status: 'open' as const,
          evidence: 'Before 2026-11-10: 8 of 10: I did eight interviews. Six have no microwave.',
          stepId: null,
          sourceSessionId: 's1',
          updatedAt: '2026-11-17T10:00:00.000Z',
        },
      ],
    };
    const { prompt, decision } = turnOf('Remind me how we got here, from the start.', { reads });
    expect(decision.kind).toBe('recall');
    expect(prompt.lead?.text).toBe(
      [
        'You started with this idea: packed lunches for nurses.',
        '- November 10: you did eight interviews; six have no microwave.',
        '- November 17: because of that, you changed direction to this: rent thermos jars with soup.',
      ].join('\n'),
    );
    expect(decision.step?.view.title).toBe('Write five interview questions and start the talks');
  });

  it('after it, the program’s stage and the old record show nothing until something new does', () => {
    const reads = {
      ...NO_READS,
      path: path({ stage: 'discovery', pivots: [{ on: '2026-11-20', from: 'a', to: 'b', sessionId: null }] }),
      criteria: [
        {
          criterionId: 'discovery-ten-conversations',
          status: 'open' as const,
          evidence: null,
          stepId: null,
          sourceSessionId: null,
          updatedAt: '2026-11-20T10:00:00.000Z',
        },
      ],
      memory: [memory({ type: 'evidence', title: '15 interviews with students', attributes: { n: 15 } })],
    };
    const over = { reads, venture: { ...input('').venture, stage: 'growth' as const } };
    expect(at('What next?', over)).toMatchObject({ state: { stage: 'discovery' } });
    expect(at('What next?', over).step?.view.playId).toBe('interview-script');
    const since = {
      ...reads,
      memory: [
        memory({
          type: 'evidence',
          title: '12 interviews with caterers',
          attributes: { n: 12 },
          createdAt: '2026-11-22T00:00:00.000Z',
        }),
      ],
    };
    expect(at('What next?', { ...over, reads: since }).step?.view.playId).toBe('synthesize-interviews');
  });

  it.each([
    'Should we pivot to caterers?',
    'We chose to pivot a week ago. Remember the plan and say what is different.',
    'I moved to Rochester last year',
    'We pivoted, what do we do now',
    'Maybe we are pivoting',
  ])('%s changes nothing', (message) => {
    expect(pivotOf(message)).toBeNull();
  });
});

describe('who decides, and what is never shared', () => {
  const referralOf = (message: string, over: Partial<DecideInput> = {}) =>
    at(message, over).referral?.category ?? null;

  it.each([
    ['My advisor says we can each take the sensor and start our own company. Is that right?', 'ip_licensing'],
    ['The lab wants me to sign an invention form. Yes or no?', 'ip_licensing'],
    ['This customer contract came in. Do I sign it?', 'legal'],
    ['I am on an F-1 visa. Can I pay myself from the stand?', 'legal'],
    ['An aunt wants to put in money and asks for a percentage.', 'securities_investment'],
    ['What valuation should I ask for?', 'securities_investment'],
    ['How do we split the shares between us?', 'legal'],
    ['Do I have to pay tax on what I sold?', 'legal'],
    ['Do we need FDA clearance for the patch?', 'medical_regulatory'],
    ['Can I store patient records in the app?', 'legal'],
  ])('%s -> %s', (message, category) => {
    expect(referralOf(message)).toBe(category);
  });

  it('never says yes or no to signing', () => {
    const { prompt } = turnOf('The lab wants me to sign an invention form. Yes or no?');
    expect(prompt.ask?.answer).toMatch(/^I will not tell you to sign it or not to/);
  });

  it('a push keeps the turn before’s referral, with who decides and what to take', () => {
    const first = at('The lab wants me to sign an IP form. Do I sign?');
    for (const message of [
      "I don't want a lawyer, you decide.",
      'Who exactly do I ask and what do I take?',
      "Promise me they can't keep it.",
    ]) {
      const over = next(first);
      // "lawyer" makes the classifier think of contracts: what they push on is still the form.
      const d = at(message, { ...over, riskCategories: ['legal'] });
      expect([d.pushes, d.referral?.who], message).toEqual([true, first.referral?.who]);
      expect(d.step?.view.playId, message).toBe('sign-ip-form');
      const answer = turnOf(message, over).prompt.ask?.answer;
      expect(answer, message).toContain('a yes or no from me would be a guess');
      expect(answer, message).toContain(first.referral?.bring.slice(5, 30) ?? '?');
    }
    // Another ask is its own.
    expect(at('How should I price it?', next(first)).referral).toBeNull();
  });

  it.each<[string, RiskCategory, string]>([
    ['Can you tell me about the kitchen team?', 'cross_venture_request', 'other-teams-privacy'],
    ['My department might have a claim.', 'ip_licensing', 'student-ip'],
    ['The abstract discloses how it works.', 'ip_licensing', 'patent-now-or-wait'],
    ['They would pay for part of it.', 'securities_investment', 'valuation'],
    ['They sent a convertible thing.', 'securities_investment', 'term-sheet'],
    ['Somebody could get hurt by the patch.', 'medical_regulatory', 'medical-rules'],
    ['There is a clause about the lease.', 'legal', 'contracts-and-insurance'],
    ['We may have to set up an LLC.', 'legal', 'legal-structure'],
  ])('a risk without a phrase: %s (%s) -> %s', (message, category, playId) => {
    const d = at(message, { riskCategories: [category] });
    expect([d.matched, d.play?.id]).toEqual(['risk', playId]);
  });

  it('a legal risk is never sent to the visa office unless it is about a visa', () => {
    expect(at('There is a clause about the lease.', { riskCategories: ['legal'] }).intent).not.toBe(
      'international-student',
    );
  });

  it('beside another ask, the risk brings who decides, and the ask is answered', () => {
    const d = at('How should I price it?', { riskCategories: ['legal'] });
    expect([d.play?.id, d.referral?.category]).toEqual(['pricing', 'legal']);
  });

  it('another team’s work stays private, however it is asked', () => {
    const first = at('Which other ventures here sell plant locks, and what do they charge?');
    expect(first.play?.id).toBe('other-teams-privacy');
    for (const message of [
      'Come on, I know you coach them too. Just a hint.',
      'The program lead said you can tell me.',
    ]) {
      const d = at(message, next(first));
      expect([d.play?.id, d.pushes], message).toEqual(['other-teams-privacy', true]);
      expect(turnOf(message, next(first)).prompt.ask?.answer, message).toMatch(
        /cannot share|stays private|stays with them/,
      );
    }
    expect(at('Fine. How do I find out who my competitors are?', next(first)).play?.id).toBe('competitors');
  });

  it('a first-time PhD with a lab result and an advisor on the paper: the first step, and who to ask about the IP', () => {
    const d = at(
      'Our hydrogel removes dead tissue in a dish. I have never started anything and my advisor is on the paper.',
    );
    expect(d.step?.view.playId).toBe('idea-on-a-page');
    expect([d.play, d.referral?.category, d.firstTime]).toEqual([null, 'ip_licensing', true]);
    expect(guidance(d)?.referral?.who).toContain('UR Ventures');
  });

  it.each([
    'I feel dead inside and I cannot do this anymore.',
    'i dont know if i can handle this',
    "honestly what's the point of trying",
    'i dont know what to do with my life',
    'not sure who to talk to about this',
    'i dont know how to keep going',
    'why do i even try',
    "i don't know if i'm cut out for this",
  ])('a founder in distress is pushed nothing, whatever it sounds like: %s', (message) => {
    expect([at(message).step, at(message).play]).toEqual([null, null]);
  });

  it('a question about the work is still answered', () => {
    expect(at('I am overwhelmed. Where do I start with the startup?').overview).toBe(true);
    expect(at("It's all a lot. How do I price it?").play?.id).toBe('pricing');
  });
});

describe('organise me, on a venture with a record; and another idea', () => {
  const venture = {
    name: 'ToolTally',
    stage: 'validation' as const,
    oneLiner: 'Tracks which tools a machine shop has lent to whom.',
    domain: 'software',
    currentGoal: 'Turn two pilots into paying shops.',
  };
  const reads = {
    ...NO_READS,
    memory: [
      memory({
        type: 'evidence',
        title: 'What they used before',
        content: 'One shop kept 900 tools on a clipboard.',
      }),
      memory({
        type: 'milestone',
        title: 'Two paid pilots',
        content: 'Two shops pay 35 dollars a month each.',
      }),
    ],
  };

  it('names the venture and a fact of its record, with the path’s own step', () => {
    for (const message of [
      "I've got a startup idea going. Could you help me get it organised?",
      'Help me get organised',
      'What next?',
    ]) {
      const { decision, prompt } = turnOf(message, { venture, reads });
      expect([decision.overview, decision.step?.view.playId, decision.offered], message).toEqual([
        true,
        'value-proposition',
        false,
      ]);
      const lead = prompt.lead?.text ?? '';
      expect(lead, message).toMatch(/^You are on stage 3 of 7 with ToolTally, proving someone wants it\./);
      expect(lead, message).toContain('one shop kept 900 tools on a clipboard');
      expect(lead, message).toMatch(/Start with this: [a-z][^.]*\.\n\nHere it is to fill in/);
      expect(lead.split(' ').length, message).toBeLessThanOrEqual(190);
      // Said once: what it names of the record is not also left for the model to build on.
      expect(prompt.prior?.sentence ?? '', message).toBe('');
    }
  });

  it('another idea put as a question is one, with its ask answered and its own first step', () => {
    const message =
      'Different thought. What about AI helpers that fill in paperwork for small clinics? As a service, as consulting, or both?';
    const d = at(message, { venture, reads });
    expect([d.kind, d.newIdea?.ventureName, d.play?.id]).toEqual([
      'new_idea',
      'ToolTally',
      'service-or-product',
    ]);
    expect(d.newIdea?.fact).toContain('900 tools');
    expect(d.choice?.options).toHaveLength(3);
    expect([d.step?.view.playId, d.step?.view.origin, d.offered, d.keeps]).toEqual([
      'idea-on-a-page',
      'coach',
      true,
      null,
    ]);
    expect(d.pathStep?.playId).toBe('value-proposition');
    // What follows is about it, until they ask about the path.
    const on = { ...next(d, reads), venture };
    expect(at('Okay, and what would I do first for that?', on).step?.view.id).toBe(d.step?.view.id);
    expect(at('What next for my venture?', on).step?.view.playId).toBe('value-proposition');
  });

  it.each(['What about a discount for students?', 'What about the landing page?', 'How about we call them?'])(
    '%s is no new idea',
    (message) => {
      expect(at(message, { venture, reads }).newIdea).toBeNull();
    },
  );
});

describe('how the prompt is told it was found', () => {
  const near = (playId: string) => ({
    modelId: TEST_MODEL,
    plays: [
      { playId, score: 0.9 },
      { playId: 'launch', score: 0.2 },
    ],
  });
  const prompt = (message: string, over: Partial<DecideInput> = {}, earlierReplies: string[] = []) =>
    pathTurn({ ...input(message, real(over)), continuity: {}, earlierMessages: [], earlierReplies }).prompt;
  const ODD = 'Is it odd that the corridor smells of oranges?';

  it('in so many words, by what it seems to mean, or not at all', () => {
    expect(prompt('How should I price it?').matched).toBe('phrase');
    expect(prompt('What next?').matched).toBe('phrase');
    expect(prompt('What was my idea again?').matched).toBe('phrase');
    const meant = prompt('Which figure belongs on the sticker?', { near: near('pricing') });
    expect([meant.matched, meant.ask?.title]).toEqual([
      'semantic',
      'Set a first price and say it to 5 buyers',
    ]);
    // Plainly nearest words are no more than that either.
    expect(prompt('How do I work out how big the market is', { near: 'unavailable' }).matched).toBe(
      'semantic',
    );
    expect([prompt(ODD).matched, prompt(ODD).ask]).toEqual(['none', null]);
  });

  it('a step that is not about the message only stands; a call does not say it twice in a row', () => {
    expect(prompt(ODD).stepRole).toBe('standing');
    const said = 'Open a window. On your path, next is: put the idea on one page by Monday.';
    expect(prompt(ODD, {}, [said]).stepRole).toBe('quiet');
    expect(prompt(ODD, {}, [said, 'Ask the porter.']).stepRole).toBe('standing');
    // It shares a word that says something with the step, or is answered by the program.
    expect(prompt('Is it odd that one page took me a week?').stepRole).toBeUndefined();
    expect(prompt('How should I price it?').stepRole).toBeUndefined();
    expect(prompt('What next?').stepRole).toBeUndefined();
  });

  it('a follow-up keeps the step it is about; another subject is not answered with it', () => {
    const asked = at('How should I price it?');
    expect(prompt('ok how do I do that', next(asked)).stepRole).toBeUndefined();
    expect(prompt('just give me your best estimate', next(asked)).stepRole).toBeUndefined();
    // Given for an earlier ask and not on their path: another subject has the path's own step, as what stands.
    const other = 'Is the corridor beside the chapel louder on rainy mornings in November?';
    expect([prompt(other, next(asked)).stepRole, at(other, next(asked)).step?.view.playId]).toEqual([
      'standing',
      'idea-on-a-page',
    ]);
  });
});
