import { plain, singular } from './words.js';

/**
 * Sums a student asks for, worked out by code from their own words: what one sale leaves, a margin, a month, a break-even,
 * an hourly rate, a conversion, a payback, a runway. The model never does arithmetic: it is given these lines and says them
 * as they are. A number counts only when its role is said ("sells for", "costs", "a month"): an unclear one is never
 * guessed, and a per-unit figure is never mixed with a per-month one. Pure: the same words give the same lines.
 */

export type CalcAsk =
  | 'contribution'
  | 'margin'
  | 'monthly'
  | 'revenue'
  | 'break_even'
  | 'hourly'
  | 'conversion'
  | 'payback'
  | 'runway'
  | 'time';

export type QuantityRole =
  | 'price'
  | 'unit_cost'
  | 'period_cost'
  | 'one_time'
  | 'volume'
  | 'unit_time'
  | 'week_hours'
  | 'cash'
  | 'revenue';

export type Period = 'hour' | 'day' | 'week' | 'month' | 'year' | 'other';

/** One number of theirs with its unit and its role. */
export interface Quantity {
  readonly role: QuantityRole;
  readonly low: number;
  /** Above `low` when they gave a range. */
  readonly high: number;
  /** What one of it is of ("box"); null when they did not say. */
  readonly noun: string | null;
  readonly period: Period | null;
  /** What the cost is for ("beads"); '' when it is not said. */
  readonly label: string;
  /** The batch a cost or a count is of ("morning"), when it is neither one unit nor a month. */
  readonly batch?: string;
}

/** "13 of 25 sold". */
export interface Ratio {
  readonly part: number;
  readonly whole: number;
}

export interface CalcInput {
  readonly message: string;
  /** The founder's earlier messages, oldest first. */
  readonly earlier?: readonly string[];
  /** What the record and the intake hold, oldest first: read before anything they said here. */
  readonly record?: readonly string[];
  /** What they ask for when the message itself does not say it (the play of their ask: unit economics). */
  readonly ask?: CalcAsk | null;
}

export interface CalcResult {
  /** What they ask to have worked out; null: they ask for no sum. */
  readonly ask: CalcAsk | null;
  /** The lines to say, word for word: the asked one first. */
  readonly lines: readonly string[];
  /** The one number that is missing, as the question to ask; null when nothing is. */
  readonly missing: string | null;
}

// Words to numbers --------------------------------------------------------------------------------------------------

const ONES: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const NUMBER_WORD = `(?:${[...Object.keys(ONES), ...Object.keys(TENS)].join('|')}|hundred|thousand)`;
/** "forty", "twenty five", "one hundred and twenty", "a thousand". */
const SPELLED = new RegExp(
  `\\b(?:an? (?=hundred|thousand))?${NUMBER_WORD}(?:(?:[ -]| and (?=${NUMBER_WORD}\\b))${NUMBER_WORD})*\\b`,
  'g',
);

/** A run of number words as one number; null when it is several ("twelve fifty"). */
function spelledValue(run: string): number | null {
  let total = 0;
  let current = 0;
  let last = Number.POSITIVE_INFINITY;
  for (const word of run.split(/[ -]+/)) {
    if (word === 'and' || word === 'a' || word === 'an') continue;
    if (word === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
      last = 100;
      continue;
    }
    if (word === 'thousand') {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      last = 1000;
      continue;
    }
    const n = ONES[word] ?? TENS[word];
    if (n === undefined) return null;
    const size = n < 10 ? 1 : n < 20 ? 10 : 10;
    // "twelve fifty", "two five": two numbers side by side.
    if (
      last <= 1 ||
      (last === 10 && size !== 1) ||
      (last === 10 && current % 100 < 20 && current % 100 >= 10)
    )
      return null;
    current += n;
    last = size;
  }
  return total + current;
}

const UNIT_WORDS = '(?:each|apiece|a ?piece|per (?:unit|item|piece|sale|order)|a pop)';
const CURRENCY = '(?:dollars?|bucks?|usd)';

