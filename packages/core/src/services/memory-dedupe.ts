import { createHash } from 'node:crypto';

import { contentTokens, jaccardSimilarity, textKey } from '@foundry/ai';

/**
 * When an AI memory candidate restates something the venture already has (pure rules, unit tested; used by
 * `proposeMemoryCandidates`). A restated candidate never becomes a second item: it raises the pending
 * proposal again, or is dropped.
 */

/**
 * Cosine similarity at or above which a candidate restates an existing item (embeddings are unit-length):
 * near-paraphrases only.
 */
export const MEMORY_DUPLICATE_COSINE = 0.92;

/**
 * Content-word overlap (Jaccard) at or above which two contents are the same statement. High on purpose: two
 * statements that differ in a specific detail (a number, a name, a code) are different memories. Titles are
 * labels and never decide on their own.
 */
const MEMORY_DUPLICATE_JACCARD = 0.9;

/** Whether two memory contents are the same statement (see {@link MEMORY_DUPLICATE_JACCARD}). */
export function sameMemoryContent(a: string, b: string): boolean {
  const key = textKey(a);
  return key !== '' && (key === textKey(b) || jaccardSimilarity(a, b) >= MEMORY_DUPLICATE_JACCARD);
}

/**
 * Words that only frame a statement, in `contentTokens` form (plurals folded): who planned, asked, said or
 * thinks it. "Maya plans to interview five staff" says what "I will interview five staff" says.
 */
const FRAMING_WORDS = new Set([
  'plan',
  'planned',
  'planning',
  'will',
  'would',
  'want',
  'wanted',
  'going',
  'intend',
  'intended',
  'aim',
  'hope',
  'hoped',
  'ask',
  'asked',
  'say',
  'said',
  'tell',
  'told',
  'mention',
  'mentioned',
  'note',
  'noted',
  'share',
  'shared',
  'state',
  'stated',
  'think',
  'thought',
  'believe',
  'believed',
  'feel',
  'felt',
  'founder',
]);

/** Content words a candidate needs before containment can call it a restatement (short notes are too vague). */
const MIN_CONTAINED_WORDS = 4;

/**
 * Whether `candidate` adds nothing to `existing`: it has at least four content words besides framing words
 * (and the `speakers`' names: within one conversation, "Maya plans to…" and "I will…" have the same
 * subject), and every one of them is in `existing`. A longer candidate that quotes a known fact says something
 * more and is not a restatement; a number, a name or a negation the existing text lacks makes it new.
 *
 * Applied only to pending AI proposals drawn from the same conversation (distillation restating what a turn
 * of that conversation proposed), where the subject and context are the same.
 */
export function addsNothingTo(
  candidate: string,
  existing: string,
  speakers: readonly string[] = [],
): boolean {
  const framing = new Set([...FRAMING_WORDS, ...speakers.flatMap((name) => [...contentTokens(name)])]);
  const own = [...contentTokens(candidate)].filter((t) => !framing.has(t));
  if (own.length < MIN_CONTAINED_WORDS) return false;
  const known = contentTokens(existing);
  return own.every((t) => known.has(t));
}

/** What was said in a conversation, for judging where a memory candidate came from. */
export interface ConversationGrounding {
  /** The founder's own words, oldest first. */
  readonly founder: readonly string[];
  /** The coach's answers the founder's next message explicitly took up ("Sounds good, let's do that"). */
  readonly agreed: readonly string[];
}

/**
 * A founder message that takes up what the coach just proposed: a phrase that adopts it ("let's do that", "I'll
 * book it", "sounds good", "agreed", "good idea"), optionally after a short acknowledgement ("Yes, let's do it").
 * A bare "sure", "ok", "yes" or "right" only answers the coach's question (production: founders type "sure" on
 * calls to go on), so it agrees to nothing; and anything with a reservation ("right, but we can't afford it")
 * agrees to nothing either.
 */
const ADOPTS = new RegExp(
  String.raw`^\s*(?:(?:ok(?:ay)?|yes|yeah|yep|yup|sure|right|great|perfect|cool|alright|makes sense|fair enough)[\s,.!—–-]+)?` +
    String.raw`(?:let['’]?s (?:do|try|go with|book|run|start) (?:it|that|this|them)\b|let['’]?s do it\b|` +
    String.raw`(?:i|we)(?:['’]ll| will) (?:do|try|book|run|start|go with|take|set up|schedule) (?:it|that|this|them|one)\b|` +
    String.raw`will do\b|agreed\b|i agree\b|we agree\b|deal\b|good (?:idea|call|plan|point)\b|great (?:idea|plan)\b|` +
    String.raw`sounds (?:good|great|right|like a plan)\b|that works\b|works for (?:me|us)\b|i['’]?m in\b|` +
    String.raw`love (?:it|that|this)\b|let['’]?s go\b)`,
  'i',
);
const RESERVATION =
  /\b(?:but|though|although|however|except|unless|not sure|no way|can['’]?t|cannot|won['’]?t|don['’]?t|doesn['’]?t|isn['’]?t|aren['’]?t|wouldn['’]?t|shouldn['’]?t|doubt|maybe not|not yet)\b/i;

