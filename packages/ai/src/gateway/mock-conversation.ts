import { CONVERSATION_STATE_TAG, WHERE_YOU_LEFT_OFF_HEADING } from '../prompts/craft.js';
import type { ChatMessage } from './types.js';
import { TOPICS, topicOf, type MockTopic } from './mock-content.js';

/**
 * How the offline mock reads the conversation the way the doctrine asks a model to: what the last conversation
 * with this founder was about (the "## Where you left off" section, else the vEIR's notes), and the server's
 * `<conversation_state>` observations. Everything here is deterministic text parsing of the prompt.
 */

/** The last conversation with this founder, as far as the prompt tells. */
export interface PreviousConversation {
  /** What it was about, as a noun phrase ("pricing", "the pilot design"). */
  readonly topic: string;
  /** The phrase bank that matches it (the mock's own topics), or null. */
  readonly bank: MockTopic | null;
  /** When, relative ("about 20 minutes ago", "yesterday"), or null. */
  readonly when: string | null;
  readonly channel: 'call' | 'chat' | null;
  /**
   * What the founder planned in that conversation, as a verb phrase ("call facilities about the budget"), or null.
   * Never a notebook line: those are older notes, not "last time".
   */
  readonly plan: string | null;
  /** The vEIR's first line the prompt shows from that conversation, when it shows one. */
  readonly opening: string | null;
  /**
   * Every vEIR line the prompt shows from that conversation: a recap of its last exchanges does not always reach
   * back to how it opened, so a new greeting avoids all of them.
   */
  readonly openings: readonly string[];
  /** The text it was read from (seeds the mock's choices, so each new conversation varies). */
  readonly source: string;
  /**
   * The teammate who had it (`with="Rafi"`), or null when it was the person talking now: then its plan is the
   * teammate's, never theirs (MX-0005).
   */
  readonly teammate?: string | null;
}

/** The parsed `<conversation_state>` block. */
export interface StateReading {
  /** Gist of the thread the conversation was on. */
  readonly previous: string | null;
  /** Gists of threads left before they were settled, newest first. */
  readonly parked: readonly string[];
  readonly questionStreak: number;
  readonly openings: readonly string[];
}

export function unescapeData(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const RELATIVE_TIME =
  /\b(?:(?:about |around |roughly )?(?:\d+|a few|a couple of|an?) (?:moments?|seconds?|minutes?|mins?|hours?|days?|weeks?|months?) ago|just now|earlier today|this (?:morning|afternoon|evening)|last night|yesterday|last week|last month|today|on \d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December))\b/i;

function firstMatch(text: string, pattern: RegExp): string | null {
  const value = pattern.exec(text)?.[1]?.trim() ?? '';
  return value === '' ? null : value;
}

