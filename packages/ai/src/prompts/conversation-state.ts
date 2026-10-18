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

/** A message that is only social: thanks, a wrap-up or a hello, with nothing asked or told ({@link socialTurnOf}). */
export type SocialTurn = 'thanks' | 'closing' | 'greeting';

export interface ConversationState {
  /** What the new message does, in order of importance. */
  readonly moves: readonly FounderMove[];
  /** The message is only social (thanks, a wrap-up, a hello): a short reply and nothing to report. */
  readonly social?: SocialTurn | null;
  /** The message asks the vEIR to choose or give its view ("per branch or a flat fee?"): answer it first. */
  readonly directChoice?: boolean;
  /** The opening line it answers said hello (a call's intro): never greet again. */
  readonly openerGreeted?: boolean;
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
  /** Questions the vEIR asked in this conversation (one line each, unescaped, newest first, distinct). */
  readonly askedQuestions: readonly string[];
  /**
   * Whether the question the vEIR's last reply asked (the first of `askedQuestions`) is still open: the new message
   * neither answers it nor takes it up (it asks something else, or changes the topic).
   */
  readonly openQuestion: boolean;
  /** Completed exchanges in view. */
  readonly earlierTurns: number;
  /**
   * The new message is the founder's first reply to the vEIR's own opening line (the conversation's stored opener,
   * which already picked up the last conversation): the reply must not say it again.
   */
  readonly afterOpener: boolean;
}

/** Longest gist of a thread. */
export const GIST_CHARS = 90;
/** Most parked threads reported. */
export const MAX_PARKED = 3;
/** Most recent openings reported. */
export const MAX_OPENINGS = 3;
/** Most questions the vEIR already asked that are reported (so it never asks one again). */
export const MAX_ASKED = 2;
/** Longest question reported. */
export const QUESTION_CHARS = 110;
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
    // Pre-closings only: a farewell, or leaving ("I have to run.") with nothing after the verb, so "we need to run
    // a pilot" or "I have to run the numbers" stay ordinary talk.
    new RegExp(
      [
        String.raw`\b(?:goodbye|bye(?:-bye)?|talk (?:soon|later|tomorrow|next week)|speak soon|catch you later|signing off|good night|i'll let you go|until next time)\b`,
        String.raw`\bsee you(?: (?:soon|later|tomorrow|next (?:week|time)|then))?(?=\s*(?:[.!,]|$))`,
        String.raw`(?:^|(?:^|[\s,.!;])(?:i|we|i've|we've|ok|okay|anyway|sorry|well|so|but|alright|right|and|thanks)(?: really| actually| just)?[\s,]+)(?:(?:have|need|got) to|gotta|must)\s+(?:go|run|jump|dash|head (?:off|out)|hop off|leave)(?: now| soon| in a (?:sec|second|minute|bit))?(?=\s*(?:[.!,;:]|$|(?:but|thanks|thank|bye|talk|see)\b))`,
        String.raw`\b(?:(?:that's|that is) (?:all|it|everything|enough) for (?:now|today)|let's (?:stop|wrap(?: it)? up|leave it) (?:here|there|for (?:now|today))|i'm done for (?:now|today))\b`,
      ].join('|'),
    ),
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
    // The founder's own state ("I'm stressed", "we're worried"), not their customers' ("lab managers are worried").
    new RegExp(
      [
        String.raw`\b(?:i'm|i am|im|i've been|i have been|i feel|i felt|feeling|i'm feeling|we're|we are|we've been|we feel|i'm getting|we're getting|i was|we were|i get|we get)\s+(?:(?:so|really|very|pretty|quite|super|totally|completely|kind of|kinda|a (?:bit|little)|getting|more and more|just|honestly|also|incredibly|seriously|starting to (?:feel|get)|a little bit)\s+)*(?:stressed(?: out)?|overwhelmed|exhausted|burn(?:ed|t)[- ]?out|burning out|anxious|worried|panick(?:ed|ing)|freaking out|frustrated|discouraged|demoralis(?:ed)|demoraliz(?:ed)|scared|terrified|drained|struggling|at a loss|losing (?:sleep|hope|motivation|it))\b`,
        String.raw`\b(?:i|we) (?:feel|felt) like (?:a failure|giving up|quitting|i'm failing|we're failing)\b`,
        String.raw`\b(?:rough|tough|awful|terrible|brutal) (?:day|week|month|few days|few weeks)\b`,
        String.raw`\b(?:this|it)(?:'s| is| has been|'s been) (?:so |really |getting |all )?(?:stressful|overwhelming|exhausting|too much)\b`,
        // Worn down without saying "stressed" (the matrix's crisis-adjacent turn).
        String.raw`\b(?:i |we )?(?:haven't|have not|hardly|barely) slept\b|\b(?:don't|do not) know how (?:much )?longer (?:i|we) can\b|\bcan't keep (?:doing|going on with) (?:this|it)\b`,
      ].join('|'),
    ),
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

// Social turns and direct questions ------------------------------------------------------------------------

