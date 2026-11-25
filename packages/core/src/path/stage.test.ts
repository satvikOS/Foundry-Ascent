import { type pathRepo } from '@foundry/db';
import { describe, expect, it } from 'vitest';

import { decide, guidanceOf } from './engine.js';
import { hasEvidence, pathState, recordShowing } from './state.js';
import { PLAYBOOK } from './playbook/index.js';
import { input, memory, NO_READS, storedStep, VENTURE_ID } from './testing/inputs.js';

/** When a path moves: what the founder shows, or a change of the program's stage; never because something was noted. */
const VENTURE = {
  name: 'PatchPorch',
  stage: 'validation' as const,
  oneLiner: 'PatchPorch lends sewing machines to students who mend their own clothes.',
  domain: 'consumer',
  currentGoal: 'Get five people to borrow a machine.',
};
const note = (
  over: Partial<pathRepo.PathMemory> & Pick<pathRepo.PathMemory, 'type' | 'title'>,
): pathRepo.PathMemory => memory({ origin: 'ai', vouched: false, ...over });
const at = (reads: Partial<pathRepo.PathReads>, venture: Partial<typeof VENTURE> = {}) =>
  input('What should I do next?', {
    playbook: PLAYBOOK,
    venture: { ...VENTURE, ...venture },
    reads: { ...NO_READS, ...reads },
  });
const path = (over: Partial<pathRepo.PathRecord> = {}): pathRepo.PathRecord => ({
  ventureId: VENTURE_ID,
  stage: 'idea',
  intake: null,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 1,
  programStage: 'validation',
  ...over,
});
const stageOf = (i: ReturnType<typeof at>) => pathState(PLAYBOOK, i).stage;

const IDEA_AGAIN = note({
  type: 'fact',
  title: 'What PatchPorch does',
  content: 'PatchPorch lends sewing machines to students who want to mend their clothes.',
});
const ONLY_PLANS = [
  note({ type: 'milestone', title: 'Five borrowers', content: 'The founder plans to get five borrowers.' }),
  note({
    type: 'decision',
    title: 'First price',
    content: 'The founder is thinking of charging $4 a night and will test the price.',
  }),
  note({
    type: 'fact',
    title: 'Ten interviews next',
    content: 'The founder wants to have interviewed 10 students by Friday.',
  }),
  note({ type: 'evidence', title: 'Prototype', content: 'The idea is a prototype box with one machine.' }),
];

describe('a path moves by what the founder shows', () => {
  it('a note the mentor kept by itself is no evidence, before the path has begun or after', () => {
    for (const memories of [[IDEA_AGAIN], ONLY_PLANS, [IDEA_AGAIN, ...ONLY_PLANS]]) {
      expect(stageOf(at({ memory: memories }))).toBe('idea');
      expect(stageOf(at({ memory: memories, path: path() }))).toBe('idea');
      expect(hasEvidence(PLAYBOOK, at({ memory: memories }))).toBe(false);
      for (const c of pathState(PLAYBOOK, at({ memory: memories, path: path() })).criteria)
        expect([c.criterion.id, c.status]).toEqual([c.criterion.id, 'open']);
    }
  });

  it('asked the same in three conversations with notes kept in between, the step is the same one', () => {
    const asked = [[], [IDEA_AGAIN], [IDEA_AGAIN, ...ONLY_PLANS]].map((m, i) =>
      decide(at({ memory: m, ...(i === 0 ? {} : { path: path() }) })),
    );
    expect(new Set(asked.map((d) => d.step?.view.id)).size).toBe(1);
    expect(new Set(asked.map((d) => d.state.stage))).toEqual(new Set(['idea']));
  });

  it('the first turn that gives a step begins the path; a greeting does not', () => {
    expect(decide(at({})).begins).toBe(true);
    expect(decide(at({ path: path() })).begins).toBe(false);
    expect(decide({ ...at({}), message: 'hi there!' }).begins).toBe(false);
    // An ask whose step is only offered begins it too, where it stands.
    const offered = decide({ ...at({}), message: 'Should I keep going with this or stop?' });
    expect([offered.offered, offered.begins, offered.state.stage]).toEqual([true, true, 'idea']);
  });

  it('“keep going or stop?” gives the same first test until one is reported, whatever is noted', () => {
    const ask = (reads: Partial<pathRepo.PathReads>) =>
      decide({ ...at(reads), message: 'Should I keep going with this or stop?' });
    const steps = [
      ask({}),
      ask({ path: path(), memory: [IDEA_AGAIN] }),
      ask({ path: path(), memory: ONLY_PLANS }),
    ];
    expect(new Set(steps.map((d) => d.step?.view.id)).size).toBe(1);
    expect(steps[0]?.step?.view.playId).toBe('smallest-test');
  });

  it('a smaller form of an offered step is kept as it was shown, and asked again it is that step', () => {
    const first = decide({ ...at({}), message: 'Should I keep going with this or stop?' });
    const previous = guidanceOf(PLAYBOOK, first);
    const less = decide({
      ...at({ path: path() }),
      message: 'That is too much, I only have an hour.',
      previous,
      previousReply: 'Run one small test.',
      started: true,
    });
    expect([less.offered, less.keeps?.write]).toEqual([true, 'insert']);
    const cut = less.keeps?.view;
    if (cut === undefined) throw new Error('kept');
    expect(cut.status).toBe('later');
    expect(cut.items.length).toBeLessThanOrEqual(first.step?.view.items.length ?? 0);
    const row = storedStep({ ...cut, createdAt: '2026-11-24T09:00:00.000Z' });
    const again = (today: string) =>
      decide({
        ...at({ path: path(), steps: [row] }),
        today,
        message: 'Should I keep going with this or stop?',
      });
    expect(again('2026-11-24').step?.view).toMatchObject({ id: cut.id, doneWhen: cut.doneWhen });
    // A day that passed is one they can still make; nothing of it is on their path.
    const later = again('2026-12-08');
    expect(later.step?.view.doneWhen).toBe(cut.doneWhen);
    expect((later.step?.view.dueOn ?? '') >= '2026-12-08').toBe(true);
    expect([later.offered, later.pathStep?.playId]).toEqual([true, 'idea-on-a-page']);
  });

  it('work a note tells was done counts for its own criterion, and lifts nothing else', () => {
    const talked = note({
      type: 'evidence',
      title: '12 students interviewed',
      content: 'The founder interviewed 12 students; 9 described the last time a zip broke on a coat.',
    });
    const state = pathState(PLAYBOOK, at({ memory: [talked], path: path() }));
    expect(state.stage).toBe('idea');
    expect(state.criteria.find((c) => c.criterion.id === 'discovery-ten-conversations')?.status).toBe(
      'claimed',
    );
    // Before any path has begun, it is history of the venture's own.
    expect(hasEvidence(PLAYBOOK, at({ memory: [talked] }))).toBe(true);
  });

  it('a note a person approved or corrected, or one they wrote, is a record like any other', () => {
    expect(stageOf(at({ memory: [{ ...IDEA_AGAIN, vouched: true }] }))).toBe('validation');
    expect(stageOf(at({ memory: [memory({ ...IDEA_AGAIN, origin: 'founder' })] }))).toBe('validation');
    // Once the path has begun, a record moves it only through what it shows.
    expect(
      stageOf(
        at({ path: path(), memory: [memory({ type: 'fact', title: 'A fact', content: 'It rained.' })] }),
      ),
    ).toBe('idea');
  });

  it('a decision kept from a conversation counts when it says it was made, never as a plan', () => {
    const price = PLAYBOOK.criteria.find((c) => c.id === 'model-price');
    if (price === undefined) throw new Error('criterion');
    const decided = (content: string) => note({ type: 'decision', title: 'Price of a night', content });
    expect(recordShowing(price, [decided('The founder decided on a price of $4 a night.')])).not.toBeNull();
    expect(recordShowing(price, [decided('The price is planned at $4 a night.')])).toBeNull();
    expect(recordShowing(price, [decided('A price of $4 a night could work.')])).toBeNull();
    // What a person recorded as decided stands.
    expect(
      recordShowing(price, [{ ...decided('A price of $4 a night.'), origin: 'founder' }]),
    ).not.toBeNull();
  });
});

