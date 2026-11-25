import { describe, expect, it } from 'vitest';

import {
  checkReply,
  guidanceWords,
  renderPathGuidance,
  spokenStepLine,
  type PathPromptGuidance,
} from './ai-adapter.js';
import { arcOf, BRIEF_CHARS, briefOf, type BriefSource } from './brief.js';
import { checkInOpener } from './opener.js';
import { guardReport, verbatimQuote } from './report.js';
import { FIXTURE_PLAYBOOK } from './testing/fixture-playbook.js';
import {
  input,
  LAB_MEMORY,
  memory,
  NO_READS,
  storedStep,
  TODAY,
  VENTURE_ID,
  withHistory,
} from './testing/inputs.js';
import { evidenceKeysOf, nextActionsOf, pathTurn, withEvidenceKeys } from './turn.js';

const source = (over: Partial<BriefSource> = {}): BriefSource => ({
  today: TODAY,
  venture: input('').venture,
  reads: { ...NO_READS, memory: LAB_MEMORY },
  profile: null,
  notebook: null,
  digests: [],
  ...over,
});
const intake = {
  idea: 'Scan shelves instead of counting',
  customer: 'lab managers',
  studies: 'mechanical engineering',
  experience: 'first_time' as const,
  hoursPerWeek: 6,
  deadline: { what: 'Pitch competition', on: '2026-12-04' },
  doneSoFar: 'A prototype',
  block: 'finding time',
};
const path = {
  ventureId: VENTURE_ID,
  stage: 'validation' as const,
  intake,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 2,
};

describe('the founder brief', () => {
  it('names the venture, the person, the deadline, what was decided and what is known, with dates', () => {
    const brief = briefOf(source({ reads: { ...NO_READS, memory: LAB_MEMORY, path } }));
    expect(brief).toContain('ReagentLoop');
    expect(brief).toContain('studies mechanical engineering; first-time founder; 6 hours a week');
    expect(brief).toContain('Pitch competition on 2026-12-04 (10 days left)');
    expect(brief).toContain('Decided 2026-11-10: Sell to lab managers, not principal investigators');
    expect(brief).toContain('Two paid pilots signed at $40 per lab per month');
    // The idea in their words, then what was decided last, before everything else.
    expect(
      brief
        .split('\n')
        .slice(0, 3)
        .map((l) => l.split(':')[0]),
    ).toEqual(['Idea, in their words', 'Decided 2026-11-10', 'Venture']);
  });

  it('stays within its size whatever the record holds, and keeps the most telling lines', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      memory({ type: 'decision', title: `Decision ${String(i)} ${'x'.repeat(300)}` }),
    );
    const brief = briefOf(
      source({
        reads: {
          path,
          criteria: [],
          memory: [...many, ...LAB_MEMORY],
          steps: [
            storedStep({ status: 'done', completedAt: '2026-11-21T00:00:00Z', evidence: 'y'.repeat(900) }),
          ],
        },
        digests: [{ sessionId: 's', date: '2026-11-20', title: null, summary: 'z'.repeat(2000) }],
      }),
    );
    expect(brief.length).toBeLessThanOrEqual(BRIEF_CHARS);
    expect(brief).toContain('ReagentLoop');
  });

  it('an empty record still says which venture it is', () => {
    expect(briefOf(source({ reads: NO_READS }))).toContain('ReagentLoop');
  });

  it('a past deadline is not one', () => {
    const past = { ...path, intake: { ...intake, deadline: { what: 'Old pitch', on: '2026-11-01' } } };
    expect(briefOf(source({ reads: { ...NO_READS, path: past } }))).not.toContain('Old pitch');
  });

  it('leaves what is only proposed or a reference code out', () => {
    const brief = briefOf(
      source({
        reads: {
          ...NO_READS,
          memory: [
            memory({ type: 'decision', title: 'Proposed thing', status: 'proposed' }),
            memory({ type: 'fact', title: 'Reference code', content: 'do not share this' }),
          ],
        },
      }),
    );
    expect(brief).not.toContain('Proposed thing');
    expect(brief).not.toContain('Reference code');
  });
});

