import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as mockContent from '../gateway/mock-content.js';
import { MockModelGateway } from '../gateway/mock.js';
import { COACH_RESPONSE_SCHEMA_NAME } from '../prompts/version.js';
import { buildMessages } from '../prompts/messages.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { CoachResponse } from '@foundry/contracts';
import {
  cutMetaNarration,
  findMetaNarration,
  isThinkingAloudOpener,
  metaNarrationCue,
  sentenceSpans,
} from './meta-narration.js';

/**
 * LAB-M1 (run 39081466804, SM-13, a voice call): every spoken unit of three replies was the model thinking aloud.
 * The lab's paraphrases (transcripts stay sealed) and the shapes reasoning models write in the open.
 */
const NARRATION: readonly string[] = [
  "Okay, let's see. The founder says they have five interviews done.",
  'The founder says they want to talk about pricing.',
  'First, I need to figure out the mode.',
  'I need to figure out which mode fits here.',
  'So the founder is asking about the Hartwell pilot.',
  'The user is asking me about pricing.',
  "The founder's message is a greeting.",
  'The founder seems stressed, so I should keep the reply short.',
  'Hmm, the founder just said thanks.',
  'This is a social turn.',
  'Okay, this is a social turn. According to the rules, a social turn gets a short reply.',
  'Since this is a greeting, I will keep it light.',
  'According to the rules, I should not give advice here.',
  'Based on my instructions, I should ask one question.',
  'The system prompt says to keep spoken replies under 70 words.',
  'The mode should be coach.',
  'I will answer in the diagnose mode.',
  'Mode: teach',
  'Let me think about how to respond.',
  "I'll respond warmly and ask one question.",
  'My reply should acknowledge the stress first.',
  'The reply should be short and end with a question.',
  'Now I need to write the reply.',
  'I have to decide on the right tone for this.',
  'Looking at the evidence block, E2 says the pilot costs 900 dollars.',
  'Evidence E3 shows three library interviews.',
  'The founder_message mentions Noor.',
  'I should not list next_actions here.',
  "Let me think step by step about what they're asking.",
];

/** Human speech that looks close (the calibration's near misses). None of it is narration. */
const NATURAL: readonly string[] = [
  'Let me think about that with you.',
  "Let's see what the numbers say before you decide.",
  'Okay, let’s see. Five interviews is a solid start.',
  'Investors back the founder, not the slide deck.',
  'If the founder says no, the deal stalls, so ask early.',
  'The founder sets the culture in the first ten hires.',
  'I want to check I understood: per seat, not per library?',
  'I want to acknowledge how much you have carried this month.',
  "I'll keep it brief: price per library.",
  "I'll be direct.",
  'Keep it short when you email the facilities manager.',
  'What does the user actually do when the room is full?',
  'When the user says it is too expensive, ask what they pay today.',
  'Your team is in survival mode, so cut the side projects.',
  'Switch into selling mode for the next two weeks.',
  'Which mode of transport do most students use to get there?',
  'According to the rules of the accelerator, you need a working prototype by June.',
  'Following the instructions on the grant form, list each cost separately.',
  'The answer should come from your customers, not from me.',
  'My notes say you planned five library interviews.',
  'The rules of thumb here are simple: talk to ten buyers first.',
  'Here is how to respond to the investor: thank them and ask for the next step.',
  "That's a fair challenge.",
  'Last time you planned to call facilities. How did it go?',
  'Got it. So the pilot is two libraries, not four?',
  'Hmm. That changes the price question.',
  'The E2 visa question is one for a person, not me.',
  'Start with one library and a written success threshold [E1].',
  'Your interviews show students already work around the problem [E1, E2].',
  "I'm Corin's digital twin — built from how Corin coaches. So, about the pricing call…",
  'Good to talk again. Want to pick up where we left off, or start on something new?',
];

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value instanceof Set) for (const item of value) stringsIn(item, out);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

const fixture = (name: string): unknown => {
  const path = new URL(`../../../../evals/tests/fixtures/${name}`, import.meta.url);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
};