/** Their words on one line, numbers as digits and money as "$12.5" ("$3~5" for a range). */
export function saidNumbers(text: string): string {
  let t = plain(text)
    .replace(/\n+/g, '. ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\bhalf a dozen\b/g, '6')
    .replace(/\b(?:a|one) dozen\b/g, '12')
    .replace(/\b(\d+|two|three|four|five|six|ten) dozen\b/g, (_m, n: string) =>
      String((ONES[n] ?? Number(n)) * 12),
    )
    .replace(/\b(?:an )?hour and a half\b/g, '90 minutes')
    .replace(/\bhalf (?:an )?hour\b/g, '30 minutes')
    .replace(/\b(\w+) and a half (hours?|dollars?|bucks?)\b/g, (whole, n: string, unit: string) => {
      const value = ONES[n] ?? Number(n);
      return Number.isFinite(value) ? `${String(value + 0.5)} ${unit}` : whole;
    })
    .replace(/\ba (dollar|buck)\b/g, '1 $1')
    .replace(/\ban hour\b(?= (?:each|per|for (?:one|each)|to )|[.,]|$)/g, '1 hour');
  t = t.replace(SPELLED, (run) => {
    const value = spelledValue(run);
    return value === null ? run : String(value);
  });
  t = t
    .replace(/(\$ ?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?) ?k\b/g, (_m, n: string) =>
      n.startsWith('$') ? `$${String(Number(n.slice(1)) * 1000)}` : String(Number(n) * 1000),
    )
    .replace(/\b(\d+(?:\.\d+)?) grand\b/g, (_m, n: string) => `$${String(Number(n) * 1000)}`)
    .replace(/\b(\d+) thousand\b/g, (_m, n: string) => String(Number(n) * 1000))
    // "twelve dollars and fifty cents", "twelve dollars fifty".
    .replace(
      new RegExp(`\\b(\\d+) ${CURRENCY}(?: and)? (\\d{2})(?: cents)?\\b(?! \\w+s\\b)`, 'g'),
      (_m, a: string, b: string) => `$${a}.${b}`,
    )
    .replace(
      new RegExp(`\\b(\\d+) ${CURRENCY}(?: and)? (\\d{1,2}) cents\\b`, 'g'),
      (_m, a: string, b: string) => `$${a}.${b.padStart(2, '0')}`,
    )
    // Ranges.
    .replace(
      new RegExp(
        `\\b(?:between )?\\$? ?(\\d+(?:\\.\\d+)?)(?: ?- ?| to | and )\\$? ?(\\d+(?:\\.\\d+)?) ${CURRENCY}\\b`,
        'g',
      ),
      (whole, a: string, b: string) =>
        Number(a) < Number(b) && (whole.startsWith('between') || !whole.includes(' and '))
          ? `$${a}~${b}`
          : whole,
    )
    .replace(
      /(?:between )?\$ ?(\d+(?:\.\d+)?)(?: ?- ?| to | and )\$? ?(\d+(?:\.\d+)?)\b/g,
      (whole, a: string, b: string) =>
        Number(a) < Number(b) && (whole.startsWith('between') || !whole.includes(' and '))
          ? `$${a}~${b}`
          : whole,
    )
    .replace(new RegExp(`(?<![\\d.$~])(\\d+(?:\\.\\d+)?) ?${CURRENCY}\\b`, 'g'), '$$$1')
    .replace(/\$ (?=\d)/g, '$')
    .replace(/(?<![\d.$])(\d{1,3}) cents\b/g, (_m, c: string) => `$${String(Number(c) / 100)}`)
    .replace(/(\d)\/(?=[a-z])/g, '$1 per ');
  return t;
}

// Reading one sentence ----------------------------------------------------------------------------------------------

const PERIODS: Readonly<Record<string, Period>> = {
  hour: 'hour',
  hr: 'hour',
  day: 'day',
  night: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
  semester: 'other',
  term: 'other',
  quarter: 'other',
  morning: 'other',
  evening: 'other',
  weekend: 'other',
  event: 'other',
  batch: 'other',
  shift: 'other',
  season: 'other',
};

const MONEY = '\\$(\\d+(?:\\.\\d+)?)(?:~(\\d+(?:\\.\\d+)?))?';
const COST_CUE =
  /\b(?:costs?|costing|spend|spent|spending|takes?|rent|hosting|fees?(?! (?:is|per|of my))|postage|shipping|delivery|packaging|materials?|ingredients?|supplies|labou?r|wages?|expenses?|ads?|insurance|subscriptions? (?:to|for)|buy(?:ing)? (?:the|them|it)|make (?:it|one|them)|to make)\b/;
const SALE_CUE =
  /\b(?:sells?|sold|selling|charg(?:e|es|ed|ing)|prices?|priced|pricing|(?:customers?|clients?|they|people|students?|schools?|buyers?|labs?|clinics?|owners?|subscribers?|members?|users?|trucks?) (?:each )?(?:pay|pays|paid|would pay|will pay)|pays? (?:me|us)|paid (?:me|us)|(?:my|our|the) (?:fee|rate|ticket)|fee (?:is|of|per)|goes for|go for|asking(?: for)?|offer(?:ed|ing)?|bought (?:it|one|them)? ?(?:for|at))\b/;
const CASH_CUE =
  /\b(?:i have|we have|i got|have got|savings?|saved(?: up)?|budget|in the bank|cash|left in|raised|won)\b/;
const REVENUE_CUE =
  /\b(?:i|we) (?:am |are )?(?:already )?(?:make|made|making|earn|earned|earning|bring in|brought in|take in|get)\b|\brevenue\b|\bsales (?:of|are|were)\b/;
const ONE_TIME_CUE =
  /\b(?:one[- ]time|up ?front|once|to (?:start|begin|set up|launch)|start-?up cost|initial(?:ly)?|equipment|machine|bike|oven|printer|press|laptop|computer|camera|truck|van|cart|trailer|stand|booth|table|permit|licen[cs]e|registration|domain|logo|mold|mould|prototype|fridge|freezer|cooler|used)\b/;
const NOT_THIS =
  /\b(?:not|never|instead of|rather than|no longer|used to be|was|from|before|down from|up from)\s*$/;
/** Words that stand between a number and its noun, or that are no noun of a product. */
const NO_NOUN = new Set(
  (
    'month week day year hour minute piece unit item sale order time lot bit few person people customer client student ' +
    'of and or the a an my our their for to in on at with that this it them so if more less about total cost price fee ' +
    'dollar buck cent percent other one each every half morning evening night weekend semester term quarter shift event ' +
    'than from after before right now today just only hours minutes left extra me us you they we i who sold paid bought said'
  ).split(' '),
);

const nounOf = (word: string | undefined): string | null => {
  if (word === undefined) return null;
  const one = singular(word.replace(/[^a-z-]/g, ''));
  return one.length < 3 || NO_NOUN.has(one) || NO_NOUN.has(word) ? null : one;
};

/** Second words of a thing sold ("a grant application", "a coffee bag"). */
const TWO_WORDS =
  /^(?:applications?|sessions?|lessons?|orders?|tickets?|bags?|kits?|packs?|sets?|visits?|classes|class|cleanings?|repairs?|shoots?|bottles?|slices?|rides?|trips?|meals?|cards?|calls?|pages?|sheets?|boxes|box|bars?|cups?|jars?|tours?|subscriptions?|memberships?)$/;

/** What a number is per, read in the words after it. */
function perOf(after: string): {
  readonly noun: string | null;
  readonly period: Period | null;
  readonly each: boolean;
} {
  if (new RegExp(`^\\s*${UNIT_WORDS}\\b`).test(after)) return { noun: null, period: null, each: true };
  const found = /^\s*(?:a|an|per|each|every|for (?:a|an|1|each|every)|the) ([a-z-]+)(?: ([a-z-]+))?/.exec(
    after,
  );
  if (found === null) return { noun: null, period: null, each: false };
  const first = found[1] ?? '';
  const period = PERIODS[singular(first)];
  if (period !== undefined) return { noun: null, period, each: false };
  if (/^(?:unit|item|piece|sale|order|customer|client|person|student)$/.test(singular(first)))
    return { noun: null, period: null, each: true };
  // "a single box", "a grant application": the noun is the second word.
  const second = found[2] ?? '';
  const noun = nounOf(
    /^(?:single|sold|finished|small|large|new)$/.test(first) || TWO_WORDS.test(second) ? second : first,
  );
  return { noun, period: null, each: noun !== null };
}

/** The thing they talk about before the number ("a box sells for", "each scarf costs me"). */
function subjectBefore(before: string): string | null {
  const found =
    /\b(?:an?|1|each|every|per) ((?:[a-z-]+ ){0,2}?[a-z-]+) (?:sells?|costs?|goes|is priced|is sold|brings?|is)\b[^,;]*$/.exec(
      before,
    ) ??
    /\b(?:the|my|our) ((?:[a-z-]+ ){0,2}?[a-z-]+) (?:sells?|goes|is priced|is sold)\b[^,;]*$/.exec(before);
  return nounOf(found?.[1]?.trim().split(' ').at(-1));
}

/** The thing sold, named before its price ("sell mugs for", "20 jars offered at"). */
function objectBefore(before: string): string | null {
  const found =
    /\b(?:sell|sells|selling|sold|offer|offers|offered|offering|price|priced|rent|rents|renting)(?: (?:my|our|the|these|those|each|\d+))? (?:[a-z-]+ )??([a-z-]+) (?:for|at)(?: (?:about|around|only|just))?\s*$/.exec(
      before,
    ) ??
    /\b\d+ ([a-z-]+) (?:offered|sold|priced)(?: (?:for|at))\s*$/.exec(before) ??
    /\b([a-z-]+) (?:sell|sells|go|goes|are priced|is priced) (?:for|at)\s*$/.exec(before);
  return nounOf(found?.[1]);
}

const clean = (label: string): string =>
  label.replace(/^(?:and|plus|the|a|an|my|our|for|then|also|with|about|around|of|in|on)\s+/g, '').trim();

/** What a cost is for: the words just before its verb or its number. */
function labelOf(before: string): string {
  const b = before
    .replace(
      /\b(?:cost|is|are|about|around|roughly|maybe|like|at|me|us|takes?|runs?|for|another|of)\s*$/g,
      '',
    )
    .trim();
  const verb =
    /((?:[a-z-]+ ){0,2}?[a-z-]+) (?:costs?|is|are|takes?|runs?|adds?)(?: (?:me|us|about|around|roughly|maybe|like|another|for))*\s*$/.exec(
      before,
    )?.[1] ??
    /\$\d[\d.~]* (?:for|on|of|in) ((?:[a-z-]+ ?){1,2})$/.exec(before)?.[1] ??
    /(?:^|[,;:]|\band\b|\bplus\b) ?((?:[a-z-]+ ){0,2}?[a-z-]+)\s*$/.exec(b)?.[1] ??
    '';
  const words = clean(verb)
    .split(' ')
    .filter((w) => w !== '');
  const last = words
    .slice(-2)
    .filter(
      (w) =>
        !/^(?:it|that|this|which|he|she|they|i|we|and|the|box|one|each|me|us|sells?|for|to|make|making|sale|unit|also|costs?|them|your|my|our|a|an|to)$/.test(
          w,
        ),
    );
  return last.join(' ');
}

/** What a batch's cost is for ("beans and cups for one morning"). */
function batchLabel(before: string): string {
  const said =
    before
      .slice(0, before.search(/\bfor (?:1|a|each|every) [a-z]+\b/))
      .split(/[,;:]/)
      .at(-1) ?? '';
  return clean(said.trim())
    .split(' ')
    .slice(-4)
    .join(' ')
    .replace(/^(?:and|or) /, '');
}

/** The money in a sentence, the implied too ("beads cost $7 and shipping 1.50 a box"). */
function withImpliedMoney(sentence: string): string {
  const money = /\$\d/.test(sentence);
  let out = sentence;
  // "the fee is 450 now", "I charge 12 a box": a price verb gives its number in money.
  out = out.replace(
    /\b((?:sells?|sold|charg(?:e|es|ed|ing)|priced?|pays?|offer(?:ed)?) (?:(?:it|them|one|each|me|us|that|about|around|for|at|is|of) ){0,3}|(?:price|fee|rate) (?:(?:is|was|of|per|now|at|to|\w+) ){1,3})(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|now|[.,;!?]|$| and))(?! (?:people|customers?|students?|hours?|minutes?|of|percent))/g,
    '$1$$$2',
  );
  if (!money && out === sentence) return sentence;
  out = out.replace(
    /\b((?:costs?|takes?) (?:(?:me|us|about|around) )?)(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|and|[.,;!?]|$))(?! ?(?:minutes?|hours?))/g,
    '$1$$$2',
  );
  out = out.replace(/(?<!\bthere )\b(is|are) (\d+(?:\.\d+)?)(?= ?(?:[,.;]|$))/g, '$1 $$$2');
  // A list that goes on: "…cost $7 and shipping 1.50".
  return out.replace(
    /(\$\d[\d.~]*(?: (?:an?|per|each) [a-z]+)?(?:,| and|, and| plus|, plus) (?:[a-z-]+ ){1,2}(?:is |costs? )?)(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|and|[.,;!?]|$))(?! ?(?:minutes?|hours?|percent|%))/g,
    '$1$$$2',
  );
}

