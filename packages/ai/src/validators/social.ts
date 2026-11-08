import {
  asksToRepeat,
  contentWords,
  founderMoves,
  hasNoAnswerOnly,
  lastQuestionOf,
  socialTurnOf,
  NARROW_SUBJECT_NAMES,
  subjectOf,
  SUPPORT_CHECK_IN,
  wrapUpOf,
  type SocialTurn,
} from '../prompts/conversation-state.js';
import { sentenceSpans } from './meta-narration.js';

/** Read in prompts/conversation-state.ts (the phrasing ledger reads it too); the validators' own since diff3-A3. */
export { asksToRepeat };

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

/**
 * Words a sign-off may open on before it signs off ("Okay, you're set.", "Now go get those answers.", "That's it,
 * you're set."): at most two of them, read off before the sign-off is matched.
 */
const SIGN_OFF_LEAD_IN =
  /^(?:(?:okay|ok|alright|all right|so|now|right|well|great|perfect|then|and then|and|that's it|that's all)\s+){1,2}/u;

/**
 * Words a sign-off carries beyond its opening and still only signs off ("Good luck with the dean tomorrow", "Let me
 * know how it goes", "Come back and tell me how it went"): never what makes a sentence advice.
 */
const SIGN_OFF_FILLER = new Set(
  (
    'it its them those these that this there here the a an with on at for in to and of me you your yours us out ' +
    'answers answer goes go get went going how happen make do tell let know talk soon again later tomorrow today ' +
    'tonight week weekend meeting call chat conversation interview interviews pitch next time then luck really just ' +
    'all set'
  ).split(' '),
);

/** Most words a sign-off carries after its opening, and most of them that are not {@link SIGN_OFF_FILLER}. */
const SIGN_OFF_MAX_REST = 6;
const SIGN_OFF_MAX_CONTENT = 1;

/**
 * The kind of sign-off a sentence is ("you're set", "go get"), or null for any other sentence. Only a sentence that
 * says nothing beyond its sign-off is one: "Go get the signed letter from facilities before Friday" opens like "Go get
 * those answers!" and is the help itself (a review of B2: it was left out as a repeated sign-off, and never written
 * again). A name ("Good luck, Amara.") is not content.
 */
