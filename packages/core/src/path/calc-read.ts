import { plain, singular } from './words.js';

/**
 * The numbers of a founder's words with their roles, as the calculator reads them (calc.ts): a price, what one costs, a
 * cost a month, a one-time cost, how many, how long. A role is given by the words beside the number and by nothing else;
 * an amount whose role is not plain is kept apart (`loose`), so a sum that would need it is not told. Pure.
 */

export type QuantityRole =
  | 'price'
  | 'unit_cost'
  | 'unit_share'
  | 'period_cost'
  | 'one_time'
  | 'spend'
  | 'volume'
  | 'unit_time'
  | 'week_hours'
  | 'cash'
  | 'revenue'
  | 'rate';

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
  /** The role is only what the rest of their words make it ("wool is 9 dollars", beside a price). */
  readonly soft?: boolean;
  /** Said as one more of the same ("plus", "also"). */
  readonly added?: boolean;
}

/** An amount whose role is not plain. */
export interface Loose {
  readonly value: number;
  readonly noun: string | null;
  /** `bare`: what one is ("a delivery is 9 dollars"), a price or a cost; `several`: for more than one; else unknown. */
  readonly kind: 'bare' | 'several' | 'unknown';
  /** The first amount of its text. */
  readonly first: boolean;
}

/** "13 of 25 sold", with the words of its clause. */
export interface Ratio {
  readonly part: number;
  readonly whole: number;
}

/** "Sixteen clubs", "four of them cancelled": a count with what it is of and the words of its clause. */
export interface Count {
  readonly value: number;
  readonly noun: string | null;
  readonly clause: string;
  /** No word follows it ("printing 5"). */
  readonly bare: boolean;
}

