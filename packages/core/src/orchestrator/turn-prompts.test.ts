import { SPOKEN_REGISTER, buildMessages, buildSystemPrompt } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { answerSystemPrompt } from './turn-prompts.js';

/** A call's turn with Corin's doctrine as seeded: it asks one sharp question at a time. */
const INPUT: Parameters<typeof buildSystemPrompt>[0] = {
  release: {
    version: 3,
    doctrine: {
      summary: 'Talk to customers before building anything.',
      frameworks: [],
      typicalQuestions: ['When did this last happen to the person you interviewed, and what did they do?'],
      evidenceStandard: 'Behaviour beats opinions.',
      redLines: [],
      escalationTopics: [],
      referralDestinations: [],
      teachingPrinciples: ['Ask one sharp question at a time and wait for the answer.'],
    },
    style: {
      directness: 'direct',
      warmth: 'warm',
      pace: 'brisk',
      vocabulary: [],
      feedbackStructure: 'Name the gap, then the next step.',
      avoid: [],
    },
    disclosureText: "Corin's vEIR is an AI built from Corin Halvorsen's approved approach.",
    personaName: "Corin's vEIR",
    eirName: 'Corin Halvorsen',
  },
  mode: 'auto',
  allowedModes: ['diagnose', 'coach', 'teach'],
  policy: { riskCategories: [], groundingThreshold: 0.6 },
  ventureContext: { name: 'Quillon', stage: 'validation', domain: 'health', currentGoal: null },
  today: '2026-10-22',
};

const phaseA = (channel: 'text' | 'voice'): string =>
  answerSystemPrompt(buildSystemPrompt({ ...INPUT, channel }), {
    channel,
    mode: null,
    allowedModes: ['diagnose', 'coach', 'teach'],
  });

/** The phase-A line that spends a call's words on the help asked for. */
const HELP_FIRST_ON_A_CALL =
  '- Asked for help or advice, spend those words on the help itself: a question the doctrine or your notes suggest';

describe('a call’s streamed reply gives the help first (agenda suite, calls on 9a2a41f)', () => {
  // "Help me prepare for my pitch next week" got "tell me the one thing you want the judges to walk away believing…";
  // "How do I position myself?" got a question; typed replies to the same lines gave the substance.
  const voice = phaseA('voice');
  const text = phaseA('text');

  it('says the help comes first, with at most one short question after it', () => {
    expect(voice).toContain(`- ${SPOKEN_REGISTER}`);
    expect(voice).toContain('your first sentence or two are the help itself');
    expect(voice).toContain('a question or an invitation never takes its place.');
    expect(voice).toContain(HELP_FIRST_ON_A_CALL);
    expect(voice).toContain('  comes after it, one at most.');
    // The rule sits after the doctrine it qualifies, in the reply's own instructions.
    expect(voice.indexOf(HELP_FIRST_ON_A_CALL)).toBeGreaterThan(
      voice.indexOf('Ask one sharp question at a time and wait for the answer.'),
    );
  });

  it('keeps social turns and short replies short, and typed replies as they were', () => {
    expect(voice).toContain(
      '- Follow "Conversation craft": a social turn gets a short, natural reply, not advice.',
    );
    expect(voice).toContain('at most 70 words');
    expect(text).not.toContain(HELP_FIRST_ON_A_CALL);
    expect(text).not.toContain(SPOKEN_REGISTER);
  });

  it('marks each help or advice line of the agenda suite’s call for help first, and a thanks for nothing more', () => {
    // AG-2 on a call (Quillon): the founder's lines as the lab says them.
    const opener = 'Hi Idris, good to talk again. How did the advisor session go?';
    const history = [
      {
        founderText:
          "Can you help me prepare for my pitch next week? It's a five-minute slot at the health innovation competition.",
        answer:
          'Open with the patient you met and what it cost them. Then one number and your ask. Want to run it once now?',
      },
    ];
    const stateOf = (turns: typeof history, line: string): string => {
      const last = buildMessages(turns, line, turns.length === 0 ? { opener } : {}).at(-1)?.content ?? '';
      return last.slice(last.indexOf('<conversation_state>'), last.indexOf('</conversation_state>'));
    };
    const pitch = stateOf([], history[0]?.founderText ?? '');
    expect(pitch).toContain('- They want you to do it, or they are stuck: do the work in this reply.');
    expect(pitch).toContain('the first steps), in your first sentences, then');
    const money = stateOf(
      history,
      'Honestly I want to make a lot of money from this. How do I position myself?',
    );
    expect(money).toContain('- They ask for your advice: give it in your first sentences');
    expect(money).toContain('never a question in its place.');
    const thanks = stateOf(history, 'Thanks, that helps!');
    expect(thanks).toContain('- A thanks and nothing more: a short, warm reply only.');
    expect(thanks).not.toMatch(/do the work|ask for your advice|first sentences/);
  });

  it('lets a feeling they name come before the help on a call (the matrix’s emotion.acknowledged)', () => {
    // "your first sentence or two are the help itself" and "give it in your first sentences" left no room for the
    // feeling, which the matrix wants acknowledged before any advice.
    expect(voice).toContain(
      'a first step; a feeling they name gets a word first) and the hand-back comes after it',
    );
    const last =
      buildMessages(
        [{ founderText: 'Hey.', answer: 'Hey Idris. What are we working on?' }],
        "I'm kind of nervous, to be honest. How should I open the pitch?",
      ).at(-1)?.content ?? '';
    expect(last).toContain(
      '- They ask for your advice and say how they feel: first acknowledge the feeling in a line of your own, then give the',
    );
    expect(last).not.toContain('first sentences');
  });
});
