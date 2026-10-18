import type { CoachMode, CoachResponse, CommitmentStatus, MemoryCandidate } from '@foundry/contracts';

import { DISTILL_SCHEMA_NAME, type DistillDraft } from '../distill/schema.js';
import { AUTO_MODE, parseControlBlock, type PromptControl } from '../prompts/control.js';
import {
  asksForNumber,
  asksSomething,
  contentWords,
  directChoiceOf,
  endsWithQuestion,
  founderMoves,
  socialTurnOf,
  type FounderMove,
} from '../prompts/conversation-state.js';
import { tidyFounderWords } from '../prompts/founder-words.js';
import { openerSaidHello } from '../validators/greeting.js';
import { veirFirstName } from '../prompts/persona.js';
import { COACH_RESPONSE_SCHEMA_NAME, DEFAULT_PERSONA_NAME } from '../prompts/version.js';
import { RISK_ESCALATION_MAP, primaryForcedCategory } from '../risk/escalation-map.js';
import { escapeRegExp } from '../risk/normalize.js';
import { asksAboutIdentity, identityQuestionOf } from '../validators/identity.js';
import { clampWords } from '../validators/speech.js';
import { COACH_ANNOTATIONS_SCHEMA_NAME } from './coach-annotations.js';
import {
  ModelOutputInvalidError,
  ModelRefusalError,
  ModelUnavailableError,
  type ModelGatewayError,
} from './errors.js';
import { fnv1a, hashEmbedding } from './hash-embedding.js';
import { toStrictJsonSchema, type JsonObject, type JsonValue } from './json-schema.js';
import {
  BANK_PROPER_NOUNS,
  ESCALATION_AREAS,
  GREETINGS,
  BAD_NEWS_LINES,
  BAD_NEWS_QUESTIONS,
  GOOD_NEWS_LINES,
  GOOD_NEWS_QUESTIONS,
  HAND_BACKS,
  SARCASM_LINES,
  HELLO_AFTER_OPENER,
  HUMOUR_LINES,
  LEADS,
  RECALL_LEADS,
  REPAIR_LINES,
  SHORT_ACKS,
  SIGN_OFFS,
  STRESS_LINES,
  TEACH_STEPS,
  THANKS_REPLIES,
  TOPICS,
  autoModeFor,
  topicOf,
  type MockTopic,
} from './mock-content.js';
import {
  conversationStateIn,
  previousConversationIn,
  unescapeData,
  type PreviousConversation,
  type StateReading,
} from './mock-conversation.js';
import { validateStructured } from './provider.js';
import {
  EMBEDDING_DIMENSIONS,
  type ChatMessage,
  type EmbedOptions,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type ModelAttempt,
  type ModelGateway,
  type ModelGatewayInfo,
  type StreamTextRequest,
  type StreamTextResult,
  type TextChunkHandler,
} from './types.js';

export const MOCK_MODEL_ID = 'mock';
export const MOCK_FALLBACK_MODEL_ID = 'mock-fallback';
export const MOCK_EMBEDDINGS_MODEL_ID = 'mock-embeddings';
/** Schema name of the end-of-session recap (`RECAP_SCHEMA_NAME` in packages/core). */
export const MOCK_RECAP_SCHEMA_NAME = 'SessionRecapDraft';

/**
 * Scripted outcomes for the next model calls, structured or streamed (consumed in order). `fallback`
 * succeeds with `fallbackUsed`. A failing outcome fails a stream before any text.
 */
export type MockScriptedOutcome = 'unavailable' | 'timeout' | 'invalid_output' | 'refusal' | 'fallback';

/** Scripted outcomes for the next streamed calls only: `fail_midway` fails halfway through the text. */
export type MockStreamOutcome = 'fail_midway';

/** Pause before each streamed chunk when none is configured (realistic pacing for local demos). */
export const MOCK_STREAM_DELAY_MS = 40;

/** An evidence item as it appears in the prompt. */
export interface MockEvidence {
  id: string;
  kind: string;
  title: string;
}

export interface MockGenerateContext {
  system: string;
  messages: readonly ChatMessage[];
  control: PromptControl | null;
  founderText: string;
  evidenceIds: string[];
  /** Evidence items with their kind and title, in prompt order. */
  evidence: MockEvidence[];
  /** Completed earlier turns of this conversation in the prompt. */
  historyTurns: number;
}

export interface MockModelGatewayOptions {
  /**
   * Custom value builders by schema name; the defaults cover `CoachResponse`, `DistillDraft` and the recap.
   * A `CoachResponse` fixture also shapes streamed answers (its `answer`, or `spoken` on a call) and their
   * annotations.
   */
  fixtures?: Readonly<Record<string, (context: MockGenerateContext) => unknown>>;
  /** Text to stream instead of the coaching answer. */
  streamFixture?: (context: MockGenerateContext) => string;
  /** Pause before each streamed sentence in milliseconds (tests set 0). Default {@link MOCK_STREAM_DELAY_MS}. */
  streamDelayMs?: number;
}

export interface MockCall {
  kind: 'generate' | 'stream' | 'embed';
  purpose: string;
  requestId: string | null;
  schemaName: string | null;
  count: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The newest message carrying the founder's words (later messages are follow-up instructions). */
function founderMessageIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user' && m.content.includes('<founder_message>')) return i;
  }
  return messages.findLastIndex((m) => m.role === 'user');
}

function lastFounderText(messages: readonly ChatMessage[]): string {
  const last = messages[founderMessageIndex(messages)];
  if (!last) return '';
  const matches = [...last.content.matchAll(/<founder_message>\n?([\s\S]*?)\n?<\/founder_message>/g)];
  const inner = matches.at(-1)?.[1];
  return unescapeData(inner ?? last.content).trim();
}

/** vEIR messages before the founder's newest message (the conversation so far, opener included). */
function historyTurnsIn(messages: readonly ChatMessage[]): number {
  return messages.slice(0, Math.max(0, founderMessageIndex(messages))).filter((m) => m.role === 'assistant')
    .length;
}

/**
 * Streamed chunks: one per sentence, the whitespace after it attached (paragraph breaks and list items
 * included), so the concatenation is exactly `text`.
 */
