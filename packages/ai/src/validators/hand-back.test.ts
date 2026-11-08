import { describe, expect, it } from 'vitest';

import { founderMoves, noAnswerContextOf, saysOnlyNoAnswer } from '../prompts/conversation-state.js';
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
    'not yet but we have a call friday',
    'i didnt get that',
    'department heads mostly, not the clinicians',
    'not bad',
    'no thanks, i dont need that',
    'no worries',
  ])('never reads %j as a no-answer', (text) => {
    expect(stuckOn(text, R1)).toBe(false);
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

  it.each(ANSWERS)('reads %j as an answer, after either question', (said) => {
    expect(stuckOn(said, R1)).toBe(false);
    expect(stuckOn(said, R2)).toBe(false);
    expect(founderMoves(said, noAnswerContextOf(R1))).not.toContain('unknown');
  });

  it.each(ANSWERS)(
    'after %j, genuine follow-ups are asked, in withoutRepeats and the gate (streamed and whole)',
    (said) => {
      for (const question of [
        'Would the clinics pay cash for it then?',
        'Did the advisor name a predicate device?',
        'Which clinics have you talked to about paying?',
      ]) {
        const reply = `That changes the model a lot. ${question}`;
        const out = withoutRepeats(reply, [R1, OPENER].join('\n\n'), {
          strictQuestions: stuckOn(said, R1),
          asked: askedBefore(R1, [OPENER]),
        });
        expect(out.dropped, question).toBe(0);
        for (const chunks of chunkings(reply)) {
          const g = gate({ previousReply: R1, earlierReplies: [OPENER], founderText: said });
          expect(streamed(g, chunks), question).toBe(reply);
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