interface Found {
  readonly quantities: Quantity[];
  readonly ratios: Ratio[];
}

/** Whether a sentence only asks, supposes or denies what it holds. */
const SUPPOSES =
  /\b(?:should i|could i|would it|what if|how about|maybe i|do i (?:raise|lower|charge)|raise (?:it|the price) to)\b/;

function readSentence(raw: string, out: Found): void {
  const s = withImpliedMoney(raw);
  const supposed = SUPPOSES.test(s);
  const money = [...s.matchAll(new RegExp(MONEY, 'g'))];
  let from = 0;
  let cue = null as Cue;
  let lastNoun: string | null = null;
  const pending: number[] = [];
  for (const m of money) {
    const before = s.slice(from, m.index);
    const whole = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    from = m.index + m[0].length;
    if (NOT_THIS.test(whole) || /^\s*(?:before|earlier|last (?:year|month|week))\b/.test(after) || supposed)
      continue;
    const low = Number(m[1]);
    const high = m[2] === undefined ? low : Number(m[2]);
    const per = perOf(after);
    const clauseCue: Cue = lastCue(before);
    const goesOn: boolean = clauseCue === null && /^(?:[^.;]*)(?:,|\band\b|\bplus\b)/.test(before);
    const now: Cue = clauseCue ?? (goesOn || pending.length > 0 ? cue : null);
    cue = now ?? cue;
    const noun = per.noun ?? subjectBefore(before) ?? objectBefore(before);
    const add = (q: Omit<Quantity, 'low' | 'high'>): void => {
      out.quantities.push({ low, high, ...q });
    };
    const oneTime = ONE_TIME_CUE.test(before) || /^\s*(?:one[- ]time|up ?front|once)\b/.test(after);
    if (per.period === 'hour' && now !== 'cost') {
      add({ role: 'revenue', noun: null, period: 'hour', label: '' });
      continue;
    }
    const cash = CASH_CUE.test(before) && clauseCue === null && per.period === null && !per.each;
    if (cash) {
      add({ role: 'cash', noun: null, period: null, label: '' });
      continue;
    }
    if (clauseCue === 'revenue' && per.period !== null) {
      add({ role: 'revenue', noun: null, period: per.period, label: '' });
      continue;
    }
    // "for one morning": a cost of a batch, said before the number.
    const batch = /\bfor (?:1|a|each|every) ([a-z]+)\b[^$]*$/.exec(before)?.[1];
    const batchPeriod = batch === undefined ? undefined : PERIODS[singular(batch)];
    const label = labelOf(before);
    if (now === 'sale') {
      if (per.period !== null) add({ role: 'price', noun: per.noun, period: per.period, label: '' });
      else add({ role: 'price', noun: noun ?? lastNoun, period: null, label: '' });
      lastNoun = noun ?? lastNoun;
      continue;
    }
    if (per.period !== null || batchPeriod !== undefined) {
      if (now === 'cost' || /\b(?:is|are|for)\b/.test(before)) {
        const period = per.period ?? batchPeriod ?? 'other';
        const word =
          batch ?? /^\s*(?:a|an|per|each|every|for (?:a|an|1|each|every)) ([a-z-]+)/.exec(after)?.[1];
        add({
          role: 'period_cost',
          noun: null,
          period,
          label: batch === undefined ? label : batchLabel(before),
          ...(period === 'other' && word !== undefined ? { batch: singular(word) } : {}),
        });
      }
      continue;
    }
    if (oneTime && !per.each) {
      add({ role: 'one_time', noun: null, period: null, label });
      continue;
    }
    if (now === 'cost') {
      const named = noun !== null && noun === singular(label.split(' ').at(-1) ?? '') ? '' : label;
      // "Beads cost $7 and shipping $1.50 a box": the list's noun comes with its last number.
      pending.push(out.quantities.length);
      add({
        role: 'unit_cost',
        noun: noun === singular(named) ? lastNoun : (per.noun ?? (named === '' ? noun : null)),
        period: null,
        label: named,
      });
      if (per.noun !== null || per.each) {
        for (const i of pending) {
          const q = out.quantities[i];
          if (q?.noun === null) out.quantities[i] = { ...q, noun: per.noun ?? lastNoun };
        }
        lastNoun = per.noun ?? lastNoun;
      }
      continue;
    }
    // "$12 a cup", "12 dollars each" with no verb: the price of one, when nothing else of the sentence says cost.
    if (per.each && !COST_CUE.test(s)) {
      add({ role: 'price', noun, period: null, label: '' });
      lastNoun = noun ?? lastNoun;
    }
  }
  readCounts(s, out, supposed);
}

