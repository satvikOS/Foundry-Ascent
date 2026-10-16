import { CONVERSATION_STATE_TAG } from './craft.js';
import { escapeData, truncate } from './escape.js';

/**
 * Where the conversation stands, derived deterministically from the turns already in the prompt (no model call,
 * no storage): what the founder's new message does (greets, changes topic, asks what the vEIR remembers, wraps
 * up…), how long their messages usually are, the thread the conversation was on, threads the founder left before
 * they were settled (so the vEIR can come back to them), and the vEIR's own recent habits (replies that all ended
 * in a question, how its recent replies opened). Rendered as a short `<conversation_state>` block of escaped
 * observations next to the founder's message; the system prompt's "Conversation craft" says how to use it.
 *
 * Topic tracking follows conversation analysis: talk moves stepwise unless a move is marked ("by the way",
 * "different question"); the turn after the vEIR's question is heard as its answer (an adjacency pair) unless it is
 * marked as a new topic; a later message that shares content words with a parked thread resumes it.
 */

/** What a founder message does in the conversation. A message can do several things ("Thanks! By the way…"). */
export type FounderMove =
  | 'greeting'
  | 'recall'
  | 'resume'
  | 'topic_shift'
  | 'repair'
  | 'closing'
  | 'thanks'
  | 'stress'
  | 'humour'
  | 'short_reply'
  | 'question';

/** A completed earlier exchange (the shape of `HistoryTurn`). */
export interface StateTurn {
  readonly founderText: string;
  readonly answer: string | null;
}

export interface ConversationThread {
  /** The founder's words that opened the thread (one line, at most {@link GIST_CHARS} characters, unescaped). */
  readonly gist: string;
  /** Founder messages since the thread was last touched (1 = the message before the new one). */
  readonly messagesAgo: number;
}

export interface ConversationState {
  /** What the new message does, in order of importance. */
  readonly moves: readonly FounderMove[];
  /** Words in the new message. */
  readonly words: number;
  /** Median words of the founder's earlier messages in view, or null without any. */
  readonly typicalWords: number | null;
  /** The thread the conversation was on before the new message (null at the start). */
  readonly previous: ConversationThread | null;
  /** Threads the founder left before they were settled, newest first (the one the new message returns to excluded). */
  readonly parked: readonly ConversationThread[];
  /** How many of the vEIR's latest replies in a row ended with a question. */
  readonly questionStreak: number;
  /** How the vEIR's latest replies opened (first words, newest first). */
  readonly recentOpenings: readonly string[];
  /** Completed exchanges in view. */
  readonly earlierTurns: number;
}

/** Longest gist of a thread. */
export const GIST_CHARS = 90;
/** Most parked threads reported. */
export const MAX_PARKED = 3;
/** Most recent openings reported. */
export const MAX_OPENINGS = 3;
const OPENING_WORDS = 6;

const APOSTROPHES = /[‘’ʼ]/g;

