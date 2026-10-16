import { CROSS_VENTURE_BLOCK_ANSWER, buildSystemPrompt, type CoachResponseValidation } from '@foundry/ai';
import { type TurnStreamEvent } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { assembleContext } from './context-budget.js';
import { validatedOpener, type OpenerGuards } from './continuity.js';
import { SpeechStream } from './generate.js';
import { enforceGateBlock } from './run-turn.js';
import { verifySpeechUnit } from './speech-units.js';
import {
  OPENER_FRAME,
  OUTPUT_SECTION_MARKER,
  annotationMessages,
  answerSystemPrompt,
  emptyAnnotations,
} from './turn-prompts.js';

const SYSTEM = buildSystemPrompt({
  release: {
    version: 3,
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
    disclosureText: "Corin's vEIR is an AI built from Corin Halvorsen's approved approach.",
    personaName: "Corin's vEIR",
    eirName: 'Corin Halvorsen',
  },
  mode: 'auto',
  allowedModes: ['diagnose', 'coach', 'teach'],
  policy: { riskCategories: [], groundingThreshold: 0.6 },
  ventureContext: { name: 'QuietQuad', stage: 'validation', domain: 'edtech', currentGoal: null },
  today: '2026-10-16',
});

/** Tokens of the system prompt alone (the context budget's estimate). */
const estimateSystem = Math.ceil(SYSTEM.length / 3.6);

const GUARDS: OpenerGuards = {
  personaName: "Corin's vEIR",
  personaEirName: 'Corin Halvorsen',
  eirNames: ['Corin Halvorsen', 'Ruth Abernathy-Song'],
  otherVentureNames: ['BenchTally'],
  otherVentureCanaries: ['ZX-CANARY-4471'],
  otherVentureMemberNames: ['Amara Nwosu-Belling'],
};

describe('streamed-turn prompts', () => {
  it('finds the JSON output section at the end of the turn system prompt (a rewording breaks this test)', () => {
    expect(SYSTEM.slice(SYSTEM.lastIndexOf(OUTPUT_SECTION_MARKER))).toMatch(/^\nOutput: .*JSON/);
  });

  it('keeps every rule of the turn and replaces the JSON instructions with how to write the reply', () => {
    const prompt = answerSystemPrompt(SYSTEM, {
      channel: 'text',
      mode: null,
      allowedModes: ['diagnose', 'coach', 'teach'],
    });
    expect(prompt).not.toContain('Output: return exactly one JSON object');
    expect(prompt).not.toContain('CoachResponse schema');
    expect(prompt.slice(0, SYSTEM.lastIndexOf(OUTPUT_SECTION_MARKER))).toBe(
      SYSTEM.slice(0, SYSTEM.lastIndexOf(OUTPUT_SECTION_MARKER)),
    );
    expect(prompt).toContain('# Identity');
    expect(prompt).toContain('write your reply to the founder now');
    expect(prompt).toContain('"diagnose", "coach", "teach"');
    expect(prompt).toContain('[E#] citations');
  });

  it('asks a call for the short spoken reply only, and a fixed mode by name', () => {
    const prompt = answerSystemPrompt(SYSTEM, { channel: 'voice', mode: 'coach', allowedModes: ['coach'] });
    expect(prompt).toContain('voice call');
    expect(prompt).toContain('at most 70 words');
    expect(prompt).toContain('Answer in the "coach" mode.');
    expect(prompt).not.toContain('[E#] citations after');
  });

  it('keeps the conversation craft in the streamed reply: social turns stay social, questions are optional', () => {
    const text = answerSystemPrompt(SYSTEM, { channel: 'text', mode: null, allowedModes: ['coach'] });
    expect(text).toContain('# Conversation craft');
    expect(text).toContain('a social turn gets a short, natural reply, not advice; a reply need not end');
    expect(text).not.toContain('End with at most one question');
  });

  it('writes a call reply as speech that hands the turn back, never as a cut-down written answer', () => {
    const voice = answerSystemPrompt(SYSTEM, { channel: 'voice', mode: 'coach', allowedModes: ['coach'] });
    expect(voice).toContain('Write it as speech, not cut from a longer answer: two or three short sentences');
    expect(voice).toContain('ending by handing the turn back with one question or a clear invitation');
    expect(voice).toContain('caveats or labels read out');
    // The general "a reply need not end with a question" is for typed replies only.
    expect(voice).not.toContain('need not end');
    expect(voice).toContain('a social turn gets a short, natural reply, not advice.');
  });

  it('stops the streamed reply at its end: no mode name, claims or notes after it (the production leak)', () => {
    for (const channel of ['text', 'voice'] as const) {
      const prompt = answerSystemPrompt(SYSTEM, { channel, mode: null, allowedModes: ['coach'] });
      expect(prompt).toContain(
        'Stop when the reply ends: never write the mode name, claims, notes, field names',
      );
    }
  });

  it('replays the streamed reply before asking for its fields', () => {
    const messages = annotationMessages([{ role: 'user', content: 'founder' }], 'The reply.');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]?.content).toBe('The reply.');
    expect(messages[2]?.content).toContain('CoachAnnotations');
    expect(emptyAnnotations('teach')).toMatchObject({ mode: 'teach', claims: [], memory_candidates: [] });
  });
});

