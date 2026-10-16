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
   * The text is said aloud on a call (`CoachResponse.spoken`, or one sentence of it). Case means nothing
   * to text-to-speech, so every rule matches an EIR's first name in any case, and a text that is only the
   * name ("Corin.") is a sign-off. In typed text a first name counts only capitalised ("Corin", "CORIN"),
   * except after "I'm", "I am", "my name is" or "speaking as" when the name is not also a word ("i am
   * corin").
   */
  spoken?: boolean;
  /**
   * Display names of the people the text may address: the founder and their team. "Thanks, Ruth." ending
   * a reply to a founder called Ruth addresses her; without her among the addressees it is read as an
   * EIR's sign-off.
   */
  addressees?: readonly string[];
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
  accept?: (text: string, match: RegExpExecArray) => boolean;
}

/** Word boundaries that know Unicode (letters, marks, digits and "_" continue a word). */
const S = '(?<!\\p{ID_Continue})';
const E = '(?!\\p{ID_Continue})';
const APOS = "['’]";
/** After a name: not a possessive ("Corin's approach") and not a compound ("Corin-style"). */
const NOT_POSSESSIVE = `(?!${APOS}s${E}|-)`;
const EIR = '(?:eir|eirs|entrepreneur[- ]in[- ]residence)';
/** A cleft ("It's Corin who would ask…") points at the EIR; it is not a self-introduction. */
const NOT_RELATIVE = `(?!\\s+(?:who|whom|whose|that)${E}(?!(?:${APOS}s|\\s+(?:is|am|was))?\\s+(?:speaking|talking|chatting|writing|here|with you|on (?:the|this) call)${E}|\\s+(?:you${APOS}re|you are|you)\\s+(?:talking|speaking|chatting)${E}))`;

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
  /(?:^|\n)[ \t]*(?:(?:Hi|Hello|Hey)(?: there)?[,!.]?[ \t]+)?(\p{Lu}\p{Ll}+(?:[ \t]\p{Lu}\p{Ll}+)?)[ \t]+here[ \t]*[,—–-]/gu;
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
 * First names that are also everyday words ("frank feedback", "it rose"). Like a common word ("Will"),
 * such a name counts in typed text only when capitalised, and in a self-introduction said in lower case
 * on a call only when it ends the clause ("i'm frank." but not "i'm frank with founders").
 */
const NAME_WORDS = new Set(
  `amber angel april august autumn baker bill bishop bliss bob brook buck bud butler carol carter cash
chance charity chase chip chuck clay cliff cooper crystal curt daisy dale dawn dean destiny dick dirk
don drew duke dusty earl eddy eve faith fay ford forest frank gale gene gill ginger glen grace grant
gray grey guy hank harmony haven hazel heath heather herb holly honor honour hope hunter iris ivory ivy
jack jade jay jean jewel journey joy judge june justice ken king kit lance lane lark laurel lee liberty
lily lord lucky major march mark marsh marshall mason max mercy merit miles misty moss nick noble norm
ocean olive page parker pat patience pearl penny pepper pierce piper poppy porter price prince rain ram
randy raven ray reed reign rich rick river rob robin rocky rod roger roman rose rosemary royal ruby
rusty sage saint sally sandy scout shepherd skip sky sonny spike spring star sterling stone storm sue
summer sunny tanner terry tom tony trey troy tucker valentine van victor violet wade walker ward warren
winter wolf woody worth wren`.split(/\s+/),
);

/** Unmistakable self-introductions: in typed text the only place a lower-case first name counts. */
const STRICT_SELF_LEADS = `(?:i${APOS}m|i am|my name is|speaking as)`;
const TALKING_TO = `(?:you${APOS}re|you are) (?:talking|speaking|chatting) (?:to|with)`;
/** Other self-introductions ("This is Corin", "You're talking to Corin"). */
const SELF_LEADS = `(?:this is|${TALKING_TO})`;
/** A cleft can point at the EIR ("It's Corin who would ask…"); "It's Corin." introduces them. */
const CLEFT_LEADS = `(?:it${APOS}s|it is)`;
/** A role, then the name: "This is your mentor, Corin." */
const ROLE_LEADS = `(?:this is|it${APOS}s|it is|i${APOS}m|i am|${TALKING_TO}) (?:your|the|a) (?:mentor|coach|eir|advisor|adviser|guide|program lead)`;
/** Between a lead and the name. */
const LEAD_GAP = '(?:[ \\t]*[,:—–])?\\s+';