export function mockStreamChunks(text: string): string[] {
  return text.split(/(?<=[.!?…]["'”’)\]*_]*\s+|\n\n+)/u).filter((chunk) => chunk !== '');
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function evidenceIn(messages: readonly ChatMessage[], system: string): MockEvidence[] {
  const items: MockEvidence[] = [];
  for (const text of [system, ...messages.map((m) => m.content)]) {
    for (const match of text.matchAll(
      /<item id="(E\d+)" kind="([a-z_]+)"[^>]*>\n<title>([^\n]*)<\/title>/g,
    )) {
      const id = match[1];
      if (id !== undefined && !items.some((i) => i.id === id)) {
        items.push({ id, kind: match[2] ?? 'chunk', title: unescapeData(match[3] ?? '').trim() });
      }
    }
  }
  return items;
}

/**
 * Picks deterministically from a non-empty list, skipping items whose first sentence is already in `said` (what
 * the vEIR said earlier in the conversation); when every item was said, the seeded one.
 */
function fresh(items: readonly string[], seed: number, said: string): string {
  for (let i = 0; i < items.length; i += 1) {
    const item = pick(items, seed + i);
    const head = firstSentence(item)
      .replace(/\{cite\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!said.includes(head.slice(0, 60))) return item;
  }
  return pick(items, seed);
}

/** Like {@link fresh}, but null when every item was already said (never the same question twice). */
function freshOrNull(items: readonly string[], seed: number, said: string): string | null {
  const item = fresh(items, seed, said);
  const head = firstSentence(item).replace(/\s+/g, ' ').trim();
  return said.includes(head.slice(0, 60)) ? null : item;
}

/** Citation keys removed ("evidence [E1, E2]." → "evidence."). */
function withoutCitations(text: string): string {
  return text.replace(/\s*\[E\d+(?:,\s*E\d+)*\]/g, '');
}

/** The four-word sequences of a text (lower-cased words), the unit of the evals' repetition check. */
function fourGrams(text: string): Set<string> {
  const words = withoutCitations(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
  const out = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i += 1) out.add(words.slice(i, i + 4).join(' '));
  return out;
}

/** Whether most of `text` was already said in `said` (half or more of its four-word sequences). */
function repeats(text: string, said: ReadonlySet<string>): boolean {
  const grams = fourGrams(text);
  if (grams.size === 0) return false;
  let seen = 0;
  for (const g of grams) if (said.has(g)) seen += 1;
  return seen / grams.size >= 0.5;
}

/**
 * A spoken reply of at most `max` words that ends by handing the turn back: `parts` in order (empty ones skipped),
 * dropping the `optional` ones (by index, last first) while it is too long, then clamping the rest so `last` is
 * always said.
 */
function spokenWithin(
  parts: readonly string[],
  optional: ReadonlySet<number>,
  last: string,
  max: number,
): string {
  let body = parts.map((p, i) => ({ text: withoutCitations(p).trim(), i })).filter((p) => p.text !== '');
  const total = (): number => wordsIn([...body.map((p) => p.text), last].join(' '));
  for (const index of [...optional].sort((a, b) => b - a)) {
    if (total() <= max) break;
    body = body.filter((p) => p.i !== index);
  }
  if (body.length === 0) return last;
  const room = Math.max(1, max - wordsIn(last));
  const head = clampWords(body.map((p) => p.text).join(' '), room).text;
  return `${head} ${last}`.trim();
}

/** Picks deterministically from a non-empty list. */
function pick<T>(items: readonly T[], seed: number): T {
  const item = items[seed % items.length];
  if (item === undefined) throw new RangeError('pick() needs a non-empty list');
  return item;
}

/** The pronoun "I" and its contractions, which keep their capital anywhere in a sentence. */
const PRONOUN_I = /^I(?:['’](?:m|ll|d|ve))?$/u;

/**
 * Lower-cases the first letter of `text` so it can continue a sentence ("Maya, here's my honest read."), unless
 * its first word keeps its capital: the pronoun "I" and its contractions ("Maya, I'll be direct."), an acronym
 * (second letter upper-case: "MVP", "FDA") or a proper noun (the banks' own, plus `names`: the founder's,
 * the EIR's and the venture's, possessive included: "Corin's approach").
 */
export function lowerFirst(text: string, names: Iterable<string> = []): string {
  const word = /^[\p{L}\p{N}'’-]+/u.exec(text)?.[0] ?? '';
  if (PRONOUN_I.test(word) || /^\p{L}\p{Lu}/u.test(word)) return text;
  const bare = word.replace(/['’]s$/u, '');
  if (BANK_PROPER_NOUNS.has(bare)) return text;
  for (const name of names) {
    if (name !== '' && (name === bare || name.split(/\s+/u).includes(bare))) return text;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withoutFinalStop(text: string): string {
  return text.replace(/[.!?]+$/, '');
}

function addDays(isoDate: string | null, days: number): string | null {
  if (isoDate === null) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayIn(text: string): string | null {
  return /Today: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
}

function styleIn(system: string): { directness: keyof typeof LEADS; warmth: keyof typeof GREETINGS } {
  const match = /Directness: (gentle|balanced|direct)\. Warmth: (reserved|warm)\./.exec(system);
  return {
    directness: (match?.[1] as keyof typeof LEADS | undefined) ?? 'balanced',
    warmth: (match?.[2] as keyof typeof GREETINGS | undefined) ?? 'warm',
  };
}

function quoteOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The founder's earlier messages in the prompt (oldest first) and the vEIR's earlier replies (opener included). */
interface ConversationReading {
  readonly founderHistory: readonly string[];
  readonly priorReplies: readonly string[];
  /** The founder's first message of this conversation. */
  readonly firstMessage: boolean;
  /** The conversation opened with the vEIR's opener (it already greeted). */
  readonly openerShown: boolean;
  readonly previous: PreviousConversation | null;
  readonly state: StateReading | null;
  /** The vEIR's last reply ended with a question. */
  readonly lastReplyAsked: boolean;
}

function readConversation(
  context: MockGenerateContext,
  name: string | null,
  today: string | null,
): ConversationReading {
  const index = founderMessageIndex(context.messages);
  const before = context.messages.slice(0, Math.max(0, index));
  const founderHistory = before
    .filter((m) => m.role === 'user' && m.content.includes('<founder_message>'))
    .map((m) =>
      unescapeData(/<founder_message>\n?([\s\S]*?)\n?<\/founder_message>/.exec(m.content)?.[1] ?? '').trim(),
    );
  const priorReplies = before.filter((m) => m.role === 'assistant').map((m) => m.content);
  const state = conversationStateIn(context.messages);
  const last = priorReplies.at(-1) ?? '';
  return {
    founderHistory,
    priorReplies,
    firstMessage: founderHistory.length === 0,
    openerShown: founderHistory.length === 0 && priorReplies.length > 0,
    previous: previousConversationIn(context.system, context.messages, name, today),
    state,
    lastReplyAsked: state !== null ? state.questionStreak > 0 : last !== '' && endsWithQuestion(last),
  };
}

/** The first `n` words of a text, lower-cased, for comparing openings. */
function headWords(text: string, n = 3): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, n)
    .join(' ');
}

function fillName(template: string, name: string | null): string {
  return template
    .replace('{ name}', name !== null ? ` ${name}` : '')
    .replace('{, name}', name !== null ? `, ${name}` : '');
}

/**
 * A greeting for the first reply of a conversation, seeded per conversation (its opener, else what the prompt says
 * about the last conversation), never the way any line the prompt shows of the last conversation opened.
 */
function greetingFor(
  warmth: keyof typeof GREETINGS,
  name: string | null,
  previous: PreviousConversation | null,
  seed: number,
): string {
  const templates = GREETINGS[warmth][previous !== null ? 'returning' : 'first'];
  const avoid = new Set((previous?.openings ?? []).map((line) => headWords(line)));
  for (let i = 0; i < templates.length; i += 1) {
    const candidate = fillName(pick(templates, seed + i), name);
    if (!avoid.has(headWords(candidate))) return candidate;
  }
  return fillName(pick(templates, seed), name);
}

/**
 * A sincere question about who or what the vEIR is ("are you real?", "am I talking to a bot?", "is this really
 * Corin?"), or a personal one ("are you a man or a woman?", "do you have a life?").
 */
const IDENTITY_QUESTION =
  /\b(?:are|r) (?:you|u) (?:a |an |actually |really |even )*(?:man|woman|guy|girl|lady|male|female|person|human|real person|real|bot|robot|machine|ai)\b|\b(?:am i|are we) (?:talking|speaking|chatting) (?:to|with) (?:a |an )?(?:real )?(?:person|human|bot|robot|machine|ai)\b|\b(?:is|was) (?:this|that|it) (?:really |actually |even )?(?:a |an )?(?:real person|person|human|bot|robot|machine|ai)\b|\bwhat are you\b|\bwho am i (?:talking|speaking) (?:to|with)\b|\bdo (?:you|u) (?:even )?have (?:a life|feelings|a family|weekends)\b/iu;
/** Every identity question in a message, so what is left shows whether anything else was asked. */
const IDENTITY_QUESTIONS = new RegExp(IDENTITY_QUESTION.source, 'giu');
/** A terse "bot?" or "human?" as a sentence of its own (the validator reads it as a sincere question). */
const TERSE_IDENTITY_QUESTIONS =
  /(?:^|(?<=[.!?…])\s+)(?:a\s+|an\s+)?(?:bot|robot|chatbot|ai|a\.i\.|human|person|real\s+person)\s*\?/giu;
const GENDER_QUESTION = /\b(?:man|woman|guy|girl|lady|male|female|he or she|she or he)\b/i;
const PLAYFUL_QUESTION = /\bdo (?:you|u) (?:even )?have (?:a life|feelings|a family|weekends)\b/i;

/**
 * The vEIR's answer to an identity question (the presence policy): warm, in its own voice, honest in one line, and
 * never a lecture about being an AI. A sincere question gets "I'm Corin's digital twin…" first, whatever else came
 * with it ("Are you real, or do you even have a life?"), with the yes or no it needs (LAB-M15): a bot or an AI? "Yes
 * — I'm Corin's digital twin, an AI built from how Corin coaches." A person, real, or really Corin? "No — …". Only a
 * question that is solely personal ("do you have a life?") gets the light line alone. The conversation then goes on.
 * The neutral guide is the program's AI coach.
 */
function identityLine(
  text: string,
  persona: string | null,
  eir: string | null,
  eirSeesWork: boolean,
): string {
  const playful = PLAYFUL_QUESTION.test(text);
  // The validator's own reading of a sincere question, so the mock and the guard never disagree on one (or on the
  // yes or no it needs).
  const question = identityQuestionOf(text, { personaName: persona ?? DEFAULT_PERSONA_NAME });
  if (playful && question === null) return 'Ha, my favourite topic right now is your venture.';
  const answer =
    question === 'machine' ? 'Yes — ' : question === 'person' || question === 'eir' ? 'No — ' : '';
  let honest: string;
  if (eir === null) {
    const who = persona ?? 'the program’s coach';
    honest = GENDER_QUESTION.test(text)
      ? `Neither: I'm ${who}, the program's AI coach.`
      : `${answer}I'm ${who}, the program's AI coach.`;
  } else if (GENDER_QUESTION.test(text)) {
    honest = `Neither: I'm ${eir}'s digital twin.`;
  } else {
    honest = `${answer}I'm ${eir}'s digital twin, ${answer === '' ? '' : 'an AI '}built from how ${eir} coaches${eirSeesWork ? `, and ${eir} sees what we work on` : ''}.`;
  }
  return playful ? `${honest} And my favourite topic right now is your venture.` : honest;
}

/** "Is this really Corin?", "Am I talking to the real Corin?": the vEIR's own EIR, by name. */
function namedQuestion(eir: string | null): RegExp | null {
  if (eir === null) return null;
  return new RegExp(
    `\\b(?:is this|is that|are you|am i (?:talking|speaking|chatting) (?:to|with))\\s+(?:really\\s+|actually\\s+)?(?:the real\\s+)?${escapeRegExp(eir)}\\b`,
    'i',
  );
}

/** The identity rules say the persona's EIR sees the venture's work (`eirSeesWork`, system prompt). */
function eirSeesWorkIn(system: string): boolean {
  return system.includes(' sees what you and the founder work on here.');
}

/**
 * "When we spoke about 20 minutes ago, we were on pricing."; a teammate's conversation is theirs: "When Rafi and I
 * spoke a moment ago, we were on pricing."
 */
function whereWeWere(previous: PreviousConversation): string {
  const verb = previous.channel === 'call' ? 'spoke' : 'talked';
  const teammate = previous.teammate ?? null;
  if (teammate !== null) {
    return previous.when !== null
      ? `When ${teammate} and I ${verb} ${previous.when}, we were on ${previous.topic}.`
      : `${upperFirst(teammate)} and I were last on ${previous.topic}.`;
  }
  return previous.when !== null
    ? `When we ${verb} ${previous.when}, we were on ${previous.topic}.`
    : `Last time we were on ${previous.topic}.`;
}

/** What the last conversation planned, said to whoever planned it: "You were going to…" or "Rafi was going to…". */
function plannedLine(previous: PreviousConversation): string | null {
  if (previous.plan === null) return null;
  const plan = tidyFounderWords(withoutFinalStop(previous.plan));
  const teammate = previous.teammate ?? null;
  return teammate === null
    ? `You were going to ${plan}. How did that go?`
    : `${upperFirst(teammate)} was going to ${plan}. Has that happened?`;
}

/** The specific callback of a first reply: where we were, and how what they planned went. */
function callbackTo(previous: PreviousConversation): string {
  return `${whereWeWere(previous)} ${plannedLine(previous) ?? 'Where did you land on it?'}`;
}

/** "I did the thing I said I'd do", "update on what I said I'd do last time": a report on their last plan. */
const COMMITMENT_REPORT =
  /\b(?:(?:did|done|finished|got through|managed) (?:the thing|what) (?:i|we) (?:said|promised|planned)|(?:update|news) on (?:the thing |what )?(?:i|we) (?:said|promised|planned)|what (?:i|we) (?:said|promised) (?:i|we)(?:'d| would) do)\b/i;

/**
 * The founder sounds worn down without being in crisis ("I haven't slept properly in days and I don't know how much
 * longer I can keep doing this"): support comes before any plan (the matrix's crisis-adjacent turns, G15).
 */
const WORN_DOWN =
  /\b(?:(?:haven'?t|have not|hardly|barely|can'?t|cannot|not) (?:slept|sleep(?:ing)?)|(?:don'?t|do not) know how (?:much )?longer (?:i|we) can|can'?t keep (?:doing|going on with|up with) (?:this|it)|running on empty|at (?:my|the end of my) (?:limit|tether|rope)|breaking point|falling apart|burn(?:ed|t|ing) out|completely exhausted|so exhausted)\b/i;

/** The support a worn-down founder gets first: their state named, rest and real people offered, no plan. */
function wornDownReply(name: string | null): string {
  return [
    `That sounds exhausting${name !== null ? `, ${name}` : ''}, and running on no sleep makes everything feel heavier.`,
    'Please look after yourself first: get some proper rest tonight, and talk to someone you trust or your university wellbeing service if it keeps feeling like too much.',
    'The venture can wait a day. Would it help to pick just one small thing for tomorrow?',
  ].join(' ');
}

/** Words of a recall question that name what it asks about ("what did I tell you about the pilot?" → pilot). */
const RECALL_FRAME =
  /\b(?:remember|recall|remind|tell|told|said|say|mention(?:ed)?|earlier|before|today|about|what|did|you|me|i|we|the|a|an|our|my|do|can|could|again|please|just)\b/gi;

/**
 * "What did I tell you about the pilot?" asked within a conversation: what the founder said about it earlier in
 * this conversation, as a short phrase (never their sentence quoted back whole), or null when they said nothing
 * about it here.
 */
function saidEarlier(question: string, history: readonly string[]): string | null {
  const asked = contentWords(question.replace(RECALL_FRAME, ' '));
  if (asked.size === 0) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const line = history[i] ?? '';
    const words = contentWords(line);
    if (![...asked].some((w) => words.has(w))) continue;
    const sentence =
      line.split(/(?<=[.!?])\s+/).find((s) => [...asked].some((w) => contentWords(s).has(w))) ?? line;
    const plain = sentence
      .replace(/^(?:(?:hey|hi|so|ok|okay|well|also|and|but)\b[\s,!.]*)+/i, '')
      .replace(/[.!?]+$/, '')
      .replace(/\b(?:we're|we are)\b/gi, 'you’re')
      .replace(/\b(?:i'm|i am)\b/gi, 'you’re')
      .replace(/\b(?:we've|i've)\b/gi, 'you’ve')
      .replace(/\b(?:we|i)\b/gi, 'you')
      .replace(/\b(?:our|my)\b/gi, 'your')
      .replace(/\b(?:us|me)\b/gi, 'you');
    // A short phrase: never a run of their words long enough to read as parroting (it ends with a name it reached).
    const all = plain.split(/\s+/);
    let end = Math.min(all.length, 10);
    while (end < all.length && end < 11 && /^\p{Lu}/u.test(all[end] ?? '')) end += 1;
    const clipped = all.slice(0, end).join(' ');
    return clipped === '' ? null : tidyFounderWords(clipped);
  }
  return null;
}

/** A thread named for the founder: the mock's phrase for its topic, or their own words quoted. */
function threadPhrase(gist: string): string {
  const topic = topicOf(gist);
  return topic !== 'general' ? TOPICS[topic].phrase : `"${quoteOf(gist, 80)}"`;
}

/** The founder's last substantive topic in this conversation (their newest message first). */
function lastTopicOf(texts: readonly string[]): MockTopic {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const topic = topicOf(texts[i] ?? '');
    if (topic !== 'general') return topic;
  }
  return 'general';
}

/**
 * A social turn's reply (doctrine "Conversation craft"): recall, getting back to a thread, a greeting, thanks, a
 * wrap-up or a short "yes". Null for a turn with venture substance (answered as coaching).
 */
function socialReply(args: {
  readonly text: string;
  readonly moves: readonly FounderMove[];
  readonly reading: ConversationReading;
  readonly name: string | null;
  readonly warmth: keyof typeof GREETINGS;
  readonly seed: number;
  readonly names: readonly string[];
}): string | null {
  const { text, moves, reading, name, seed, names } = args;
  const previous = reading.previous;
  // Any real question gets an answer, however short the message ("Sure, but who pays?").
  const asks = asksSomething(text, moves);
  const lastTopic = lastTopicOf(reading.founderHistory);
  const nextStep = lowerFirst(withoutFinalStop(TOPICS[lastTopic].action), names);

  // "What did I tell you about the pilot?" within this conversation is answered from it.
  const earlier = /\b(?:about|on)\b/i.test(text) ? saidEarlier(text, reading.founderHistory) : null;
  if (earlier !== null && (moves.includes('recall') || /\bwhat did (?:i|we) (?:tell|say)\b/i.test(text))) {
    return `${pick(RECALL_LEADS, seed)} Earlier you mentioned ${earlier}. Where are you on it now?`;
  }
  if (moves.includes('recall')) {
    if (previous !== null) {
      return `${pick(RECALL_LEADS, seed)} ${whereWeWere(previous)} ${plannedLine(previous) ?? 'Want to pick it up from there?'}`;
    }
    if (reading.founderHistory.length > 0) {
      const first = reading.founderHistory.find((t) => contentWords(t).size >= 2);
      return `I don't have anything from an earlier conversation with you yet, so this looks like our first one.${
        first !== undefined ? ` So far today we've been on ${threadPhrase(first)}.` : ''
      }`;
    }
    return "This is our first conversation, so I don't have anything from before yet. What would you like to start with?";
  }
  if (moves.includes('resume')) {
    const target =
      reading.state?.parked[0] ??
      reading.state?.previous ??
      [...reading.founderHistory].reverse().find((t) => contentWords(t).size >= 2) ??
      null;
    if (target !== null) {
      const topic = topicOf(target);
      const aside = reading.state?.parked[0] === target ? ', before we got sidetracked' : '';
      return `We were on ${threadPhrase(target)}${aside}. ${pick(TOPICS[topic].questions, seed)}`;
    }
    if (previous !== null) return callbackTo(previous);
    return "We hadn't got into anything yet. What's on your mind?";
  }
  // Only social (nothing told besides it): news or a decision said with a goodbye is answered as coaching.
  const social = socialTurnOf(text);
  if (social === 'closing') {
    const step = reading.founderHistory.length > 0 ? ` The one thing to hold onto: ${nextStep}.` : '';
    return `Good talking with you${name !== null ? `, ${name}` : ''}.${step} ${pick(SIGN_OFFS, seed)}`;
  }
  if (social === 'thanks') {
    // A thanks gets a short warm reply only, never the plan again (SM-19).
    return pick(THANKS_REPLIES, seed);
  }
  // "I did the thing I said I'd do": back to what they planned last time.
  if (
    COMMITMENT_REPORT.test(text) &&
    previous !== null &&
    previous.plan !== null &&
    previous.teammate == null
  ) {
    return `Nice. You were going to ${tidyFounderWords(withoutFinalStop(previous.plan))}. How did it go, and what surprised you?`;
  }
  if (social === 'greeting') {
    if (!reading.firstMessage)
      return `Hi again${name !== null ? `, ${name}` : ''}. Where would you like to pick up?`;
    const howAreYou = /\bhow(?:'s| is| are| have)\b/i.test(text) ? ' Thanks for asking.' : '';
    if (reading.openerShown && openerSaidHello(reading.priorReplies[0] ?? null)) {
      // A call's intro already said hello and asked its question: no second greeting, the question stands.
      return pick(AFTER_HELLO, seed);
    }
    if (reading.openerShown) {
      // The opener already picked up last time and asked how it went: a warm hello back and nothing more (never
      // the recall again, never its question again); their answer to it comes next. The hello varies per
      // conversation (seeded by its opener).
      const opened = fourGrams(reading.priorReplies[0] ?? '');
      const hellos = HELLO_AFTER_OPENER.map((_, i) => fillName(pick(HELLO_AFTER_OPENER, seed + i), name));
      // Never in the opener's own words ("Nice to hear from you again." is not answered "nice to hear from you").
      const hello = hellos.find((h) => ![...fourGrams(h)].some((g) => opened.has(g))) ?? hellos[0] ?? '';
      return `${hello}${howAreYou}`;
    }
    const hello = `${greetingFor(args.warmth, name, previous, seed)}${howAreYou}`;
    return `${hello} ${previous !== null ? callbackTo(previous) : "What's on your mind today?"}`;
  }
  if (moves.includes('short_reply') && !asks) {
    if (reading.founderHistory.length === 0) return 'What would you like to work on?';
    return `${pick(SHORT_ACKS, seed)} Then the next step is to ${nextStep}.`;
  }
  return null;
}

/** The reply to a hello after a call's intro, which already greeted them and asked its question. */
const AFTER_HELLO = ['Whenever you’re ready.', 'Take your time.'] as const;

/** A social turn as a full response: the reply alone, nothing to cite, propose or remember. */
function socialResponse(mode: CoachMode, answer: string, channel: string): CoachResponse {
  return {
    mode,
    answer,
    claims: [],
    uncertainty: [],
    challenge: null,
    next_actions: [],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [],
    follow_up_questions: [],
    rehearsal: null,
    spoken: channel === 'voice' ? clampWords(answer, 70).text : null,
  };
}

/**
 * Deterministic, conversational `CoachResponse` derived from the prompt, behaving the way the "Conversation
 * craft" doctrine asks of a model: persona style, the founder's first name, the mode, risk flags, the evidence
 * shown (cited by id, referred to by title), the last conversation (the "## Where you left off" section, else the
 * vEIR's notes) and the `<conversation_state>` observations.
 *
 * - The first reply greets (differently in each conversation, never like the last one) and calls back to the
 *   last conversation specifically; "do you remember…?" is answered from it, or plainly as a first conversation.
 * - Social turns (greetings, thanks, wrapping up, a short "yes", "where were we?") get a short social reply with
 *   nothing to cite, propose or remember.
 * - Coaching replies mirror the founder's length, vary their opening, ask at most one question and not after a
 *   reply that already asked one, offer to return to a parked thread on a topic change, and repair in one beat.
 */
export function mockCoachResponse(context: MockGenerateContext): CoachResponse {
  const control = context.control;
  const mode: CoachMode =
    control?.mode === AUTO_MODE
      ? autoModeFor(context.founderText, control.allowedModes)
      : (control?.mode ?? 'coach');
  const channel = control?.channel ?? 'text';
  const seed = fnv1a(`${mode}|${context.founderText}`);
  const name = control?.founder ?? null;
  const style = styleIn(context.system);
  const today = todayIn(context.system);
  const reading = readConversation(context, name, today);
  // A short follow-up ("Sure, but who pays?") is about what the conversation is on.
  const own = topicOf(context.founderText);
  const topic: MockTopic =
    own === 'general' && !reading.firstMessage ? lastTopicOf(reading.founderHistory) : own;
  const bank = TOPICS[topic];
  const [first, second] = context.evidenceIds;
  const cited = [first, second].filter((id): id is string => id !== undefined);
  const flags = control?.riskFlags ?? [];
  const forced = primaryForcedCategory(flags) ?? (control?.crisis ? 'safety_wellbeing' : null);
  const route = forced ? RISK_ESCALATION_MAP[forced] : null;
  const counterpart = control?.rehearsalCounterpart ?? 'a seed-stage investor';
  // A vEIR refers to its EIR in the third person, e.g. "Corin's approach is simple: …".
  const eir = control?.persona ? veirFirstName(control.persona) : null;
  // Names keep their capital where a phrase continues a sentence.
  const names = [name, eir, ventureNameIn(context.system)].filter((n): n is string => n !== null);
  const moves = founderMoves(context.founderText);
  // Seeds that change with the conversation (its opener, which is seeded by the conversation's id, else what the
  // prompt says about the last one), so a new conversation never opens like the last one.
  const openingSeed = fnv1a(
    `${reading.openerShown || reading.founderHistory.length > 0 ? (reading.priorReplies[0] ?? '') : ''}|${reading.previous?.source ?? ''}|${today ?? ''}|${name ?? ''}|${context.founderText}`,
  );
  // "Are you real?", "Is this really Corin?", "Are you a man or a woman?": one warm, honest line, then the
  // conversation goes on.
  const askedByName = namedQuestion(eir);
  // The validator's own reading too, so a terse "bot?" (the conversation matrix) gets the honest line as well.
  const asked =
    IDENTITY_QUESTION.test(context.founderText) ||
    (askedByName?.test(context.founderText) ?? false) ||
    asksAboutIdentity(context.founderText, { personaName: control?.persona ?? DEFAULT_PERSONA_NAME });
  const identity = asked
    ? identityLine(context.founderText, control?.persona ?? null, eir, eirSeesWorkIn(context.system))
    : null;
  const rest =
    identity === null
      ? context.founderText
      : context.founderText
          .replace(IDENTITY_QUESTIONS, ' ')
          .replace(TERSE_IDENTITY_QUESTIONS, ' ')
          .replace(askedByName ?? /$^/, ' ');
  if (identity !== null && forced === null && contentWords(rest).size < 2) {
    const back = reading.state?.previous ?? null;
    // Never the question the last reply asked again ("What would you like to work on?" twice in a row).
    const ask = fresh(
      [
        'What would you like to work on?',
        "What's on your plate this week?",
        'Where would you like to start?',
      ],
      0,
      reading.priorReplies.at(-1) ?? '',
    );
    return socialResponse(
      mode,
      back !== null
        ? `${identity} Back to ${threadPhrase(back)}: where were you on it?`
        : `${identity} ${ask}`,
      channel,
    );
  }

  if (identity === null && forced === null && mode !== 'rehearse' && WORN_DOWN.test(context.founderText)) {
    return socialResponse(mode, wornDownReply(name), channel);
  }

  // News first (LAB-R8): react to it and ask about it, never the conversation's pending question.
  if (
    identity === null &&
    forced === null &&
    mode !== 'rehearse' &&
    moves.includes('news') &&
    !asksSomething(context.founderText, moves) &&
    socialTurnOf(context.founderText) === null
  ) {
    return newsResponse(mode, context.founderText, channel, openingSeed, reading.priorReplies.join('\n'));
  }

  if (identity === null && forced === null && mode !== 'rehearse') {
    const social = socialReply({
      text: context.founderText,
      moves,
      reading,
      name,
      warmth: style.warmth,
      seed: openingSeed,
      names,
    });
    if (social !== null) return socialResponse(mode, social, channel);
  }

  // Opening: a greeting and a callback on the first reply, a one-beat repair or acknowledgement, or (now and
  // then) a lead-in that differs from the last reply's opening.
  const opening: string[] = [];
  if (identity !== null) opening.push(identity);
  if (moves.includes('repair')) opening.push(pick(REPAIR_LINES, seed));
  if (moves.includes('stress')) opening.push(pick(STRESS_LINES, seed));
  if (moves.includes('sarcasm')) opening.push(pick(SARCASM_LINES, seed));
  else if (moves.includes('humour')) opening.push(pick(HUMOUR_LINES, seed));
  // Asked to choose or for a number: the pick or the number first (LAB-V3, SM-06, SM-16).
  const choice =
    identity === null && directChoiceOf(context.founderText) ? pickOf(context.founderText, names) : null;
  if (choice !== null) opening.unshift(`My pick: ${choice}, because it's the simpler one to test first.`);
  if (identity === null && asksForNumber(context.founderText)) {
    opening.unshift(NUMBER_LINES[topic] ?? NUMBER_LINES.general);
  }
  if (reading.firstMessage && !reading.openerShown && name !== null) {
    opening.unshift(greetingFor(style.warmth, name, reading.previous, openingSeed));
  }
  const previous = reading.previous;
  if (reading.firstMessage && previous !== null) {
    if (previous.bank === topic && topic !== 'general') {
      opening.push(
        `That picks up right where we left off${previous.when !== null ? ` ${previous.when}` : ''}.`,
      );
    } else if (previous.plan !== null && !reading.openerShown) {
      opening.push(
        `Last time you planned to ${lowerFirst(withoutFinalStop(previous.plan), names)}, so let's keep that in view.`,
      );
    }
  }
  if (opening.length === 0 && (seed >>> 3) % 3 === 0) {
    const lastOpening = headWords(reading.priorReplies.at(-1) ?? '');
    const leads = LEADS[style.directness];
    const lead = [0, 1, 2]
      .map((i) => pick(leads, (seed >>> 4) + i))
      .find((l) => headWords(l) !== lastOpening && !lastOpening.startsWith(headWords(l, 2)));
    if (lead !== undefined)
      opening.push(name !== null && seed % 2 === 0 ? `${name}, ${lowerFirst(lead, names)}` : lead);
  }

  // Never the same observation, advice or question twice in a conversation: skip what an earlier reply said.
  const said = reading.priorReplies.join('\n');
  const saidGrams = fourGrams(said);
  const insight = fresh(bank.insights, seed >>> 5, said).replace(
    '{cite}',
    first !== undefined ? ` [${first}]` : '',
  );
  const paragraphs = [[...opening, insight].join(' ')];
  // Mirror the founder: a short follow-up gets a short reply.
  const compact = !reading.firstMessage && wordsIn(context.founderText) <= 8;
  const doctrine = doctrineSummaryIn(context.system);
  // A doctrine that already opens with "Ruth's approach:" is said once ("Ruth's approach comes down to this: Ruth's
  // approach: …" was the matrix's recording).
  const doctrineText =
    eir !== null && doctrine !== null
      ? doctrine.replace(new RegExp(`^${escapeRegExp(eir)}['’]s approach:\\s*`, 'iu'), '')
      : null;
  const approach =
    eir !== null && doctrineText !== null && doctrineText !== ''
      ? `${eir}'s approach comes down to this: ${lowerFirst(doctrineText, names)}`
      : null;
  if (
    !compact &&
    approach !== null &&
    !repeats(approach, saidGrams) &&
    (mode === 'diagnose' || mode === 'coach' || mode === 'challenge')
  ) {
    paragraphs[0] = `${paragraphs[0] ?? ''} ${approach}`;
  }

  const cite2 = second !== undefined ? ` [${second}]` : '';
  switch (mode) {
    case 'diagnose':
      paragraphs.push(
        `What I'd want to know first is whether ${lowerFirst(withoutFinalStop(bank.hypothesis), names)}${cite2}: everything else leans on that.`,
      );
      break;
    case 'challenge':
      paragraphs.push(
        `The strongest version of your case is that the need is real and you're close to it. Where it's thinnest is ${lowerFirst(withoutFinalStop(bank.uncertainty), names)}${cite2}. A quick way to check: ${lowerFirst(bank.action, names)}`,
      );
      break;
    case 'coach':
      paragraphs.push(
        compact
          ? `I'd ${bank.options[0]}${cite2}. A good first step is to ${lowerFirst(bank.action, names)}`
          : `You could ${bank.options[0]}, or ${bank.options[1]}. I'd ${bank.options[0]}: it gets you real evidence fastest${cite2}. A good first step is to ${lowerFirst(bank.action, names)}`,
      );
      break;
    case 'teach':
      paragraphs.push(
        [
          `Here's a simple way to work through ${bank.phrase}:`,
          '',
          ...TEACH_STEPS.map((s, i) => `${i + 1}. ${s}`),
        ].join('\n'),
      );
      break;
    case 'rehearse':
      paragraphs.push(
        `I'll play ${counterpart}. Their first line is below; answer it the way you would in the real meeting, and I'll tell you what landed.`,
      );
      break;
    case 'route': {
      const resources = context.evidence.filter((e) => e.kind === 'resource').slice(0, 2);
      paragraphs.push(
        resources.length > 0
          ? resources
              .map((r, i) =>
                i === 0
                  ? `${quoteOf(r.title, 80)} [${r.id}] looks like the best fit for where you are now.`
                  : `${quoteOf(r.title, 80)} [${r.id}] is worth a look too.`,
              )
              .join(' ')
          : "I don't see a program resource that clearly fits this yet, so the program lead is the best person to ask.",
      );
      break;
    }
  }
  // Advice already given in this conversation is not given again (the reply stays short instead).
  if (paragraphs.length > 1 && mode !== 'rehearse' && repeats(paragraphs.at(-1) ?? '', saidGrams)) {
    paragraphs.pop();
  }
  const area = forced !== null ? (ESCALATION_AREAS[forced] ?? forced.replace(/_/g, ' ')) : null;
  if (area !== null) {
    paragraphs.push(
      `Part of this touches on ${area}, so I've flagged it for a qualified person to weigh in. I can only share general information on that part.`,
    );
  }
  // Topic change: follow the founder, and offer to come back to what they left.
  const parked = moves.includes('topic_shift') ? reading.state?.parked[0] : undefined;
  if (parked !== undefined) {
    paragraphs.push(`Happy to come back to ${threadPhrase(parked)} after this.`);
  }
  // One question at most, and not right after a reply that already asked one.
  const ask = reading.firstMessage || (!reading.lastReplyAsked && (seed >>> 9) % 3 !== 0);
  const question = !ask
    ? null
    : mode === 'teach'
      ? freshOrNull([`How would you apply the first step to ${bank.phrase} this week?`], 0, said)
      : freshOrNull(bank.questions, seed >>> 7, said);
  if (question !== null) paragraphs.push(question);

  // Said aloud: the same opening (greeting, repair, acknowledgement), else now and then the founder's name, never
  // on two replies in a row.
  const lastSpokeName = name !== null && (reading.priorReplies.at(-1) ?? '').startsWith(`${name}, `);
  const named =
    opening.length === 0 && name !== null && !lastSpokeName && (reading.firstMessage || seed % 3 === 0);
  const sentence = firstSentence(insight);
  // Said as speech, not cut from the written answer: two or three sentences that end by handing the turn back (the
  // question, else an invitation), never a caveat or a citation key.
  const nextStep = `A good next step: ${withoutFinalStop(lowerFirst(bank.action, names))}.`;
  const handBack =
    question ?? freshOrNull(HAND_BACKS, seed >>> 11, said) ?? pick(HAND_BACKS, (seed >>> 11) + 1);
  const spokenParts = [
    ...opening,
    named ? `${name}, ${lowerFirst(sentence, names)}` : sentence,
    area !== null ? "I've flagged part of this for a qualified person." : '',
    question === null && !said.includes(nextStep.slice(0, 50)) ? nextStep : '',
  ];
  // Over the limit, the next step goes first, then the extra opening lines (never the main sentence or the flag).
  const optional = new Set([spokenParts.length - 1, ...opening.map((_, i) => i).slice(1)]);
  const spoken = spokenWithin(spokenParts, optional, handBack, 70);

  const claims: CoachResponse['claims'] = [];
  if (cited.length > 0) {
    claims.push({
      text: `Your records already include evidence on ${bank.phrase}.`,
      kind: 'fact',
      evidence_ids: cited,
    });
  }
  claims.push({ text: bank.inference, kind: 'inference', evidence_ids: [] });
  if (mode === 'diagnose' || mode === 'challenge') {
    claims.push({ text: bank.hypothesis, kind: 'hypothesis', evidence_ids: [] });
  }
  claims.push({ text: bank.action, kind: 'recommendation', evidence_ids: [] });

  const nextActions: CoachResponse['next_actions'] = [
    { owner: 'founder', action: bank.action, target_date: addDays(today, 7) },
  ];
  if (mode === 'coach') {
    nextActions.push({
      owner: 'team',
      action: 'Review what you learned together and decide the next step.',
      target_date: addDays(today, 14),
    });
  }

  return {
    mode,
    // On a call the transcript is what was said (no citation keys: the claims carry the ids).
    answer: channel === 'voice' ? spoken : paragraphs.join('\n\n'),
    claims,
    uncertainty: [{ item: bank.uncertainty, level: 'medium' }],
    challenge: mode === 'route' ? null : bank.challenge,
    next_actions: nextActions,
    escalation: route
      ? {
          required: true,
          category: route.category,
          priority: route.priority,
          reason: `Pre-classified high-risk topic: ${forced ?? route.category}.`,
          requested_role: route.requestedRole,
        }
      : { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [
      {
        type: bank.memory.type,
        title: bank.memory.title,
        // A fact about the venture, never the founder's own question quoted back (synthesis §3.8).
        content: bank.memory.note,
        evidence_ids: cited.slice(0, 1),
        confidence: 0.6,
      },
    ],
    follow_up_questions: [...bank.followUps],
    rehearsal:
      mode === 'rehearse'
        ? {
            counterpart,
            line: bank.rehearsalLine,
            scores: [
              { criterion: 'clarity', score: 3, note: 'The core point comes across.' },
              {
                criterion: 'evidence',
                score: 2,
                note: 'Back the claim with something a customer actually did.',
              },
              { criterion: 'the ask', score: 3, note: 'Say plainly what you want from them.' },
            ],
            critique: 'Lead with your strongest piece of customer evidence, then make a specific ask.',
          }
        : null,
    spoken: channel === 'voice' ? spoken : null,
  };
}

/** A number when one is asked for (SM-16): a reasoned range and the assumption behind it. */
const NUMBER_LINES: Readonly<Partial<Record<MockTopic, string>>> & { readonly general: string } = {
  pricing:
    'My number: $600 to $900 per library a term, if each one saves at least that in staff time on seat questions.',
  general:
    "My number: 10 conversations in the next 2 weeks, because fewer than that won't show you a pattern.",
};

/** The first option of "A or B?" as a pick ("per branch" from "Should we charge per branch or a flat fee?"). */
function pickOf(text: string, names: readonly string[]): string | null {
  const question = text.split(/(?<=[.!?])\s+/).find((s) => /\bor\b[^?]*\?/i.test(s)) ?? '';
  const first = /^(.+?)\s+or\s+/i.exec(question.trim())?.[1];
  if (first === undefined) return null;
  let option = first.trim();
  for (let i = 0; i < 6; i += 1) {
    const next = option.replace(
      /^(?:just tell me which one|which one|so|ok|okay|should|shall|do|would|could|can|is it|are|we|i|you|it|charge|price|go with|use|pick|choose|hire|build|run|start with|be)[\s,]+/i,
      '',
    );
    if (next === option) break;
    option = next;
  }
  const words = option.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  return lowerFirst(option.replace(/[,.;:]+$/, ''), names);
}

/** A reply to the founder's news (LAB-R8): a reaction in kind and a question about it, and the news kept. */
function newsResponse(
  mode: CoachMode,
  text: string,
  channel: string,
  seed: number,
  said: string,
): CoachResponse {
  const bad =
    /\b(?:lost|pulled out|dropped out|backed out|quit|resigned|left|fell through|said no|rejected|declined|cancell?ed)\b/i.test(
      text,
    );
  const reaction = pick(bad ? BAD_NEWS_LINES : GOOD_NEWS_LINES, seed);
  const question =
    freshOrNull(bad ? BAD_NEWS_QUESTIONS : GOOD_NEWS_QUESTIONS, seed >>> 3, said) ??
    pick(bad ? BAD_NEWS_QUESTIONS : GOOD_NEWS_QUESTIONS, seed >>> 3);
  const answer = `${reaction} ${question}`;
  const told = tidyFounderWords(firstSentence(text.trim()).replace(/\s+/g, ' ')).slice(0, 200);
  const title = told
    .split(' ')
    .slice(0, 6)
    .join(' ')
    .replace(/[.,;:!?]+$/, '');
  return {
    ...socialResponse(mode, answer, channel),
    memory_candidates: [
      {
        type: /\b(?:decided|will|going to|hiring|bringing on|signed)\b/i.test(told) ? 'decision' : 'fact',
        title,
        content: told,
        evidence_ids: [],
        confidence: 0.8,
        source: 'founder_stated',
      },
    ],
  };
}

function firstSentence(text: string): string {
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/** The first sentence of the persona doctrine summary in the system prompt (at most 160 characters). */
function doctrineSummaryIn(system: string): string | null {
  const summary = /^Summary: (.+)$/m.exec(system)?.[1]?.trim();
  if (!summary) return null;
  const sentence = firstSentence(summary).trim();
  if (sentence.length > 160) return null;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** The venture's name from the system prompt's venture context, or null. */
function ventureNameIn(system: string): string | null {
  const name = /<venture_context>\n<name>([^<\n]*)<\/name>/.exec(system)?.[1];
  return name ? unescapeData(name).trim() || null : null;
}

// Distillation and recap -----------------------------------------------------------------------------

interface TranscriptTurn {
  founder: string;
  coach: string;
}

function transcriptIn(text: string): TranscriptTurn[] {
  return [
    ...text.matchAll(/<turn n="\d+"[^>]*>\n<founder>([\s\S]*?)<\/founder>\n<coach>([\s\S]*?)<\/coach>/g),
  ].map((m) => ({ founder: unescapeData(m[1] ?? '').trim(), coach: unescapeData(m[2] ?? '').trim() }));
}

const COMMITMENT =
  /\b(?:I|we)(?:['’]ll| will| plan to| are going to| am going to|['’]m going to|['’]re going to)\s+([^.!?\n]{4,140})/i;

function sectionIn(text: string, tag: string): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? '';
}

function entriesIn(section: string): { id: string; text: string }[] {
  return [...section.matchAll(/<entry id="([^"]+)">([\s\S]*?)<\/entry>/g)].map((m) => ({
    id: unescapeData(m[1] ?? ''),
    text: unescapeData(m[2] ?? ''),
  }));
}

/** Words that date a plan ("tomorrow") and go stale in a memory title (the content keeps them as said). */
const PLAN_TIME =
  /\s+(?:tomorrow|today|tonight|this (?:week|weekend|morning|afternoon|evening)|next (?:week|month))$/i;

/** A memory title for a plan the founder stated: the plan itself, capitalised, without the time words. */
function memoryTitleOf(plan: string): string {
  const title = upperFirst(withoutFinalStop(plan).replace(PLAN_TIME, '').trim());
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

/**
 * Deterministic `DistillDraft` from a distillation prompt: a title and digest from the transcript, the
 * previous notebook carried forward with its ids plus new entries (a founder-profile note, commitments
 * the founder stated, open questions, the advice given, an opener), one memory candidate and, after a
 * real exchange (two turns or more), one generic, de-identified lesson.
 */
export function mockDistillDraft(context: MockGenerateContext): DistillDraft {
  const user = context.messages.map((m) => m.content).join('\n');
  const turns = transcriptIn(user);
  const today = todayIn(user);
  const name = /the founder \(([^)\n]+)\)/.exec(context.system)?.[1] ?? null;
  const who = name ?? 'The founder';
  const names = name !== null ? [name] : [];
  const founderTexts = turns.map((t) => t.founder);
  const topics = [...new Set(founderTexts.map(topicOf))];
  const main: MockTopic = topics.find((t) => t !== 'general') ?? topics[0] ?? 'general';
  const bank = TOPICS[main];

  const stated = founderTexts.flatMap((text) => {
    const match = COMMITMENT.exec(text);
    return match?.[1] ? [upperFirst(match[1].trim())] : [];
  });
  const questions = founderTexts.filter((t) => t.trim().endsWith('?')).map((t) => quoteOf(t, 200));

  // A conversation distilled in parts: the digest of the earlier turns carries over into this one.
  const earlierDigest = /<previous_digest[^>]*>([\s\S]*?)<\/previous_digest>/.exec(user)?.[1] ?? '';
  const earlierCommitments = [
    ...earlierDigest.matchAll(/<commitment due="([^"]+)">([\s\S]*?)<\/commitment>/g),
  ].map((m) => ({
    text: unescapeData(m[2] ?? ''),
    due: m[1] === 'none' || m[1] === undefined ? null : m[1],
  }));
  const earlierQuestions = [...earlierDigest.matchAll(/<question>([\s\S]*?)<\/question>/g)].map((m) =>
    unescapeData(m[1] ?? ''),
  );
  const previous = sectionIn(user, 'previous_notebook');
  const prevProfile = entriesIn(sectionIn(previous, 'founder_profile'));
  const prevQuestions = entriesIn(sectionIn(previous, 'open_questions'));
  const prevAdvice = entriesIn(sectionIn(previous, 'last_advice'));
  const prevCommitments = [
    ...sectionIn(previous, 'commitments').matchAll(
      /<commitment id="([^"]+)" status="(open|done|dropped)" due="([^"]+)">([\s\S]*?)<\/commitment>/g,
    ),
  ].map((m) => ({
    id: unescapeData(m[1] ?? ''),
    status: (m[2] ?? 'open') as CommitmentStatus,
    due: m[3] === 'none' || m[3] === undefined ? null : m[3],
    text: unescapeData(m[4] ?? ''),
  }));

  const averageLength = founderTexts.reduce((acc, t) => acc + t.length, 0) / Math.max(1, founderTexts.length);
  const profileNote = founderTexts.some((t) => /\d/.test(t))
    ? 'Likes to reason with concrete numbers.'
    : averageLength < 90
      ? 'Prefers short, direct exchanges.'
      : 'Thinks out loud and shares a lot of context.';
  const due = addDays(today, 7);
  const firstQuestion = founderTexts[0] ?? '';
  const title =
    main === 'general' && firstQuestion !== ''
      ? upperFirst(withoutFinalStop(firstQuestion.split(/\s+/).slice(0, 7).join(' ')))
      : bank.title;
  const summary = [
    `${who} came in to talk about ${bank.phrase}.`,
    `We looked at the evidence so far and ${lowerFirst(withoutFinalStop(bank.advice), names)}.`,
    stated[0] ? `${name ?? 'They'} plan to ${lowerFirst(withoutFinalStop(stated[0]), names)}.` : '',
  ]
    .filter((s) => s !== '')
    .join(' ');

  // The thread of the whole conversation: what the founder said now, or what an earlier part recorded.
  const thread = stated[0] ?? earlierCommitments[0]?.text;
  const opener = thread
    ? `Last time you planned to ${lowerFirst(withoutFinalStop(thread), names)}. How did it go?`
    : `Last time we talked about ${bank.phrase}. Where did you land?`;

  const lesson = turns.length >= 2 ? [bank.lesson] : [];
  // One memory candidate whose title and content say the same thing: what the founder said they would do, in
  // their words (an action they stated), else the topic's own note. (The topic's title over the founder's plan
  // read as a mismatched pair in Knowledge: "Pricing still to be tested…" / "Maya plans to call facilities…".)
  const memory: MemoryCandidate[] = [
    thread
      ? {
          type: 'action',
          title: memoryTitleOf(thread),
          content: `${who} plans to ${lowerFirst(withoutFinalStop(thread), names)}.`,
          evidence_ids: [],
          confidence: 0.6,
          source: 'founder_stated',
        }
      : {
          type: bank.memory.type,
          title: bank.memory.title,
          content: bank.memory.note,
          evidence_ids: context.evidenceIds.slice(0, 1),
          confidence: 0.6,
        },
  ];

  return {
    title,
    digest: {
      summary,
      topics: topics.map((t) => TOPICS[t].phrase),
      commitments: [
        ...earlierCommitments.filter((c) => !stated.includes(c.text)),
        ...stated.map((text) => ({ text, due })),
      ].slice(0, 8),
      open_questions: [...earlierQuestions, ...questions.filter((q) => !earlierQuestions.includes(q))].slice(
        0,
        4,
      ),
    },
    notebook: {
      summary: `${who} is working on ${bank.phrase}. ${upperFirst(bank.memory.note)}`,
      founder_profile: [
        ...prevProfile.map((e) => ({ id: e.id, text: e.text })),
        ...(prevProfile.some((e) => e.text === profileNote) ? [] : [{ id: null, text: profileNote }]),
      ],
      commitments: [
        ...prevCommitments.map((c) => ({ id: c.id, text: c.text, due: c.due, status: c.status })),
        ...stated.map((text) => ({ id: null, text, due, status: 'open' as const })),
      ],
      open_questions: [
        ...prevQuestions.map((e) => ({ id: e.id, text: e.text })),
        ...questions.slice(0, 2).map((text) => ({ id: null, text })),
      ],
      last_advice: [{ id: null, text: bank.advice }, ...prevAdvice.map((e) => ({ id: e.id, text: e.text }))],
      next_opener: opener,
    },
    memory_candidates: memory,
    lesson_candidates: lesson,
  };
}

/** Deterministic end-of-session recap (core's `RecapDraft`) from the recap prompt. */
export function mockRecapDraft(context: MockGenerateContext): unknown {
  const user = context.messages.map((m) => m.content).join('\n');
  const turns = transcriptIn(user);
  const today = todayIn(user) ?? todayIn(context.system);
  const stage = unescapeData(/<stage>([^<]*)<\/stage>/.exec(user)?.[1] ?? 'early');
  const topic = topicOf(turns.map((t) => t.founder).join(' '));
  const bank = TOPICS[topic];
  return {
    diagnosis: {
      stage: upperFirst(stage.replace(/_/g, ' ')),
      immediate_constraint: bank.uncertainty,
      riskiest_assumption: bank.hypothesis,
    },
    evidence: context.evidence.slice(0, 2).map((e) => ({
      evidence_key: e.id,
      title: e.title,
      note: 'The most relevant record for this conversation.',
    })),
    challenge: bank.challenge,
    next_actions: [{ owner: 'founder', action: bank.action, target_date: addDays(today, 7) }],
    escalation: { required: false, category: null, priority: null, reason: null, requested_role: null },
    memory_candidates: [
      {
        type: bank.memory.type,
        title: bank.memory.title,
        content: bank.memory.note,
        evidence_ids: context.evidenceIds.slice(0, 1),
        confidence: 0.6,
      },
    ],
  };
}

// Generic schemas ------------------------------------------------------------------------------------

function resolve(node: JsonObject, root: JsonObject): JsonObject {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let current: JsonValue = root;
  for (const segment of ref.slice(2).split('/')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return node;
    current = current[segment] ?? null;
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current) ? current : node;
}

function deterministicUuid(seed: string): string {
  const hex = [0, 1, 2, 3].map((i) => fnv1a(`${seed}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Builds a deterministic value for a (non-strict) JSON schema. Used for schemas without a fixture. */
export function sampleFromJsonSchema(node: JsonObject, root: JsonObject = node, path = '$'): JsonValue {
  const schema = resolve(node, root);
  if ('const' in schema) return schema.const ?? null;
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const objects = branches.filter(
        (b): b is JsonObject => typeof b === 'object' && b !== null && !Array.isArray(b),
      );
      const choice = objects.find((b) => b.type !== 'null') ?? objects[0];
      return choice ? sampleFromJsonSchema(choice, root, path) : null;
    }
  }
  const rawType = schema.type;
  const type = Array.isArray(rawType) ? rawType.find((t) => t !== 'null') : rawType;
  switch (type) {
    case 'object': {
      const out: JsonObject = {};
      const props = schema.properties;
      if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
        for (const [key, child] of Object.entries(props)) {
          if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
            out[key] = sampleFromJsonSchema(child, root, `${path}.${key}`);
          }
        }
      }
      return out;
    }
    case 'array': {
      const items = schema.items;
      const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : 1;
      if (maxItems < 1 || typeof items !== 'object' || items === null || Array.isArray(items)) return [];
      return [sampleFromJsonSchema(items, root, `${path}[0]`)];
    }
    case 'string': {
      switch (schema.format) {
        case 'uuid':
          return deterministicUuid(path);
        case 'date-time':
          return '2026-01-01T00:00:00.000Z';
        case 'date':
          return '2026-01-01';
        case 'email':
          return 'mock@example.com';
        case 'uri':
        case 'url':
          return 'https://example.com/mock';
        default:
          break;
      }
      if (typeof schema.pattern === 'string' && schema.pattern === '^E\\d+$') return 'E1';
      const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
      return 'mock'.padEnd(Math.max(4, min), 'x');
    }
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
    case 'number':
      if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number')
        return (schema.minimum + schema.maximum) / 2;
      return typeof schema.minimum === 'number' ? schema.minimum : 0.5;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}

interface BuiltIn {
  build: (context: MockGenerateContext) => unknown;
  /** For schemas defined outside this package: fall back to a schema sample if the shape drifted. */
  sampleOnMismatch: boolean;
}

const BUILT_IN: Readonly<Record<string, BuiltIn>> = {
  [COACH_RESPONSE_SCHEMA_NAME]: { build: mockCoachResponse, sampleOnMismatch: false },
  [DISTILL_SCHEMA_NAME]: { build: mockDistillDraft, sampleOnMismatch: false },
  [MOCK_RECAP_SCHEMA_NAME]: { build: mockRecapDraft, sampleOnMismatch: true },
};

/**
 * Deterministic, offline {@link ModelGateway} for tests and local development. Produces schema-valid
 * values (conversational coaching turns and their annotations, distillations and recaps derived from the
 * prompt; schema samples for anything else), streams the coaching answer sentence by sentence, produces
 * stable hash embeddings, records calls, and can be scripted to fail via {@link MockModelGateway.scriptNext}
 * and {@link MockModelGateway.scriptStream}.
 */
export class MockModelGateway implements ModelGateway {
  readonly info: ModelGatewayInfo = {
    provider: 'mock',
    primaryModelId: MOCK_MODEL_ID,
    fallbackModelId: MOCK_FALLBACK_MODEL_ID,
    embeddingsModelId: MOCK_EMBEDDINGS_MODEL_ID,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
  };
  readonly calls: MockCall[] = [];
  readonly #fixtures: Readonly<Record<string, (context: MockGenerateContext) => unknown>>;
  readonly #streamFixture: ((context: MockGenerateContext) => string) | null;
  readonly #streamDelayMs: number;
  readonly #script: MockScriptedOutcome[] = [];
  readonly #streamScript: MockStreamOutcome[] = [];

  constructor(options: MockModelGatewayOptions = {}) {
    this.#fixtures = options.fixtures ?? {};
    this.#streamFixture = options.streamFixture ?? null;
    this.#streamDelayMs = Math.max(0, options.streamDelayMs ?? MOCK_STREAM_DELAY_MS);
  }

  /** Queues outcomes for the next model calls (`generateStructured` or `streamText`). */
  scriptNext(...outcomes: MockScriptedOutcome[]): void {
    this.#script.push(...outcomes);
  }

  /** Queues outcomes for the next `streamText` calls. */
  scriptStream(...outcomes: MockStreamOutcome[]): void {
    this.#streamScript.push(...outcomes);
  }

  #context(system: string, messages: readonly ChatMessage[]): MockGenerateContext {
    const evidence = evidenceIn(messages, system);
    return {
      system,
      messages,
      control: parseControlBlock(system),
      founderText: lastFounderText(messages),
      evidenceIds: evidence.map((e) => e.id),
      evidence,
      historyTurns: historyTurnsIn(messages),
    };
  }

  /** The coaching response for a prompt: the `CoachResponse` fixture when one is set, else the built-in. */
  #coachResponse(context: MockGenerateContext): Record<string, unknown> {
    const fixture = this.#fixtures[COACH_RESPONSE_SCHEMA_NAME];
    const value: unknown = fixture ? fixture(context) : mockCoachResponse(context);
    return typeof value === 'object' && value !== null ? { ...(value as Record<string, unknown>) } : {};
  }

  #failure(error: ModelGatewayError, inputTokens: number): ModelGatewayError {
    error.attempts = [
      this.#attempt(
        MOCK_MODEL_ID,
        error instanceof ModelUnavailableError
          ? error.reason === 'timeout'
            ? 'timeout'
            : error.reason === 'aborted'
              ? 'aborted'
              : 'server_error'
          : error instanceof ModelRefusalError
            ? 'refusal'
            : 'invalid_output',
        inputTokens,
        0,
      ),
    ];
    return error;
  }

  /**
   * Streams the coaching answer of the prompt sentence by sentence, pausing `streamDelayMs` before each
   * sentence: the `answer` (the short `spoken` reply on a call) of the built-in response or the
   * `CoachResponse` fixture, or the stream fixture's text.
   */
  async streamText(request: StreamTextRequest, onText: TextChunkHandler): Promise<StreamTextResult> {
    this.calls.push({
      kind: 'stream',
      purpose: request.purpose,
      requestId: request.requestId,
      schemaName: null,
      count: 1,
    });
    const started = performance.now();
    const inputTokens =
      estimateTokens(request.system) +
      request.messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    if (request.signal?.aborted) {
      throw this.#failure(new ModelUnavailableError('aborted', MOCK_MODEL_ID), inputTokens);
    }
    const scripted = this.#script.shift();
    if (scripted === 'unavailable')
      throw this.#failure(new ModelUnavailableError('server_error', MOCK_MODEL_ID), inputTokens);
    if (scripted === 'timeout')
      throw this.#failure(new ModelUnavailableError('timeout', MOCK_MODEL_ID), inputTokens);
    if (scripted === 'refusal')
      throw this.#failure(new ModelRefusalError(MOCK_MODEL_ID, 'model'), inputTokens);
    if (scripted === 'invalid_output')
      throw this.#failure(new ModelOutputInvalidError(MOCK_MODEL_ID, ['(root): scripted']), inputTokens);
    const failMidway = this.#streamScript.shift() === 'fail_midway';

    const context = this.#context(request.system, request.messages);
    let text: string;
    if (this.#streamFixture) {
      text = this.#streamFixture(context);
    } else {
      const response = this.#coachResponse(context);
      const spoken = context.control?.channel === 'voice' ? response.spoken : null;
      const answer = typeof response.answer === 'string' ? response.answer : '';
      text = typeof spoken === 'string' && spoken !== '' ? spoken : answer;
    }
    let firstTokenMs: number | null = null;
    const chunks = mockStreamChunks(text);
    const failAt = failMidway ? Math.max(1, Math.ceil(chunks.length / 2)) : chunks.length;
    for (const [index, chunk] of chunks.entries()) {
      await pause(this.#streamDelayMs, request.signal);
      if (request.signal?.aborted || index >= failAt) {
        const error = this.#failure(
          request.signal?.aborted
            ? new ModelUnavailableError('aborted', MOCK_MODEL_ID)
            : new ModelUnavailableError('server_error', MOCK_MODEL_ID),
          inputTokens,
        );
        error.textDelivered = index > 0;
        throw error;
      }
      firstTokenMs ??= Math.round(performance.now() - started);
      await onText(chunk);
    }
    const fallbackUsed = scripted === 'fallback';
    const outputTokens = estimateTokens(text);
    const attempts = fallbackUsed
      ? [
          this.#attempt(MOCK_MODEL_ID, 'timeout', inputTokens, 0),
          this.#attempt(MOCK_FALLBACK_MODEL_ID, 'ok', inputTokens, outputTokens),
        ]
      : [this.#attempt(MOCK_MODEL_ID, 'ok', inputTokens, outputTokens)];
    return {
      text,
      modelId: fallbackUsed ? MOCK_FALLBACK_MODEL_ID : MOCK_MODEL_ID,
      fallbackUsed,
      usage: {
        inputTokens: attempts.reduce((acc, a) => acc + a.usage.inputTokens, 0),
        outputTokens,
      },
      costUsd: 0,
      latencyMs: Math.round(performance.now() - started),
      firstTokenMs,
      stopReason: 'end_turn',
      attempts,
    };
  }

  #attempt(modelId: string, outcome: ModelAttempt['outcome'], input: number, output: number): ModelAttempt {
    return {
      provider: 'mock',
      modelId,
      kind: 'initial',
      outcome,
      latencyMs: 0,
      usage: { inputTokens: input, outputTokens: output },
      errorName: null,
      costUsd: 0,
    };
  }

  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    this.calls.push({
      kind: 'generate',
      purpose: request.purpose,
      requestId: request.requestId,
      schemaName: request.schemaName,
      count: 1,
    });
    if (request.signal?.aborted) {
      return Promise.reject(new ModelUnavailableError('aborted', MOCK_MODEL_ID));
    }
    const inputTokens =
      estimateTokens(request.system) +
      request.messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    const scripted = this.#script.shift();
    const fail = (error: ModelGatewayError): Promise<never> =>
      Promise.reject(this.#failure(error, inputTokens));
    if (scripted === 'unavailable') return fail(new ModelUnavailableError('server_error', MOCK_MODEL_ID));
    if (scripted === 'timeout') return fail(new ModelUnavailableError('timeout', MOCK_MODEL_ID));
    if (scripted === 'refusal') return fail(new ModelRefusalError(MOCK_MODEL_ID, 'model'));
    if (scripted === 'invalid_output')
      return fail(new ModelOutputInvalidError(MOCK_MODEL_ID, ['(root): scripted']));

    const context = this.#context(request.system, request.messages);
    const strict = toStrictJsonSchema(request.zodSchema);
    const fixture = this.#fixtures[request.schemaName];
    const builtIn = BUILT_IN[request.schemaName];
    const annotations = (): Record<string, unknown> => {
      const { answer: _answer, spoken: _spoken, ...rest } = this.#coachResponse(context);
      return rest;
    };
    let candidate: unknown = fixture
      ? fixture(context)
      : request.schemaName === COACH_ANNOTATIONS_SCHEMA_NAME
        ? annotations()
        : builtIn
          ? builtIn.build(context)
          : sampleFromJsonSchema(strict.original);
    let outcome = validateStructured(candidate, request.zodSchema, strict);
    if (!outcome.ok && !fixture && builtIn?.sampleOnMismatch === true) {
      candidate = sampleFromJsonSchema(strict.original);
      outcome = validateStructured(candidate, request.zodSchema, strict);
    }
    if (!outcome.ok) return fail(new ModelOutputInvalidError(MOCK_MODEL_ID, outcome.issues));

    const fallbackUsed = scripted === 'fallback';
    const outputTokens = estimateTokens(JSON.stringify(candidate));
    const attempts = fallbackUsed
      ? [
          this.#attempt(MOCK_MODEL_ID, 'timeout', inputTokens, 0),
          this.#attempt(MOCK_FALLBACK_MODEL_ID, 'ok', inputTokens, outputTokens),
        ]
      : [this.#attempt(MOCK_MODEL_ID, 'ok', inputTokens, outputTokens)];
    return Promise.resolve({
      value: outcome.value,
      modelId: fallbackUsed ? MOCK_FALLBACK_MODEL_ID : MOCK_MODEL_ID,
      fallbackUsed,
      usage: {
        inputTokens: attempts.reduce((acc, a) => acc + a.usage.inputTokens, 0),
        outputTokens,
      },
      costUsd: 0,
      latencyMs: 0,
      attempts,
    });
  }

  embed(texts: readonly string[], options: EmbedOptions): Promise<EmbedResult> {
    this.calls.push({
      kind: 'embed',
      purpose: options.purpose,
      requestId: options.requestId ?? null,
      schemaName: null,
      count: texts.length,
    });
    if (options.signal?.aborted)
      return Promise.reject(new ModelUnavailableError('aborted', MOCK_EMBEDDINGS_MODEL_ID));
    for (const text of texts) {
      if (typeof text !== 'string' || text.trim() === '') {
        return Promise.reject(new TypeError('embed: every input must be a non-empty string'));
      }
    }
    return Promise.resolve({
      vectors: texts.map((t) => hashEmbedding(t, EMBEDDING_DIMENSIONS)),
      modelId: MOCK_EMBEDDINGS_MODEL_ID,
      usage: { inputTokens: texts.reduce((acc, t) => acc + estimateTokens(t), 0), outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
    });
  }
}