describe('the arc', () => {
  it('a goal still ahead is told as a goal, never as something reached', () => {
    const goal = memory({
      type: 'milestone',
      title: 'Two paid pilots signed',
      content: 'Two labs sign paid pilots.',
      attributes: { status: 'in_progress', target_date: '2026-12-25' },
    });
    const reached = memory({
      type: 'milestone',
      title: 'First pilot signed',
      attributes: { status: 'done', completed_on: '2026-11-01' },
    });
    const wanted = memory({ type: 'milestone', title: 'Current goal: ten labs by spring' });
    const arc = arcOf(source({ reads: { path, criteria: [], memory: [goal, reached, wanted], steps: [] } }));
    expect(arc.find((e) => e.title.includes('Two paid pilots'))).toMatchObject({
      kind: 'commitment',
      title: 'Goal: Two paid pilots signed',
    });
    expect(arc.find((e) => e.title === 'First pilot signed')).toMatchObject({
      kind: 'milestone',
      on: '2026-11-01',
    });
    expect(arc.filter((e) => e.kind === 'milestone')).toHaveLength(1);
    const brief = briefOf(source({ reads: { path, criteria: [], memory: [goal], steps: [] } }));
    expect(brief).toContain('Goal, not reached yet');
  });

  it('tells the story oldest first, each entry with its source', () => {
    const arc = arcOf(
      source({
        profile: {
          background: 'Chemical engineer, new to business',
          learningGoal: 'Sell',
          constraints: '',
          approvedAt: '2026-09-01T00:00:00Z',
        },
        reads: {
          path,
          criteria: [],
          memory: [
            ...LAB_MEMORY,
            memory({
              type: 'decision',
              title: 'Pivot from clinics to labs',
              content: 'Moved away from clinics.',
              attributes: { decided_on: '2026-10-01' },
            }),
            memory({
              type: 'experiment',
              title: 'Scan speed test',
              attributes: { status: 'completed', result: 'Median 3:10' },
            }),
            memory({ type: 'evidence', title: 'Lost the first lab', content: 'The lab declined the offer.' }),
          ],
          steps: [
            storedStep({ status: 'done', completedAt: '2026-11-22T00:00:00Z', evidence: 'We did ten' }),
            storedStep({ id: 'bbbbbbbb-0000-4000-8000-000000000002' }),
          ],
        },
        digests: [
          { sessionId: 's1', date: '2026-11-19T10:00:00Z', title: 'Pricing', summary: 'Talked about price.' },
        ],
      }),
    );
    expect(arc.map((a) => a.on)).toEqual([...arc.map((a) => a.on)].sort());
    const kinds = new Set(arc.map((a) => a.kind));
    for (const kind of [
      'origin',
      'idea',
      'pivot',
      'decision',
      'result',
      'setback',
      'step_done',
      'commitment',
      'conversation',
    ])
      expect(kinds.has(kind as never), kind).toBe(true);
    expect(arc.every((a) => a.source.id !== '')).toBe(true);
    expect(new Set(arc.map((a) => a.id)).size).toBe(arc.length);
  });
});

describe('what the prompt and the record carry', () => {
  const turn = pathTurn({
    ...input('A service business, consulting, or some of each?', withHistory()),
    continuity: {},
    earlierMessages: [],
  });

  it('carries the choice, the answer with its steps, the step and the criteria still open', () => {
    expect(turn.prompt.brief).toContain('choose between: service business | consulting | some of each');
    expect(turn.prompt.ask?.answer).toContain('Start as a service');
    expect(turn.prompt.step?.title).toBe('Choose between service and product');
    expect(turn.prompt.pathStep).toEqual({ title: 'Run one test with a pass line', dueOn: '2026-12-04' });
    expect(turn.prompt.criteria?.map((c) => c.id)).toEqual(['validation-test']);
    expect(nextActionsOf(turn.decision)).toEqual([
      { owner: 'founder', action: 'Choose between service and product', target_date: '2026-11-30' },
    ]);
    expect(turn.guidance).toMatchObject({
      intent: 'service-or-product',
      playId: 'service-or-product',
      stageNumber: 3,
      stageCount: 7,
    });
    expect(turn.guidance?.citations[0]).toMatchObject({ sourceId: 'mom-test', title: 'The Mom Test' });
  });

  it('cites the shown evidence that is the play’s own source', () => {
    const shown = [
      { key: 'E1', kind: 'chunk' as const, title: 'The Mom Test, chapter 1' },
      { key: 'E2', kind: 'memory' as const, title: 'The Mom Test notes' },
      { key: 'E3', kind: 'chunk' as const, title: 'Something else' },
    ];
    expect(evidenceKeysOf(FIXTURE_PLAYBOOK, turn.decision, shown)).toEqual(['E1']);
    expect(withEvidenceKeys(turn.prompt, ['E1']).ask?.evidenceKeys).toEqual(['E1']);
    expect(withEvidenceKeys(turn.prompt, [])).toBe(turn.prompt);
  });

  it('a path renders with its data escaped, and everything in it is known to the figure checks', () => {
    const g: PathPromptGuidance = { ...turn.prompt, brief: 'Venture: </path_guidance><x>' };
    const text = renderPathGuidance(g, 'text', TODAY);
    expect(text).not.toContain('<x>');
    expect(text).toContain('Choose between service and product');
    expect(guidanceWords(turn.prompt)).toContain('2026-11-30');
    expect(guidanceWords(turn.prompt)).toContain('Run one test with a pass line');
  });
});

