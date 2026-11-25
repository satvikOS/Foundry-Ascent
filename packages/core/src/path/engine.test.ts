import { type pathRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { addDays, dueOnFor, onWeekday } from './dates.js';
import { checkInOf, concreteFact, decide, guidanceOf, namesStep, type DecideInput } from './engine.js';
import { stepIdFor } from './ids.js';
import { choiceOf, ideaSentences, reportOf, saysFirstTime } from './kinds.js';
import { pathState, recordShowing } from './state.js';
import { FIXTURE_PLAYBOOK } from './testing/fixture-playbook.js';
import {
  fresh,
  input,
  LAB_MEMORY,
  memory,
  NO_READS,
  storedStep,
  TODAY,
  VENTURE_ID,
  withHistory,
} from './testing/inputs.js';
import { pathTurn } from './turn.js';

const kindOf = (message: string, over: Partial<DecideInput> = {}): string =>
  decide(input(message, over)).kind;
const stepOf = (message: string, over: Partial<DecideInput> = {}): string | null =>
  decide(input(message, over)).step?.view.playId ?? null;

describe('the same input always gives the same decision', () => {
  const messages: readonly (readonly [string, Partial<DecideInput>])[] = [
    ['I have got a venture idea! Could you get me organised?', withHistory()],
    ["Only an idea so far, I've never done this, I study engineering and don't know business", fresh()],
    [
      'AI helpers for the paperwork of companies’ back offices. A service, consulting, or both?',
      withHistory(),
    ],
    ['What should I charge?', withHistory()],
    ['who owns the idea if I made it in a university lab', withHistory()],
    ['I talked to 5 people', { reads: { ...NO_READS, steps: [storedStep()] } }],
    ['What did we decide yesterday?', withHistory()],
    ['thanks!', withHistory()],
    ['Let us role-play: you are the investor', withHistory()],
    ['zzz qqq', fresh()],
  ];

  it.each(messages)('%s', (message, over) => {
    const first = JSON.stringify(decide(input(message, over)));
    for (let i = 0; i < 100; i += 1) expect(JSON.stringify(decide(input(message, over)))).toBe(first);
  });

  it('reads no clock: another day changes the due date, not the step', () => {
    const a = decide(input('What next?', withHistory({ today: '2026-11-24' })));
    const b = decide(input('What next?', withHistory({ today: '2026-12-24' })));
    expect(a.step?.view.id).toBe(b.step?.view.id);
    expect(a.step?.view.dueOn).not.toBe(b.step?.view.dueOn);
  });

  it('does not change what it is given', () => {
    const given = input('What next?', withHistory());
    const before = JSON.stringify({ ...given, playbook: null });
    decide(given);
    expect(JSON.stringify({ ...given, playbook: null })).toBe(before);
  });
});

describe('kinds of message', () => {
  it.each([
    ['hi', 'social'],
    ['thanks, that helps!', 'social'],
    ['ok', 'social'],
    ['got it', 'social'],
    ['bye, talk tomorrow', 'social'],
    ['What did we talk about last time?', 'recall'],
    ['Tell me, what is our business idea?', 'recall'],
    ['What was my idea again, and what did we settle on yesterday? What did we decide?', 'recall'],
    ['Remind me what we agreed on', 'recall'],
    ['Where did we leave off?', 'recall'],
    ['We chose to pivot a week ago. Remember the plan and say what is different.', 'recall'],
    ['Can we practice my pitch?', 'rehearsal'],
    ['Pretend to be a lab manager who says no', 'rehearsal'],
    ['How do I practice my pitch?', 'coaching'],
    ['What should I do next?', 'coaching'],
    ['Say that the idea is great.', 'coaching'],
    ['Every friend of mine loves it. Does that mean it is good?', 'coaching'],
  ])('%s -> %s', (message, kind) => {
    expect(kindOf(message, withHistory())).toBe(kind);
  });

  it('a bare yes to a question answers it; to a statement it is an acknowledgement', () => {
    expect(kindOf('yes', withHistory({ previousReply: 'Do you have their emails?' }))).toBe('coaching');
    expect(kindOf('yes', withHistory({ previousReply: 'Send it on Friday.' }))).toBe('social');
  });

  it('crisis comes before everything and gives no step', () => {
    const d = decide(input('What should I charge?', withHistory({ crisis: true })));
    expect([d.kind, d.step, guidanceOf(FIXTURE_PLAYBOOK, d)]).toEqual(['crisis', null, null]);
  });

  it('a rehearsal goes on while the coach is in role, and ends when the founder says so', () => {
    const over = withHistory({
      conversationMode: 'rehearse',
      previousReply: '[As the lab manager:] We have no budget for this.',
    });
    expect(['rehearsal', 'coaching', 'report', 'social']).toContain(kindOf('It is only $40 a month', over));
    expect(kindOf('Stop the role-play. How did I do?', over)).not.toBe('rehearsal');
    expect(kindOf('anything', withHistory({ mode: 'rehearse' }))).toBe('rehearsal');
    expect(kindOf('anything', withHistory({ counterpart: 'an investor' }))).toBe('rehearsal');
  });

  it('social, rehearsal and crisis turns keep no guidance', () => {
    for (const message of ['thanks!', 'Can we practice my pitch?'])
      expect(guidanceOf(FIXTURE_PLAYBOOK, decide(input(message, withHistory())))).toBeNull();
  });

  it('a step is present on every other kind', () => {
    for (const message of [
      'What next?',
      'What did we decide?',
      'I talked to 5 people',
      'What should I charge?',
      'Who owns the idea?',
      'blah blah',
      'My idea is a drone network that delivers insulin to rural clinics',
    ])
      expect(decide(input(message, withHistory())).step, message).not.toBeNull();
  });

  it('a founder in distress is pushed no step, and keeps the referral', () => {
    const d = decide(
      input('I had a big fight with my cofounder', withHistory({ riskCategories: ['conflict_harassment'] })),
    );
    expect(d.step).toBeNull();
    expect(d.referral?.role).toBe('program_lead');
    expect(guidanceOf(FIXTURE_PLAYBOOK, d)?.referral?.who).toBe('The program lead');
  });

  it('overwhelmed and asking where to start still gets the plan', () => {
    const d = decide(input('I am overwhelmed. Where do I start?', withHistory()));
    expect(d.overview).toBe(true);
    expect(d.step).not.toBeNull();
  });
});

describe('the ask', () => {
  it('a phrase names its play; nothing named gives none, and the step of the path', () => {
    const asked = decide(input('What should I charge?', withHistory()));
    expect([asked.intent, asked.play?.id, asked.matched]).toEqual(['pricing', 'price-it', 'phrase']);
    const nothing = decide(input('blah blah', withHistory()));
    expect([nothing.intent, nothing.play, nothing.matched]).toEqual([null, null, null]);
  });

  it('a referral wins over any other ask, by phrase or by the risk the classifier found', () => {
    const phrase = decide(input('What should I charge, and who owns the idea?', withHistory()));
    expect([phrase.intent, phrase.referral?.who]).toEqual(['ownership', 'The technology transfer office']);
    const risk = decide(
      input(
        'My professor says the department might claim it',
        withHistory({ riskCategories: ['ip_licensing'] }),
      ),
    );
    expect([risk.intent, risk.matched, risk.referral?.category]).toEqual([
      'ownership',
      'risk',
      'ip_licensing',
    ]);
  });

  it('an ask is answered with its own step, and never with the path’s', () => {
    const own = decide(input('blah', withHistory())).step?.view.id;
    const asked = decide(input('What should I charge?', withHistory()));
    expect(asked.step?.view).toMatchObject({ playId: 'price-it', status: 'later', origin: 'path' });
    // It shows nothing the stage asks for: offered, not stored, with the path's own step beside it.
    expect([asked.offered, asked.step?.write, asked.keeps, asked.pathStep?.id]).toEqual([
      true,
      null,
      null,
      own,
    ]);
    expect(guidanceOf(FIXTURE_PLAYBOOK, asked)).toMatchObject({
      offered: true,
      step: { playId: 'price-it' },
      pathStep: { id: own },
    });
    const owner = decide(input('Who owns the idea?', withHistory()));
    expect([owner.offered, owner.step?.view.playId, owner.referral?.who]).toEqual([
      true,
      'who-owns-it',
      'The technology transfer office',
    ]);
    // The path is as it was.
    expect(decide(input('What next?', withHistory())).step?.view.id).toBe(own);
  });

  const atDiscovery = (steps: pathRepo.PathStepRecord[] = []): Partial<DecideInput> =>
    fresh({
      reads: {
        ...NO_READS,
        steps,
        path: {
          ventureId: VENTURE_ID,
          stage: 'discovery',
          intake: null,
          intakeBy: null,
          pivots: [],
          playbookVersion: 'x',
          version: 1,
        },
      },
    });

  it('becomes the path’s step when it shows something the stage still asks for; another is offered', () => {
    expect(stepOf('blah', fresh())).toBe('idea-on-a-page');
    expect(stepOf('blah', atDiscovery())).toBe('ten-interviews');
    const segment = decide(input('Which customer do I go after?', atDiscovery()));
    expect(segment).toMatchObject({
      offered: false,
      pathStep: null,
      keeps: {
        write: 'insert',
        view: { playId: 'choose-segment', status: 'now', criterionId: 'discovery-segment' },
      },
    });
    expect(segment.then[0]?.playId).toBe('ten-interviews');
    const unit = decide(input('What are my unit economics?', atDiscovery()));
    expect([unit.offered, unit.step?.view.playId, unit.pathStep?.playId]).toEqual([
      true,
      'unit-economics',
      'ten-interviews',
    ]);
  });

  it('the step before waits with its id and its ticks', () => {
    const given = storedStep({
      items: [{ do: 'List the people you can reach this week', how: '', minutes: 20, done: true }],
    });
    const d = decide(input('Which customer do I go after?', atDiscovery([given])));
    expect(d.step?.view.playId).toBe('choose-segment');
    expect(d.then[0]).toMatchObject({ id: given.id, status: 'next', items: [{ done: true }] });
    // As the rows then read: what the path is on is the ask's, and the one before is next.
    const after = [
      { ...given, status: 'next' as const },
      storedStep({ id: d.step?.view.id ?? '', playId: 'choose-segment', criterionId: 'discovery-segment' }),
    ];
    expect(stepOf('What next?', atDiscovery(after))).toBe('choose-segment');
  });

  it('a play that shows one of the stage’s criteria in another way is the step too, and the criterion has one step', () => {
    const touching = {
      ...FIXTURE_PLAYBOOK,
      plays: FIXTURE_PLAYBOOK.plays.map((x) =>
        x.id === 'service-or-product' ? { ...x, criteria: ['idea-page'] } : x,
      ),
    };
    const d = decide(input('Service business or consulting?', fresh({ playbook: touching })));
    expect([d.play?.id, d.step?.view.playId, d.step?.view.criterionId, d.offered]).toEqual([
      'service-or-product',
      'service-or-product',
      'idea-page',
      false,
    ]);
    expect(d.then.map((s) => s.playId)).not.toContain('idea-on-a-page');
  });

  it('what they said they would do, in their own words, is never displaced by an ask', () => {
    const theirs = storedStep({
      origin: 'founder',
      playId: null,
      criterionId: null,
      title: 'Email five clubs',
    });
    const d = decide(input('Which customer do I go after?', atDiscovery([theirs])));
    expect([d.offered, d.step?.view.playId, d.pathStep?.title]).toEqual([
      true,
      'choose-segment',
      'Email five clubs',
    ]);
  });

  it('the same ask gives the same step, offered or stored, in every conversation', () => {
    const offered = decide(input('What should I charge?', withHistory())).step?.view;
    const stored = storedStep({
      id: offered?.id ?? '',
      playId: 'price-it',
      criterionId: null,
      status: 'next',
    });
    const again = decide(
      input(
        'What should I charge?',
        withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, steps: [stored] } }),
      ),
    );
    expect([again.step?.view.id, again.offered, again.step?.write]).toEqual([offered?.id, false, null]);
  });

  it('A or B: the options as they said them', () => {
    expect(choiceOf('AI helpers for offices. Fixed service, consulting, or both?')).toEqual([
      'Fixed service',
      'consulting',
      'both',
    ]);
    expect(choiceOf('Should I sell to labs or to principal investigators?')).toEqual([
      'labs',
      'to principal investigators',
    ]);
    expect(choiceOf('Should I go for grants, angel money or VC?')).toEqual(['grants', 'angel money', 'VC']);
    expect(choiceOf('Should I incorporate or not?')).toEqual([]);
    expect(choiceOf('We sell to labs or clinics.')).toEqual([]);
    expect(decide(input('A fixed service, consulting, or some of each?', withHistory())).choice).toHaveLength(
      3,
    );
  });

  it('get me organized, what next, where do I start: the whole path', () => {
    for (const message of [
      'Can you help me get organised?',
      'what should I do next?',
      "What's next?",
      'where do I start',
      'Give me a clear plan',
      'I have no idea what to do',
      'where are we at',
    ]) {
      const d = decide(input(message, withHistory()));
      expect(d.overview, message).toBe(true);
      expect(d.step, message).not.toBeNull();
    }
    for (const message of ['What should I charge next year?', 'We organized a meetup', 'What is next door?'])
      expect(decide(input(message, withHistory())).overview, message).toBe(false);
  });

  it('an overview is answered by where this venture stands, never by another stage’s play', () => {
    const turn = pathTurn({
      ...input('Help me get organized', withHistory()),
      continuity: {},
      earlierMessages: [],
    });
    expect(turn.prompt.ask).toBeNull();
    const lead = turn.prompt.lead?.text ?? '';
    expect(lead).toMatch(/^You are on stage 3 of 7 with ReagentLoop, proving someone wants it\./);
    expect(lead).toContain('first paying customers');
    expect(lead).toContain('What you know so far: you interviewed 15 lab managers');
    expect(lead).toContain('Start with this: list the people you can reach this week.');
    // Spoken, it is where they stand, what is missing and the start.
    const voice = turn.prompt.lead?.voice ?? '';
    expect(voice).not.toContain('What you know so far');
    expect(voice.split(' ').length).toBeLessThanOrEqual(50);
  });
});

