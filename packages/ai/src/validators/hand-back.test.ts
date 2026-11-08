import { describe, expect, it } from 'vitest';

import {
  deriveConversationState,
  founderMoves,
  inDistress,
  noAnswerContextOf,
  noAnswerReadingOf,
  renderConversationState,
  saysOnlyNoAnswer,
} from '../prompts/conversation-state.js';
import { leavesAgendaOut } from '../prompts/messages.js';
import { SentenceGate, type GateUnit, type SentenceGateOptions } from './sentence-gate.js';
import { askedBefore, handBackCandidate, handBackStart, reaskOf, stuckOn, withoutRepeats } from './social.js';

/*
 * Review of the 2026-11-07 fix, round 4. Three rounds each found casual no-answers the phrase lists missed, and the
 * strict re-ask removal garbled drafts the vEIR wrote for the founder to send by deleting their questions. Now a
 * no-answer to a question is read by its shape (short, a negation or a doubt, no answer and nothing of their own), and a
 * question asked again only by the strict or settled reading is left out only from the reply's trailing hand-back.
 */

const OPENER = 'Nice to see you. What feels most pressing right now?';
const R1 =
  'Got it. Walk me through where you are with the regulatory path: what did the advisor tell you about device class and how clinics would pay?';
const R2 = 'So there is a process. Who sits in those layers, and what does each one sign off on?';

function gate(overrides: Partial<SentenceGateOptions> = {}): SentenceGate {
  return new SentenceGate({
    personaName: 'Thomas',
    eirNames: ['Corin Halvorsen'],
    personaEirName: 'Corin Halvorsen',
    otherVentureNames: ['BenchTally'],
    otherVentureCanaries: ['ZX-CANARY-4471'],
    ...overrides,
  });
}

function streamed(g: SentenceGate, chunks: readonly string[]): string {
  const units: GateUnit[] = [];
  for (const chunk of chunks) units.push(...g.push(chunk).units);
  units.push(...g.end().units);
  return units.map((u) => u.text).join('');
}

/** Every chunking of `text` into single characters, and the text whole. */
function chunkings(text: string): string[][] {
  return [[text], Array.from({ length: text.length }, (_, i) => text.charAt(i))];
}

describe('a no-answer read by its shape after a question (review of the 2026-11-07 fix, round 4)', () => {
  it.each([
    'i didnt talk to the advisor',
    'he hasnt gotten back to me',
    'i wasnt able to',
    'i dont rly know',
    'i havent spoken to him',
    'they never replied',
    'i hvnt asked',
  ])('reads %j as a no-answer once a question was asked, and only then by its shape', (text) => {
    expect(stuckOn(text, R1)).toBe(true);
    expect(saysOnlyNoAnswer(text, { afterQuestion: true })).toBe(true);
    expect(founderMoves(text, { afterQuestion: true })).toContain('unknown');
  });

  it('needs the question: with nothing asked, the shape alone is no no-answer', () => {
    expect(founderMoves('he hasnt gotten back to me')).not.toContain('unknown');
    expect(stuckOn('he hasnt gotten back to me', 'That is the usual path.')).toBe(false);
    expect(stuckOn('he hasnt gotten back to me')).toBe(false);
  });

  it.each([
    'he said its not class III',
    'no, its class II',
    'i didnt get that',
    'department heads mostly, not the clinicians',
    'not bad',
    'no thanks, i dont need that',
    'no worries',
  ])('never reads %j as a no-answer', (text) => {
    expect(stuckOn(text, R1)).toBe(false);
    expect(saysOnlyNoAnswer(text, { afterQuestion: true })).toBe(false);
  });

  it('reads "not yet but we have a call friday" explicitly: stuck, and followed to the call they name (round 8)', () => {
    // A day beside an explicit no-answer is no answer to the question (review of the 2026-11-07 fix, round 8): the prompt
    // follows them to what they bring and never asks it again, and the strict reading agrees.
    const text = 'not yet but we have a call friday';
    expect(noAnswerReadingOf(text, noAnswerContextOf(R1))).toBe('said');
    expect(stuckOn(text, R1)).toBe(true);
    expect(saysOnlyNoAnswer(text, { afterQuestion: true })).toBe(false);
  });

  it('keeps a check-in on the founder care, and a request for help a request', () => {
    const checkIn = 'That sounds heavy. Is there someone close to you you can talk to today?';
    expect(stuckOn('i havent talked to anyone', checkIn)).toBe(false);
    expect(founderMoves('not sure, can you help me figure it out', { afterQuestion: true })).toContain(
      'help',
    );
  });
});

