import {
  askedBefore,
  buildSystemPromptParts,
  stuckOn,
  withoutRepeats,
  type HistoryTurn,
  type PromptContinuity,
} from '@foundry/ai';
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
        sourceSessionId: 's-earlier-call',
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

/**
 * The user message of turn `n` (0-based) as the turn assembles it: "Where you left off", the notes, the state.
 * `said`: what the founder says on that turn instead of the call's words.
 */
function turnMessage(n: number, said?: string): string {
  const history: HistoryTurn[] = REPLIES.slice(0, n).map((answer, i) => ({
    founderText: FOUNDER[i] ?? '',
    answer,
  }));
  const founderText = said ?? FOUNDER[n] ?? '';
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
      previousReply: history.at(-1)?.answer ?? OPENER,
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

  it.each([
    [2, undefined],
    [1, 'i dont know'],
    [1, 'i didnt do that'],
    [1, "it didn't come up"],
  ] as const)(
    'a founder with no answer (turn %i, %j): never asked again, taught how it usually goes instead',
    (n, said) => {
      const message = turnMessage(n, said);
      expect(message).toContain('Never ask it again, in any words.');
      expect(message).toContain('- You already asked:');
      // The notebook's agenda is left out of that turn: it would offer up the very question they could not answer, in
      // other words (the open question on billing, the commitment's "ask how it went"; review of the 2026-11-07 fix).
      expect(message).not.toContain('<open_threads>');
      expect(message).not.toContain('<open_commitments>');
      expect(message).not.toContain('<open_questions>');
      expect(message).not.toContain('billable under existing codes');
      expect(message).not.toContain('ask how it went');
      expect(message).toContain('Prefers direct answers and actionable steps');
    },
  );

  it.each([
    'we didnt look into it',
    'didnt get to it',
    'havent gotten to it',
    'never got around to it',
    'i dont know man',
    'nope havent',
    'i dont know who pays',
    'i dint do that',
    'not a clue',
    'i got no idea',
    'i dont have that info',
    'havent figured that out',
    'not something i looked at',
  ])(
    "the call's third turn after %j: never asked again, in the prompt and in the reply (review, round 3)",
    (said) => {
      const message = turnMessage(2, said);
      expect(message).toContain('Never ask it again, in any words.');
      expect(message).not.toContain('<open_questions>');
      expect(message).not.toContain('billable under existing codes');
      const [r1, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(true);
      const reply = withoutRepeats(
        'Okay. Is monitoring time reimbursable under existing CPT codes?',
        [r2, r1, OPENER].join('\n\n'),
        { strictQuestions: stuckOn(said, r2), asked: askedBefore(r2, [r1, OPENER]) },
      );
      expect(reply.removed).toEqual(['Is monitoring time reimbursable under existing CPT codes?']);
      // On the second turn too, right after the first question.
      expect(turnMessage(1, said)).toContain('Never ask it again, in any words.');
    },
  );

  // Review of the 2026-11-07 fix, round 4: a no-answer is read by its shape after a question, not by a list of its
  // wordings (each round of review found new ones). Synthetic casual wordings: typos, no apostrophes, third parties who
  // have not replied, objects named as nouns.
  const NO_ANSWERS = [
    'i didnt talk to the advisor',
    'he hasnt gotten back to me',
    'i wasnt able to',
    'i dont rly know',
    'i havent spoken to him',
    'they never replied',
    'nah not really',
    'no word from him yet',
    'still waiting on him',
    'havent had the meeting',
    'i didnt ask him abt the codes',
    'she hasnt responded',
    'nobody got back to me',
    'idk tbh hes been quiet',
    'i never followed up w him',
    'not sure, never asked',
    'i didnt get round to the email',
    'didnt hear anything back',
    'the advisor hasnt said anything',
    'havent looked at the reimbursement stuff',
    'i couldnt reach her',
    'they didnt get back to us',
    'no clue honestly',
    'i dont have the class info',
    'we havent booked the call yet',
    'nope, havent done the reading',
    'he never emailed back',
    'i honestly dont remember',
    'nothing so far',
    'i didnt follow up on the billing question',
    'werent able to meet',
    'i didnt manage to call the clinic',
    'the meeting didnt happen',
    'i hvnt asked',
    'i didnt get a chance w the advisor',
    'the clinic never answered my email',
    'not something we got to',
    'ugh no i totally spaced on it',
    'no reply from the clinic yet',
    'i cldnt find anything on it',
  ];
  // Answers of their own, a request to say the question again, and a change of subject: never a no-answer.
  const REAL_ANSWERS = [
    'he said its not class III',
    'no, its class II',
    'not yet but we have a call friday',
    'i didnt get that',
    'he said probably class 2',
    'they told me clinics bill it under 99091',
    'not class III, more like class II',
    'we dont sell to hospitals, only clinics',
    'no because the device is low risk',
    'nope, maybe next month',
    'not really, its exempt',
    'she thinks its exempt',
    'he didnt name one but said its class II',
    'i dont know if clinics will pay for it',
    'i didnt understand the question',
    'the advisor never said, but clinics pay per scan',
    'i havent, can we talk about hiring instead',
    'department heads mostly, not the clinicians',
    'we did talk, he wants a demo first',
    'not the patients, the clinic pays',
  ];

  it('pins forty casual no-answers and twenty answers of their own', () => {
    expect(NO_ANSWERS).toHaveLength(40);
    expect(new Set(NO_ANSWERS).size).toBe(40);
    expect(REAL_ANSWERS).toHaveLength(20);
  });

  it.each(NO_ANSWERS)(
    "the call's third turn after %j: never asked again, in the prompt and in the reply (round 4: by its shape)",
    (said) => {
      const [r1, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(true);
      const message = turnMessage(2, said);
      expect(message).toContain('Never ask it again, in any words.');
      expect(message).not.toContain('<open_questions>');
      expect(message).not.toContain('billable under existing codes');
      const reply = withoutRepeats(
        'Okay. Is monitoring time reimbursable under existing CPT codes?',
        [r2, r1, OPENER].join('\n\n'),
        { strictQuestions: stuckOn(said, r2), asked: askedBefore(r2, [r1, OPENER]) },
      );
      expect(reply.removed).toEqual(['Is monitoring time reimbursable under existing CPT codes?']);
    },
  );

  it.each(REAL_ANSWERS)(
    "the call's third turn after %j: an answer of their own, never a no-answer",
    (said) => {
      const [, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(false);
      expect(turnMessage(2, said)).not.toContain('Never ask it again, in any words.');
    },
  );

  it('marks the threads a reply raised by their subject, and never asks how a raised commitment went', () => {
    // "how clinics would pay" raised the open question on billing, which shares no word with it.
    const threads = leftOffThreads(CONTINUITY, {
      founderText: 'Sure.',
      said: [REPLIES[0] ?? '', OPENER],
      started: true,
    });
    expect(threads?.raised).toEqual([
      'Follow up with the clinical-innovation advisor on device class, the billing route and the budget owner',
      'Which device class the insole falls into',
      'Whether monitoring time is billable under existing codes',
    ]);
    const message = turnMessage(1, 'Sure.');
    expect(message).toContain(
      'device class, the billing route and the budget owner (due 2026-11-01) [already raised',
    );
    expect(message).not.toContain('ask how it went');
  });

  it('lists the open threads at the start of a conversation, before the founder brings a subject', () => {
    const threads = leftOffThreads(CONTINUITY, { founderText: 'hi', said: [], started: false });
    expect(threads?.commitments).toHaveLength(1);
    expect(threads?.questions).toHaveLength(2);
    expect(threads?.raised).toEqual([]);
  });
});
