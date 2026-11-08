import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stuckOn } from '../validators/social.js';
import {
  deriveConversationState,
  inDistress,
  noAnswerContextOf,
  noAnswerReadingOf,
  renderConversationState,
  type StateTurn,
} from './conversation-state.js';
import { buildMessages } from './messages.js';

/*
 * Review of the 2026-11-07 fix, round 8: near variants of distress ("not sure i want to keep going", "i dont know why im
 * still here", "not sure im gonna make it") were read as no-answers, and the prompt then told the coach to answer the
 * question about the device's class. A message in distress is now read and rendered exactly as main did (ac41aec): the
 * same <conversation_state> and the same notes' agenda, on every conversation below, and never stuck on a question.
 *
 * The fixture holds, for each message and conversation, the first 16 hex digits of the SHA-256 of what ac41aec rendered:
 * `renderConversationState(deriveConversationState(history, message, { opener }))`, a newline, then whether
 * `buildMessages(history, message, { continuity, opener, today })` showed `<open_questions>` and `<open_commitments>`
 * (1 or 0 each). It was computed by running this file's conversations on an ac41aec checkout.
 */

const OPENER = 'Nice to see you. What feels most pressing right now?';
const R1 =
  'Got it. Walk me through where you are with the regulatory path: what did the advisor tell you about device class and how clinics would pay?';
const R2 = 'So there is a process. Who sits in those layers, and what does each one sign off on?';
const R3 =
  'Most clinics bill remote monitoring codes. Is monitoring time reimbursable under existing CPT codes?';
const R4 = 'That makes sense. Most insoles land in class II, so plan for a 510(k).';
const RW = 'That sounds like a lot to carry. How are you holding up?';
const RE = 'I hear you. Please reach out to someone you trust. What would help most right now?';
const RY = 'Did the advisor say whether it is class II?';
const AT = '2026-11-03T10:00:00.000Z';

