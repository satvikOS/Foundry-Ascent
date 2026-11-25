import type { PromptGuidance } from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn } from './figures.js';
import { sharedCount, stemOf, stemsOf } from './stems.js';

/**
 * What a reply claims about the founder and their venture is what they said (first live run on Nova 2 Lite: templates were
 * filled with a subject they never named, a place they never said they knew, a monthly loss out of the air, and a venture with no sale was
 * told it had customers who pay). Deterministic, per unit:
 *
 * 1. a line of a template ("Why me: …") whose words are not theirs keeps its [bracket];
 * 2. a sentence that says they have customers, sales, interviews… that nothing of theirs mentions goes;
 * 3. a sum of money nobody gave as money ("maybe $30 to $60 a month", "offer 45") is not said;
 * 4. our own words for the method ("the playbook says") go.
 */

/** Words that claim nothing of their own in a line written for them. */
const GENERIC: ReadonlySet<string> = new Set(
  (
    'person people student someone anyone customer user buyer friend group type one real example app site page service product ' +
    'idea thing problem time money way day week month year campus school college university place help need want use try make ' +
    'get give find go work offer sell buy pay build create provide deliver reach talk ask know learn see guess seen maybe often ' +
    'each every many most some more less first next now today quickly easily simple easy better new small own able ready live'
  )
    .split(' ')
    .map(stemOf),
);

