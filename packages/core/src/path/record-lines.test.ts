import { describe, expect, it } from 'vitest';

import { MAX_RECORD_LINES, recordLines, type RecordSource } from './record-lines.js';
import { memory, NO_READS, storedStep, TODAY, VENTURE_ID } from './testing/inputs.js';

const intake = {
  idea: 'I lend tide charts to kayakers',
  customer: 'Kayak clubs',
  studies: '',
  experience: 'first_time' as const,
  hoursPerWeek: 5,
  deadline: { what: 'The club meeting', on: '2026-12-04' },
  doneSoFar: 'I printed two charts',
  block: 'my printer',
};
const path = {
  ventureId: VENTURE_ID,
  stage: 'validation' as const,
  intake: null,
  intakeBy: null,
  pivots: [],
  playbookVersion: 'x',
  version: 2,
};
const lines = (over: Partial<RecordSource['reads']> = {}, continuity: RecordSource['continuity'] = {}) =>
  recordLines({ today: TODAY, reads: { ...NO_READS, ...over }, continuity });
const texts = (over: Partial<RecordSource['reads']> = {}, continuity: RecordSource['continuity'] = {}) =>
  lines(over, continuity).map((l) => l.text);

describe('the record as lines', () => {
  it('says each thing to them, in whole sentences, with every number it holds', () => {
    expect(
      texts({
        memory: [
          memory({
            type: 'fact',
            title: 'Price and costs',
            content: 'A chart is 14 dollars; paper is 3 and printing 1.50. We give one in ten away.',
          }),
          memory({
            type: 'evidence',
            title: 'Spring clubs',
            content: 'The founder showed it to nine clubs; four of them ordered.',
          }),
          memory({ type: 'decision', title: 'Season', content: 'Sell from March to October only' }),
        ],
      }),
    ).toEqual([
      'You showed it to nine clubs; four of them ordered.',
      'A chart is 14 dollars; paper is 3 and printing 1.50. You give one in ten away.',
      'You decided to sell from March to October only.',
    ]);
  });

  it('keeps the key, the kind, the day and the memory of each', () => {
    const m = memory({
      type: 'evidence',
      title: 'x',
      content: 'Four clubs paid in May.',
      attributes: { collected_on: '2026-05-20' },
    });
    expect(lines({ memory: [m] })).toEqual([
      { key: 'R1', kind: 'evidence', text: 'Four clubs paid in May.', on: '2026-05-20', memoryId: m.id },
    ]);
  });

  it('tells an experiment with its result, and one without as having none', () => {
    expect(
      texts({
        memory: [
          memory({
            type: 'experiment',
            title: 'Two paper sizes',
            content: 'We offered both at the pier.',
            attributes: {
              result: '7 of 12 took the small one',
              completed_on: '2026-11-12',
              status: 'completed',
            },
          }),
          memory({
            type: 'experiment',
            title: 'A waterproof chart',
            content: 'We plan to lend it to a club.',
          }),
          memory({
            type: 'experiment',
            title: 'The pier stall',
            content: 'Thirty people stopped, 11 took a chart home and 2 bought one.',
            createdAt: '2026-11-09T09:00:00.000Z',
          }),
        ],
      }),
    ).toEqual([
      'Your test, two paper sizes, came out so: 7 of 12 took the small one. You offered both at the pier.',
      'Your test, a waterproof chart, has no result yet. You plan to lend it to a club.',
      'Thirty people stopped, 11 took a chart home and 2 bought one.',
    ]);
  });

  it('is in order: the newest first, what they said of themself last', () => {
    const got = lines({
      path: {
        ...path,
        intake,
        pivots: [{ on: '2026-11-18', from: 'renting kayaks', to: 'lending tide charts', sessionId: null }],
      },
      memory: [
        memory({
          type: 'fact',
          title: 'a',
          content: 'One club has 40 members.',
          createdAt: '2026-11-01T09:00:00.000Z',
        }),
      ],
    });
    expect(got.map((l) => l.kind)).toEqual([
      'pivot',
      'fact',
      'idea',
      'customer',
      'done',
      'time',
      'deadline',
      'stuck',
      'founder',
    ]);
    expect(got[0]?.text).toBe(
      'You changed direction on November 18, from "renting kayaks" to "lending tide charts".',
    );
    expect(got.slice(2).map((l) => l.text)).toEqual([
      'You described your idea as: you lend tide charts to kayakers.',
      'You said it is for kayak clubs.',
      'You said of what is done so far: you printed two charts.',
      'You have 5 hours a week for it.',
      'Your deadline, the club meeting, is on December 4.',
      'You said you are stuck on your printer.',
      'You are doing this for the first time.',
    ]);
    expect(got.map((l) => l.key)).toEqual(got.map((_l, i) => `R${String(i + 1)}`));
  });

  it('leaves out what newer items replaced', () => {
    expect(
      texts({
        memory: [
          memory({ type: 'decision', title: 'Fee', content: 'charge 14 dollars a chart' }),
          memory({
            type: 'decision',
            title: 'Fee',
            content: 'charge 16 dollars a chart',
            createdAt: '2026-11-14T09:00:00.000Z',
          }),
          memory({
            type: 'relationship',
            title: 'Partner',
            content: 'Iva does the printing with the founder.',
          }),
          memory({
            type: 'relationship',
            title: 'Partner',
            content: 'Iva has left for a job in another city.',
            createdAt: '2026-11-15T09:00:00.000Z',
          }),
        ],
      }),
    ).toEqual(['Iva has left for a job in another city.', 'You decided to charge 16 dollars a chart.']);
  });

  it('keeps two of a kind that only share a label', () => {
    expect(
      texts({
        memory: [
          memory({
            type: 'evidence',
            title: 'Interview',
            content: 'One club secretary keeps tide times in a notebook.',
          }),
          memory({
            type: 'evidence',
            title: 'Interview',
            content: 'A guide lost 2 trips to wind in June.',
            createdAt: '2026-11-14T09:00:00.000Z',
          }),
        ],
      }),
    ).toHaveLength(2);
  });

  it('never shows a marker, a proposal, a course’s advice or a template', () => {
    expect(
      lines({
        memory: [
          memory({ type: 'fact', title: 'Reference', content: 'CANARY::abc do not share' }),
          memory({ type: 'fact', title: 'A guess', content: 'Clubs pay well.', status: 'proposed' }),
          memory({ type: 'fact', title: 'Advice', content: 'Founders should always talk to customers.' }),
          memory({ type: 'decision', title: '[your decision]', content: 'x' }),
          memory({ type: 'action', title: 'Ring the club', content: 'Ring the club.' }),
        ],
      }),
    ).toEqual([]);
  });

  it('names a label’s thing, and the founder as you', () => {
    expect(
      texts(
        {
          memory: [
            memory({ type: 'fact', title: 'Team', content: 'Runa Vik and Iva, both juniors' }),
            memory({
              type: 'hypothesis',
              title: 'Guides',
              content: 'We think that guides would pay double.',
            }),
            memory({ type: 'risk', title: 'Rain', content: 'Paper charts get wet in the rain.' }),
            memory({
              type: 'milestone',
              title: 'Harbour fair',
              content: 'Win the table at the harbour fair',
              attributes: { target_date: '2026-12-12' },
            }),
          ],
        },
        { founderFirstName: 'Runa' },
      ),
    ).toEqual([
      'On team, your record says: you and Iva, both juniors.',
      'A goal of yours, not reached yet by December 12: win the table at the harbour fair.',
      'You believe, and have not tested: guides would pay double.',
      'A risk you named: paper charts get wet in the rain.',
    ]);
  });

  it('tells what they reported and did, each once', () => {
    const criterion = {
      criterionId: 'c',
      status: 'claimed' as const,
      evidence: 'I rang six clubs. Two asked for a sample.',
      stepId: null,
      sourceSessionId: 's',
      updatedAt: '2026-11-20T09:00:00.000Z',
    };
    expect(
      texts(
        {
          criteria: [criterion, { ...criterion, criterionId: 'd' }],
          steps: [
            storedStep({
              status: 'done',
              title: 'Ring 6 clubs',
              evidence: 'I rang them all',
              completedAt: '2026-11-21T09:00:00.000Z',
            }),
            storedStep({
              status: 'blocked',
              title: 'Print it',
              reason: 'my printer broke',
              createdAt: '2026-11-19T09:00:00.000Z',
            }),
          ],
        },
        {
          notebook: {
            summary: '',
            founderProfile: [],
            openQuestions: [],
            commitments: [
              { text: 'Ring the harbour master', due: '2026-11-30', status: 'open' },
              { text: 'old', due: null, status: 'done' },
            ],
            nextOpener: '',
            lastAdvice: [],
          } as never,
        },
      ),
    ).toEqual([
      'You finished "Ring 6 clubs": you rang them all.',
      'You rang six clubs. Two asked for a sample.',
      'You are blocked on "Print it": your printer broke.',
      'You said you would: ring the harbour master (by November 30).',
    ]);
  });

  it('cuts at a sentence: never a half one from the column’s end', () => {
    const [first = ''] = texts({
      memory: [
        memory({
          type: 'fact',
          title: 'Long',
          content: `Clubs pay 14 dollars. ${'Then they ask for more and '.repeat(12)}`.slice(0, 280),
        }),
      ],
    });
    expect(first).toBe('Clubs pay 14 dollars.');
  });

  it('is bounded, and what tells the most stays', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      memory({
        type: i % 2 === 0 ? 'risk' : 'evidence',
        title: `Item ${String(i)}`,
        content: `Club number ${String(i)} of the ${'long '.repeat(40)}list paid ${String(100 + i)} dollars.`,
      }),
    );
    const got = lines({ memory: many });
    expect(got.length).toBeLessThanOrEqual(MAX_RECORD_LINES);
    expect(got.reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(6_000);
    expect(got.every((l) => l.kind === 'evidence')).toBe(true);
    expect(lines()).toEqual([]);
  });
});