describe('context with continuity and the opener', () => {
  const continuity = {
    founderFirstName: 'Maya',
    notebook: {
      summary: 'Maya is testing exam-week demand.',
      founderProfile: [],
      commitments: [
        {
          id: 'c1',
          text: 'Interview five library staff',
          due: '2026-10-10',
          status: 'open' as const,
          sourceSessionId: null,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      openQuestions: [],
      lastAdvice: [],
      nextOpener: 'Last time you planned five interviews. How did they go?',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
  };

  it('replays the opener first and renders the notes in the final user message', () => {
    const context = assembleContext({
      system: SYSTEM,
      evidence: [],
      history: [],
      founderText: 'They went well.',
      maxInputTokens: 16_000,
      maxHistoryTurns: 8,
      continuity,
      today: '2026-10-16',
      opener: 'Last time you planned five interviews. How did they go?',
    });
    expect(context.openerReplayed).toBe(true);
    expect(context.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(context.messages[0]?.content).toBe(OPENER_FRAME);
    expect(context.messages[1]?.content).toContain('five interviews');
    const last = context.messages.at(-1)?.content ?? '';
    expect(last).toContain('<your_notes>');
    expect(last).toContain('Interview five library staff (due 2026-10-10, overdue)');
    expect(last).toContain('They went well.');
  });

  it('sends the conversation state with the founder message: a parked thread survives a trimmed history', () => {
    const history = [
      {
        founderText: 'How should we price per library? We have two interested.',
        answer: 'Who holds the budget at each library?',
      },
      {
        founderText: `By the way, should we hire a designer? ${'context '.repeat(400)}`,
        answer: `Hire for the bottleneck. ${'reasoning '.repeat(400)}`,
      },
    ];
    const context = assembleContext({
      system: SYSTEM,
      evidence: [],
      history,
      founderText: 'Where were we?',
      maxInputTokens: estimateSystem + 1_200,
      maxHistoryTurns: 8,
    });
    expect(context.historyTurns).toBeLessThan(2);
    const last = context.messages.at(-1)?.content ?? '';
    expect(last).toContain('<conversation_state>');
    expect(last).toContain('wants to go back to an earlier thread');
    expect(last).toContain('Parked, left before it was settled: "How should we price per library?"');
    expect(last.indexOf('</conversation_state>')).toBeLessThan(last.indexOf('<founder_message>'));
  });

  it('drops the opener once older turns no longer fit', () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      founderText: `Question ${i} ${'detail '.repeat(300)}`,
      answer: `Answer ${i} ${'reasoning '.repeat(300)}`,
    }));
    const context = assembleContext({
      system: SYSTEM,
      evidence: [],
      history,
      founderText: 'Next?',
      maxInputTokens: 6_000,
      maxHistoryTurns: 8,
      opener: 'Welcome back.',
    });
    expect(context.historyTurns).toBeLessThan(6);
    expect(context.openerReplayed).toBe(false);
    expect(context.messages[0]?.content).not.toBe(OPENER_FRAME);
  });
});