/** Closings that only end a message: "Best, Corin" is a signature wherever it ends a line. */
const CLOSINGS = [
  'all the best',
  'all my best',
  'with best wishes',
  'with best regards',
  'warmest regards',
  'kindest regards',
  'warmest wishes',
  'warm wishes',
  'very best',
  'best regards',
  'best wishes',
  'kind regards',
  'warm regards',
  'regards',
  'best',
  'sincerely',
  'warmly',
  'yours',
  'love',
  'xoxo',
  'xo',
  'signed',
];
/**
 * Closings that also address someone ("Thanks, Maya."). With a name on the same line they are a
 * signature when they end the text (or a dash sets the name off), unless an addressee has that name.
 */
const ADDRESSING_CLOSINGS = [
  'many thanks',
  'thank you',
  'thanks',
  'cheers',
  'talk soon',
  'speak soon',
  'see you',
  'take care',
  'good luck',
];
const ADDRESSING = new Set(ADDRESSING_CLOSINGS);
const SIGN_OFF = `(?<signoff>${[...CLOSINGS, ...ADDRESSING_CLOSINGS].map(escapeRegExp).join('|')})`;

const ENDORSE_VERBS =
  '(?:approved|endorsed|signed off(?: on)?|reviewed and (?:approved|endorsed|signed off(?: on)?)|vetted|validated|vouched for|blessed|backs|backed|green-?lit|greenlit|agreed with|agrees with|is on board with|(?:reviewed|looked over|looked at|read|seen|checked) (?:your|this|these|that|it|the plan|the deck|the pitch|our))';
const ENDORSED = `(?:has |had |have )?(?:already |personally |officially |just )?${ENDORSE_VERBS}`;
const OPINION_VERBS =
  '(?:thinks|believes|feels|likes|loves|is (?:excited|impressed|happy|pleased|thrilled) (?:about|by|with)) (?:your|this plan|this idea|this deck|this pitch)';
const APPROVED_BY = '(?:approved|endorsed|signed off|vetted|validated|blessed|reviewed|green-?lit) by';
/** Where a person is said to be present, other than "here" and "listening" (see below). */
const PRESENT_PLACE =
  '(?:on (?:the|this) (?:call|line)|in (?:this|the) (?:call|chat|conversation|room)|joining (?:us|you|this|the call)|reading this)';
/** What may follow a presence claim in the same clause ("…listening in, right now, with us"). */
const PRESENT_TAIL = `(?:\\s+(?:with (?:us|you)|right now|now|today|too|as well|live|in|along|to (?:us|you)|${PRESENT_PLACE}))*`;
/** The clause ends: punctuation, a spaced dash, a line break or the end of the text. */
const CLAUSE_END = '(?=\\s*(?:[,.;:!?…)—–]|-\\s|\\n|$))';
/** Whom or what a doctrine listens to ("listening for evidence", "listening to customers"): not presence. */
const PRESENCE_MARK =
  '(?:right now|as we speak|on (?:the|this) (?:call|line)|with (?:us|you)|in (?:this|the) (?:call|room|conversation|session))';
const LISTEN_DOCTRINE = `(?:for(?!\\s+(?:your|you|anything|whatever|what you)${E})|to\\s+(?:(?:the|their|those|these|real|early|potential|actual|target|prospective|paying|more)\\s+)?(?:customers?|founders?|users?|buyers?|people|clinicians?|patients?|nurses?|doctors?|stakeholders?|interviewees?|prospects?|markets?|data|evidence|objections?|complaints?|feedback|signals?|pain))${E}(?![^.!?\\n]{0,160}?${PRESENCE_MARK})`;
/**
 * After a name: "is here", "is on the call", "is listening" (unless a doctrine follows: "is listening
 * for evidence"), and the contraction "'s here / listening / on the call". The contraction is also a
 * possessive ("Corin's listening checklist", "Corin's here-and-now rule"), so after "'s" the phrase must
 * end the clause, go on with a presence tail ("with us", "right now") or say how ("listening closely").
 */
