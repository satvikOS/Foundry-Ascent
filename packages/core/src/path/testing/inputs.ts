import { type pathRepo } from '@foundry/db';

import { type DecideInput } from '../engine.js';
import { FIXTURE_PLAYBOOK } from './fixture-playbook.js';

/** Inputs for the path's unit tests. 2026-11-24 is a Tuesday. */
export const TODAY = '2026-11-24';
export const VENTURE_ID = '11111111-1111-4111-8111-111111111111';

export const NO_READS: pathRepo.PathReads = { path: null, steps: [], criteria: [], memory: [] };

export function memory(
  m: Partial<pathRepo.PathMemory> & Pick<pathRepo.PathMemory, 'type' | 'title'>,
): pathRepo.PathMemory {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(Math.abs(hash(m.title)))
      .padStart(12, '0')
      .slice(0, 12)}`,
    content: '',
    attributes: {},
    status: 'confirmed',
    origin: 'founder',
    pinned: false,
    createdAt: '2026-11-10T09:00:00.000Z',
    ...m,
  };
}

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 33 + (ch.codePointAt(0) ?? 0)) % 999_999_999_999;
  return h;
}

export function storedStep(s: Partial<pathRepo.PathStepRecord> = {}): pathRepo.PathStepRecord {
  return {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    playId: 'ten-interviews',
    criterionId: 'discovery-interviews',
    title: 'Interview ten people about the last time',
    items: [{ do: 'List the people you can reach this week', how: '', minutes: 20, done: false }],
    doneWhen: 'Notes from 10 interviews, each about the last time.',
    dueOn: '2026-11-30',
    status: 'now',
    origin: 'path',
    evidence: null,
    reason: null,
    template: null,
    citations: [],
    givenTo: null,
    sourceSessionId: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    completedAt: null,
    version: 1,
    ...s,
  };
}

/** A venture with a record of its own (synthetic): a lab-inventory tool at the validation stage. */
export const LAB_MEMORY: pathRepo.PathMemory[] = [
  memory({
    type: 'decision',
    title: 'Sell to lab managers, not principal investigators',
    attributes: { decided_on: '2026-11-10' },
  }),
  memory({
    type: 'evidence',
    title: '15 interviews with lab managers',
    content: 'We interviewed 15 lab managers; 11 described the last time a reagent expired unused.',
    attributes: { n: 15, collected_on: '2026-10-20' },
  }),
  memory({
    type: 'evidence',
    title: 'Two paid pilots signed at $40 per lab per month',
    content: 'Two labs signed the pilot agreement and paid the first invoice.',
    attributes: { collected_on: '2026-11-15' },
  }),
  memory({
    type: 'fact',
    title: 'The pilot lab tracks 1,400 items in spreadsheets',
    content: 'Roughly 1,400 reagent and consumable items are in three shared spreadsheets.',
  }),
  memory({
    type: 'hypothesis',
    title: 'Managers will pay without procurement',
    content: 'We believe a discretionary budget covers it.',
  }),
];

export function input(message: string, over: Partial<DecideInput> = {}): DecideInput {
  return {
    playbook: FIXTURE_PLAYBOOK,
    ventureId: VENTURE_ID,
    venture: {
      name: 'ReagentLoop',
      stage: 'validation',
      oneLiner: 'Barcode-based reagent tracking for university research labs.',
      domain: 'software',
      currentGoal: 'Convert two of six labs to paid pilots.',
    },
    reads: NO_READS,
    today: TODAY,
    message,
    previousReply: null,
    mode: null,
    counterpart: null,
    conversationMode: null,
    crisis: false,
    riskCategories: [],
    recordText: '',
    background: [],
    started: false,
    ...over,
  };
}

export const withHistory = (over: Partial<DecideInput> = {}): Partial<DecideInput> => ({
  reads: { ...NO_READS, memory: LAB_MEMORY },
  ...over,
});

/** A venture that has just begun: nothing recorded, at the idea stage. */
export const fresh = (over: Partial<DecideInput> = {}): Partial<DecideInput> => ({
  venture: { name: 'New venture', stage: 'idea', oneLiner: '', domain: 'general', currentGoal: null },
  ...over,
});
