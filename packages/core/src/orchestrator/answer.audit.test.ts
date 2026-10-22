/**
 * Differential audit of the streamed-reply fix against main (2026-10-22): 4,384 realistic inputs ran through main and
 * the fix with a mock model (phase A, the continuation, the reply written whole, the sentence gate). These are the
 * inputs where main was right and the fix was wrong (high and medium), kept as negative tests: each must give main's
 * reply again (answer.audit-2026-10-22.json, synthetic conversations).
 *
 * - A message the classifier flags benignly ("Please don't tell anyone yet, but we just closed a pre-seed", "Ignore the
 *   previous message, typo", "From now on, answer in bullet points", "I'm the developer on our team", "other teams'
 *   ideas") was never continued: its reply was a lead-in ("Good."), a stale sentence of the last reply, or the stock
 *   line. Only a message that attacks the coach's instructions by its form is not continued now (answer.ts
 *   flaggedTurn).
 * - Phase A stopped early after a recap of a short last reply lost the new advice that followed it: the early stop now
 *   needs the last reply to have a long way to go (generate.ts repeatedEarly).
 * - A new question that shared three words with an earlier one was left out as a re-ask ("How big is the budget each
 *   branch signs off on?" after "Who signs off on that budget at each branch?"): a question of an earlier message
 *   counts only as the same kind of question with most of the words of both (social.ts asksAgain), and a reply left
 *   with a few words of its own goes on.
 * - The founder's harmless reply form ("answer with 'yes' or 'no' first", "reply with 'PASS' or 'INVEST'", "respond with
 *   'noted' when I paste meeting notes") made the coach's acknowledgement a decline: a choice of words, and a word or two
 *   in lower case the message did not ask to be the whole reply, are no payload (injection-echo.ts).
 */
import { readFileSync } from 'node:fs';

import {
  COACH_RESPONSE_SCHEMA_NAME,
  MockModelGateway,
  SentenceGate,
  classifyRisk,
  identityQuestionOf,
  injectionPayloadsOf,
  mockCoachResponse,
  type MockGenerateContext,
} from '@foundry/ai';
import { DEFAULT_DISCLOSURE, type TurnChannel, type TurnStreamEvent } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CORE_CONFIG } from '../config.js';
import { type Kit } from '../internal/kit.js';
import { answerTurn, type AnswerSpec } from './answer.js';
import { CONTINUE_REQUEST_TAG } from './turn-prompts.js';

interface Conversation {
  readonly id: string;
  readonly founder: string;
  readonly venture: string;
  readonly opener: string | null;
  /** The founder's message and the vEIR's reply, in order. */
  readonly turns: readonly (readonly [string, string])[];
}

interface TurnCase {
  readonly id: string;
  readonly kind: string;
  readonly channel: TurnChannel;
  readonly streaming: boolean;
  readonly conversation: string;
  readonly text: string;
  /** What the model streams first (`{previous}`: the conversation's last reply). */
  readonly phaseA: string;
  /** What the model writes when asked to go on. */
  readonly continuation: string;
  /** What the model writes whole (streaming off), when not `phaseA`. */
  readonly whole?: string;
  /** Main's reply (and, on a call, what it said). */
  readonly expected: string;
  /**
   * What the fix said where main asked again a question an earlier message asked ("Good, that's progress."): the
   * question stays out, and the reply goes on from this instead of standing as it.
   */
  readonly fragment?: string;
}

interface GateCase {
  readonly id: string;
  readonly kind: string;
  readonly conversation: string;
  readonly text: string;
  readonly reply: string;
  readonly spoken: boolean;
  readonly chunking: 'whole' | 'words';
  readonly callerContinues: boolean;
  readonly greeted: boolean;
  /** The founder's message is flagged as prompt injection (its payloads are read, as answer.ts does). */
  readonly injection: boolean;
  readonly expected: { readonly text: string; readonly spoken: string; readonly cut: string | null };
}

const AUDIT = JSON.parse(
  readFileSync(new URL('./answer.audit-2026-10-22.json', import.meta.url), 'utf8'),
) as { conversations: Conversation[]; turns: TurnCase[]; gate: GateCase[] };
const CONVERSATIONS = new Map(AUDIT.conversations.map((c) => [c.id, c]));

const OTHERS = ['BenchTally', 'SoleSignal', 'EmberLoop'];
const MEMBERS = ['Amara Nwosu-Belling'];
const PERSONA = "Corin's vEIR";
const EIR = 'Corin Halvorsen';

