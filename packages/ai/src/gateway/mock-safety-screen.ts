import { foldDiacritics, normalizeForMatching } from '../risk/normalize.js';
import type { SafetyScreenVerdict } from '../risk/safety-screen.js';

/**
 * The mock gateway's safety screen: a small deterministic rule standing in for the model, so the turn pipeline's
 * screen runs offline (unit and DB tests, the Playwright e2e suite, the dev server and the lab's dry run all use the
 * mock model).
 *
 * It is deliberately narrow. Everything the ideation prefilter flags reaches it, and most of that is ordinary talk:
 * sign-offs ("goodbye", "ok let's end it there", "i think i'm done"), scheduling ("I'm not going to be around on
 * Friday"), venture frustration ("I can't take any more meetings this week"), idiom ("the deal will be dead"). A mock
 * that called those a crisis would put the crisis message into every local demo that says goodbye. So it answers
 * crisis only for a short list of unmistakable first-person phrasings of indirect ideation, wellbeing only for a bare
 * "I can't do this anymore", and clear for everything else. It is no measure of the real screen: that is
 * apps/api/src/scripts/lab-safety-screen.ts on Bedrock.
 */

/** A phrase may close its sentence with a few of these words ("ending it like for real", "anymore honestly"). */
const TAIL =
  '(?: (?:anymore|any more|any longer|honestly|really|seriously|tbh|now|lately|like|for real|all the time|every day|a lot|again|tonight|tomorrow))*';

/** "if I wasn't here", "if I was gone", "if I disappeared". */
const IF_GONE =
  'if (?:i|im) (?:wasnt (?:here|around)|werent (?:here|around)|was not (?:here|around)|was gone|were gone|disappeared|died|was dead)';
/** Unless the whole message is ordinary talk, a crisis wherever one of these closes a sentence of it. */
const CRISIS_ANYWHERE = [
  // "nobody would even notice if I wasn't here", "no one would miss me".
  `\\b(?:nobody|no one|noone|everyone)(?: would| will|d)?(?: even| really| ever| just)? (?:notice|care|miss me|be fine|be better)(?: \\w+){0,2} ${IF_GONE}${TAIL}$`,
  `\\b(?:nobody|no one|noone)(?: would| will|d)?(?: even| really| ever)? miss me${TAIL}$`,
  `\\bbetter off (?:without me|dead|${IF_GONE})${TAIL}$`,
  `\\b(?:dont|do not|no longer) (?:want|wanna)(?: to)? (?:be alive|exist|live)${TAIL}$`,
  `\\bend(?:ing)? (?:it all|my life|my own life)${TAIL}$`,
  `\\b(?:no reason to (?:live|go on|be here|keep going)|nothing (?:left )?to live for)${TAIL}$`,
  `\\bwhats (?:even )?the point of (?:living|me|my life|being alive|going on|being here)${TAIL}$`,
  `\\b(?:hurt|harm|cut) myself${TAIL}$`,
  `\\b(?:took|swallowed) (?:a bottle of|all (?:of )?(?:my|the)|a handful of) (?:pills|meds|tablets)${TAIL}$`,
].map((source) => new RegExp(source, 'u'));

/**
 * Phrases ordinary talk shares ("ending it", "not be around", "my last message", "never wake up", "disappear"): a
 * crisis only when one of them is the whole message, with nothing that says what is ended or why ("I'm thinking about
 * ending it." is; "18 months and no traction. I'm thinking about ending it.", "I won't be around much longer, the
 * library closes at 10" and "This is my last message, out of credits." are not).
 */