function clean(text: string): string {
  return unescapeData(text)
    .replace(/\s+/g, ' ')
    .replace(/^["'“‘]|["'”’]$/g, '')
    .trim();
}

function lowerFirstWord(text: string): string {
  const word = /^[\p{L}'’-]+/u.exec(text)?.[0] ?? '';
  // Keep acronyms and the pronoun "I".
  if (/^\p{L}\p{Lu}/u.test(word) || /^I(?:['’]|$)/u.test(word)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function asPlan(text: string): string | null {
  const flat = clean(text)
    .replace(/^[-*]\s*/, '')
    .replace(/\s*\((?:due|by) [^)]*\)$/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (flat === '') return null;
  const stated =
    /^(?:I|we|they|the founder|[A-Z][\p{L}'-]+)\s+(?:will|plans? to|planned to|is going to|are going to|was going to|were going to|'ll)\s+(.+)$/u.exec(
      flat,
    );
  return lowerFirstWord(stated?.[1] ?? flat);
}

const COMMITMENT =
  /\b(?:I|we)(?:['’]ll| will| plan to| am going to| are going to|['’]m going to|['’]re going to)\s+([^.!?\n]{4,140})/i;

/**
 * The user message that carries the founder's newest words (with the notes, evidence and observations), not a
 * later instruction such as the annotation request that follows a streamed reply.
 */
function founderTurnOf(messages: readonly ChatMessage[]): string {
  const users = messages.filter((m) => m.role === 'user');
  return (
    users.findLast((m) => m.content.includes('<founder_message>'))?.content ?? users.at(-1)?.content ?? ''
  );
}

/** The "## Where you left off" section of the prompt (to the next heading or block), or null. */
export function whereYouLeftOffIn(texts: readonly string[]): string | null {
  // The heading starts a line; the doctrine only names it inside a sentence.
  const heading = new RegExp(`(?:^|\\n)${WHERE_YOU_LEFT_OFF_HEADING}[^\\n]*`);
  for (const text of texts) {
    const match = heading.exec(text);
    if (match === null) continue;
    const rest = text.slice(match.index + match[0].length);
    const end = rest.search(
      /\n#{1,2} |\n<founder_message>|\n<evidence|\n<conversation_state>|\n<\/?your_notes>|\n\[control\]/,
    );
    return end < 0 ? rest : rest.slice(0, end);
  }
  return null;
}

/** Nothing to recall ("none", "this is the first conversation"). */
const NOTHING_YET =
  /\b(?:none|nothing (?:yet|before|earlier)|no (?:earlier|previous|prior) (?:conversations?|calls?|chats?)|first conversation)\b/i;

function fromSection(
  section: string,
  founderName: string | null,
  today: string | null,
): PreviousConversation | null {
  const text = unescapeData(section);
  // The newest conversation's own element when the section lists them (its notebook threads come after it).
  const scope = /<conversation\b[^>]*>[\s\S]*?<\/conversation>/.exec(text)?.[0] ?? text;
  const name = founderName ? founderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const speaker = (who: string): RegExp =>
    new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${who})(?: said)?\\s*[:：]\\s*([^\\n]+)`, 'gi');
  const founderWho = [
    'founder',
    'the founder',
    'they',
    'user',
    ...(name ? [name, `${name} \\(founder\\)`] : []),
  ];
  const founderLines = [
    ...[...scope.matchAll(speaker(founderWho.join('|')))].map((m) => clean(m[1] ?? '')),
    ...[...scope.matchAll(/<founder>([\s\S]*?)<\/founder>/g)].map((m) => clean(m[1] ?? '')),
  ].filter((l) => l !== '');
  const veirLines = [
    ...[...scope.matchAll(speaker('you|veir|the veir|coach|assistant|you said'))].map((m) =>
      clean(m[1] ?? ''),
    ),
    ...[...scope.matchAll(/<(?:you|coach|veir|answer)>([\s\S]*?)<\/(?:you|coach|veir|answer)>/g)].map((m) =>
      clean(m[1] ?? ''),
    ),
  ].filter((l) => l !== '');
  const topics =
    firstMatch(
      scope,
      /(?:^|\n)\s*(?:[-*]\s*)?(?:topics?|about|subjects?|what you talked about)\s*[:：]\s*([^\n]+)/i,
    ) ?? firstMatch(scope, /<topics>([\s\S]*?)<\/topics>/);
  const summary =
    firstMatch(scope, /(?:^|\n)\s*(?:[-*]\s*)?(?:summary|digest|recap)\s*[:：]\s*([^\n]+)/i) ??
    firstMatch(scope, /<summary>([\s\S]*?)<\/summary>/);
  const title =
    firstMatch(scope, /title="([^"]+)"/) ??
    firstMatch(text, /(?:^|\n)\s*(?:[-*]\s*)?title\s*[:：]\s*([^\n]+)/i);
  const planIn = (where: string): string | null =>
    firstMatch(
      where,
      /(?:^|\n)\s*(?:[-*]\s*)?(?:commitments?|plans?|next steps?|open threads?|they planned|planned|promised)\s*[:：]\s*([^\n]+)/i,
    ) ??
    firstMatch(where, /(?:commitments?|plans?|next steps?|open threads?)\s*[:：]?\s*\n\s*[-*]\s*([^\n]+)/i) ??
    firstMatch(where, /<(?:commitments|open_commitments)>\n\s*-\s*([^\n]+)/) ??
    firstMatch(where, /<commitment[^>]*>([\s\S]*?)<\/commitment>/);
  // Only what the last conversation itself planned: the notebook's open threads after it are older notes.
  const scopedPlan = planIn(scope);
  const stated = founderLines.map((l) => COMMITMENT.exec(l)?.[1]).find((c) => c !== undefined) ?? null;
  const anything =
    founderLines.length + veirLines.length > 0 || topics !== null || summary !== null || title !== null;
  if (!anything && scopedPlan === null) {
    // A section in a shape this reader does not know still says something, unless it says there is nothing.
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    if (NOTHING_YET.test(text) || letters < 40) return null;
    const line = text
      .split('\n')
      .map((l) => clean(l.replace(/^\s*[-*]\s*/, '')))
      .find((l) => l.length >= 12);
    return build({
      topicText: text,
      topicLabel: null,
      gist: line ?? null,
      when: RELATIVE_TIME.exec(text)?.[0] ? normaliseWhen(RELATIVE_TIME.exec(text)?.[0] ?? '') : null,
      channel: channelIn(text),
      plan: COMMITMENT.exec(text)?.[1] ?? null,
      openings: [],
      source: text,
    });
  }
  const relative = RELATIVE_TIME.exec(scope)?.[0] ?? null;
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(scope)?.[1] ?? null;
  const channel = channelIn(scope);
  const withWhom = firstMatch(/<conversation\b[^>]*>/.exec(scope)?.[0] ?? '', /\bwith="([^"]+)"/);
  const teammate =
    withWhom === null || withWhom === 'you' ? null : withWhom === 'a teammate' ? 'your teammate' : withWhom;
  return build({
    teammate,
    topicText: [topics, title, founderLines.join(' '), summary]
      .filter((t): t is string => t !== null)
      .join(' '),
    topicLabel: topics?.split(/[;,]/)[0]?.trim() ?? null,
    gist: founderLines[0] ?? null,
    when: relative !== null ? normaliseWhen(relative) : date !== null ? whenFromDate(date, today) : null,
    channel,
    plan: scopedPlan ?? stated,
    openings: veirLines,
    source: text,
  });
}

const CALL =
  /\b(?:a|on a|by|voice|phone) call\b|\(call\)|kind="call"|\b(?:channel|kind)\s*[:=]\s*"?(?:voice|call)\b/i;
const CHAT =
  /\b(?:a|on|by|in|typed) chat\b|\(chat\)|kind="chat"|\b(?:channel|kind)\s*[:=]\s*"?(?:text|chat)\b/i;

/**
 * Whether the last conversation was a call or a chat: read on the line that says when it was, else anywhere ("call"
 * alone is a verb in plans such as "call facilities").
 */
function channelIn(text: string): 'call' | 'chat' | null {
  const line = text
    .split('\n')
    .find((l) => RELATIVE_TIME.test(l) || /\b(?:when|last conversation)\b/i.test(l));
  for (const scope of line !== undefined ? [line, text] : [text]) {
    const call = CALL.test(scope);
    const chat = CHAT.test(scope);
    if (call !== chat) return call ? 'call' : 'chat';
  }
  return null;
}

function normaliseWhen(raw: string): string {
  const trimmed = raw.trim();
  // Lower-case all but month names ("on 2 September").
  const when = /^on \d/i.test(trimmed) ? `on ${trimmed.slice(3)}` : trimmed.toLowerCase();
  return /^\d/.test(when) ? `about ${when}` : when;
}

function whenFromDate(date: string, today: string | null): string | null {
  if (today === null) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${String(days)} days ago`;
  if (days < 14) return 'last week';
  return 'a while back';
}

function build(args: {
  teammate?: string | null;
  topicText: string;
  topicLabel: string | null;
  gist: string | null;
  when: string | null;
  channel: 'call' | 'chat' | null;
  plan: string | null;
  openings: readonly string[];
  source: string;
}): PreviousConversation {
  const bank = topicOf(args.topicText);
  const label =
    args.topicLabel !== null && args.topicLabel.length <= 60 ? lowerFirstWord(clean(args.topicLabel)) : null;
  const topic =
    label ??
    (bank !== 'general'
      ? TOPICS[bank].phrase
      : args.gist !== null
        ? `what you raised: "${args.gist.length > 80 ? `${args.gist.slice(0, 79).trimEnd()}…` : args.gist}"`
        : TOPICS.general.phrase);
  return {
    topic,
    bank: bank === 'general' ? null : bank,
    when: args.when,
    channel: args.channel,
    plan: args.plan === null ? null : asPlan(args.plan),
    opening: args.openings[0] ?? null,
    openings: args.openings,
    source: args.source,
    teammate: args.teammate ?? null,
  };
}

/**
 * The most recent dated conversation digest in the vEIR's notes (`<your_notes>`), or null. The notebook's own lines
 * (summary, open commitments, the opener) are older notes and venture facts, never "last time": with no digest, the
 * notes say nothing about the last conversation (production recited a seeded notebook as "last time").
 */
function fromNotes(notes: string, today: string | null): PreviousConversation | null {
  const conversation = /<conversation ([^>]*)>([\s\S]*?)<\/conversation>/.exec(notes);
  if (conversation === null) return null;
  const attrs = conversation[1] ?? '';
  const body = conversation[2] ?? '';
  const date = firstMatch(attrs, /date="(\d{4}-\d{2}-\d{2})"/);
  const title = firstMatch(attrs, /title="([^"]*)"/);
  const topics = firstMatch(body, /<topics>([\s\S]*?)<\/topics>/);
  const summary = firstMatch(body, /<summary>([\s\S]*?)<\/summary>/);
  const digestCommitment = firstMatch(body, /<commitments>\n-\s*([^\n]+)/);
  return build({
    topicText: [topics, title, summary].filter((t): t is string => t !== null).join(' '),
    topicLabel: topics?.split(';')[0]?.trim() ?? null,
    gist: null,
    when: date !== null ? whenFromDate(date, today) : null,
    channel: attrs.includes('kind="call"') ? 'call' : 'chat',
    plan: digestCommitment,
    openings: [],
    source: notes,
  });
}

/**
 * What the prompt says about the last conversation with this founder: the "## Where you left off" section when
 * there is one (it says plainly when there is nothing), else the vEIR's notes. Null when there is nothing.
 */
export function previousConversationIn(
  system: string,
  messages: readonly ChatMessage[],
  founderName: string | null,
  today: string | null,
): PreviousConversation | null {
  const texts = [system, ...messages.map((m) => m.content)];
  const section = whereYouLeftOffIn(texts);
  if (section !== null) return fromSection(section, founderName, today);
  const last = founderTurnOf(messages);
  const notes = /<your_notes>([\s\S]*?)<\/your_notes>/.exec(last)?.[1];
  return notes === undefined ? null : fromNotes(notes, today);
}

/** The `<conversation_state>` block of the founder's message, parsed; null when there is none. */
export function conversationStateIn(messages: readonly ChatMessage[]): StateReading | null {
  const last = founderTurnOf(messages);
  const block = new RegExp(`<${CONVERSATION_STATE_TAG}>\\n([\\s\\S]*?)\\n</${CONVERSATION_STATE_TAG}>`).exec(
    last,
  )?.[1];
  if (block === undefined) return null;
  const quotedIn = (line: string): string[] =>
    [...line.matchAll(/"([^"]*)"/g)].map((m) => unescapeData(m[1] ?? '').trim()).filter((q) => q !== '');
  const lines = block.split('\n');
  const previous = lines.find((l) => l.startsWith('- You were on:'));
  const streak = /- Your last (\d+) replies all ended with a question/.exec(block)?.[1];
  return {
    previous: previous ? (quotedIn(previous)[0] ?? null) : null,
    parked: lines.filter((l) => l.startsWith('- Parked')).flatMap((l) => quotedIn(l).slice(0, 1)),
    questionStreak:
      streak !== undefined
        ? Number(streak)
        : block.includes('- Your last reply ended with a question')
          ? 1
          : 0,
    openings: lines.filter((l) => l.startsWith('- Your recent replies opened with:')).flatMap(quotedIn),
  };
}