type Cue = 'cost' | 'sale' | 'revenue' | null;

/** The last cue said before a number: a sale, a cost, or money that comes in. */
function lastCue(before: string): Cue {
  let at = -1;
  let cue = null as Cue;
  for (const [pattern, kind] of [
    [REVENUE_CUE, 'revenue'],
    [COST_CUE, 'cost'],
    [SALE_CUE, 'sale'],
  ] as const) {
    for (const m of before.matchAll(new RegExp(pattern.source, 'g'))) {
      if (m.index >= at) {
        at = m.index;
        cue = kind;
      }
    }
  }
  return cue;
}

const GOT =
  '(?:sold|bought|paid|said yes|signed(?: up)?|ordered|pre-?ordered|subscribed|converted|came back|stayed|replied|answered|booked)';

function readCounts(s: string, out: Found, supposed: boolean): void {
  const t = s.replace(new RegExp(MONEY, 'g'), ' $ ');
  // Volume: "40 boxes a month", "40 of them a week".
  for (const m of t.matchAll(
    /(?<![\d.$])(\d+(?:\.\d+)?)(?: (?:of them|(?:more |paying |regular )?([a-z-]+)))?(?: (?:go|goes|went|are|get) (?:out|sold))? (?:a|per|each|every|in 1|in a) (day|week|month|year|morning|evening|night|weekend|event|batch|shift|semester|term|season)\b/g,
  )) {
    const noun = nounOf(m[2]);
    const word = m[2] ?? '';
    if (/^(?:hours?|minutes?|hrs?|mins?)$/.test(word)) {
      if (word.startsWith('h') && m[3] === 'week')
        out.quantities.push({
          role: 'week_hours',
          low: Number(m[1]),
          high: Number(m[1]),
          noun: null,
          period: 'week',
          label: '',
        });
      continue;
    }
    if (/^(?:percent|times?|days?|weeks?)$/.test(word)) continue;
    out.quantities.push({
      role: 'volume',
      low: Number(m[1]),
      high: Number(m[1]),
      noun,
      period: PERIODS[m[3] ?? ''] ?? 'other',
      label: '',
      ...((PERIODS[m[3] ?? ''] ?? 'other') === 'other' ? { batch: m[3] ?? '' } : {}),
    });
  }
  // "At forty boxes", "if I sell 40 boxes", "what would I make on 30 mugs".
  if (!supposed)
    for (const m of t.matchAll(
      /\b(?:at|if (?:i|we) (?:sell|sold|do|make|get)|selling|sell|sold|make on) (\d+) ([a-z-]+)(?! (?:a|per|each|every|in 1|in a) (?:day|week|month|year|morning|evening|night|weekend|event|batch|shift|semester|term|season))\b/g,
    )) {
      const noun = nounOf(m[2]);
      if (noun === null || /\b(?:hour|minute|percent|am|pm)$/.test(noun)) continue;
      out.quantities.push({
        role: 'volume',
        low: Number(m[1]),
        high: Number(m[1]),
        noun,
        period: null,
        label: '',
      });
    }
  // How long one takes.
  for (const m of t.matchAll(
    /(?:\b(?:an?|1|each|every|per) ([a-z-]+) takes?(?: (?:me|us))?(?: (?:about|around|roughly|like))? |\btakes?(?: (?:me|us))?(?: (?:about|around|roughly|like))? |\bspend(?: (?:about|around))? )?(?<![\d.$])(\d+(?:\.\d+)?) (hours?|hrs?|minutes?|mins?)(?: (?:each|apiece|(?:per|a|on (?:each|1|every)|for (?:each|1|every|a)) ([a-z-]+)))?/g,
  )) {
    const takes = /\b(?:takes?|spend)\b/.test(m[0]);
    const tail = m[4];
    if (tail !== undefined && PERIODS[singular(tail)] !== undefined) continue;
    const each = tail !== undefined || / (?:each|apiece)$/.test(m[0]);
    if (!takes && !each) continue;
    const minutes = Number(m[2]) * ((m[3] ?? '').startsWith('h') ? 60 : 1);
    out.quantities.push({
      role: 'unit_time',
      low: minutes,
      high: minutes,
      noun: nounOf(m[1] ?? tail),
      period: null,
      label: '',
    });
  }
  out.ratios.push(...ratiosIn(t));
}

