import { buildSystemPromptParts, type HistoryTurn, type PromptContinuity } from '@foundry/ai';
import { DEFAULT_DISCLOSURE } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { assembleContext } from './context-budget.js';
import { renderLeftOffSection, type LeftOffData } from './continuity-prompt.js';
import { leftOffThreads } from './continuity.js';

/*
 * The context a production call's turns were written from (2026-11-07), rebuilt with the turn's own builders on a
 * synthetic notebook of the same shape: a returning founder, an open commitment and open questions about a device's
 * class, how clinics pay and who owns the budget, a call that opened on a bare invitation. The founder named a goal, gave
 * a vague answer, then a short one; every reply was a question, and the third asked the first one again. The prompt
 * rules already said "follow the founder": what each turn carried did not. These pin what each turn now carries.
 */

const AT = '2026-11-03T10:00:00.000Z';
const NOW = new Date('2026-11-07T14:22:00Z');

const CONTINUITY: PromptContinuity = {
  founderFirstName: 'Noor',
  notebook: {
    summary:
      'Noor is taking a plantar-pressure insole to foot clinics and met a clinical-innovation advisor.',
    founderProfile: [
      {
        id: 'fp-1',
        text: 'Prefers direct answers and actionable steps',
        sourceSessionId: null,
        createdAt: AT,
      },
      {
        id: 'fp-2',
        text: 'Does not report what experts told them; stays vague even when pressed',
        sourceSessionId: null,
        createdAt: AT,
      },
    ],
    commitments: [
      {
        id: 'c-1',
        text: 'Follow up with the clinical-innovation advisor on device class, the billing route and the budget owner',
        due: '2026-11-01',
        status: 'open',
        sourceSessionId: null,
        createdAt: AT,
      },
    ],
    openQuestions: [
      { id: 'q-1', text: 'Which device class the insole falls into', sourceSessionId: null, createdAt: AT },
      {
        id: 'q-2',
        text: 'Whether monitoring time is billable under existing codes',
        sourceSessionId: null,
        createdAt: AT,
      },
    ],
    lastAdvice: [],
    nextOpener: null,
    nextTopic: null,
    updatedAt: AT,
  },
};

const LEFT_OFF: LeftOffData = {
  conversations: [
    {
      sessionId: 's-small-talk',
      withCaller: true,
      teammateFirstName: null,
      withThisVeir: true,
      title: 'A quick hello',
      channel: 'call',
      lastActivityAt: AT,
      ended: true,
      digest: {
        summary: 'A short hello with no venture topic.',
        topics: [],
        commitments: [],
        openQuestions: [],
      },
      exchanges: [],
    },
  ],
};

const OPENER = 'Nice to see you. What feels most pressing right now?';
const FOUNDER = [
  'taking the insole to market',
  'there are a few layers of sign-off to get through',
  "I don't know, I didn't do that",
];
const REPLIES = [
  'Got it. Walk me through where you are with the regulatory path: what did the advisor tell you about device class and how clinics would pay?',
  'So there is a process. Who sits in those layers, and what does each one sign off on?',
];

/** The user message of turn `n` (0-based) as the turn assembles it: "Where you left off", the notes, the state. */
function turnMessage(n: number): string {
  const history: HistoryTurn[] = REPLIES.slice(0, n).map((answer, i) => ({
    founderText: FOUNDER[i] ?? '',
    answer,
  }));
  const founderText = FOUNDER[n] ?? '';
  const prompt = buildSystemPromptParts({
    release: {
      version: 2,
      personaName: 'Thomas',
      mentor: true,
      disclosureText: DEFAULT_DISCLOSURE,
      doctrine: {
        summary: 'Answer first, then teach.',
        frameworks: [],
        typicalQuestions: [],
        evidenceStandard: 'What people did.',
        redLines: [],
        escalationTopics: [],
        referralDestinations: [],
        teachingPrinciples: [],
      },
      style: {
        directness: 'direct',
        warmth: 'warm',
        pace: 'brisk',
        vocabulary: [],
        feedbackStructure: '',
        avoid: [],
      },
    },
    mode: 'auto',
    allowedModes: ['diagnose', 'coach', 'teach'],
    policy: { riskCategories: [], groundingThreshold: 0.6 },
    ventureContext: { name: 'Stepwise', stage: 'business_model', domain: 'medtech', currentGoal: null },
    today: '2026-11-07',
    channel: 'voice',
    continuity: CONTINUITY,
  });
  const leftOff = renderLeftOffSection(LEFT_OFF, {
    now: NOW,
    threads: leftOffThreads(CONTINUITY, {
      founderText,
      said: [...history.map((t) => t.answer), OPENER],
      started: true,
    }),
  });
  const context = assembleContext({
    system: `${prompt.stable}${prompt.turn}`,
    evidence: [],
    history,
    founderText,
    maxInputTokens: 24_000,
    maxHistoryTurns: 8,
    continuity: CONTINUITY,
    leftOff,
    today: '2026-11-07',
    opener: OPENER,
  });
  return context.messages.at(-1)?.content ?? '';
}

describe('what each turn of the production call now carries (2026-11-07)', () => {
  it('the goal turn: teach and prepare, and no agenda of open threads around it', () => {
    const message = turnMessage(0);
    expect(message).toContain('teach and prepare. Most of the reply is how it usually works');
    // The notebook's threads were in "Where you left off" on every turn while the notes left them out.
    expect(message).not.toContain('<open_threads>');
    expect(message).not.toContain('<open_commitments>');
    // How they like to work stays; a verdict on them never reaches the model.
    expect(message).toContain('Prefers direct answers and actionable steps');
    expect(message).not.toContain('even when pressed');
  });

  it('after two replies that were questions, the next one gives substance and asks nothing', () => {
    expect(turnMessage(2)).toContain(
      'this one gives substance (a teaching point,\n  a draft or your view) and ends without a question.',
    );
  });

  it('a founder with no answer: never asked again, taught how it usually goes instead', () => {
    const message = turnMessage(2);
    expect(message).toContain('Never ask it again, in any words.');
    expect(message).toContain('- You already asked:');
    // The threads they had no answer for are marked as raised, so the notes never push them again this conversation.
    expect(message).toContain('<open_threads>');
    expect(message).toContain(
      'device class, the billing route and the budget owner (due 2026-11-01) [already raised',
    );
  });

  it('lists the open threads at the start of a conversation, before the founder brings a subject', () => {
    const threads = leftOffThreads(CONTINUITY, { founderText: 'hi', said: [], started: false });
    expect(threads?.commitments).toHaveLength(1);
    expect(threads?.questions).toHaveLength(2);
    expect(threads?.raised).toEqual([]);
  });
});