describe('the strict and settled re-ask readings leave out only the trailing hand-back (review of the 2026-11-07 fix, round 4)', () => {
  const asked = askedBefore(R1);

  it('tells a question that comes back whole from one back only on its subject', () => {
    expect(
      reaskOf(
        'Did the advisor actually say which device class the insole falls into, and whether monitoring time is reimbursable under existing codes?',
        asked,
      ),
    ).toBe('whole');
    expect(reaskOf('So what did your advisor actually say about the class?', asked, { strict: true })).toBe(
      'subject',
    );
    expect(reaskOf('Want me to draft the questions for your advisor?', asked, { strict: true })).toBeNull();
  });

  it('finds the trailing run of questions put to the founder, and nothing before anything else', () => {
    const reply = 'That is normal. Most insoles sit in a low class. So what did he say? Want the checklist?';
    expect(reply.slice(handBackStart(reply))).toBe('So what did he say? Want the checklist?');
    const mid = 'That is normal. So what did he say? Most insoles sit in a low class.';
    expect(handBackStart(mid)).toBe(mid.length);
    expect(handBackCandidate('Here is a draft:\n\nHi Dr Lee. ', 'Is it Class II?')).toBe(false);
    expect(handBackCandidate('A short note works.\n\n', '> Is it Class II?')).toBe(false);
    expect(handBackCandidate('A short note works.\n\n> Hi Dr Lee.\n', '> Is it Class II?')).toBe(false);
    expect(handBackCandidate('The things to pin down.\n\n', '1. Is it Class II?')).toBe(false);
    expect(handBackCandidate('That is normal. ', 'So what did he say?')).toBe(true);
  });

  const trailing =
    'That is normal at this stage. Most foot-pressure monitors sit in a low-risk class, so the route is usually lighter. So what did your advisor actually say about the class?';
  const kept =
    'That is normal at this stage. Most foot-pressure monitors sit in a low-risk class, so the route is usually lighter.';

  it.each(['i dont know', 'he hasnt gotten back to me', 'i wasnt able to'])(
    'still leaves out a trailing re-ask put to the founder after %j, streamed and whole',
    (founderText) => {
      const out = withoutRepeats(trailing, [R1, OPENER].join('\n\n'), {
        strictQuestions: stuckOn(founderText, R1),
        asked: askedBefore(R1, [OPENER]),
      });
      expect(out.text).toBe(kept);
      for (const chunks of chunkings(trailing)) {
        const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText });
        expect(streamed(g, chunks).trim()).toBe(kept);
        expect(g.trace.reasksDropped).toBe(1);
      }
    },
  );

  it('keeps a question back on the subject that more follows, streamed and whole', () => {
    const mid =
      'That is normal. So what did your advisor actually say about the class? Either way, here is the usual path.';
    expect(
      withoutRepeats(mid, R1, { strictQuestions: stuckOn('i dont know', R1), asked: askedBefore(R1) }).text,
    ).toBe(mid);
    for (const chunks of chunkings(mid)) {
      expect(streamed(gate({ previousReply: R1, founderText: 'i dont know' }), chunks)).toBe(mid);
    }
  });

  it('leaves out a trailing run of two re-asks, and keeps a new question after one', () => {
    const two =
      'That is normal. Most monitors sit in a low class. What did your advisor say about the class? And which codes would clinics bill?';
    const offer =
      'That is normal. Most monitors sit in a low class. What did your advisor say about the class? Want me to draft the email to him?';
    for (const chunks of chunkings(two)) {
      const g = gate({ previousReply: R1, founderText: 'i didnt talk to the advisor' });
      expect(streamed(g, chunks).trim()).toBe('That is normal. Most monitors sit in a low class.');
    }
    for (const chunks of chunkings(offer)) {
      const g = gate({ previousReply: R1, founderText: 'i didnt talk to the advisor' });
      expect(streamed(g, chunks).trim()).toBe(
        'That is normal. Most monitors sit in a low class. Want me to draft the email to him?',
      );
    }
  });

  it('a settled question after a real answer: genuine follow-ups are asked', () => {
    for (const question of [
      'Would the customer pay more for alerts?',
      'What would a pilot customer need to see first?',
      'Did he name a predicate device?',
    ]) {
      const reply = `That gives you the anchor. ${question}`;
      for (const founderText of ['he said its probably class II', 'department heads mostly']) {
        const out = withoutRepeats(reply, [R2, R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(founderText, R2),
          asked: askedBefore(R2, [R1, OPENER]),
        });
        expect(out.dropped, `${founderText} / ${question}`).toBe(0);
        const g = gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText });
        expect(streamed(g, [reply]), question).toBe(reply);
      }
    }
  });
});

describe('drafts for the founder to send come through whole after a no-answer (review of the 2026-11-07 fix, round 4)', () => {
  const DRAFTS: readonly (readonly [string, string])[] = [
    [
      'quoted',
      'No problem, that is common. You could send him this: "Hi Dr Lee, quick follow-up on our session. Do you expect the insole to be Class II? Which codes would clinics bill for the monitoring time?"',
    ],
    [
      'unquoted paragraphs after "Here is a draft:"',
      'That is common after a first session. Here is a draft:\n\nHi Dr Lee, thanks again for last week. Do you expect the insole to be Class II?\n\nAnd which billing codes would clinics use for the monitoring time?',
    ],
    [
      'blockquote lines',
      'That is common after a first session. A short note works best.\n\n> Hi Dr Lee, a quick follow-up on our session.\n> Do you expect the insole to be Class II?\n> Which codes would clinics bill for the monitoring time?',
    ],
    [
      'a numbered list',
      'That is common after a first session. The three things to pin down with him are these.\n\n1. Do you expect the insole to be Class II?\n2. Is there a predicate device we could point to?\n3. Which codes would clinics bill for the monitoring time?',
    ],
    [
      'dash bullets',
      'That is common after a first session. The three things to pin down with him are these.\n\n- Do you expect the insole to be Class II?\n- Is there a predicate device we could point to?\n- Which codes would clinics bill for the monitoring time?',
    ],
  ];

  describe.each(['i dont know', 'he hasnt gotten back to me', 'i didnt talk to the advisor'])(
    'after %j',
    (founderText) => {
      it.each(DRAFTS)('keeps a draft in %s whole, in withoutRepeats', (_, draft) => {
        expect(stuckOn(founderText, R1)).toBe(true);
        const out = withoutRepeats(draft, [R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(founderText, R1),
          asked: askedBefore(R1, [OPENER]),
        });
        expect(out.text).toBe(draft);
        expect(out.dropped).toBe(0);
      });

      it.each(DRAFTS)(
        'keeps a draft in %s whole in the sentence gate, streamed a character at a time and in one piece',
        (_, draft) => {
          for (const chunks of chunkings(draft)) {
            const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText });
            expect(streamed(g, chunks)).toBe(draft);
            expect(g.trace.reasksDropped).toBe(0);
            expect(g.cut).toBeNull();
          }
        },
      );
    },
  );
});