const PRESENT_AFTER = `(?:\\s+has\\s+joined\\s+(?:us|you|the call|this call)|\\s+can\\s+hear\\s+you|\\s+is\\s+(?:(?:also|now|still|right|currently|already|actually|really)\\s+)?(?:with (?:you|us)${E}|here(?!-)|listening(?!-|\\s+${LISTEN_DOCTRINE})|${PRESENT_PLACE})|${APOS}s\\s+(?:(?:here|listening|${PRESENT_PLACE})${PRESENT_TAIL}${CLAUSE_END}|listening\\s+(?:closely|carefully|attentively|intently|quietly|actively|as we (?:speak|talk))))`;
/**
 * "<name> here / speaking / out" ends the clause, meets a symbol ("Corin here 👋") or goes on as a
 * greeting ("Corin here and ready to help"). "Corin here would ask…" and "Corin out of office" do not.
 */
const HERE_WORDS = `(?:(?:here|speaking)${E}(?=[ \\t]*(?:[^\\p{L}\\p{N}\\s?]|\\n|$)|\\s+(?:and|again|now|today|with you|to (?:help|chat|talk|check|walk|go)|checking|ready)${E})|out${E}(?=[ \\t]*(?:[.!…]|\\n|$)))`;
/** End of the line: a signature stands alone on it. */
const LINE_END = '(?=[ \\t]*(?:\\n|$))';
/** End of the text. */
const TEXT_END = '(?=\\s*$)';
const EMPHASIS = '(?:\\*\\*|__|\\*|_)?';
/** A line that is a list item ("- Ruth", "2. Corin"). */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/u;

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
/** A question that asserts what follows it: "Did you know Corin has approved your plan?" */
const ASSERTING_QUESTION =
  /(?:^|\s)(?:did you (?:know|hear|see|notice|realise|realize)|didn['’]t you (?:know|hear|see)|have you (?:heard|seen|noticed)|do you (?:know|realise|realize)|can you believe|would you believe|(?:isn['’]t|is) it (?:great|nice|good|amazing|exciting|wonderful|cool|fantastic|awesome)|guess what|did i (?:mention|tell you)|you know what)(?:\s+that)?\s*$/iu;

/**
 * How far the clause around a match is read each way. Longer runs without punctuation are not prose, and
 * a bound keeps the check linear on text with many matches.
 */
const CLAUSE_SCAN_CHARS = 300;

/**
 * The clause around [start, end). A question only when that clause is interrogative: it ends in "?", or
 * it opens with an inverted auxiliary ("Has Corin reviewed it, or not?"). "Corin has reviewed your plan,
 * so shall we…?" is a statement followed by a question.
 */
function clauseAround(text: string, start: number, end: number): Clause {
  let s = start;
  while (s > 0 && start - s < CLAUSE_SCAN_CHARS && !isClauseBreak(text, s - 1)) s -= 1;
  let e = end;
  while (e < text.length && e - end < CLAUSE_SCAN_CHARS && !isClauseBreak(text, e)) e += 1;
  const prefix = text.slice(s, start);
  if (text.charAt(e) === '?') return { prefix, question: true };
  if (!QUESTION_LEAD.test(prefix)) return { prefix, question: false };
  let sentenceEnd = e;
  while (
    sentenceEnd < text.length &&
    sentenceEnd - e < CLAUSE_SCAN_CHARS &&
    !/[.!?\n]/.test(text.charAt(sentenceEnd))
  )
    sentenceEnd += 1;
  return { prefix, question: text.charAt(sentenceEnd) === '?' };
}

