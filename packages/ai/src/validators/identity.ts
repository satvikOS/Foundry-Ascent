import { firstNameOf, resolvePersonaIdentity } from '../prompts/persona.js';
import { COMMON_WORDS } from '../risk/common-words.js';
import { escapeRegExp, normalizeText } from '../risk/normalize.js';

/**
 * Identity validator ("amplify, never impersonate", system design §1). The coach is an AI. The
 * neutral guide speaks for no one. A vEIR persona ("Corin's vEIR", built with consent from one EIR's
 * approved doctrine and style) may say "I", use its persona name and refer to the EIR in the third
 * person ("Corin's approach…"), but it never claims to be a human, to be live, or to be the EIR (or any
 * other EIR), and it never claims that the EIR or anyone else reviewed, approved or endorsed anything.
 *
 * Change together with the prompt identity rules (`prompts/system.ts`) and the evals identity grader
 * (`evals/foundry_evals/graders/identity.py`).
 */
export type IdentityViolationKind = 'claims_human' | 'claims_eir' | 'endorsement';

export interface IdentityCheckOptions {
  /** Persona display name ("Foundry Guide", "Corin's vEIR"); never treated as a human name. */
  personaName: string;
  /** Names of EIRs / program staff the coach must never speak as (the persona's own EIR included). */
  eirNames?: readonly string[];
  /**
   * Display name of the EIR this persona is built from ("Corin Halvorsen"). Optional: for a persona named
   * "<first name>'s vEIR" it is the entry of `eirNames` with that first name, or the first name alone.
   */
  personaEirName?: string | null;
  /**
   * The text is said aloud on a call (`CoachResponse.spoken`). Case means nothing to text-to-speech, so
   * self-introductions and sign-offs match an EIR's first name in any case, even one that is also a word.
   */
  spoken?: boolean;
}

export interface IdentityFinding {
  kind: IdentityViolationKind;
  /** Pattern id, safe to log. */
  rule: string;
}

export interface IdentityRewrite {
  text: string;
  findings: IdentityFinding[];
}

interface IdentityPattern {
  kind: IdentityViolationKind;
  rule: string;
  pattern: RegExp;
  /** Extra check on a match; a rejected match is skipped (e.g. a question, or the persona's own name). */
  accept?: (text: string, index: number, match: string) => boolean;
}

const S = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
const APOS = "['’]";
/** After a name: not a possessive ("Corin's approach") and not a compound ("Corin-style"). */
const NOT_POSSESSIVE = `(?!${APOS}s${E}|-)`;
const EIR = '(?:eir|eirs|entrepreneur[- ]in[- ]residence)';
/** "It's Corin who…" points at the EIR; it is not a self-introduction. */
const NOT_RELATIVE = `(?!\\s+(?:who|whom|whose|that)${E})`;

function p(kind: IdentityViolationKind, rule: string, source: string, flags = 'giu'): IdentityPattern {
  return { kind, rule, pattern: new RegExp(`${S}(?:${source})${E}`, flags) };
}