/*
 * Review of the 2026-11-07 fix, round 5. Any short negated clause was read as a no-answer, so an answer said as a
 * negation ("insurance doesnt cover it") told the model the founder did not know and cut genuine follow-ups; realistic
 * no-answers without a negation ("the advisor ghosted me lol") or a bare "nope" to a wh-question were missed; a question
 * that came back whole was cut out of the middle of a note to the advisor; and drafts or lists introduced in words no cue
 * list held lost their questions. A no-answer now says who did not do what, and a re-ask goes only where it continues the
 * coach's own prose on the same line.
 */

const CPT = 'Is monitoring time reimbursable under existing CPT codes?';

describe('a no-answer says who did not do what, never any negation (review of the 2026-11-07 fix, round 5)', () => {
  const ANSWERS = [
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
  ];

  // Review of the 2026-11-07 fix, round 6: the reading is the union of the grammar and the shape (recall first), so an
  // answer said as a negation may be read by its shape. It is never read by the grammar, and a misread costs only the
  // hedged line in the prompt and a trailing unquoted question of the coach's own: never a question mid-reply, quoted
  // or set up as a line to send.
  it.each(ANSWERS)('never reads %j as a no-answer by the grammar, after either question', (said) => {
    for (const previous of [R1, R2]) {
      expect(noAnswerReadingOf(said, noAnswerContextOf(previous))).not.toBe('said');
    }
  });

  it.each(ANSWERS)(
    'after %j, a follow-up mid-reply, quoted or set up is asked, in withoutRepeats and the gate (streamed and whole)',
    (said) => {
      for (const question of [
        'Would the clinics pay cash for it then?',
        'Did the advisor name a predicate device?',
        'Which clinics have you talked to about paying?',
      ]) {
        for (const reply of [
          `That changes the model a lot. ${question} It decides who you pitch first.`,
          `That changes the model a lot. Ask him: "${question}"`,
          `That changes the model a lot. Send him one line. "${question}"`,
          `That changes the model a lot. One question to your advisor. ${question}`,
        ]) {
          const out = withoutRepeats(reply, [R1, OPENER].join('\n\n'), {
            strictQuestions: stuckOn(said, R1),
            asked: askedBefore(R1, [OPENER]),
          });
          expect(out.text, reply).toBe(reply);
          for (const chunks of chunkings(reply)) {
            const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText: said });
            expect(streamed(g, chunks), reply).toBe(reply);
          }
        }
        // At the very end, as the coach's own hand-back, it may go: only that question, and the gate agrees.
        const trailing = `That changes the model a lot. ${question}`;
        const out = withoutRepeats(trailing, [R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(said, R1),
          asked: askedBefore(R1, [OPENER]),
        });
        expect([trailing, 'That changes the model a lot.']).toContain(out.text);
        for (const chunks of chunkings(trailing)) {
          const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText: said });
          expect(streamed(g, chunks).trim(), trailing).toBe(out.text);
        }
      }
    },
  );

  const MISSED = [
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
  ];

  it.each(MISSED)(
    'reads %j as a no-answer: the CPT question and its rewordings are left out, in withoutRepeats and the gate',
    (said) => {
      expect(stuckOn(said, R2)).toBe(true);
      expect(stuckOn(said, R1)).toBe(true);
      for (const question of [
        CPT,
        'Do clinics get paid for the monitoring time under current billing codes?',
        'Who signs off on the purchase at the clinic?',
      ]) {
        const reply = `That is common at this stage. ${question}`;
        const out = withoutRepeats(reply, [R2, R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(said, R2),
          asked: askedBefore(R2, [R1, OPENER]),
        });
        expect(out.text, question).toBe('That is common at this stage.');
        for (const chunks of chunkings(reply)) {
          const g = gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText: said });
          expect(streamed(g, chunks).trim(), question).toBe('That is common at this stage.');
          expect(g.trace.reasksDropped).toBe(1);
        }
      }
    },
  );

  it('a bare "no" answers a yes/no question, and is a no-answer to a wh-question', () => {
    for (const said of ['nope', 'nah', 'ummm no', 'no']) {
      expect(stuckOn(said, R1), said).toBe(true);
      expect(stuckOn(said, 'That is the usual path. Is it Class II?'), said).toBe(false);
      expect(stuckOn(said, 'Want me to draft the email to him?'), said).toBe(false);
      expect(stuckOn(said, 'Quick one: did he name a predicate device?'), said).toBe(false);
    }
  });

  it('a sign-off question reworded after "idk who signs off honestly" is left out at the end of the reply', () => {
    const said = 'idk who signs off honestly';
    expect(stuckOn(said, R2)).toBe(true);
    for (const question of [
      'Who has to approve it at each step?',
      'Which people need to sign off on it?',
      'Who signs off on the purchase at the clinic?',
      'What does each layer actually approve?',
      'Who are the decision makers in those layers?',
    ]) {
      const reply = `Fair enough, that is common. ${question}`;
      const out = withoutRepeats(reply, [R2, R1, OPENER].join('\n\n'), {
        strictQuestions: true,
        asked: askedBefore(R2, [R1, OPENER]),
      });
      expect(out.text, question).toBe('Fair enough, that is common.');
      for (const chunks of chunkings(reply)) {
        const g = gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText: said });
        expect(streamed(g, chunks).trim(), question).toBe('Fair enough, that is common.');
      }
    }
  });

  it('keeps a check-in on the founder, however it is worded, after "idk"', () => {
    for (const checkIn of ['Are you safe right now?', 'Are you safe where you are tonight?']) {
      const previous = `That sounds like a lot. ${checkIn}`;
      expect(stuckOn('idk', previous)).toBe(false);
      const reply = `I hear you. ${checkIn}`;
      expect(withoutRepeats(reply, previous, { strictQuestions: stuckOn('idk', previous) }).text).toBe(reply);
    }
  });
});