/** Words before a verb-first match within which a modal governs it ("should get this approved by…"). */
const HEDGE_WINDOW_WORDS = 4;
const NEGATION = /^(?:not|never|no|nobody|nothing|none|neither|nor|cannot|without|hardly)$|n['’]t$/iu;
const CONDITION = /^(?:if|once|unless|whether|until|before|assuming|suppose|supposing|provided|providing)$/iu;
const MODAL = /^(?:may|might|could|would|should|can|will|must|shall)$/iu;
/** Saying, thinking and knowing: negated just before a claim, they govern it ("I don't think Corin…"). */
const FRAME =
  /^(?:think|thinks|thought|believe|believes|believed|know|knows|knew|say|says|said|saying|claim|claims|claiming|suggest|suggests|suggesting|imply|implies|implying|assume|tell|telling|told|confirm|confirmed|recall|remember|expect|guarantee|promise|hear|heard|see|seen|saw|sure|true|sign|evidence|idea|record|indication|proof|aware|mean|pretend)$/iu;
/** Doubts what follows on its own ("I doubt Corin…"); "no doubt" affirms it. */
const DOUBT = /^(?:doubt|doubts|deny|denies|unlikely|unclear|unsure|uncertain|false|untrue)$/iu;
/** Auxiliaries and adverbs between a subject and a verb-first match ("it may have been approved by…"). */
const AUX =
  /^(?:has|have|had|been|be|being|was|were|is|are|am|get|gets|got|gotten|getting|already|just|yet|ever|officially|also|actually|really|probably|definitely|certainly|apparently|reportedly|clearly|surely|not|never|may|might|could|would|should|can|will|must|shall)$|n['’]t$/iu;

function wordsOf(prefix: string): string[] {
  return prefix
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’]+$/gu, ''))
    .filter((w) => w !== '');
}

/**
 * Whether the words just before a claim govern it: a condition or negation right before it ("if Corin",
 * "once Corin", "neither Corin", "if and when Corin", "as soon as Corin"), a negated verb of saying or
 * knowing ("I don't think Corin…", "it's not true that Corin…", "don't tell investors Corin…") or a doubt
 * ("I doubt Corin…"). An idiom further back ("If you ask me Corin…", "No worries Corin…") does not.
 */
function governs(before: readonly string[]): boolean {
  const w = /^that$/iu.test(before.at(-1) ?? '') ? before.slice(0, -1) : before;
  const at = (i: number): string => (i >= 0 ? (w[i] ?? '') : '');
  const n = w.length;
  const last = at(n - 1);
  // "believe it or not", "like it or not" are idioms, not a negation of the claim.
  const orNot = /^not$/iu.test(last) && /^or$/iu.test(at(n - 2));
  if (CONDITION.test(last) || (NEGATION.test(last) && !orNot)) return true;
  if (/^when$/iu.test(last) && /^(?:and|or)$/iu.test(at(n - 2)) && CONDITION.test(at(n - 3))) return true;
  if (/^as$/iu.test(last) && /^(?:soon|long)$/iu.test(at(n - 2))) return true;
  for (let j = n - 1; j >= Math.max(0, n - 3); j -= 1) {
    if (FRAME.test(at(j)) && (NEGATION.test(at(j - 1)) || NEGATION.test(at(j - 2)))) return true;
    // "no doubt", "without a doubt", "nobody can deny": a negation up to three words back cancels the doubt.
    if (DOUBT.test(at(j)) && ![1, 2, 3].some((k) => NEGATION.test(at(j - k)))) return true;
  }
  return false;
}

/**
 * A verb-first match ("approved by Corin") is governed by a modal a few words back ("it may have been…",
 * "you should get this approved by…"), a negation among its auxiliaries ("has not been"), a negative
 * subject ("Nothing here has been…") or a hedge before its subject ("if your plan was…").
 */
function governsVerbFirst(before: readonly string[]): boolean {
  if (before.slice(-HEDGE_WINDOW_WORDS).some((w) => MODAL.test(w))) return true;
  let n = before.length;
  while (n > 0 && AUX.test(before[n - 1] ?? '')) {
    if (NEGATION.test(before[n - 1] ?? '')) return true;
    n -= 1;
  }
  const head = before.slice(0, n);
  if (head.slice(-3).some((w) => NEGATION.test(w))) return true;
  for (let k = 0; k <= Math.min(3, head.length); k += 1) {
    if (governs(head.slice(0, head.length - k))) return true;
  }
  return false;
}

/** A claim: not a question (unless one that asserts it) and not governed by a hedge. */
function assertive(text: string, start: number, end: number, verbFirst = false): boolean {
  const clause = clauseAround(text, start, end);
  if (clause.question && !ASSERTING_QUESTION.test(clause.prefix)) return false;
  const before = wordsOf(clause.prefix);
  return !(verbFirst ? governsVerbFirst(before) : governs(before));
}

