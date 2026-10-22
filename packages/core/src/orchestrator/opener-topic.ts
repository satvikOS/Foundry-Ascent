import { contentTokens, founderMoves, isEverydayWord, tidyFounderWords } from '@foundry/ai';

/**
 * What an opening line says the last conversation was about, and how it speaks of the founder.
 *
 * LAB-R3 (lab run 39080360013): openers quoted the founder's last line back, even when it was a recall or meta
 * question ('the last thing you asked was "Hey, do you remember what we talked about last time?" Want to pick that
 * up?'). So a line is only a subject when it names something to talk about ({@link isTopicLine}: not a greeting,
 * a check, a recall or memory question, a question about the vEIR itself, thanks or a wrap-up), and the topic is
 * summarised, never quoted ({@link topicOf}): "whether to price per library or per seat", "how to price the
 * pilot", "your plan to call facilities", "the Hartwell pilot".
 *
 * LAB-U2: a chat opener named the founder in the third person, in lower case ("Shall we pick up the facility budget
 * numbers maya will get…"): the distilled thread, written about the founder, was pasted as it stood. Every
 * distilled line an opener uses is addressed to the founder first ({@link addressFounder}): their name or "the
 * founder" becomes "you"/"your", other people's names get their real case back, and a line that still speaks of
 * the founder in the third person is dropped.
 *
 * Wave 7 (the w6 integrator's list): openers echoed the founder's own chat shorthand and lower case ("…at the bus
 * station this week fr", "…call facilities monday"). What an opener says of them is tidied the way it would be
 * written (`tidyFounderWords`: slang dropped, shorthand spelt out, days and months capitalised).
 */

/** The people an opener may speak of: the founder (said as "you") and their team (names in their real case). */
export interface OpenerPeople {
  /** The founder's display name ("Maya Patel"); null when unknown. */
  readonly founder: string | null;
  /** Display names of the venture's people (the founder among them is ignored). */
  readonly team?: readonly string[];
  /**
   * Proper nouns the conversation wrote with their capitals (the vEIR's own replies, its digest:
   * {@link properNounsIn}): what the founder typed in lower case gets that case back ("harbour hall" → "Harbour Hall").
   */
  readonly names?: readonly string[];
}

/**
 * The proper nouns in `texts` (written by the vEIR, so in their real case): one to three capitalised words in a row
 * that do not open a sentence, at least one of them no everyday word ("Harbour Hall", "Hartwell", "QuietQuad").
 */
