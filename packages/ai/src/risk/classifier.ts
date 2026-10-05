import { RiskCategory } from '@foundry/contracts';

import {
  foldDiacritics,
  foldLeetspeak,
  normalizeForMatching,
  normalizeText,
  personNameRegExp,
  spacedLetterRuns,
  ventureNameRegExp,
} from './normalize.js';
import { RISK_RULES, SQUASHED_INJECTION_SIGNATURES, type RiskRule } from './rules.js';

/** Result of the deterministic pre-classifier for one founder message. */
export interface RiskClassification {
  /** Distinct categories in canonical (`RiskCategory`) order. */
  categories: RiskCategory[];
  /** Self-harm, suicide or imminent danger: answer with human support, no model call. */
  crisis: boolean;
  /** Prompt-injection / instruction-exfiltration attempt. */
  injection: boolean;
  /** Request for another venture's information (or mentions another venture by name). */
  crossVentureRequest: boolean;
  /** Ids (`<category>:<rule>`) of every rule that fired, in evaluation order. Never contains text. */
  matchedRules: string[];
}

export interface ClassifyRiskOptions {
  /**
   * Names of the *other* ventures in the tenant. A message that names one is a cross-venture
   * request. Only distinctive names count (`ventureNameProblem`): a name that is a common word, too short,
   * or only common words would match ordinary messages and is ignored.
   */
  otherVentureNames?: readonly string[];
  /**
   * Display names of the *members* of other ventures in the tenant (founders, team, advisors). A message
   * that names one is a cross-venture request (membership inference). Single-word names are ignored.
   */
  otherVentureMemberNames?: readonly string[];
}

/** Hard cap on analysed characters (turn text is ≤ 8 000 characters by schema). */
const MAX_ANALYSED_CHARS = 20_000;
/** Minimum length for a token to be treated as a candidate base64 payload. */
const MIN_BASE64_CHARS = 24;

const CATEGORY_ORDER = RiskCategory.options;

interface Span {
  start: number;
  end: number;
}

function spans(pattern: RegExp, text: string): Span[] {
  const out: Span[] = [];
  for (const match of text.matchAll(pattern)) {
    out.push({ start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/**
 * The clause before a match says the data is not handled at all: "will not collect any", "no",
 * "without storing", "never record the". Deliberately narrow (data-handling verbs only), so "we do not
 * have patient consent yet" is still flagged.
 */
const NEGATED_HANDLING = new RegExp(
  [
    '(?:^|[^\\p{L}])(?:',
    'no',
    '|zero',
    "|(?:not|never|no longer|won'?t|wouldn'?t|will not|would not|don'?t|do not|doesn'?t|does not|didn'?t|did not|can'?t|cannot|shouldn'?t|should not|without)",
    '(?: \\p{L}+){0,2}? (?:collect|collecting|store|storing|record|recording|gather|gathering|use|using|access|accessing|need|needing|touch|touching|handle|handling|see|seeing|process|processing|keep|keeping|share|sharing|ask for|asking for|request|requesting|capture|capturing|save|saving|retain|retaining|receive|receiving)',
    ')(?: any| the| their| its| identifiable| real| actual)*\\s*$',
  ].join(''),
  'u',
);

/** The part of `text` before `index` that belongs to the same clause. */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 120), index);
  const cut = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf(';'),
  );
  const clause = cut >= 0 ? before.slice(cut + 1) : before;
  const but = clause.lastIndexOf(' but ');
  return but >= 0 ? clause.slice(but + 5) : clause;
}

/** Whether `rule` has at least one positive match in `text` not fully covered by an exclusion. */
function ruleMatches(rule: RiskRule, text: string): boolean {
  const excluded = rule.exclude?.flatMap((pattern) => spans(pattern, text)) ?? [];
  for (const pattern of rule.patterns) {
    for (const hit of spans(pattern, text)) {
      const covered = excluded.some((x) => x.start <= hit.start && x.end >= hit.end);
      if (covered) continue;
      if (rule.negatable === true && NEGATED_HANDLING.test(clauseBefore(text, hit.start))) continue;
      return true;
    }
  }
  return false;
}

function mostlyUpperCase(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 12) return false;
  const upper = text.match(/\p{Lu}/gu)?.length ?? 0;
  return upper / letters > 0.6;
}

/** Decodes plausible base64 tokens to printable text so hidden instructions can be inspected. */
function decodedBase64Payloads(original: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`[A-Za-z0-9+/_-]{${MIN_BASE64_CHARS},}={0,2}`, 'g');
  for (const match of original.matchAll(pattern)) {
    const token = match[0];
    if (!/[A-Z]/.test(token) || !/[a-z]/.test(token)) continue; // hashes/ids are usually single-case hex
    let decoded: string;
    try {
      decoded = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (decoded.length < 8) continue;
    const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, '').length / decoded.length;
    if (printable >= 0.9) out.push(decoded);
    if (out.length >= 5) break;
  }
  return out;
}