describe('where the venture stands', () => {
  it('starts at the idea with nothing recorded, whatever stage the program has it at', () => {
    expect(pathState(FIXTURE_PLAYBOOK, input('')).stage).toBe('idea');
  });

  it('starts at the program’s stage when the record holds work of its own, earlier stages counting as claimed', () => {
    const state = pathState(FIXTURE_PLAYBOOK, input('', withHistory()));
    expect(state.stageIndex).toBe(2);
    const byId = Object.fromEntries(state.criteria.map((c) => [c.criterion.id, [c.status, c.by]]));
    expect(byId['idea-page']).toEqual(['claimed', 'stage']);
    expect(byId['discovery-interviews']).toEqual(['claimed', 'record']);
    expect(byId['validation-customers']).toEqual(['claimed', 'record']);
    expect(byId['validation-test']).toEqual(['open', null]);
  });

  it('a record claims only what it shows: counts are reached, plans and offers show nothing', () => {
    const interviews = FIXTURE_PLAYBOOK.criteria.find((c) => c.id === 'discovery-interviews');
    const customers = FIXTURE_PLAYBOOK.criteria.find((c) => c.id === 'validation-customers');
    const test = FIXTURE_PLAYBOOK.criteria.find((c) => c.id === 'validation-test');
    if (!interviews || !customers || !test) throw new Error('fixture');
    const four = memory({ type: 'evidence', title: '4 interviews with students', attributes: { n: 4 } });
    expect(recordShowing(interviews, [four])).toBeNull();
    expect(recordShowing(interviews, LAB_MEMORY)?.title).toContain('15 interviews');
    const offer = memory({
      type: 'evidence',
      title: 'Offered 2 paid pilots',
      content: 'We will sign 2 pilots next month.',
    });
    expect(recordShowing(customers, [offer])).toBeNull();
    const believed = memory({ type: 'hypothesis', title: '2 paid pilots signed' });
    expect(recordShowing(customers, [believed])).toBeNull();
    // A count of something else in the same record is no count of customers.
    const ten = { ...customers, evidence: 'A list of 10 paying or signed customers.' };
    const pilots = memory({
      type: 'milestone',
      title: 'Two paid pilots',
      content: 'Two paid pilots signed. One shop kept 1200 tools on a clipboard and lost about 40 a year.',
    });
    expect(recordShowing(ten, [pilots])).toBeNull();
    expect(
      recordShowing(ten, [{ ...pilots, title: '12 paid pilots', content: '12 paid pilots signed.' }]),
    ).not.toBeNull();
    const proposed = memory({ type: 'evidence', title: '2 paid pilots signed', status: 'proposed' });
    expect(recordShowing(customers, [proposed])).toBeNull();
    const running = memory({ type: 'experiment', title: 'Smoke test', attributes: { status: 'running' } });
    expect(recordShowing(test, [running])).toBeNull();
    const ran = memory({
      type: 'experiment',
      title: 'Smoke test',
      attributes: { status: 'completed', result: '19%' },
    });
    expect(recordShowing(test, [ran])).toBe(ran);
  });

  it('moves on when every criterion of the stage is claimed or met, and never back by itself', () => {
    const met = (id: string) => ({
      criterionId: id,
      status: 'met' as const,
      evidence: 'x',
      stepId: null,
      sourceSessionId: null,
      updatedAt: '',
    });
    const reads = { ...NO_READS, criteria: [met('idea-page'), met('idea-risk')] };
    expect(pathState(FIXTURE_PLAYBOOK, input('', fresh({ reads }))).stage).toBe('discovery');
    const path = {
      ventureId: VENTURE_ID,
      stage: 'commercialization' as const,
      intake: null,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    expect(pathState(FIXTURE_PLAYBOOK, input('', fresh({ reads: { ...NO_READS, path } }))).stage).toBe(
      'commercialization',
    );
    // The program moved the venture back; the path stays where it got to.
    expect(
      pathState(
        FIXTURE_PLAYBOOK,
        input('', withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, path } })),
      ).stage,
    ).toBe('commercialization');
  });

  it('a criterion the founder took back is open though the record shows it', () => {
    const reads = {
      ...NO_READS,
      memory: LAB_MEMORY,
      criteria: [
        {
          criterionId: 'validation-customers',
          status: 'open' as const,
          evidence: null,
          stepId: null,
          sourceSessionId: null,
          updatedAt: '',
        },
      ],
    };
    const state = pathState(FIXTURE_PLAYBOOK, input('', withHistory({ reads })));
    expect(state.criteria.find((c) => c.criterion.id === 'validation-customers')?.status).toBe('open');
  });
});

