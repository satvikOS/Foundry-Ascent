/**
 * How a reply starts, and how often it names the founder: two habits no prompt rule fixed.
 *
 * Stock openers. Live pilot 42124259353 (after the prompt banned them by name): 133 replies of 600 opened with a stock
 * line, 22.8 per 100: a verdict on the founder's message ("That's a solid plan.", "That's a good instinct."), a thank-you
 * for it ("Thanks for the update."), praise ("Perfect.", "Great —") or "I hear you". The prompt listing them did not stop
 * the model, and its own history taught it the habit back. So the reply's first clauses are read on the way out: while a
 * clause is only such a line it is left out, and the reply starts with its substance ({@link withoutStockOpener}); the
 * history then holds replies that start with the substance too. A reply that is nothing but the line keeps it (a thanks
 * answered "You're welcome." is not touched: that is no stock opener). A verdict the founder asked for ("Does that sound
 * like a solid plan?" → "It does.") is an answer, not an opener, and stays ({@link asksForVerdict}).
 *
 * The founder's name. Live pilot 42124259353: name overuse in 15 of 60 runs ("You're very welcome, Alessandro." five
 * replies running). A name said to the founder ("…, Maya.", "Maya, …", "Thanks, Maya") is left out of a reply while one
 * of the last three replies already named them ({@link nameUsedRecently}, {@link withoutVocativeName}): at most one reply
 * in four uses it, as the voice rules ask. A name the reply talks about rather than to ("Maya's pilot") stays.
 */

import { founderMoves, reportsCommitmentDone } from '../prompts/conversation-state.js';