const LABELLED =
  /^(\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)?[*_]{0,2}([\p{L}][\p{L}\d '’/-]{1,40}?)[*_]{0,2}\s*:[*_]{0,2}\s*)(\S[\s\S]*)$/u;

/** What a line of the five-line page asks for, when no template of the turn says it. */
const ASKS_FOR: Readonly<Record<string, string>> = {
  who: '[one type of person]',
  problem: '[what goes wrong, and how often]',
  today: '[what they do now, and what it costs them]',
  'today they': '[what they do now, and what it costs them]',
  idea: '[what you would do, in one sentence]',
  'my idea': '[what you would do, in one sentence]',
  'why me': '[what you know, have or can reach]',
  price: '[price]',
  'pass line': '[number paid, by a date]',
};

/** The lines of the turn's template by their label. */
function templateLines(guidance: PromptGuidance): Map<string, string> {
  const out = new Map<string, string>();
  for (const body of [guidance.step?.template?.body, guidance.ask?.block]) {
    for (const raw of (body ?? '').split('\n')) {
      const m = LABELLED.exec(raw);
      if (m?.[2] !== undefined && m[3] !== undefined && !out.has(m[2].toLowerCase()))
        out.set(m[2].toLowerCase(), m[3].trim());
    }
  }
  return out;
}

/** A line that is only its mark. */
const STRAY_MARK = /^\s*[([]\s*(?:seen|guess|seen\s*\/\s*guess)\s*[)\]]\s*[.!]?\s*$/iu;
const MARK = /\s*[([]\s*(?:seen|guess|seen\s*\/\s*guess|guess\s*\/\s*seen)\s*[)\]]\s*[.!]?\s*$/iu;

/** Whether a line written for them says no more than they did. */
function isTheirs(value: string, label: string, guidance: PromptGuidance): boolean {
  const said = guidance.said ?? '';
  const text = value
    .replace(MARK, '')
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/[*_]+/g, '');
  const known = stemsOf(said);
  const numbers = knownNumbersIn(said);
  if (numbersIn(text).some((n) => !numbers.some((k) => Math.abs(k - n) < 0.005))) return false;
  const words = [...stemsOf(text)].filter((w) => !/^\d/.test(w));
  const own = words.filter((w) => !GENERIC.has(w));
  if (own.length === 0) return label !== 'why me' || words.length === 0;
  const shared = own.filter((w) => known.has(w)).length;
  if (label === 'why me') return shared >= 2 && shared / own.length >= 0.67;
  return shared / own.length >= 0.6 || (own.length - shared <= 1 && shared >= 1);
}

/** Work and traction a reply may only say they have when they said so. */
const TRACTION =
  /\b(?:pay(?:ing)? (?:customers?|users?|clients?|subscribers?)|customers?|clients?|subscribers?|sales|revenue|orders|pre-?orders|users|pilots?|interviews?|wait(?:ing)? ?list|sign-?ups|letters? of intent|investors?|co-?founders?|patents?|prototypes?|traction|demand|strangers)\b/iu;
const HAS =
  /\byou(?:['’]ve| have| still have| already have| now have| currently have| do have| got| still| already)(?: (?:got|already|still|now|proven|shown|had|validated|built|won|seen|run|done|completed|collected|enough|real|some|strong|clear|early|a few|several|your|the|a|an|first|two|three|four|five|\d+))* (?=\S)/iu;
const NOT_SAID =
  /\b(?:if|once|when|until|unless|whether|before|after|as soon as|should|could|would|will|might|can|need|want|imagine|suppose|say|once you|do you|not|never|no|don['’]t|haven['’]t|without)\b/iu;

/** A thing they are said to have that nothing they said mentions. */
function claimsTraction(unit: string, guidance: PromptGuidance): boolean {
  if (guidance.said === undefined || /[?]["'”’)\]*_]*\s*$/u.test(unit.trim())) return false;
  const has = HAS.exec(unit);
  if (has === null || NOT_SAID.test(unit.slice(0, has.index))) return false;
  const after = unit.slice(has.index + has[0].length, has.index + has[0].length + 60);
  const what = TRACTION.exec(`${has[0]}${after}`)?.[0];
  if (what === undefined || NOT_SAID.test(`${has[0]}${after}`.slice(0, `${has[0]}${after}`.indexOf(what))))
    return false;
  const known = stemsOf(guidance.said);
  const words = [...stemsOf(what)];
  const synonyms: Readonly<Record<string, string>> = {
    customer: 'customer client buyer pay sell buy order sale subscriber',
    client: 'customer client buyer pay sell order',
    sal: 'sell sale order pay buy',
    revenue: 'revenue sell pay sale charge',
    interview: 'interview talk speak ask conversation meet',
    user: 'user customer sign use test',
    order: 'order sell buy pay',
    demand: 'pay sell buy order sign want ask',
    traction: 'pay sell buy order sign customer',
    stranger: 'stranger pay sell buy customer',
  };
  const any = words.flatMap((w) => (synonyms[w] ?? w).split(' ').map(stemOf).concat(w));
  return sharedCount(new Set(any), known) === 0;
}

/** Our own words for the method, said to a founder. */
const OUR_WORDS: readonly (readonly [RegExp, string])[] = [
  [
    /(?<=^\s*|[.!?]\s+)(?:as )?the (?:playbook|play) (?:says|suggests|recommends|tells (?:you|us))(?: to| that)?,?\s+/giu,
    '',
  ],
  [
    /[,—–-]?\s*(?:exactly |just )?(?:(?:what|the \w+(?: \w+){0,3}) )?(?:the|our) (?:playbook|path engine) (?:says|suggests|recommends|asks for|tells (?:you|us))(?: to [^,.;!?]+)?(?=[ ,.;:!?]|$)/giu,
    '',
  ],
  [/\b(?:according to|per|from|in) (?:the|our) (?:playbook|play),?\s*/giu, ''],
  [/\b(?:the|this|our|your) playbook['’]?s?\b/giu, 'the method'],
];

/** The unit without our own words for the method, its sentence still a sentence. */
function withoutOurWords(unit: string): string {
  let text = unit;
  for (const [pattern, said] of OUR_WORDS) text = text.replace(pattern, said);
  if (text === unit) return unit;
  const opened = /^\s*[*_"“]*\p{Lu}/u.test(unit);
  return opened
    ? text.replace(/^(\s*[*_"“]*)(\p{Ll})/u, (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`)
    : text;
}

export interface OwnFacts {
  /** The unit as it may be said; '' when nothing of it may. */
  readonly text: string;
  readonly findings: readonly (
    'template_bracketed' | 'traction_unsupported' | 'money_unsupported' | 'own_words'
  )[];
}

const MONEY =
  /\$\s?(\d[\d,]*(?:\.\d+)?)(k\b)?(?:\s?[-–—~]\s?\$?\s?(\d[\d,]*(?:\.\d+)?))?|\b(\d[\d,]*(?:\.\d+)?)(?:\s?[-–—]\s?(\d[\d,]*(?:\.\d+)?))? (?:dollars|bucks|usd)\b/giu;
/** A price said without its unit ("offer 35 to ten next week", "raise it to 40"). */
const BARE_PRICE =
  /\b(?:offer|charge|price (?:it )?at|ask(?:ing)? for|raise (?:it |the price )?to|lower (?:it |the price )?to|sell (?:it |them )?(?:at|for)) (?:about |around |maybe )?(\d{1,6}(?:\.\d+)?)(?= (?:to|and|for|this|next|instead|per|a|an|each|now)\b|[.,;!?]|$)/giu;

/** Numbers a founder said as money without its unit ("the fee is 450", "we charge 12 a box"): never a count. */
const SAID_PRICE =
  /\b(?:price[ds]?|fee|fees|charge[sd]?|charging|costs?|pay(?:s|ing)?|paid|sells?(?: it| them)? (?:for|at)|rent|budget|worth|at|for|is|are|takes?|now|and [a-z]+|raise (?:it|the price) to|to)\s+(?:about |around |only |just )?(\d[\d,]*(?:\.\d+)?)\b(?!\s*(?:people|persons?|students?|customers?|users?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|times?|%|percent|of\b|out of|in\b|am\b|pm\b|a\.m|p\.m|slides?|talks?|interviews?))/giu;

function saidMoney(text: string): number[] {
  return [
    ...moneyValues(text),
    ...[...text.matchAll(SAID_PRICE)].map((m) => Number((m[1] ?? '').replace(/,/g, ''))),
  ];
}

function moneyValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const k = m[2] === undefined ? 1 : 1000;
    for (const raw of [m[1], m[3], m[4], m[5]])
      if (raw !== undefined) out.push(Number(raw.replace(/,/g, '')) * k);
  }
  return out;
}

/** Money of a sentence that is neither theirs, the program's, nor a sum given or worked out from theirs. */
function inventedMoney(unit: string, guidance: PromptGuidance, known: string): number[] {
  const said = `${guidance.said ?? ''}\n${(guidance.calc ?? []).join('\n')}`;
  const given = [...moneyValues(known), ...saidMoney(said)];
  const counts = knownNumbersIn(said);
  const ok = (v: number): boolean =>
    v === 0 || given.some((g) => Math.abs(g - v) < 0.005) || derived(v, given, counts);
  const bare = [...unit.matchAll(BARE_PRICE)].map((m) => Number(m[1]));
  if (bare.length > 0)
    for (const m of unit.matchAll(
      /\b(?:and|or|then|versus|vs\.?) (\d{1,6}(?:\.\d+)?)(?= (?:to|next|for|instead|at)\b|[.,;!?]|$)/giu,
    ))
      bare.push(Number(m[1]));
  return [...moneyValues(unit), ...bare].filter((v) => !ok(v));
}

/** A sum worked out from their money: of two amounts, or of an amount and a count of theirs. */
function derived(value: number, amounts: readonly number[], counts: readonly number[]): boolean {
  const near = (r: number): boolean => Math.abs(r - value) <= Math.max(0.005, Math.abs(value) * 0.005);
  const money = [...new Set(amounts)].filter((n) => n > 0).slice(0, 24);
  const all = [...new Set([...money, ...counts])].filter((n) => n > 1).slice(0, 40);
  return money.some((a) =>
    all.some((b) => near(a * b) || near(a / b) || (money.includes(b) && (near(a + b) || near(a - b)))),
  );
}

/**
 * One unit of a reply as it may be said of the founder: see the module comment. `known`: what else may be stated (the
 * evidence and the program's text).
 */
export function ownFactsUnit(
  unit: string,
  guidance: PromptGuidance | null,
  options: { readonly known?: string } = {},
): OwnFacts {
  const findings: OwnFacts['findings'][number][] = [];
  if (guidance === null) return { text: unit, findings };
  const text = withoutOurWords(unit);
  if (text !== unit) findings.push('own_words');
  if (guidance.said !== undefined) {
    // A mark that a line left behind ("(guess)").
    if (STRAY_MARK.test(text)) return { text: '', findings: ['template_bracketed'] };
    const line = LABELLED.exec(text);
    const label = line?.[2]?.toLowerCase() ?? '';
    const given = templateLines(guidance).get(label);
    // Only what a template asks them to fill in: a script to say is the program's, or theirs to change.
    const fills =
      given !== undefined &&
      !/^["“]/u.test(given) &&
      (given.includes('[') || MARK.test(given) || ASKS_FOR[label] !== undefined);
    const asks = fills ? given : ASKS_FOR[label];
    if (line !== null && asks !== undefined && line[3] !== undefined && !/^["“]/u.test(line[3].trim())) {
      // As the template gives it, or with nothing that is not theirs.
      const value = line[3].trim();
      const plain = (t: string): string => t.replace(/[*_]+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        plain(value) !== plain(asks) &&
        (!isTheirs(value, label, guidance) || inventedMoney(value, guidance, '').length > 0)
      ) {
        findings.push('template_bracketed');
        return { text: `${line[1] ?? ''}${asks}`, findings };
      }
      return { text, findings };
    }
    if (claimsTraction(text, guidance)) {
      findings.push('traction_unsupported');
      return { text: '', findings };
    }
  }
  if (guidance.said !== undefined) {
    const invented = inventedMoney(text, guidance, options.known ?? '');
    if (invented.length > 0) {
      findings.push('money_unsupported');
      return { text: '', findings };
    }
  }
  return { text, findings };
}