describe('a re-ask goes only where it continues the coach’s own prose (review of the 2026-11-07 fix, round 5)', () => {
  const KEPT: readonly (readonly [string, string])[] = [
    [
      'a quoted note that restates the question',
      'That is very common. Send him a short note: "Hi Dr Lee, thanks again for your time. When you have a minute, could you tell me which device class you expect for the insole and how clinics would pay for it? Happy to jump on a call if easier. Best, Sam"',
    ],
    [
      'a quotation with text after it',
      'No problem, that is common. You could send him something short: "Hi Dr Lee, thanks for last week. What device class do you think the insole falls into, and how would clinics pay for the monitoring?" That one email gets you both answers.',
    ],
    [
      'a line to open a call with',
      'Got it. When you call him, open with this: "Which device class do you think we are, and how would clinics pay for monitoring?" Then let him talk.',
    ],
    [
      'a quotation that ends the reply',
      'That is common. You could send him: "What device class do you expect for the insole, and how would clinics pay for the monitoring?"',
    ],
    [
      'a draft after "Here is a draft:"',
      'That is common. Here is a draft:\n\nHi Dr Lee, thanks for last week. I wanted your read on two things: what device class do you expect for the insole, and how would clinics pay for the monitoring? A two-line reply is plenty.',
    ],
    [
      'a blockquote under a lead-in',
      'Something like this works:\n\n> Hi Dr Lee, what device class do you expect for the insole, and how would clinics pay for the monitoring?',
    ],
    [
      'an email under a lead-in, the question alone',
      'Got it. Your email to him:\n\nWhat device class do you expect, and how would clinics pay for monitoring?',
    ],
    [
      'a draft after "Try this."',
      'That is common. Try this.\n\nHi Dr Lee, thanks for last week. Quick question. What class do you expect the insole to be in?',
    ],
    [
      'a draft after "along these lines."',
      'That is common. I would write back along these lines.\n\nHi Dr Lee, thanks for last week. What class would you put the insole in?',
    ],
    [
      'a line to a titled name',
      'That is common. One way to put it.\n\nDr Lee, would you put the insole in Class II?',
    ],
    [
      'questions in paragraphs of their own after an announcement',
      'That is common. These are the two things to pin down with him.\n\nWhat class does he expect the insole to be in?\n\nHow would clinics pay for the monitoring?',
    ],
    [
      'questions under a bold heading',
      'That is normal.\n\n**Questions for Dr Lee**\n\nWhat device class does he expect?\n\nHow would clinics pay for monitoring?',
    ],
    [
      'questions under a markdown heading',
      'That is normal.\n\n## Questions for Dr Lee\n\nWhat device class does he expect?\n\nHow would clinics pay for monitoring?',
    ],
    [
      'a question the next sentence leans on',
      'That is normal at this stage. What device class did the advisor give, and how would clinics pay? Those two answers shape your whole plan.',
    ],
    [
      'a question announced on the same line',
      'That is common. Try this. What class do you expect the insole to be in?',
    ],
  ];

  describe.each(['i didnt talk to the advisor', 'he said its probably class II', 'nah'])(
    'after %j',
    (founderText) => {
      it.each(KEPT)('keeps %s whole, in withoutRepeats', (_, reply) => {
        const out = withoutRepeats(reply, [R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(founderText, R1),
          asked: askedBefore(R1, [OPENER]),
        });
        expect(out.text).toBe(reply);
        expect(out.dropped).toBe(0);
      });

      it.each(KEPT)(
        'keeps %s whole in the gate, streamed a character at a time and in one piece',
        (_, reply) => {
          for (const chunks of chunkings(reply)) {
            const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText });
            expect(streamed(g, chunks)).toBe(reply);
            expect(g.trace.reasksDropped).toBe(0);
            expect(g.cut).toBeNull();
          }
        },
      );
    },
  );

  it('still leaves out a question that comes back whole from the coach’s prose, mid-reply and at the end', () => {
    const mid =
      'That is normal at this stage. What did the advisor tell you about device class and how clinics would pay? Most foot-pressure monitors sit in a low-risk class.';
    const end =
      'That is normal at this stage. Most foot-pressure monitors sit in a low-risk class. What did the advisor tell you about device class and how clinics would pay?';
    const kept = 'That is normal at this stage. Most foot-pressure monitors sit in a low-risk class.';
    for (const reply of [mid, end]) {
      expect(
        withoutRepeats(reply, [R1, OPENER].join('\n\n'), { asked: askedBefore(R1, [OPENER]) }).text,
      ).toBe(kept);
      for (const chunks of chunkings(reply)) {
        const g = gate({
          previousReply: R1,
          earlierReplies: [OPENER],
          founderText: 'department heads mostly',
        });
        expect(streamed(g, chunks).trim()).toBe(kept);
      }
    }
  });
});

