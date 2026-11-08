import { describe, expect, it } from 'vitest';

import { founderMoves, saysOnlyNoAnswer } from '../prompts/conversation-state.js';
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
    'nope',
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
