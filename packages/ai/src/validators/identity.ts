import { escapeRegExp, normalizeText } from '../risk/normalize.js';

/**
 * Identity validator: the coach is an AI and never a person, never the EIR, and never claims that
 * it or an EIR approved anything (system design §1 "amplify never impersonate").
 */
export type IdentityViolationKind = 'claims_human' | 'claims_eir' | 'endorsement';

export interface IdentityCheckOptions {
  /** Persona display name (e.g. "Foundry Guide"); never treated as a human name. */
  personaName: string;
  /** Names of real EIRs / program staff the coach must never speak as. */
  eirNames?: readonly string[];
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
}

const S = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
const APOS = "['’]";
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

function namePatterns(names: readonly string[]): IdentityPattern[] {
  const out: IdentityPattern[] = [];
  for (const raw of names) {
    const name = normalizeText(raw);
    if (name.replace(/[^\p{L}]/gu, '').length < 3) continue;
    const body = name.split(' ').map(escapeRegExp).join('\\s+');
    out.push(
      p('claims_eir', 'named_eir_here', `${body}\\s+here`),
      p('claims_eir', 'named_eir_self', `(?:this is|it${APOS}s|I${APOS}m|I am|speaking as) ${body}`),
      p(
        'endorsement',
        'named_eir_approved',
        `${body} (?:has |had )?(?:already |officially )?(?:approved|endorsed|signed off(?: on)?|vetted|blessed|backs|backed)`,
      ),
      p('endorsement', 'approved_by_named_eir', `(?:approved|endorsed|signed off|vetted|blessed) by ${body}`),
    );
  }
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

export function identityReplacement(kind: IdentityViolationKind, personaName: string): string {
  return kind === 'endorsement'
    ? 'Approval decisions belong to people, not to me: I am an AI coach, and nothing here has been reviewed by a human EIR.'
    : `To be clear, I am ${personaName}, an AI coach, not a person.`;
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
  const patterns = [...BASE_PATTERNS, ...namePatterns(options.eirNames ?? [])].filter(
    (pat) => options.checkHumanClaims !== false || pat.kind !== 'claims_human',
  );
  const personaWords = new Set(
    normalizeText(options.personaName)
      .toLowerCase()
      .split(' ')
      .filter((word) => word !== ''),
  );
  const findings: IdentityFinding[] = [];
  let current = text;

  for (let guard = 0; guard < 25; guard += 1) {
    let hit: { start: number; end: number; kind: IdentityViolationKind; rule: string } | null = null;
    for (const pat of patterns) {
      pat.pattern.lastIndex = 0;
      const m = pat.pattern.exec(current);
      if (m && (hit === null || m.index < hit.start))
        hit = { start: m.index, end: m.index + m[0].length, kind: pat.kind, rule: pat.rule };
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
    const replacement = identityReplacement(hit.kind, options.personaName);
    const before = current.slice(0, span.start);
    const after = current.slice(span.end);
    const lead = before === '' || /\s$/.test(before) ? '' : ' ';
    const trail = after === '' || /^\s/.test(after) ? '' : ' ';
    current = `${before}${lead}${replacement}${trail}${after}`;
  }

  // Collapse repeated replacement sentences.
  for (const kind of ['endorsement', 'claims_human'] as const) {
    const sentence = escapeRegExp(identityReplacement(kind, options.personaName));
    current = current.replace(new RegExp(`(${sentence})(?:\\s*${sentence})+`, 'g'), '$1');
  }
  return { text: current, findings };
}