describe('the step', () => {
  it('is the first criterion of the stage still to show, with a derived id, due on a weekday', () => {
    const d = decide(input('What next?', withHistory()));
    expect(d.step).toMatchObject({
      write: 'insert',
      view: { playId: 'run-a-test', criterionId: 'validation-test', status: 'now', origin: 'path' },
    });
    // 10 days after Tuesday 2026-11-24 is a Friday.
    expect(d.step?.view.dueOn).toBe('2026-12-04');
    expect(d.then.map((s) => s.playId)).toEqual(['unit-economics', 'channel-choice']);
  });

  it('keeps its id while it is open, stored or not', () => {
    const id = stepIdFor({ ventureId: VENTURE_ID, playId: 'run-a-test', origin: 'path', attempt: 1 });
    expect(decide(input('What next?', withHistory())).step?.view.id).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const stored = storedStep({ id, playId: 'run-a-test', criterionId: 'validation-test' });
    const d = decide(
      input('What next?', withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, steps: [stored] } })),
    );
    expect(d.step).toMatchObject({ write: null, view: { id, dueOn: '2026-11-30' } });
  });

  it('done again later is another step', () => {
    const done = storedStep({
      id: 'cccccccc-0000-4000-8000-000000000001',
      playId: 'run-a-test',
      criterionId: 'validation-test',
      status: 'done',
      completedAt: '2026-11-20T10:00:00Z',
    });
    const d = decide(
      input('What next?', withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, steps: [done] } })),
    );
    expect(d.step?.view.id).toBe(
      stepIdFor({ ventureId: VENTURE_ID, playId: 'run-a-test', origin: 'path', attempt: 2 }),
    );
  });

  it('a stored step whose criterion has been shown since is over', () => {
    const stored = storedStep({ playId: 'signed-pilots', criterionId: 'validation-customers' });
    expect(
      stepOf('What next?', withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, steps: [stored] } })),
    ).toBe('run-a-test');
  });

  it('what was skipped or is blocked waits until nothing else of the stage is left', () => {
    const path = {
      ventureId: VENTURE_ID,
      stage: 'discovery' as const,
      intake: null,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    const skipped = storedStep({ status: 'skipped' });
    expect(stepOf('What next?', fresh({ reads: { ...NO_READS, path, steps: [skipped] } }))).toBe(
      'choose-segment',
    );
    const blocked = storedStep({ status: 'blocked' });
    const d = decide(input('What next?', fresh({ reads: { ...NO_READS, path, steps: [blocked] } })));
    expect(d.step?.view.playId).toBe('choose-segment');
    expect(d.then[0]).toMatchObject({ id: blocked.id, status: 'blocked' });
  });

  it('a waiting step that comes back is promoted, with a due date from today when its own is past', () => {
    const path = {
      ventureId: VENTURE_ID,
      stage: 'discovery' as const,
      intake: null,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    const waiting = storedStep({ status: 'next', dueOn: '2026-11-01', version: 4 });
    const d = decide(input('What next?', fresh({ reads: { ...NO_READS, path, steps: [waiting] } })));
    expect(d.step).toMatchObject({
      write: 'promote',
      storedVersion: 4,
      view: { id: waiting.id, status: 'now', dueOn: '2026-12-01' },
    });
  });

  it('no criterion left: no step, and no crash', () => {
    const all = FIXTURE_PLAYBOOK.criteria.map((c) => ({
      criterionId: c.id,
      status: 'met' as const,
      evidence: null,
      stepId: null,
      sourceSessionId: null,
      updatedAt: '',
    }));
    const d = decide(input('What next?', withHistory({ reads: { ...NO_READS, criteria: all } })));
    expect([d.state.stage, d.step]).toEqual(['transition', null]);
    expect(guidanceOf(FIXTURE_PLAYBOOK, d)).toBeNull();
  });
});

