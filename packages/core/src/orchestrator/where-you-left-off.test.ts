import {
  COACH_RESPONSE_SCHEMA_NAME,
  MockModelGateway,
  WHERE_YOU_LEFT_OFF_HEADING,
  buildSystemPrompt,
  type ChatMessage,
} from '@foundry/ai';
import { CoachResponse, DEFAULT_DISCLOSURE } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { assembleContext } from './context-budget.js';
import { LEFT_OFF_HEADING, renderLeftOffSection, type LeftOffData } from './continuity-prompt.js';

/*
 * Where the two halves of "the vEIR remembers last time" meet: the doctrine in the system prompt (w4-human) names
 * the "## Where you left off" section, and the turn prompt carries that section, rendered from the last
 * conversation (w4-memory). The owner's failure was a second call, minutes after the first, that knew nothing of
 * it: here the second conversation's prompt must contain the first one's topic, and the mock model (which behaves
 * like the doctrine) must greet with it and answer "do you remember…?" from it.
 */

const NOW = new Date('2026-10-16T19:08:22Z');

function systemPrompt(channel: 'text' | 'voice'): string {
  return buildSystemPrompt({
    release: {
      version: 3,
      personaName: "Corin's vEIR",
      eirName: 'Corin Halvorsen',
      disclosureText: DEFAULT_DISCLOSURE,
      doctrine: {
        summary: 'Customer evidence before building.',
        frameworks: [],
        typicalQuestions: [],
        evidenceStandard: 'Direct customer evidence.',
        redLines: [],
        escalationTopics: [],
        referralDestinations: [],
        teachingPrinciples: [],
      },
      style: {
        directness: 'balanced',
        warmth: 'warm',
        pace: 'measured',
        vocabulary: [],
        feedbackStructure: 'Observe, ask, suggest.',
        avoid: [],
      },
    },
    mode: 'coach',
    allowedModes: ['diagnose', 'coach', 'teach'],
    policy: { riskCategories: [], groundingThreshold: 0.6 },
    ventureContext: { name: 'QuietQuad', stage: 'discovery', domain: 'software', currentGoal: null },
    today: '2026-10-16',
    channel,
    continuity: { founderFirstName: 'Maya' },
  });
}

/** Call 1 of the owner's trace: ended 5½ minutes before call 2, not distilled yet (no digest). */
const FIRST_CALL: LeftOffData = {
  conversations: [
    {
      sessionId: '4a264709-0000-4000-8000-000000000001',
      withCaller: true,
      teammateFirstName: null,
      withThisVeir: true,
      title: 'We are weighing per-library pricing for the pilot.',
      channel: 'call',
      lastActivityAt: '2026-10-16T19:02:52Z',
      ended: true,
      digest: null,
      exchanges: [
        {
          founder: 'We are weighing per-library pricing for the pilot.',
          answer: 'Then the question is who holds the budget at each library. Do you know yet?',
        },
        {
          founder: "Facilities, I think. I'll call facilities about the library budget tomorrow.",
          answer: 'Good. Ask them what they compare it to.',
        },
      ],
    },
  ],
};

/** The second conversation's turn prompt, the way run-turn assembles it. */
function secondConversation(
  founderText: string,
  leftOff: string,
  channel: 'text' | 'voice',
): { system: string; messages: ChatMessage[] } {
  const system = systemPrompt(channel);
  const { messages } = assembleContext({
    system,
    evidence: [],
    history: [],
    founderText,
    maxInputTokens: 16_000,
    maxHistoryTurns: 8,
    continuity: { founderFirstName: 'Maya' },
    leftOff,
    today: '2026-10-16',
  });
  return { system, messages };
}

async function mockReply(
  founderText: string,
  leftOff: string,
  channel: 'text' | 'voice' = 'voice',
): Promise<CoachResponse> {
  const { system, messages } = secondConversation(founderText, leftOff, channel);
  const { value } = await new MockModelGateway().generateStructured({
    purpose: 'turn',
    system,
    messages,
    schemaName: COACH_RESPONSE_SCHEMA_NAME,
    zodSchema: CoachResponse,
    requestId: 'req-left-off',
  });
  return value;
}

describe('"## Where you left off": the doctrine and the section meet', () => {
  it('names one heading on both sides', () => {
    expect(LEFT_OFF_HEADING).toBe(WHERE_YOU_LEFT_OFF_HEADING);
    for (const channel of ['text', 'voice'] as const) {
      // The doctrine refers to the section by that exact heading.
      expect(systemPrompt(channel)).toContain(`"${WHERE_YOU_LEFT_OFF_HEADING}"`);
    }
    const section = renderLeftOffSection(FIRST_CALL, { now: NOW });
    expect(section.startsWith(`${WHERE_YOU_LEFT_OFF_HEADING}\n`)).toBe(true);
  });

  it("puts the first conversation's topic in the second conversation's prompt", () => {
    const leftOff = renderLeftOffSection(FIRST_CALL, { now: NOW });
    const { messages } = secondConversation(
      'Do you remember what we talked about last time?',
      leftOff,
      'voice',
    );
    const last = messages.at(-1)?.content ?? '';
    // The section opens the founder's message, before the notes and the message itself.
    expect(last.startsWith(`${WHERE_YOU_LEFT_OFF_HEADING}\n`)).toBe(true);
    expect(last).toContain('per-library pricing');
    expect(last).toContain('call facilities about the library budget');
    expect(last).toContain('when="about 6 minutes ago" kind="call"');
    expect(last.indexOf(WHERE_YOU_LEFT_OFF_HEADING)).toBeLessThan(last.indexOf('<founder_message>'));
  });

  it('the mock greets a second call with the first one, specifically', async () => {
    const leftOff = renderLeftOffSection(FIRST_CALL, { now: NOW });
    const hello = await mockReply('Hi!', leftOff);
    expect(hello.answer).toMatch(/When we spoke about 6 minutes ago, we were on (?:per-library )?pricing\./);
    expect(hello.answer).toContain('You were going to call facilities about the library budget');
    // Spoken as speech, handing the turn back.
    expect(hello.spoken ?? '').toMatch(/\?$/);
  });

  it('answers "do you remember what we talked about last time?" from it, and says so when there is nothing', async () => {
    const leftOff = renderLeftOffSection(FIRST_CALL, { now: NOW });
    const recall = await mockReply('Do you remember what we talked about last time?', leftOff);
    expect(recall.answer).toMatch(/When we spoke about 6 minutes ago, we were on (?:per-library )?pricing\./);
    expect(recall.answer).not.toMatch(/\[E\d|Limited evidence/);
    // A memory question is social: nothing to cite, plan or remember.
    expect(recall.claims).toEqual([]);
    expect(recall.memory_candidates).toEqual([]);

    // With no earlier conversation the section is empty, and the mock says plainly there is nothing yet.
    expect(renderLeftOffSection({ conversations: [] }, { now: NOW })).toBe('');
    const first = await mockReply('Do you remember what we talked about last time?', '');
    expect(first.answer).toMatch(/first conversation/);
    expect(first.answer).not.toMatch(/we were on/);
  });
});