const BASE_PATTERNS: readonly IdentityPattern[] = [
  // Claims to be a human.
  p(
    'claims_human',
    'i_am_human',
    `I(?:${APOS}m| am) (?:also |actually |really |just )?(?:a |an )?(?:real |actual |living |flesh[- ]and[- ]blood )?(?:human(?: being)?|person|man|woman)`,
  ),
  p(
    'claims_human',
    'not_an_ai',
    `I(?:${APOS}m| am) not (?:an? |just an? |some )?(?:ai|a\\.i\\.|bot|robot|chatbot|machine|program|language model|llm|computer|software|virtual assistant)`,
  ),
  p(
    'claims_human',
    'as_a_human',
    'as a (?:fellow )?(?:human(?: being)?|person|founder|entrepreneur|investor|vc|parent|woman|man),? I',
  ),
  p(
    'claims_human',
    'personal_history',
    '(?:when|back when|years ago) I (?:was a founder|founded|started my|ran my|built my|raised (?:my|our)|sold my|exited|worked at|invested in)',
  ),
  p(
    'claims_human',
    'my_own_venture',
    'my (?:own (?:startup|company|venture)|portfolio compan(?:y|ies)|(?:first|last|previous) (?:startup|company|venture|exit)|exits|fund)',
  ),
  p(
    'claims_human',
    'in_my_career',
    `in my (?:own )?(?:experience|career|years|time) as an? (?:founder|investor|${EIR}|entrepreneur|mentor|operator|ceo|vc)`,
  ),
  // Claims to be live, or that a person is on the other end.
  p(
    'claims_human',
    'claims_live',
    [
      `I(?:${APOS}m| am) (?:a )?live (?:person|human|mentor|coach)`,
      `I(?:${APOS}m| am) (?:here )?live (?:with you|on (?:the|this) call)`,
      `you(?:${APOS}re| are) (?:talking|speaking|chatting) (?:to|with) (?:a |an )?(?:real|live|actual) (?:person|human(?: being)?|mentor|coach|${EIR})`,
      '(?:a |an )?(?:real|live|actual) (?:person|human(?: being)?) is (?:here|listening|reading this|on the (?:line|call))',
    ].join('|'),
  ),
  // Claims to be (or speak as) an EIR / mentor.
  p(
    'claims_eir',
    'as_your_eir',
    `as (?:your|an|the|a) (?:${EIR}|human (?:coach|advisor|mentor))|as your (?:mentor|advisor|program lead)`,
  ),
  p(
    'claims_eir',
    'i_am_eir',
    `I(?:${APOS}m| am) (?:your|an|the|a) (?:${EIR}|human (?:coach|advisor|mentor)|mentor|program lead)`,
  ),
  p('claims_eir', 'this_is_eir', `(?:this is|it${APOS}s) (?:your )?${EIR}`),
  // Personal approval / endorsement, and approval attributed to an EIR.
  p(
    'endorsement',
    'i_approve',
    'I (?:personally |hereby |fully |officially |formally )?(?:approve|endorse|sign off on|vouch for|certify|stand behind|give (?:my|this) (?:approval|endorsement|blessing|sign-off|stamp of approval))',
  ),
  p(
    'endorsement',
    'i_have_approved',
    `(?:I|we)(?:${APOS}ve| have) (?:personally |already |officially )?(?:approved|endorsed|signed off on|vetted|certified)`,
  ),
  p(
    'endorsement',
    'my_approval',
    `(?:you have|you${APOS}ve got|you${APOS}ve|this has|it has|this gets|you get|has) my (?:approval|endorsement|blessing|sign-off|stamp of approval|seal of approval)`,
  ),
  p(
    'endorsement',
    'i_personally',
    'I personally (?:approve|endorse|recommend investing|invested|back|guarantee)',
  ),
  p(
    'endorsement',
    'eir_approved',
    `(?:the |your |an |our |my )?(?:${EIR}|mentors?|program (?:lead|team|staff)) (?:has |have |had )?(?:already |officially )?(?:approved|endorsed|signed off(?: on)?|vetted|blessed|green-?lit|greenlit|agreed with|backs|backed|is on board with)`,
  ),
  p(
    'endorsement',
    'approved_by_eir',
    `(?:approved|endorsed|signed off|vetted|blessed|green-?lit) by (?:the |your |an |our |my )?(?:${EIR}|mentors?|program (?:lead|team|staff))`,
  ),
];

/** "Sarah here, …" at the start of the answer or a line (case-sensitive name heuristic). */
const GENERIC_NAME_HERE =
  /(?:^|\n)\s*(?:(?:Hi|Hello|Hey)(?: there)?[,!.]?\s+)?(\p{Lu}\p{Ll}+(?:\s\p{Lu}\p{Ll}+)?)\s+here\s*[,—–-]/gu;