/** "13 of 25", "asked 40 and 3 bought", "20 offered, 11 sold": a part of a whole, never more than it. */
export function ratiosIn(text: string): Ratio[] {
  const t = text.replace(/\b(?:only|just|about|exactly|jars?|people|students?|customers?|of them) /g, (w) =>
    w === 'of them ' ? '' : w,
  );
  const out: Ratio[] = [];
  const add = (part: number, whole: number): void => {
    if (!(part >= 0 && whole > 0 && part <= whole && whole <= 1_000_000)) return;
    if (!out.some((r) => r.part === part && r.whole === whole)) out.push({ part, whole });
  };
  for (const m of t.matchAll(
    /(?<![\d.$])(\d+)(?: [a-z-]+)? (?:of|out of|in) (?:the |my |our )?(\d+)\b(?! ?(?:minutes?|hours?|days?|weeks?|months?|am|pm))/g,
  ))
    if (Number(m[2]) > 1 && !/\bin \d+$/.test(m[0])) add(Number(m[1]), Number(m[2]));
  const asked =
    '(?:asked|offered|showed|emailed|messaged|called|pitched|invited|approached|visited|contacted|handed out|interviewed|talked to|spoke to|tested with)';
  for (const m of t.matchAll(
    new RegExp(
      `\\b${asked} (?:it to )?(\\d+)\\b[^.;]*?(?:,|\\band\\b|\\bbut\\b|;) ?(?:only |just )?(?:(\\d+) (?:of (?:them|those) |people |customers? |students? )?${GOT}|${GOT} (\\d+))`,
      'g',
    ),
  ))
    add(Number(m[2] ?? m[3]), Number(m[1]));
  for (const m of t.matchAll(
    new RegExp(
      `(?<![\\d.$])(\\d+) (?:[a-z-]+ ){0,2}(?:offered|asked|shown|visitors?|emails?|calls?)\\b[^.;]*?(?:,|\\band\\b|\\bbut\\b)[^.;]*?(?<![\\d.$])(\\d+) (?:[a-z-]+ )?${GOT}`,
      'g',
    ),
  ))
    add(Number(m[2]), Number(m[1]));
  for (const m of t.matchAll(
    /(?<![\d.$])(\d+) (?:sales?|orders?|buyers?|sign-?ups?) (?:from|out of) (\d+)\b/g,
  ))
    add(Number(m[1]), Number(m[2]));
  return out;
}

/** Every number of a text with its role. */
export function quantitiesIn(text: string): {
  readonly quantities: readonly Quantity[];
  readonly ratios: readonly Ratio[];
} {
  const found: Found = { quantities: [], ratios: [] };
  for (const sentence of saidNumbers(text).split(/(?<=[.?!;])\s+|;\s*|\n/)) {
    if (sentence.trim() === '') continue;
    const s = sentence.replace(/[.?!]+$/u, '').trim();
    if (/\d/.test(s)) readSentence(s, found);
  }
  return found;
}

// What they ask ------------------------------------------------------------------------------------------------------

const ASKS: readonly (readonly [CalcAsk, RegExp])[] = [
  [
    'payback',
    /\bpay ?back\b|\b(?:how long|when)\b[^?]*\b(?:earn|make|get|pay) (?:it|that|the \w+|my money|this|them)? ?(?:back|off)\b|\bpays? for itself\b/,
  ],
  [
    'break_even',
    /\bbreak[- ]?even\b|\bhow many\b[^?]*\b(?:to (?:cover|pay (?:for|off)|earn back|make back|break even)|(?:cover|pay for|pays for))\b|\bhow many (?:\w+ )?(?:do|would|must|should) (?:i|we) (?:have to|need to|must)? ?sell\b/,
  ],
  [
    'runway',
    /\brunway\b|\bhow long\b[^?]*\b(?:money|cash|savings?|budget)\b[^?]*\blast\b|\bhow many months (?:do|can|will) (?:i|we)\b/,
  ],
  [
    'hourly',
    /\bhourly\b|\b(?:per|an|each) hour\b[^?]*\?|\bwhat (?:do|am|would|are) (?:i|we) (?:earn|make|making|earning|get)\b[^?]*\b(?:an|per) hour\b/,
  ],
  ['conversion', /\bconversion\b|\bwhat (?:percent|percentage|share)\b|\b(?:close|response|success) rate\b/],
  ['margin', /\bmargins?\b|\bmark-?up\b/],
  ['revenue', /\b(?:how much|what)\b[^?]*\b(?:revenue|turnover|in sales)\b/],
  [
    'monthly',
    /\b(?:how much|what)\b[^?]*\b(?:make|earn|left|profit|keep|bring in|get|net)\b[^?]*\b(?:a|per|each|every|in a|in one|for the) (?:month|week|year)\b|\b(?:monthly|weekly|yearly) (?:profit|earnings|income|total)\b|\b(?:month|week)\b[^?]*\b(?:make|earn|profit)\b[^?]*\?/,
  ],
  [
    'time',
    /\bhow (?:long|many hours|much time)\b[^?]*\b(?:would|will|does|do|to make|to do|for)\b[^?]*\b\d+\b/,
  ],
  [
    'contribution',
    /\bunit economics\b|\bcontribution\b|\b(?:how much|what)(?: money)?\b[^?]*\b(?:left|make|profit|earn|keep|clear)\b[^?]*\b(?:per|on (?:each|one|every)|from (?:each|one|every)|each|a|one) (?!month|week|year|hour|day)\w+|\bprofit (?:per|on (?:each|one|every)|a) (?!month|week|year|hour|day)\w+|\bwhat (?:is|do i) (?:left|make|keep)\b|\bwork out (?:my|the|our) (?:numbers|margin|costs|profit)\b|\bam i (?:making|losing) money\b/,
  ],
];