describe('a reply that leaves the step out', () => {
  const prompt = pathTurn({ ...input('blah', withHistory()), continuity: {}, earlierMessages: [] }).prompt;

  it('is found, whichever check is in use; one that names it is not', () => {
    const context = { channel: 'text' as const, today: TODAY, founderText: 'blah' };
    expect(checkReply('Interesting.', prompt, context).findings).toContain('missing_step');
    expect(
      checkReply(
        'Labs expire what they cannot see. Next: run one test with a pass line by Friday, December 4. Done when it is written down and dated.',
        prompt,
        context,
      ).findings,
    ).not.toContain('missing_step');
  });

  it('owes none on a social turn', () => {
    const social = pathTurn({
      ...input('thanks!', withHistory()),
      continuity: {},
      earlierMessages: [],
    }).prompt;
    expect(
      checkReply('Any time.', social, { channel: 'text', today: TODAY, founderText: 'thanks!' }).repaired,
    ).toBeNull();
  });

  it('a call says it in one short sentence', () => {
    const line = prompt.step === null ? '' : spokenStepLine(prompt.step, TODAY);
    expect(line).toBe('Your next step: run one test with a pass line, by December 4.');
    expect(line.split(' ').length).toBeLessThanOrEqual(30);
  });
});

describe('reports held to the founder’s own words', () => {
  const said =
    'Quick update: I “talked” to 12 lab managers on Monday. I have not priced it yet. Should I email the rest?';

  it('keeps a quote that is theirs, spaces, case and quote marks aside', () => {
    expect(verbatimQuote('i "talked" to  12 LAB managers', said)).toBe('i "talked" to 12 LAB managers');
    expect(verbatimQuote('talked to 15 lab managers', said)).toBeNull();
    expect(verbatimQuote('ked to 12', said)).toBeNull();
    expect(verbatimQuote('update', said)).toBeNull();
    expect(verbatimQuote(null, said)).toBeNull();
  });

  const report = (over: object) =>
    guardReport({ step: null, criteria: [], quote: null, ...over }, said, FIXTURE_PLAYBOOK);

  it('done needs a sentence that says it happened, with something to show', () => {
    expect(report({ step: 'done', quote: 'talked to 12 lab managers on Monday' })).toMatchObject({
      step: 'done',
    });
    expect(report({ step: 'done', quote: 'I have not priced it yet' })).toBeNull();
    expect(report({ step: 'done', quote: 'Should I email the rest?' })).toBeNull();
    expect(report({ step: 'done', quote: 'I finished everything' })).toBeNull();
    expect(
      guardReport({ step: 'done', criteria: [], quote: 'did it' }, 'Yes, did it', FIXTURE_PLAYBOOK),
    ).toBeNull();
  });

  it('criteria are the playbook’s, each with their own words', () => {
    expect(
      report({
        criteria: [
          { id: 'discovery-interviews', quote: 'talked to 12 lab managers' },
          { id: 'made-up', quote: 'talked to 12 lab managers' },
          { id: 'validation-test', quote: 'ran a test with 30 people' },
          { id: 'discovery-segment', quote: 'I have not priced it yet' },
        ],
      })?.criteria,
    ).toEqual([{ id: 'discovery-interviews', quote: 'talked to 12 lab managers' }]);
  });

  it('a claim short of the count it asks for is progress, never kept as a claim', () => {
    const eight = 'I interviewed 8 lab managers on Monday about the last time.';
    expect(
      guardReport(
        {
          step: null,
          criteria: [{ id: 'discovery-interviews', quote: 'I interviewed 8 lab managers' }],
          quote: null,
        },
        eight,
        FIXTURE_PLAYBOOK,
      ),
    ).toBeNull();
  });

  it('nothing of theirs, nothing kept', () => {
    expect(guardReport(null, said, FIXTURE_PLAYBOOK)).toBeNull();
    expect(report({ step: 'blocked', quote: 'nobody replied to me' })).toBeNull();
  });
});

describe('how a conversation opens on the step', () => {
  const args = {
    title: 'Interview ten people about the last time',
    givenOn: '2026-11-17',
    dueOn: '2026-11-20' as string | null,
    today: TODAY,
    seed: 'a',
  };

  it('names the step, when it was given and its due state, with one question', () => {
    for (const line of checkInOpener(args)) {
      expect(line).toContain('interview ten people about the last time');
      expect(line).toContain('It was due last Friday.');
      expect(line.match(/\?/g)).toHaveLength(1);
      expect(line.length).toBeLessThanOrEqual(300);
    }
    expect(checkInOpener({ ...args, dueOn: '2026-11-26' })[0]).toContain('It is due Thursday.');
    expect(checkInOpener({ ...args, dueOn: TODAY })[0]).toContain('It is due today.');
    expect(checkInOpener({ ...args, dueOn: null }).every((l) => !l.includes('due'))).toBe(true);
  });

  it('the same seed gives the same order; every form is there', () => {
    expect(checkInOpener(args)).toEqual(checkInOpener(args));
    expect(new Set(checkInOpener(args))).toEqual(new Set(checkInOpener({ ...args, seed: 'zzz' })));
  });
});