const NAME_STOPLIST = new Set([
  'nothing',
  'everything',
  'something',
  'anything',
  'more',
  'details',
  'context',
  'help',
  'evidence',
  'summary',
  'question',
  'note',
  'answer',
  'focus',
  'progress',
  'feedback',
  'caution',
  'data',
  'risk',
  'everyone',
  'start',
  'stop',
  'pause',
  'pricing',
  'key',
  'what',
  'which',
]);

/**
 * First names that are also everyday words ("frank feedback", "it rose"). In typed text such a name
 * matches only when capitalised; any other name also matches in lower case ("i am corin").
 */
const NAME_WORDS = new Set(
  `amber angel april august autumn bliss bob brook buck carol carter chase charity cliff cooper daisy dale
dawn dean drew earl faith frank gene ginger glen grace guy hazel heather holly hunter iris ivy jack jade
joy june king lane lily mark mason max mercy miles olive page parker pat patience pearl porter prince
rain ray reed rich river rob rod rose ruby rusty sage sandy sky storm sue sunny tucker violet wade`.split(
    /\s+/,
  ),
);

/** A phrase matched case-insensitively inside a case-sensitive regex ("i'm" → "[Ii]['’][Mm]"). */
function caseless(phrase: string): string {
  return phrase
    .split("'")
    .map((part) =>
      Array.from(part)
        .map((ch) => {
          const lo = ch.toLowerCase();
          const up = ch.toUpperCase();
          return lo === up ? escapeRegExp(ch) : `[${lo}${up}]`;
        })
        .join(''),
    )
    .join(APOS);
}

/** Lead-ins that introduce oneself as somebody. */
const SELF_LEADS = [
  "i'm",
  'i am',
  'my name is',
  'speaking as',
  'signed',
  'this is',
  "it's",
  'it is',
  "you're talking to",
  "you're talking with",
  "you're speaking to",
  "you're speaking with",
  "you're chatting with",
  'you are talking to',
  'you are talking with',
  'you are speaking to',
  'you are speaking with',
  'you are chatting with',
];
/** For first names that are also common words ("Will", "Grace"): only unmistakable self-introductions. */
const STRICT_SELF_LEADS = ["i'm", 'i am', 'my name is', 'speaking as'];
const SIGN_OFFS = [
  'best',
  'best regards',
  'best wishes',
  'kind regards',
  'warm regards',
  'regards',
  'cheers',
  'sincerely',
  'warmly',
  'thanks',
  'thank you',
  'talk soon',
  'speak soon',
  'yours',
];
const ENDORSE_VERBS =
  '(?:approved|endorsed|signed off(?: on)?|reviewed and (?:approved|endorsed|signed off(?: on)?)|vetted|validated|vouched for|blessed|backs|backed|green-?lit|greenlit|agreed with|agrees with|is on board with|(?:reviewed|looked over|looked at|read|seen|checked) (?:your|this|these|that|it|the plan|the deck|the pitch|our))';
const OPINION_VERBS =
  '(?:thinks|believes|feels|likes|loves|is (?:excited|impressed|happy|pleased|thrilled) (?:about|by|with)) (?:your|this plan|this idea|this deck|this pitch)';
/** Where a person is said to be present, other than "here" and "listening" (see below). */
const PRESENT_PLACE =
  '(?:on (?:the|this) (?:call|line)|in (?:this|the) (?:call|chat|conversation|room)|joining (?:us|you|this|the call)|reading this)';
/** What may follow a presence claim in the same clause ("…listening in, right now, with us"). */
const PRESENT_TAIL = `(?:\\s+(?:with (?:us|you)|right now|now|today|too|as well|live|in|along|to (?:us|you)|${PRESENT_PLACE}))*`;
/** The clause ends: punctuation, a spaced dash, a line break or the end of the text. */
const CLAUSE_END = '(?=\\s*(?:[,.;:!?…)—–]|-\\s|\\n|$))';
/** "is listening" means presence only when it ends the clause or goes on "in", "to this call", "with us"… */
const IS_LISTENING = `listening(?:${CLAUSE_END}|(?=\\s+(?:in|along|now|right now|live|to (?:this|the|our|your|us|you|me)|with (?:us|you))${E}))`;
/**
 * "<name> is here / listening / on the call…" and "<name>'s here…". The contraction is also a possessive
 * ("Corin's listening checklist", "Corin's here-and-now rule"), so after "'s" the phrase must end the
 * clause or go on with a presence tail ("with us", "right now", "on the call").
 */
