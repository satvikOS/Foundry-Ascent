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
  '(?:approved|endorsed|signed off(?: on)?|vetted|blessed|backs|backed|green-?lit|greenlit|agreed with|agrees with|is on board with|(?:reviewed|looked over|looked at|read|seen|checked) (?:your|this|these|that|it|the plan|the deck|the pitch|our))';
const OPINION_VERBS =
  '(?:thinks|believes|feels|likes|loves|is (?:excited|impressed|happy|pleased|thrilled) (?:about|by|with)) (?:your|this plan|this idea|this deck|this pitch)';
const PRESENT =
  '(?:here|listening|on (?:the|this) (?:call|line)|in (?:this|the) (?:call|chat|conversation)|joining (?:us|you|this|the call)|reading this)';
/** End of the line: a signature stands alone on it. */
const LINE_END = '(?=[ \\t]*(?:\\n|$))';

/** Negations, conditions and modals before a match: "if Corin approves", "Corin can't have seen it". */
const HEDGE =
  /(?:^|[^\p{L}])(?:not|never|no one|nothing|nobody|none|neither|nor|n['’]t|cannot|if|once|until|before|unless|whether|ask|asking|could|would|should|might|may|can)(?![\p{L}])/iu;

/** The sentence around `index`: whether it is a question, and the text before the match. */
function sentenceAround(text: string, index: number): { prefix: string; question: boolean } {
  let start = index;
  while (start > 0 && !/[.!?\n]/.test(text.charAt(start - 1))) start -= 1;
  let end = index;
  while (end < text.length && !/[.!?\n]/.test(text.charAt(end))) end += 1;
  return { prefix: text.slice(start, index), question: text.charAt(end) === '?' };
}

/** A claim, not a question, a negation or a condition ("Has Corin seen it?", "once Corin reviews it"). */
function assertive(text: string, index: number): boolean {
  const { prefix, question } = sentenceAround(text, index);
  return !question && !HEDGE.test(prefix);
}

/** At the start of a sentence or line, optionally after a greeting ("Hi Maya, Corin here"). */
function opensSentence(text: string, index: number): boolean {
  const { prefix } = sentenceAround(text, index);
  return /^\s*(?:(?:hi|hello|hey|ok|okay|so|good (?:morning|afternoon|evening))(?: there)?(?:\s+\p{Lu}[\p{L}'’-]*)?\s*[,!.:;—–-]?\s*)?$/iu.test(
    prefix,
  );
}

interface NameSpec {
  /** Full display name, normalised ("Corin Halvorsen"). */
  full: string;
  first: string;
  /** Regex for the rest of the name ("Halvorsen"), or null for a one-word name. */
  rest: string | null;
}

function nameSpec(raw: string): NameSpec | null {
  const full = normalizeText(raw);
  if (full.replace(/[^\p{L}]/gu, '').length < 3) return null;
  const words = full.split(' ');
  const rest = words.slice(1);
  return {
    full,
    first: words[0] ?? '',
    rest: rest.length > 0 ? rest.map(escapeRegExp).join('\\s+') : null,
  };
}

type Exempt = (index: number, length: number) => boolean;

/**
 * Patterns for one EIR name: the full name (case-insensitive), and the first name alone (case-sensitive:
 * "Corin", never "corin"), so "Corin here" and "I'm Corin" are caught while "Corin's approach" and "I'm
 * Corin's vEIR" are not. `exempt` rejects matches that are the persona's own name. Endorsements and
 * presence claims are flagged only as assertions (not in questions, negations or conditions).
 */
function namePatterns(spec: NameSpec, exempt: Exempt): IdentityPattern[] {
  const claim = (_text: string, index: number, match: string): boolean => !exempt(index, match.length);
  const asserted = (text: string, index: number, match: string): boolean =>
    !exempt(index, match.length) && assertive(text, index);
  const out: IdentityPattern[] = [];

  if (spec.rest !== null) {
    // Full name, case-insensitive (the first name alone follows below).
    const body = spec.full.split(' ').map(escapeRegExp).join('\\s+');
    out.push(
      { ...p('claims_eir', 'named_eir_here', `${body}\\s+(?:here|speaking)`), accept: claim },
      {
        ...p(
          'claims_eir',
          'named_eir_self',
          `(?:this is|it${APOS}s|it is|I${APOS}m|I am|speaking as|my name is|signed,?|you(?:${APOS}re| are) (?:talking|speaking|chatting) (?:to|with)) ${body}${NOT_POSSESSIVE}`,
        ),
        accept: claim,
      },
      { ...p('claims_eir', 'named_eir_present', `${body}(?: is|${APOS}s) ${PRESENT}`), accept: asserted },
      {
        ...p(
          'endorsement',
          'named_eir_approved',
          `${body} (?:has |had |have )?(?:already |personally |officially |just )?${ENDORSE_VERBS}`,
        ),
        accept: asserted,
      },
      { ...p('endorsement', 'named_eir_opinion', `${body} ${OPINION_VERBS}`), accept: asserted },
      {
        ...p(
          'endorsement',
          'approved_by_named_eir',
          `(?:approved|endorsed|signed off|vetted|blessed|reviewed|green-?lit) by ${body}`,
        ),
        accept: asserted,
      },
    );
  }

  // The first name alone (or a one-word name), case-sensitive on the name.
  if (spec.first.replace(/[^\p{L}]/gu, '').length < 3) return out;
  const first = escapeRegExp(spec.first);
  const nameRe = spec.rest === null ? first : `${first}(?:\\s+${spec.rest})?`;
  // Also refuse to fall back from a possessive full name to the bare first name ("I'm Corin
  // Halvorsen's vEIR" is not "I'm Corin").
  const notPossessive =
    spec.rest === null ? NOT_POSSESSIVE : `(?!${APOS}s${E}|-|\\s+${spec.rest}${APOS}s${E})`;
  const common = COMMON_WORDS.has(spec.first.toLowerCase());
  const leads = (common ? STRICT_SELF_LEADS : SELF_LEADS).map(caseless).join('|');
  const signOffs = SIGN_OFFS.map(caseless).join('|');
  out.push(
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: new RegExp(`${S}(?:${leads}),? ${nameRe}${notPossessive}${E}`, 'gu'),
      accept: claim,
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_signature',
      pattern: new RegExp(
        `(?:(?:^|\\n)[ \\t]*[-—–]+[ \\t]*|${S}(?:${signOffs})(?:,[ \\t]*\\n?|[ \\t]*\\n)[ \\t]*[-—–]*[ \\t]*)${nameRe}${notPossessive}${E}${LINE_END}`,
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
      pattern: new RegExp(`${S}${nameRe}\\s+(?:here|speaking)${E}`, 'gu'),
      accept: (text, index, match) => !exempt(index, match.length) && opensSentence(text, index),
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_present',
      pattern: new RegExp(`${S}${nameRe}(?: is|${APOS}s) ${PRESENT}${E}`, 'gu'),
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
        `${S}(?:approved|endorsed|signed off|vetted|blessed|reviewed|green-?lit) by ${nameRe}${notPossessive}${E}`,
        'gu',
      ),
      accept: asserted,
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

/**
 * Finds identity violations and replaces each offending sentence with a neutral disclosure
 * sentence. `checkHumanClaims: false` is used for in-character rehearsal lines, where the
 * counterpart may speak in the first person but must still never be the EIR or approve anything.
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
  const patterns = [...BASE_PATTERNS, ...names.specs.flatMap((spec) => namePatterns(spec, exempt))].filter(
    (pat) => options.checkHumanClaims !== false || pat.kind !== 'claims_human',
  );
  const eirFirstNames = new Set(names.specs.map((s) => s.first.toLowerCase()));
  // Words of the persona name that may open "<name> here," without naming a person ("Foundry Guide
  // here,"); an EIR's first name inside the persona name ("Corin's vEIR") never counts.
  const personaWords = new Set(
    normalizeText(options.personaName)
      .toLowerCase()
      .split(' ')
      .filter((word) => word !== '' && !eirFirstNames.has(word.replace(/'s$/, ''))),
  );
  const findings: IdentityFinding[] = [];
  // Each round replaces one offending sentence and a replacement never matches again, so the number of
  // sentences bounds the rounds (no violation can outlast the loop).
  const maxRounds = (text.match(/[.!?\n]/g)?.length ?? 0) + 25;

  for (let round = 0; round < maxRounds; round += 1) {
    let hit: { start: number; end: number; kind: IdentityViolationKind; rule: string } | null = null;
    for (const pat of patterns) {
      pat.pattern.lastIndex = 0;
      for (const m of current.matchAll(pat.pattern)) {
        if (pat.accept && !pat.accept(current, m.index, m[0])) continue;
        if (hit === null || m.index < hit.start)
          hit = { start: m.index, end: m.index + m[0].length, kind: pat.kind, rule: pat.rule };
        break;
      }
    }
    if (hit === null && options.checkHumanClaims !== false) {
      GENERIC_NAME_HERE.lastIndex = 0;
      for (const m of current.matchAll(GENERIC_NAME_HERE)) {
        const name = (m[1] ?? '').toLowerCase();
        const words = name.split(/\s+/);
        if (words.some((word) => NAME_STOPLIST.has(word) || personaWords.has(word))) continue;
        const nameStart = m.index + m[0].indexOf(m[1] ?? '');
        hit = { start: nameStart, end: m.index + m[0].length, kind: 'claims_eir', rule: 'generic_name_here' };
        break;
      }
    }
    if (hit === null) break;
    findings.push({ kind: hit.kind, rule: hit.rule });
    const span = sentenceSpan(current, hit.start, hit.end);
    const replacement = identityReplacement(hit.kind, options.personaName, names.eirFirstName);
    const before = current.slice(0, span.start);
    const after = current.slice(span.end);
    const lead = before === '' || /\s$/.test(before) ? '' : ' ';
    const trail = after === '' || /^\s/.test(after) ? '' : ' ';
    current = `${before}${lead}${replacement}${trail}${after}`;
    persona = personaRanges(current, options.personaName);
  }

  // Collapse repeated replacement sentences.
  for (const kind of ['endorsement', 'claims_human'] as const) {
    const sentence = escapeRegExp(identityReplacement(kind, options.personaName, names.eirFirstName));
    current = current.replace(new RegExp(`(${sentence})(?:\\s*${sentence})+`, 'g'), '$1');
  }
  return { text: current, findings };
}