/** What the message asks to have worked out; null: no sum. */
export function calcAsked(message: string): CalcAsk | null {
  const t = saidNumbers(message);
  return ASKS.find(([, pattern]) => pattern.test(t))?.[0] ?? null;
}

// The sums -----------------------------------------------------------------------------------------------------------

export function money(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const abs = Math.abs(rounded);
  const text = Number.isInteger(abs)
    ? abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d)(?=\.))/g, ',');
  return `${rounded < 0 ? '-' : ''}$${text}`;
}

function number(value: number, places = 1): string {
  const f = 10 ** places;
  const r = Math.round(value * f) / f;
  return Number.isInteger(r)
    ? r.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : r.toFixed(places).replace(/0+$/, '');
}
export function percent(part: number, whole: number): string {
  const exact = (part / whole) * 100;
  const tenth = Math.round(exact * 10) / 10;
  // "67%" of a few, "7.5%", "68.8%" of hundreds.
  return `${number(whole >= 100 || Math.abs((tenth % 1) - 0.5) < 1e-9 ? tenth : Math.round(exact))}%`;
}
const range = (low: number, high: number): string =>
  low === high ? money(low) : `${money(low)} to ${money(high)}`;
const plural = (noun: string): string =>
  /(?:s|x|ch|sh|z)$/.test(noun)
    ? `${noun}es`
    : /[^aeiou]y$/.test(noun)
      ? `${noun.slice(0, -1)}ies`
      : `${noun}s`;

/** Their numbers put together: the latest said of each wins. */
interface Book {
  readonly noun: string | null;
  /** More than one thing they sell, and no word of which. */
  readonly nouns: readonly string[];
  readonly price: Quantity | null;
  readonly costs: readonly Quantity[];
  readonly periodCosts: readonly Quantity[];
  readonly oneTime: readonly Quantity[];
  readonly volume: Quantity | null;
  readonly unitTime: Quantity | null;
  readonly weekHours: Quantity | null;
  readonly cash: Quantity | null;
  readonly revenue: Quantity | null;
  readonly ratio: Ratio | null;
}

/** What one is, in the question itself ("what do I make per cookie?"). */
function nounAsked(asked: string): string | null {
  return nounOf(
    /\b(?:per|on (?:each|1|every|an?)|from (?:each|1|every)|for (?:1|each)|on) ([a-z-]+)(?=\W|$)/.exec(
      asked,
    )?.[1],
  );
}

function bookOf(input: CalcInput): Book {
  const texts = [...(input.record ?? []), ...(input.earlier ?? []), input.message];
  const all = texts.map((t, i) => ({ source: i, ...quantitiesIn(t) }));
  const quantities = all.flatMap((a) => a.quantities.map((q) => ({ ...q, source: a.source })));
  const last = <T>(xs: readonly T[]): T | null => xs.at(-1) ?? null;
  const prices = quantities.filter((q) => q.role === 'price' && q.period === null);
  const priced = [...new Set(prices.flatMap((p) => (p.noun === null ? [] : [p.noun])))];
  const asked = saidNumbers(input.message);
  const namedHere = priced.filter((n) => new RegExp(`\\b${n}(?:e?s)?\\b`).test(asked));
  const nouns = namedHere.length > 0 ? namedHere : priced;
  const noun = nouns.length === 1 ? (nouns[0] ?? null) : nouns.length === 0 ? nounAsked(asked) : null;
  const fits = (q: Quantity): boolean => q.noun === null || noun === null || q.noun === noun;
  const price = last(
    prices.filter((p) => nouns.length <= 1 || (p.noun !== null && nouns.includes(p.noun))).filter(fits),
  );
  // The parts of what one costs: a newer figure of the same part stands for the older, a new whole for them all.
  const parts = new Map<string, Quantity & { source: number }>();
  for (const found of quantities.filter((x) => x.role === 'unit_cost')) {
    // "The bag costs $1" of a kit: a part of it, unless the bag is sold by itself.
    const part = !fits(found) && found.noun !== null && !priced.includes(found.noun);
    if (!part && !fits(found)) continue;
    const q = part && found.label === '' ? { ...found, label: found.noun ?? '' } : found;
    if (q.label === '') {
      const newer = [...parts.values()].every((p) => p.source < q.source);
      if (newer) parts.clear();
      else if ([...parts.keys()].some((k) => k !== '')) continue;
    } else if (parts.has('')) {
      parts.delete('');
    }
    parts.set(singular(q.label.split(' ').at(-1) ?? ''), q);
  }
  const byLabel = (role: QuantityRole): Quantity[] => {
    const out = new Map<string, Quantity>();
    for (const q of quantities.filter((x) => x.role === role))
      out.set(singular(q.label.split(' ').at(-1) ?? ''), q);
    return [...out.values()];
  };
  const volumes = quantities.filter(
    (q) => q.role === 'volume' && fits(q) && (q.noun === null || noun === null || q.noun === noun),
  );
  return {
    noun: noun ?? last(quantities.filter((q) => q.role === 'unit_cost' && q.noun !== null))?.noun ?? null,
    nouns,
    price,
    costs: [...parts.values()],
    periodCosts: byLabel('period_cost'),
    oneTime: byLabel('one_time'),
    volume: last(volumes),
    unitTime: last(quantities.filter((q) => q.role === 'unit_time')),
    weekHours: last(quantities.filter((q) => q.role === 'week_hours')),
    cash: last(quantities.filter((q) => q.role === 'cash')),
    revenue: last(quantities.filter((q) => q.role === 'revenue' && q.period !== 'hour')),
    ratio: last(all.flatMap((a) => a.ratios)),
  };
}