/** Whether a founder message explicitly takes up what the coach just proposed (see {@link ADOPTS}). */
export function agreesWith(message: string): boolean {
  return ADOPTS.test(message) && !RESERVATION.test(message);
}

/**
 * The grounding of a conversation's turns (oldest first): every founder message, and each answer the next founder
 * message explicitly took up ({@link agreesWith}).
 */
export function conversationGrounding(
  turns: readonly { readonly founder: string; readonly answer: string | null }[],
): ConversationGrounding {
  const founder: string[] = [];
  const agreed: string[] = [];
  turns.forEach((turn, i) => {
    founder.push(turn.founder);
    const previous = turns[i - 1]?.answer ?? null;
    if (previous !== null && agreesWith(turn.founder)) agreed.push(previous);
  });
  return { founder, agreed };
}

/**
 * Whether the founder's own words in `grounding` say the candidate: at least a third of its content words (framing
 * words and their names aside) are theirs.
 */
export function founderSaid(
  candidate: { readonly title: string; readonly content: string },
  grounding: ConversationGrounding,
  speakers: readonly string[] = [],
): boolean {
  const framing = new Set([...FRAMING_WORDS, ...speakers.flatMap((name) => [...contentTokens(name)])]);
  const words = [...contentTokens(`${candidate.title} ${candidate.content}`)].filter((t) => !framing.has(t));
  if (words.length === 0) return false;
  const known = contentTokens(grounding.founder.join(' '));
  return words.filter((t) => known.has(t)).length / words.length >= FOUNDER_SHARE;
}

/** Content words a candidate needs before its provenance can be judged (shorter notes are kept). */
const MIN_ECHO_WORDS = 3;
/** Share of a candidate's words that must be the founder's own for it to count as what they said. */
const FOUNDER_SHARE = 1 / 3;

/** Advice in the coach's voice: a recommendation, or an instruction that starts the note. */
const ADVICE =
  /\b(?:should|ought to|needs? to|must|recommend(?:s|ed)?|suggest(?:s|ed)?|consider(?:ing)?|make sure|be sure to|it would be (?:wise|best|good)|it is (?:worth|important|essential))\b/i;
const INSTRUCTION =
  /^(?:book|schedule|talk|run|test|try|build|hire|ask|call|meet|interview|prepare|focus|prioriti[sz]e|validate|start|stop|avoid|get|set up|reach out|draft|write|send|find|define|map|plan|review|check|confirm|clarify|secure|engage|line up|follow up|keep|make|use|pick|choose|narrow)\b/i;

/** Whether a note is phrased as advice ("The founder should…", "Book the advisor…"). */
export function adviceShaped(content: string): boolean {
  return ADVICE.test(content) || INSTRUCTION.test(content.trim());
}

/** The founder as the subject of a note: "the founder", "the team", a first person, or their name. */
const SELF_SUBJECT = /\b(?:the founders?|founder['’]s|the team|i|i['’]m|i['’]ve|my|me|we|we['’]re|our|us)\b/i;
/** What a person wants, prefers or cannot do: a goal, a preference or a constraint. */
const STANCE =
  /\b(?:wants?|wanted|wanting|hopes?|hoped|hoping|aims?|aiming|goals?|wish(?:es)?|dreams?|prefers?|preferences?|likes?|dislikes?|cares? about|priorit(?:y|ies|i[sz]es?)|motivat\w*|values?|refuses?|won['’]?t|will not|can['’]?t|cannot|unable|afford\w*|budget\w*|limited|deadline|committed|determined|ambitions?|looking to|trying to|intends?|plans? to|needs?(?! to))\b/i;

