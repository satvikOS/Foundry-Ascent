/** Test fixtures for the founder path (synthetic data only). Imported by tests and by the e2e mocks, never by the app. */
import type { ArcEntry, PathIntake, PathStepView, TurnGuidance, VenturePath } from '@foundry/contracts';

export const PATH_IDS = {
  venture: '0b9d1f0e-6a0c-4f39-9d0e-5d3b8a1c2e01',
  now: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01',
  next: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02',
  later: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03',
  done: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c04',
  offered: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c07',
  memory: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c05',
  session: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c06',
} as const;

/** Far enough off to be neither today nor overdue, whenever the suite runs. */
export const DUE = '2099-12-04';

export function makeStep(overrides: Partial<PathStepView> = {}): PathStepView {
  return {
    id: PATH_IDS.now,
    playId: 'last-time-interviews',
    criterionId: 'five-real-stories',
    title: 'Hear five lab managers describe the last time they ran out of a reagent',
    items: [
      {
        do: 'List 20 lab managers you can reach',
        how: 'Start with your own department.',
        minutes: 30,
        done: true,
      },
      {
        do: 'Write to ten of them today',
        how: 'Two sentences; ask for 20 minutes.',
        minutes: 40,
        done: false,
      },
      {
        do: 'Ask about the last time, never the next',
        how: 'No pitch before minute 15.',
        minutes: 100,
        done: false,
      },
    ],
    doneWhen: 'Five people described the last time it happened, with dates.',
    dueOn: DUE,
    status: 'now',
    origin: 'path',
    evidence: null,
    template: { title: 'Interview invitation', body: 'Hi [name], I am studying how labs track reagents.' },
    citations: [
      {
        sourceId: 'mom-test',
        locator: 'Chapter 3',
        title: 'The Mom Test',
        authors: 'Rob Fitzpatrick',
        url: 'https://www.momtestbook.com/',
      },
      {
        sourceId: 'programme-discovery',
        locator: 'Module 2, unit 4',
        title: 'Ain programme: customer discovery',
        authors: 'Ain Center',
        url: null,
      },
    ],
    completedAt: null,
    version: 3,
    ...overrides,
  };
}

const ARC: ArcEntry[] = [
  {
    id: 'a3',
    kind: 'result',
    on: '2026-11-10',
    title: 'Two labs paid for a pilot',
    detail: '40 dollars per lab per month.',
    source: { kind: 'memory', id: PATH_IDS.memory },
  },
  {
    id: 'a1',
    kind: 'origin',
    on: '2026-09-02',
    title: 'Ran out of a reagent in the middle of an experiment',
    detail: null,
    source: { kind: 'profile', id: PATH_IDS.venture },
  },
  {
    id: 'a2',
    kind: 'pivot',
    on: '2026-10-05',
    title: 'From students to lab managers',
    detail: 'Managers hold the budget.',
    source: { kind: 'memory', id: PATH_IDS.memory },
  },
  {
    id: 'a4',
    kind: 'conversation',
    on: '2026-11-12',
    title: 'Pricing per lab',
    detail: null,
    source: { kind: 'session', id: PATH_IDS.session },
  },
];

export function makeIntake(overrides: Partial<PathIntake> = {}): PathIntake {
  return {
    idea: 'Reagent tracking for teaching labs',
    customer: 'Lab managers',
    studies: 'Chemical engineering',
    experience: 'first_time',
    hoursPerWeek: 8,
    deadline: { what: 'Pitch night', on: '2099-12-10' },
    doneSoFar: '',
    block: '',
    ...overrides,
  };
}