function normalise(text: string): string {
  return text.normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Praise or enthusiasm as a whole clause ("Perfect.", "Great —", "Love that!", "Nice work."). */
const PRAISE = String.raw`(?:great|perfect|excellent|fantastic|awesome|wonderful|brilliant|amazing|lovely|superb|nice|good|great stuff|nice one|nice work|good work|great work|well done|love (?:that|this|it)|i love (?:that|this|it)|i like (?:that|this)|wow|ooh)`;

/** "Great question", "That's a fair question", "What a good idea". */
const GOOD_QUESTION = String.raw`(?:(?:that's|that is|what) )?(?:a |an )?(?:really |very )?(?:great|good|excellent|fair|smart|brilliant|important|interesting|sharp|thoughtful|big) (?:question|one|point|idea)`;

/** Adjectives of a verdict on the founder's message. */
const VERDICT_ADJ = String.raw`(?:solid|great|good|strong|smart|fair|valid|clear|key|important|big|useful|interesting|excellent|fantastic|real|helpful|reasonable|sensible|promising|clever|thoughtful|healthy|natural|exciting|positive|wise|smart|sharp|nice|encouraging|impressive|meaningful|concrete|practical)`;

/** What the verdict is about ("plan", "first step", "commitment signal"). */
const VERDICT_NOUN = String.raw`(?:plan|start|step|first step|next step|question|point|move|instinct|idea|approach|call|insight|observation|catch|update|decision|choice|concern|foundation|signal|commitment signal|demand signal|result|sign|progress|win|milestone|direction|piece of evidence|data point|outcome|place to start|way to (?:think about|look at|frame) (?:it|this|that)|thing to (?:do|check|ask|notice)|read|framing|test|experiment|anchor|baseline|number|figure|goal|target|takeaway|realisation|realization|reflection|catch|breakthrough|structure|set of numbers|bit of news|news)`;

/**
 * A verdict on what they said ("That's a solid plan", "That sounds like a strong start", "This is a really good
 * instinct", "You're on the right track", "Smart move").
 */
const VERDICT = String.raw`(?:(?:that|this|it)(?:'s| is| sounds| seems| looks| feels)(?: like)?(?: (?:a|an))?(?: (?:really|very|truly|super|pretty|such a|genuinely|definitely))? ${VERDICT_ADJ}(?: (?:first|next|early|real))?(?: ${VERDICT_NOUN})?|(?:a|an)?(?: really| very)? ${VERDICT_ADJ} ${VERDICT_NOUN}|you(?:'re| are) (?:on the right track|heading in the right direction|thinking about (?:this|it) the right way|asking the right question)|(?:smart|good|great|nice|solid) (?:move|call|thinking|catch)|(?:that|this) is (?:great|good|excellent|exciting|encouraging|promising) (?:news|to hear)|(?:that's|that is) (?:great|good|excellent|exciting|encouraging|promising)(?: news| to hear)?|(?:good|great|nice|glad|happy) to hear(?: (?:that|it|this))?|(?:i'm |i am )?glad (?:to hear (?:that|it|this)|you (?:asked|shared that|did that))|(?:that's|that is) (?:exactly )?(?:the right (?:question|move|call|instinct|idea|place to start))|(?:that's|that is) (?:huge|big|real) progress)`;

/** Thanks for their message ("Thanks for the update", "Thank you for sharing that"). */
const THANKS = String.raw`(?:(?:thanks|thank you)(?: so much| again| a lot)?(?: for (?:sharing(?: (?:that|this|those|the \w+|your \w+))?|that|this|the (?:update|context|details?|clarification|info|information|question|numbers|background|follow-up|detail|rundown|recap)|your (?:update|question|honesty|patience)|clarifying|explaining|telling me|letting me know|laying (?:that|it|this|those) out|bringing (?:this|that|it) (?:up|to me)|walking me through (?:that|it|this|those)|being (?:so )?(?:honest|open|candid|clear)|the quick reply|getting back(?: to me)?|the heads[- ]up|coming back))?)`;

/** "I hear you", "I hear the frustration", "I can hear how much…" kept short. */
const I_HEAR = String.raw`(?:i (?:totally |really |completely )?(?:hear|get|feel) (?:you|that|ya|where you're coming from)|i hear (?:the|your) (?:frustration|worry|concern|stress|excitement))`;

/**
 * A preamble about the reply itself, as a whole clause ("I see.", "Here's my honest read:", "Good to talk again."):
 * the rest of craft.ts `STOCK_OPENERS`, which the prompt no longer quotes. "It sounds like…" and "I remember…" lead
 * into substance and are never a whole clause to leave out; the prompt describes them as habits instead.
 */
const PREAMBLE = String.raw`(?:i see|i understand|understood|here's (?:my|the) (?:honest |quick |short )?(?:read|take)(?: on (?:this|that|it))?|my (?:honest |quick )?(?:read|take)|good to (?:talk|chat|hear from you|see you) again)`;

/** A whole clause that is only a stock opener (normalised, without the founder's name). */
const STOCK_CLAUSE = new RegExp(
  String.raw`^(?:(?:oh|ok|okay|so|well|and|alright|right|yes|yeah)[ ,]+)?(?:${PRAISE}|${GOOD_QUESTION}|${VERDICT}|${THANKS}|${I_HEAR}|${PREAMBLE})(?: (?:too|again|indeed|then|there|here|already|overall))?$`,
  'u',
);

/**
 * Empathy as a whole clause ("I hear you.", "Thanks for being honest.", "I understand."): kept on a turn of stress or
 * hesitation, and on a flagged turn (review of coaching v2: "show empathy proportionately"); praise and verdicts still go.
 */
const EMPATHY_CLAUSE = new RegExp(
  String.raw`^(?:(?:oh|ok|okay|so|well|and|alright|right|yes|yeah)[ ,]+)?(?:${THANKS}|${I_HEAR}|i understand|understood)(?: (?:too|again|indeed|then|there|here|already|overall))?$`,
  'u',
);
/** "Absolutely", "Definitely": an answer to a question they asked, else enthusiasm. */
const ANSWER_PRAISE = /^(?:absolutely|definitely|totally|for sure)$/u;

/** A question about the coach's own day, weekend or how it is: small talk, answered in kind. */
const SMALL_TALK =
  /\bhow (?:are|r) (?:you|u)\b|\bhow(?:'s| is| was| has) (?:your|ur) (?:day|week|weekend|morning|evening|night|holiday|break|trip)\b|\b(?:good|nice|fun|busy|relaxing) (?:weekend|day|week|holiday|break)\?|\bwhat(?:'s| is| did) you (?:up to|do (?:this|last) (?:weekend|week))\b/u;

/** The founder reports how something went ("update on…", "done", "it went well"): a reaction may come first. */
const REPORT_WORDS =
  /\b(?:update|news|done|did it|finished|it went|went (?:well|badly|ok|okay|great)|results? (?:are|came) in)\b/u;

/** Praise or a verdict: kept as the reaction to news or to a report of what they did ("That's big news.", "Nice."). */
const REACTION_CLAUSE = new RegExp(
  String.raw`^(?:(?:oh|ok|okay|so|well|and|alright|right|yes|yeah)[ ,]+)?(?:${PRAISE}|${VERDICT})(?: (?:too|again|indeed|then|there|here|already|overall))?$`,
  'u',
);

/** The same, but a verdict alone (kept when the founder asked for one: {@link asksForVerdict}). */
const VERDICT_CLAUSE = new RegExp(
  String.raw`^(?:(?:oh|ok|okay|so|well|and|alright|right|yes|yeah)[ ,]+)?(?:${VERDICT}|${GOOD_QUESTION})(?: (?:too|again|indeed|then|there|here|already|overall))?$`,
  'u',
);

/**
 * The founder asked for a verdict on their plan or claim ("does that sound like a solid plan?", "am I on the right
 * track?", "is that a good idea?", "thoughts?"): then a verdict opening the reply answers them and stays.
 */
export function asksForVerdict(founderText: string): boolean {
  const t = normalise(founderText);
  if (!t.includes('?') && !/\bthoughts\b|\bwhat do you think\b/.test(t)) return false;
  return /\b(?:does (?:that|this|it|my \w+) (?:sound|seem|look|feel)|is (?:that|this|it|my \w+) (?:a |an |the )?(?:good|right|solid|smart|reasonable|fair|ok|okay|enough|sensible|strong|realistic|bad|wise)|am i (?:on the right track|right|wrong|crazy|overthinking)|(?:sound|seem|look)s? (?:good|right|ok|okay|reasonable|solid)\?|good (?:plan|idea|start|move)\?|right\?|make sense\?|what do you think|thoughts\b|your (?:take|view|verdict|opinion)|how (?:does|do) (?:that|this|it|they) (?:sound|look)|is (?:that|this) (?:the right|a good) (?:call|move|plan|idea|approach))/.test(
    t,
  );
}

/** A clause of the reply's start: its text and everything up to the next clause (its punctuation and spaces). */
const FIRST_CLAUSE = /^([^,.!?…;:\n—–]+?)\s*([,.!?…;:—–]+["'”’)\]*_]*\s*|\s+[—–-]\s+|$)/u;

function withoutNames(clause: string, names: readonly string[]): string {
  let text = normalise(clause).replace(/[!.…,;:\s]+$/u, '');
  for (const name of names) {
    const forms = [name, name.split(/\s+/)[0] ?? ''].filter((n) => n.length >= 2).map((n) => normalise(n));
    for (const form of forms) {
      text = text.replace(new RegExp(`(?:^|[\\s,]+)${escapeRegExp(form)}(?=$|[\\s,!.])`, 'gu'), ' ').trim();
    }
  }
  return text.replace(/^[,\s]+|[,\s]+$/gu, '').replace(/\s+/g, ' ');
}

export interface OpenerRewrite {
  /** The reply without its stock opener (unchanged when nothing was left out, or when nothing else would be left). */
  readonly text: string;
  /** A stock opener was left out. */
  readonly removed: boolean;
  /** The text was nothing but a stock opener (then `text` is unchanged, and `removed` false). */
  readonly onlyOpener: boolean;
}

/**
 * `text` without the stock opener it starts with (see the module comment): clauses are left out from the start while
 * each is only praise, a verdict on the founder's message, a thank-you for it or "I hear you" (with the founder's
 * `names` at most). A verdict stays when the founder asked for one (`founderText`, {@link asksForVerdict}). What is
 * left starts a sentence. A text that is nothing but the opener is returned as it is (`onlyOpener`): the caller decides
 * (a streamed unit waits to see whether more follows).
 */
export function withoutStockOpener(
  text: string,
  options: {
    readonly names?: readonly string[];
    readonly founderText?: string;
    /** The turn is flagged (risk categories, a crisis, a forced escalation): empathy is never left out. */
    readonly flagged?: boolean;
  } = {},
): OpenerRewrite {
  const names = (options.names ?? []).filter((n) => n.trim() !== '');
  const founder = options.founderText;
  // Read only against the message it answers: without one there is nothing to tell an opener from an answer.
  if (founder === undefined) return { text, removed: false, onlyOpener: false };
  const moves = founderMoves(founder);
  // Small talk is answered in kind ("How are you?" → "Good, thanks!"), and thanks or a goodbye too.
  if (
    moves.some((m) => m === 'greeting' || m === 'thanks' || m === 'closing' || m === 'humour') ||
    SMALL_TALK.test(normalise(founder))
  ) {
    return { text, removed: false, onlyOpener: false };
  }
  const keepVerdict = asksForVerdict(founder);
  // Distress, hesitation or a flagged matter: "I hear you." is the proportionate start, not a habit.
  const keepEmpathy = options.flagged === true || moves.some((m) => m === 'stress' || m === 'hesitant');
  // News, or a report of what they did, gets a reaction first (LAB-R8): "That's big news." is no stock opener there.
  const keepReaction =
    moves.includes('news') || reportsCommitmentDone(founder) || REPORT_WORDS.test(normalise(founder));
  const asked = founder.includes('?');
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  // Emphasis around the opener ("**Great.**") goes with it.
  let rest = text.slice(lead.length);
  let removed = false;
  for (let i = 0; i < 4; i += 1) {
    const plain = rest.replace(/^[*_]+/, '');
    const clause = FIRST_CLAUSE.exec(plain);
    if (clause?.[1] === undefined) break;
    const words = withoutNames(clause[1], names);
    if (words === '' && !removed) break; // a bare name is an address, not an opener
    const stock =
      words === '' ||
      (STOCK_CLAUSE.test(words) &&
        !(keepVerdict && VERDICT_CLAUSE.test(words)) &&
        !(keepEmpathy && EMPATHY_CLAUSE.test(words)) &&
        !(keepReaction && REACTION_CLAUSE.test(words))) ||
      (!asked && ANSWER_PRAISE.test(words));
    if (!stock) break;
    rest = plain.slice(clause[0].length).replace(/^[*_]+\s*/, '');
    removed = true;
    if (rest.trim() === '') break;
  }
  if (!removed) return { text, removed: false, onlyOpener: false };
  // What is left starts a sentence: a connector that leaned on the opener goes ("…plan, and the price…").
  const trimmed = rest.replace(/^[\s,;:—–-]+/u, '').replace(/^and\s+(?=\p{L})/iu, '');
  if (!/\p{L}|\p{N}/u.test(trimmed)) return { text, removed: false, onlyOpener: true };
  const capital = trimmed.replace(
    /^([*_"“(]*)(\p{Ll})/u,
    (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`,
  );
  return { text: `${lead}${capital}`, removed: true, onlyOpener: false };
}

// The founder's name ------------------------------------------------------------------------------------------

/** How many of the latest replies are read for the name (one reply in four may use it). */
export const NAME_WINDOW = 3;

function namePattern(name: string): string {
  return escapeRegExp(name.trim());
}

/**
 * Whether one of the latest {@link NAME_WINDOW} replies (`replies`, newest first) names the founder (`firstName`):
 * then this reply leaves the name out.
 */
export function nameUsedRecently(
  firstName: string | null | undefined,
  replies: readonly (string | null | undefined)[],
): boolean {
  const name = firstName?.trim() ?? '';
  if (name.replace(/[^\p{L}]/gu, '').length < 2) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}'’])${namePattern(name)}(?![\\p{L}\\p{N}]|['’]s\\b)`, 'u');
  return replies
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
    .slice(0, NAME_WINDOW)
    .some((r) => re.test(r));
}

/** Words that may stand before a name said to the founder, and stay when it goes ("Thanks, Maya" → "Thanks"). */
const ADDRESS_LEAD =
  '(?:hi|hey|hello|thanks|thank you|good luck|congrats|congratulations|okay|ok|sure|great|perfect|nice|well done|welcome back|morning|good morning|right|got it|of course|absolutely|exactly|you got it)';

/** `source` (letters, spaces and groups only) matching in any case, under flags without `i`. */
function anyCase(source: string): string {
  return source.replace(/\p{L}/gu, (c) => {
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    return lower === upper ? c : `[${lower}${upper}]`;
  });
}

/** {@link ADDRESS_LEAD} in any case, for a name matched case-sensitively. */
const ADDRESS_LEAD_ANY_CASE = anyCase(ADDRESS_LEAD);

/**
 * `text` without the founder's name where it is said to them: "Maya, the pilot…" → "The pilot…", "…, Maya." → "….",
 * "Thanks, Maya!" → "Thanks!", "Good luck Maya" → "Good luck". A name talked about ("Maya's pilot", "ask Maya") stays.
 * Case matters (a name is capitalised) unless `spoken`.
 */
export function withoutVocativeName(
  text: string,
  firstName: string | null | undefined,
  options: { readonly spoken?: boolean } = {},
): { readonly text: string; readonly removed: number } {
  const name = firstName?.trim() ?? '';
  if (name.replace(/[^\p{L}]/gu, '').length < 2) return { text, removed: 0 };
  const flags = options.spoken === true ? 'giu' : 'gu';
  // The words before an address are matched in any case ("thanks maya"); the name as `flags` says.
  const n = namePattern(name);
  let removed = 0;
  const count = (): void => {
    removed += 1;
  };
  let out = text;
  // A lead word then the name ending its clause: "Thanks, Maya!", "Good luck Maya." (the name only). The lead word in
  // any case, the name as `flags` say: a founder called Will keeps "Okay, will you send it?" (review of coaching v2).
  out = out.replace(
    new RegExp(
      `(?<![\\p{L}])(${ADDRESS_LEAD_ANY_CASE})(?:,\\s*|\\s+)${n}(?![\\p{L}\\p{N}'’])(?=\\s*(?:[.!?…,;:—–)]|$))`,
      flags,
    ),
    (_m, word: string) => {
      count();
      return word;
    },
  );
  // The name opening a sentence: "Maya, the pilot…" / "Maya — the pilot…".
  out = out.replace(
    new RegExp(`(^|[.!?…]\\s+|\\n\\s*)${n}\\s*(?:,|—|–| - )\\s*([*_"“]*)(\\p{L})`, flags),
    (_m, pre: string, emphasis: string, c: string) => {
      count();
      return `${pre}${emphasis}${c.toUpperCase()}`;
    },
  );
  // The name closing a clause or a sentence: "…, Maya." / "…, Maya —".
  out = out.replace(new RegExp(`\\s*,\\s*${n}(?=\\s*(?:[.!?…,;:—–]|$))`, flags), () => {
    count();
    return '';
  });
  return { text: out, removed };
}
