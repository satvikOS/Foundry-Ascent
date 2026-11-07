import { contentWords, founderMoves, type SocialTurn } from '../prompts/conversation-state.js';
import { sentenceSpans } from './meta-narration.js';

/**
 * Conversation craft the lab still heard after the presence work (wave 6, runs 39088463537 and 39089309562),
 * enforced where the prompt alone did not hold:
 *
 * - SM-19: "thank you, this is helpful" got "You're welcome. Let's keep moving." and the whole plan again. A social
 *   turn (thanks, a wrap-up, a hello: `socialTurnOf`) gets a short reply ({@link SOCIAL_BUDGETS}: whole sentences
 *   within a few words), a wrap-up asks nothing new, and its structured response carries nothing to cite, plan or
 *   remember (`social_turn_report` x4: "Okay, thanks, that's helpful. Talk soon." still came with next steps).
 * - A spoken reply is never given a stock hand-back ("What do you think?") after it: production, 2026-11-06, "hows
 *   your personal life going" got "I'm good, thanks for asking. What do you think?", a question that followed from
 *   nothing. A complete answer may end without a question (prompts/craft.ts `SPOKEN_REGISTER`); the call shows the
 *   founder it is listening once the reply ends.
 * - `repeated_reply` x3, LAB-M3, LAB-M10: a reply that says the previous one again. Its sentences that mostly repeat
 *   the previous reply (four-word sequences, as the evals measure) are left out ({@link withoutRepeats}), unless
 *   the founder asked to hear it again ({@link asksToRepeat}).
 * - LAB-R8: the founder's news parked for the vEIR's own pending question ("Before we talk about that, let's
 *   finish…"). In a reply to news, such a sentence is left out ({@link withoutAgendaPush}).
 */

/** How long a social reply may run: whole sentences, within a number of words (the first sentence always stays). */
/**
 * Replies to a founder who asked for yes/no answers, or for short ones (`statedPreferences`): live pilot 42124259353's
 * "yes or no answers only" got three paragraphs two replies later. A flagged turn is never held to them (its referral is
 * said whole).
 */
export const YES_NO_BUDGET = { sentences: 2, words: 40 } as const;
export const SHORT_BUDGET = { sentences: 4, words: 70 } as const;

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

/**
 * The founder asks to hear something again, or to run a rehearsal or a drill again ("ok stop, run it again from the
 * top", "same questions again"): then a reply may repeat it (diff3-A3; the brief: repetition the student asked for is
 * not a fault).
 */