const CRISIS_ALONE = [
  `^(?:[\\p{L}\\p{N}]+ ){0,6}(?:think|thinks|thinking|thought) (?:about|of) ending (?:it|everything)${TAIL}$`,
  `^(?:[\\p{L}\\p{N}]+ ){0,3}(?:wont|will not|not going to|not gonna) be (?:here|around) (?:much longer|for much longer|for long)${TAIL}$`,
  `^(?:[\\p{L}\\p{N}]+ ){0,3}(?:dont|do not|no longer) (?:want|wanna)(?: to)? (?:be here|be around|wake up)${TAIL}$`,
  `^(?:[\\p{L}\\p{N}]+ ){0,8}(?:never|not|dont) wake up(?: again)?${TAIL}$`,
  `^(?:[\\p{L}\\p{N}]+ ){0,3}(?:want|wanna|wish i could)(?: to)? (?:just )?(?:disappear|vanish)(?: forever| for good)?${TAIL}$`,
  `^this is my (?:last|final) message${TAIL}$`,
  `^(?:(?:so|ok|okay|well|and) )?goodbye forever$`,
].map((source) => new RegExp(source, 'u'));

/** A bare "I can't do this anymore" (the whole message, fillers aside): the mock's wellbeing case. */
const BARE_STRAIN = new RegExp(
  `^(?:(?:honestly|really|man|god|i think|i just|just|tbh|ok|okay|look|so|yeah|i mean|i swear) )*` +
    `(?:(?:i|im) )?(?:just |really |honestly )?` +
    `(?:(?:cant|cannot|can not) (?:do (?:this|it|any of this)|take (?:it|this|any more|anymore)|cope|keep going|handle (?:it|this))|(?:am |m )?at my breaking point|(?:am |m )?at the end of my rope)` +
    `${TAIL}$`,
  'u',
);

/**
 * Words that make a message ordinary talk for the mock, whatever else it says: a venture, study, schedule or everyday
 * referent, someone else's words (a quote, an example, a product that detects such phrases), a sign-off, a laugh.
 */
const ORDINARY =
  /\b(?:startup|company|pilot|deck|app|product|project|venture|launch|meeting|meetings|call|vendor|supplier|contract|agency|class|lecture|exam|study|patients|doctor|spreadsheet|build|investor|investors|customer|customers|beta|demo|team|pricing|sales|feature|bug|market|today|for now|thanks|thank you|lol|lmao|jk|haha|ugh|conference|trip|moving|vacation|holiday|flight|office|model|classifier|screener|example|phrases|quote|song|told me|told us|my friend)\b/u;
const LAUGH = /[\u{1F602}\u{1F923}\u{1F605}\u{1F606}\u{1F61C}\u{1F61D}\u{1F643}]/u;

/** Apostrophes removed, every other run of non-letters a single space (the text is already lower case). */
function flatten(text: string): string {
  return text
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The message's sentences, each flattened (split at `.`, `!`, `?`, `;`, `…`, `,` and line breaks). */
function sentencesOf(lower: string): string[] {
  return lower
    .split(/[.!?;…,\n]+/u)
    .map(flatten)
    .filter((s) => s !== '');
}

/** The mock screen's verdict on a founder message (see the module comment). */
export function mockSafetyScreenVerdict(founderText: string): SafetyScreenVerdict {
  const lower = foldDiacritics(normalizeForMatching(founderText));
  const whole = flatten(lower);
  if (ORDINARY.test(whole) || LAUGH.test(founderText)) {
    return { reason: 'Ordinary talk (mock rule).', crisis: false, wellbeing: false };
  }
  const sentences = sentencesOf(lower);
  if (
    sentences.some((sentence) => CRISIS_ANYWHERE.some((pattern) => pattern.test(sentence))) ||
    (sentences.length === 1 && CRISIS_ALONE.some((pattern) => pattern.test(whole)))
  ) {
    return { reason: 'Indirect ideation about the founder (mock rule).', crisis: true, wellbeing: false };
  }
  if (BARE_STRAIN.test(whole)) {
    return {
      reason: 'Personal strain without signs of self-harm (mock rule).',
      crisis: false,
      wellbeing: true,
    };
  }
  return { reason: 'Ordinary talk (mock rule).', crisis: false, wellbeing: false };
}
