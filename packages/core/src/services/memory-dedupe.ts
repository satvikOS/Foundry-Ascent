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

/** What the founder said in a conversation, for judging where a memory candidate came from. */
export interface ConversationGrounding {
  /** The founder's own words, and the coach's advice the founder agreed to ("Sounds good, let's do that"). */
  readonly founder: readonly string[];
}

/** A founder message that agrees with what the coach just said. */
const AGREEMENT =
  /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|agreed|i agree|deal|perfect|great|good idea|sounds good|makes sense|let'?s do (?:it|that)|will do|right|exactly|absolutely|definitely)\b/i;

/**
 * The grounding of a conversation's turns (oldest first): every founder message, plus each answer the next founder
 * message agreed to.
 */
export function conversationGrounding(
  turns: readonly { readonly founder: string; readonly answer: string | null }[],
): ConversationGrounding {
  const founder: string[] = [];
  turns.forEach((turn, i) => {
    founder.push(turn.founder);
    const previous = turns[i - 1]?.answer ?? null;
    if (previous !== null && AGREEMENT.test(turn.founder)) founder.push(previous);
  });
  return { founder };
}

/** Content words a candidate needs before it can be judged (shorter notes are kept). */
const MIN_ECHO_WORDS = 3;

/**
 * Whether a memory candidate is only the coach's own advice or framing, which is never kept as a fact about the
 * venture (production: the same advice was kept four times while the founder's own goal was missed): none of its
 * content words come from the founder (or advice they agreed to), and it cites none of the venture's records
 * (`cited`: evidence the turn was shown). Anything the founder said, even reworded or said back by the coach,
 * shares a word with them and is kept.
 */
export function isCoachEcho(
  candidate: { readonly title: string; readonly content: string },
  grounding: ConversationGrounding,
  options: { readonly speakers?: readonly string[]; readonly cited: boolean },
): boolean {
  if (options.cited) return false;
  const framing = new Set([
    ...FRAMING_WORDS,
    ...(options.speakers ?? []).flatMap((name) => [...contentTokens(name)]),
  ]);
  const words = [...contentTokens(`${candidate.title} ${candidate.content}`)].filter((t) => !framing.has(t));
  if (words.length < MIN_ECHO_WORDS) return false;
  const founder = contentTokens(grounding.founder.join(' '));
  return !words.some((t) => founder.has(t));
}