function signOffKind(sentence: string): string | null {
  const names = new Set(
    [...sentence.replace(/[‘’ʼ]/g, "'").matchAll(/(?<=\S\s+)\p{Lu}[\p{L}'-]*/gu)].map((m) =>
      m[0].toLowerCase().replace(/'s$/u, ''),
    ),
  );
  const words = repeatWords(sentence).join(' ');
  let text = words;
  let m = SIGN_OFF.exec(text);
  if (m === null) {
    text = words.replace(SIGN_OFF_LEAD_IN, '');
    m = SIGN_OFF.exec(text);
  }
  if (m === null) return null;
  const rest = text
    .slice(m[0].length)
    .split(' ')
    .filter((w) => w !== '' && !names.has(w.replace(/'s$/u, '')));
  if (rest.length > SIGN_OFF_MAX_REST) return null;
  if (rest.filter((w) => !SIGN_OFF_FILLER.has(w)).length > SIGN_OFF_MAX_CONTENT) return null;
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

/**
 * Whether the founder's message is social (a goodbye, thanks, a hello) or wraps up: a sign-off is then a fitting reply,
 * never left out for its kind alone. Review of B2: "Okay thanks, talk soon!" after an earlier "Good luck with the dean"
 * was answered "We covered that a moment ago. Which part should we take further?".
 */
export function welcomesSignOff(founderText: string | undefined): boolean {
  if (founderText === undefined || founderText.trim() === '') return false;
  return socialTurnOf(founderText) !== null || wrapUpOf(founderText);
}

/** Whether the founder says goodbye or wraps up: a reply then never ends on a new question. */
export function wrapsUp(founderText: string | undefined): boolean {
  if (founderText === undefined || founderText.trim() === '') return false;
  return socialTurnOf(founderText) === 'closing' || wrapUpOf(founderText);
}

/**
 * What a reply says in place of one whose every sentence was left out as said before (`removed`): null when all of
 * them only signed off (the sign-off stands: a reply that only closes is never swapped for a stock line), the wrap-up
 * line when the founder wraps up ({@link wrapsUp}, {@link CLOSING_FALLBACK}), else {@link REPEAT_FALLBACK}.
 */
export function repeatFallbackFor(removed: readonly string[], closing: boolean): string | null {
  if (removed.length > 0 && removed.every(signsOff)) return null;
  return closing ? CLOSING_FALLBACK : REPEAT_FALLBACK;
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
 * phrasing ledger names such phrases back to the model so it does not say them (prompts/phrasing.ts). `signOffs: false`
 * (a reply to a goodbye, thanks or a hello: a sign-off is what it says) compares a sign-off as any other sentence.
 */
export function repeatsPrevious(
  sentence: string,
  previous: ReadonlySet<string>,
  options: { readonly signOffs?: boolean } = {},
): boolean {
  if (previous.size === 0) return false;
  const kind = options.signOffs === false ? null : signOffKind(sentence);
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
 * A question's terms: its content words, each cut to a root ("reimbursement" and "reimbursable" meet) or to the subject
 * it names ("classification" and "class", "billing code" and "pay": prompts/conversation-state.ts `subjectOf`), and the
 * pairs of them it says one after another ("device class"). `settled`: asked before the previous reply, so the founder has had their turn to
 * answer it; a question back on its subject is read strictly ({@link ReaskOptions}).
 */
export interface QuestionTerms {
  readonly words: ReadonlySet<string>;
  readonly pairs: ReadonlySet<string>;
  readonly settled?: boolean;
}

/** Endings a root leaves out, beyond the stem `contentWords` already cut (only while four letters or more remain). */
const ROOT_ENDING = /(?:ments?|abl|ibl|ation|ition|ity|ive|ical|al)$/;

/**
 * A question that offers the vEIR's own work ("Want me to draft the questions for your advisor?"): what a reply after a
 * no-answer should end on, never a re-ask of the question left unanswered, whatever subject it shares.
 */
const OFFERS_WORK =
  /^[\s*_"“]*(?:(?:so|and|or|then)[,\s]+)?(?:(?:do you )?want me to|would you like me to|shall i|should i|can i|could i|would it help (?:if i|for me to)|how about i|i can\b.*\bif you (?:like|want))\b/i;

function questionTerms(sentence: string, settled = false): QuestionTerms {
  const words = [...contentWords(sentence)].map((word) => {
    const subject = subjectOf(word);
    if (subject !== null) return subject;
    const root = word.replace(ROOT_ENDING, '');
    const cut = root.length >= 4 ? root : word;
    return cut.length > 3 && cut.endsWith('e') ? cut.slice(0, -1) : cut;
  });
  const pairs = new Set<string>();
  for (let i = 1; i < words.length; i += 1) pairs.add(`${words[i - 1] ?? ''} ${words[i] ?? ''}`);
  return { words: new Set(words), pairs, ...(settled ? { settled } : {}) };
}

/**
 * The questions of a text (its sentences that end in a question mark), as their terms: the questions a previous reply
 * asked, which the next reply never asks again in other words (item 20: "do you have a written agreement on what success
 * looks like…?" was asked two turns running, the second time in reply to the founder's SSO worry). `settled`, see
 * {@link QuestionTerms}.
 */
export function questionsOf(text: string, settled = false): QuestionTerms[] {
  return sentenceSpans(text)
    .map((s) => text.slice(s.start, s.end))
    .filter((sentence) => /\?["'”’)\]*_]*$/.test(sentence))
    .map((sentence) => questionTerms(sentence, settled))
    .filter((terms) => terms.words.size >= 2);
}

/**
 * The questions the vEIR asked before this reply: the previous reply's, and those of the replies before it as
 * `settled` (production, 2026-11-07: the first reply's question came back in the third, after a vague answer and a
 * short one, neither of which said they did not know).
 */
export function askedBefore(
  previousReply: string | null | undefined,
  earlierReplies: readonly (string | null | undefined)[] = [],
): QuestionTerms[] {
  return [
    ...(typeof previousReply === 'string' ? questionsOf(previousReply) : []),
    ...earlierReplies.flatMap((text) => (typeof text === 'string' ? questionsOf(text, true) : [])),
  ];
}

export interface ReaskOptions {
  /**
   * The founder just said they do not know, have not done it, or handed the work back (`stuckOn`): any question that
   * comes back to a subject of one they were asked (the device class, how clinics pay, the advisor, the regulatory path:
   * prompts/conversation-state.ts `subjectOf`) is asked again however it is worded, even sharing that one term ("So
   * what did your advisor actually say?"), unless it offers the vEIR's own work ({@link OFFERS_WORK}); else three shared
   * terms, or two in a pair or 40% of them.
   */
  readonly strict?: boolean;
  /**
   * False for a question the reply gives the founder to put to someone else ({@link putToFounder}: a quoted draft, a
   * list of questions for their advisor): only one that comes back whole (three shared terms) is a re-ask; the strict
   * and settled readings are for questions put to the founder. Default true.
   */
  readonly toFounder?: boolean;
}

/**
 * How a question asks again one of `asked` ({@link reaskOf}): `whole`, it comes back whole (three shared terms or more,
 * most of its own or with a pair said together), left out wherever it stands; `subject`, only by the strict or settled
 * reading (one subject or two terms back, see {@link ReaskOptions}), left out only as the reply's trailing hand-back
 * ({@link handBackStart}).
 */
export type ReaskReading = 'whole' | 'subject';

/**
 * Whether `sentence` asks again one of `asked` (see {@link questionsOf}) in other words, and how ({@link ReaskReading}):
 * a question that shares three terms or more with it and most of its own (60%, or of the shorter one); or three or more
 * and 30%, two of them said together in both (production, 2026-11-07: a question about what the advisor said of the
 * device class and how clinics would pay came back two replies later, longer and reworded, about the advisor, the device
 * class and reimbursable monitoring time): `whole`. `strict`, or a `settled` question, see {@link ReaskOptions}:
 * `subject`. Null when it asks something new.
 */
export function reaskOf(
  sentence: string,
  asked: readonly QuestionTerms[],
  options: ReaskOptions = {},
): ReaskReading | null {
  if (asked.length === 0 || !/\?["'”’)\]*_]*\s*$/.test(sentence)) return null;
  const terms = questionTerms(sentence);
  const comesBackWhole = asked.some((question) => {
    let shared = 0;
    for (const w of terms.words) if (question.words.has(w)) shared += 1;
    const share = shared / Math.min(terms.words.size, question.words.size);
    const pair = [...terms.pairs].some((p) => question.pairs.has(p));
    return shared >= 3 && (share >= 0.6 || (share >= 0.3 && pair));
  });
  if (comesBackWhole) return 'whole';
  // A question for someone else is a re-ask only when it comes back whole.
  if (options.toFounder === false) return null;
  const strict = options.strict === true;
  const subjects = [...terms.words].filter((w) => NARROW_SUBJECT_NAMES.has(w));
  if (
    strict &&
    subjects.length > 0 &&
    !OFFERS_WORK.test(sentence) &&
    asked.some((question) => subjects.some((subject) => question.words.has(subject)))
  )
    return 'subject';
  if (terms.words.size < (strict || asked.some((question) => question.settled === true) ? 2 : 3)) return null;
  const again = asked.some((question) => {
    let shared = 0;
    for (const w of terms.words) if (question.words.has(w)) shared += 1;
    const share = shared / Math.min(terms.words.size, question.words.size);
    const pair = [...terms.pairs].some((p) => question.pairs.has(p));
    if (strict) return shared >= 3 || (shared >= 2 && (pair || share >= 0.4));
    // A settled question comes back whole, or as two of its terms (a pair said again, or two subjects) with little
    // else: "Did the advisor mention the class at all?" asks it again, while "What does your customer pay today?"
    // leaves "Would that customer pay more for the version with alerts?" a new question.
    const sharedSubjects = subjects.filter((subject) => question.words.has(subject)).length;
    return (
      question.settled === true &&
      (shared >= 3 || (shared >= 2 && share >= 0.6 && (pair || sharedSubjects >= 2)))
    );
  });
  return again ? 'subject' : null;
}

/** Whether `sentence` asks one of `asked` again in other words, by any reading ({@link reaskOf}). */
export function reasksQuestion(
  sentence: string,
  asked: readonly QuestionTerms[],
  options: ReaskOptions = {},
): boolean {
  return reaskOf(sentence, asked, options) !== null;
}

/**
 * A lead-in that hands the founder questions to put to someone else ("Ask your advisor:", "Here are three questions to
 * send:", "You could send something like:").
 */
const PREP_LEAD_IN =
  /\b(?:ask(?:ing)? (?:them|him|her|your|the|whoever|each|someone|an?)\b|(?:send|email|write|message|text) (?:them|him|her|your|the|an?|something)\b|questions? (?:to (?:send|ask|bring|raise|put)|you (?:could|can|might|should) (?:send|ask|bring|raise|put)|worth (?:asking|sending|raising)|for (?:them|him|her|your|the|dr)\b)|something like|(?:could|can|might) (?:say|ask|send|write|open with|lead with)|(?:a|the|this) (?:draft|template|script|note|email|message)\b)[^:]*:[*_\s]*$/i;

/** A lead-in that puts what follows to the founder themselves ("Two questions for you:", "Ask yourself:"). */
const FOUNDER_LEAD_IN = /\b(?:for you|yourself|ask you|(?:i'd|i would) (?:like|love) to know|tell me)\b/i;

/** A line said by someone in a role-play ("**Investor:** …", "Dr Lee: …"), never "Walk me through the path: …". */
const ROLE_SPEAKER =
  /^\s*(?:(?:\*\*|__)[^*_\n]{1,40}:(?:\*\*|__)|\p{Lu}[\p{L}'.-]*(?: \p{Lu}[\p{L}'.-]*){0,2}:)\s/u;

/** A list marker alone ("1.", "-"), as sentences split it from its item. */
const BARE_LIST_MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s*$/;
/** Text that ends on a list marker: what follows is that item's text. */
const BARE_LIST_MARKER_END = /(?:^|\n)\s*(?:[-*+•]|\d{1,3}[.)])\s*$/;

/** Whether a double quotation is still open at the end of `text` (a straight quote toggles, curly ones open and close). */
function quoteOpenAt(text: string): boolean {
  let open = false;
  for (const ch of text) {
    if (ch === '"') open = !open;
    else if (ch === '\u201C') open = true;
    else if (ch === '\u201D') open = false;
  }
  return open;
}

/** The lead-in a sentence ends on or opens with: its text up to its last colon, or null. */
function leadInOf(sentence: string): string | null {
  const ask = sentence.lastIndexOf('?');
  const head = ask < 0 ? sentence : sentence.slice(0, ask);
  const colon = head.lastIndexOf(':');
  return colon < 0 ? null : head.slice(0, colon + 1);
}

/**
 * Whether the question `sentence` (what the reply says after `before`) is put to the founder, rather than given to
 * them to put to someone else: one inside an open quotation (a draft email), a line in character, a list item under a
 * lead-in ending in ":", or a question after a lead-in such as "Ask your advisor:" or "questions to send:" (and the
 * questions and list items that follow it). Review of the 2026-11-07 fix: after "i dont know", the strict re-ask
 * reading took the questions out of a drafted email, leaving its quote open and its body gone.
 */
export function putToFounder(before: string, sentence: string): boolean {
  const ask = sentence.lastIndexOf('?');
  if (quoteOpenAt(before + (ask < 0 ? sentence : sentence.slice(0, ask)))) return false;
  if (ROLE_SPEAKER.test(sentence)) return false;
  // Sentences split a list item's marker from its text ("1." then "Do you see…?").
  const listItem = isListItem(sentence) || BARE_LIST_MARKER_END.test(before);
  const earlier = sentenceSpans(before)
    .map((s) => before.slice(s.start, s.end).trim())
    .filter((s) => s !== '');
  for (const s of [sentence.trim(), ...earlier.reverse()]) {
    const lead = leadInOf(s);
    if (lead !== null) {
      if (FOUNDER_LEAD_IN.test(lead)) return true;
      if (PREP_LEAD_IN.test(lead)) return false;
      if (s !== sentence.trim()) return !listItem;
      // A list item's own label ("1. **Class:** …?") leads into nothing: the lead-in is above it.
      if (!listItem) return true;
      continue;
    }
    // A run of questions or list items goes on under the lead-in that opened it.
    if (s !== sentence.trim() && !/\?["'”’)\]*_]*$/.test(s) && !isListItem(s) && !BARE_LIST_MARKER.test(s))
      break;
  }
  return true;
}

/**
 * Words that prepare something for the founder to say or send to someone else ("Here is a draft:", "something like",
 * "ask him", "questions to send", "you could write"): a question anywhere after them may be part of what they send, so
 * it is never read as a hand-back to the founder ({@link handBackCandidate}).
 */
const PREP_CUE =
  /\b(?:here(?:'s| is| are) (?:a |an |the |my |your |some |two |three )?(?:(?:quick|short|rough|first) )?(?:draft|template|script|version|email|message|note|text|questions?)\b|draft\b[^.?!\n]{0,40}:|something like|ask (?:him|her|them|whoever|each of them)\b|questions? (?:to (?:send|ask|bring|raise|put)|you (?:could|can|might) (?:send|ask|bring|raise|put)|worth (?:asking|sending|raising)|for (?:him|her|them|your|the)\b)|you (?:could|can|might) (?:write|say|send|ask|open with|lead with|text|email)|(?:send|email|text|message|write to) (?:him|her|them)\b)/i;

/** A question sentence ("…?", with closing quotes or emphasis after it). */
const QUESTION_SENTENCE = /\?["'”’)\]*_]*\s*$/;

/**
 * Whether the question `sentence` (what the reply says after `before`) may be part of the reply's trailing hand-back:
 * put to the founder ({@link putToFounder}: not in a quotation, not a line in character, not under "Ask your advisor:"),
 * and besides not a list item, not a blockquote line ("> …"), not under or after a lead-in ending in ":", and with no
 * prep cue before it or in it ({@link PREP_CUE}: "Here is a draft:", "something like", "ask him", "questions to send",
 * "you could write"). Review of the 2026-11-07 fix: deleting a question anywhere in the reply garbled drafts the vEIR
 * wrote for the founder to send (unquoted paragraphs, blockquotes, lists); only a question at the very end, put to the
 * founder, is ever left out by the strict or settled re-ask reading.
 */
export function handBackCandidate(before: string, sentence: string): boolean {
  if (!QUESTION_SENTENCE.test(sentence)) return false;
  if (!putToFounder(before, sentence)) return false;
  if (isListItem(sentence) || BARE_LIST_MARKER_END.test(before)) return false;
  const line = before.slice(before.lastIndexOf('\n') + 1) + sentence.replace(/^\s*\n/, '');
  if (/^\s*>/.test(line) || /(?:^|\n)\s*>/.test(sentence)) return false;
  if (leadInOf(sentence) !== null) return false;
  if (/:[*_\s]*$/.test(before)) return false;
  return !PREP_CUE.test(before + sentence);
}

/**
 * Where the reply's trailing hand-back starts: the run of question sentences at its very end, each one a
 * {@link handBackCandidate} ("That is normal. Most insoles sit in a low class. So what did your advisor say?"), or
 * `text.length` when it ends on anything else. A question followed by anything but another question is never in it.
 */
export function handBackStart(text: string): number {
  const spans = sentenceSpans(text);
  let start = text.length;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (span === undefined) break;
    const sentence = text.slice(span.start, span.end);
    if (sentence.trim() === '') continue;
    if (!handBackCandidate(text.slice(0, span.start), sentence)) break;
    start = span.start;
  }
  return start;
}

/**
 * Whether the founder's message says they do not know, have not done it or have no answer yet, or hands the work back
 * ("you tell me"): a question of the vEIR's that comes back to the same subject is then read strictly
 * ({@link ReaskOptions}). After `previousReply` asked something, a no-answer is read by its shape too, however it is
 * worded ("he hasnt gotten back to me", "i wasnt able to": prompts/conversation-state.ts `hasNoAnswerOnly`); a message
 * that carries an answer of its own besides ("not yet, we have a call friday") is none. Never after `previousReply`
 * checked on the founder themselves (prompts/conversation-state.ts `SUPPORT_CHECK_IN`): asking after them again is care,
 * not a re-ask.
 */
export function stuckOn(founderText: string | undefined, previousReply?: string | null): boolean {
  if (founderText === undefined || founderText.trim() === '') return false;
  const asked = typeof previousReply === 'string' ? lastQuestionOf(previousReply) : null;
  if (asked !== null && SUPPORT_CHECK_IN.test(asked)) return false;
  const context = { afterQuestion: asked !== null };
  return founderMoves(founderText, context).includes('help') || hasNoAnswerOnly(founderText, context);
}

/** A line in character in a role-play ("**Investor:** …", a quoted line): its question is the counterpart's. */
const IN_ROLE_LINE = /^\s*(?:\*\*|__)?\p{Lu}[\p{L}'.-]*(?: [\p{L}'.-]+){0,4}:(?:\*\*|__)?\s|^\s*["“]/u;

/**
 * An acknowledgement that leads a sentence into a restatement of what the founder said ("Okay, so department heads need
 * to approve it.", "That's something—so there's a process."): what follows it only says their words back.
 */
const RESTATING_LEAD =
  /^(?:(?:ok(?:ay)?|got it|right|sure|i see|alright|makes sense|fair enough|understood|that's (?:something|fair|good|helpful|useful|great|interesting|a start|real progress))\b[\s,.!:;—–-]*)+(?:so\b[\s,]*)?|^so\b[\s,]*/i;

/**
 * Whether a reply only asks: it has a question and no statement of eight words or more beyond an acknowledgement that
 * restates the founder ({@link RESTATING_LEAD}), nor a list (a line in character in a role-play is the counterpart's,
 * never counted). Production, 2026-11-07: three call replies in a row were a question each and taught nothing, two of
 * them after a lead-in that only said the founder's answer back. The lab reads the same (ops/lab live/checks.py
 * `question_only`).
 */
export function asksOnly(text: string): boolean {
  if (!text.includes('?') || IN_ROLE_LINE.test(text)) return false;
  const sentences = sentenceSpans(text).map((s) => text.slice(s.start, s.end).trim());
  if (sentences.filter((s) => isListItem(s)).length >= 2) return false;
  return !sentences.some(
    (s) =>
      s !== '' &&
      !/\?["'”’)\]*_]*$/.test(s) &&
      s
        .replace(/[‘’ʼ]/g, "'")
        .replace(RESTATING_LEAD, '')
        .split(/\s+/)
        .filter((word) => word !== '').length >= 8,
  );
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

/**
 * Whether `sentence` is a safety line ({@link SAFETY_LINE}) or a check-in on the founder themselves ("Is there someone
 * close to you you can talk to today?": prompts/conversation-state.ts `SUPPORT_CHECK_IN`), or a referral when
 * `keepReferrals` ({@link REFERRAL_LINE}).
 */
export function isProtectedLine(sentence: string, keepReferrals = false): boolean {
  return (
    SAFETY_LINE.test(sentence) ||
    SUPPORT_CHECK_IN.test(sentence) ||
    (keepReferrals && REFERRAL_LINE.test(sentence))
  );
}

export interface WithoutRepeatsOptions {
  /** The turn is flagged for a consequential matter: a referral sentence is never left out ({@link REFERRAL_LINE}). */
  readonly keepReferrals?: boolean;
  /**
   * False on a social turn (a goodbye, thanks, a hello) or a wrap-up: a sign-off is the reply there, so it is never
   * left out for its kind alone ({@link repeatsPrevious}). Default true.
   */
  readonly signOffs?: boolean;
  /** Questions are read strictly ({@link ReaskOptions}): the founder said they do not know ({@link stuckOn}). */
  readonly strictQuestions?: boolean;
  /**
   * The questions `previous` asked, when the caller knows which reply asked each ({@link askedBefore}: those before the
   * previous reply are settled). Default: every question of `previous`, none settled.
   */
  readonly asked?: readonly QuestionTerms[];
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
  const asked = options.asked ?? questionsOf(previous);
  const spans = sentenceSpans(text);
  // A question asked again only by the strict or settled reading goes only from the reply's trailing hand-back.
  const handBack = handBackStart(text);
  const repeated: { start: number; end: number }[] = [];
  const removed: string[] = [];
  let lastKept: { start: number; end: number } | null = null;
  for (const s of spans) {
    const sentence = text.slice(s.start, s.end);
    const reask = reaskOf(sentence, asked, {
      strict: options.strictQuestions === true,
      toFounder: putToFounder(text.slice(0, s.start), sentence),
    });
    const repeat =
      repeatsPrevious(sentence, said, { signOffs: options.signOffs !== false }) ||
      reask === 'whole' ||
      (reask === 'subject' && s.start >= handBack);
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