export function makePath(overrides: Partial<VenturePath> = {}): VenturePath {
  const now = makeStep();
  return {
    ventureId: PATH_IDS.venture,
    stage: 'discovery',
    stages: [
      {
        stage: 'idea',
        title: 'Idea',
        goal: 'Say who has the problem and what it costs them.',
        status: 'done',
        criteria: [
          {
            id: 'named-person',
            title: 'One named person has it',
            evidence: 'A real name and their week.',
            status: 'met',
          },
        ],
      },
      {
        stage: 'discovery',
        title: 'Discovery',
        goal: 'Prove the problem happens often, to people you can reach.',
        status: 'current',
        criteria: [
          {
            id: 'five-real-stories',
            title: 'Five real stories',
            evidence: 'Five people described the last time it happened.',
            status: 'claimed',
          },
          {
            id: 'cost-of-problem',
            title: 'What it costs them',
            evidence: 'A number each of three people gave.',
            status: 'open',
          },
        ],
      },
      { stage: 'validation', title: 'Validation', goal: 'Someone pays.', status: 'ahead', criteria: [] },
      {
        stage: 'business_model',
        title: 'Business model',
        goal: 'The numbers work.',
        status: 'ahead',
        criteria: [],
      },
      {
        stage: 'commercialization',
        title: 'Selling',
        goal: 'Sell it again and again.',
        status: 'ahead',
        criteria: [],
      },
      { stage: 'growth', title: 'Growth', goal: 'Grow what works.', status: 'ahead', criteria: [] },
      { stage: 'transition', title: 'After Ain', goal: 'Leave with a plan.', status: 'ahead', criteria: [] },
    ],
    now,
    next: [
      makeStep({
        id: PATH_IDS.next,
        title: 'Write down the three costs they named',
        status: 'next',
        criterionId: 'other',
        dueOn: null,
        items: [],
        template: null,
        version: 1,
      }),
      makeStep({
        id: PATH_IDS.later,
        title: 'Ask two of them to pay',
        status: 'later',
        criterionId: 'other-2',
        dueOn: null,
        items: [],
        template: null,
        version: 1,
      }),
    ],
    done: [
      makeStep({
        id: PATH_IDS.done,
        title: 'Name one person with the problem',
        status: 'done',
        criterionId: 'named-person',
        evidence: 'Dana in the chemistry building, every Monday.',
        completedAt: '2026-10-20T09:00:00.000Z',
        version: 5,
      }),
    ],
    intake: makeIntake(),
    arc: ARC,
    playbookVersion: '2026-11-24',
    version: 7,
    ...overrides,
  };
}

export function makeGuidance(overrides: Partial<TurnGuidance> = {}): TurnGuidance {
  const step = overrides.step === undefined ? makeStep() : overrides.step;
  return {
    intent: 'next-step',
    playId: 'last-time-interviews',
    stage: 'discovery',
    stageTitle: 'Discovery',
    stageNumber: 2,
    stageCount: 7,
    step,
    then: ['Write down the three costs they named'],
    referral: null,
    citations: step?.citations ?? [],
    ...overrides,
  };
}

/** The step that answers what they asked, offered beside the path's own. */
export function makeOfferedStep(overrides: Partial<PathStepView> = {}): PathStepView {
  return makeStep({
    id: PATH_IDS.offered,
    playId: 'price-test',
    criterionId: null,
    title: 'Quote one price to three labs this week',
    items: [
      { do: 'Write the price and what it covers', how: 'One sentence.', minutes: 15, done: false },
      {
        do: 'Say it to three labs and stay quiet',
        how: 'Write down what they answer.',
        minutes: 60,
        done: false,
      },
    ],
    doneWhen: 'Three labs heard the price and each answer is written down.',
    status: 'later',
    origin: 'coach',
    template: null,
    version: 1,
    ...overrides,
  });
}

/** A turn that answers what they asked with its own step, the path's step still open. */
export function makeOfferedGuidance(overrides: Partial<TurnGuidance> = {}): TurnGuidance {
  return makeGuidance({
    intent: 'price',
    playId: 'price-test',
    step: makeOfferedStep(),
    pathStep: makeStep(),
    offered: true,
    ...overrides,
  });
}