function aboutTheFounder(text: string, speakers: readonly string[]): boolean {
  const named = speakers.some(
    (name) =>
      name.trim() !== '' &&
      new RegExp(`\\b${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  );
  return (named || SELF_SUBJECT.test(text)) && STANCE.test(text);
}

/** Where the model says a candidate came from (contract `MemoryCandidate.source`); null when it did not say. */
export type CandidateProvenance = 'founder_stated' | 'founder_agreed' | 'coach_advice' | null;

/**
 * Whether a memory candidate is the coach's own advice or framing, which is never kept as a fact about the venture
 * unless the founder agreed to it (production: the same advice was kept four times while the founder's own goal
 * was missed twice). The founder's own goals, preferences and constraints come first, so the model's word is
 * taken where it can be: it labels each candidate (`source`), and
 * - `coach_advice` is the coach's: dropped;
 * - `founder_agreed` is kept only when the founder explicitly took up an answer ({@link agreesWith}) that shares
 *   words with it, or a third of its words are the founder's own;
 * - `founder_stated` is kept, however reworded ("make a lot of money fast" kept as "become wealthy quickly"),
 *   unless it is phrased as advice ({@link adviceShaped}) and barely any of it is the founder's words.
 * Without a label (an older model or a mock), it is judged from the words: kept when the founder took up advice
 * saying it, when at least a third of its words are the founder's own and it is not advice, or when it states
 * what the founder (or their team) wants, prefers or cannot do; otherwise it is the coach's. Citing the venture's
 * records never makes a note the founder's: the coach restating a record is still the coach talking. Notes of
 * fewer than three content words are kept (too short to judge).
 */
export function isCoachEcho(
  candidate: { readonly title: string; readonly content: string },
  grounding: ConversationGrounding,
  options: { readonly speakers?: readonly string[]; readonly source?: CandidateProvenance } = {},
): boolean {
  const speakers = options.speakers ?? [];
  const framing = new Set([...FRAMING_WORDS, ...speakers.flatMap((name) => [...contentTokens(name)])]);
  const words = [...contentTokens(`${candidate.title} ${candidate.content}`)].filter((t) => !framing.has(t));
  const source = options.source ?? null;
  if (source === 'coach_advice') return true;
  if (words.length < MIN_ECHO_WORDS) return false;
  const share = (texts: readonly string[]): number => {
    const known = contentTokens(texts.join(' '));
    return words.filter((t) => known.has(t)).length / words.length;
  };
  const founderShare = share(grounding.founder);
  const agreedShare = share(grounding.agreed);
  const advice = adviceShaped(candidate.content);
  switch (source) {
    case 'founder_agreed':
      return !(agreedShare > 0 || founderShare >= FOUNDER_SHARE);
    case 'founder_stated':
      return advice && founderShare < FOUNDER_SHARE && agreedShare === 0;
    default:
      if (agreedShare >= 0.5) return false;
      if (advice) return founderShare < 0.5;
      if (founderShare >= FOUNDER_SHARE) return false;
      return !aboutTheFounder(`${candidate.title}. ${candidate.content}`, speakers);
  }
}

// ------------------------------------------------------------------------------------------------
// What the founder made the vEIR forget
// ------------------------------------------------------------------------------------------------

/**
 * Cosine similarity at or above which a candidate learned from the same conversation as a forgotten item is that
 * item again (a paraphrase by the next distillation of the same transcript); other conversations need
 * {@link MEMORY_DUPLICATE_COSINE}.
 */
export const FORGOTTEN_SAME_CONVERSATION_COSINE = 0.85;

/** Bits of a {@link meaningSignature}. */
const SIGNATURE_BITS = 256;

/** A seeded PRNG (mulberry32): the signature's hyperplanes are the same in every process. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let planes: { readonly dim: number; readonly values: Float64Array } | null = null;

/** {@link SIGNATURE_BITS} random Gaussian hyperplanes of dimension `dim` (Box–Muller from a fixed seed). */
function hyperplanes(dim: number): Float64Array {
  if (planes?.dim === dim) return planes.values;
  const random = mulberry32(0x5eed_f0f6);
  const values = new Float64Array(SIGNATURE_BITS * dim);
  for (let i = 0; i < values.length; i += 2) {
    const u = Math.max(random(), 1e-12);
    const v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    values[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < values.length) values[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  planes = { dim, values };
  return values;
}

/**
 * A locality-sensitive fingerprint of an embedding (random-hyperplane SimHash, 256 bits as 64 hex characters):
 * two signatures estimate the cosine of their vectors ({@link signatureCosine}), but the text cannot be read
 * back from one. What a forgotten item is remembered by, so it is never learned again from the same words.
 */
export function meaningSignature(vector: readonly number[]): string {
  const dim = vector.length;
  const values = hyperplanes(dim);
  let hex = '';
  for (let block = 0; block < SIGNATURE_BITS / 4; block += 1) {
    let nibble = 0;
    for (let b = 0; b < 4; b += 1) {
      const plane = (block * 4 + b) * dim;
      let dot = 0;
      for (let i = 0; i < dim; i += 1) dot += (values[plane + i] ?? 0) * (vector[i] ?? 0);
      nibble = (nibble << 1) | (dot >= 0 ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/** The cosine two {@link meaningSignature}s estimate (cos of π × the share of bits that differ); -1 if unusable. */
export function signatureCosine(a: string, b: string): number {
  if (a.length !== SIGNATURE_BITS / 4 || b.length !== a.length) return -1;
  let differ = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16);
    if (Number.isNaN(x)) return -1;
    for (; x !== 0; x &= x - 1) differ += 1;
  }
  return Math.cos((Math.PI * differ) / SIGNATURE_BITS);
}

/** A short hash of a text's normalised words (`textKey`): equal for the same words however written. */
export function memoryTextKey(text: string): string {
  return createHash('sha256').update(textKey(text), 'utf8').digest('hex').slice(0, 32);
}

/** Numbers written as words ("five thousand"): as different from each other as digits are. */
const NUMBER_WORDS = new Set(
  (
    'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen ' +
    'seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million ' +
    'billion trillion half quarter dozen'
  ).split(' '),
);

/** The numbers a text states ("5 000", "30%", "2.5", "five thousand"), normalised: a different number is a different fact. */
function numbersOf(text: string): string[] {
  const digits = (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,](?=\d{3}\b)/g, ''));
  const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => NUMBER_WORDS.has(w));
  return [...new Set([...digits, ...words])].sort();
}

/** A short hash of the numbers a text states (equal when both state the same numbers, or none). */
export function memoryNumbersKey(text: string): string {
  return createHash('sha256').update(numbersOf(text).join(' '), 'utf8').digest('hex').slice(0, 16);
}

/** Whether two texts state the same numbers (or none): a meaning match never merges "$500" and "$700". */
export function sameNumbers(a: string, b: string): boolean {
  return numbersOf(a).join(' ') === numbersOf(b).join(' ');
}

/**
 * What the vEIR remembers of an item the founder forgot (deleted, or corrected away from what the vEIR kept), per
 * conversation it was learned from: hashes of its title and content words, of its numbers, and a meaning
 * signature when it had an embedding. Never its text.
 */
export interface ForgottenPrint {
  readonly sessionId: string;
  readonly type: string;
  readonly titleKey: string;
  readonly contentKey: string;
  readonly numbersKey: string;
  readonly signature: string | null;
}

/** The fingerprint of one version of a memory item (see {@link ForgottenPrint}). */
export function forgottenPrintOf<T extends string>(
  item: { readonly type: T; readonly title: string; readonly content: string },
  embedding: readonly number[] | null,
): Omit<ForgottenPrint, 'sessionId' | 'type'> & { readonly type: T } {
  return {
    type: item.type,
    titleKey: memoryTextKey(item.title),
    contentKey: memoryTextKey(item.content),
    numbersKey: memoryNumbersKey(`${item.title} ${item.content}`),
    signature: embedding === null || embedding.length === 0 ? null : meaningSignature(embedding),
  };
}

/**
 * Whether a candidate is something the founder made the vEIR forget. From a conversation it was learned from (the
 * next distillation of the same transcript): the same words, the same title and type, or the same meaning at
 * {@link FORGOTTEN_SAME_CONVERSATION_COSINE}. From any other conversation: the same words, or the same meaning at
 * {@link MEMORY_DUPLICATE_COSINE} (the vEIR never learns it back from its own notes of the earlier conversation),
 * unless the founder said it again there (`saidAgain`, {@link founderSaid}): then it is new, as it is for a person
 * told "forget that" who hears it again. A meaning match needs the same numbers.
 */
export function matchesForgotten(
  candidate: { readonly type: string; readonly title: string; readonly content: string },
  embedding: readonly number[] | null,
  conversationId: string,
  forgotten: readonly ForgottenPrint[],
  options: { readonly saidAgain?: boolean } = {},
): boolean {
  if (forgotten.length === 0) return false;
  const print = forgottenPrintOf(candidate, embedding);
  return forgotten.some((f) => {
    const same = f.sessionId === conversationId;
    if (!same && options.saidAgain === true) return false;
    if (f.contentKey === print.contentKey) return true;
    if (same && f.titleKey === print.titleKey && f.type === print.type) return true;
    if (f.signature === null || print.signature === null || f.numbersKey !== print.numbersKey) return false;
    return (
      signatureCosine(f.signature, print.signature) >=
      (same ? FORGOTTEN_SAME_CONVERSATION_COSINE : MEMORY_DUPLICATE_COSINE)
    );
  });
}