const INJECTION_RULES = RISK_RULES.filter((r) => r.category === 'prompt_injection');

/**
 * Deterministic risk pre-classifier (runs before retrieval and the model call).
 *
 * Rules are keyword/regex families with Unicode-aware word boundaries, evaluated on NFKC-normalised,
 * lower-cased text with invisible characters removed and homoglyphs folded, and again with Latin
 * diacritics removed (multilingual rules: Spanish, French, German, Portuguese, Italian, plus crisis
 * language in Russian, Chinese, Japanese, Arabic and Hindi). Data-handling rules honour clause-level
 * negation ("we will not collect any patient information"). Prompt-injection rules
 * are additionally evaluated on leetspeak-folded text, spaced-out letter runs and decoded base64
 * payloads. The result contains rule ids only, never message text, so it is safe to log.
 */
export function classifyRisk(text: string, options: ClassifyRiskOptions = {}): RiskClassification {
  if (typeof text !== 'string' || text.trim() === '') {
    return { categories: [], crisis: false, injection: false, crossVentureRequest: false, matchedRules: [] };
  }
  const bounded = text.length > MAX_ANALYSED_CHARS ? text.slice(0, MAX_ANALYSED_CHARS) : text;
  const cased = normalizeText(bounded);
  const lower = normalizeForMatching(bounded);
  // Accent-free variant: multilingual rules are written without diacritics (`est-ce legal`, `hoffnungslos`).
  const folded = foldDiacritics(lower);
  const leet = foldLeetspeak(lower);
  const shouting = mostlyUpperCase(cased);

  const matched: string[] = [];
  const categories = new Set<RiskCategory>();
  const state = { crisis: false };
  const fire = (rule: { id: string; category: RiskCategory; crisis?: boolean }): void => {
    if (!matched.includes(rule.id)) matched.push(rule.id);
    categories.add(rule.category);
    if (rule.crisis === true) state.crisis = true;
  };

  for (const rule of RISK_RULES) {
    if (rule.caseSensitive === true) {
      if (!shouting && ruleMatches(rule, cased)) fire(rule);
      continue;
    }
    if (
      ruleMatches(rule, lower) ||
      (folded !== lower && ruleMatches(rule, folded)) ||
      (rule.evasionAware === true && leet !== lower && ruleMatches(rule, leet))
    ) {
      fire(rule);
    }
  }

  // Spaced-out letters: "i g n o r e  a l l  p r e v i o u s  i n s t r u c t i o n s".
  const squashed = spacedLetterRuns(lower);
  if (squashed.some((run) => SQUASHED_INJECTION_SIGNATURES.some((sig) => run.includes(sig)))) {
    fire({ id: 'prompt_injection:spaced_letters', category: 'prompt_injection' });
  }

  // Instructions hidden in base64.
  for (const payload of decodedBase64Payloads(bounded)) {
    const payloadLower = normalizeForMatching(payload);
    if (INJECTION_RULES.some((rule) => ruleMatches(rule, payloadLower))) {
      fire({ id: 'prompt_injection:base64_payload', category: 'prompt_injection' });
      break;
    }
  }

  // Other ventures named explicitly (distinctive names only: a common word would match everything).
  for (const name of options.otherVentureNames ?? []) {
    const pattern = ventureNameRegExp(name);
    if (pattern?.test(lower)) {
      fire({ id: 'cross_venture_request:named_venture', category: 'cross_venture_request' });
      break;
    }
  }

  // Members of other ventures named explicitly ("Is <name> a founder here, and with which venture?").
  for (const name of options.otherVentureMemberNames ?? []) {
    const pattern = personNameRegExp(name);
    if (pattern?.test(lower) === true || (folded !== lower && pattern?.test(folded) === true)) {
      fire({ id: 'cross_venture_request:named_member', category: 'cross_venture_request' });
      break;
    }
  }

  if (state.crisis) categories.add('safety_wellbeing');
  return {
    categories: CATEGORY_ORDER.filter((c) => categories.has(c)),
    crisis: state.crisis,
    injection: categories.has('prompt_injection'),
    crossVentureRequest: categories.has('cross_venture_request'),
    matchedRules: matched,
  };
}

/** Categories that are consequential enough to force a human escalation (excludes injection/cross-venture). */
export function isHighRiskCategory(category: RiskCategory): boolean {
  return category !== 'prompt_injection' && category !== 'cross_venture_request';
}

/**
 * Compact label for `turns.risk_label`: `crisis`, `high`, `injection`, `cross_venture` or `none`
 * (in that precedence order).
 */
export function riskLabel(
  classification: Pick<RiskClassification, 'categories' | 'crisis'>,
): 'crisis' | 'high' | 'injection' | 'cross_venture' | 'none' {
  if (classification.crisis) return 'crisis';
  if (classification.categories.some(isHighRiskCategory)) return 'high';
  if (classification.categories.includes('prompt_injection')) return 'injection';
  if (classification.categories.includes('cross_venture_request')) return 'cross_venture';
  return 'none';
}