/** Social lead-ins before a founder's actual question ("Sure, but who pays?"). */
const SOCIAL_LEAD =
  /^(?:(?:hi|hey|hello|hiya|good (?:morning|afternoon|evening)|thanks|thank you|thx|cheers|ok|okay|sure|yes|yeah|yep|no|nope|right|great|perfect|cool|got it|makes sense|fair enough|sounds good|and|but|so)\b[\s,.!:;-]*)+/i;
/** "How are you?" and its kin: a social question, answered socially. */
const HOW_ARE_YOU =
  /\bhow(?:'s| is| are| have) (?:it going|you(?: been| doing)?|things|your (?:day|week))\b[?!.]*/gi;
const ASKING_WORD =
  /^(?:what|how|why|when|where|who|which|should|could|would|can|do|does|did|is|are|will|any)\b/i;

/**
 * Whether the founder's message asks something that needs an answer, however short ("Sure, but who pays?"): a
 * question left after the greeting, thanks or "ok" around it. "How are you?" alone is social.
 */
export function asksSomething(text: string, moves: readonly FounderMove[] = founderMoves(text)): boolean {
  if (!moves.includes('question')) return false;
  const rest = text.replace(SOCIAL_LEAD, '').replace(HOW_ARE_YOU, '').replace(SOCIAL_LEAD, '').trim();
  return rest.includes('?') || (ASKING_WORD.test(rest) && wordCount(rest) > 2);
}

/**
 * What a message that is only social does (doctrine "Conversation craft"; the lab's SM-19 and SM-13): thanks
 * ("Thank you, this is genuinely helpful"), a wrap-up ("Okay, thanks, that's helpful. Talk soon.") or a hello, with
 * nothing asked and next to nothing told. Null for a message with venture substance or a real question.
 */
export function socialTurnOf(text: string): SocialTurn | null {
  const moves = founderMoves(text);
  if (asksSomething(text, moves)) return null;
  const content = contentWords(text).size;
  if (moves.includes('closing') && content < 4) return 'closing';
  if (moves.includes('thanks') && content < 3) return 'thanks';
  if (moves.includes('greeting') && content < 2) return 'greeting';
  return null;
}

/** "X or Y?" asked of the vEIR, or a request for its pick or verdict. */
const CHOICE =
  /(?:\b(?:should|shall|do|would|could|can|is|are)\b[^?]{1,120}\bor\b[^?]{1,80}\?|^[^?]{1,60}\bor\b[^?]{1,60}\?$|\b(?:which (?:one|is better|would you|should (?:we|i))|what would you (?:do|pick|choose|go with)|(?:just )?(?:decide|pick|choose) for (?:me|us)|your (?:pick|call|honest (?:view|take)|recommendation)|what do you recommend|which do you recommend|yes or no)\b)/i;

/**
 * Whether the message asks the vEIR to choose or give its view, directly (LAB-V3: "per branch or a flat campus
 * fee?" was answered with demand-validation questions). The reply answers it in its first sentence.
 */
export function directChoiceOf(text: string): boolean {
  const flat = normalize(text);
  return flat.includes('?') || /\b(?:decide|pick|choose) for (?:me|us)\b|\byour (?:pick|call)\b/.test(flat)
    ? CHOICE.test(flat)
    : false;
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

/** For each position, the index of the first of `stops` at or after it (`text.length` when none). */
function nextOf(text: string, stops: string): Int32Array {
  const next = new Int32Array(text.length + 1);
  next[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    next[i] = stops.includes(text.charAt(i)) ? i : (next[i + 1] ?? text.length);
  }
  return next;
}

/**
 * Markdown links and images (`[text](url)`, `![alt](url)`) replaced by their text, in one linear pass: a regular
 * expression for them backtracks quadratically on a founder's pasted "[x](" runs.
 */
export function stripLinks(text: string): string {
  if (!text.includes('](')) return text;
  const bracket = nextOf(text, ']\n');
  const paren = nextOf(text, ')\n');
  let out = '';
  let from = 0;
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    const close = bracket[i + 1] ?? text.length;
    if (text.charAt(close) !== ']' || text.charAt(close + 1) !== '(') continue;
    const end = paren[close + 2] ?? text.length;
    if (text.charAt(end) !== ')') continue;
    const start = i > from && text.charAt(i - 1) === '!' ? i - 1 : i;
    out += text.slice(from, start) + text.slice(i + 1, close);
    from = end + 1;
    i = end;
  }
  return out + text.slice(from);
}

/** Markdown and citation keys removed, one line (linear in the length of `text`). */
function plain(text: string): string {
  return stripLinks(text)
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?\[ ?E\d+(?: ?[,;] ?E\d+)* ?\]/gi, '')
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

/** The last question a reply asks (its last sentence ending in "?"), one bounded line, or null. */
export function lastQuestionOf(answer: string): string | null {
  const sentences = plain(answer).split(/(?<=[.!?]["'”’)\]]*)\s+/);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = (sentences[i] ?? '').trim();
    if (/\?["'”’)\]]*$/.test(sentence)) return truncate(sentence, QUESTION_CHARS);
  }
  return null;
}

/** A hello and nothing else ("Hi!", "Good morning", "Hi, it's me again", "How are you?"). */
function onlyGreets(text: string, moves: readonly FounderMove[]): boolean {
  if (!moves.includes('greeting')) return false;
  const rest = normalize(text).replace(
    /\bgood (?:morning|afternoon|evening|day)\b|\b(?:morning|evening|howdy|hiya)\b/g,
    ' ',
  );
  return contentWords(rest).size === 0;
}

/** Whether the founder's message takes up the vEIR's question: answers it, or at least says something to it. */
function takesUp(question: string, text: string, moves: readonly FounderMove[]): boolean {
  // A hello is not an answer: "Hi!" after "How did the facilities call go?" leaves the question open.
  if (onlyGreets(text, moves)) return false;
  if (moves.includes('short_reply')) return true;
  if (moves.some((m) => m === 'topic_shift' || m === 'recall' || m === 'resume' || m === 'closing'))
    return false;
  if (shared(contentWords(question), contentWords(text)) > 0) return true;
  // Something said, not only a question of their own.
  return normalize(text)
    .split(/(?<=[.!?])\s+/)
    .some((s) => s !== '' && !s.endsWith('?'));
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
  options: {
    /**
     * The conversation's opener (the vEIR's first message, replayed before the history): on the founder's first
     * message it counts as the vEIR's last reply (its question, how it opened).
     */
    readonly opener?: string | null;
  } = {},
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

  const asked: string[] = [];
  for (let i = turns.length - 1; i >= 0 && asked.length < MAX_ASKED; i -= 1) {
    const question = lastQuestionOf(turns[i]?.answer ?? '');
    if (question !== null && !asked.includes(question)) asked.push(question);
  }
  // The founder's first message answers the opener: it is the vEIR's last reply so far.
  const opener = options.opener?.trim() ?? '';
  const afterOpener = turns.length === 0 && opener !== '';
  if (afterOpener) {
    const question = lastQuestionOf(opener);
    if (question !== null) asked.push(question);
    if (endsWithQuestion(opener)) streak = 1;
    const opening = openingOf(opener);
    if (opening !== '') openings.push(opening);
  }
  const lastAsked = lastQuestionOf(afterOpener ? opener : (turns.at(-1)?.answer ?? ''));
  const moves = founderMoves(founderText);

  const prev: Thread | null = previous;
  const open = parked.filter((p) => p !== current).slice(0, MAX_PARKED);
  return {
    moves,
    social: socialTurnOf(founderText),
    directChoice: directChoiceOf(founderText),
    openerGreeted: afterOpener && /^(?:hi|hello|hey|hiya)\b/i.test(opener),
    words: wordCount(founderText),
    typicalWords: median(turns.map((t) => wordCount(t.founderText))),
    // A thread the new message leaves unsettled is reported once, as parked.
    previous: prev === null || open.includes(prev) ? null : asThread(prev),
    parked: open.map(asThread),
    questionStreak: streak,
    recentOpenings: openings,
    askedQuestions: asked,
    openQuestion: lastAsked !== null && !takesUp(lastAsked, founderText, moves),
    earlierTurns: turns.length,
    afterOpener,
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
  const notable = state.moves.some((m) => NOTABLE.has(m)) || state.directChoice === true;
  if (state.earlierTurns === 0 && !notable && !state.afterOpener) return '';
  const what = state.moves.map((m) => MOVE_LABELS[m]);
  const length =
    state.typicalWords === null
      ? `${state.words} words`
      : `${state.words} words (their messages usually run about ${state.typicalWords})`;
  const lines = [`- Their message${what.length > 0 ? ` ${what.join(', ')}` : ''}; ${length}.`];
  if (state.afterOpener) {
    lines.push(
      state.openerGreeted === true
        ? '- It answers your opening line, which already greeted them and picked up last time: never greet them or say that again.'
        : '- It answers your opening line, which already picked up last time: never say that again.',
    );
  }
  if (state.social === 'thanks') {
    lines.push(
      '- A thanks and nothing more: a short, warm reply only. No advice, plan or recap, and no other field.',
    );
  } else if (state.social === 'closing') {
    lines.push(
      '- They are wrapping up: a warm sign-off (their one next step in a line at most), no new question, no other field.',
    );
  } else if (state.social === 'greeting' && state.earlierTurns > 0) {
    lines.push('- A hello and nothing more: a few warm words, no advice.');
  }
  if (state.directChoice === true) {
    lines.push(
      '- They asked you to choose or give your view: open with your answer and why, before anything you ask.',
    );
  }
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
  if (state.askedQuestions.length > 0) {
    lines.push(`- You already asked: ${state.askedQuestions.map(quoted).join(' | ')}`);
  }
  if (state.openQuestion) {
    lines.push('- They did not take up your last question: answer what they said, and do not ask it again.');
  }
  return [`<${CONVERSATION_STATE_TAG}>`, ...lines, `</${CONVERSATION_STATE_TAG}>`].join('\n');
}