function normalize(text: string): string {
  return text.normalize('NFKC').replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Cues for each move (on the normalised, lower-cased message), in order of importance. */
const MOVE_CUES: readonly (readonly [FounderMove, RegExp])[] = [
  [
    'recall',
    /\b(?:(?:do|did|can|could) you (?:still |even |actually )?(?:remember|recall)|what (?:did|were|have) we (?:just )?(?:talk(?:ed|ing)?|discuss(?:ed|ing)?|cover(?:ed|ing)?|go(?:ne)? over|decide[d]?|agree[d]?|land(?:ed)? on)|remind me (?:what|where|of what|how)|where did we (?:leave|land|end up|get to)|what do you (?:remember|know) about (?:me|us|our|my|what we))\b/,
  ],
  [
    'resume',
    /\b(?:where were we|where was i|(?:go|going|get|getting|come|coming|circle|circling|loop|looping) back to|back to (?:the|what|my|our|where|that|your)|as i was saying|pick(?:ing)? (?:it )?(?:up|back up) (?:where|from|again)|returning to)\b/,
  ],
  [
    'repair',
    /(?:\b(?:that's not what i (?:meant|said|asked|was asking)|that isn't what i (?:meant|said|asked)|you misunderstood|you misread|you got (?:that|it|me) wrong|i didn't (?:mean|say|ask) that)\b|^(?:no|nope|not quite|not exactly|sorry|wait)[,.!]?\s+(?:i|what i)\s+(?:meant|mean|was asking|asked|said)\b|^i meant\b)/,
  ],
  [
    'closing',
    /\b(?:gotta go|got to go|have to (?:go|run|jump|head)|need to (?:go|run|jump|head off)|i'll let you go|talk (?:soon|later|tomorrow|next week)|speak soon|goodbye|bye|see you|catch you later|signing off|good night|(?:that's|that is) (?:all|it|everything) for (?:now|today)|(?:that's|that is) enough for (?:now|today)|let's (?:stop|wrap(?: it)? up|leave it) (?:here|there|for (?:now|today))|i'm done for (?:now|today))\b/,
  ],
  [
    'thanks',
    /(?:^(?:(?:thanks|thank you|thx|ty|cheers)(?! to\b)|much appreciated|appreciate (?:it|that|you)|(?:that's|that is|that was) (?:really |super |very )?(?:helpful|useful|great|perfect))\b|\b(?:thanks|thank you)(?: so much| a lot| again)?[.!]*$)/,
  ],
  [
    'topic_shift',
    /(?:\b(?:by the way|btw|(?:a )?(?:different|another|unrelated|separate|random|new) (?:question|topic|thing|subject)|on (?:another|a different|a separate) note|chang(?:e|ing) (?:the )?(?:topic|subject)|before i forget|switching gears|quick (?:question|one))\b|^(?:oh|also)[,.]? (?:and |also )?(?:what|how|can|could|should|one more)\b|^actually[,.]? (?:can|could|let's|i want|i'd like)\b)/,
  ],
  [
    'greeting',
    /(?:^(?:hi|hey|hello|hiya|howdy|good (?:morning|afternoon|evening|day)|morning|evening)\b|\bhow(?:'s| is| are| have) (?:it going|you(?: been| doing)?|things|your (?:day|week))\b)/,
  ],
  [
    'stress',
    /\b(?:stress(?:ed|ful)?|overwhelm(?:ed|ing)?|exhaust(?:ed|ing)|burn(?:ed|t)[- ]?out|burning out|anxious|anxiety|worried|panick(?:ed|ing)|freaking out|(?:rough|tough|hard|awful|terrible) (?:day|week|month)|frustrat(?:ed|ing)|discourag(?:ed|ing)|demoralis(?:ed|ing)|demoraliz(?:ed|ing)|scared|losing (?:sleep|hope|motivation)|at a loss|feel like (?:a failure|giving up|quitting))\b/,
  ],
  [
    'humour',
    /(?:\b(?:ha(?:ha)+|hah|he(?:he)+|lol|lmao|rofl)\b|[\u{1F602}\u{1F923}\u{1F605}\u{1F604}\u{1F606}\u{1F61C}\u{1F609}])/u,
  ],
];

const SHORT_REPLY =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|right|exactly|correct|no|nope|maybe|makes sense|got it|true|fair|fair enough|sounds good|will do|agreed|definitely|of course|not really|kind of|sort of|perfect|great)\b/;

const QUESTION_START =
  /^(?:what|how|why|when|where|who|which|should|could|would|can|do|does|did|is|are|will|any)\b/;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** What `text` does in the conversation (deterministic cues; English). */
export function founderMoves(text: string): FounderMove[] {
  const t = normalize(text);
  if (t === '') return [];
  const moves: FounderMove[] = MOVE_CUES.filter(([, cue]) => cue.test(t)).map(([move]) => move);
  const words = wordCount(t);
  if (words <= 5 && SHORT_REPLY.test(t) && !moves.includes('thanks')) moves.push('short_reply');
  if (t.endsWith('?') || (QUESTION_START.test(t) && words > 2)) moves.push('question');
  return moves;
}

// Content words ------------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been before being below ' +
    'between both but by can cannot could couldn did didn do does doesn doing don down during each few for from ' +
    'further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is isn ' +
    'it its itself just let me more most my myself no nor not now of off on once only or other our ours ourselves ' +
    'out over own same she should shouldn so some such than that the their theirs them themselves then there these ' +
    'they this those through to too under until up very was wasn we were weren what when where which while who whom ' +
    'why will with won would wouldn you your yours yourself yourselves ok okay yeah yes yep no nope sure thanks ' +
    'thank hi hey hello please maybe really actually think know like just want need get got going go make made ' +
    'thing things something anything stuff lot lots much many way kind sort bit good great nice cool helpful useful ' +
    'perfect right well also still even already ever never always one two last time next today tomorrow yesterday ' +
    'week day said say says tell told ask asked mean meant talk talked talking back anyway btw remember recall ' +
    'question different another topic quick oh wait sorry per via etc'
  ).split(' '),
);

function suffixless(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** A crude stem that lets "price", "prices", "priced" and "pricing" meet. */
function stem(word: string): string {
  const base = suffixless(word);
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base;
}

/** The content words of `text` (lower-cased, stop words removed, crudely stemmed). */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of normalize(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const word = match[0].replace(/'s$/, '').replace(/'/g, '');
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(stem(word));
  }
  return out;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

// Plain text helpers -------------------------------------------------------------------------------------

/** Markdown and citation keys removed, one line. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\s*\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]/gi, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING_SOCIAL =
  /^(?:(?:hi|hey|hello|ok|okay|so|well|thanks|thank you|yeah|yes|right|by the way|btw|anyway|also|oh|actually|quick question|different question|another question|one more thing)\b[\s,.!:;-]*)+/i;

/** A thread's gist: the founder's words without the social lead-in, first sentence, one bounded line. */
export function gistOf(text: string): string {
  const flat = plain(text).replace(LEADING_SOCIAL, '').trim();
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return truncate(sentence.length >= 12 ? sentence : flat, GIST_CHARS);
}

/** Whether a reply ends in a question (its last sentence). */
export function endsWithQuestion(answer: string): boolean {
  return /\?["'”’)\]]*$/.test(plain(answer));
}

/** The first words of a reply. */
export function openingOf(answer: string): string {
  const words = plain(answer)
    .split(' ')
    .filter((w) => w !== '');
  if (words.length === 0) return '';
  return words.length > OPENING_WORDS ? `${words.slice(0, OPENING_WORDS).join(' ')}…` : words.join(' ');
}

// Derivation ---------------------------------------------------------------------------------------------

interface Thread {
  gist: string;
  words: Set<string>;
  /** Index (in founder messages) of the last message in this thread. */
  last: number;
  settled: boolean;
}

/** Whether a message carries venture substance (not only social words or a one-word reply). */
function substantive(text: string, moves: readonly FounderMove[]): boolean {
  if (moves.includes('short_reply')) return false;
  const content = contentWords(text).size;
  if (moves.includes('closing') || moves.includes('thanks'))
    return content >= 3 && moves.includes('question');
  return content >= 2;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/**
 * The state of the conversation for the new founder message: `history` holds the completed earlier exchanges in
 * view (oldest first; turns without an answer are skipped).
 */
export function deriveConversationState(
  history: readonly StateTurn[],
  founderText: string,
): ConversationState {
  const turns = history.filter(
    (t) => t.answer !== null && t.answer.trim() !== '' && t.founderText.trim() !== '',
  );
  const messages = [...turns.map((t) => t.founderText), founderText];
  const newIndex = messages.length - 1;

  let current: Thread | null = null;
  let previous: Thread | null = null;
  const parked: Thread[] = [];
  const park = (thread: Thread | null): void => {
    if (thread === null || thread.settled) return;
    if (!parked.includes(thread)) parked.unshift(thread);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const text = messages[i] ?? '';
    const moves = founderMoves(text);
    if (i === newIndex) previous = current;
    const words = contentWords(text);
    if (
      current !== null &&
      (moves.includes('thanks') || moves.includes('closing')) &&
      !moves.includes('question')
    ) {
      current.settled = true;
    }
    if (!substantive(text, moves)) continue;

    // A message that shares content words with a parked thread returns to it ("back to…" needs only one).
    const needed = moves.includes('resume') ? 1 : 2;
    const resumed = parked.find((p) => shared(words, p.words) >= Math.min(needed, p.words.size));
    if (resumed !== undefined) {
      parked.splice(parked.indexOf(resumed), 1);
      if (current !== resumed) park(current);
      resumed.last = i;
      for (const w of words) resumed.words.add(w);
      current = resumed;
      continue;
    }
    const lastAnswer = i > 0 ? (turns[i - 1]?.answer ?? '') : '';
    const answered = i > 0 && endsWithQuestion(lastAnswer);
    const overlap =
      current === null ? 0 : shared(words, current.words) + shared(words, contentWords(lastAnswer));
    const marked = moves.includes('topic_shift');
    // Unmarked talk continues the thread (stepwise), and the turn after the vEIR's question is its answer.
    const shift = current === null || marked || (!answered && overlap === 0 && words.size >= 4);
    if (shift) {
      park(current);
      current = { gist: gistOf(text), words: new Set(words), last: i, settled: false };
    } else if (current !== null) {
      current.last = i;
      for (const w of words) current.words.add(w);
    }
  }
  const asThread = (t: Thread): ConversationThread => ({ gist: t.gist, messagesAgo: newIndex - t.last });

  let streak = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (!endsWithQuestion(turns[i]?.answer ?? '')) break;
    streak += 1;
  }
  const openings = turns
    .slice(-MAX_OPENINGS)
    .reverse()
    .map((t) => openingOf(t.answer ?? ''))
    .filter((o) => o !== '');

  const prev: Thread | null = previous;
  const open = parked.filter((p) => p !== current).slice(0, MAX_PARKED);
  return {
    moves: founderMoves(founderText),
    words: wordCount(founderText),
    typicalWords: median(turns.map((t) => wordCount(t.founderText))),
    // A thread the new message leaves unsettled is reported once, as parked.
    previous: prev === null || open.includes(prev) ? null : asThread(prev),
    parked: open.map(asThread),
    questionStreak: streak,
    recentOpenings: openings,
    earlierTurns: turns.length,
  };
}

const MOVE_LABELS: Readonly<Record<FounderMove, string>> = {
  recall: 'asks what you remember from before',
  resume: 'wants to go back to an earlier thread',
  repair: 'corrects how you understood them',
  closing: 'is wrapping up',
  thanks: 'thanks you',
  topic_shift: 'changes the topic',
  greeting: 'greets you',
  stress: 'sounds stressed or discouraged',
  humour: 'is joking around',
  short_reply: 'is a short reply to your last message',
  question: 'asks a question',
};

/** Moves worth reporting even on the first message of a conversation. */
const NOTABLE: ReadonlySet<FounderMove> = new Set([
  'recall',
  'resume',
  'repair',
  'closing',
  'thanks',
  'topic_shift',
  'greeting',
  'stress',
  'humour',
]);

function quoted(text: string): string {
  return `"${escapeData(text.replace(/"/g, "'"))}"`;
}

function ago(n: number): string {
  return n <= 1 ? 'just before this message' : `${n} messages ago`;
}

/**
 * The `<conversation_state>` block, or '' when there is nothing worth saying (the first message of a
 * conversation with no notable move). Founder words in it are escaped data.
 */
export function renderConversationState(state: ConversationState): string {
  const notable = state.moves.some((m) => NOTABLE.has(m));
  if (state.earlierTurns === 0 && !notable) return '';
  const what = state.moves.map((m) => MOVE_LABELS[m]);
  const length =
    state.typicalWords === null
      ? `${state.words} words`
      : `${state.words} words (their messages usually run about ${state.typicalWords})`;
  const lines = [`- Their message${what.length > 0 ? ` ${what.join(', ')}` : ''}; ${length}.`];
  if (state.previous !== null) lines.push(`- You were on: ${quoted(state.previous.gist)}.`);
  for (const p of state.parked) {
    lines.push(`- Parked, left before it was settled: ${quoted(p.gist)} (${ago(p.messagesAgo)}).`);
  }
  if (state.questionStreak >= 2) {
    lines.push(`- Your last ${state.questionStreak} replies all ended with a question.`);
  } else if (state.questionStreak === 1) {
    lines.push('- Your last reply ended with a question.');
  }
  if (state.recentOpenings.length > 0) {
    lines.push(`- Your recent replies opened with: ${state.recentOpenings.map(quoted).join(' | ')}`);
  }
  return [`<${CONVERSATION_STATE_TAG}>`, ...lines, `</${CONVERSATION_STATE_TAG}>`].join('\n');
}