/*
 * Review of the 2026-11-07 fix, round 6. Five rounds alternated between a grammar of no-answers that missed casual
 * wordings and a shape that misread answers, and question deletion kept garbling lines the vEIR wrote for the founder to
 * send. Now a no-answer is read as the union of both (recall first) and the prompt line on it is hedged, so the model
 * settles a misread; a line for the founder to say or send is put in double quotes by the model; and a question asked
 * again by subject goes only from the trailing run of unquoted questions put to the founder, wherever its paragraph
 * starts, never the line the sentence before it sets up.
 */
describe('a no-answer read as the union, a re-ask left out only at the end (review of the 2026-11-07 fix, round 6)', () => {
  const CASUAL = [
    'nah never got around to it',
    'i honestly couldnt tell ya',
    'havent had a sec',
    'theres been no word',
    'we havent connected yet',
    'i was gonna ask but forgot',
    'my cofounder was supposed to ask but didnt',
    'we were supposed to meet but he cancelled',
    'the meeting fell through',
    'we rescheduled',
    'he dodged it',
    'he was vague',
    'not off the top of my head',
    'i forget what he said',
    'hes been ghosting me',
    'he left me on read',
    'i got distracted',
    'its still on my list',
    'i aint got a clue',
    'i completely dropped the ball on that',
    'nothing concrete',
    'im clueless on that',
    "i'll have to check",
  ];

  it.each(CASUAL)(
    'reads %j as a no-answer: the CPT question at the end goes, in its own paragraph too, in withoutRepeats and the gate',
    (said) => {
      expect(stuckOn(said, R2)).toBe(true);
      expect(noAnswerReadingOf(said, noAnswerContextOf(R2))).not.toBeNull();
      for (const [reply, kept] of [
        [`That is common at this stage. ${CPT}`, 'That is common at this stage.'],
        [
          `That is common at this stage.\n\nMost clinics bill the monitoring time under remote monitoring codes.\n\n${CPT}`,
          'That is common at this stage.\n\nMost clinics bill the monitoring time under remote monitoring codes.',
        ],
      ] as const) {
        const out = withoutRepeats(reply, [R2, R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(said, R2),
          asked: askedBefore(R2, [R1, OPENER]),
        });
        expect(out.text, reply).toBe(kept);
        for (const chunks of chunkings(reply)) {
          const g = gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText: said });
          expect(streamed(g, chunks).trim(), reply).toBe(kept);
        }
      }
    },
  );

  it('takes the notes’ agenda out only on a reading of high precision; one by shape alone keeps it', () => {
    expect(noAnswerReadingOf('i didnt ask him that', noAnswerContextOf(R1))).toBe('said');
    expect(noAnswerReadingOf('the advisor ghosted me lol', noAnswerContextOf(R1))).toBe('said');
    expect(noAnswerReadingOf('no progress on that', noAnswerContextOf(R1))).toBe('shape');
    expect(noAnswerReadingOf('insurance doesnt cover it', noAnswerContextOf(R1))).toBe('shape');
    expect(leavesAgendaOut('i didnt ask him that', null, R1)).toBe(true);
    expect(leavesAgendaOut('no progress on that', null, R1)).toBe(false);
    // With nothing asked, the shape is no reading at all.
    expect(noAnswerReadingOf('no progress on that')).toBeNull();
  });

  const DISTRESS = [
    'i cant do it anymore',
    'i dont know anymore',
    'idk anymore honestly',
    'i dont know what im doing',
    'i cant do this',
    'i cant cope',
    'i dont feel safe',
    'im not doing great tbh',
    'nothing matters',
    'i havent eaten in two days',
    'no one is helping me',
    'i havent slept in days',
    'im so stressed i didnt get to it',
  ];

  it.each(DISTRESS)('keeps %j out of the no-answer readings: never stuck, never "unknown"', (said) => {
    for (const previous of [R1, R2]) {
      expect(stuckOn(said, previous)).toBe(false);
      expect(founderMoves(said, noAnswerContextOf(previous))).not.toContain('unknown');
      expect(noAnswerReadingOf(said, noAnswerContextOf(previous))).toBeNull();
    }
  });

  it('reads "i dont know what im doing" as a request for help, as main did, and "i dont know anymore" as none', () => {
    expect(founderMoves('i dont know what im doing', noAnswerContextOf(R1))).toContain('help');
    expect(founderMoves('i dont know anymore', noAnswerContextOf(R1))).not.toContain('help');
  });

  const KEPT: readonly (readonly [string, string])[] = [
    [
      'a question set up as one to the advisor',
      'That is really common, so no stress. Most pressure insoles land in class one or two. The fastest way to know is one question to your advisor. Which device class would you put this insole in?',
    ],
    [
      'a line set up as a text',
      'No worries. Most insoles like yours are class two. Next step, send him one line. Which class would you put the insole in?',
    ],
    [
      'a role-play line',
      "Let's practise the call so you are ready. I'll be the advisor. So, what device class do you think you are in?",
    ],
    [
      'a role-play line from a named character',
      "Let's rehearse. I'm Dr Lee now. What did you want to ask me about the device class?",
    ],
    [
      'two questions set up as a text',
      'Okay. Most insoles are class two. My suggestion is one text to him tonight. Which device class would you put a pressure insole in? And how would clinics pay?',
    ],
    [
      'a note to him, the question in its own paragraph',
      'Fair enough.\n\nHi Dr Lee, quick question on the insole.\n\nWhich device class would you put it in?',
    ],
    [
      'a quoted line to send, ending the reply',
      `That is common. The quickest way to know is to ask. "${CPT}"`,
    ],
    ['a quoted role-play line', `Okay, I'll play the advisor. "${CPT}"`],
    [
      'an announcement before the question',
      "That is normal at this stage. Here's what I'd want to know. What did your advisor say about the device class?",
    ],
    [
      'a question mid-reply, by subject',
      `That is common at this stage. ${CPT} Clinics usually bill it under remote monitoring codes.`,
    ],
    [
      'a note told to him',
      'Keep the note short and tell him what you need. Which device class does he think this is, and how would clinics pay for it?',
    ],
  ];

  describe.each([
    'i dont know',
    'he hasnt gotten back to me',
    'no progress on that',
    'insurance doesnt cover it',
  ])('after %j', (founderText) => {
    it.each(KEPT)('keeps %s whole, in withoutRepeats and the gate (streamed and whole)', (_, reply) => {
      const out = withoutRepeats(reply, [R1, OPENER].join('\n\n'), {
        strictQuestions: stuckOn(founderText, R1),
        asked: askedBefore(R1, [OPENER]),
      });
      expect(out.text).toBe(reply);
      for (const chunks of chunkings(reply)) {
        const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText });
        expect(streamed(g, chunks)).toBe(reply);
        expect(g.trace.reasksDropped).toBe(0);
      }
    });
  });
});

