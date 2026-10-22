import { contentWords, founderMoves, socialTurnOf, type SocialTurn } from '../prompts/conversation-state.js';
import { identityQuestionOf, type IdentityCheckOptions } from './identity.js';
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
 * - LAB-R8: the founder's news parked for the vEIR's own pending question ("Before we talk about that, let's
 *   finish…"). In a reply to news, such a sentence is left out ({@link withoutAgendaPush}).
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

/**
 * Whether the founder asks to hear the last reply (or part of it) again: in so many words, or by asking what the
 * vEIR remembers or where they were (the answer names it again, on purpose).
 */
export function asksToRepeat(founderText: string): boolean {
  if (REPEAT_REQUEST.test(founderText.replace(/[‘’ʼ]/g, "'"))) return true;
  const moves = founderMoves(founderText);
  return moves.includes('recall') || moves.includes('resume');
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

/**
 * The questions of a text (its sentences that end in a question mark), as content words: the questions a previous
 * reply asked, which the next reply never asks again in other words (item 20: "do you have a written agreement on
 * what success looks like…?" was asked two turns running, the second time in reply to the founder's SSO worry).
 */
export function questionsOf(text: string): ReadonlySet<string>[] {
  return sentenceSpans(text)
    .map((s) => text.slice(s.start, s.end))
    .filter((sentence) => /\?["'”’)\]*_]*$/.test(sentence))
    .map((sentence) => contentWords(sentence))
    .filter((words) => words.size >= 3);
}

/**
 * Whether `sentence` asks again one of `asked` (see {@link questionsOf}) in other words: a question that shares three
 * content words or more with it, and most of its own (60%, or of the shorter one).
 */
export function reasksQuestion(sentence: string, asked: readonly ReadonlySet<string>[]): boolean {
  if (asked.length === 0 || !/\?["'”’)\]*_]*\s*$/.test(sentence)) return false;
  const words = contentWords(sentence);
  if (words.size < 3) return false;
  return asked.some((question) => {
    let shared = 0;
    for (const w of words) if (question.has(w)) shared += 1;
    return shared >= 3 && shared / Math.min(words.size, question.size) >= 0.6;
  });
}

/**
 * The questions the vEIR asked in `earlier` (its replies and its opener in this conversation; see {@link questionsOf}):
 * never asked again in other words, however long ago (voice suite, 2026-10-22: "Who signs the cheque for each library
 * branch, and who can block it?" was asked in five replies of one call, the gate knowing only the previous reply's).
 */
export function questionsAskedIn(earlier: readonly (string | null | undefined)[]): ReadonlySet<string>[] {
  return earlier.flatMap((text) => (text === null || text === undefined ? [] : questionsOf(text)));
}

/**
 * Whether a reply to `founderText` is checked against what the conversation already said (repeats, questions asked
 * again): not when the founder asks to hear it again ({@link asksToRepeat}), or sincerely asks who or what the coach
 * is (its honest answer is said however recently it was said; the presence policy).
 */
export function checksForRepeats(founderText: string, identity: IdentityCheckOptions): boolean {
  return !asksToRepeat(founderText) && identityQuestionOf(founderText, identity) === null;
}

/**
 * `text` without its question sentences that ask one of `asked` again in other words ({@link reasksQuestion});
 * `dropped` counts them, and `text` is '' when nothing else was said.
 */
export function withoutReasks(
  text: string,
  asked: readonly ReadonlySet<string>[],
): { readonly text: string; readonly dropped: number } {
  if (asked.length === 0) return { text, dropped: 0 };
  const spans = sentenceSpans(text).filter((s) => reasksQuestion(text.slice(s.start, s.end), asked));
  if (spans.length === 0) return { text, dropped: 0 };
  let out = '';
  let from = 0;
  for (const span of spans) {
    out += text.slice(from, span.start);
    from = span.end;
  }
  out += text.slice(from);
  return {
    text: out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    dropped: spans.length,
  };
}

/** What a reply says when every sentence of it was the previous reply again. */
export const REPEAT_FALLBACK = 'That still stands from a moment ago. Which part do you want to dig into?';

/**
 * `text` without the sentences that mostly repeat `previous` (the vEIR's previous reply; see the module comment), or
 * ask one of its questions again in other words ({@link reasksQuestion}). `dropped` counts them; `text` is '' when
 * every sentence was a repeat.
 */
export function withoutRepeats(
  text: string,
  previous: string,
): { readonly text: string; readonly dropped: number } {
  const said = fourGramsOf(previous);
  if (said.size === 0) return { text, dropped: 0 };
  const asked = questionsOf(previous);
  const spans = sentenceSpans(text);
  const repeated = spans.filter((s) => {
    const sentence = text.slice(s.start, s.end);
    return repeatsPrevious(sentence, said) || reasksQuestion(sentence, asked);
  });
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

/**
 * A sentence that parks the founder's news for the vEIR's own agenda (LAB-R8, three times in one lab run: "Before we
 * talk about that, let's finish… what did you learn from the five library staff interviews?", "One thing at a time —
 * let's finish the student union question first, then we'll talk about Noor.").
 */
const AGENDA_PUSH =
  /^(?:(?:but|so|okay|ok|great|nice|good|right|alright)[,!.]?\s+)?(?:before (?:we|you|i) (?:talk about|get (?:to|into)|dig into|go (?:there|into)|move on|jump|take (?:that|it|this) on|celebrate)|one thing at a time|(?:first,?\s+)?let's (?:first\s+)?(?:finish|wrap up|close out|settle|come back to)\b[^.?!]*\b(?:first|before)\b|first,? let's (?:finish|wrap up|close out|settle))/i;

/** Whether `sentence` parks the founder's news for the vEIR's own agenda (see {@link AGENDA_PUSH}). */
export function parksTheirNews(sentence: string): boolean {
  return AGENDA_PUSH.test(sentence.replace(/[‘’ʼ]/g, "'").replace(/^[\s*_>"“]+/, ''));
}

/** A sentence that only acknowledges ("Okay, Idris.", "Got it.", "Thanks for that.", "Great, Maya!"). */
const LEAD_IN =
  /^(?:okay|ok|alright|all right|got it|right|sure|understood|of course|fair enough|great|good|nice|cool|perfect|i see|i get (?:that|it|you)|thanks(?: for (?:that|sharing(?: that)?|telling me))?|thank you(?: for (?:that|sharing(?: that)?|telling me))?|makes sense|yes|yeah|so|well|hmm|ah|oh)(?:[\s,]+\p{Lu}[\p{L}'’-]*)?[\s.!…]*$/iu;

/**
 * Whether `text` says nothing but acknowledgements (or nothing at all): what is left of a reply when the gate left out
 * everything after its lead-in as already said (lab run 39780304879: "Okay, Idris." was a whole call reply).
 */
export function isOnlyLeadIn(text: string): boolean {
  return sentencesOf(text.trim()).every((sentence) => LEAD_IN.test(sentence.replace(/[‘’ʼ]/g, "'").trim()));
}

/** What a reply to news says when every sentence of it parked the news. */
export const NEWS_FALLBACK = 'That’s real news. How did it come about?';

/**
 * `text` without the sentences that park the founder's news for the vEIR's agenda ({@link parksTheirNews}), for a
 * reply to a message that brings news; `dropped` counts them, and `text` is '' when nothing else was said.
 */
export function withoutAgendaPush(text: string): { readonly text: string; readonly dropped: number } {
  const spans = sentenceSpans(text);
  const pushed = spans.filter((s) => parksTheirNews(text.slice(s.start, s.end)));
  if (pushed.length === 0) return { text, dropped: 0 };
  let out = '';
  let from = 0;
  for (const span of pushed) {
    out += text.slice(from, span.start);
    from = span.end;
  }
  out += text.slice(from);
  return {
    text: out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    dropped: pushed.length,
  };
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

/**
 * Short hand-backs (four words at most: the call's spoken budget keeps room for one) said after a spoken reply that
 * ended on a statement: varied by turn, and never one the conversation already heard (the evals' `repeated_question`
 * flags an exact repeat anywhere in a conversation; two fixed lines repeated on any call of three or more such
 * replies).
 */
export const SPOKEN_HAND_BACKS = [
  'What do you think?',
  'How does that sound?',
  'Does that fit?',
  'Want to try that?',
  "Anything you'd change?",
  "What's your gut?",
  'Does that feel doable?',
  'Where would you start?',
  'Sound right to you?',
  'Which part first?',
  'Does that match?',
  'Shall we try it?',
] as const;
/** Hand-backs after a reply to someone who sounds stressed or discouraged: about them, not the plan. */
export const STRESSED_HAND_BACKS = [
  'What would help most right now?',
  'How are you holding up?',
  'What feels heaviest right now?',
  'Want to take it one piece at a time?',
  'What would make this week lighter?',
] as const;
/** The first stressed hand-back (kept for callers that name one). */
export const STRESSED_HAND_BACK = STRESSED_HAND_BACKS[0];

function plainLine(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The hand-back of a call's turn (see the module comment): none when the founder is only being social or wrapping
 * up; one about what would help when they sound stressed ({@link STRESSED_HAND_BACKS}); else one of
 * {@link SPOKEN_HAND_BACKS}. Chosen by `seed` (the turn's id) among those the conversation has not heard yet
 * (`earlier`: the replies in view, and the opener): null once every one was said.
 */
export function spokenHandBackFor(
  founderText: string,
  seed: string,
  earlier: readonly (string | null | undefined)[] = [],
): string | null {
  if (socialTurnOf(founderText) !== null) return null;
  const pool: readonly string[] = founderMoves(founderText).includes('stress')
    ? STRESSED_HAND_BACKS
    : SPOKEN_HAND_BACKS;
  const heard = earlier.map((text) => plainLine(text ?? '')).join('\n');
  const fresh = pool.filter((line) => !heard.includes(plainLine(line)));
  if (fresh.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return fresh[hash % fresh.length] ?? null;
}