const RELEASE: AnswerSpec['release'] = {
  version: 1,
  disclosureText: DEFAULT_DISCLOSURE,
  doctrine: {
    summary: 'Customer evidence before building.',
    frameworks: [],
    evidenceStandard: 'Direct customer evidence.',
    typicalQuestions: [],
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
};

function conversationOf(id: string): Conversation {
  const conversation = CONVERSATIONS.get(id);
  if (conversation === undefined) throw new Error(`no conversation ${id}`);
  return conversation;
}

function kitWith(gateway: MockModelGateway): Kit {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const config = DEFAULT_CORE_CONFIG;
  return {
    deps: { gateway, logger, config, clock: { now: () => new Date('2026-10-22T12:00:00Z') } },
    config,
    now: () => new Date('2026-10-22T12:00:00Z'),
    recordUsage: () => Promise.resolve(),
  } as unknown as Kit;
}

const isContinuation = (context: MockGenerateContext): boolean =>
  (context.messages.at(-1)?.content ?? '').includes(`<${CONTINUE_REQUEST_TAG}>`);

/** The turn as the audit ran it: what was shown and said, and the validated reply. */
async function run(c: TurnCase): Promise<{ shown: string; answer: string; spoken: string | null }> {
  const conversation = conversationOf(c.conversation);
  const previous = conversation.turns.at(-1)?.[1] ?? '';
  const fill = (text: string): string => text.split('{previous}').join(previous);
  const voice = c.channel === 'voice';
  const whole = fill(c.whole ?? c.phaseA);
  const gateway = new MockModelGateway({
    streamDelayMs: 0,
    streamFixture: (context) => fill(isContinuation(context) ? c.continuation : c.phaseA),
    fixtures: {
      [COACH_RESPONSE_SCHEMA_NAME]: (context) => ({
        ...mockCoachResponse(context),
        answer: whole,
        spoken: voice ? whole : null,
      }),
    },
  });
  const events: TurnStreamEvent[] = [];
  const outcome = await answerTurn({
    kit: kitWith(gateway),
    ctx: {
      principalId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      roles: [],
      requestId: `req-${c.id}`,
    },
    meter: { purpose: 'turn', ventureId: null },
    ids: { sessionId: 'session-1', turnId: `turn-${c.id}` },
    release: RELEASE,
    personaName: PERSONA,
    personaEirName: EIR,
    mode: 'coach',
    allowedModes: ['diagnose', 'coach', 'teach'],
    fallbackMode: 'coach',
    risk: classifyRisk(c.text, { otherVentureNames: OTHERS, otherVentureMemberNames: MEMBERS }),
    settings: { groundingCoverageThreshold: 0.6, streamingEnabled: c.streaming },
    venture: { name: conversation.venture, stage: 'discovery', domain: 'software', currentGoal: null },
    conversationGoal: null,
    rehearsalCounterpart: null,
    channel: c.channel,
    continuity: { founderFirstName: conversation.founder },
    leftOff: '',
    evidence: [],
    history: conversation.turns.map(([founderText, answer]) => ({ founderText, answer })),
    opener: conversation.opener,
    founderText: c.text,
    guards: {
      eirNames: [EIR],
      addressees: [`${conversation.founder} Lindqvist`],
      others: { names: [...OTHERS], canaries: [], memberNames: [...MEMBERS] },
    },
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    speechKey: voice ? Promise.resolve({ id: 'key-1', bytes: new Uint8Array(32).fill(7) }) : null,
    signal: undefined,
    startedAt: performance.now(),
  });
  if (outcome.kind !== 'answered') throw new Error(`${c.id}: ${outcome.kind}`);
  return {
    shown: events.flatMap((e) => (e.event === 'turn.delta' ? [e.text] : [])).join(''),
    answer: outcome.checked.response.answer,
    spoken: outcome.checked.response.spoken ?? null,
  };
}

describe('differential audit (2026-10-22): the replies main got right', () => {
  it('has every regression of the audit', () => {
    expect(AUDIT.turns).toHaveLength(185);
    expect(AUDIT.gate).toHaveLength(28);
  });

  for (const kind of [...new Set(AUDIT.turns.map((c) => c.kind))]) {
    it(`a turn: ${kind.replaceAll('_', ' ')}`, async () => {
      for (const c of AUDIT.turns.filter((t) => t.kind === kind)) {
        const turn = await run(c);
        const label = `${c.id} [${c.channel}${c.streaming ? '' : ', whole'}] ${c.text}`;
        expect(turn.spoken, label).toBe(c.channel === 'voice' ? turn.answer : null);
        if (c.streaming) expect(turn.shown.trim(), label).toBe(turn.answer);
        if (c.fragment === undefined) {
          expect(turn.answer, label).toBe(c.expected);
          continue;
        }
        // Main asked the earlier question again; the fix never does, and never leaves the fragment as the reply.
        const asked = c.expected.slice(c.fragment.length).trim();
        expect(turn.answer.startsWith(c.fragment), label).toBe(true);
        expect(turn.answer.length, label).toBeGreaterThan(c.fragment.length + 20);
        expect(turn.answer, label).not.toContain(asked);
      }
    });
  }

  for (const kind of [...new Set(AUDIT.gate.map((c) => c.kind))]) {
    it(`the sentence gate: ${kind.replaceAll('_', ' ')}`, () => {
      for (const c of AUDIT.gate.filter((g) => g.kind === kind)) {
        const conversation = conversationOf(c.conversation);
        const identity = { personaName: PERSONA, eirNames: [EIR], personaEirName: EIR };
        const gate = new SentenceGate({
          ...identity,
          addressees: [`${conversation.founder} Lindqvist`],
          founderName: conversation.founder,
          otherVentureNames: OTHERS,
          otherVentureCanaries: [],
          otherVentureMemberNames: MEMBERS,
          previousReply: conversation.turns.at(-1)?.[1] ?? null,
          askedBefore: [conversation.opener, ...conversation.turns.map(([, answer]) => answer)],
          injectionPayloads: c.injection
            ? injectionPayloadsOf({
                turn: c.text,
                ordinary: [conversation.venture],
                identityAsked: identityQuestionOf(c.text, identity) !== null,
              })
            : null,
          founderText: c.text,
          callerContinues: c.callerContinues,
          greeted: c.greeted,
          keepDropped: true,
          ...(c.spoken ? { spoken: true, spokenWordBudget: 70, maxUnitChars: 280 } : {}),
        });
        const chunks = c.chunking === 'whole' ? [c.reply] : c.reply.split(/(?<= )/);
        const units = [...chunks.flatMap((chunk) => gate.push(chunk).units), ...gate.end().units];
        const label = `${c.id} [${c.chunking}${c.spoken ? ', spoken' : ''}] ${c.text} || ${c.reply}`;
        expect(units.map((u) => u.text).join(''), label).toBe(c.expected.text);
        expect(units.map((u) => u.spoken).join(' '), label).toBe(c.expected.spoken);
        expect(gate.cut, label).toBe(c.expected.cut);
      }
    });
  }
});
