import { founderMoves, socialTurnOf, type SocialTurn } from '../prompts/conversation-state.js';
import { sentenceSpans } from './meta-narration.js';

/**
 * Conversation craft the lab still heard after the presence work (wave 6, runs 39088463537 and 39089309562),
 * enforced where the prompt alone did not hold:
 *
 * - SM-19: "thank you, this is helpful" got "You're welcome. Let's keep moving." and the whole plan again. A social
 *   turn (thanks, a wrap-up, a hello: `socialTurnOf`) gets a short reply ({@link SOCIAL_BUDGETS}: whole sentences
 *   within a few words), a wrap-up asks nothing new, and its structured response carries nothing to cite, plan or
 *   remember (`social_turn_report` x4: "Okay, thanks, that's helpful. Talk soon." still came with next steps).
 * - `spoken_no_handback` x6: a spoken reply that ends on a statement leaves the founder waiting; it ends by handing the
 *   turn back ({@link endsWithHandBack}, {@link spokenHandBack}) unless the founder is wrapping up.
 * - `repeated_reply` x3, LAB-M3, LAB-M10: a reply that says the previous one again. Its sentences that mostly repeat
 *   the previous reply (four-word sequences, as the evals measure) are left out ({@link withoutRepeats}), unless
 *   the founder asked to hear it again ({@link asksToRepeat}).
 */

/** How long a social reply may run: whole sentences, within a number of words (the first sentence always stays). */
export const SOCIAL_BUDGETS: Readonly<
  Record<SocialTurn, { readonly sentences: number; readonly words: number }>
> = {
  thanks: { sentences: 2, words: 30 },
  greeting: { sentences: 2, words: 30 },
  closing: { sentences: 3, words: 40 },
};

/** What a wrap-up says when every sentence of it asked something new. */
export const CLOSING_FALLBACK = 'Talk soon.';

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function sentencesOf(text: string): string[] {
  return sentenceSpans(text).map((s) => text.slice(s.start, s.end));
}

/**
 * `text` as a social reply of kind `social` (see {@link SOCIAL_BUDGETS}): its first sentences within the budget, as
 * one paragraph; for a wrap-up, without the sentences that ask something. Unchanged when it already fits.
 */
export function withinSocialBudget(text: string, social: SocialTurn): string {
  const budget = SOCIAL_BUDGETS[social];
  let sentences = sentencesOf(text);
  if (social === 'closing') {
    const statements = sentences.filter((s) => !/\?["'”’)\]*_]*$/.test(s));
    sentences = statements.length > 0 ? statements : [CLOSING_FALLBACK];
  }
  const kept: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const n = wordsIn(sentence);
    if (kept.length > 0 && (kept.length >= budget.sentences || words + n > budget.words)) break;
    kept.push(sentence);
    words += n;
  }
  const out = kept.join(' ');
  const same = out.replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim();
  return same ? text : out;
}

/** The founder asks to hear something again: then a reply may repeat it. */
const REPEAT_REQUEST =
  /\b(?:repeat (?:that|it|this|yourself|what you said)|say (?:that|it|this) again|one more time|come again|(?:what|which) was (?:that|it|the (?:first|second|last|next) (?:step|one|thing|point))|remind me what you (?:said|suggested)|go over (?:that|it) again|(?:can|could) you (?:say|explain) (?:that|it) again|(?:sorry|pardon),? what\?)/i;

/** Whether the founder asks to hear the last reply (or part of it) again. */
export function asksToRepeat(founderText: string): boolean {
  return REPEAT_REQUEST.test(founderText.replace(/[‘’ʼ]/g, "'"));
}

/** Four-word sequences of a text (lower case, citation keys and punctuation out), the evals' repetition unit. */
export function fourGramsOf(text: string): Set<string> {
  const words = text
    .replace(/\s*\[E\d+(?:,\s*E\d+)*\]/gi, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
  const out = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i += 1) out.add(words.slice(i, i + 4).join(' '));
  return out;
}

/** Fewest four-word sequences a sentence needs before it is compared (a short acknowledgement repeats safely). */
export const REPEAT_MIN_GRAMS = 4;
/** A sentence repeats the previous reply when this share of its four-word sequences was said there. */
export const REPEAT_SENTENCE_SHARE = 0.6;

/** Whether one sentence (or unit) mostly repeats `previous` (its four-word sequences). */
export function repeatsPrevious(sentence: string, previous: ReadonlySet<string>): boolean {
  const grams = fourGramsOf(sentence);
  if (grams.size < REPEAT_MIN_GRAMS || previous.size === 0) return false;
  let seen = 0;
  for (const g of grams) if (previous.has(g)) seen += 1;
  return seen / grams.size >= REPEAT_SENTENCE_SHARE;
}

/** What a reply says when every sentence of it was the previous reply again. */
export const REPEAT_FALLBACK = 'That still stands from a moment ago. Which part do you want to dig into?';

/**
 * `text` without the sentences that mostly repeat `previous` (the vEIR's previous reply; see the module comment).
 * `dropped` counts them; `text` is '' when every sentence was a repeat.
 */
export function withoutRepeats(
  text: string,
  previous: string,
): { readonly text: string; readonly dropped: number } {
  const said = fourGramsOf(previous);
  if (said.size === 0) return { text, dropped: 0 };
  const spans = sentenceSpans(text);
  const repeated = spans.filter((s) => repeatsPrevious(text.slice(s.start, s.end), said));
  if (repeated.length === 0) return { text, dropped: 0 };
  let out = '';
  let from = 0;
  for (const span of repeated) {
    out += text.slice(from, span.start);
    from = span.end;
  }
  out += text.slice(from);
  const tidy = out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .filter((line, i, all) => !(line.trim() === '' && (all[i - 1] ?? '').trim() === ''))
    .join('\n')
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: tidy, dropped: repeated.length };
}

/** How a spoken reply hands the turn back without a question ("Tell me how that sits with you."). */
const INVITATION =
  /^(?:tell me|walk me through|your turn|go ahead|over to you|let me know|say more|talk me through|what do you think|keep going|let's hear|i'd love to hear|try it and tell me)\b/i;

/** Whether a spoken reply ends by handing the turn back: its last sentence asks, or invites them to talk. */
export function endsWithHandBack(spoken: string): boolean {
  const sentences = sentencesOf(spoken.trim());
  const last = sentences.at(-1) ?? '';
  return /\?["'”’)\]*_]*$/.test(last) || INVITATION.test(last.replace(/^[^\p{L}]+/u, ''));
}

/** Short hand-backs said after a spoken reply that ended on a statement (one per turn, varied by its id). */
export const SPOKEN_HAND_BACKS = ['What do you think?', 'How does that sound?'] as const;
/** The hand-back after a reply to someone who sounds stressed or discouraged. */
export const STRESSED_HAND_BACK = 'What would help most right now?';

/**
 * The hand-back of a call's turn (see the module comment): none when the founder is only being social or wrapping
 * up; a question about what would help when they sound stressed; else one of {@link SPOKEN_HAND_BACKS}, varied by
 * `seed` (the turn's id).
 */
export function spokenHandBackFor(founderText: string, seed: string): string | null {
  if (socialTurnOf(founderText) !== null) return null;
  if (founderMoves(founderText).includes('stress')) return STRESSED_HAND_BACK;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return SPOKEN_HAND_BACKS[hash % SPOKEN_HAND_BACKS.length] ?? SPOKEN_HAND_BACKS[0];
}
