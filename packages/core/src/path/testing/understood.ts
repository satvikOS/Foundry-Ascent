import {
  buildSupportIndex,
  SentenceGate,
  validateCoachResponse,
  type Understanding,
  type UnderstoodSum,
} from '@foundry/ai';
import { type pathRepo } from '@foundry/db';

import { guidanceWords } from '../ai-adapter.js';
import { PLAYBOOK } from '../playbook/index.js';
import { pathTurn, type PathTurn, type PathTurnInput } from '../turn.js';
import { input, NO_READS, storedStep, TODAY } from './inputs.js';

/** A hand-made reading; every field has its empty form. */
export const understood = (over: Partial<Understanding> = {}): Understanding => ({
  ask: 'what to make of it',
  secondAsk: null,
  kind: 'question',
  also: [],
  record: [],
  contradicts: null,
  sums: [],
  missing: null,
  choice: null,
  result: null,
  referral: null,
  playId: null,
  stepPlayId: null,
  sure: false,
  points: [],
  firstAction: null,
  avoid: null,
  ...over,
});

export const sumOf = (over: Partial<UnderstoodSum> = {}): UnderstoodSum => ({
  label: 'what the market day left you',
  unit: '$',
  value: 187.5,
  said: '$187.50',
  working: '30 × ($8 − $1.25) − $15',
  asked: true,
  ...over,
});

/** A stored step of a play of the playbook, under way. */
export function onStep(playId: string, over: Partial<pathRepo.PathStepRecord> = {}): pathRepo.PathStepRecord {
  const play = PLAYBOOK.plays.find((p) => p.id === playId);
  if (play === undefined) throw new Error(playId);
  return storedStep({
    playId,
    criterionId: PLAYBOOK.criteria.find((c) => c.playId === playId)?.id ?? null,
    title: play.title,
    doneWhen: play.doneWhen,
    items: play.steps.map((s) => ({ do: s.do, how: s.how, minutes: s.minutes, done: false })),
    template: play.template,
    ...over,
  });
}

export function readTurnOf(
  message: string,
  understanding: Understanding | null,
  over: Partial<PathTurnInput> = {},
): PathTurn {
  return pathTurn({
    ...input(message, {
      playbook: PLAYBOOK,
      venture: {
        name: 'Plumline',
        stage: 'validation',
        oneLiner: 'Plum preserves from backyard trees, sold at weekend markets.',
        domain: 'food',
        currentGoal: null,
      },
      reads: NO_READS,
    }),
    continuity: {},
    earlierMessages: [],
    understanding,
    ...over,
  });
}

/** What the founder sees when the writer answers `model`: the same gate a streamed reply passes. */
export function replyOf(
  turn: PathTurn,
  message: string,
  model: string,
  channel: 'text' | 'voice' = 'text',
  known = '',
): string {
  const { prompt } = turn;
  const said = [message, prompt.said ?? '', known].join('\n');
  const knownFigures = `${said}\n${guidanceWords(prompt)}`;
  const support = buildSupportIndex({
    evidence: [],
    founderText: said,
    guidanceText: guidanceWords(prompt),
  });
  const gate = new SentenceGate({
    personaName: 'Thomas',
    mentor: true,
    otherVentureNames: [],
    otherVentureCanaries: [],
    founderText: message,
    guidance: prompt,
    today: TODAY,
    callerContinues: true,
    knownFigures,
    support,
    ...(channel === 'voice' ? { spoken: true, spokenWordBudget: 90 } : {}),
  });
  const units = [...gate.open().units, ...gate.push(model).units, ...gate.end().units];
  if (channel === 'voice') return units.map((u) => u.spoken).join(' ');
  const text = units.map((u) => u.text).join('');
  // What was streamed is what is stored.
  const kept = validateCoachResponse(
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
      founderText: message,
      guidance: prompt,
      today: TODAY,
      knownFigures,
      support,
      released: true,
    },
  ).response.answer;
  if (kept !== text.trim()) throw new Error(`stored otherwise:\n${text}\n---\n${kept}`);
  return text;
}