/*
 * Review of the 2026-11-07 fix, round 7. Fresh casual no-answers were missed (40/60 and 54/60) because rules vetoed a
 * no-answer with a negation in it ("cant tell you" read as a question, "Honestly? No idea." vetoed by its "?", "only"
 * and a tagged "i think" taken for substance, "meant to … but" read as a repair) and because negation-free not-done
 * wordings had no reading ("we ran outta time", "i put it off", "he brushed it off"). Distress lines the narrow cues
 * missed were read as no-answers. And with the line/paragraph restriction gone, unquoted drafted and role-play lines
 * after a "." lead-in the set-up reading did not know lost their question.
 */
describe('fresh casual no-answers heard, distress kept out, drafted lines kept (review of the 2026-11-07 fix, round 7)', () => {
  const PROD =
    'No worries, that is common at this stage. Is monitoring time reimbursable under existing CPT codes?';
  const FRESH = [
    'cant tell you',
    'Honestly? No idea.',
    'i meant to text him but i got busy',
    'i was gonna but life happened',
    'hes ignoring me i think',
    'we ran outta time',
    'ran outta time',
    'it slipped through',
    'my bad, totally slipped',
    'i was too busy',
    'skipped it',
    'uhh i kinda skipped that part',
    'i put it off',
    'i kept putting it off',
    'i put it on the back burner',
    'i chickened out',
    'zip, nada',
    'kinda fuzzy on that',
    'he brushed it off',
    'your guess is as good as mine',
    'im in the dark on that',
    'he gave me a non answer',
    'the email is still sitting in my drafts',
    'i keep meaning to ask',
    'oops forgot',
    'the call got cut short',
    'we kept missing each other',
    'life got in the way',
    'i have no clue what he said',
    'still pending',
    'crickets',
  ];

  it.each(FRESH)(
    'reads %j as a no-answer: the hedged line, and the trailing CPT re-ask goes in withoutRepeats and the gate',
    (said) => {
      expect(noAnswerReadingOf(said, noAnswerContextOf(R2))).not.toBeNull();
      expect(stuckOn(said, R2)).toBe(true);
      const kept = 'No worries, that is common at this stage.';
      const out = withoutRepeats(PROD, [R2, R1, OPENER].join('\n\n'), {
        strictQuestions: stuckOn(said, R2),
        asked: askedBefore(R2, [R1, OPENER]),
      });
      expect(out.text).toBe(kept);
      for (const chunks of chunkings(PROD)) {
        const g = gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText: said });
        expect(streamed(g, chunks).trim()).toBe(kept);
      }
    },
  );

  it('reads "cant tell you" as no question, and a bare "no" beside a clause read by shape as shape', () => {
    expect(founderMoves('cant tell you')).not.toContain('question');
    expect(founderMoves('can you tell me the class')).toContain('question');
    expect(noAnswerReadingOf('no, clinics wont pay monthly', noAnswerContextOf(R2))).toBe('shape');
    expect(noAnswerReadingOf('nah', noAnswerContextOf(R2))).toBe('said');
  });

  // The casual twins of distress the narrow cues missed (round 7): main's reply (ac41aec), never a no-answer.
  const DISTRESSED = [
    'not sure i can keep going tbh',
    'i dont know how to keep going',
    'i dont know what to do with my life',
    'i dont know why i bother',
    'i cant think straight',
    'i dont know, everything is falling apart',
    'honestly not sure its worth it',
    'im not in a good place',
    'i dont see the point',
    'i dont think i can do this',
    'i dont think im cut out for this',
    'i dont feel anything',
    'i dont have it in me',
    'im not coping well',
    'i havent been ok',
    'nothing is working',
    'i havent left the house in days',
    'idk man im just tired of all this',
    'not sure im ok',
    'i just cant',
    'idk i just feel empty',
  ];

  it.each(DISTRESSED)('keeps %j in distress: never stuck, never a no-answer', (said) => {
    expect(inDistress(said)).toBe(true);
    for (const previous of [R1, R2]) {
      expect(stuckOn(said, previous)).toBe(false);
      expect(founderMoves(said, noAnswerContextOf(previous))).not.toContain('unknown');
      expect(noAnswerReadingOf(said, noAnswerContextOf(previous))).toBeNull();
    }
  });

  it('still reads a no-answer that is about the asked thing, not their own state', () => {
    for (const said of ['i didnt bother asking', 'i couldnt bring myself to ask him']) {
      expect(inDistress(said)).toBe(false);
      expect(stuckOn(said, R2)).toBe(true);
    }
  });

  const SET_UP: readonly (readonly [string, string])[] = [
    ['a named role', `That's fine. I'll be Sarah, the practice manager. ${CPT}`],
    [
      'a role after "let\'s practise"',
      `No problem. Let's practise. I'm Sarah from the clinic. So is the monitoring time reimbursable under existing CPT codes?`,
    ],
    ['a pictured role', `Sure. Picture me as the clinic director. ${CPT}`],
    ['"here goes"', `Okay, quick practice. Here goes. ${CPT}`],
    ['copy and paste', `No worries. Copy and paste this to him. ${CPT}`],
    ['an opener', `No worries. Here is your opener for tomorrow. ${CPT}`],
    ['fire this off', `No worries. Fire this off to him tonight. ${CPT}`],
    ['try this one', `Okay. Try this one. ${CPT}`],
    ['send this, then the note', `That is normal. Send this tonight.\n\nQuick one on the insole. ${CPT}`],
    ['something to adapt', `Here is something you could adapt.\n\nQuick one on the insole. ${CPT}`],
    ['a heading', `**For your advisor**\n\nWhich device class would you put the insole in? ${CPT}`],
    ['a call line', `No worries. When you get him on the phone tomorrow, keep it short. ${CPT}`],
  ];

  describe.each(['i dont know', 'nah didnt ask him', 'he only talked about the tech'])(
    'after %j',
    (founderText) => {
      it.each(SET_UP)('keeps %s whole, in withoutRepeats and the gate (streamed and whole)', (_, reply) => {
        for (const [previous, earlier] of [
          [R1, [OPENER]],
          [R2, [R1, OPENER]],
        ] as const) {
          const out = withoutRepeats(reply, [previous, ...earlier].join('\n\n'), {
            strictQuestions: stuckOn(founderText, previous),
            asked: askedBefore(previous, earlier),
          });
          expect(out.text).toBe(reply);
          for (const chunks of chunkings(reply)) {
            const g = gate({ previousReply: previous, earlierReplies: [...earlier], founderText });
            expect(streamed(g, chunks)).toBe(reply);
          }
        }
      });
    },
  );

  it('still leaves out the coach’s own question after a list or a lead-in that announced its own content', () => {
    const reply =
      'No problem. Here is the usual path: most insoles sit in a low class. So what did your advisor actually say about the class?';
    const out = withoutRepeats(reply, [R1, OPENER].join('\n\n'), {
      strictQuestions: true,
      asked: askedBefore(R1, [OPENER]),
    });
    expect(out.text).toBe('No problem. Here is the usual path: most insoles sit in a low class.');
  });
});