interface Left {
  readonly low: number;
  readonly high: number;
  readonly line: string;
}

const one = (b: Book): string => b.noun ?? 'sale';
const many = (b: Book, n: number): string => (n === 1 ? one(b) : plural(one(b)));

/** What one sale leaves, with its working. */
function leftOf(b: Book): Left | null {
  const { price, costs } = b;
  if (price === null || costs.length === 0) return null;
  const low = price.low - costs.reduce((sum, c) => sum + c.high, 0);
  const high = price.high - costs.reduce((sum, c) => sum + c.low, 0);
  const working = [
    `${range(price.low, price.high)} price`,
    ...costs.map((c) => `${range(c.low, c.high)} ${c.label === '' ? 'cost' : c.label}`),
  ].join(' - ');
  const result =
    high < 0 ? `${range(low, high)}: each ${one(b)} loses money` : `${range(low, high)} left per ${one(b)}`;
  return { low, high, line: `${working} = ${result}.` };
}

const whatIsMissing = {
  price: (b: Book) => `What do you charge for one ${one(b)}?`,
  cost: (b: Book) => `What does one ${one(b)} cost you to make and deliver?`,
  volume: (b: Book) => `How many ${plural(one(b))} do you sell in a month?`,
  oneTime: () => 'What is the one-time cost you want to earn back?',
  time: (b: Book) => `How long does one ${one(b)} take you?`,
  cash: () => 'How much money do you have for this now?',
  monthlyCost: () => 'What do you spend on it in a month?',
  ratio: () => 'How many did you ask, and how many said yes with money?',
  which: (b: Book) => `Which one: ${b.nouns.map(plural).join(' or ')}?`,
  batch: (b: Book, batch: string) => `How many ${plural(one(b))} do you sell in one ${batch}?`,
} as const;

interface Sum {
  readonly lines: string[];
  readonly missing: string | null;
}
const need = (missing: string, lines: string[] = []): Sum => ({ lines, missing });
const got = (...lines: string[]): Sum => ({ lines, missing: null });

function perMonth(q: Quantity): { readonly value: number; readonly label: string } | null {
  if (q.period === 'month') return { value: q.low, label: 'a month' };
  if (q.period === 'week') return { value: q.low * 4, label: 'in four weeks' };
  return null;
}

function contribution(b: Book): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return need(whatIsMissing.price(b));
  const batched = b.costs.length === 0 ? b.periodCosts.filter((c) => c.batch !== undefined) : [];
  const batch = batched[0]?.batch;
  if (batch !== undefined) {
    // A cost of a whole morning: what one leaves needs how many a morning sells.
    if (b.volume?.batch !== batch) return need(whatIsMissing.batch(b, batch));
    const n = b.volume.low;
    const out = batched.reduce((sum, c) => sum + c.low, 0);
    const named = batched.map((c) => (c.label === '' ? 'costs' : c.label)).join(' and ');
    return got(
      `${number(n)} ${many(b, n)} x ${range(b.price.low, b.price.high)} - ${money(out)} ${named} = ${range(n * b.price.low - out, n * b.price.high - out)} left for one ${batch}.`,
    );
  }
  if (b.costs.length === 0) return need(whatIsMissing.cost(b));
  const left = leftOf(b);
  return left === null ? need(whatIsMissing.cost(b)) : got(left.line);
}

function margin(b: Book): Sum {
  const base = contribution(b);
  const left = leftOf(b);
  if (base.missing !== null || left === null || b.price === null) return base;
  if (left.low !== left.high || b.price.low !== b.price.high) return base;
  return got(
    left.line,
    `Margin: ${money(left.low)} of ${money(b.price.low)} = ${percent(left.low, b.price.low)} of the price.`,
  );
}

function monthly(b: Book): Sum {
  const base = contribution(b);
  const left = leftOf(b);
  if (base.missing !== null || left === null) return base;
  if (b.volume === null) return need(whatIsMissing.volume(b), [left.line]);
  const n = b.volume.low;
  const period = b.volume.period ?? 'month';
  if (period !== 'month' && period !== 'week' && period !== 'day' && period !== 'year')
    return need(whatIsMissing.volume(b), [left.line]);
  const low = n * left.low;
  const high = n * left.high;
  const when = period === 'month' ? 'a month' : `a ${period}`;
  const lines = [
    `${number(n)} ${many(b, n)} x ${range(left.low, left.high)} left per ${one(b)} = ${range(low, high)} ${when} before other costs.`,
  ];
  if (period === 'week') lines.push(`Four weeks of that: ${range(low * 4, high * 4)}.`);
  const fixed = b.periodCosts.filter((c) => c.period === 'month');
  if (period === 'month' && fixed.length > 0) {
    const total = fixed.reduce((sum, c) => sum + c.low, 0);
    const named = fixed.map((c) => (c.label === '' ? 'monthly costs' : c.label)).join(' and ');
    lines.push(
      `${range(low, high)} - ${money(total)} ${named} = ${range(low - total, high - total)} a month.`,
    );
  }
  return got(...lines);
}

function revenue(b: Book): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return need(whatIsMissing.price(b));
  if (b.volume === null) return need(whatIsMissing.volume(b));
  const period = b.volume.period ?? 'month';
  const n = b.volume.low;
  return got(
    `${number(n)} ${many(b, n)} x ${range(b.price.low, b.price.high)} = ${range(n * b.price.low, n * b.price.high)} ${period === 'other' ? '' : `a ${period} `}in sales, before any cost.`,
  );
}