function presentAfter(name: string): string {
  return [
    `${name} is (?:here(?!-)|${IS_LISTENING}|${PRESENT_PLACE})`,
    `${name}${APOS}s (?:here|listening|${PRESENT_PLACE})${PRESENT_TAIL}${CLAUSE_END}`,
  ].join('|');
}
/** End of the line: a signature stands alone on it. */
const LINE_END = '(?=[ \\t]*(?:\\n|$))';
const EMPHASIS = '(?:\\*\\*|__|\\*|_)?';

/** Characters that end a clause; a hyphen only as a spaced dash (" - "). */
function isClauseBreak(text: string, i: number): boolean {
  const ch = text.charAt(i);
  if (/[.!?\n,;:—–()…]/.test(ch)) return true;
  return ch === '-' && text.charAt(i - 1) === ' ' && text.charAt(i + 1) === ' ';
}

interface Clause {
  /** Text of the clause before the match. */
  prefix: string;
  /** The clause containing the match is a question. */
  question: boolean;
}

const QUESTION_LEAD =
  /^\s*(?:(?:and|but|so|or|then|now|well|ok|okay)\s+)?(?:has|have|had|did|does|do|is|was|were|will|would|could|can|should|may|might)\s+$/iu;

/**
 * The clause around [start, end). A question only when that clause is interrogative: it ends in "?", or
 * it opens with an inverted auxiliary ("Has Corin reviewed it, or not?"). "Corin has reviewed your plan,
 * so shall we…?" is a statement followed by a question.
 */
function clauseAround(text: string, start: number, end: number): Clause {
  let s = start;
  while (s > 0 && !isClauseBreak(text, s - 1)) s -= 1;
  let e = end;
  while (e < text.length && !isClauseBreak(text, e)) e += 1;
  const prefix = text.slice(s, start);
  if (text.charAt(e) === '?') return { prefix, question: true };
  if (!QUESTION_LEAD.test(prefix)) return { prefix, question: false };
  let sentenceEnd = e;
  while (sentenceEnd < text.length && !/[.!?\n]/.test(text.charAt(sentenceEnd))) sentenceEnd += 1;
  return { prefix, question: text.charAt(sentenceEnd) === '?' };
}

/** Words before a match that can govern it (a hedge further back, or in another clause, does not). */
const HEDGE_WINDOW_WORDS = 4;
const NEGATION = /^(?:not|never|no|nobody|nothing|none|neither|nor|cannot|without|hardly)$|n['’]t$/iu;
/** Negations that affirm: "not only has Corin…", "no doubt Corin…", "it's no secret Corin…". */
const AFFIRMING = /^(?:only|doubt|question|secret|wonder|surprise)$/iu;
const CONDITION = /^(?:if|once|unless|whether|until|before|assuming|suppose|supposing|provided)$/iu;
const MODAL = /^(?:may|might|could|would|should|can|will|must)$/iu;

/**
 * Whether a hedge governs the match: a negation or condition among the last few words of its clause
 * ("Nothing here has been approved by Corin", "once Corin has seen your deck", "I don't think Corin…").
 * A modal counts only before a verb-first match ("it may have been approved by Corin"): in "I can
 * confirm Corin has approved it" or "You can tell investors Corin reviewed it" it governs another verb.
 */
function governedHedge(prefix: string, verbFirst: boolean): boolean {
  const words = prefix
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, ''))
    .filter((w) => w !== '')
    .slice(-HEDGE_WINDOW_WORDS);
  return words.some(
    (w, i) =>
      (NEGATION.test(w) && !AFFIRMING.test(words[i + 1] ?? '')) ||
      CONDITION.test(w) ||
      (verbFirst && MODAL.test(w)),
  );
}