describe('a path moves with the program’s stage only when it changed', () => {
  it('a path begun at the idea stays there while the program’s stage is the one it began with', () => {
    expect(stageOf(at({ path: path() }))).toBe('idea');
    const history = [memory({ type: 'fact', title: 'A box of zips', content: 'We own a box of zips.' })];
    expect(stageOf(at({ path: path(), memory: history }))).toBe('idea');
  });

  it('a later stage the program set since moves it; an earlier one does not move it back', () => {
    expect(stageOf(at({ path: path({ programStage: 'idea' }) }))).toBe('validation');
    expect(
      stageOf(
        at({ path: path({ stage: 'validation', programStage: 'validation' }) }, { stage: 'validation' }),
      ),
    ).toBe('validation');
    const back = input('', {
      playbook: PLAYBOOK,
      venture: { ...VENTURE, stage: 'idea' },
      reads: { ...NO_READS, path: path({ stage: 'discovery' }) },
    });
    expect(pathState(PLAYBOOK, back).stage).toBe('discovery');
  });

  it('a path of before the column, or read without it, stays where it is', () => {
    expect(stageOf(at({ path: path({ programStage: null }) }))).toBe('idea');
    const { programStage: _unknown, ...old } = path();
    expect(stageOf(at({ path: old }))).toBe('idea');
  });

  it('a change of direction takes the program’s stage of that day: only a later change counts', () => {
    const d = decide({
      ...at({
        path: path({
          stage: 'validation',
          programStage: 'idea',
          intake: {
            idea: 'lend sewing machines to students',
            customer: '',
            studies: '',
            experience: null,
            hoursPerWeek: null,
            deadline: null,
            doneSoFar: '',
            block: '',
          },
        }),
      }),
      message: "I'm changing direction. No machines: a mending class in the library instead.",
    });
    expect(d.pivot).not.toBeNull();
    expect(d.state.stage).toBe('discovery');
  });

  it('records from before the path keep the stage it began at, and the earlier criteria with it', () => {
    const history = [
      memory({ type: 'evidence', title: 'Two lenders', content: 'Two halls lent us a room.' }),
    ];
    const begun = pathState(PLAYBOOK, at({ memory: history }));
    expect(begun.stage).toBe('validation');
    const later = pathState(PLAYBOOK, at({ memory: history, path: path({ stage: begun.stage }) }));
    expect(later.stage).toBe('validation');
    expect(later.criteria.find((c) => c.criterion.id === 'idea-one-page')).toMatchObject({
      status: 'claimed',
      by: 'stage',
    });
  });
});