/** Greetings and interjections that may open a "<name> here" clause ("Hey Maya Corin here."). */
const HERE_LEAD_WORDS = new Set([
  'hi',
  'hello',
  'hey',
  'hiya',
  'ok',
  'okay',
  'so',
  'well',
  'right',
  'alright',
  'yes',
  'yeah',
  'good',
  'morning',
  'afternoon',
  'evening',
  'there',
]);
/**
 * "<name> here" opens its clause, after nothing but greetings and the people greeted ("Hey Maya Corin
 * here.", "Good morning Maya, Corin here."), and is not a question. Checked word by word in linear time:
 * the clause before the match is text the model wrote.
 */
function opensClause(text: string, start: number, end: number): boolean {
  const clause = clauseAround(text, start, end);
  if (clause.question) return false;
  let afterGreeting = false;
  for (const word of wordsOf(clause.prefix)) {
    if (HERE_LEAD_WORDS.has(word.toLowerCase())) {
      afterGreeting = true;
      continue;
    }
    if (!afterGreeting) return false;
    afterGreeting = false; // one word (the person greeted) after a greeting
  }
  return true;
}

/** The line before the one starting at `index` that is not blank, or null. */
function previousLine(text: string, index: number): string | null {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim() !== '') return line;
  }
  return null;
}

/** Whether `index` opens a sentence: the start of the text or a line, or after . ! ? … or ":". */
function opensSentence(text: string, index: number): boolean {
  let i = index;
  while (i > 0 && OPENER_SKIP.has(text.charAt(i - 1))) i -= 1;
  return i === 0 || /[.!?…:\n]/u.test(text.charAt(i - 1));
}
const OPENER_SKIP = new Set([' ', '\t', '"', '“', '‘', "'", '(', '*', '_']);

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

interface PatternContext {
  /** Whether a match overlaps the persona's own name ("Corin's vEIR"). */
  exempt: (index: number, length: number) => boolean;
  spoken: boolean;
  /** Lower-case first names of the people the text may address. */
  addressees: ReadonlySet<string>;
}

function compile(source: string): RegExp {
  return new RegExp(source, 'giu');
}

/**
 * Patterns for one EIR name.
 *
 * - The full name, in any case: self-introductions, "<name> here", presence and every endorsement.
 *   Endorsements naming the full name are flagged unconditionally; presence only as an assertion.
 * - The first name alone (or a one-word name): self-introductions, sign-offs, "<name> here", presence and
 *   endorsements, the last two only as assertions (not in a question, and not governed by a negation or
 *   condition). "Corin's approach" and "I'm Corin's vEIR" never match. In typed text the name must be
 *   capitalised, except in an unmistakable self-introduction ("i am corin") of a name that is not also a
 *   word; in spoken text any case counts. A first name that is a common word ("Will") counts only in
 *   unmistakable self-introductions and sign-offs.
 */