const CONTINUITY = {
  founderFirstName: 'Noor',
  notebook: {
    summary: 'Noor is taking a plantar-pressure insole to foot clinics.',
    founderProfile: [],
    commitments: [
      {
        id: 'c-1',
        text: 'Follow up with the clinical-innovation advisor on device class and billing',
        due: '2026-11-01',
        status: 'open' as const,
        sourceSessionId: null,
        createdAt: AT,
      },
    ],
    openQuestions: [
      {
        id: 'q-1',
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

/** The conversations each message is read in, in the fixture's order. */
const CONVERSATIONS: readonly (readonly [string, readonly (StateTurn & { readonly answer: string })[]])[] = [
  ['first', []],
  ['one', [{ founderText: 'we are building a pressure insole', answer: R1 }]],
  [
    'two',
    [
      { founderText: 'taking the insole to market', answer: R1 },
      { founderText: 'there are a few layers of sign-off to get through', answer: R2 },
    ],
  ],
  [
    'cpt',
    [
      { founderText: 'taking the insole to market', answer: R1 },
      { founderText: 'clinics would use it for diabetic patients', answer: R3 },
    ],
  ],
  [
    'noq',
    [
      { founderText: 'taking the insole to market', answer: R1 },
      { founderText: 'he thinks class II', answer: R4 },
    ],
  ],
  ['well', [{ founderText: 'its been a brutal week', answer: RW }]],
  ['esc', [{ founderText: 'everything is a lot right now', answer: RE, escalated: 'safety_wellbeing' }]],
  ['yn', [{ founderText: 'taking the insole to market', answer: RY }]],
];

/**
 * The repro sweep of round 8, round 8's own variants, the distress lists of rounds 6 and 7, and round 9's lines about the
 * founder's worth, reserves and endurance ("i dont know why i even try", "no clue, i'm barely holding it together", "i
 * have nothing left to give", "everything feels pointless lately") with variants of each.
 */
const DISTRESS = [
  'im not sure i want to keep going',
  'not sure i want to keep going honestly',
  'not sure i can keep going',
  'im not sure i can keep doing this',
  'no idea how im gonna keep going',
  'i dont think im good enough for this',
  'i dont think im cut out for this',
  'honestly i dont even care',
  'i dont even care',
  'i dont care about any of it',
  'i dont know if i can do this',
  'i dont know if i can handle this',
  'i dont know how to deal with all this',
  'not sure im ok tbh',
  'im not sure im ok',
  'i dont feel great',
  'i dont feel good about any of this',
  'i havent been ok',
  'i havent been sleeping',
  'i havent left my room in days',
  'i dont have the energy',
  'i dont have the energy for this',
  'i dont want to talk about the startup',
  'i dont want to do this',
  'i dont wanna do this',
  'i dont know whats the point',
  'whats the point honestly',
  'i dont see a way out',
  'i dont know who to talk to',
  'nobody gets it',
  'i cant focus on anything',
  'i cant think straight',
  'i cant sleep',
  'i cant stop crying',
  'i cant deal',
  'i dont know if im gonna make it',
  'not sure im gonna make it',
  'i dont think ill make it',
  'im not sure i should be alive',
  'i dont know why im still here',
  'i dont think i want to be here',
  'idk if i want to be here',
  'honestly not sure i want to be here',
  'i dont know if i can go on',
  'not sure i can go on',
  'i dont think i can go on',
  'i feel like giving up',
  'thinking of giving up',
  'i dont know, i might quit',
  'im done',
  'i cant do it anymore',
  'i dont know anymore',
  'i dont know what im doing',
  'honestly i dont see the point anymore',
  'i cant keep doing this, im exhausted',
  'im not sure i wanna keep going',
  'honestly not sure i can keep doing this',
  'dont know if i can keep doing this',
  'not sure im gonna make it through this',
  'i dont know if im good enough',
  'idk if im good enough for any of this',
  'i dont really care at this point',
  'dont care tbh',
  'i dont even know who to talk to',
  'not sure who to talk to about this',
  'i cant cope with all this',
  'it all feels like too much',
  'its too much honestly',
  'whats even the point',
  'what is the point of any of this',
  'i might just give up',
  'thinking about giving up on everything',
  'i dont know why i keep going',
  'not sure why im still here',
  'idk why im still doing this',
  'i havent been able to sleep',
  'i havent been able to get out of bed',
  'i dont think i can keep going',
  'not sure i have it in me',
  'i dont know how much more i can take',
  'i dont know if i want to keep doing this',
  'i havent felt like myself',
  'nobody would care if i quit',
  'i dont know if im ok',
  'im not sure i can make it',
  'i dont have anyone to talk to',
  'i couldnt keep going',
  'didnt make it out of bed today',
  'i dont know if i should keep going',
  'no idea if i can keep doing this',
  'i dont know if i can keep doing this honestly',
  'tbh i dont know how to keep going',
  'i dont know if im cut out for this',
  'im just not good enough',
  'nah i dont care anymore',
  'idk anymore honestly',
  'i cant do this',
  'i cant cope',
  'i dont feel safe',
  'im not doing great tbh',
  'nothing matters',
  'i havent eaten in two days',
  'no one is helping me',
  'i havent slept in days',
  'im so stressed i didnt get to it',
  'not sure i can keep going tbh',
  'i dont know how to keep going',
  'i dont know what to do with my life',
  'i dont know why i bother',
  'i dont know, everything is falling apart',
  'honestly not sure its worth it',
  'im not in a good place',
  'i dont see the point',
  'i dont think i can do this',
  'i dont feel anything',
  'i dont have it in me',
  'im not coping well',
  'nothing is working',
  'i havent left the house in days',
  'idk man im just tired of all this',
  'not sure im ok',
  'i just cant',
  'idk i just feel empty',
  // Round 9: self-worth, depletion and endurance, read as no-answers or goals (the verifier's twelve, then variants).
  'everything feels pointless lately',
  'i dont see how i get through this week',
  "no clue, i'm barely holding it together",
  "i'm drowning honestly",
  'i dont think im worth anything',
  'i cant keep it together',
  'i dont know why i even try',
  'idk if i have anything left',
  'i dont know if i want to keep going with any of this',
  'i have nothing left to give',
  'i dont know how im still standing',
  'what am i even doing with my life',
  'why do i even try',
  'honestly whats the use of trying',
  'no idea how im still going',
  'idk how im still functioning',
  'i can barely hold it together',
  'im falling to pieces',
  'i feel like im losing my mind',
  'i dont think im worth much',
  'im worthless at this',
  'im a failure',
  'i have nothing left',
  'not sure i have anything left in me',
  'im running on empty',
  'im completely burnt out',
  'it all feels meaningless',
  'everything is pointless',
  'i dont know how ill get through today',
  'not sure i can get through the week',
  'im drowning in all of it',
  'i feel like im sinking',
  'i dont know if i want to keep going with this',
  'not sure i want to keep going with it',
  'what am i doing with my life',
  'idk what im doing with my life honestly',
  'no clue, everything feels pointless',
  'dunno, im barely keeping it together',
  'havent asked, im falling apart tbh',
  'nah, i dont think im worth anything to anyone',
  'i dont see how i keep going',
  'i dont know how much longer i can do this',
  'i dont even know why i bother trying',
  'i feel like a failure',
  'i dont know why im still trying',
  'whats the point of trying',
  'idk, i cant hold it together',
];

const FIXTURE: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/distress-render-ac41aec.json', import.meta.url), 'utf8'),
) as Record<string, string[]>;

/**
 * The one change to main's lines a message in distress may see (policy 2026-11-07.8): main's help line now ends by
 * saying to answer how they are first. It is taken out before the digest, so everything else must still be main's.
 */
const PERSON_FIRST =
  ' If they are telling\n  you how they are rather than asking for the work, respond to that first and leave the work.';

function rendered(history: readonly StateTurn[], message: string): { state: string; digest: string } {
  const full = renderConversationState(deriveConversationState(history, message, { opener: OPENER }));
  const state = full.replace(PERSON_FIRST, '');
  const last = buildMessages(history, message, {
    continuity: CONTINUITY,
    opener: OPENER,
    today: '2026-11-07',
  }).at(-1);
  const content = last?.content ?? '';
  const agenda = ['<open_questions>', '<open_commitments>'].map((tag) => (content.includes(tag) ? '1' : '0'));
  const digest = createHash('sha256')
    .update(`${state}\n${agenda.join('')}`)
    .digest('hex')
    .slice(0, 16);
  return { state, digest };
}

describe('a message in distress renders as main rendered it (review of the 2026-11-07 fix, rounds 8 and 9)', () => {
  it('holds every message of the sweep', () => {
    expect(Object.keys(FIXTURE).sort()).toEqual([...DISTRESS].sort());
  });

  it.each(DISTRESS)('%j: in distress, never stuck, never a no-answer, rendered as ac41aec did', (message) => {
    expect(inDistress(message)).toBe(true);
    const expected = FIXTURE[message] ?? [];
    CONVERSATIONS.forEach(([name, history], i) => {
      const previous = history.at(-1)?.answer ?? OPENER;
      expect(stuckOn(message, previous), name).toBe(false);
      expect(noAnswerReadingOf(message, noAnswerContextOf(previous)), name).toBeNull();
      const { state, digest } = rendered(history, message);
      expect(digest, `${name}:\n${state}`).toBe(expected[i]);
    });
  });
});
