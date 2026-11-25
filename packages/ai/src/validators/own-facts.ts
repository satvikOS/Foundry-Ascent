import type { PromptGuidance } from '../prompts/guidance.js';
import { knownNumbersIn, numbersIn } from './figures.js';
import { TO_FILL, withoutEmptyBrackets } from './method.js';
import { sharedCount, stemOf, stemsOf } from './stems.js';
import { operandsIn, workedFrom, workedShape, type Operand } from './worked.js';

/**
 * What a reply claims about the founder and their venture is what they said (first live run on Nova 2 Lite: templates were
 * filled with a subject they never named, a place they never said they knew, a monthly loss out of the air, and a venture with no sale was
 * told it had customers who pay). Deterministic, per unit:
 *
 * 1. a line of a template ("Why me: …") whose words are not theirs keeps its [bracket];
 * 2. a sentence that says they have customers, sales, interviews… that nothing of theirs mentions goes;
 * 3. a sum of money nobody gave as money ("maybe $30 to $60 a month", "offer 45") is not said;
 * 4. our own words for the method ("the playbook says") go;
 * 5. a verdict only buyers can give ("your fee is right", "they are willing to pay") goes while none has paid or answered, and
 *    so does a number they are said to have set and never did;
 * 6. "By now we ran it at two piers" in a line written for them, when they told of nothing of the kind, keeps its
 *    [bracket];
 * 7. what people are said to have said that nothing of theirs tells ("the sailmakers said they want a phone version") goes.
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
  /^(\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+)?[*_]{0,2}([\p{L}][\p{L}\d '’/-]{1,40}?)[*_]{0,2}\s*(?::|[—–]|\s-\s)[*_]{0,2}\s*)(\S[\s\S]*)$/u;

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

const PAID_SAID =
  /\b(?:paid|pays|paying|bought|ordered|orders|sold|signed|pre-?ordered|renewed|subscribed)\b/iu;
/** Their own spending, or what others charge, is no buyer's answer. */
const buyersAnswered = (said: string): boolean =>
  said
    .split(/[.;\n!?]+/u)
    .some(
      (c) =>
        PAID_SAID.test(c) &&
        !/\b(?:nobody|no one|none|not|never|didn['’]t|i|we) (?:\w+ ){0,2}(?:paid|bought|ordered|signed)\b|\bnobody\b|\bno one\b/iu.test(
          c,
        ),
    );
const VERDICT_ON_PRICE =
  /\b(?:your|the|that|this|it|its) ?(?:current |new )?(?:fee|price|rate|pricing|charge)?(?: of [^.!?]{1,20})? (?:is|are|looks|seems|sounds)(?: just| about| probably| definitely| already)? (?:right|fair|reasonable|correct|fine|good|about right|well priced|spot on|in the right range|too (?:low|high|cheap|expensive))\b/iu;
const ABOUT_PRICE = /\b(?:fee|price|rate|pricing|charge)\b/iu;
const WILL_PAY =
  /\b(?:signal|sign|proof|evidence|shows?|proves?|means?|confirms?|tells? (?:you|us))\b[^.!?]{0,50}\b(?:willing(?:ness)? to pay|(?:they|people|students|customers|users|buyers)(?:['’]d| would| will|['’]ll| are ready to| want to) pay|real demand|there is demand)\b|\b(?:they|people|students|customers|users|buyers) are willing to pay\b/iu;
const HEDGED =
  /\b(?:not|n['’]t|never|no|whether|if|yet|until|before|unless|without|may|might|could|once|when|how|ask|test|see|find out|know)\b/iu;
const LINE_SET =
  /\b(?:line|target|goal|number|bar|mark|threshold) (?:that )?you(?:['’]d| had)? (?:set|wrote|chose|agreed|picked)\b/iu;
const SET_BY_THEM = /\b(?:pass line|pass mark|target|goal|at least|bar|threshold|need(?:ed)? \d+)\b/iu;
const SO_FAR = /^(\s*["“*_]*)so far,?\s+(?=.)/iu;
const DID_SO_FAR =
  /\b(?:we|i)(?:['’]ve| have)?\b[^.!?]{0,40}\b(?:tested|talked|spoke|sold|signed|piloted|interviewed|shown|showed|ran|run|helped|worked|reached|won|got|had|have)\b|\b(?:used|tried|bought|paid|signed|said|asked|joined|ordered|cut)\b/iu;

/** What a verdict only buyers can give, or a number they never set, is worth: nothing of it is said. */
function unearned(unit: string, guidance: PromptGuidance): boolean {
  const said = guidance.said ?? '';
  if (/[?]["'”’)\]*_]*\s*$/u.test(unit.trim())) return false;
  if (LINE_SET.test(unit) && !SET_BY_THEM.test(said)) return true;
  if (buyersAnswered(said)) return false;
  if (VERDICT_ON_PRICE.test(unit) && ABOUT_PRICE.test(unit) && !HEDGED.test(unit)) return true;
  const pays = WILL_PAY.exec(unit);
  // "Tells you little about what they'll pay" is no verdict.
  if (pays !== null && guidance.reading !== undefined && /\b(?:little|nothing|hardly)\b/iu.test(pays[0]))
    return false;
  return pays !== null && !HEDGED.test(unit.slice(0, pays.index + pays[0].length));
}

const PEOPLE =
  '(?:teachers?|students?|customers?|users?|buyers?|parents?|nurses?|owners?|managers?|founders?|clients?|families|shops?|clinics?|caterers?|people|interviewees|patients?|diners?|restaurants?|trucks?|marinas?|labs?|they|most(?: of them)?|some(?: of them)?|all of them|the (?:others|rest|ones?)|\\p{L}+(?:ers|ors|ists|ians|ants|ents))';
/** "The sailmakers who lack a bench said they want a phone version": people quoted. */
const PEOPLE_SAID = new RegExp(
  String.raw`(?:^|[\s(,;:])(?:(?:the|your|these|those|\d+|\p{L}+) )?${PEOPLE}\b(?:[^.!?;:]{0,40}?) (?:said|told (?:you|us)|mentioned|reported|agreed|admitted|confirmed|complained|explained)(?: to you)?(?: that)? ([^.!?;]{12,})`,
  'iu',
);
const SAYING_OPEN =
  /\b(?:if|when|once|whether|what|until|unless|imagine|suppose|ask|who|anyone|someone|people often)\b/iu;

/** What people are said to have said, when nothing the founder told holds it. */
function inventsSpeech(unit: string, guidance: PromptGuidance): boolean {
  if (guidance.said === undefined || /[?]["'”’)\]*_]*\s*$/u.test(unit.trim())) return false;
  const m = PEOPLE_SAID.exec(unit);
  // "The sailmakers who lack a bench said" names them; "ask who said" does not.
  const opens = unit
    .slice(0, m === null ? 0 : m.index + m[0].length - (m[1] ?? '').length)
    .replace(/\b(?:the|your|these|those|\d+) \p{L}+ who\b/giu, ' ');
  if (m?.[1] === undefined || SAYING_OPEN.test(opens)) return false;
  const claim = stemsOf(m[1]);
  if (claim.size < 2) return false;
  // One sentence of theirs holds most of it: words of the idea gathered from everywhere are nobody's answer.
  return !`${guidance.said}\n${guidance.lead?.text ?? ''}\n${(guidance.facts ?? []).join('\n')}`
    .split(/(?<=[.!?;])\s+|\n/u)
    .some((s) => sharedCount(claim, stemsOf(s)) >= claim.size * 0.5);
}

/** "By now we ran it at two piers…" of a pitch written for them, when nothing they told says so. */
function soFar(unit: string, guidance: PromptGuidance): string | null {
  const opens = SO_FAR.exec(unit);
  if (opens === null || unit.includes('[') || !DID_SO_FAR.test(unit)) return null;
  const rest = unit.slice(opens[0].length);
  const said = guidance.said ?? '';
  const numbers = knownNumbersIn(said);
  const invented = numbersIn(rest).some((n) => !numbers.some((k) => Math.abs(k - n) < 0.005));
  const words = [...stemsOf(rest)].filter((w) => !/^\d/.test(w) && !GENERIC.has(w));
  const known = stemsOf(said);
  const theirs = words.filter((w) => known.has(w)).length;
  if (!invented && words.length > 0 && theirs / words.length >= 0.5) return null;
  return `${opens[1] ?? ''}So far [what you have shown: who, how many, what they did].`;
}

/** Our own words for the method, said to a founder. */
const OUR_WORDS: readonly (readonly [RegExp, string])[] = [
  [
    /(?<=^\s*|[.!?]\s+)(?:as )?(?:the|our) (?:program(?:me)?(?:['’]s)? (?:playbook|method)|playbook|play|program(?:me)?) (?:says|suggests|recommends|asks you|tells (?:you|us))(?: to| that)?,?\s+/giu,
    '',
  ],
  [
    /[,—–-]?\s*(?:exactly |just )?(?:(?:what|the \w+(?: \w+){0,3}) )?(?:the|our) (?:program(?:me)?(?:['’]s)? )?(?:playbook|path engine) (?:says|suggests|recommends|asks for|tells (?:you|us))(?: to [^,.;!?]+)?(?=[ ,.;:!?]|$)/giu,
    '',
  ],
  [/\b(?:according to|per|from|in) (?:the|our) (?:program(?:me)?(?:['’]s)? )?(?:playbook|play),?\s*/giu, ''],
  [/\b(?:the|this|our|your) (?:program(?:me)?(?:['’]s)? )?playbook['’]?s?\b/giu, 'the method'],
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
    | 'template_bracketed'
    | 'traction_unsupported'
    | 'money_unsupported'
    | 'sum_beside'
    | 'count_beside'
    | 'own_words'
    | 'speech_unsupported'
    | 'verdict_unsupported'
  )[];
}

const MONEY =
  /\$\s?(\d[\d,]*(?:\.\d+)?)(k\b|\s?(?:thousand|million|billion)\b)?(?:\s?[-–—~]\s?\$?\s?(\d[\d,]*(?:\.\d+)?))?|\b(\d[\d,]*(?:\.\d+)?)(?:\s?[-–—]\s?(\d[\d,]*(?:\.\d+)?))? (?:dollars|bucks|usd)\b/giu;
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
    // "They cap it at 220k": nobody counts people like that.
    ...[...text.matchAll(/(?<![\p{L}\d.])\d[\d,]*(?:\.\d+)?\s?(?:k|grand|million)\b/giu)].flatMap((m) =>
      numbersIn(m[0].replace(/ ?grand$/iu, 'k')),
    ),
  ];
}

function moneyValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const k = /million/iu.test(m[2] ?? '')
      ? 1e6
      : /billion/iu.test(m[2] ?? '')
        ? 1e9
        : m[2] === undefined
          ? 1
          : 1000;
    for (const raw of [m[1], m[3], m[4], m[5]])
      if (raw !== undefined) out.push(Number(raw.replace(/,/g, '')) * k);
  }
  return out;
}

/** Money of a sentence that is neither theirs, the program's, nor a sum given or worked out from theirs. */
function inventedMoney(unit: string, guidance: PromptGuidance, known: string, before = ''): number[] {
  const said = `${guidance.said ?? ''}\n${(guidance.calc ?? []).join('\n')}`;
  const given = [...moneyValues(known), ...saidMoney(said)];
  const counts = knownNumbersIn(said);
  const ok = (v: number): boolean =>
    v === 0 || given.some((g) => Math.abs(g - v) < 0.005) || derived(v, given, counts);
  const onTheWay: number[] = [];
  const bare = [...unit.matchAll(BARE_PRICE)].map((m) => Number(m[1]));
  if (bare.length > 0)
    for (const m of unit.matchAll(
      /\b(?:and|or|then|versus|vs\.?) (\d{1,6}(?:\.\d+)?)(?= (?:to|next|for|instead|at)\b|[.,;!?]|$)/giu,
    ))
      bare.push(Number(m[1]));
  // A sum shown on the way counts for the next one ("13 a lamp, so 20 lamps bring 260, and 165 after the stall").
  const shown = numbersIn(unit);
  const asked = guidance.asksSum === true ? [...given, ...counts] : [];
  const worked = workedOn(`${before.slice(-400)} ${unit}`, [...given, ...counts], asked);
  return [...moneyValues(unit), ...bare].filter((v) => {
    const fine =
      ok(v) || onTheWay.some((s) => shown.some((n) => stepOf(v, s, n))) || worked(v) || workedShape(v, asked);
    if (fine && !given.some((g) => Math.abs(g - v) < 0.005)) onTheWay.push(v);
    return !fine;
  });
}

/** Whether a value is worked out from numbers of theirs that the text shows (validators/worked.ts). */
function workedOn(
  text: string,
  theirs: readonly number[],
  asked: readonly number[],
): (value: number) => boolean {
  const all = operandsIn(text);
  return (value) => {
    const out: Operand[] = [];
    for (const o of all) {
      if (Math.abs(o.value - value) < 0.0051) continue;
      if (
        theirs.some((n) => Math.abs(n - o.value) < 0.005) ||
        workedFrom(o.value, out) ||
        workedShape(o.value, asked)
      )
        out.push(o);
    }
    return workedFrom(value, out);
  };
}

/** Whether a value is one step of arithmetic on two shown ones. */
function stepOf(value: number, a: number, b: number): boolean {
  const near = (r: number): boolean => Math.abs(r - value) <= Math.max(0.005, Math.abs(value) * 0.005);
  return b > 1 && (near(a * b) || near(a / b) || near(a - b) || near(a + b));
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

/** A number in front of a list item is its place. */
const MARKER = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u;

/**
 * A number of the model's own beside a sum code worked out and opened the reply with (live: two
 * answers to one question): what is neither theirs, the sum's nor given this turn is a second sum nobody checked.
 */
export function besideTheSum(unit: string, guidance: PromptGuidance, known: string): boolean {
  const lead = guidance.lead?.text ?? '';
  const calc = guidance.calc ?? [];
  if (lead === '' || !calc.some((c) => lead.includes(c))) return false;
  const numbers = numbersIn(unit.replace(MARKER, '').replace(/\[\s*E\d+[^\]]*\]/giu, ' ')).filter(
    (n) => n > 1,
  );
  if (numbers.length === 0) return false;
  const given = knownNumbersIn([guidance.said ?? '', lead, ...calc, known].join('\n'));
  return numbers.some((n) => !given.some((g) => Math.abs(g - n) < 0.005));
}

const SPELLED: Readonly<Record<string, string>> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  twelve: '12',
};
/** Each "n of (the) m" of a text. */
function partsOf(text: string): [number, number][] {
  const digits = text
    .toLowerCase()
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/g, (w) => SPELLED[w] ?? w);
  return [
    ...digits.matchAll(/(?<![\d.$])(\d+) (?:out )?of (?:the |your |those |these |them |all )*(\d+)\b/g),
  ].map((m) => [Number(m[1]), Number(m[2])]);
}

/** Another count of the same whole than the server's lead gives ("2 of the 5"; "4 of the 5"), that nobody told. */
function besideTheCount(unit: string, guidance: PromptGuidance): boolean {
  const lead = partsOf(guidance.lead?.text ?? '');
  if (lead.length === 0) return false;
  const told = partsOf(guidance.said ?? '');
  return partsOf(unit).some(
    ([part, whole]) =>
      lead.some(([, w]) => w === whole) &&
      ![...lead, ...told].some(([p, w]) => w === whole && (p === part || w - p === part)),
  );
}

/**
 * One unit of a reply as it may be said of the founder: see the module comment. `known`: what else may be stated (the
 * evidence and the program's text).
 */
export function ownFactsUnit(
  unit: string,
  guidance: PromptGuidance | null,
  options: { readonly known?: string; readonly before?: string } = {},
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
        // Asked for the words, a line of facts is no template's line.
        !(
          guidance.draft === true &&
          guidance.reading !== undefined &&
          inventedMoney(value, guidance, '').length === 0
        ) &&
        (!isTheirs(value, label, guidance) || inventedMoney(value, guidance, '').length > 0)
      ) {
        findings.push('template_bracketed');
        // A blank of the template alone ("[ ], [ ]") is nothing to show.
        const given = withoutEmptyBrackets(asks);
        return { text: `${line[1] ?? ''}${given.trim() === '' ? TO_FILL : given}`, findings };
      }
      return { text, findings };
    }
    if (unearned(text, guidance)) {
      findings.push('verdict_unsupported');
      return { text: '', findings };
    }
    const bracketed = soFar(text, guidance);
    if (bracketed !== null) {
      findings.push('template_bracketed');
      return { text: bracketed, findings };
    }
    if (inventsSpeech(text, guidance)) {
      findings.push('speech_unsupported');
      return { text: '', findings };
    }
    if (claimsTraction(text, guidance)) {
      findings.push('traction_unsupported');
      return { text: '', findings };
    }
  }
  if (besideTheSum(text, guidance, options.known ?? '')) {
    findings.push('sum_beside');
    return { text: '', findings };
  }
  if (besideTheCount(text, guidance)) {
    findings.push('count_beside');
    return { text: '', findings };
  }
  if (guidance.said !== undefined) {
    const invented = inventedMoney(text, guidance, options.known ?? '', options.before ?? '');
    if (invented.length > 0) {
      findings.push('money_unsupported');
      return { text: '', findings };
    }
  }
  return { text, findings };
}