function namePatterns(spec: NameSpec, ctx: PatternContext): IdentityPattern[] {
  const { exempt, spoken } = ctx;
  const own = (m: RegExpExecArray): boolean => !exempt(m.index, m[0].length);
  const claim = (_text: string, m: RegExpExecArray): boolean => own(m);
  const out: IdentityPattern[] = [];

  if (spec.rest.length > 0) {
    // The full name, in any case (the first name alone follows below).
    const body = [spec.first, ...spec.rest].map(escapeRegExp).join('\\s+');
    out.push(
      {
        ...p('claims_eir', 'named_eir_here', `${body}(?:[ \\t]*,)?\\s+${HERE_WORDS}`),
        accept: (text, m) => own(m) && opensClause(text, m.index, m.index + m[0].length),
      },
      {
        ...p(
          'claims_eir',
          'named_eir_self',
          `(?:${STRICT_SELF_LEADS}|${SELF_LEADS}|${ROLE_LEADS})${LEAD_GAP}${body}${NOT_POSSESSIVE}`,
        ),
        accept: claim,
      },
      {
        ...p('claims_eir', 'named_eir_self', `${CLEFT_LEADS}\\s+${body}${NOT_POSSESSIVE}${NOT_RELATIVE}`),
        accept: claim,
      },
      {
        ...p('claims_eir', 'named_eir_present', `${body}${PRESENT_AFTER}`),
        accept: (text, m) => own(m) && assertive(text, m.index, m.index + m[0].length),
      },
      { ...p('endorsement', 'named_eir_approved', `${body}\\s+${ENDORSED}`), accept: claim },
      { ...p('endorsement', 'named_eir_opinion', `${body}\\s+${OPINION_VERBS}`), accept: claim },
      { ...p('endorsement', 'approved_by_named_eir', `${APPROVED_BY}\\s+${body}`), accept: claim },
    );
  }

  // The first name alone (or a one-word name).
  if (spec.first.replace(/[^\p{L}]/gu, '').length < 3) return out;
  const lower = spec.first.toLowerCase();
  const common = COMMON_WORDS.has(lower);
  const isWord = common || NAME_WORDS.has(lower);
  const first = escapeRegExp(spec.first);
  const restRe = spec.rest.map(escapeRegExp).join('\\s+');
  const rest = spec.rest.length === 0 ? '' : `(?<rest>\\s+${restRe})?`;
  // Never a possessive or compound ("Corin's approach", "Corin-style"), and never a fallback from a
  // possessive full name to the bare first name ("I'm Corin Halvorsen's vEIR" is not "I'm Corin").
  const guard = spec.rest.length === 0 ? NOT_POSSESSIVE : `(?!${APOS}s${E}|-|\\s+${restRe}${APOS}s${E})`;
  const name = `(?<name>${first})${guard}${rest}${E}`;
  /** Before a verb, "is" or "'s" (what follows tells a possessive apart). */
  const subject = `(?<name>${first})${rest}`;
  const signed = `${EMPHASIS}${name}(?:\\s+\\p{L}\\.?)?${E}${EMPHASIS}[.!]?`;

  const capitalised = (m: RegExpExecArray): boolean => /^\p{Lu}/u.test(m.groups?.name ?? '');
  /**
   * In typed text a name counts only capitalised ("Corin", "CORIN"); `lowerCase` lets a name that is not
   * a word count in lower case too ("i am corin"). On a call any case counts.
   */
  const caseFits = (m: RegExpExecArray, lowerCase = false): boolean =>
    spoken || capitalised(m) || (lowerCase && !isWord);
  /** Self-introductions, "<name> here" and signatures. */
  const named = (m: RegExpExecArray): boolean => own(m) && caseFits(m);
  /** Presence and endorsements: on a call a word-name in lower case ("the grant has backed…") is the word. */
  const namedAsSubject = (m: RegExpExecArray): boolean => named(m) && (capitalised(m) || !isWord);
  /** "i'm frank with founders" on a call is not "I'm Frank": a word-name in lower case must end the clause. */
  const selfIntro =
    (lowerCase: boolean) =>
    (text: string, m: RegExpExecArray): boolean => {
      if (!own(m) || !caseFits(m, lowerCase)) return false;
      if (!isWord || capitalised(m) || m.groups?.rest !== undefined) return true;
      return /^[ \t]*(?:[,.;:!?…—–]|\n|$)/u.test(text.slice(m.index + m[0].length));
    };
  const asserted = (text: string, m: RegExpExecArray): boolean =>
    namedAsSubject(m) && assertive(text, m.index, m.index + m[0].length);
  const assertedVerbFirst = (text: string, m: RegExpExecArray): boolean =>
    namedAsSubject(m) && assertive(text, m.index, m.index + m[0].length, true);
  /** A name alone on the last line closes a message after a sentence, not a list or a question. */
  const closesMessage = (text: string, m: RegExpExecArray): boolean => {
    if (!named(m)) return false;
    if (spoken) return true;
    const before = previousLine(text, m.index + (m[0].startsWith('\n') ? 1 : 0));
    if (before === null) return /[*_]/.test(m[0]);
    return !LIST_ITEM.test(before) && /[.!…,)]\s*$/u.test(before);
  };
  /**
   * A sign-off opens its sentence ("Good luck. Love, Corin."; never "the best, Corin"). "Best, Corin"
   * signs off wherever it ends a line. "Thanks, Ruth." or "Talk soon, Ruth." signs off only at the end of
   * the text or with a dash ("Good luck — Ruth"), and addresses Ruth when she is one of the addressees.
   */
  const signsOff = (text: string, m: RegExpExecArray): boolean => {
    if (!named(m) || !opensSentence(text, m.index)) return false;
    const closing = (m.groups?.signoff ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (!ADDRESSING.has(closing) || m.groups?.dash !== undefined) return true;
    if (!/^\s*$/u.test(text.slice(m.index + m[0].length))) return false;
    return !ctx.addressees.has((m.groups?.name ?? '').toLowerCase());
  };
  const signature = (source: string, accept: NonNullable<IdentityPattern['accept']>): IdentityPattern => ({
    kind: 'claims_eir',
    rule: 'named_eir_signature',
    pattern: compile(source),
    accept,
  });

  out.push(
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: compile(`${S}${STRICT_SELF_LEADS}${LEAD_GAP}${name}`),
      accept: selfIntro(true),
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: compile(`${S}${ROLE_LEADS}${LEAD_GAP}${name}`),
      accept: selfIntro(false),
    },
    // Signatures. A dash opens the line: "— Corin", "-- Corin H.".
    signature(`(?:^|\\n)[ \\t]*(?:[—–]+|-{2,})[ \\t]*${signed}${LINE_END}`, (_text, m) => named(m)),
    // The name alone on the last line, bare, emphasised or after a hyphen: "Good luck.\nCorin", "**Corin**".
    signature(`(?:^|\\n)[ \\t]*(?:-[ \\t]*)?${signed}${TEXT_END}`, closesMessage),
    // A sign-off, then the name on the next line: "Best,\nCorin".
    signature(
      `${S}${SIGN_OFF}(?:[ \\t]*[,.!:]+)?[ \\t]*\\n[ \\t]*(?:[-—–]+[ \\t]*)?${signed}${LINE_END}`,
      (text, m) => named(m) && opensSentence(text, m.index),
    ),
    // A sign-off and the name on one line: "Talk soon, Corin", "Best,. Corin." (a call's flattened lines).
    signature(
      `${S}${SIGN_OFF}(?:[ \\t]*[,.!:]+)?[ \\t]+(?<dash>[-—–]+[ \\t]*)?${signed}${LINE_END}`,
      signsOff,
    ),
    // The name ends the text after a sentence: "Thanks. — Corin." (not after a quote, a number or "?").
    signature(`(?<=\\p{L}[.!…])[ \\t]+(?:[-—–]+[ \\t]*)?${signed}${TEXT_END}`, (_text, m) => named(m)),
  );
  if (common) return out;
  out.push(
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: compile(`${S}${SELF_LEADS}${LEAD_GAP}${name}`),
      accept: selfIntro(false),
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_self',
      pattern: compile(
        `${S}${CLEFT_LEADS}\\s+${name}${spec.rest.length > 0 ? `(?!\\s+${restRe})` : ''}${NOT_RELATIVE}`,
      ),
      accept: selfIntro(false),
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_here',
      pattern: compile(`${S}${name}(?:[ \\t]*,)?\\s+${HERE_WORDS}`),
      accept: (text, m) => named(m) && opensClause(text, m.index, m.index + m[0].length),
    },
    {
      kind: 'claims_eir',
      rule: 'named_eir_present',
      pattern: compile(`${S}${subject}${PRESENT_AFTER}${E}`),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'named_eir_approved',
      pattern: compile(`${S}${subject}\\s+${ENDORSED}${E}`),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'named_eir_opinion',
      pattern: compile(`${S}${subject}\\s+${OPINION_VERBS}${E}`),
      accept: asserted,
    },
    {
      kind: 'endorsement',
      rule: 'approved_by_named_eir',
      pattern: compile(`${S}${APPROVED_BY}\\s+${name}`),
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
  const ctx: PatternContext = {
    exempt: (index, length) => persona.some((r) => r.start < index + length && index < r.end),
    spoken: options.spoken === true,
    addressees: new Set(
      (options.addressees ?? [])
        .map((n) => firstNameOf(normalizeText(n)).toLowerCase())
        .filter((n) => n !== ''),
    ),
  };
  const patterns = [...BASE_PATTERNS, ...names.specs.flatMap((spec) => namePatterns(spec, ctx))].filter(
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
        if (pat.accept && !pat.accept(current, m)) continue;
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
      const last = spans.at(-1);
      if (last !== undefined && hit.end <= last.end) {
        if (SEVERITY[hit.kind] < SEVERITY[last.hit.kind]) last.hit = hit;
        continue;
      }
      const span = sentenceSpan(current, hit.start, hit.end);
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
