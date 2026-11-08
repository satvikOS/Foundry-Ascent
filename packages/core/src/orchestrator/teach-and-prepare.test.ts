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
      expect(message).toContain('do not ask it again in any words');
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
      expect(message).toContain('do not ask it again in any words');
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
      expect(turnMessage(1, said)).toContain('do not ask it again in any words');
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
    'i didnt get that',
    'he said probably class 2',
    'they told me clinics bill it under 99091',
    'not class III, more like class II',
    'we dont sell to hospitals, only clinics',
    'no because the device is low risk',
    'not really, its exempt',
    'she thinks its exempt',
    'he didnt name one but said its class II',
    'i dont know if clinics will pay for it',
    'i didnt understand the question',
    'the advisor never said, but clinics pay per scan',
    'department heads mostly, not the clinicians',
    'we did talk, he wants a demo first',
    'not the patients, the clinic pays',
  ];

  it('pins forty casual no-answers and seventeen answers of their own', () => {
    expect(NO_ANSWERS).toHaveLength(40);
    expect(new Set(NO_ANSWERS).size).toBe(40);
    expect(REAL_ANSWERS).toHaveLength(17);
  });

  // Review of the 2026-11-07 fix, round 8: a time, a reason or a hedge beside an explicit no-answer, or a subject of
  // their own after it, never vetoes it; they are followed to what they bring, and never asked the question again.
  it.each([
    'not yet but we have a call friday',
    'nope, maybe next month',
    'i havent, can we talk about hiring instead',
  ])("the call's third turn after %j: an explicit no-answer that moves on, never asked again", (said) => {
    const [r1, r2] = REPLIES as [string, string];
    expect(stuckOn(said, r2)).toBe(true);
    const message = turnMessage(2, said);
    expect(message).toMatch(
      /do not ask it again in any words|Never ask\s+the earlier question again, in any words/,
    );
    const reply = withoutRepeats(
      'Okay. Is monitoring time reimbursable under existing CPT codes?',
      [r2, r1, OPENER].join('\n\n'),
      { strictQuestions: stuckOn(said, r2), asked: askedBefore(r2, [r1, OPENER]) },
    );
    expect(reply.removed).toEqual(['Is monitoring time reimbursable under existing CPT codes?']);
  });

  it.each(NO_ANSWERS)(
    "the call's third turn after %j: never asked again, in the prompt and in the reply (round 4: by its shape)",
    (said) => {
      const [r1, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(true);
      const message = turnMessage(2, said);
      expect(message).toContain('do not ask it again in any words');
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
      expect(turnMessage(2, said)).not.toContain('do not ask it again in any words');
    },
  );

  // Review of the 2026-11-07 fix, round 5: the shape took any short negated clause as a no-answer, so an answer said as
  // a negation was read as "they do not know". A no-answer now says who did not do what. Forty casual no-answers of our
  // own (typos, no apostrophes, third parties who went quiet, a bare "nope" to a wh-question, noun-phrase objects) and
  // twenty answers said as negations.
  const ROUND5_NO_ANSWERS = [
    'nah',
    'nope',
    'ummm no',
    'no one has told me',
    'zero idea',
    'totally forgot tbh',
    'i blanked on it',
    'the advisor ghosted me lol',
    'the meeting got cancelled',
    'he went quiet after the first meeting',
    'she said shed get back to me but hasnt',
    'idk, ask me next week',
    'i emailed him but he never replied',
    'didnt get a chance to ask abt billing',
    'havnt talked to anyone about the codes',
    'my advisor hasnt replied to my email',
    'dr lee never got back to me',
    'i cant reach him',
    'we havent had time to look into reimbursement',
    'nobody at the clinic has said',
    'i dont knw',
    'dunno tbh',
    'not sure tbh',
    'he said hed get back to me',
    'the call got pushed',
    'i didnt bring up the device class',
    'werent able to get hold of him',
    'i ddint ask him that',
    'honestly no clue',
    'havent heard back from the clinic',
    'i never did the reimbursement research',
    'we didnt discuss billing at all',
    'he hasnt confirmed anything',
    'no news from the advisor',
    'i havent got the details yet',
    'they never answered',
    'it slipped my mind',
    'i havent checked the cpt stuff',
    'i couldnt find out',
    'still waiting to hear from her',
  ];
  const ROUND5_REAL_ANSWERS = [
    'insurance doesnt cover it',
    'medicare wont pay for it',
    'theres no code for it',
    'none of the clinics bill for it',
    'it doesnt need fda clearance',
    'we dont have a predicate device',
    'not reimbursable as far as i know',
    'the clinics wont pay unless insurance does',
    'nah the insurer pays not the clinic',
    'i dont think anyone pays for monitoring now',
    'no clinic ive talked to pays out of pocket',
    'insurance pays, not the clinic',
    'no, the clinic bills it monthly',
    'they dont pay for the time, only the device',
    'its not reimbursable yet',
    'nope, the clinic pays cash',
    'he didnt think it needs clearance',
    'none of them want to pay',
    'we dont have a billing code yet',
    'i didnt need to ask, its in the guidance',
  ];

  it('pins forty more casual no-answers and twenty answers said as negations (round 5)', () => {
    expect(ROUND5_NO_ANSWERS).toHaveLength(40);
    expect(new Set(ROUND5_NO_ANSWERS).size).toBe(40);
    expect(ROUND5_REAL_ANSWERS).toHaveLength(20);
    expect(new Set([...NO_ANSWERS, ...ROUND5_NO_ANSWERS]).size).toBe(80);
  });

  it.each(ROUND5_NO_ANSWERS)(
    "the call's third turn after %j: never asked again, in the prompt and in the reply (round 5)",
    (said) => {
      const [r1, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(true);
      const message = turnMessage(2, said);
      expect(message).toContain('do not ask it again in any words');
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

  // Review of the 2026-11-07 fix, round 6: the no-answer reading is the union of the grammar and the shape (recall
  // first), so an answer said as a negation may be read by its shape. A misread is acceptable only in effect: the prompt
  // line is hedged ("if they did answer, build on what they said"), the notes keep their agenda, and at most a trailing
  // unquoted question of the coach's own goes; a question mid-reply or quoted is always asked.
  it.each(ROUND5_REAL_ANSWERS)(
    'after %j, an answer said as a negation: a misread only in effect, on the second turn or the third',
    (said) => {
      const [r1, r2] = REPLIES as [string, string];
      for (const n of [1, 2]) {
        const message = turnMessage(n, said);
        if (message.includes('could not answer your question')) {
          expect(message).toContain('If they did\n  answer, build on what they said.');
        }
      }
      for (const [previous, earlier] of [
        [r1, [OPENER]],
        [r2, [r1, OPENER]],
      ] as const) {
        const options = { strictQuestions: stuckOn(said, previous), asked: askedBefore(previous, earlier) };
        const history = [previous, ...earlier].join('\n\n');
        // Mid-reply and quoted, the follow-up is always asked.
        for (const reply of [
          'That changes the model a lot. Would the clinics pay cash for it then? It decides who you pitch first.',
          'That changes the model a lot. Ask him: "Would the clinics pay cash for it then?"',
        ]) {
          expect(withoutRepeats(reply, history, options).text).toBe(reply);
        }
        // At the very end, only the follow-up itself may go.
        const trailing = withoutRepeats(
          'That changes the model a lot. Would the clinics pay cash for it then?',
          history,
          options,
        );
        expect(trailing.removed.every((r) => r === 'Would the clinics pay cash for it then?')).toBe(true);
      }
    },
  );

  it.each(['im not sure i want to keep going', 'i dont know why im still here', 'not sure im gonna make it'])(
    'a message in distress (%j) keeps the notes and the open threads, as main did, and is never stuck (round 8)',
    (said) => {
      const [, r2] = REPLIES as [string, string];
      expect(stuckOn(said, r2)).toBe(false);
      const message = turnMessage(2, said);
      expect(message).toContain('<open_threads>');
      expect(message).toContain('<open_questions>');
      expect(message).not.toContain('could not answer your question');
      expect(message).not.toContain('do not ask it again in any words');
    },
  );

  it('a no-answer read only by its shape keeps the notes, the question it left open marked as raised (round 6)', () => {
    const said = 'no progress on that';
    const [, r2] = REPLIES as [string, string];
    // Read by its shape alone, it is only hedged in the prompt: never stuck, so no question is left out (round 8).
    expect(stuckOn(said, r2)).toBe(false);
    const message = turnMessage(2, said);
    expect(message).toContain('could not answer your question');
    expect(message).toContain('<open_questions>');
    expect(message).toContain('[already raised');
  });

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