const REPEAT_REQUEST =
  /\b(?:from the top|(?:run|do|go through|ask|start) (?:(?:it|that|this|them|those|the (?:\w+ )?(?:questions|pitch|run|round|drill|rehearsal|role-?play)) )?(?:again|over)|again,? (?:the )?same (?:questions|run|round|drill)|same questions again|(?:another|one more) (?:round|run|pass)|repeat (?:that|it|this|yourself|what you said)|say (?:that|it|this) again|one more time|come again|(?:what|which) was (?:that|it|the (?:first|second|last|next) (?:step|one|thing|point))|remind me what you (?:said|suggested)|go over (?:that|it) again|(?:can|could) you (?:say|explain) (?:that|it) again|(?:sorry|pardon),? what\?)/i;

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
/** The words a repeat is read on: lower case, citations and punctuation out (apostrophes kept). */
function repeatWords(text: string): string[] {
  return text
    .replace(/\s*\[E\d+(?:,\s*E\d+)*\]/gi, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** The four-word sequences of `words`, in order. */
function gramList(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 4 <= words.length; i += 1) out.push(words.slice(i, i + 4).join(' '));
  return out;
}

export function fourGramsOf(text: string): Set<string> {
  return new Set(gramList(repeatWords(text)));
}

/**
 * How a reply signs off ("You're set.", "Go get those answers!", "Good luck with the dean.", "You've got this."): the
 * line long sessions closed on again and again (lab run 42238272157 on Haiku: "You're set… go get those answers" closed
 * three replies). Too short for the four-word share, so a sign-off is compared by its kind ({@link signOffKind}).
 */
const SIGN_OFF =
  /^(?:you(?:'re| are) (?:all )?set|good luck|best of luck|go (?:and )?(?:get|grab|nail|crush|land|win|make)|you(?:'ve| have) got this|let me know how|come back (?:and|to)|talk soon|over to you|go for it|knock (?:it|'em|them) out|off you go|onward)\b/u;

/** The kind of sign-off a sentence is ("you're set", "go get"), or null for any other sentence. */
function signOffKind(sentence: string): string | null {
  const text = repeatWords(sentence).join(' ');
  const m = SIGN_OFF.exec(text);
  if (m === null) return null;
  // "You're all set" is "you're set"; "go and get" is "go get".
  return m[0]
    .replace(/\b(?:all|and) /gu, '')
    .replace(/^you are/u, "you're")
    .replace(/^you have/u, "you've");
}

/** Whether a sentence only signs off ("You're set.", "Good luck with the dean."): left out when said again, never more. */
export function signsOff(sentence: string): boolean {
  return signOffKind(sentence) !== null;
}

/** Marks that live in a repeat-key set beside the four-word sequences: never words, so never a sequence. */
const SIGN_OFF_KEY = '\u0000signoff:';
const SIGN_OFF_WORD = '\u0000signoff-word:';

/**
 * What a later reply is checked against for repeats (`withoutRepeats`, the sentence gate): the four-word sequences of
 * `text`, and the kinds and content words of its sign-offs.
 */
export function repeatKeysOf(text: string): Set<string> {
  const keys = fourGramsOf(text);
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    const kind = signOffKind(sentence);
    if (kind === null) continue;
    keys.add(`${SIGN_OFF_KEY}${kind}`);
    for (const word of contentWords(sentence)) keys.add(`${SIGN_OFF_WORD}${word}`);
  }
  return keys;
}

/** Fewest four-word sequences a sentence needs before it is compared (a short acknowledgement repeats safely). */
export const REPEAT_MIN_GRAMS = 4;
/** A sentence repeats the previous reply when this share of its four-word sequences was said there. */
export const REPEAT_SENTENCE_SHARE = 0.6;
/**
 * Whether one sentence (or unit) repeats `previous` (from {@link repeatKeysOf}, or {@link fourGramsOf}): most of its
 * four-word sequences were said there, or it is a sign-off of a kind already said, or one that shares two content words
 * with one. A sentence that is mostly new keeps a phrase said before (leaving it out would lose what is new); the
 * phrasing ledger names such phrases back to the model so it does not say them (prompts/phrasing.ts).
 */
export function repeatsPrevious(sentence: string, previous: ReadonlySet<string>): boolean {
  if (previous.size === 0) return false;
  const kind = signOffKind(sentence);
  if (kind !== null) {
    if (previous.has(`${SIGN_OFF_KEY}${kind}`)) return true;
    let shared = 0;
    for (const word of contentWords(sentence)) if (previous.has(`${SIGN_OFF_WORD}${word}`)) shared += 1;
    if (shared >= 2) return true;
  }
  const grams = fourGramsOf(sentence);
  if (grams.size < REPEAT_MIN_GRAMS) return false;
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

/** A line that is an item of a list ("1. …", "- …"). */
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

/** Whether `text` (a sentence or unit) is an item of a list: left out, its list would have a hole. */
export function isListItem(text: string): boolean {
  return LIST_ITEM.test(text.replace(/^\s*\n/, ''));
}

/** What a reply says when every sentence of it was the previous reply again. */
// Live pilot 42124259353: the old line ("That still stands from a moment ago…") was itself a stock phrase the judge read
// as canned.
export const REPEAT_FALLBACK = 'We covered that a moment ago. Which part should we take further?';

/**
 * A safety line: crisis support, a hotline, being unsafe. Never left out as a repeat, however often it was said (the
 * presence policy and the escalation invariant: a wellbeing referral is said as often as it is needed).
 */
const SAFETY_LINE =
  /\b(?:988|911|999|112|crisis|helpline|hotline|lifeline|samaritans|text line|emergency|unsafe|in danger|self[- ]harm|suicid\w*|hurt(?:ing)? yourself|counsell?ors?|therapists?|mental health|support line|wellbeing|well-being)\b/i;

/**
 * A referral to a person who can act on a consequential matter (a lawyer, an IRB, the tech-transfer office, a doctor,
 * the program's staff). Kept on a turn whose message is flagged for that kind of matter (`keepReferrals`): the guard
 * never takes the escalation out of the reply that needs it.
 */
const REFERRAL_LINE =
  /\b(?:lawyers?|attorneys?|legal (?:advice|counsel|clinic|review|help)|counsel|irb|ethics (?:board|committee|review)|tech[- ]?transfer|patent (?:attorney|agent)|accountants?|tax (?:advisers?|advisors?)|doctors?|clinicians?|physicians?|pharmacists?|regulatory (?:advice|expert|consultant|counsel)|fda|program(?:me)? (?:staff|team|lead|director)|human eir|your eir|escalat\w*|flag(?:ged|ging)? (?:this|it) (?:to|for))\b/i;

/** Whether `sentence` is a safety line ({@link SAFETY_LINE}), or a referral when `keepReferrals` ({@link REFERRAL_LINE}). */
export function isProtectedLine(sentence: string, keepReferrals = false): boolean {
  return SAFETY_LINE.test(sentence) || (keepReferrals && REFERRAL_LINE.test(sentence));
}

export interface WithoutRepeatsOptions {
  /** The turn is flagged for a consequential matter: a referral sentence is never left out ({@link REFERRAL_LINE}). */
  readonly keepReferrals?: boolean;
}

export interface WithoutRepeats {
  readonly text: string;
  /** Sentences left out (a lead-in left with nothing after it is not counted). */
  readonly dropped: number;
  /** The sentences left out, as written (for the "already said" brief of a reply written again). */
  readonly removed: readonly string[];
}

/**
 * `text` without the sentences that mostly repeat `previous` (the vEIR's earlier replies; see the module comment), or
 * ask one of their questions again in other words ({@link reasksQuestion}). `dropped` counts them; `text` is '' when
 * every sentence was a repeat. Only the repeated sentence goes, never what follows it (a reply cut at its first repeat
 * lost new content and its safety lines: 57 of 521 pilot replies lost 25 words or more). A lead-in left announcing
 * nothing ("Ask them:") goes with it. A safety line, and on a flagged turn a referral, is never left out
 * ({@link isProtectedLine}). A reply written whole that lost a sentence here is written again once with what was
 * already said (`generateWhole`), so what is left never leans on a hole.
 */
export function withoutRepeats(
  text: string,
  previous: string,
  options: WithoutRepeatsOptions = {},
): WithoutRepeats {
  const said = repeatKeysOf(previous);
  if (said.size === 0) return { text, dropped: 0, removed: [] };
  const asked = questionsOf(previous);
  const spans = sentenceSpans(text);
  const repeated: { start: number; end: number }[] = [];
  const removed: string[] = [];
  let lastKept: { start: number; end: number } | null = null;
  for (const s of spans) {
    const sentence = text.slice(s.start, s.end);
    const repeat = repeatsPrevious(sentence, said) || reasksQuestion(sentence, asked);
    if (!repeat || isProtectedLine(sentence, options.keepReferrals === true)) {
      lastKept = s;
      continue;
    }
    // "Ask them:" announced this sentence: with it gone, the announcement goes too.
    if (lastKept !== null && /:[*_\s]*$/.test(text.slice(lastKept.start, lastKept.end))) {
      repeated.push(lastKept);
      lastKept = null;
    }
    repeated.push(s);
    removed.push(sentence.trim());
  }
  if (repeated.length === 0) return { text, dropped: 0, removed: [] };
  return { ...tidied(text, repeated, removed.length), removed };
}

/**
 * `text` without `units` (text the sentence gate left out of it, in order), tidied as {@link withoutRepeats} tidies: a
 * streamed reply's stored answer is then exactly what the gate released, unit by unit, never re-judged sentence by
 * sentence after it was shown or said.
 */
export function withoutUnits(text: string, units: readonly string[]): string {
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  for (const unit of units) {
    const needle = unit.trim();
    if (needle === '') continue;
    const at = text.indexOf(needle, from);
    if (at < 0) continue;
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return spans.length === 0 ? text : tidied(text, spans, spans.length).text;
}

/** `text` without `spans`, tidied (no empty list markers or runs of blank lines). */
function tidied(
  text: string,
  spans: readonly { readonly start: number; readonly end: number }[],
  dropped: number,
): { readonly text: string; readonly dropped: number } {
  let out = '';
  let from = 0;
  for (const span of spans) {
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
  return { text: tidy, dropped };
}

const COUNT_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

/**
 * A reply that announces a count of steps and gives fewer ("three steps:" then two items), or a numbered list that
 * skips a number (a plan without its first step): the count it announced and the items it gave, or null when it is
 * whole. Live pilot 42099643194: holes of this kind in 41 replies of 21 runs.
 */
export function announcedCountGap(
  text: string,
): { readonly announced: number; readonly given: number } | null {
  const numbered = [...text.matchAll(/^\s*(\d{1,2})[.)]\s+\S/gm)].map((m) => Number(m[1]));
  if (numbered.length > 0) {
    // One list counts up from 1; a reply with two lists restarts at 1.
    let want = 1;
    for (const n of numbered) {
      if (n === 1) want = 1;
      if (n !== want) return { announced: Math.max(...numbered), given: numbered.length };
      want += 1;
    }
  }
  const announce =
    /\b(two|three|four|five|six|seven|[2-7]) (?:quick |key |simple |concrete |small |next |practical )?(?:steps|things|questions|options|moves|ways|ideas|actions|points|checks|tips)\b[^.?!\n]*[:.]/i.exec(
      text,
    );
  if (announce === null) return null;
  const word = (announce[1] ?? '').toLowerCase();
  const announced = COUNT_WORDS[word] ?? Number(word);
  const after = text.slice(announce.index + announce[0].length);
  const items = after.match(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/gm)?.length ?? 0;
  if (items === 0) return null;
  return items < announced ? { announced, given: items } : null;
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