export interface Read {
  readonly quantities: Quantity[];
  readonly ratios: Ratio[];
  readonly counts: Count[];
  readonly loose: Loose[];
  /** Money in another currency than dollars is spoken of. */
  foreign: boolean;
  /** The text holds a percentage of something nobody could place. */
  percentLoose: boolean;
  /** Every percentage of the text. */
  readonly percents: number[];
  /** It says what is so now ("now", "from today", "changed"). */
  updates: boolean;
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
    .replace(
      /(?<!\b(?:dollars?|bucks?|usd|rate|\d) )\ban hour\b(?= (?:each|per|for (?:one|each)|to )|[.,]|$)/g,
      '1 hour',
    );
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
          ? `${whole.startsWith(' ') ? ' ' : ''}$${a}~${b}`
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
const FOREIGN =
  /[£€₦₵¥₹₩]|\b(?:euros?|pounds? (?:sterling|each|a|per)|quid|cedis?|naira|shillings?|rand|rupees?|pesos?|yen|yuan|dirhams?|riyals?|francs?|birr|kwacha|taka|ringgit|baht|lira|zloty|ghs|ngn|kes|zar|inr|eur|gbp)\b/;

/** A fee they pay, never one they charge. */
const PAID_FEE =
  /\b(?:payment|card|processing|transaction|platform|app|marketplace|listing|booking|service|bank|stripe|paypal|etsy|venmo|square|delivery|shipping|stall|entry|vendor|credit|merchant|handling|licen[cs]e|permit|venue|market|checkout|gateway|online) fees?\b|\bfees\b|\bcommissions?\b/;
/** A cost, said as one. */
const COST_CUE =
  /\b(?:costs?|costing|rent|hosting|postage|shipping|delivery|packaging|materials?|ingredients?|supplies|labou?r|wages?|expenses?|ads?|insurance|subscriptions? (?:to|for))\b(?! (?:the |my |our )?(?:customers?|clients?|buyers?|students?|people|them|parents?)\b)|\b(?:i|we) (?:\w+ )?(?:spend|spent|pay|paid|buy|bought)\b|\bspend(?:ing)?\b|\bspent\b|\bbuy(?:ing)? (?:the|them|it)\b|\b(?:pay|paying|paid) (?:the|my|our|a|him|her|them|for)\b|\bmake (?:it|one|them)\b|\bto (?:make|print|bake|sew|knit|build|produce|assemble|ship|post|mail|deliver|pack|package|brew|cook|grow) (?:1|it|them|each|every|an?)\b|\b(?:charge|charges|charged|bill|bills|billed) (?:me|us)\b|\bruns? (?:me|us)\b/;
/** What somebody else gets of it. */
const SHARE_CUE =
  /\b(?!(?:i|we|you) )([a-z-]+) (?:gets?|takes?|keeps?|earns?|receives?|is paid|are paid|wants?)(?: (?:about|around|only|just))?\s*$|\bgoes? to (?:the )?[a-z]+\s*$/;
const SALE_CUE =
  /\b(?:sells?|sold|selling|charg(?:e|es|ed|ing)|prices?|priced|pricing|(?:customers?|clients?|they|people|students?|schools?|buyers?|labs?|clinics?|owners?|subscribers?|members?|users?|trucks?|clubs?|parents?|teams?|parks?|shops?|cafes?|restaurants?|offices?|families|companies|groups?) (?:each )?(?:pay|pays|paid)|pays? (?:me|us)|paid (?:me|us)|(?:my|our) (?:\w+ )?(?:fee|rate|ticket)|the (?:fee|rate|ticket)|fee (?:is|of|per)|goes for|go for|going for|asking(?: for)?|ask(?=(?: for)?\s*$)|offer(?:ed|ing)?|(?:bought|ordered) (?:it|one|them|\d+)? ?(?:for|at)|ordered at|rais(?:e|ed|ing) (?:it|the price|that) to|lower (?:it|the price|that) to|set it (?:at|to))(?!\w)/;
/** Somebody else's price. */
const OTHERS =
  /\b(?:others?|another|competitors?|rivals?|elsewhere|somewhere else|incumbents?|amazon|walmart|starbucks|ikea)\b|\b(?:the|a|an|most|some|many|all|local|big|nearby|campus|every) (?:[a-z-]+ ){0,2}?(?:stores?|shops?|bookstores?|cafes?|cafeterias?|supermarkets?|brands?|compan(?:y|ies)|agenc(?:y|ies)|sellers?|vendors?|baker(?:y|ies)|freelancers?|barbers?|salons?|tutors?|gyms?|chains?|sites?|marketplaces?) (?:[a-z]+ ){0,5}?(?:sells?|sold|charges?|asks?|offers?|wants?|lists?|costs?|is|are)\b|\btutors (?:[a-z]+ ){0,5}?(?:ask|charge)\b/;
const CASH_CUE =
  /\b(?:i have|we have|i got|have got|savings?|saved(?: up)?|budget|in the bank|cash|left in|raised|won)\b/;
const REVENUE_CUE =
  /\b(?:i|we) (?:am |are )?(?:already )?(?:make|made|making|earn|earned|earning|bring in|brought in|take in|get)\b|\brevenue\b|\bsales (?:of|are|were)\b/;
const ONCE_THINGS =
  'equipment|machine|bike|oven|printer|press|laptop|computer|camera|truck|van|cart|trailer|stand|booth|stall|table|tent|permit|licen[cs]e|registration|domain|logo|mold|mould|prototype|fridge|freezer|cooler|kiln';
const ONE_TIME_CUE = new RegExp(
  `\\b(?:one[- ]time|up ?front|once|to (?:start|begin|set up|launch)|start-?up cost|initial(?:ly)?|used|${ONCE_THINGS})\\b`,
);
/** Money spent to be found. */
const SPEND_CUE =
  /\b(?:flyers?|posters?|adverts?|ads|ad|marketing|promo(?:tion)?s?|campaign|boosted|leaflets?|banners?|business cards)\b/;
const NOT_THIS =
  /\b(?:not|never|instead of|rather than|no longer|used to be|used to (?:sell|charge|cost)(?: \w+){0,3}|was|from|before|down from|up from)\s*$/;
/** Words that stand between a number and its noun, or that are no noun of a product. */
const NO_NOUN = new Set(
  (
    'month week day year hour minute piece unit item sale order time lot bit few person people customer client student ' +
    'of and or the a an my our their for to in on at with that this it them so if more less about total cost price fee ' +
    'dollar buck cent percent other one each every half morning evening night weekend semester term quarter shift event ' +
    'than from after before right now today just only hours minutes left extra me us you they we i who sold paid bought said ' +
    'there here how many much what would could should will does again bring keep stay stays get gets'
  ).split(' '),
);

export const nounOf = (word: string | undefined): string | null => {
  if (word === undefined) return null;
  const one = singular(word.replace(/[^a-z-]/g, ''));
  return one.length < 3 || NO_NOUN.has(one) || NO_NOUN.has(word) ? null : one;
};

/** Second words of a thing sold ("a grant application", "a coffee bag"). */
const TWO_WORDS =
  /^(?:applications?|sessions?|lessons?|orders?|tickets?|bags?|kits?|packs?|sets?|visits?|classes|class|cleanings?|repairs?|shoots?|bottles?|slices?|rides?|trips?|meals?|cards?|calls?|pages?|sheets?|boxes|box|bars?|cups?|jars?|tours?|subscriptions?|memberships?)$/;

const UNIT_NOUN = /^(?:unit|item|piece|sale|order|customer|client|person|student)$/;

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
  if (UNIT_NOUN.test(singular(first))) return { noun: null, period: null, each: true };
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
  // "A table at the fair is": the table.
  const b = before
    .replace(
      /\b([a-z-]+) (?:at|in|on|from|for|of) (?:the |a |my |our )?(?:[a-z-]+ ){1,3}?(?=(?:is|are|costs?)\b)/g,
      '$1 ',
    )
    .replace(
      /\b(?:cost|is|are|about|around|roughly|maybe|like|at|me|us|takes?|gets?|keeps?|runs?|for|another|of)\s*$/g,
      '',
    )
    .trim();
  const verb =
    /((?:[a-z-]+ ){0,2}?[a-z-]+) (?:costs?|is|are|takes?|gets?|keeps?|runs?|adds?)(?: (?:me|us|about|around|roughly|maybe|like|another|for))*\s*$/.exec(
      b === before.trim() ? before : `${b} is`,
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
        !/^(?:it|that|this|which|he|she|they|i|we|and|the|box|one|each|me|us|sells?|for|to|make|making|sale|unit|also|costs?|was|were|them|your|my|our|a|an|to|then|spend|spent|pay|paid|buy|bought|charges?|charged|runs?|run|bills?|goes|go|gets?|takes?|keeps?)$/.test(
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

const NUMBER_ENDS =
  '(?= ?(?:an? |per |each|now|and|[.,;!?]|$))(?! ?(?:minutes?|hours?|people|customers?|students?|of|percent|%))';

/** The money in a sentence, the implied too ("beads cost $7 and shipping 1.50 a box"). `money`: the text holds money. */
function withImpliedMoney(sentence: string, inMoney: boolean): string {
  let out = sentence;
  // "the fee is 450 now", "I charge 12 a box", "they go for 5": a price verb gives its number in money.
  out = out
    .replace(
      /\b((?:sells?|sold|selling|offer(?:ed)?|go(?:es)?|going) (?:(?:it|them|one|each|that|these|those) )?(?:for|at) (?:about |around |only |just )?)(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|now|[.,;!?]|$| and))(?! (?:people|customers?|students?|hours?|minutes?|of|percent))/g,
      '$1$$$2',
    )
    .replace(
      /\b((?:charg(?:e|es|ed|ing)|priced?|pays?|paid) (?:(?:it|them|one|each|me|us|that|about|around|for|at|is|of) ){0,3}|(?:price|fee|rate) (?:(?:is|was|of|per|now|at|to|\w+) ){1,3})(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|now|instead|[.,;!?]|$| and))(?! (?:people|customers?|students?|hours?|minutes?|of|percent))/g,
      '$1$$$2',
    );
  // "300 a month to rent", "rent is 300".
  out = out
    .replace(
      /(?<![\d.$])(\d+(?:\.\d+)?)(?= an? (?:month|week|day|year) (?:to rent|rent|for rent|in rent)\b)/g,
      '$$$1',
    )
    .replace(/\b(rent (?:is|costs) (?:about )?)(\d+(?:\.\d+)?)(?= |[.,;!?]|$)/g, '$1$$$2');
  out = out
    .replace(
      /\b(costs? (?:me|us) (?:about |around |only |just )?)(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|and|to |[.,;!?]|$))(?! ?(?:minutes?|hours?|days?|weeks?|months?|people|customers?))/g,
      '$1$$$2',
    )
    .replace(
      /\b((?:spend|spent|spending) (?:about |around |only |just )?)(\d+(?:\.\d+)?)(?= (?:an? (?:month|week|year|day)|on|for)\b|[.,;!?]|$)/g,
      '$1$$$2',
    )
    .replace(
      /(\$\d[\d.]* an? (?:month|week|year) (?:on|for) [a-z ]{2,30}?(?:,| and) )(\d+(?:\.\d+)?)(?= an? (?:month|week|year) (?:on|for)\b)/g,
      '$1$$$2',
    );
  const here = inMoney || /\$\d/.test(out);
  if (!here) return out;
  out = out
    .replace(
      /\b((?:costs?|takes?|runs?) (?:(?:me|us|about|around|only) )*)(\d+(?:\.\d+)?)(?= ?(?:an? |per |each|and|to |[.,;!?]|$))(?! ?(?:minutes?|hours?|days?|weeks?|months?))/g,
      '$1$$$2',
    )
    .replace(
      /\b((?:gets?|keeps?|goes to [a-z]+|charges? (?:me|us)) (?:about |around |only )?)(\d+(?:\.\d+)?)(?= ?(?:and|[.,;!?]|$))/g,
      '$1$$$2',
    )
    .replace(/(?<!\bthere )\b(is|are) (\d+(?:\.\d+)?)(?= ?(?:[,.;]|$|and\b))/g, '$1 $$$2')
    // "8 goes to the rider, 1 to the app", "20 dollars, or 15 for students".
    .replace(/(?<![\d.$])(\d+(?:\.\d+)?)(?= (?:goes|go) to\b)/g, '$$$1')
    .replace(/(\$\d[\d.]* goes to [^.;]*?(?:,|\band) )(\d+(?:\.\d+)?)(?= to\b)/g, '$1$$$2')
    .replace(
      /(\$\d[\d.~]*(?: each| an? [a-z]+)?,? or )(\d+(?:\.\d+)?)(?= (?:for|to|if|with|when|on)\b|[.,;!?]|$)/g,
      '$1$$$2',
    );
  // A list that goes on: "…cost $7 and shipping 1.50", "clay is $6, glaze 3 and the box 2".
  for (let n = 0; n < 4; n += 1) {
    const next = out.replace(
      new RegExp(
        `(\\$\\d[\\d.~]*(?: (?:each|apiece|(?:an?|per|each|every) [a-z]+))?(?:,| and|, and| plus|, plus) (?:[a-z-]+ ){1,3}(?:is |are |costs? |takes? )?)(\\d+(?:\\.\\d+)?)${NUMBER_ENDS}`,
      ),
      '$1$$$2',
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Whether a sentence only asks, supposes or denies what it holds. */
const SUPPOSES =
  /\b(?:should i|should we|could i|could we|would it|what if|how about|maybe i|do i (?:raise|lower|charge)|(?<!(?:decided to|we|i|have|just) )raise (?:it|the price) to|\bnext (?:year|term|semester|season)\b|thinking|considering|might charge|planning to charge)\b/;

/** What they told before has changed. */
const UPDATES =
  /\b(?:now|new|newer|currently|today|from now|chang(?:e|ed|es)|updated?|rais(?:e|ed|ing)|lower(?:ed|ing)?|instead|no longer|any ?more|used to|as of|decided)\b/;
/** One of a list ("plus", "also"). */
const ADDS = /\b(?:plus|also|too|as well|another|extra|on top|forgot|in addition|additional(?:ly)?)\b/;
/** More than one for the amount ("3 for", "a dozen for", "a pack of 6 for"). */
const SEVERAL =
  /\b(?:\d+ (?:of (?:them|these) )?(?:[a-z-]+ ){0,2}for|(?:pack|box|set|bag|case|bundle|batch|dozen|pair) of \d+ (?:[a-z-]+ )?(?:for|at|is|costs?|sells? for|goes for|sold for))(?: (?:about|around|only|just))?\s*$/;
/** A measure things are bought by: no thing sold. */
const MEASURE =
  /^(?:pound|kilo|kg|ounce|gram|litre|liter|gallon|yard|metre|meter|foot|feet|inch|roll|ream|spool|skein|sheet|sack|mile|km)$/;
/** Money that went in one go: never what one costs. */
const LUMP =
  /\b(?:last|this|that|every|first) (?:month|week|year|term|semester|weekend)\b|\bso far\b|\bin total\b|\baltogether\b|\btotal\b|\bin all\b|\bfor (?:the whole|all)\b|\byesterday\b|\bon (?:saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/;
/** What is paid by the month. */
const FIXED =
  /\b(?:rent|hosting|insurance|server|servers|domain|software|van|truck|bike|car|storage|phone|internet|website|electricity|utilities|salary|salaries|wages?|ads?|marketing|booth|stall|kitchen|studio|space|office|desk|gas|fuel|loan|lease|permit|licen[cs]e|helper|assistant|bookkeeper)\b/;
/** A part of it goes to somebody, and nobody said how much in a number. */
const PART_WORD =
  /\b(?:takes?|keeps?|gets?|wants?|giv(?:e|es|ing) (?:them|him|her|the \w+)|split) (?:a |1 |about )?(?:half|thirds?|quarter|cut|commission|share|percentage)\b|\b(?:half|a third|a quarter) (?:of (?:it|that|each|the price) )?(?:goes|to the)\b|\b50[-/ ]50\b|\bby the (?:dozen|pair|pack|box|bundle)\b|\bper (?:dozen|pair|pack)\b/;
/** A thing bought in bulk ("a bag of clay is 30 dollars"). */
const BULK =
  /\b(?:a|an|1|each|every|per|the) (?:bag|box|roll|pack|sheet|bottle|pound|kilo|kg|bulk|batch|case|bundle|gallon|litre|liter|yard|metre|meter|ream|spool|skein|tin|sack|bolt|carton|crate) of [a-z-]+(?: (?:is|are|costs?|for))?(?: (?:me|us|about|around))*\s*$/;

interface Ctx {
  /** The text holds money somewhere. */
  readonly money: boolean;
  readonly supposedToo: boolean;
}

/** A label and its amount with no verb of cost or sale ("wool is $9", "the box $2"). */
interface Item {
  readonly label: string;
  readonly noun: string | null;
  readonly article: boolean;
  readonly low: number;
  readonly high: number;
  readonly first: boolean;
  readonly per: string | null;
  readonly added: boolean;
}

type Cue = 'cost' | 'sale' | 'revenue' | null;

/** A cost, or the thing they sell. */
const THING_OR_COST =
  /^(?:rent|hosting|postage|shipping|delivery|packaging|materials?|ingredients?|supplies|labou?r|wages?|expenses?|ads?|insurance)$/;
const AIMS =
  /\b(?:to (?:cover|make|reach|earn|save|get|pay|clear|hit)|cover|reach|earn|profit|goal|target|save|enough)\b/;
/** "I sell mugs 12 dollars each": the number stands right after the thing. */
const SOLD_EACH = /\b(?:sell|sells|sold|selling) (?:[a-z-]+ ){1,3}$/;
/** Somebody named who charges or sells: theirs, or nobody knows whose. */
const THIRD =
  /\b(?!(?:i|we|it|that|which|who|and|also)\b)[a-z]+ (?:charges|asks|offers|sells (?!for\b|at\b)[a-z]+)\b(?! (?:me|us)\b)/;

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
      // "Sell to cover", "charge enough to make": what they want, no price.
      if (kind === 'sale' && AIMS.test(before.slice(m.index))) continue;
      // "A delivery is 9 dollars": the thing itself, when it is what they sell.
      if (
        kind === 'cost' &&
        THING_OR_COST.test(m[0]) &&
        /\b(?:an?|1|each|every) (?:[a-z-]+ )?$/.test(before.slice(0, m.index)) &&
        !/\bcosts?\b/.test(before.slice(m.index + m[0].length))
      )
        continue;
      if (
        kind === 'sale' &&
        /^sell|^sold/.test(m[0]) &&
        !/ (?:for|at)(?: (?:about|around|only|just|roughly|maybe))*\s*$/.test(before) &&
        !SOLD_EACH.test(before)
      )
        continue;
      if (m.index >= at) {
        at = m.index;
        cue = kind;
      }
    }
  }
  // A fee is what they pay, unless they charge it.
  if (/\b(?:charges?|charged|bills?|billed) (?:me|us)\b(?!.*\b(?:sell|charge)\b)/.test(before)) return 'cost';
  const fee = PAID_FEE.exec(before);
  if (fee !== null && !/\b(?:i|we) (?:also |then )?(?:charge|add|ask)\b|\bpays? (?:me|us)\b/.test(before))
    return 'cost';
  if (SHARE_CUE.test(before)) return 'cost';
  return cue;
}

const CLAUSE = /[,:]|\b(?:and|plus|but|while|whereas)\b/;

function readSentence(raw: string, out: Read, items: Item[], ctx: Ctx, seen: { amounts: number }): void {
  const s = withImpliedMoney(raw, ctx.money);
  const supposed = SUPPOSES.test(s) && !ctx.supposedToo;
  const money = [...s.matchAll(new RegExp(MONEY, 'g'))];
  let from = 0;
  let cue = null as Cue;
  let byOthers = false;
  let lastNoun: string | null = null;
  let lastItem = false;
  const pending: number[] = [];
  for (const [n, m] of money.entries()) {
    const before = s.slice(from, m.index);
    const whole = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length, money[n + 1]?.index ?? s.length);
    from = m.index + m[0].length;
    seen.amounts += 1;
    const first = seen.amounts === 1;
    if (
      (NOT_THIS.test(whole) && !(ONE_TIME_CUE.test(before) && /\bwas\s*$/.test(whole))) ||
      /^\s*(?:before|earlier|last (?:year|month|week))\b/.test(after) ||
      supposed
    )
      continue;
    const low = Number(m[1]);
    const high = m[2] === undefined ? low : Number(m[2]);
    const per = perOf(after);
    const clause = before.split(CLAUSE).at(-1) ?? before;
    const tail = after.split(/[,;:.]|\b(?:and|plus|but|while|or)\b/)[0] ?? '';
    const own = /\b(?:i|we|my|our|me|us)\b/;
    const noun = per.noun ?? subjectBefore(before) ?? objectBefore(before);
    const added = ADDS.test(before);
    const add = (q: Omit<Quantity, 'low' | 'high'>): void => {
      out.quantities.push({ low, high, ...q, ...(added && q.role === 'unit_cost' ? { added: true } : {}) });
    };
    const loose = (kind: Loose['kind']): void => {
      out.loose.push({ value: low, noun, kind, first });
    };
    // Somebody else's price is nobody's sum.
    if (OTHERS.test(clause) && !own.test(clause) && !/\b(?:gets?|takes?|keeps?)\b/.test(clause)) {
      byOthers = true;
      // "The bookstore is 7 dollars": whose price it is, is not said.
      if (/\b(?:is|are|costs?)\s*$/.test(clause)) loose('unknown');
      if (per.period === 'hour')
        out.quantities.push({ role: 'rate', low, high, noun: null, period: 'hour', label: '', soft: true });
      continue;
    }
    if (THIRD.test(clause) && !own.test(clause)) {
      out.loose.push({ value: low, noun: null, kind: 'unknown', first });
      cue = null;
      continue;
    }
    if (byOthers && lastCue(clause) === null && /,|\band\b|\bor\b/.test(before)) continue;
    byOthers = false;
    const tailCost =
      /^\s*(?:to (?:make|print|bake|sew|knit|build|produce|ship|post|mail|deliver|pack|package|brew|cook|grow)|in (?:materials?|postage|shipping|fees?|labou?r|parts|packaging)|goes to|of (?:that|it) goes|for (?:materials?|ingredients?|parts|postage|shipping|packaging|labou?r|delivery))\b/.test(
        tail,
      );
    const buyers =
      /\bcosts? (?:the |my |our )?(?:customers?|clients?|buyers?|students?|people|them|parents?)\b/.test(
        clause,
      );
    const clauseCue: Cue = tailCost ? 'cost' : buyers ? 'sale' : lastCue(clause);
    const goesOn: boolean = clauseCue === null && /^(?:[^.;]*)(?:,|\band\b|\bplus\b)/.test(before);
    const now: Cue = clauseCue ?? (goesOn || pending.length > 0 ? cue : null);
    cue = now ?? cue;
    const eachSaid = per.each || /\b(?:each|every|apiece)\b/.test(clause);
    if (SEVERAL.test(whole) && !per.each) {
      loose('several');
      continue;
    }
    if (BULK.test(whole) || (per.noun !== null && MEASURE.test(per.noun))) {
      loose('several');
      continue;
    }
    // "To cover 150 dollars of rent", "after a 50 dollar table".
    const covers =
      /\b(?:cover|pay (?:for|off)|earn back|make back)(?: (?:a|an|the|my|our|that|about))*\s*$/.test(before);
    const tailThing = /^\s*(?:(?:of|in|for) (?:the |my |our )?)?([a-z-]+)/.exec(tail)?.[1] ?? '';
    const thingOnce =
      new RegExp(`^(?:a |an )?(?:${ONCE_THINGS})s?$`).test(tailThing) &&
      /\b(?:a|an|the|my|our|that)\s*$/.test(before);
    if ((covers || thingOnce) && per.period === null && !per.each) {
      add({ role: 'one_time', noun: null, period: null, label: tailThing });
      continue;
    }
    const oneTime = ONE_TIME_CUE.test(before) || /^\s*(?:one[- ]time|up ?front|once)\b/.test(after);
    if (per.period === 'hour' && now !== 'cost') {
      add({ role: 'rate', noun: null, period: 'hour', label: '' });
      continue;
    }
    const cash = CASH_CUE.test(before) && clauseCue === null && per.period === null && !per.each;
    if (cash) {
      add({ role: 'cash', noun: null, period: null, label: '' });
      continue;
    }
    const brings =
      /\b(?:earn(?:s|ing|ed)?|make|makes|making|made|bring(?:s|ing)? in|tak(?:e|es|ing) in|income (?:is|of)|revenue (?:is|of)|sales (?:are|of))(?: (?:about|around))?\s*$/.test(
        clause,
      );
    if ((clauseCue === 'revenue' || brings) && per.period !== null) {
      add({ role: 'revenue', noun: null, period: per.period, label: '' });
      continue;
    }
    // "handed out for $36", "spent $36 on flyers": spent to be found.
    if (
      now !== 'sale' &&
      per.period === null &&
      !per.each &&
      (SPEND_CUE.test(before) || SPEND_CUE.test(tail)) &&
      (clauseCue === 'cost' || /\b(?:for|on|at)\s*$/.test(before) || SPEND_CUE.test(tail))
    ) {
      add({ role: 'spend', noun: null, period: null, label: SPEND_CUE.exec(`${before} ${tail}`)?.[0] ?? '' });
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
    // "Nineteen clubs paid $15 a month": what one of them pays.
    if (
      per.period !== null &&
      /\b(?:pay|pays|paid|paying)\s*$/.test(before) &&
      !/\b(?:i|we)\b[^,]*$/.test(clause)
    ) {
      add({ role: 'price', noun: null, period: per.period, label: '' });
      continue;
    }
    if (per.period !== null || batchPeriod !== undefined) {
      if (now === 'cost' || /\b(?:is|are|for)\b/.test(before) || /\bto rent\b/.test(after)) {
        const period = per.period ?? batchPeriod ?? 'other';
        const word =
          batch ?? /^\s*(?:a|an|per|each|every|for (?:a|an|1|each|every)) ([a-z-]+)/.exec(after)?.[1];
        // "150 a month on hosting".
        const on = /^\s*an? [a-z]+ (?:on|for) (?:the |my |our )?([a-z-]+)/.exec(after)?.[1];
        add({
          role: 'period_cost',
          noun: null,
          period,
          label: batch === undefined ? (on ?? label) : batchLabel(before),
          // "A box is 20 dollars a month": what they pay, or what it brings?
          ...(now === 'cost' || batch !== undefined || /\bto rent\b/.test(after) || FIXED.test(before)
            ? {}
            : { soft: true }),
          ...(period === 'other' && word !== undefined ? { batch: singular(word) } : {}),
        });
      } else loose('unknown');
      continue;
    }
    if (oneTime && !per.each) {
      add({ role: 'one_time', noun: null, period: null, label });
      continue;
    }
    if (now === 'cost') {
      const inParts = /^\s*in ([a-z-]+)/.exec(tail)?.[1];
      const named =
        noun !== null && noun === singular(label.split(' ').at(-1) ?? '') ? (inParts ?? '') : label;
      // "I spent 60 on clay": of how many? "It costs me 4", "6 a kit": of one.
      const ofOne =
        per.each ||
        tailCost ||
        /\b(?:each|every|apiece|per|to make|to ship|(?:an?|1) [a-z-]+)\b/.test(clause) ||
        /\b(?:it|1|one|that) (?:costs?|takes?|runs?) (?:me|us)\b|\bcosts? (?:me|us)\b/.test(clause) ||
        (SHARE_CUE.test(clause) && !/\b(?:i|we)\b/.test(clause)) ||
        /^\s*(?:each|apiece|for (?:each|one|1|every)|to make|in [a-z-]+\b)/.test(tail);
      const bought = /\b(?:spen[dt]|spending|paid|pay|paying|buy|bought|buying)\b/.test(clause);
      if (
        (LUMP.test(`${clause} ${tail}`) && !per.each) ||
        (bought && !ofOne && per.noun === null && !/\b(?:to|for) (?:make|print|ship|post)\b/.test(s))
      ) {
        loose('several');
        continue;
      }
      // "A kit costs 9 dollars", with no word of whose cost: only beside a price.
      const whose =
        clauseCue === 'cost' &&
        /\bcosts?\s*(?:about|around|only|just)?\s*$/.test(clause) &&
        noun !== null &&
        per.noun === null &&
        named === '' &&
        !tailCost;
      // "Beads cost $7 and shipping $1.50 a box": the list's noun comes with its last number.
      pending.push(out.quantities.length);
      add({
        role: 'unit_cost',
        noun:
          noun === singular(named)
            ? lastNoun
            : (per.noun ?? (named === '' || inParts !== undefined ? noun : null)),
        period: null,
        label: named,
        ...(whose || (lastItem && clauseCue === null) || !ofOne ? { soft: true } : {}),
      });
      if (per.noun !== null || per.each) {
        for (const i of pending) {
          const q = out.quantities[i];
          if (q === undefined) continue;
          const { soft, ...said } = q;
          out.quantities[i] = {
            ...said,
            noun: q.noun ?? per.noun ?? lastNoun,
            ...(soft === true && whose ? { soft } : {}),
          };
        }
        lastNoun = per.noun ?? lastNoun;
      }
      continue;
    }
    // "$12 a cup", "12 dollars each" with no verb: the price of one, when nothing else of the sentence says cost.
    if (per.each && !COST_CUE.test(s) && !/\b(?:is|are)\s*$/.test(before)) {
      add({ role: 'price', noun, period: null, label: '', soft: true });
      lastNoun = noun ?? lastNoun;
      continue;
    }
    // "Wool is $9 and knitting $8", "a delivery is $9": what it is, the rest of the text says.
    const item =
      /(?:^|[,;:]|\b(?:and|plus|but|while)\b)\s*((?:(?:the|a|an|1|each|every|my|our|1) )?(?:[a-z-]+ ){0,3}?[a-z-]+?)(?: (?:is|are|at|:))?(?: (?:about|around|only|just|another))*\s*$/.exec(
        before === whole ? whole : before,
      );
    const words = item?.[1]?.trim() ?? '';
    const head = nounOf(words.split(' ').at(-1));
    if (words !== '' && head !== null && !/\b(?:it|that|this|they|price|total|sum)$/.test(words)) {
      items.push({
        label: label === '' ? head : label,
        noun: head,
        article: /^(?:a|an|1|each|every)\b/.test(words),
        low,
        high,
        first,
        per: per.noun,
        added: added || eachSaid,
      });
      lastItem = true;
      continue;
    }
    loose('unknown');
  }
  readCounts(s, out, supposed);
}

const GOT =
  '(?:sold|bought|paid|said yes|signed(?: up)?|ordered|pre-?ordered|subscribed|converted|came back|stayed|replied|answered|booked)';
export const LOST =
  /\b(?:cancel\w*|left|leave|leaves|quit|quits|churn\w*|drop(?:ped|s)? out|dropped|unsubscribed|stopped|lost|lose|gone|did not renew|never came back)\b/;

const PER_PERIOD =
  '(?:a|per|each|every|in 1|in a) (day|week|month|year|morning|evening|night|weekend|event|batch|shift|semester|term|season)';

function readCounts(s: string, out: Read, supposed: boolean): void {
  const t = s.replace(new RegExp(MONEY, 'g'), ' $ ');
  // Volume: "40 boxes a month", "40 of them a week".
  for (const m of t.matchAll(
    new RegExp(
      `(?<![\\d.$])(\\d+(?:\\.\\d+)?)(?: (?:of them|(?:more |paying |regular )?([a-z-]+)))?(?: (?:go|goes|went|are|get) (?:out|sold))? ${PER_PERIOD}\\b`,
      'g',
    ),
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
    if (/^(?:percent|times?|days?|weeks?|talks?|interviews?|calls?|posts?|emails?)$/.test(word)) continue;
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
      new RegExp(
        `\\b(?:at|(?:if|say|when|suppose|and) (?:(?:i|we) )?(?:sell|sold|do|make|get)|selling|sell|sold|make on|made on|left on|keep on|from|on|for) (\\d+)(?: (?:more )?(?!(?:a|an|per|each|every|in|of)\\b)([a-z-]+)(?! ${PER_PERIOD})\\b|(?=\\s*(?:[.,;?!]|$|of them\\b|there\\b|each\\b)))`,
        'g',
      ),
    )) {
      const noun = nounOf(m[2]);
      const verb = /^(?:at|if|say|when|suppose|and|sell|selling|sold|make on|made on|left on|keep on)/.test(
        m[0],
      );
      const bareVerb = /\b(?:sell|do|make|get|selling)\b/.test(m[0]);
      if (noun === null && !bareVerb) continue;
      if (
        !verb &&
        (noun === null ||
          !/\b(?:make|made|left|keep|profit|earn|clear|stays?|remains?)\b[^?]*$/.test(
            t.slice(Math.max(0, m.index - 160), m.index),
          ))
      )
        continue;
      if (
        /^(?:hours?|minutes?|percent|am|pm|days?|weeks?|months?|years?|people|customers?|students?)$/.test(
          m[2] ?? '',
        )
      )
        continue;
      out.quantities.push({
        role: 'volume',
        low: Number(m[1]),
        high: Number(m[1]),
        noun,
        period: null,
        label: '',
        ...(verb ? {} : { soft: true }),
      });
    }
  // "And 30 of them?"
  const some = /^(?:(?:and|so|ok|okay|then) )*(\d+) (?:of (?:them|those|these)|more)\b/.exec(t);
  if (some !== null)
    out.quantities.push({
      role: 'volume',
      low: Number(some[1]),
      high: Number(some[1]),
      noun: null,
      period: null,
      label: '',
    });
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
  // A part of the price that goes to somebody ("the app takes 15 percent", "a 10% commission").
  for (const m of t.matchAll(/(?<![\d.$])(\d+(?:\.\d+)?) ?(?:%|percent)/g)) {
    out.percents.push(Number(m[1]));
    const clause =
      t
        .slice(0, m.index)
        .split(/[,;:]|\bbut\b/)
        .at(-1) ?? '';
    const after = t.slice(m.index + m[0].length);
    const takes =
      /\b(?!(?:to|i|we|you|can|would|will|could|should|not) )([a-z-]+) (?:takes?|keeps?|charges?|gets?)(?: (?:a|an|about|around|only))*\s*$/.exec(
        clause,
      ) ??
      /\b(?:card|payment|platform|processing|transaction|app|marketplace) (fees?) (?:is|are|of)(?: about)?\s*$/.exec(
        clause,
      );
    const cut =
      /^ (?:commission|cut|fee)\b/.test(after) ||
      /\b(?:commission|fees?|cut) (?:is|are|of)(?: about)?\s*$/.test(clause);
    if (/\b(?:i|we)\b[^,]*$/.test(clause) && /\b(?:i|we) (?:get|keep|take|want|make)/.test(clause)) continue;
    if (takes !== null || cut) {
      const ofWhat =
        /^ (?:commission |cut |fee )?(?:of|on|from|per) (?:the |each |every |my |our |a )?([a-z]+)/.exec(
          after,
        )?.[1];
      if (
        ofWhat === undefined ||
        /^(?:price|sale|order|[a-z]+ price|it|that|everything|all)$/.test(ofWhat) ||
        (nounOf(ofWhat) !== null && !/profit|margin|revenue|sales|tips?/.test(ofWhat))
      )
        out.quantities.push({
          role: 'unit_share',
          low: Number(m[1]),
          high: Number(m[1]),
          noun: null,
          period: null,
          label: takes?.[1] === undefined || /^fees?$/.test(takes[1]) ? 'fee' : takes[1],
        });
      else out.percentLoose = true;
    } else if (/\b(?:tax|discount|off|interest)\b/.test(`${clause} ${after.split(/[,;:]/)[0] ?? ''}`))
      out.percentLoose = true;
  }
  readPlainCounts(t, out);
  for (const r of ratiosIn(t))
    if (!out.ratios.some((x) => x.part === r.part && x.whole === r.whole)) out.ratios.push(r);
}

/** Every count of a sentence, with the words of its clause. */
function readPlainCounts(t: string, out: Read): void {
  for (const clause of t.split(/[,;:]|\band\b|\bbut\b/)) {
    for (const m of clause.matchAll(
      /(?<![\d.$])(\d+(?:\.\d+)?)(?![\d]|\.\d)(?! ?(?:%|percent|am\b|pm\b|hours?\b|minutes?\b|days?\b|weeks?\b|months?\b|years?\b))(?: (?:of (?:them|those|these|the|my|our) )?([a-z-]+))?/g,
    )) {
      // "a month in the first month of term": no count.
      out.counts.push({
        value: Number(m[1]),
        noun: nounOf(m[2]),
        clause: clause.trim(),
        bare: m[2] === undefined,
      });
    }
  }
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
  // "I offered the app to 30 parents at $4 a month. 2 paid."
  for (const m of t.matchAll(
    new RegExp(
      `\\b${asked} (?:[a-z-]+ ){1,5}?to (\\d+)\\b[^;]{0,60}?(?:,|\\band\\b|\\bbut\\b|\\.) ?(?:only |just )?(\\d+) (?:of (?:them|those) |people |[a-z]+ )?${GOT}`,
      'g',
    ),
  ))
    add(Number(m[2]), Number(m[1]));
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

/** Every number of a text with its role. `supposedToo`: what they only suppose counts (a sum they ask about it). */
export function readText(text: string, supposedToo = false): Read {
  const out: Read = {
    quantities: [],
    ratios: [],
    counts: [],
    loose: [],
    foreign: false,
    percentLoose: false,
    percents: [],
    updates: false,
  };
  const said = saidNumbers(text);
  out.foreign = FOREIGN.test(said);
  const items: Item[] = [];
  const seen = { amounts: 0 };
  const ctx: Ctx = { money: /\$\d/.test(said), supposedToo };
  for (const sentence of said.split(/(?<=[.?!;])\s+|;\s*|\n/)) {
    const s = sentence.replace(/[.?!]+$/u, '').trim();
    if (s !== '' && /\d/.test(s)) readSentence(s, out, items, ctx, seen);
  }
  // A whole and its part in two sentences.
  for (const r of ratiosIn(said.replace(new RegExp(MONEY, 'g'), '$')))
    if (!out.ratios.some((x) => x.part === r.part && x.whole === r.whole)) out.ratios.push(r);
  if (PART_WORD.test(said)) out.percentLoose = true;
  out.updates = UPDATES.test(said);
  placeItems(items, out);
  return out;
}

/** What a label with its amount is: beside a price, a part of what one costs; with no price, nobody knows. */
function placeItems(items: readonly Item[], out: Read): void {
  if (items.length === 0) return;
  const prices = out.quantities.filter((q) => q.role === 'price' && q.period === null && q.soft !== true);
  const products = new Set(prices.flatMap((p) => (p.noun === null ? [] : [p.noun])));
  for (const item of items) {
    if (prices.some((p) => p.low === item.low) && item.noun !== null && products.has(item.noun)) continue;
    if (
      prices.length > 0 &&
      products.size <= 1 &&
      // "A mug is 8 dollars. I sell it for 20": whose mug, at what?
      !(item.article && products.size === 0) &&
      (item.noun === null || !products.has(item.noun))
    )
      out.quantities.push({
        role: 'unit_cost',
        low: item.low,
        high: item.high,
        noun: [...products][0] ?? null,
        period: null,
        label: item.label,
        soft: true,
        ...(item.added ? { added: true } : {}),
      });
    else
      out.loose.push({
        value: item.low,
        noun: item.noun,
        kind: item.article ? 'bare' : 'unknown',
        first: item.first,
      });
  }
}

/** Every number of a text with its role. */
export function quantitiesIn(text: string): {
  readonly quantities: readonly Quantity[];
  readonly ratios: readonly Ratio[];
} {
  return readText(text);
}