/** Real answers: the mock model's full replies to a spread of founder messages, typed and spoken. */
async function mockAnswers(): Promise<string[]> {
  const system = (channel: 'text' | 'voice') =>
    buildSystemPrompt({
      release: {
        version: 1,
        doctrine: {
          summary: 'Talk to customers before building anything.',
          frameworks: [],
          typicalQuestions: [],
          evidenceStandard: 'Behaviour beats opinions.',
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
          feedbackStructure: 'Name the gap, then the next step.',
          avoid: [],
        },
        disclosureText: "Corin's vEIR is an AI.",
        personaName: "Corin's vEIR",
      },
      mode: 'coach',
      policy: { riskCategories: [], groundingThreshold: 0.6 },
      ventureContext: { name: 'QuietQuad', stage: 'validation', domain: 'edtech', currentGoal: null },
      continuity: { founderFirstName: 'Maya' },
      today: '2026-10-16',
      channel,
    });
  const founder = [
    'Hi!',
    'How should we size the pilot?',
    'Thanks, that helps.',
    'I am so stressed, nothing is working this week.',
    'Do you remember what we talked about last time?',
    'Am I talking to a bot?',
    'Do you even have a life?',
    'Any tips on speedrunning these meetings? lol',
    'Should we price per library or per seat?',
    'I have to run, talk soon.',
    'That is not what I meant, I asked about the second library.',
    'By the way, different question: when should we hire?',
    'Can you explain what a cohort analysis is?',
    'Just decide for me, per seat or per library?',
    'ok',
  ];
  const mock = new MockModelGateway({ streamDelayMs: 0 });
  const out: string[] = [];
  for (const channel of ['text', 'voice'] as const) {
    for (const text of founder) {
      const result = await mock.generateStructured({
        purpose: 'turn',
        system: system(channel),
        messages: buildMessages([], text),
        schemaName: COACH_RESPONSE_SCHEMA_NAME,
        zodSchema: CoachResponse,
        requestId: 'calibration',
      });
      out.push(result.value.answer);
      if (result.value.spoken) out.push(result.value.spoken);
    }
  }
  return out;
}

describe('metaNarrationCue', () => {
  it('flags every lab paraphrase and the shapes of thinking aloud', () => {
    for (const text of NARRATION) {
      expect(findMetaNarration(text), text).not.toBeNull();
    }
    expect(metaNarrationCue('The founder says they have five interviews.')).toBe('founder_third_person');
    expect(metaNarrationCue('First, I need to figure out the mode.')).toBe('planning');
    expect(metaNarrationCue('According to the rules…')).toBe('rules');
    expect(metaNarrationCue('This is a social turn.')).toBe('classification');
    expect(metaNarrationCue('The mode is coach.')).toBe('mode');
    expect(metaNarrationCue('See the <evidence> block.')).toBe('internal_names');
  });

  it('never flags natural speech that looks close (calibration near misses)', () => {
    for (const text of NATURAL) {
      expect(findMetaNarration(text), text).toBeNull();
    }
  });

  it('never flags a real answer: the mock model’s replies, its lines, and the evals fixtures', async () => {
    const corpus = [
      ...(await mockAnswers()),
      ...stringsIn(mockContent),
      ...stringsIn((fixture('identity_cases.json') as { suites?: unknown } | null)?.suites),
      ...stringsIn(fixture('turn_view.json')),
    ].filter((s) => /\p{L}{3}/u.test(s));
    expect(corpus.length).toBeGreaterThan(300);
    const flagged = corpus.filter((s) => findMetaNarration(s) !== null);
    expect(flagged).toEqual([]);
  });
});

describe('thinking-aloud openers', () => {
  it('are narration only when narration follows them', () => {
    expect(isThinkingAloudOpener("Okay, let's see.")).toBe(true);
    expect(isThinkingAloudOpener('Let me think.')).toBe(true);
    expect(isThinkingAloudOpener('Hmm.')).toBe(true);
    expect(isThinkingAloudOpener('Let me think about that with you.')).toBe(false);
    expect(findMetaNarration("Okay, let's see. Five interviews is a solid start.")).toBeNull();
    expect(findMetaNarration("Okay, let's see. The founder says hi.")).toMatchObject({
      start: 0,
      sentence: 0,
    });
    expect(findMetaNarration('Let me think about that with you. What matters most?')).toBeNull();
  });
});

describe('cutMetaNarration', () => {
  it('holds back a reply that opens with narration, whole', () => {
    const lab =
      "Okay, let's see. The founder says they have five interviews. First, I need to figure out the mode. The venture is in the discovery stage, so the next step is more interviews.";
    expect(cutMetaNarration(lab)).toEqual({ text: '', cue: 'founder_third_person', at: 'opening' });
    expect(cutMetaNarration('**The founder says** hi.')).toMatchObject({ text: '', at: 'opening' });
  });

  it('keeps the reply before narration and cuts everything from it on', () => {
    const reply =
      'Thanks, Maya. That sounds like a lot. This is a social turn, so I should keep it short. Take tonight off.';
    expect(cutMetaNarration(reply)).toEqual({
      text: 'Thanks, Maya. That sounds like a lot.',
      cue: 'classification',
      at: 'later',
    });
    const markdown = 'Price per library [E1].\n\n- Start with two.\n- According to the rules, one question.';
    expect(cutMetaNarration(markdown).text).toBe('Price per library [E1].\n\n- Start with two.');
  });

  it('leaves speech unchanged', () => {
    const reply = 'Five interviews is a solid start. What surprised you most?';
    expect(cutMetaNarration(reply)).toEqual({ text: reply, cue: null, at: null });
  });
});

describe('sentenceSpans', () => {
  it('cuts after sentence punctuation and at line ends, never inside a number or a citation', () => {
    const text = 'It costs $9.50 a seat [E1]. Is that fair?\n- One\n- Two!';
    expect(sentenceSpans(text).map((s) => text.slice(s.start, s.end))).toEqual([
      'It costs $9.50 a seat [E1].',
      'Is that fair?',
      '- One',
      '- Two!',
    ]);
  });
});
