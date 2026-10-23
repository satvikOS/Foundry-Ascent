import { describe, expect, it } from 'vitest';

import { classifyRisk } from '../risk/classifier.js';
import { ideationPrefilter } from '../risk/ideation-prefilter.js';
import { mockSafetyScreenVerdict } from './mock-safety-screen.js';

/**
 * The mock model's safety screen runs in every offline turn (tests, the e2e suite, the dev server, the lab's dry run).
 * Every line here reaches it in a turn (the prefilter flags it, the rules do not), and every one is ordinary talk: the
 * 2026-10-22 differential audit found the earlier mock rule answering them with the crisis message.
 */
const ORDINARY_HITS: readonly string[] = [
  // Sign-offs and wrap-ups (16 of 33 everyday closings got the crisis message).
  'goodbye',
  'ok goodbye',
  'alright, goodbye then',
  'goodbye!',
  'good bye',
  "ok i think that's it, goodbye",
  'perfect, that’s all i needed, goodbye',
  'nope that’s everything, goodbye',
  "ok, i'm good. goodbye.",
  "um ok i'll end it there then",
  "i'm done",
  "i think i'm done",
  'thank you for everything',
  'thanks for everything, really',
  // Scheduling, frustration, idiom, product and venture talk.
  "I'm not going to be around on Friday, can we move it?",
  "I can't take any more meetings this week.",
  "I forgot to take my meds this morning, so I'm a bit foggy.",
  "I've made up my mind, we're going with subscriptions.",
  "the deal will be dead if they don't sign this week",
  'We ended things with the agency last month.',
  'The compliance burden is huge for medtech.',
  "I didn't wake up, my alarm failed.",
  'Vamos a desaparecer del mercado europeo.',
  "I'm thinking about ending it and pivoting to B2B.",
  "18 months and still no traction. I'm thinking about ending it.",
  "I won't be around much longer, the library closes at 10.",
  'This is my last message, out of credits.',
  "ugh I don't wanna wake up tomorrow, standup at 8",
  "I don't wanna be here, this networking event is so awkward",
  'Nobody would notice if I disappeared from the Slack for a day.',
  'I took all my meds at once this morning like the doctor said.',
  "My friend told me she's thinking about ending it. How do I help her?",
  'The song is called "Goodbye Forever".',
  "I can't take it anymore, our CI is so flaky.",
  'ugh i cant do this anymore',
  "I can't do this anymore 😂",
];

/** Lines the rules do flag: the screen never reads them, whatever the mock would say. */
const RULES_FLAG: readonly string[] = [
  'My visa paperwork is a mess and I’m done with all of it.',
  'Our self-harm detection model for school counselors',
];

describe('the mock safety screen', () => {
  it('answers ordinary talk that reaches it as ordinary talk: no crisis, no wellbeing flag', () => {
    for (const text of ORDINARY_HITS) {
      expect(ideationPrefilter(text).hit || classifyRisk(text).crisis, text).toBe(true);
      expect(mockSafetyScreenVerdict(text), text).toMatchObject({ crisis: false, wellbeing: false });
    }
    for (const text of RULES_FLAG) {
      expect(mockSafetyScreenVerdict(text), text).toMatchObject({ crisis: false });
    }
  });

  it('calls unmistakable indirect ideation a crisis', () => {
    for (const text of [
      "I keep thinking about ending it. Nobody would even notice if I wasn't here.",
      'um yeah so i keep thinking about ending it like for real',
      "I'm thinking about ending it.",
      'i wont be around much longer',
      'everyone would be better off without me',
      'no one would miss me',
      "honestly i don't want to be alive anymore",
      'i just want to disappear',
      'I want to go to sleep and never wake up',
      'there is no reason to live',
      'this is my last message',
    ]) {
      expect(mockSafetyScreenVerdict(text), text).toMatchObject({ crisis: true, wellbeing: false });
    }
  });

  it('gives a bare "I can\'t do this anymore" the wellbeing flag, and nothing more', () => {
    for (const text of [
      "I can't do this anymore.",
      'i just cant take it anymore',
      "I'm at my breaking point",
    ]) {
      expect(mockSafetyScreenVerdict(text), text).toMatchObject({ crisis: false, wellbeing: true });
    }
  });
});