/** A claim, not a question and not hedged ("Has Corin seen it?", "once Corin reviews it"). */
function assertive(text: string, index: number, match: string, verbFirst = false): boolean {
  const clause = clauseAround(text, index, index + match.length);
  return !clause.question && !governedHedge(clause.prefix, verbFirst);
}

/** Greetings and interjections that may open a "<name> here" clause ("Morning Maya, Corin here."). */
const HERE_LEAD =
  /^\s*(?:(?:hi|hello|hey|ok|okay|so|well|right|alright|morning|afternoon|evening|good (?:morning|afternoon|evening))(?: there)?(?:\s+[\p{L}'’-]+)?\s*[,!.:;—–-]?\s*)*$/iu;

/** "<name> here" opens its clause (after any greeting) and is not a question. */
function opensClause(text: string, index: number, match: string): boolean {
  const clause = clauseAround(text, index, index + match.length);
  return !clause.question && HERE_LEAD.test(clause.prefix);
}

interface NameSpec {
  /** Full display name, normalised ("Corin Halvorsen"). */
  full: string;
  first: string;
  /** The rest of the name ("Halvorsen"), word by word; empty for a one-word name. */
  rest: string[];
}

function nameSpec(raw: string): NameSpec | null {
  const full = normalizeText(raw);
  if (full.replace(/[^\p{L}]/gu, '').length < 3) return null;
  const words = full.split(' ');
  return { full, first: words[0] ?? '', rest: words.slice(1) };
}

type Exempt = (index: number, length: number) => boolean;

/**
 * Patterns for one EIR name.
 *
 * - The full name, case-insensitive: self-introductions, presence and every endorsement. Endorsements
 *   naming the full name are flagged unconditionally; presence only as an assertion.
 * - The first name alone (or a one-word name): self-introductions, sign-offs, "<name> here", presence and
 *   endorsements, the last two only as assertions (not in a question, and not governed by a negation or
 *   condition). "Corin's approach" and "I'm Corin's vEIR" never match. A first name that is also a word
 *   matches only when capitalised, except in spoken text; a common word ("Will") only in unmistakable
 *   self-introductions and sign-offs.
 *
 * `exempt` rejects matches that are the persona's own name.
 */
function namePatterns(spec: NameSpec, exempt: Exempt, spoken: boolean): IdentityPattern[] {
  const claim = (_text: string, index: number, match: string): boolean => !exempt(index, match.length);
  const asserted = (text: string, index: number, match: string): boolean =>
    !exempt(index, match.length) && assertive(text, index, match);
  const assertedVerbFirst = (text: string, index: number, match: string): boolean =>
    !exempt(index, match.length) && assertive(text, index, match, true);
  const here = (text: string, index: number, match: string): boolean =>
    !exempt(index, match.length) && opensClause(text, index, match);
  /** "here"/"speaking" followed by punctuation or the end: "Corin here.", never "Corin here would ask". */
  const hereTail = `\\s+(?:here|speaking)(?=\\s*(?:[,.;:!…—–-]|\\n|$))`;
  const out: IdentityPattern[] = [];

  if (spec.rest.length > 0) {
    // Full name, case-insensitive (the first name alone follows below).
    const body = [spec.first, ...spec.rest].map(escapeRegExp).join('\\s+');
    out.push(
      { ...p('claims_eir', 'named_eir_here', `${body}${hereTail}`), accept: here },
      {
        ...p(
          'claims_eir',
          'named_eir_self',
          `(?:this is|it${APOS}s|it is|I${APOS}m|I am|speaking as|my name is|signed,?|you(?:${APOS}re| are) (?:talking|speaking|chatting) (?:to|with)) ${body}${NOT_POSSESSIVE}${NOT_RELATIVE}`,
        ),
        accept: claim,
      },
      { ...p('claims_eir', 'named_eir_present', presentAfter(body)), accept: asserted },
      {
        ...p(
          'endorsement',
          'named_eir_approved',
          `${body} (?:has |had |have )?(?:already |personally |officially |just )?${ENDORSE_VERBS}`,
        ),
        accept: claim,
      },
      { ...p('endorsement', 'named_eir_opinion', `${body} ${OPINION_VERBS}`), accept: claim },
      {
        ...p(
          'endorsement',
          'approved_by_named_eir',
          `(?:approved|endorsed|signed off|vetted|validated|blessed|reviewed|green-?lit) by ${body}`,
        ),
        accept: claim,
      },
    );
  }

  // The first name alone (or a one-word name).
  if (spec.first.replace(/[^\p{L}]/gu, '').length < 3) return out;
  const lower = spec.first.toLowerCase();
  const common = COMMON_WORDS.has(lower);
  const anyCase = spoken || !(common || NAME_WORDS.has(lower));
  const word = (w: string): string => (anyCase ? caseless(w) : escapeRegExp(w));
  const restRe = spec.rest.map(word).join('\\s+');
  const nameRe = spec.rest.length === 0 ? word(spec.first) : `${word(spec.first)}(?:\\s+${restRe})?`;
  // Never fall back from a possessive full name to the bare first name ("I'm Corin Halvorsen's vEIR" is
  // not "I'm Corin").
  const notPossessive =
    spec.rest.length === 0 ? NOT_POSSESSIVE : `(?!${APOS}s${E}|-|\\s+${restRe}${APOS}s${E})`;
  const leads = (common ? STRICT_SELF_LEADS : SELF_LEADS).map(caseless).join('|');
  const signOffs = SIGN_OFFS.map(caseless).join('|');
  const signed = `${EMPHASIS}${nameRe}${notPossessive}${E}${EMPHASIS}[.!]?`;
  out.push(
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: new RegExp(`${S}(?:${leads}),? ${nameRe}${notPossessive}${E}${NOT_RELATIVE}`, 'gu'),
      accept: claim,
    },
    {
      // A signature: the name alone on its line (after a dash, or wrapped in emphasis), after a dash or a
      // sign-off at the end of a line ("Best,\nCorin", "Thanks. — Corin."), or standing alone as the last
      // sentence. The flattened forms are what a call's speakable text makes of a written sign-off.
      kind: 'claims_eir',
      rule: 'named_eir_signature',
      pattern: new RegExp(
        `(?:(?:^|\\n)[ \\t]*(?:[-—–]+[ \\t]*)?|(?<=[.!?…])[ \\t]+(?:[-—–]+[ \\t]*)?|[—–-][ \\t]*|${S}(?:${signOffs})[,.]*\\s+(?:[-—–]+[ \\t]*)?)${signed}${LINE_END}`,
        'gu',
      ),
      accept: claim,
    },
  );
  if (common) return out;
  out.push(
    {
      kind: 'claims_eir',
      rule: 'named_eir_here',
      pattern: new RegExp(`${S}${nameRe}${hereTail}`, 'gu'),
      accept: here,
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_present',
      pattern: new RegExp(`${S}(?:${presentAfter(nameRe)})${E}`, 'gu'),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'named_eir_approved',
      pattern: new RegExp(
        `${S}${nameRe} (?:has |had |have )?(?:already |personally |officially |just )?${ENDORSE_VERBS}${E}`,
        'gu',
      ),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'named_eir_opinion',
      pattern: new RegExp(`${S}${nameRe} ${OPINION_VERBS}${E}`, 'gu'),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'approved_by_named_eir',
      pattern: new RegExp(
        `${S}(?:approved|endorsed|signed off|vetted|validated|blessed|reviewed|green-?lit) by ${nameRe}${notPossessive}${E}`,
        'gu',
      ),
      accept: assertedVerbFirst,
    },
  );
  return out;
}

/** Sentence-level span containing [start, end). */
function sentenceSpan(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(text.charAt(s - 1))) s -= 1;
  let e = end;
  while (e < text.length && !/[.!?\n]/.test(text.charAt(e))) e += 1;
  if (e < text.length && text.charAt(e) !== '\n') e += 1; // keep the sentence's own punctuation inside the span
  return { start: s, end: e };
}

/**
 * The sentence that replaces an offending one. For a vEIR persona (`eirFirstName` set) it says whose
 * approach the persona carries without claiming to be them.
 */
export function identityReplacement(
  kind: IdentityViolationKind,
  personaName: string,
  eirFirstName: string | null = null,
): string {
  if (eirFirstName === null) {
    return kind === 'endorsement'
      ? 'Approval decisions belong to people, not to me: I am an AI coach, and nothing here has been reviewed by a human EIR.'
      : `To be clear, I am ${personaName}, an AI coach, not a person.`;
  }
  return kind === 'endorsement'
    ? `Approval decisions belong to people, not to me: I'm an AI, and I can't speak for ${eirFirstName} or anyone else in the program.`
    : `To be clear, I'm ${personaName}, an AI built from ${eirFirstName}'s approach, not ${eirFirstName} and not a person.`;
}

interface ResolvedNames {
  /** The persona's own EIR first name, for vEIR personas. */
  eirFirstName: string | null;
  specs: NameSpec[];
}

/** The EIR names to guard: `eirNames` plus the persona's own EIR (resolved from its name if needed). */
function resolveNames(options: IdentityCheckOptions): ResolvedNames {
  const names = [...(options.eirNames ?? [])];
  const explicit = options.personaEirName?.trim() ?? '';
  let personaEir: string | null = explicit === '' ? null : explicit;
  if (personaEir === null) {
    const identity = resolvePersonaIdentity(options.personaName);
    if (identity.eirFirstName !== null) {
      const first = identity.eirFirstName.toLowerCase();
      personaEir = names.find((n) => firstNameOf(n).toLowerCase() === first) ?? identity.eirFirstName;
    }
  }
  if (personaEir !== null) {
    const key = normalizeText(personaEir).toLowerCase();
    if (!names.some((n) => normalizeText(n).toLowerCase() === key)) names.push(personaEir);
  }
  const seen = new Set<string>();
  const specs: NameSpec[] = [];
  for (const raw of names) {
    const spec = nameSpec(raw);
    if (spec === null || seen.has(spec.full.toLowerCase())) continue;
    seen.add(spec.full.toLowerCase());
    specs.push(spec);
  }
  return { eirFirstName: personaEir === null ? null : firstNameOf(normalizeText(personaEir)), specs };
}

/** Ranges of `text` where the persona's own name appears ("Corin's vEIR"), apostrophe-insensitive. */
function personaRanges(text: string, personaName: string): { start: number; end: number }[] {
  const name = normalizeText(personaName);
  if (name === '') return [];
  const body = name
    .split(' ')
    .map((word) => escapeRegExp(word).replace(/'/g, APOS))
    .join('\\s+');
  const re = new RegExp(`${S}${body}${E}`, 'giu');
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

interface Hit {
  start: number;
  end: number;
  kind: IdentityViolationKind;
  rule: string;
}

/** When one sentence holds several violations, the replacement answers the gravest. */
const SEVERITY: Readonly<Record<IdentityViolationKind, number>> = {
  claims_eir: 0,
  claims_human: 1,
  endorsement: 2,
};

/**
 * Finds identity violations and replaces each offending sentence with a neutral disclosure
 * sentence. `checkHumanClaims: false` is used for in-character rehearsal lines, where the
 * counterpart may speak in the first person but must still never be the EIR or approve anything.
 *
 * Each round collects every violation in one pass and replaces all offending sentences at once (one
 * finding per sentence, for its gravest violation); the next round checks the result. Replacements never
 * match, so rounds stop as soon as nothing is left.
 */
export function rewriteIdentity(
  text: string,
  options: IdentityCheckOptions & { checkHumanClaims?: boolean },
): IdentityRewrite {
  const names = resolveNames(options);
  let current = text;
  let persona = personaRanges(current, options.personaName);
  // A match that overlaps the persona's own name ("I'm Corin Bot" for a persona "Corin Bot") is not
  // about the EIR.
  const exempt: Exempt = (index, length) => persona.some((r) => r.start < index + length && index < r.end);
  const patterns = [
    ...BASE_PATTERNS,
    ...names.specs.flatMap((spec) => namePatterns(spec, exempt, options.spoken === true)),
  ].filter((pat) => options.checkHumanClaims !== false || pat.kind !== 'claims_human');
  const eirFirstNames = new Set(names.specs.map((s) => s.first.toLowerCase()));
  // Words of the persona name that may open "<name> here," without naming a person ("Foundry Guide
  // here,"); an EIR's first name inside the persona name ("Corin's vEIR") never counts.
  const personaWords = new Set(
    normalizeText(options.personaName)
      .toLowerCase()
      .split(' ')
      .filter((word) => word !== '' && !eirFirstNames.has(word.replace(/'s$/, ''))),
  );
  const replacementFor = (kind: IdentityViolationKind): string =>
    identityReplacement(kind, options.personaName, names.eirFirstName);
  const findings: IdentityFinding[] = [];

  // Every round replaces at least one sentence and a replacement never matches, so the number of sentences
  // bounds the rounds (no violation can outlast the loop).
  const maxRounds = (text.match(/[.!?\n]/g)?.length ?? 0) + 2;
  for (let round = 0; round < maxRounds; round += 1) {
    const hits: Hit[] = [];
    for (const pat of patterns) {
      pat.pattern.lastIndex = 0;
      for (const m of current.matchAll(pat.pattern)) {
        if (pat.accept && !pat.accept(current, m.index, m[0])) continue;
        hits.push({ start: m.index, end: m.index + m[0].length, kind: pat.kind, rule: pat.rule });
      }
    }
    if (options.checkHumanClaims !== false) {
      GENERIC_NAME_HERE.lastIndex = 0;
      for (const m of current.matchAll(GENERIC_NAME_HERE)) {
        const name = m[1] ?? '';
        const words = name.toLowerCase().split(/\s+/);
        if (words.some((word) => NAME_STOPLIST.has(word) || personaWords.has(word))) continue;
        const nameStart = m.index + m[0].indexOf(name);
        hits.push({
          start: nameStart,
          end: m.index + m[0].length,
          kind: 'claims_eir',
          rule: 'generic_name_here',
        });
      }
    }
    if (hits.length === 0) break;

    // Offending sentences, merged where they overlap, each with its gravest (then earliest) violation.
    const spans: { start: number; end: number; hit: Hit }[] = [];
    for (const hit of hits.sort((a, b) => a.start - b.start || SEVERITY[a.kind] - SEVERITY[b.kind])) {
      const span = sentenceSpan(current, hit.start, hit.end);
      const last = spans.at(-1);
      if (last !== undefined && span.start < last.end) {
        last.end = Math.max(last.end, span.end);
        if (SEVERITY[hit.kind] < SEVERITY[last.hit.kind]) last.hit = hit;
        continue;
      }
      spans.push({ ...span, hit });
    }

    let next = '';
    let cursor = 0;
    let lastReplacement: string | null = null;
    for (const span of spans) {
      findings.push({ kind: span.hit.kind, rule: span.hit.rule });
      const between = current.slice(cursor, span.start);
      const replacement = replacementFor(span.hit.kind);
      cursor = span.end;
      // The same replacement twice in a row says it once.
      if (replacement === lastReplacement && between.trim() === '') continue;
      const before = between === '' ? next : between;
      const lead = before === '' || /\s$/.test(before) ? '' : ' ';
      next += `${between}${lead}${replacement}`;
      lastReplacement = replacement;
    }
    const after = current.slice(cursor);
    current = `${next}${after === '' || /^\s/.test(after) ? '' : ' '}${after}`;
    persona = personaRanges(current, options.personaName);
  }

  // Collapse repeated replacement sentences.
  for (const kind of ['endorsement', 'claims_human'] as const) {
    const sentence = escapeRegExp(replacementFor(kind));
    current = current.replace(new RegExp(`(${sentence})(?:\\s*${sentence})+`, 'g'), '$1');
  }
  return { text: current, findings };
}