export function properNounsIn(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(
      /(?<=[\p{Ll}\p{N},;:'’)] )\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*){0,2}/gu,
    )) {
      const phrase = m[0].replace(/['’]s$/, '');
      const words = phrase.split(' ');
      if (words.some((w) => !isEverydayWord(w)) && phrase.length >= 3) found.add(phrase);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Third-person verbs said after the founder's name, as they read after "you". */
const AGREEMENT: Readonly<Record<string, string>> = {
  is: 'are',
  was: 'were',
  has: 'have',
  does: 'do',
  "isn't": "aren't",
  "wasn't": "weren't",
  "hasn't": "haven't",
  "doesn't": "don't",
  says: 'say',
  goes: 'go',
  tries: 'try',
};
/** Regular verbs in the third person singular a distilled note uses after the founder's name. */
const S_VERBS = new Set(
  (
    'plans wants needs gets hopes thinks expects intends knows likes prefers asks owes runs leads owns handles ' +
    'sends calls meets talks works feels seems believes keeps makes takes gives checks reviews builds writes shares ' +
    'agrees decides promises mentions follows tests sets starts finishes reaches books emails visits pitches ' +
    'chases drafts prepares ends begins launches closes opens loves hates'
  ).split(' '),
);
const THIRD_PERSON = /\b(?:she|he|her|hers|him|his|herself|himself)\b/i;

/**
 * `text` (a distilled line: the notebook's next topic or opener, a digest topic) addressed to the founder: their
 * name, or "the founder", becomes "you" or "your" (and the verb after it agrees: "maya will get" → "you will get",
 * "Maya plans" → "You plan", "the founder's pilot" → "your pilot"); other people's names get their real case
 * back ("noor" → "Noor"). Null when the line still speaks of the founder in the third person (he, she, her…), so it
 * is dropped rather than said.
 */
export function addressFounder(text: string, people: OpenerPeople): string | null {
  const founderNames = new Set<string>(['the founder']);
  if (people.founder !== null && people.founder.trim() !== '') {
    const full = people.founder.normalize('NFKC').trim().replace(/\s+/g, ' ');
    founderNames.add(full);
    const first = full.split(' ')[0];
    if (first !== undefined && first.length >= 2) founderNames.add(first);
  }
  const alternation = [...founderNames]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  // Capitalised where a sentence starts: after its punctuation, or at the start when the line was capitalised there
  // (a lower-case line is a phrase said mid-sentence: "we left off on the numbers you will get").
  const startOfSentence = (source: string, at: number): boolean =>
    at === 0 ? /^\p{Lu}/u.test(source) : /[.!?]\s+$/.test(source.slice(0, at));
  const cased = (word: string, source: string, at: number): string =>
    startOfSentence(source, at) ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
  let out = text
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(new RegExp(`\\b(?:${alternation})'s\\b`, 'giu'), (_m, at: number, source: string) =>
      cased('your', source, at),
    )
    .replace(
      new RegExp(`\\b(?:${alternation})\\s+([a-z']+)\\b`, 'giu'),
      (_m, verb: string, at: number, source: string) => {
        const lower = verb.toLowerCase();
        const agreed = AGREEMENT[lower] ?? (S_VERBS.has(lower) ? lower.slice(0, -1) : verb);
        return `${cased('you', source, at)} ${agreed}`;
      },
    )
    .replace(new RegExp(`\\b(?:${alternation})\\b`, 'giu'), (_m, at: number, source: string) =>
      cased('you', source, at),
    );
  if (THIRD_PERSON.test(out)) return null;
  const founderFirst = people.founder?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
  for (const name of people.team ?? []) {
    for (const part of new Set([name.trim(), name.trim().split(/\s+/)[0] ?? ''])) {
      if (part.length < 2 || part.toLowerCase() === founderFirst) continue;
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, 'giu'), part);
    }
  }
  // Names the conversation wrote with capitals, where the founder typed them in lower case (wave 7, item 2).
  for (const name of people.names ?? []) {
    if (name.toLowerCase() === founderFirst) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'), name);
  }
  return tidyFounderWords(out);
}

/**
 * Words that open, check or fill a conversation without naming anything to talk about: greetings, "can you hear
 * me", acknowledgements, and the bare frame of a request ("I have a quick question").
 */
export const FILLER = new Set(
  (
    'hi hello hey hiya howdy yo hullo greetings morning afternoon evening good day night test testing tested ' +
    'hear me can you there are ok okay sure yes yeah yep yup no nope nah thanks thank cheers please sorry um ' +
    'uh umm hmm right great cool fine well again back just quick question something talk chat call start let ' +
    'what how about anything want would like need help got minute moment am doing do going today now here ' +
    'news big huge exciting update updates guess'
  ).split(' '),
);

/** Words that name something to talk about (content words that are not {@link FILLER}). */
export function topicWords(text: string): string[] {
  return [...contentTokens(text)].filter((w) => !FILLER.has(w));
}

/** Words a clause opens with, never a noun phrase said mid-sentence: subject pronouns and their contractions. */
const CLAUSE_START =
  /^(?:i|i'm|i've|i'll|i'd|we|we're|we've|we'll|we'd|you|you're|you've|you'll|you'd|they|they're|they've|they'll|they'd|he|he's|he'll|he'd|she|she's|she'll|she'd|it|it's|it'll|it'd|that's|there's|let's)(?![\p{L}'])/iu;
/** A subject pronoun with its verb anywhere ("the union said they'll promote us"): a clause, not a phrase. */
const PRONOUN_CLAUSE =
  /(?<![\p{L}'])(?:i|we|you|they|he|she|it)(?:'(?:ll|re|ve|d|m|s)|\s+(?:will|would|are|were|have|had|is|was|am|can|could|should|did|do|does|said|say|says))(?![\p{L}'])/iu;

/**
 * Whether `phrase` (the words an opener says it was about) is a clause cut from a sentence rather than something to
 * name mid-sentence (LAB-R3b, "we left off on They'll promote QuietQuad"): it opens with a pronoun or a capitalised
 * everyday word (a sentence's first word), or a pronoun and its verb sit in it.
 */
export function isClauseFragment(phrase: string): boolean {
  if (CLAUSE_START.test(phrase) || PRONOUN_CLAUSE.test(phrase)) return true;
  const first = /^\p{Lu}[\p{Ll}'’-]+(?![\p{L}])/u.exec(phrase)?.[0]?.replace(/['’]s$/, '');
  // A month, a day or a holiday is written with its capital ("Thanksgiving break", "May pricing"), and so is a name
  // of two capitalised words ("Viking Global", "Redding Library", "Harbour Hall").
  return (
    first !== undefined &&
    !CALENDAR_NAMES.has(first.toLowerCase()) &&
    !/^\S+\s+\p{Lu}/u.test(phrase) &&
    isEverydayWord(first)
  );
}

/** Months, days and holidays: names that keep their capital mid-sentence, everyday words or not ("May", "Thanksgiving"). */
const CALENDAR_NAMES = new Set(
  (
    'january february march april may june july august september october november december monday tuesday ' +
    'wednesday thursday friday saturday sunday thanksgiving christmas easter halloween hanukkah passover ramadan ' +
    'diwali'
  ).split(' '),
);

/**
 * Whether `word` ("hiring", "pricing", "fundraising") is the gerund of an everyday verb, never a name that ends in -ing
 * ("Sterling", "Beijing", "Boeing", "Kipling": the review of 1cac704 heard "shall we pick up sterling Capital?") nor a
 * holiday ("Thanksgiving"): its verb is an everyday word ("hire", "price"), or it joins a noun and such a gerund
 * ("fund" + "raising", "crowd" + "funding").
 */
function isGerund(word: string): boolean {
  const w = word.toLowerCase();
  if (!/^[a-z]{3,}ing$/.test(w) || CALENDAR_NAMES.has(w)) return false;
  const stem = w.slice(0, -3);
  const verbs = [stem, `${stem}e`];
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) verbs.push(stem.slice(0, -1));
  if (stem.length >= 3 && verbs.some((v) => isEverydayWord(v))) return true;
  for (let at = 4; at <= w.length - 6; at += 1) {
    const head = w.slice(0, at);
    if (!head.endsWith('s') && isEverydayWord(head) && isGerund(w.slice(at))) return true;
  }
  return false;
}

/**
 * A sentence's first word as said mid-sentence (the review of 1cac704: "shall we pick up Annual pricing?", "the Five
 * libraries"): an everyday word, a gerund or a hyphenated pair of them in lower case ("annual", "five", "per-seat",
 * "fundraising"); a name, a month, a day or a holiday, or a word before another capitalised one ("Viking Global",
 * "Redding Library") as written.
 */
function everydayCase(word: string, next: string | undefined): string {
  const core = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (!/^\p{Lu}\p{Ll}/u.test(core) || /^[^\p{L}]*\p{Lu}/u.test(next ?? '')) return word;
  const lower = core.toLowerCase();
  if (CALENDAR_NAMES.has(lower.replace(/['’]s$/, ''))) return word;
  const everyday = core
    .replace(/['’]s$/, '')
    .split('-')
    .every((part) => part !== '' && (isEverydayWord(part) || isGerund(part)));
  return everyday ? word.replace(core, lower) : word;
}

/** Words that say when, how long or how many: never what a subject names ("January", "next week", "a few minutes"). */
const TIME_WORDS = new Set(
  (
    'january february march april may june july august september october november december jan feb mar apr jun ' +
    'jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu ' +
    'thur thurs fri sat sun today tomorrow tonight yesterday morning afternoon evening night weekend weekends week ' +
    'weeks month months year years day days hour hours minute minutes min mins second seconds moment moments time ' +
    'times quarter semester term now soon later earlier ago next last this coming past end beginning middle early ' +
    'late few couple bit little while q1 q2 q3 q4'
  ).split(' '),
);
const NUMBER_WORDS = new Set(
  (
    'one two three four five six seven eight nine ten eleven twelve fifteen twenty thirty forty fifty hundred ' +
    'thousand million first second third half dozen'
  ).split(' '),
);
/** Function words: a subject never opens with one of {@link BAD_START} nor ends with one of these. */
const FUNCTION_WORDS = new Set(
  (
    'a an the this that these those my your our their his her its some any no every each all both either neither ' +
    'another other such of to in on at for with from by about into onto over under after before during between ' +
    'through without within per via as than since until till toward towards against among around across behind ' +
    'beyond near off out up down upon and or but nor so yet if because while although though whether unless i me ' +
    'we us you they them he him she it is are was were be been am will would can could should shall may might ' +
    'must do does did have has had not myself yourself himself herself itself ourselves yourselves themselves ' +
    'mine yours ours theirs'
  ).split(' '),
);
/** Pronouns that end a phrase well, as its object ("your plan to call them", "money from this"). */
const OBJECT_PRONOUNS = new Set(
  (
    'this that these those it them us me you him myself yourself himself herself itself ourselves yourselves ' +
    'themselves mine yours ours theirs'
  ).split(' '),
);
/** Words a subject never opens with: prepositions, conjunctions, "to", auxiliaries and pronouns. */
const BAD_START = new Set(
  (
    'of to in on at for with from by about into onto over under after before during between through without ' +
    'within per via as than since until till toward towards against among around across behind beyond near off ' +
    'out up down upon and or but nor so yet if because while although though unless is are was were be been am ' +
    'will would can could should shall may might must do does did have has had not i me we us you they them he ' +
    'him she it'
  ).split(' '),
);
/**
 * Words a subject never ends with: function words that need what follows ("the study room for", "your plan to"; an
 * object pronoun ends a phrase well: "your plan to call them", "money from this"), and a modifier left without its
 * noun ("the advisor last").
 */
const UNFINISHED = new Set(
  'last next coming past few couple very really just also still even more most less much many'.split(' '),
);
const DANGLING = new Set([...[...FUNCTION_WORDS].filter((w) => !OBJECT_PRONOUNS.has(w)), ...UNFINISHED]);
const WH_SUBJECT = /^(?:whether|how|what|which|when|where|who|why)(?![\p{L}'])/iu;
/** "your plan to X", "your cofounder's plan to X", "your goal of X". */
const PLAN_SUBJECT =
  /^(?:(?:your|the|their|our|a|an|this|that)\s+)?(?:[\p{L}'’-]+['’]s\s+)?(?:plans?|decision|goal|aim|idea|promise|offer|commitment|intention|hope|wish|attempt)\s+(to|of)\s+(\S+)/iu;

/** A word as compared with the lists above: lower case, without the punctuation around it. */
function bare(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
}

/** Hyphenated words that describe, never name: "full-time", "long-term", "high-level", "early-stage", "two-week". */
const DESCRIBING_COMPOUND =
  /^[\p{L}\d]+-(?:time|term|level|stage|scale|based|sized|size|facing|only|free|ready|friendly|related|focused|wide|year|month|week|day)$/u;
/** Everyday words that describe, never name (an opener never asks "shall we pick up ready?"). */
const DESCRIBING = new Set(
  (
    'ready new old good bad big small great fine sure clear full free busy late early quick fast slow hard easy ' +
    'better best worse worst real true false cheap expensive important interested happy sad possible impossible ' +
    'available done finished open closed fixed stuck lost blank okay ok right wrong high low long short paid unpaid ' +
    'quickly slowly actually honestly probably basically definitely finally recently'
  ).split(' '),
);

/**
 * Adverbs and discourse words of a founder's line that say how, when or how sure, never what (the voice suite on
 * 9a2a41f: "Hi Maya, want to carry on with a short pilot instead?", the subject cut from "Maybe we should do a short
 * pilot instead"). A subject never ends with one, nor opens with one ({@link withoutDiscourseWords}, {@link
 * readsAsSubject}).
 */
const DISCOURSE_WORDS = new Set(
  (
    'instead too also anyway anyways though then again either yet already now later first really maybe probably ' +
    'perhaps just actually basically honestly still even definitely obviously literally seriously totally ' +
    'eventually finally certainly hopefully personally'
  ).split(' '),
);
/**
 * Discourse words that also modify the word after them ("first customers", "the later stages", "too many pilots",
 * "either option", "yet another pilot", "even numbers", "still photos"): discourse only before a determiner or a comma.
 */
const MODIFYING = new Set(['first', 'later', 'too', 'either', 'yet', 'even', 'still']);
/** Conjunctions among them: never dropped from the start of a phrase, so no clause is left behind ("though it is"). */
const JOINING = new Set(['though', 'yet']);
/**
 * Discourse words that say when or in what order: what a plan or a question is about when its verb has nothing else
 * ("Should we just hire later?" is "whether to hire later", never "whether to hire": the review of 1cac704), and
 * discourse after what it does ("your plan to call facilities again" is "your plan to call facilities"). The other
 * discourse words ("instead", "though", "honestly"…) never say what was meant.
 */
const TIMING = new Set(['now', 'later', 'first', 'again', 'already', 'yet']);
/** Adverbs of manner or frequency a founder's line can end on ("a designer urgently", "a cofounder ASAP"). */
const MANNER = new Set(
  'asap fast daily weekly monthly yearly quarterly hourly nightly only together alone anymore somehow'.split(
    ' ',
  ),
);
/** Words in -ly that name or describe, never say how ("the family", "a steady supply", "the elderly"). */
const LY_WORDS = new Set(
  (
    'family supply assembly anomaly ally rally reply apply fly butterfly belly jelly bully holly lily monopoly ' +
    'elderly poly'
  ).split(' '),
);
/**
 * Whether `word` is an adverb that ends a founder's line, outside the discourse words (the review of 1cac704: "We
 * need a designer urgently" opened "shall we pick up a designer urgently?"): a word in -ly that names nothing
 * ("urgently", "properly", "quickly"; never "family", "supply" nor a name such as "Kelly"), or "ASAP", "fast", "daily".
 */
function isMannerAdverb(word: string): boolean {
  const clean = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  // A name keeps its capital ("Kelly", "July"); "ASAP" is written in capitals.
  if (/^\p{Lu}/u.test(clean) && !/^\p{Lu}+$/u.test(clean)) return false;
  const w = clean.toLowerCase();
  return MANNER.has(w) || (/^[a-z]{3,}ly$/.test(w) && !LY_WORDS.has(w));
}
/** Words before a last discourse word that make it one side of an alternative ("now or later", "sooner than later"). */
const ALTERNATIVE = new Set(['or', 'nor', 'than']);
/** Vague tails of a founder's line ("annual pricing as well", "a short pilot or something", "the deck so far"). */
const LOOSE_TAIL =
  /,?\s+(?:as well|for now|right now|so far|at all|after all|for sure|of course|or something(?: like that)?|or so|or whatever|and stuff|and everything|and all that|and so on|etc\.?)$/i;
/**
 * Fixed phrases that end on a discourse word, never cut (the review of 1cac704: "We want to break even" was "your plan
 * to break"): "break even", "buy now, pay later", "put students first", "customers come first".
 */
const FIXED_TAIL =
  /\b(?:break|breaks|breaking|broke|broken)\s+even$|\bpay(?:s|ing)?\s+later$|\b(?:put|puts|putting)\s+(?:[\p{L}\p{N}'’-]+\s+){1,4}first$|\b(?:come|comes|coming|came|go|goes|going|went)\s+first$/iu;
/** Particles of a phrasal verb: nothing a plan does by themselves ("step back", "give up"). */
const PARTICLES = new Set('up down out off back away on over in around aside along through'.split(' '));
/** Those that end a phrasal verb well, never a preposition left without its object ("add up", not "focus on"). */
const PHRASAL = new Set('up down out off back away aside'.split(' '));
/** A plan or a question: what it does can end on a particle ("whether the numbers add up"). */
const WHAT_IS_DONE =
  /^(?:whether|how|what|which|when|where|who)(?![\p{L}'])|^(?:(?:your|the|their|our|a|an|this|that)\s+)?(?:[\p{L}'’-]+['’]s\s+)?(?:plans?|decision|goal|aim|idea|promise|commitment|intention|hope|wish|attempt)\s+to\s/iu;
/** Whether `word`, followed by `next`, opens a phrase as a discourse word rather than modifying `next`. */
function opensAsDiscourse(word: string, next: string | undefined): boolean {
  const w = bare(word);
  if (!DISCOURSE_WORDS.has(w)) return false;
  if (!MODIFYING.has(w) || /[,;:]$/.test(word)) return true;
  // A determiner after it: "first the pricing" (DETERMINERS is defined with the phrase rules below).
  return next !== undefined && DETERMINERS.has(bare(next));
}

/** A plan's or a question's frame and what it does: "your plan to …", "whether to …", "whether you can …". */
const VERB_FRAME =
  /^(?:(?:(?:your|the|their|our|a|an|this|that)\s+)?(?:[\p{L}'’-]+['’]s\s+)?(?:plans?|decision|goal|aim|idea|promise|commitment|intention|hope|wish|attempt)\s+to|(?:whether|how|what|which|when|where|who)\s+to|whether\s+you(?:\s+can)?)\s+(\p{Ll}[\p{L}'’-]*(?:\s.*)?)$/iu;

/**
 * Whether `words` are what a plan or a question does with nothing after its verb but particles or pronouns ("your plan
 * to break", "whether to hire", "talk to them"): `verbPhrase` when they open with the verb, else read from their frame
 * ({@link VERB_FRAME}).
 */
function leavesBareVerb(words: readonly string[], verbPhrase: boolean): boolean {
  let done: readonly string[] = words;
  if (!verbPhrase) {
    const frame = VERB_FRAME.exec(words.join(' '));
    if (frame?.[1] === undefined) return false;
    done = frame[1].split(' ');
  }
  return done.length > 0 && done.slice(1).every((w) => namesNothing(w) || PARTICLES.has(bare(w)));
}

/** Whether the last word of `words` is one side of an alternative said in parallel ("raise first or hire first"). */
function inAlternative(words: readonly string[]): boolean {
  const lower = words.map(bare);
  const last = lower.at(-1) ?? '';
  const or = lower.slice(0, -1).findLastIndex((w) => /^(?:or|nor|versus|vs)$/.test(w));
  return or > 0 && lower.slice(0, or).includes(last);
}

/**
 * Whether `words` end on a discourse word, an adverb of manner or a vague tail that says nothing of what was meant:
 * never one side of an alternative ("now or later", "raise first or hire first"), a fixed phrase ("break even", "put
 * students first"), nor a timing word or an adverb that is all a plan's verb has ("whether to hire later": the review of
 * 1cac704). `verbPhrase`: `words` open with the verb (a plan's "hire later"), else a frame says where it is.
 */
function endsAsDiscourse(words: readonly string[], verbPhrase = false): boolean {
  if (LOOSE_TAIL.test(words.join(' '))) return true;
  const lastWord = words.at(-1) ?? '';
  const last = bare(lastWord);
  const timing = TIMING.has(last) || (!DISCOURSE_WORDS.has(last) && isMannerAdverb(lastWord));
  if (!timing && !DISCOURSE_WORDS.has(last)) return false;
  if (ALTERNATIVE.has(bare(words.at(-2) ?? '')) || inAlternative(words)) return false;
  if (FIXED_TAIL.test(words.map(bare).join(' '))) return false;
  return !(timing && leavesBareVerb(words.slice(0, -1), verbPhrase));
}

/**
 * `text` (what an opener says a conversation was about) without the adverbs and discourse words at its ends ("a short
 * pilot instead" → "a short pilot", "actually the pilot pricing" → "the pilot pricing", "annual pricing as well" →
 * "annual pricing", "a designer urgently" → "a designer"), keeping one that belongs to it ("whether to hire now or
 * later", "first customers", "your plan to break even", "whether to hire later"); '' when nothing else is left.
 * `verbPhrase`: `text` is what a plan does, its verb first ("just hire later" → "hire later").
 */
export function withoutDiscourseWords(text: string, verbPhrase = false): string {
  let words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  for (;;) {
    const joined = words.join(' ');
    const tail = LOOSE_TAIL.exec(joined);
    if (tail !== null) {
      words = joined.slice(0, tail.index).split(' ').filter(Boolean);
    } else if (
      words.length > 0 &&
      !JOINING.has(bare(words[0] ?? '')) &&
      opensAsDiscourse(words[0] ?? '', words[1])
    ) {
      // The start first: what is left of a plan opens with its verb ("just hire later" → "hire later").
      words = words.slice(1);
    } else if (words.length > 0 && endsAsDiscourse(words, verbPhrase)) {
      words = words.slice(0, -1);
    } else {
      break;
    }
  }
  return words.join(' ').replace(/[,;:]+$/, '');
}

/** `text` without the discourse words it opens with ("probably two engineers" → "two engineers"). */
function withoutLeadingDiscourse(text: string): string {
  let words = text.trim().split(/\s+/);
  while (words.length > 1 && !JOINING.has(bare(words[0] ?? '')) && opensAsDiscourse(words[0] ?? '', words[1]))
    words = words.slice(1);
  return words.join(' ');
}

/**
 * Whether `text` is a plan or a question whose verb has nothing after it but particles or pronouns ("whether to hire",
 * "your plan to break"): a shorter form of a subject never ends there when the whole did not (calls.ts
 * `shorterSubjects`: the review of 1cac704).
 */
export function endsOnItsVerb(text: string): boolean {
  return leavesBareVerb(text.replace(/\s+/g, ' ').trim().split(' '), false);
}

/** A word that only describes (an adjective or an adverb), never something to talk about on its own; never a name. */
function describesOnly(word: string): boolean {
  if (/^\p{Lu}/u.test(word) && !isEverydayWord(word.replace(/['’]s$/, ''))) return false;
  const w = bare(word);
  return DESCRIBING.has(w) || DESCRIBING_COMPOUND.test(w);
}

/** A word that can be the verb of a plan ("to call", "to book"): lower case, no function, time or number word. */
function looksLikeVerb(word: string): boolean {
  const w = bare(word);
  return (
    /^\p{Ll}[\p{Ll}'-]*$/u.test(word.replace(/[,.;:!?]+$/, '')) &&
    !FUNCTION_WORDS.has(w) &&
    !TIME_WORDS.has(w) &&
    !NUMBER_WORDS.has(w)
  );
}

/** A word that names nothing by itself: a function, time or number word, or a number. */
function namesNothing(word: string): boolean {
  const w = bare(word);
  return (
    w === '' ||
    FUNCTION_WORDS.has(w) ||
    TIME_WORDS.has(w) ||
    NUMBER_WORDS.has(w) ||
    WH_SUBJECT.test(w) ||
    /^\$?\d[\d.,:/%-]*(?:st|nd|rd|th|s|k|m)?$/.test(w)
  );
}

/**
 * Whether `text` reads as what an opener can say a conversation was about, mid-sentence ("shall we pick up …?",
 * "want to carry on with …?"): a noun phrase ("the Hartwell pilot", "per-library pricing", "Noor", "pricing"), an activity
 * ("booking the auditorium"), a question ("whether to price per seat") or a plan with its verb ("your plan to call
 * facilities"). Never a lone date, month or time ("January": lab run 39780304879, "Hi Idris, want to carry on with
 * January?"), a single word that only describes ("full-time", "ready"), a plan without a verb ("your plan to a few
 * minutes before your next class": the voice suite on acc50c6), a phrase that opens with a preposition, a
 * conjunction, an auxiliary or a pronoun, or one left dangling ("the study room for", "the advisor last"), nor one
 * that ends or opens on an adverb or a discourse word of the founder's line ("a short pilot instead": the voice
 * suite on 9a2a41f; "actually the pilot pricing"; "a designer urgently": the review of 1cac704), unless it is one side
 * of an alternative ("now or later", "raise first or hire first"), part of a fixed phrase ("break even", "put
 * students first") or the timing a plan's verb has ("whether to hire later").
 */
export function readsAsSubject(text: string): boolean {
  const flat = text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:…]+$/, '');
  if (flat === '' || topicWords(flat).length === 0) return false;
  const words = flat.split(' ');
  const first = bare(words[0] ?? '');
  const last = bare(words.at(-1) ?? '');
  // A fixed phrase ("break even") or a verb's particle in a plan or a question ("whether the numbers add up", "your
  // plan to follow up") ends well.
  const particle =
    PHRASAL.has(last) &&
    words.length >= 3 &&
    !DANGLING.has(bare(words.at(-2) ?? '')) &&
    WHAT_IS_DONE.test(flat);
  if (DANGLING.has(last) && !particle && !FIXED_TAIL.test(words.map(bare).join(' '))) return false;
  if (endsAsDiscourse(words) || opensAsDiscourse(words[0] ?? '', words[1])) return false;
  const plan = PLAN_SUBJECT.exec(flat);
  if (plan !== null) {
    // A plan says what will be done: "your plan to call facilities", never "your plan to a few minutes".
    if (plan[1]?.toLowerCase() === 'to' && !looksLikeVerb(plan[2] ?? '')) return false;
  } else if (!WH_SUBJECT.test(flat)) {
    if (BAD_START.has(first) || CLAUSE_START.test(flat)) return false;
  }
  const naming = words.filter((w) => !namesNothing(w));
  if (naming.length === 0) return false;
  // One word alone is a name or a noun ("Noor", "FDA", "pricing", "fundraising"), never a word that only describes
  // ("full-time", "ready", "quickly").
  if (words.length === 1) return !describesOnly(words[0] ?? '');
  return true;
}

/** Recall and memory questions the conversation-state cues do not cover ("What did I tell you in our chat…?"). */
const RECALL =
  /\b(?:remember|recall|remind me|last time|(?:we|you and i) (?:talked|spoke|discussed|chatted|covered)|did i (?:tell|say|mention|ask)|i (?:told|asked|said to|mentioned to) you|what did (?:i|we) (?:say|tell|talk|discuss|decide|agree|ask)|(?:in|from|during) our (?:last |previous |earlier |first )?(?:chat|call|conversation|session|talk)|you (?:said|told me|mentioned)|(?:forgot|forget)\b)/i;
/** Questions about the vEIR itself, not the venture. */
const ABOUT_THE_VEIR =
  /\b(?:are you (?:a |an |the )?(?:bot|robot|human|real|ai|person|machine|man|woman|really)|is this (?:really |actually )?(?:you|a bot|a human|an ai|real|a person|[A-Z][a-z]+\b(?=\s*\?))|am i (?:talking|speaking|chatting) (?:to|with)|who (?:am i talking to|are you|is this)|what are you|your name|do you (?:even )?(?:have a life|sleep|eat|feel|dream)|you(?:'re| are) (?:a bot|an ai|not real|a robot|human))/i;
/** Checks of the line itself. */
const META = /\b(?:can you hear me|are you there|is this (?:working|on)|mic check|testing|test test)\b/i;

/** Whether a founder line names something to pick up again (see the module comment). */
export function isTopicLine(text: string): boolean {
  const line = text.replace(/[‘’ʼ]/g, "'").trim();
  if (line === '') return false;
  const moves = founderMoves(line);
  if (moves.some((m) => m === 'recall' || m === 'resume' || m === 'closing' || m === 'short_reply'))
    return false;
  if (RECALL.test(line) || ABOUT_THE_VEIR.test(line) || META.test(line)) return false;
  // A discourse word is no topic word ("I really want to quit" names one thing, as "I want to quit" does: the review of
  // 1cac704), but for a timing word ("hire later") or "even" in "break even".
  const breakEven = /\b(?:break|breaks|breaking|broke|broken)\s+even\b/i.test(line);
  return (
    topicWords(line).filter((w) => !DISCOURSE_WORDS.has(w) || TIMING.has(w) || (w === 'even' && breakEven))
      .length >= 2
  );
}

/** Words that end a noun phrase (function words and the common verbs of a founder's line). */
const BREAKERS = new Set(
  (
    'and or but so if then than to of in on at for with from by about into over under after before during between ' +
    'through without within per via as is are was were be been being am do does did done have has had will would ' +
    "can could should may might must shall not no yes it its it's i i'm i've i'd i'll we we're we've we'd we'll you " +
    "you're they they're he she me us them what which who whom whose when where why how there here just also very " +
    'really too quite all any some each every both either neither more most less much many enough get got gets make ' +
    'made makes take took said say says tell told ask asked want wants wanted need needs needed think thought know ' +
    'knew see saw go went going come came give gave try tried call called talk talked plan planned decided offer ' +
    'offered pay paid charge charged sign signed run ran use used start started finish finished book booked meet met ' +
    'send sent find found keep kept let help helps helped work worked look looks looking seem seems feel felt like ' +
    'love hate sure ok okay well right great good bad hi hey hello thanks please quick question still even already left ' +
    'now today tomorrow yesterday week since because while until though although thing things stuff something ' +
    'anything everything nothing one lot lots pays month months year years day days hour hours minute minutes ' +
    "time times long ago different same other single whole they'll they've they'd he'll he's he'd she'll she's " +
    "she'd it'll it'd you'll you've you'd that's that'll there's here's let's who's what's won't can't don't " +
    "doesn't didn't isn't aren't wasn't weren't shouldn't wouldn't couldn't haven't hasn't hadn't " +
    // Irregular past tenses: "Bloomberg wrote about our pilot" names "Bloomberg", never "Bloomberg wrote".
    'wrote spoke grew chose drove began brought bought caught taught sold spent'
  ).split(' '),
);
/**
 * Words after which the next word is a verb, not the start of a noun phrase (a subject pronoun, a modal, "to"):
 * "they'll promote QuietQuad" and "if we add group booking" name no "promote QuietQuad" or "add group booking"
 * (LAB-R3b: "we talked about They'll promote QuietQuad").
 */
const BEFORE_A_VERB = new Set(
  (
    "i we you they he she it i'll we'll you'll they'll he'll she'll it'll i'd we'd you'd they'd he'd she'd " +
    "will would can could should shall may might must to don't doesn't didn't won't can't let's"
  ).split(' '),
);
/**
 * Auxiliaries after which a participle can be the verb of a clause ("The competition is getting fiercer"), never the
 * start of a phrase ("shall we pick up getting fiercer?"); after a noun's "is" it can also name an activity ("The
 * bottleneck is hiring engineers"): {@link participleIsVerb}.
 */
const AUXILIARY = new Set(
  "is are was were am be been being isn't aren't wasn't weren't i'm we're you're they're it's he's she's".split(
    ' ',
  ),
);

/**
 * Whether the participle at `raw[i]`, after an auxiliary, is the verb of its clause rather than an activity it names:
 * nothing named follows it ("is getting fiercer though", "are going slower than I hoped", "is going well", "is
 * booked"), where "is hiring engineers", "is funding runway" and "is marketing budget" name what follows (the review
 * of 1cac704: those three had become the invitation).
 */
function participleIsVerb(raw: readonly string[], i: number): boolean {
  const token = raw[i] ?? '';
  const next = raw[i + 1];
  if (next === undefined || /[,.;:!?]$/.test(token)) return true;
  const word = bare(next);
  if (
    word === '' ||
    BREAKERS.has(word) ||
    DISCOURSE_WORDS.has(word) ||
    PARTICLES.has(word) ||
    UNFINISHED.has(word) ||
    describesOnly(next) ||
    isMannerAdverb(next)
  )
    return true;
  // A comparative that ends the clause: "getting fiercer", "going slower than…".
  const after = raw[i + 2];
  return (
    /^[a-z]{2,}(?:er|ier)$/.test(word) &&
    (after === undefined ||
      /[,.;:!?]$/.test(next) ||
      BREAKERS.has(bare(after)) ||
      DISCOURSE_WORDS.has(bare(after)))
  );
}
const DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'our',
  'my',
  'your',
  'their',
  'this',
  'that',
  'these',
  'those',
]);
const DEFINITE = new Set(['the', 'our', 'my', 'your', 'this', 'that', 'these', 'those']);
const OWN = /\b(?:our|my|ours|mine|ourselves|myself)\b|\b(?:we|i|us|me)\b/gi;

/** The founder's own words as the vEIR says them: "our" → "your", "we" / "I" → "you". */
function yourWords(text: string): string {
  return text.replace(OWN, (word) => {
    const w = word.toLowerCase();
    if (w === 'our' || w === 'my') return 'your';
    if (w === 'ours' || w === 'mine') return 'yours';
    if (w === 'ourselves' || w === 'myself') return 'yourself';
    return 'you';
  });
}

/**
 * Where a clause ends: its punctuation (never a comma or a colon inside a number: "$1,200", "10:30"; the voice suite
 * on 9a2a41f heard "raising the price to $1") or a word that joins another clause.
 */
const CLAUSE_BREAK = /(?<!\d)[,:]|[,:](?!\d)|[;—–]|\s(?:but|because|so|and then|since|though)\s/i;

/**
 * The clause after a verb, as a topic: up to the first clause break, without the adverbs and discourse words at its
 * ends ("maybe run a pilot first" → "run a pilot": {@link withoutDiscourseWords}; `verbPhrase` when it opens with
 * what is done, so "just hire later" keeps "hire later"), at most `maxWords` words, no end punctuation.
 */
function clause(text: string, verbPhrase = false, maxWords = 10): string | null {
  const cut = text.split(CLAUSE_BREAK)[0] ?? '';
  const words = withoutDiscourseWords(cut.replace(/[.!?…"“”]+$/g, ''), verbPhrase)
    .split(' ')
    .filter(Boolean);
  if (words.length === 0 || words.length > maxWords) return null;
  return yourWords(words.join(' '));
}

interface Phrase {
  readonly text: string;
  readonly score: number;
}

/** A number that counts what follows it ("five interviews", "12 libraries"; never "several", "dozens"). */
const COUNT =
  /^(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)$/i;

/** The most telling noun phrase of a sentence ("the Hartwell pilot", "a two-week test", "Noor"), or null. */
function nounPhrase(sentence: string): Phrase | null {
  const raw = sentence.split(/\s+/).filter(Boolean);
  // Its first word as said mid-sentence: "annual pricing", never "Annual pricing" (names keep their capitals).
  if (raw[0] !== undefined) raw[0] = everydayCase(raw[0], raw[1]);
  let best: Phrase | null = null;
  let i = 0;
  while (i < raw.length) {
    const words: string[] = [];
    let score = 0;
    let determiner: string | null = null;
    let j = i;
    const first = (raw[j] ?? '').replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
    if (DETERMINERS.has(first.toLowerCase())) {
      determiner = first.toLowerCase();
      words.push(determiner);
      j += 1;
    }
    // A lower-case word right after a subject or a modal is its verb ("they'll promote …", "we add …"): no phrase
    // starts there ("What would Corin say?" still names Corin). Nor does one on an adverb ("Probably Hartwell").
    const before = (raw[i - 1] ?? '').replace(/^[^\p{L}']+|[^\p{L}']+$/gu, '').toLowerCase();
    if (
      determiner === null &&
      ((BEFORE_A_VERB.has(before) && /^\p{Ll}/u.test(first)) ||
        (AUXILIARY.has(before) && /^\p{Ll}+(?:ing|ed)$/u.test(first) && participleIsVerb(raw, i)) ||
        opensAsDiscourse(raw[i] ?? '', raw[i + 1]))
    ) {
      i += 1;
      continue;
    }
    let content = 0;
    let rejected = false;
    for (; j < raw.length && content < 5; j += 1) {
      const token = raw[j] ?? '';
      const word = token.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%']+$/gu, '');
      const lower = word.toLowerCase();
      if (word === '' || BREAKERS.has(lower) || S_VERBS.has(lower) || DETERMINERS.has(lower)) break;
      // "the advisor last week": "last" starts a time, not part of the phrase; "a short pilot instead": an adverb of
      // the line ends it (the voice suite on 9a2a41f).
      if (content > 0 && (UNFINISHED.has(lower) || DISCOURSE_WORDS.has(lower))) break;
      if (/^(?:her|his|him|she|he)$/.test(lower)) {
        rejected = true;
        break;
      }
      // A past-tense verb ends the phrase ("the student union offered…"), except right after the determiner, or as
      // what an activity leaves its object at the sentence's end ("keeping librarians engaged").
      const complement =
        content >= 2 &&
        j === raw.length - 1 &&
        /^\p{Ll}+ing$/u.test(words[determiner === null ? 0 : 1] ?? '');
      if (lower.endsWith('ed') && lower.length > 4 && !(determiner !== null && content === 0) && !complement)
        break;
      words.push(word);
      content += 1;
      const capitalised = /^\p{Lu}/u.test(word) && !isEverydayWord(word);
      if (capitalised) score += 2;
      if (topicWords(word).length > 0) score += 1;
      // A phrase ends at the punctuation that ends its last word.
      if (/[,.;:!?)]$/.test(token)) {
        j += 1;
        break;
      }
    }
    // "My cofounder and I disagree…": the people who did something, not what it was about.
    if (bare(raw[j] ?? '') === 'and' && /^(?:i|we|me)$/.test(bare(raw[j + 1] ?? ''))) rejected = true;
    // "a designer urgently", "a cofounder ASAP": an adverb of the line ends no phrase (the review of 1cac704).
    while (content > 1 && isMannerAdverb(words.at(-1) ?? '')) {
      words.pop();
      content -= 1;
    }
    if (!rejected && content > 0) {
      if (determiner !== null && DEFINITE.has(determiner)) score += 1;
      const proper = words.some((w) => /^\p{Lu}/u.test(w) && !isEverydayWord(w));
      // Two words that name something ("the Hartwell pilot", "a two-week test"), or a name ("Noor").
      const enough = proper || topicWords(words.join(' ')).length >= 2;
      // A count is the one the founder told of: "five customer interviews" → "the five customer interviews".
      if (determiner === null && content >= 2 && COUNT.test(words[0] ?? '')) words.unshift('the');
      const text = yourWords(words.join(' '));
      // A month or a lone word is no subject ("January": lab run 39780304879): the next phrase is tried.
      if (enough && readsAsSubject(text) && (best === null || score > best.score)) best = { text, score };
    }
    i = Math.max(j, i + 1);
  }
  return best;
}

/** {@link invertedQuestion} of a question whose subject and verb cannot be told apart ("Does the pilot cover costs?"). */
const UNSPLIT = Symbol('unsplit');

/**
 * A yes/no question about a thing ("Should the pilot run in two libraries or three?", "Is a two-week test
 * enough?") as "whether the pilot should run in two libraries or three", "whether a two-week test is enough". The
 * subject is a determiner and up to three words before the next function word or verb; null for other shapes, and
 * {@link UNSPLIT} when where the subject ends cannot be told ("Does the pilot cover costs?"): its words are then no
 * noun phrase either ("shall we pick up the pilot cover costs?" splices the subject and its verb).
 */
function invertedQuestion(sentence: string): string | typeof UNSPLIT | null {
  const match =
    /^(should|can|could|will|is|are|does|do|was|were)\s+(the|a|an|our|my|this|that|these|those)\s+(.+?)\??$/i.exec(
      sentence,
    );
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const auxiliary = match[1].toLowerCase();
  const copula = /^(?:is|are|was|were)$/.test(auxiliary);
  const words = match[3].split(/\s+/);
  // The subject ends at a function word or a verb, at a word that describes it ("Is the Hartwell pilot ready yet?" →
  // "whether the Hartwell pilot is ready", "Is the pilot worth it?" → "whether the pilot is worth it"), or where a
  // determiner opens what is said of it ("Is the pilot a success?", "Does the pilot cover our costs?": the verb is
  // the word before). The word right after the question's determiner is the subject's noun ("Is the plan solid?",
  // "Should the call go ahead?").
  const ends = (n: number): boolean => {
    const word = words[n] ?? '';
    if (n === 0) return FUNCTION_WORDS.has(bare(word));
    return (
      BREAKERS.has(word.toLowerCase().replace(/[^a-z'-]/g, '')) ||
      describesOnly(word) ||
      bare(word) === 'worth' ||
      DETERMINERS.has(bare(word))
    );
  };
  let n = 0;
  while (n < words.length && n < 3 && !ends(n)) n += 1;
  if (!copula && n > 0 && n < words.length && DETERMINERS.has(bare(words[n] ?? ''))) n -= 1;
  // Otherwise the subject runs on to the question's end or past three words (the review of 1cac704 heard "shall we
  // pick up your pitch convincing?"): after "is", the last word is what is asked of it ("Is our pitch convincing?" →
  // "whether your pitch is convincing"); after "do" or a modal, the verb of a two-word question ("Can the pilot
  // scale?") or a verb and its particle ("Do the numbers add up?"). Where it ends cannot be told otherwise.
  const runsOn = n === words.length || (n === 3 && !ends(3));
  if (runsOn && words.length >= 2 && !(copula && n === 3 && words.length === 4)) {
    const last = words.at(-1) ?? '';
    if (copula && predicative(last, words.at(-2) ?? '') && words.length <= 5) n = words.length - 1;
    else if (copula && n === words.length) return null;
    else if (!copula && words.length >= 3 && words.length <= 4 && PHRASAL.has(bare(last)))
      n = words.length - 2;
    else if (!copula && words.length === 2) n = 1;
    else return UNSPLIT;
  }
  if (n === 0 || n >= words.length) return null;
  const rest = clause(words.slice(n).join(' '), !copula);
  if (rest === null) return null;
  const subject = yourWords(`${match[2].toLowerCase()} ${words.slice(0, n).join(' ')}`);
  // "Does the pricing make sense?" → "whether the pricing makes sense", never "whether the pricing does make sense".
  if (auxiliary === 'does') return `whether ${subject} ${thirdPerson(rest)}`;
  if (auxiliary === 'do') return `whether ${subject} ${rest}`;
  return `whether ${subject} ${auxiliary} ${rest}`;
}

/**
 * Whether `word`, the last of "Is the … ?" after `before`, says what its subject is ("convincing", "useful", "solid",
 * "ready"): a word in lower case that names something (never a time: "Is the demo tomorrow?"), and not the noun of a
 * name's compound ("Is the Hartwell pilot?" asks nothing of "the Hartwell"). A question has its predicate, so its last
 * word is no part of its subject.
 */
function predicative(word: string, before: string): boolean {
  const name = /^\p{Lu}/u.test(before) && !isEverydayWord(before.replace(/['’]s$/, ''));
  return !name && /^\p{Ll}/u.test(word.replace(/^[^\p{L}]+/u, '')) && !namesNothing(word);
}

/**
 * What is done, said of one thing: "make sense" → "makes sense", "still stand" → "still stands", "have" → "has" (its
 * verb is its first word that is no adverb).
 */
function thirdPerson(done: string): string {
  const words = done.split(' ');
  const at = Math.max(
    0,
    words.findIndex((w) => !DISCOURSE_WORDS.has(bare(w)) && !isMannerAdverb(w)),
  );
  const verb = words[at] ?? '';
  const said =
    verb === 'have'
      ? 'has'
      : verb === 'be'
        ? 'is'
        : /(?:s|sh|ch|x|z|o)$/.test(verb)
          ? `${verb}es`
          : /[^aeiou]y$/.test(verb)
            ? `${verb.slice(0, -1)}ies`
            : `${verb}s`;
  return [...words.slice(0, at), said, ...words.slice(at + 1)].join(' ');
}

/** "booked" → "booking", "planned" → "planning", "priced" → "pricing" (null for "agreed" and the like). */
function gerund(pastTense: string): string | null {
  const verb = pastTense.toLowerCase();
  if (!/^[a-z]{3,}ed$/.test(verb) || verb.endsWith('eed')) return null;
  return `${verb.slice(0, -2)}ing`;
}

/**
 * Adverbs a founder puts between "we" or "I" and the verb ("I still need to…", "we've finally decided to…", "we're
 * really weighing…"), as a pattern of whole words, each followed by a space.
 */
const ADVERBS =
  '(?:(?:still|really|just|probably|actually|also|definitely|finally|already|maybe|honestly|basically|now|seriously|totally|certainly|eventually|kind of|sort of)\\s+)*';
/** "We're (still) pricing the pilot…": the verb and what follows it. */
const PROGRESSIVE = new RegExp(
  `^(?:we|i)(?:'re| are|'m| am|'ve been| have been)\\s+${ADVERBS}([a-z]+ing)\\s+(.+)$`,
  'i',
);
/** "We (just) booked the auditorium…": the verb and what follows it. */
const PAST = new RegExp(`^(?:we|i)\\s+${ADVERBS}([a-z]+ed)\\s+(.+)$`, 'i');
/** "We('ve finally) decided to …": what was decided. */
const DECIDED = new RegExp(
  `^(?:we|i)(?:'ve| have)?\\s+${ADVERBS}(?:decided|chose|agreed)\\s+to\\s+(.+)$`,
  'i',
);
/** "We're (really) planning to …", "I'm going to …": what is planned. */
const PLANNING = new RegExp(
  `^(?:we|i)(?:'re| are|'m| am)?\\s+${ADVERBS}(?:planning|going|hoping|trying|aiming|about)\\s+to\\s+(.+)$`,
  'i',
);
/** "I (still) need to call", "I will call"; never "I have a few minutes" (a possession is no plan). */
const PLANS_TO = new RegExp(
  `^(?:we|i)\\s+${ADVERBS}(?:(?:plan|want|need|have|hope|intend)\\s+to|will|'ll)\\s+(.+)$`,
  'i',
);

/**
 * A deliberation: what is weighed is the subject, never the weighing ("We are weighing per-library pricing for the
 * pilot" → "per-library pricing for the pilot": "shall we pick up weighing per-library pricing…?" is no sentence).
 */
const DELIBERATING =
  /^(?:thinking (?:about|of|through)|weighing(?: up)?|considering|debating|discussing|exploring|looking (?:at|into)|wondering about|mulling(?: over)?|figuring out|working out|deciding on)\s+(.+)$/i;

/**
 * What the founder did or is doing, as an activity: "We booked the auditorium for demo day" → "booking the
 * auditorium for demo day", "We're pricing the Hartwell pilot at $900" → "pricing the Hartwell pilot at $900",
 * "Our goal is ten paying libraries by June" → "your goal of ten paying libraries by June"; what they are weighing,
 * as itself ("We're thinking about annual pricing too" → "annual pricing", "We're considering whether to raise now or
 * later" → "whether to raise now or later"). Null for other shapes.
 */
function doing(sentence: string): LineTopic | null {
  const progressive = PROGRESSIVE.exec(sentence);
  const past = PAST.exec(sentence);
  const goal =
    /^(?:our|my)\s+(goal|plan|aim|target|idea|worry|concern|priority|problem)\s+is\s+(to\s+)?(.+)$/i.exec(
      sentence,
    );
  let text: string | null = null;
  const weighed =
    progressive?.[1] === undefined ? null : DELIBERATING.exec(`${progressive[1]} ${progressive[2] ?? ''}`);
  if (weighed?.[1] !== undefined) {
    const what = clause(weighed[1]);
    // Something to name ("annual pricing", "Hartwell"), never "it" or "stuff".
    if (what === null || !topicWords(what).some((w) => !BREAKERS.has(w))) return null;
    return { text: what, question: WH_SUBJECT.test(what), score: 3 + topicWords(what).length };
  }
  // Read with its verb, so a fixed phrase stays whole ("putting students first").
  if (progressive?.[1] !== undefined && progressive[2] !== undefined) {
    const verb = progressive[1].toLowerCase();
    const said = clause(`${verb} ${withoutLeadingDiscourse(progressive[2])}`, true, 11);
    if (said !== null && !BREAKERS.has(verb) && said.includes(' ')) text = said;
  } else if (past?.[1] !== undefined && past[2] !== undefined) {
    const verb = gerund(past[1]);
    const said = verb === null ? null : clause(`${verb} ${withoutLeadingDiscourse(past[2])}`, true, 11);
    if (said?.includes(' ') === true) text = said;
  } else if (goal?.[1] !== undefined && goal[3] !== undefined) {
    const rest = clause(goal[3]);
    if (rest !== null) text = `your ${goal[1].toLowerCase()} ${goal[2] === undefined ? 'of' : 'to'} ${rest}`;
  }
  return text === null || topicWords(text).length < 2
    ? null
    : { text, question: false, score: 3 + topicWords(text).length };
}

/** Gerunds that are no activity: a sentence opening with one names no activity ("Nothing is working"). */
const NOT_AN_ACTIVITY = new Set(
  'something nothing anything everything morning evening spring during according including regarding'.split(
    ' ',
  ),
);
/** A sentence about an activity: its gerund and what follows it, up to its verb ("Hiring a designer feels risky"). */
const ACTIVITY_SUBJECT =
  /^(\p{Lu}\p{Ll}{2,}ing)((?:\s+[^\s,;:]+){0,5}?)\s+(?:is|are|was|were|feels|felt|seems|seemed|looks|looked|sounds|sounded|has|had|keeps|kept|takes|took|will|would|could|might|may|can|isn't|wasn't|doesn't|didn't|won't)(?![\p{L}'])/u;

/**
 * The activity a sentence is about, in its everyday case ("Fundraising is taking too much of my time" → "fundraising",
 * never "Fundraising" mid-sentence; "Hiring a full-time engineer feels risky right now" → "hiring a full-time
 * engineer"). Null for other shapes.
 */
function activity(sentence: string): LineTopic | null {
  const match = ACTIVITY_SUBJECT.exec(sentence);
  const gerundWord = match?.[1]?.toLowerCase();
  if (match === null || gerundWord === undefined || NOT_AN_ACTIVITY.has(gerundWord)) return null;
  const rest = (match[2] ?? '').trim();
  // A name that ends in -ing is no activity, and keeps its capital ("Sterling Capital", "Beijing", "Viking Global",
  // "Thanksgiving break": the review of 1cac704 heard "sterling Capital"), nor is one whose next word is an everyday
  // word in capitals ("Redding Library", "Reading Room"): the noun phrase is read instead. A name after an activity
  // is what it does ("Hiring Noor feels risky" → "hiring Noor").
  const next = /^[^\p{L}]*(\p{Lu}[\p{L}'’-]*)/u.exec(rest)?.[1];
  if (!isGerund(gerundWord) || (next !== undefined && isEverydayWord(next.replace(/['’]s$/, ''))))
    return null;
  const object = rest === '' ? '' : clause(rest);
  if (object === null) return null;
  const text = object === '' ? gerundWord : `${gerundWord} ${object}`;
  return topicWords(text).length === 0 ? null : { text, question: false, score: 3 + topicWords(text).length };
}

/** What a founder line was about, summarised as the vEIR can say it; `question` when it asked something. */
export interface LineTopic {
  readonly text: string;
  readonly question: boolean;
  /** How telling it is (higher is better). */
  readonly score: number;
}

/**
 * A sentence that only says how much time the founder has ("I have a few minutes before my next class, so let's be
 * quick", "I've got a bit of time today"): it names nothing to pick up (the voice suite on acc50c6 opened with "want to
 * carry on with your plan to a few minutes before your next class?").
 */
const TIME_BUDGET =
  /^(?:(?:i|we)(?:'ve| have)?\s+(?:only\s+|just\s+)?(?:got|have)|(?:i'm|i am|we're|we are)\s+(?:only\s+)?(?:free|around|here)(?:\s+for)?)\s+(?:(?:a|an|about|maybe|like|only|just|more)\s+)*(?:few|couple(?:\s+of)?|bit(?:\s+of)?|little(?:\s+bit(?:\s+of)?)?|some|\d+|ten|five|fifteen|twenty|thirty|half an?)?\s*(?:more\s+)?(?:minutes?|mins?|time|moment|hour|hours|seconds?)\b/i;

/** Someone of the founder's ("My cofounder wants to go full-time in January") and their plan. */
const THEIR_PLAN =
  /^(?:my|our)\s+([\p{L}-]+(?:\s+[\p{L}-]+)?)\s+(?:wants|plans|is going|is planning|hopes|intends|has decided|decided|agreed|is about|needs)\s+to\s+(.+)$/iu;
const THIRD_PERSON_WORD = /\b(?:he|she|him|his|her|hers|himself|herself)\b/i;

/**
 * Their plan as a topic ("your cofounder's plan to go full-time in January"): the clause after "wants to", or its last
 * part when the first speaks of them ("quit his job and go full-time…": an opener never says "his").
 */
function theirPlan(sentence: string): LineTopic | null {
  const match = THEIR_PLAN.exec(sentence);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  let rest = clause(match[2], true);
  if (rest !== null && THIRD_PERSON_WORD.test(rest)) {
    const lastPart = rest.split(/\s+and\s+/).at(-1) ?? '';
    rest = lastPart === rest || THIRD_PERSON_WORD.test(lastPart) ? null : lastPart;
  }
  if (rest === null || rest === '') return null;
  const who = match[1].toLowerCase();
  const text = `your ${who}'s plan to ${rest}`;
  return readsAsSubject(text) ? { text, question: false, score: 3 + topicWords(rest).length } : null;
}

/** What a plan or a decision is to do ({@link clause}), when it names something ("talk about it soon" names nothing). */
function toDo(text: string): string | null {
  const rest = clause(text, true);
  return rest !== null && topicWords(rest).some((w) => !namesNothing(w) && !DISCOURSE_WORDS.has(w))
    ? rest
    : null;
}

/**
 * Distress, as what a plan, a question or an activity does (the review of 1cac704: "I'm honestly burning out on this
 * startup" opened "Hi Maya, shall we pick up burning out on this startup?"): burning out, breaking down, falling
 * apart, ending it, needing to talk to someone. A line that says one names nothing to pick up.
 */
const DISTRESS =
  /^(?:burn(?:s|ed|t|ing)?\s+out|cry|cries|cried|crying|(?:break(?:s|ing)?|broke)\s+down|(?:fall(?:s|ing)?|fell)\s+apart|(?:los(?:e|es|ing)|lost)\s+it|freak(?:s|ed|ing)?\s+out|die|dies|died|dying|panic\w*|despair\w*|drown\w*|(?:talk|speak)(?:s|ing)?\s+to\s+(?:someone|somebody|anyone|anybody)|end(?:s|ed|ing)?\s+(?:it|things|everything|my\s+life|myself))(?![\p{L}'])/iu;
/**
 * Withdrawing: venting when nothing named follows it ("I really want to give up on this", "I need to step back",
 * "I want to quit"), a plan of the venture when something does ("give up the office lease", "stop the free pilot",
 * "step back from day-to-day operations").
 */
const WITHDRAWING =
  /^(?:(?:giv(?:e|es|ing)|gave)\s+up|quit(?:s|ting)?|stop(?:s|ped|ping)?|end(?:s|ed|ing)?|leav(?:e|es|ing)|kill(?:s|ed|ing)?|step(?:s|ped|ping)?\s+(?:back|away|down|aside)|(?:run(?:s|ning)?|ran|get(?:s|ting)?|got|walk(?:s|ing|ed)?)\s+away|shut(?:s|ting)?\s+(?:it\s+|everything\s+)?down|tak(?:e|es|ing)\s+a\s+break|disappear(?:s|ed|ing)?|hid(?:e|es|ing))(?![\p{L}'])\s*(.*)$/iu;
/**
 * Struggling or failing: venting when nothing named follows it ("struggling with everything"), else the thing is what
 * to pick up, never the struggle ("We're struggling to close Hartwell" is about Hartwell, "We failed the security
 * audit" about the security audit).
 */
const STRUGGLING = /^(?:struggl|suffer|hurt|fail)\w*(?![\p{L}'])\s*(.*)$/iu;
/** Words that name no one and nothing in particular. */
const INDEFINITE = new Set(
  'someone somebody anyone anybody everyone everybody something anything everything nothing things stuff all'.split(
    ' ',
  ),
);

/** Whether `text` names something in particular (not "this", "all this", "everything", "up", "again"). */
function namesSomething(text: string): boolean {
  return text.split(/\s+/).some((w) => {
    const word = bare(w);
    return (
      word !== '' &&
      !namesNothing(w) &&
      !INDEFINITE.has(word) &&
      !PARTICLES.has(word) &&
      !DISCOURSE_WORDS.has(word) &&
      !UNFINISHED.has(word)
    );
  });
}

/**
 * Whether a topic (`topicOf`'s text) is the founder venting, not something to pick up: `line` when the line then names
 * nothing ({@link DISTRESS}, or withdrawing or struggling with nothing named), `topic` when what they struggle with
 * is what to name ({@link STRUGGLING}), null when it is no venting.
 */
function vents(text: string): 'line' | 'topic' | null {
  // Someone else's plan is theirs to talk about ("your cofounder's plan to quit").
  if (/^your\s+[\p{L}-]+(?:\s+[\p{L}-]+)?['’]s\s/u.test(text)) return null;
  const done = (
    /^(?:your\s+(?:plans?|decision|goal|aim|idea|target|priority|worry|concern|problem)\s+(?:to|of)|whether\s+to|whether\s+you(?:\s+can)?|(?:how|what|when|where|which|who)\s+to)\s+(.+)$/i.exec(
      text,
    )?.[1] ?? text
  ).trim();
  if (DISTRESS.test(done)) return 'line';
  const withdrawing = WITHDRAWING.exec(done);
  if (withdrawing !== null) return namesSomething(withdrawing[1] ?? '') ? null : 'line';
  const struggling = STRUGGLING.exec(done);
  if (struggling !== null) return namesSomething(struggling[1] ?? '') ? 'topic' : 'line';
  return null;
}

const LEAD_IN =
  /^(?:(?:so|and|but|ok|okay|hey|hi|hello|well|also|actually|honestly|basically|anyway|anyways|maybe|probably|perhaps|really|yeah|um|uh|i mean|quick one|quick question|one more thing)\b[\s,.!:;-]*)+/i;

/**
 * The topic of a founder line, summarised, never quoted (see the module comment): a yes/no question becomes
 * "whether to …" / "whether you …", a "how / what should we …" question "how to …", a decision or a plan "your
 * decision to …" / "your plan to …", anything else its most telling noun phrase. Null when nothing names a topic.
 */
export function topicOf(line: string): LineTopic | null {
  const sentences = line
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/);
  let best: LineTopic | null = null;
  for (const raw of sentences) {
    const sentence = raw.replace(LEAD_IN, '').trim();
    if (topicWords(sentence).length === 0 || TIME_BUDGET.test(sentence)) continue;
    let found: LineTopic | null = null;
    const yesNo = /^(should|shall|can|could|do|would)\s+(?:we|i)\s+(.+?)\??$/i.exec(sentence);
    const wh =
      /^(how|what|which|when|where|who)\s+(?:should|do|can|could|would|shall)\s+(?:we|i)\s+(.+?)\??$/i.exec(
        sentence,
      );
    // An adverb can sit before the verb ("I still need to…", "We've finally decided to…").
    const decided = DECIDED.exec(sentence);
    const planned = PLANNING.exec(sentence) ?? PLANS_TO.exec(sentence);
    const inverted = invertedQuestion(sentence);
    if (inverted === UNSPLIT) continue;
    if (inverted !== null) {
      found = { text: inverted, question: true, score: 4 + topicWords(inverted).length };
    } else if (yesNo?.[1] !== undefined && yesNo[2] !== undefined) {
      const rest = clause(yesNo[2], true);
      const verb = yesNo[1].toLowerCase();
      if (rest !== null && verb !== 'would') {
        const lead =
          verb === 'should' || verb === 'shall'
            ? 'whether to'
            : verb === 'do'
              ? 'whether you'
              : 'whether you can';
        found = { text: `${lead} ${rest}`, question: true, score: 4 + topicWords(rest).length };
      }
    } else if (wh?.[1] !== undefined && wh[2] !== undefined) {
      const rest = clause(wh[2], true);
      if (rest !== null)
        found = {
          text: `${wh[1].toLowerCase()} to ${rest}`,
          question: true,
          score: 4 + topicWords(rest).length,
        };
    } else if (decided?.[1] !== undefined) {
      const rest = toDo(decided[1]);
      if (rest !== null)
        found = { text: `your decision to ${rest}`, question: false, score: 4 + topicWords(rest).length };
    } else if (planned?.[1] !== undefined) {
      const rest = toDo(planned[1]);
      if (rest !== null)
        found = { text: `your plan to ${rest}`, question: false, score: 3 + topicWords(rest).length };
    } else {
      found = theirPlan(sentence) ?? doing(sentence) ?? activity(sentence);
    }
    // A line that vents names nothing to pick up, in none of its sentences ("I really want to give up on this"); what
    // a founder struggles with is named for itself ("Hartwell"), never the struggle.
    const venting = found === null ? null : vents(found.text);
    if (venting === 'line') return null;
    if (venting === 'topic') found = null;
    // What does not read as a subject is not one ("your plan to a few minutes…"): the sentence's phrases are tried.
    if (found !== null && !readsAsSubject(found.text)) found = null;
    if (found === null) {
      const phrase = nounPhrase(sentence);
      if (phrase !== null) found = { text: phrase.text, question: false, score: phrase.score };
    }
    if (found !== null && found.text.length <= 70 && (best === null || found.score > best.score))
      best = found;
  }
  if (best === null) return null;
  // Tidied ("idk" is said "maybe"), then without the discourse words that leaves at its ends.
  const text = withoutDiscourseWords(tidyFounderWords(best.text));
  return text === '' ? null : { ...best, text };
}