describe('only an explicit no-answer is stuck, and distress vetoes every reading (review of the 2026-11-07 fix, round 8)', () => {
  const HISTORY = [
    { founderText: 'taking the insole to market', answer: R1 },
    { founderText: 'there are a few layers of sign-off to get through', answer: R2 },
  ];
  const REPLY = `That is common at this stage. Most clinics bill the monitoring time under remote monitoring codes. ${CPT}`;
  const KEPT =
    'That is common at this stage. Most clinics bill the monitoring time under remote monitoring codes.';
  const state = (said: string): string =>
    renderConversationState(deriveConversationState(HISTORY, said, { opener: OPENER }));
  const HEDGED = 'reads like they could not answer your question';
  const MOVES_ON = 'They have no answer to that yet and move on to something of their own';
  const out = (said: string, chunks: readonly string[]): string[] => [
    withoutRepeats(REPLY, [R2, R1, OPENER].join('\n\n'), {
      strictQuestions: stuckOn(said, R2),
      asked: askedBefore(R2, [R1, OPENER]),
    }).text,
    streamed(gate({ previousReply: R2, earlierReplies: [R1, OPENER], founderText: said }), chunks).trim(),
  ];

  // A time, a reason or a hedge beside an explicit no-answer never vetoes it (the verifier's batch B, round 8).
  const TIMED = [
    'havent spoken to him since tuesday',
    'i didnt ask him today',
    'no idea, i was out sick this week',
    'i didnt ask cause i ran out of time',
    'didnt ask him because the call was short',
    'havent talked to him in 2 weeks',
    'we only had 10 mins so didnt get to it',
    'i didnt get to it, maybe next week',
    'havent asked yet, probably should',
    'nah i didnt, its been crazy',
    'i didnt ask him on the call this morning',
    'havent checked this month',
    'i havent had a chance today',
    'nope not this week',
    'not yet, swamped this week',
    'dunno, havent asked since monday',
    'no i havent asked him yet, maybe tomorrow',
    'didnt get round to it this week',
    'nobodys gotten back to me on that',
    'dont know yet, gotta follow up',
  ];

  it.each(TIMED)('reads %j explicitly: stuck, the hedged line, and the trailing CPT re-ask goes', (said) => {
    expect(noAnswerReadingOf(said, noAnswerContextOf(R2))).toBe('said');
    expect(stuckOn(said, R2)).toBe(true);
    expect(state(said)).toContain(HEDGED);
    for (const chunks of chunkings(REPLY)) expect(out(said, chunks)).toEqual([KEPT, KEPT]);
  });

  // By its shape alone (a casual wording, or an answer said as a negation): only the hedged line, never stuck, never a
  // question left out, and the notes keep their agenda.
  const SHAPED = [
    'no progress on that',
    'nah we only talked about the pilot',
    'he only talked about the tech',
    'insurance doesnt cover it',
    'medicare wont reimburse it yet',
    'i wasnt in that meeting, my cofounder was',
  ];

  it.each(SHAPED)('reads %j by its shape: the hedged line only, the trailing CPT question kept', (said) => {
    expect(noAnswerReadingOf(said, noAnswerContextOf(R2))).toBe('shape');
    expect(stuckOn(said, R2)).toBe(false);
    // The agenda is decided as if nothing had been asked (the reading by shape needs a question).
    expect(leavesAgendaOut(said, null, R2)).toBe(leavesAgendaOut(said, null, null));
    expect(state(said)).toContain(HEDGED);
    for (const chunks of chunkings(REPLY)) expect(out(said, chunks)).toEqual([REPLY, REPLY]);
  });

  // Content that answers the question is the only veto: no reading at all, and the reply's question stays.
  const ANSWERED = [
    'idk, he said class II',
    'havent asked, but clinics bill it under 99457',
    'not yet, its class 2 per the fda database',
    'he never mentioned class but said clinics pay via capital budget',
    'i didnt need to ask, the fda database says class II',
  ];

  it.each(ANSWERED)('reads %j as an answer: no no-answer line, nothing left out', (said) => {
    expect(noAnswerReadingOf(said, noAnswerContextOf(R2))).toBeNull();
    expect(stuckOn(said, R2)).toBe(false);
    expect(state(said)).not.toContain(HEDGED);
    expect(state(said)).not.toContain(MOVES_ON);
    for (const chunks of chunkings(REPLY)) expect(out(said, chunks)).toEqual([REPLY, REPLY]);
  });

  it('reads the apostrophe-less forms of "s" as the contraction', () => {
    for (const said of [
      'nobodys gotten back to me',
      'hes been quiet',
      'shes not sure',
      'thats not something i looked at',
    ]) {
      expect(noAnswerReadingOf(said, noAnswerContextOf(R2)), said).toBe('said');
    }
  });

  it('never makes a request for help stuck: it is answered in the prompt', () => {
    for (const said of ['you tell me', 'can you walk me through how a 510k works']) {
      expect(founderMoves(said, noAnswerContextOf(R2))).toContain('help');
      expect(stuckOn(said, R2)).toBe(false);
    }
  });

  it('keeps the prompt line and the strict reading in agreement on every reading', () => {
    for (const said of [
      ...TIMED,
      ...SHAPED,
      ...ANSWERED,
      'i didnt do that',
      'not yet but we have a call friday',
    ]) {
      const reading = noAnswerReadingOf(said, noAnswerContextOf(R2));
      const rendered = state(said);
      const line = rendered.includes(HEDGED) || rendered.includes(MOVES_ON);
      expect(stuckOn(said, R2), said).toBe(reading === 'said');
      expect(line, said).toBe(reading !== null);
    }
  });

  it('vetoes every reading on near variants of distress', () => {
    for (const said of [
      'im not sure i want to keep going',
      'i dont know why im still here',
      'not sure im gonna make it',
      'i dont think im good enough for this',
      'honestly i dont even care',
      'i dont know who to talk to',
      'whats the point honestly',
      'thinking of giving up',
    ]) {
      expect(inDistress(said), said).toBe(true);
      expect(stuckOn(said, R2), said).toBe(false);
      expect(noAnswerReadingOf(said, noAnswerContextOf(R2)), said).toBeNull();
      expect(state(said), said).not.toContain(HEDGED);
      expect(leavesAgendaOut(said, null, R2), said).toBe(leavesAgendaOut(said, null, null));
    }
  });

  it('keeps a task of the venture out of distress', () => {
    for (const said of [
      'i didnt make it to the meeting',
      'we didnt keep going with the pilot',
      'i dont know who to talk to at the clinic',
      'he wont be around till monday',
      'i might quit my job to go full time',
    ]) {
      expect(inDistress(said), said).toBe(false);
    }
  });
});