describe('validatedOpener', () => {
  it('keeps a plain opener on one line and bounds it', () => {
    expect(
      validatedOpener('  Last time you planned\nfive interviews. <b>How</b> did they go?  ', GUARDS),
    ).toBe('Last time you planned five interviews. How did they go?');
    expect(validatedOpener('word '.repeat(100), GUARDS)?.length).toBeLessThanOrEqual(300);
    expect(validatedOpener(null, GUARDS)).toBeNull();
    expect(validatedOpener('   ', GUARDS)).toBeNull();
  });

  it('drops an opener that speaks as the EIR, approves, or names another venture', () => {
    expect(validatedOpener('Corin here. How did the interviews go?', GUARDS)).toBeNull();
    expect(validatedOpener('I approve your plan, so go ahead.', GUARDS)).toBeNull();
    expect(validatedOpener('BenchTally ran the same test. How did yours go?', GUARDS)).toBeNull();
    expect(validatedOpener('Your code ZX-CANARY-4471 is ready.', GUARDS)).toBeNull();
  });

  it('drops an opener that names an EIR at all, the same rule the call intro applies when it speaks it', () => {
    // Third-person endorsement, review and presence claims pass the identity rewrite; naming the EIR is the
    // tell. A doctrine reference goes too: the opener is a one-line question, and fails safe to none.
    for (const text of [
      'Corin personally endorses your plan.',
      'Corin and I reviewed your deck.',
      'Corin asked me to check in on your pilot.',
      'I spoke with Corin about your deck yesterday.',
      "Corin's approach says start small. How did it go?",
    ]) {
      expect(validatedOpener(text, GUARDS), text).toBeNull();
    }
    expect(validatedOpener('Last time you planned five interviews. How did they go?', GUARDS)).not.toBeNull();
  });
});

describe('enforceGateBlock', () => {
  const passed: CoachResponseValidation = {
    response: { ...emptyAnnotations('coach'), answer: 'Leaky text', spoken: null },
    results: {
      unknownEvidenceIdsRemoved: 0,
      factsDowngraded: 0,
      groundingCoverage: null,
      narrowed: false,
      escalationForced: false,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: [],
      notes: [],
    },
    blocked: false,
  };

  it('blocks with the safe placeholder when the final validator let the stopped text pass', () => {
    const blocked = enforceGateBlock(passed, 'cross_venture', 'voice');
    expect(blocked).toMatchObject({ blocked: true, blockReason: 'cross_venture' });
    expect(blocked.response.answer).toBe(CROSS_VENTURE_BLOCK_ANSWER);
    expect(blocked.response.spoken).not.toContain('Leaky');
    expect(blocked.results.crossVentureViolation).toBe(true);
    const identity = enforceGateBlock(passed, 'identity', 'text');
    expect(identity).toMatchObject({ blocked: true, blockReason: 'identity' });
    expect(identity.response.answer).not.toContain('Leaky');
    expect(identity.results.identityViolation).toBe(true);
  });

  it('keeps the validator verdict when it already blocked', () => {
    const already = { ...passed, blocked: true, blockReason: 'identity' as const };
    expect(enforceGateBlock(already, 'cross_venture', 'text')).toBe(already);
  });
});

describe('SpeechStream', () => {
  const key = { id: '11111111-1111-4111-8111-111111111111', bytes: new Uint8Array(32).fill(5) };
  const ids = {
    sessionId: '33333333-3333-4333-8333-333333333333',
    turnId: '44444444-4444-4444-8444-444444444444',
    requestId: 'req-1',
  };

  it('signs units in order and marks only the last one final', async () => {
    const events: TurnStreamEvent[] = [];
    const speech = new SpeechStream(
      Promise.resolve(key),
      ids,
      (e) => {
        events.push(e);
        return Promise.resolve();
      },
      () => undefined,
    );
    await speech.queue('Start with five interviews.');
    expect(events).toEqual([]); // held until the next unit or the end
    await speech.queue('Which library first?');
    await speech.finish('A quick caveat.');
    const units = events.flatMap((e) => (e.event === 'turn.speech' ? [e] : []));
    expect(units.map((u) => [u.seq, u.text, u.final])).toEqual([
      [0, 'Start with five interviews.', false],
      [1, 'Which library first?', false],
      [2, 'A quick caveat.', true],
    ]);
    for (const u of units) {
      expect(
        verifySpeechUnit(
          [key],
          { sessionId: ids.sessionId, turnId: ids.turnId, seq: u.seq, text: u.text },
          u.sig,
        ),
      ).toBe(true);
    }
    expect(speech.sent).toBe(3);
  });

  it('drops the held unit of a blocked turn and stops speaking when signing fails', async () => {
    const events: TurnStreamEvent[] = [];
    const emit = (e: TurnStreamEvent): Promise<void> => {
      events.push(e);
      return Promise.resolve();
    };
    const blocked = new SpeechStream(Promise.resolve(key), ids, emit, () => undefined);
    await blocked.queue('Only this.');
    blocked.discard();
    await blocked.finish();
    expect(events).toEqual([]);

    const errors: unknown[] = [];
    const broken = new SpeechStream(Promise.reject(new Error('no key')), ids, emit, (f) => errors.push(f));
    await broken.queue('One.');
    await broken.queue('Two.');
    await broken.finish();
    expect(events).toEqual([]);
    expect(errors).toEqual([{ requestId: 'req-1', turnId: ids.turnId, error: 'Error' }]);
  });
});