describe('due dates', () => {
  it('today plus the play’s days, on a weekday', () => {
    expect(dueOnFor('2026-11-24', 5, null)).toBe('2026-11-30'); // Sunday the 29th -> Monday
    expect(dueOnFor('2026-11-24', 4, null)).toBe('2026-11-30'); // Saturday the 28th -> Monday
    expect(dueOnFor('2026-11-24', 2, null)).toBe('2026-11-26');
    expect(onWeekday('2026-11-27')).toBe('2026-11-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('a deadline ahead pulls it in, never before today; one already past changes nothing', () => {
    expect(dueOnFor('2026-11-24', 14, '2026-11-27')).toBe('2026-11-27');
    expect(dueOnFor('2026-11-24', 14, '2026-11-29')).toBe('2026-11-27'); // Sunday -> the Friday before
    expect(dueOnFor('2026-11-24', 14, '2026-11-24')).toBe('2026-11-24');
    expect(dueOnFor('2026-11-28', 14, '2026-11-29')).toBe('2026-11-28'); // Saturday, deadline on Sunday
    expect(dueOnFor('2026-11-24', 2, '2026-11-20')).toBe('2026-11-26');
  });

  it('reads the founder’s intake', () => {
    const intake = {
      idea: '',
      customer: '',
      studies: '',
      experience: null,
      hoursPerWeek: null,
      deadline: { what: 'Pitch', on: '2026-11-25' },
      doneSoFar: '',
      block: '',
    };
    const path = {
      ventureId: VENTURE_ID,
      stage: 'validation' as const,
      intake,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    const d = decide(input('What next?', withHistory({ reads: { ...NO_READS, memory: LAB_MEMORY, path } })));
    expect(d.step?.view.dueOn).toBe('2026-11-25');
  });
});

describe('reports', () => {
  it.each([
    ['I did it', 'done'],
    ['Done', 'done'],
    ['We talked to 5 people and four said the same thing', 'done'],
    ['I sent the emails on Monday', 'done'],
    ['not yet', 'not_yet'],
    ['No, I ran out of time', 'not_yet'],
    ["I haven't done it", 'not_yet'],
    ['Nobody replied to my emails', 'blocked'],
    ['I am stuck on the second part', 'blocked'],
    ['We decided not to do the survey', 'dropped'],
    ['Change of plans, we are dropping it', 'dropped'],
    ['I have started the list', 'started'],
  ])('%s -> %s', (message, state) => {
    expect(reportOf(message)?.state).toBe(state);
  });

  it.each([
    'I will talk to 5 people',
    'Should I have talked to 5 people?',
    'I want to send the emails',
    'If I did it, would it help?',
    'How did you get 5 people?',
    'What should I do next?',
  ])('%s reports nothing done', (message) => {
    expect(reportOf(message)?.state === 'done').toBe(false);
  });

  const path = {
    ventureId: VENTURE_ID,
    stage: 'discovery' as const,
    intake: null,
    intakeBy: null,
    pivots: [],
    playbookVersion: 'x',
    version: 1,
  };
  const onInterviews = fresh({ reads: { ...NO_READS, path, steps: [storedStep()] } });

  it('a finished step is completed with their words, and the step is the next one', () => {
    const d = decide(input('I interviewed 12 people about the last time it happened.', onInterviews));
    expect(d.kind).toBe('report');
    expect(d.completes).toMatchObject({
      step: { id: storedStep().id },
      evidence: 'I interviewed 12 people about the last time it happened.',
    });
    expect(d.step?.view.playId).toBe('choose-segment');
    expect(d.checkIn).toBeNull();
  });

  it('what is short of done-when, or shows nothing, finishes nothing', () => {
    for (const message of [
      'I interviewed 3 people about the last time',
      'Done',
      'I did it',
      'I went to a party with 12 people',
    ]) {
      const d = decide(input(message, onInterviews));
      expect(d.completes, message).toBeNull();
      expect(d.step?.view.id, message).toBe(storedStep().id);
    }
  });

  it('a report with no step given yet changes nothing', () => {
    const d = decide(
      input('I talked to 12 people about the last time', fresh({ reads: { ...NO_READS, path } })),
    );
    expect(d.completes).toBeNull();
  });

  it('thanks with a report is a report', () => {
    expect(kindOf('I interviewed 12 people about the last time, thanks!', onInterviews)).toBe('report');
  });

  it('an ask in the message is answered now, and the report still counts', () => {
    const d = decide(
      input('I finished: I interviewed 12 people about the last time. What should I charge?', onInterviews),
    );
    expect(d.intent).toBe('pricing');
    expect(d.step).not.toBeNull();
  });
});

describe('an idea the record does not hold', () => {
  const idea = 'I want to build a drone network that delivers insulin to rural clinics.';

  it('is told apart from the venture’s own, with one concrete fact, and still gets a first step', () => {
    const d = decide(input(idea, withHistory()));
    expect(d.kind).toBe('new_idea');
    expect(d.newIdea).toEqual({
      ventureName: 'ReagentLoop',
      fact: 'you interviewed 15 lab managers; 11 described the last time a reagent expired unused',
    });
    expect(d.step?.view).toMatchObject({ playId: 'idea-on-a-page', origin: 'coach', status: 'later' });
    expect(d.then).toEqual([]);
    // The venture's own path is as it was.
    expect(decide(input('What next?', withHistory())).step?.view.origin).toBe('path');
  });

  it('a noun phrase tells one too, with the choice it asks', () => {
    const d = decide(
      input(
        'AI helpers for the paperwork of companies’ back offices. A fixed service, consulting, or some of each?',
        withHistory(),
      ),
    );
    expect(d.kind).toBe('new_idea');
    expect(d.choice).toHaveLength(3);
    expect(d.intent).toBe('service-or-product');
    expect(d.step).not.toBeNull();
  });

  it.each([
    'I have got a venture idea! Could you get me organised?',
    'Is there a tool for sending surveys to clinics?',
    'We want to build the barcode scanner for reagent shelves',
    'How do I find customers for the app?',
    'My idea is great, right?',
    "I'm in idea stage, never done this, engineering student",
  ])('%s is not one', (message) => {
    expect(decide(input(message, withHistory())).newIdea).toBeNull();
  });

  it('a venture with no record has no other idea: what they tell is its own', () => {
    expect(decide(input(idea, fresh())).newIdea).toBeNull();
    expect(decide(input(idea, fresh())).kind).toBe('coaching');
  });

  it('an idea its notes hold is not new', () => {
    expect(
      decide(
        input(
          idea,
          withHistory({
            recordText: 'They once planned a drone network to deliver insulin to rural clinics.',
          }),
        ),
      ).newIdea,
    ).toBeNull();
  });

  it('reads the sentence that tells it', () => {
    expect(ideaSentences('Hello! My idea is simple. Scooters that charge at bus stops.')).toHaveLength(2);
    expect(ideaSentences('What app do I use for notes?')).toEqual([]);
  });

  it('never names a workspace’s own reference code as a fact', () => {
    expect(concreteFact([memory({ type: 'fact', title: 'Code 12', content: 'CANARY::x' })])).toBeNull();
  });
});

describe('who they are, and the check-in', () => {
  it.each([
    "I've never done this before",
    'I don’t know anything about business',
    'first-time founder here',
    'This is my first startup',
  ])('%s: first time', (message) => {
    expect(saysFirstTime(message)).toBe(true);
    expect(decide(input(message, fresh())).firstTime).toBe(true);
  });

  it('what they said earlier counts; an experienced founder is never taken for one', () => {
    expect(decide(input('What next?', fresh({ background: ['I have never done this'] }))).firstTime).toBe(
      true,
    );
    const intake = {
      idea: '',
      customer: '',
      studies: '',
      experience: 'experienced' as const,
      hoursPerWeek: null,
      deadline: null,
      doneSoFar: '',
      block: '',
    };
    const path = {
      ventureId: VENTURE_ID,
      stage: 'idea' as const,
      intake,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    expect(
      decide(input('I have never done this kind of sale', fresh({ reads: { ...NO_READS, path } }))).firstTime,
    ).toBe(false);
  });

  const context = { today: TODAY };
  it('asks about the step given before today, with its due state, once at the start', () => {
    expect(checkInOf(context, [storedStep()])).toMatchObject({ title: storedStep().title, overdue: false });
    expect(checkInOf(context, [storedStep({ dueOn: '2026-11-23' })])?.overdue).toBe(true);
    expect(checkInOf(context, [storedStep({ createdAt: `${TODAY}T08:00:00Z` })])).toBeNull();
    expect(
      checkInOf(context, [storedStep({ createdAt: `${TODAY}T08:00:00Z`, dueOn: TODAY })]),
    ).not.toBeNull();
    expect(checkInOf(context, [storedStep({ status: 'done' })])).toBeNull();
    expect(checkInOf(context, [storedStep({ givenTo: 'x' })], 'y')).toBeNull();
    const path = {
      ventureId: VENTURE_ID,
      stage: 'discovery' as const,
      intake: null,
      intakeBy: null,
      pivots: [],
      playbookVersion: 'x',
      version: 1,
    };
    const over = fresh({ reads: { ...NO_READS, path, steps: [storedStep()] } });
    expect(decide(input('Hello, I am back for more', over)).checkIn).not.toBeNull();
    // An explicit ask is asked about the step they were on only when it is due.
    expect(decide(input('What should I charge?', over)).checkIn).toBeNull();
    const late = fresh({ reads: { ...NO_READS, path, steps: [storedStep({ dueOn: '2026-11-23' })] } });
    expect(decide(input('What should I charge?', late)).checkIn?.overdue).toBe(true);
    expect(decide(input('Hello, I am back for more', { ...over, started: true })).checkIn).toBeNull();
    expect(
      decide(
        input('Hello, I am back for more', {
          ...over,
          previousReply: 'Last Friday you were going to interview ten people about the last time.',
        }),
      ).checkIn,
    ).toBeNull();
  });

  it('knows when a text names the step', () => {
    expect(namesStep('Your next step is to interview ten people about last time', storedStep().title)).toBe(
      true,
    );
    expect(namesStep('Price it at what the problem costs.', storedStep().title)).toBe(false);
  });
});