function breakEven(b: Book): Sum {
  const base = contribution(b);
  if (base.missing !== null) return base;
  const left = leftOf(b);
  if (left === null) return base;
  if (left.low <= 0)
    return got(left.line, `No number of ${plural(one(b))} covers a cost while one ${one(b)} loses money.`);
  const once = b.oneTime;
  const fixed = b.periodCosts.filter((c) => c.period === 'month');
  const lines: string[] = [];
  const count = (cost: number): string =>
    left.low === left.high
      ? number(Math.ceil(cost / left.low - 1e-9), 0)
      : `${number(Math.ceil(cost / left.high - 1e-9), 0)} to ${number(Math.ceil(cost / left.low - 1e-9), 0)}`;
  if (once.length > 0) {
    const total = once.reduce((sum, c) => sum + c.low, 0);
    const named = once.map((c) => (c.label === '' ? 'one-time cost' : c.label)).join(' and ');
    lines.push(
      `${money(total)} ${named} / ${range(left.low, left.high)} left per ${one(b)} = ${count(total)} ${plural(one(b))} to pay for it.`,
    );
  }
  if (fixed.length > 0) {
    const total = fixed.reduce((sum, c) => sum + c.low, 0);
    const named = fixed.map((c) => (c.label === '' ? 'monthly costs' : c.label)).join(' and ');
    lines.push(
      `${money(total)} a month ${named} / ${range(left.low, left.high)} left per ${one(b)} = ${count(total)} ${plural(one(b))} a month to cover it.`,
    );
  }
  return lines.length === 0 ? need(whatIsMissing.oneTime(), [left.line]) : got(...lines, left.line);
}

function hourly(b: Book): Sum {
  if (b.nouns.length > 1) return need(whatIsMissing.which(b));
  if (b.price === null) return need(whatIsMissing.price(b));
  if (b.unitTime === null) return need(whatIsMissing.time(b));
  const hours = b.unitTime.low / 60;
  const time =
    b.unitTime.low % 60 === 0
      ? `${number(hours)} ${hours === 1 ? 'hour' : 'hours'}`
      : `${number(b.unitTime.low)} minutes`;
  const left = leftOf(b);
  const p = b.price;
  if (left !== null)
    return got(
      left.line,
      `${range(left.low, left.high)} left / ${time} = ${range(left.low / hours, left.high / hours)} an hour.`,
    );
  return got(
    `${range(p.low, p.high)} / ${time} = ${range(p.low / hours, p.high / hours)} an hour, before any cost.`,
  );
}

function conversion(b: Book): Sum {
  if (b.ratio === null) return need(whatIsMissing.ratio());
  const { part, whole } = b.ratio;
  return got(`${number(part)} of ${number(whole)} = ${percent(part, whole)}.`);
}

function payback(b: Book): Sum {
  if (b.oneTime.length === 0) return need(whatIsMissing.oneTime());
  const total = b.oneTime.reduce((sum, c) => sum + c.low, 0);
  const left = leftOf(b);
  const volume = b.volume === null ? null : perMonth({ ...b.volume, period: b.volume.period ?? 'month' });
  if (left === null) return contribution(b);
  if (volume === null) return need(whatIsMissing.volume(b), [left.line]);
  if (left.low <= 0) return got(left.line);
  const month = volume.value * left.low;
  const months = total / month;
  return got(
    `${number(volume.value)} ${many(b, volume.value)} x ${money(left.low)} left per ${one(b)} = ${money(month)} ${volume.label}.`,
    `${money(total)} / ${money(month)} ${volume.label} = about ${number(months)} ${volume.label === 'a month' ? (months <= 1 ? 'month' : 'months') : 'times four weeks'} to earn it back.`,
  );
}

function runway(b: Book): Sum {
  if (b.cash === null) return need(whatIsMissing.cash());
  const fixed = b.periodCosts.filter((c) => c.period === 'month');
  if (fixed.length === 0) return need(whatIsMissing.monthlyCost());
  const out = fixed.reduce((sum, c) => sum + c.low, 0);
  const income = b.revenue?.period === 'month' ? b.revenue.low : 0;
  const net = out - income;
  if (net <= 0)
    return got(
      `${money(income)} a month in - ${money(out)} a month out = ${money(income - out)} a month: the money does not run out.`,
    );
  return got(
    income === 0
      ? `${money(b.cash.low)} / ${money(out)} a month = ${number(b.cash.low / out)} months.`
      : `${money(b.cash.low)} / (${money(out)} out - ${money(income)} in a month) = ${number(b.cash.low / net)} months.`,
  );
}

function time(b: Book, message: string): Sum {
  if (b.unitTime === null) return need(whatIsMissing.time(b));
  const n = b.volume?.low ?? Number(/(?<![\d.$])(\d+)/.exec(saidNumbers(message))?.[1] ?? Number.NaN);
  if (!Number.isFinite(n)) return need(whatIsMissing.volume(b));
  const total = n * b.unitTime.low;
  const noun = b.unitTime.noun ?? b.volume?.noun ?? null;
  const what = noun === null ? '' : ` ${n === 1 ? noun : plural(noun)}`;
  const lines = [
    `${number(n)}${what} x ${number(b.unitTime.low)} minutes = ${number(total)} minutes (${number(total / 60)} hours).`,
  ];
  if (b.weekHours !== null) lines.push(`You have ${number(b.weekHours.low)} hours a week for it.`);
  return got(...lines);
}

/**
 * The sums of a turn: the asked one first, with the one number it lacks as a question; with no sum asked, what one sale
 * leaves when they gave both numbers of it in this conversation or the record (a fact the reply may use).
 */
export function calcOf(input: CalcInput): CalcResult {
  const ask = calcAsked(input.message) ?? input.ask ?? null;
  const b = bookOf(input);
  if (ask === null) {
    const left = b.nouns.length > 1 ? null : leftOf(b);
    const here = quantitiesIn(input.message);
    const ratio = here.ratios[0] ?? null;
    return {
      ask: null,
      lines: [
        ...(left === null ? [] : [left.line]),
        ...(ratio === null
          ? []
          : [`${number(ratio.part)} of ${number(ratio.whole)} = ${percent(ratio.part, ratio.whole)}.`]),
      ],
      missing: null,
    };
  }
  const sum: Sum = {
    contribution: () => contribution(b),
    margin: () => margin(b),
    monthly: () => monthly(b),
    revenue: () => revenue(b),
    break_even: () => breakEven(b),
    hourly: () => hourly(b),
    conversion: () => conversion(b),
    payback: () => payback(b),
    runway: () => runway(b),
    time: () => time(b, input.message),
  }[ask]();
  return { ask, lines: sum.lines, missing: sum.missing };
}
