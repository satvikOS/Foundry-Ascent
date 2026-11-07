/**
 * Figures in a reply that nobody gave: a price, a percentage, a threshold or a target the coach made up as an example.
 *
 * Live pilot 42124259353: 32 replies carried a figure that appeared nowhere in what the student said or the program's
 * sources ("ask if they'd pay $2 a month", "if fewer than 15 percent keep using it, stop"), and 11 more proposed one as
 * an example ("say, $1 per seat"). Arithmetic on the student's own numbers was fine and stays fine. The doctrine that
 * asked for a kill criterion "in numbers" is gone (Thomas, ADR-0021) and the prompt says to use the founder's numbers,
 * compute openly, or say what to measure; on the way out:
 *
 * - {@link inventedFigures} reads which money and percentage figures of a reply nobody gave (neither the founder's
 *   messages, nor the sources shown, nor arithmetic on two of those numbers): counted on the turn record
 *   (`invented_figure:n`, `proposed_figure:n`), so the lab and production can see the rate;
 * - {@link withoutExampleFigures} leaves out an aside that only offers a made-up figure as an example ("(say, $10 a
 *   month)", "— e.g. 40 percent —", "(even $5–$10)"). The sentence around it stands; nothing else of the reply is touched.
 * - {@link withoutInventedFigures} (coaching v3: pilot v3 still stated 30 made-up figures) says a figure nobody gave by
 *   what it is, where a price is offered or asked and the sentence reads as well without the number: "offer a $10 gift
 *   card" → "offer a gift card", "add a 10 percent discount" → "add a discount", "would you pay $2/month for it" →
 *   "would you pay a monthly price for it", "sell it at $30 per unit" → "sell it at a set price per unit". Any other
 *   made-up figure (an estimate, a fact about the market) stays as written (and counted): the sentence would not
 *   read without it.
 */

/**
 * Money in any currency, as the lab's live checks read it (ops/lab conversation_lab/live/checks.py `NUMBER`; the cases
 * both must agree on are evals/tests/fixtures/figure_cases.json). Lab run 42238272157: "a local tutor at, say, 50–100
 * cedis an hour" was a made-up local rate that neither the product nor the lab read as a figure (only "$", "€", "£").
 */
const MONEY_SIGN = '[$€£₵₦₹¥₩]';
const MONEY_CODE =
  '(?:USD|EUR|GBP|GHS|GH₵|NGN|KES|KSh|Ksh|ZAR|INR|Rs\\.?|UGX|TZS|RWF|ETB|XOF|XAF|EGP|MAD|CAD|AUD|CFA)';
const MONEY_WORD =
  '(?:dollars?|bucks|euros?|pounds?|quid|pence|cents?|cedis?|pesewas|naira|kobo|shillings?|rand|rupees?|pesos?|reais|yen|yuan|renminbi|dirhams?|riyals?|francs?|birr|kwacha|taka|ringgit|baht|lira|zloty)';
const AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?';
const SCALE = '(?:k|m|bn|million|billion|thousand)';
const RANGE_TO = '\\s?(?:-|–|—|to)\\s?';
/** The figure shapes: a sign or a code first, or a currency word, %, "million" or "billion" after. */
const FIGURE_SOURCE = [
  // "$1,200", "$1.5k", "GHS 80", "₦5,000", "$5–$10".
  `(?:${MONEY_SIGN}|(?<![\\p{L}\\p{N}])${MONEY_CODE}\\s?)\\s?${AMOUNT}(?:\\s?${SCALE}(?![\\p{L}]))?(?:${RANGE_TO}(?:${MONEY_SIGN}\\s?)?${AMOUNT}(?:\\s?${SCALE}(?![\\p{L}]))?)?`,
  // "40%", "15 percent", "10–15%".
  `${AMOUNT}(?:${RANGE_TO}${AMOUNT})?\\s?(?:%|percent|per cent)`,
  // "50–100 cedis", "300 shillings", "2 million dollars".
  `${AMOUNT}(?:${RANGE_TO}${AMOUNT})?(?:\\s?${SCALE})?\\s?(?:${MONEY_WORD}|${MONEY_CODE})(?![\\p{L}])`,
  // A market size or a statistic: "2 million students", "1.5 billion".
  `${AMOUNT}(?:${RANGE_TO}${AMOUNT})?\\s?(?:million|billion)(?![\\p{L}])`,
].join('|');
/** A money or percentage figure ("$1,200", "$1.5k", "40%", "15 percent", "$2/month", "50–100 cedis", "GHS 80"). */
const FIGURE = new RegExp(FIGURE_SOURCE, 'giu');
const PERCENT = /%|percent|per cent/i;

/** Any number in known text ("40 firm orders", "$3.50", "70%"). */
const NUMBER = /\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand))?/giu;

function valueOf(token: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|million|billion|thousand)?/iu.exec(token);
  if (m?.[1] === undefined) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const scale =
    unit === 'k' || unit === 'thousand'
      ? 1e3
      : unit === 'm' || unit === 'million'
        ? 1e6
        : unit === 'bn' || unit === 'billion'
          ? 1e9
          : 1;
  return base * scale;
}

/** The numbers `text` holds, as values. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const v = valueOf(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.011);
}

/**
 * Everyday scalings said in words ("half of", "a third", "per year", "per week"): a money figure that is one of these of a
 * known number is arithmetic on it (never a percentage: too many would match by chance).
 */
const SCALES = [0.5, 0.25, 1 / 3, 2, 4, 12, 52, 1 / 12, 1 / 52];

/** Most known numbers combined pairwise (arithmetic on a long pasted table stays bounded). */
const MAX_KNOWN = 40;

/**
 * Whether `value` is one of the known numbers, or arithmetic on two of them (sum, difference, product, quotient, or a
 * quotient as a percentage), within rounding.
 */
function derivable(value: number, known: readonly number[], percent: boolean): boolean {
  const nums = known.slice(0, MAX_KNOWN);
  if (nums.some((k) => close(value, k) || (!percent && SCALES.some((f) => close(value, k * f))))) return true;
  for (let i = 0; i < nums.length; i += 1) {
    for (let j = 0; j < nums.length; j += 1) {
      const a = nums[i] ?? 0;
      const b = nums[j] ?? 0;
      if (i !== j) {
        if (close(value, a + b) || close(value, a - b) || close(value, a * b)) return true;
        if (b !== 0 && (close(value, a / b) || (percent && close(value, (a / b) * 100)))) return true;
        if (percent && b !== 0 && close(value, ((a - b) / b) * 100)) return true;
      }
    }
  }
  return false;
}

/**
 * Words before a figure that offer it as an example, a condition or a target ("say", "e.g.", "aim for", "if it's
 * under"), at most 24 characters before it: the lab's `_PROPOSED` (ops/lab live/checks.py), word for word, so both
 * split the same figures. "About", "around", "roughly", "like", "over" and "under" are claims, not proposals.
 */
const PROPOSED_CUE =
  /(?:\b(?:say|e\.g\.|for example|for instance|suppose|imagine|aim for|target(?:ing)?(?: of)?|goal of|threshold of|set (?:a|the|your) (?:bar|threshold|target|cap) (?:at|of)|cap(?:ped)? at|kill (?:it )?(?:if|at|below)|if(?: (?:it'?s|you get|you see|you hit|fewer than|more than|less than|under|over|below|above|at least))?)\b[^.?!\d]{0,24})$/iu;

export interface InventedFigures {
  /** Figures stated as fact that nobody gave. */
  readonly unsourced: readonly string[];
  /** Figures offered as an example, a condition or a target that nobody gave. */
  readonly proposed: readonly string[];
}

/** The money and percentage figures of `answer` that `known` (what the founder said, the sources shown) does not give. */
export function inventedFigures(answer: string, known: string): InventedFigures {
  const knownNumbers = numbersIn(known);
  const unsourced: string[] = [];
  const proposed: string[] = [];
  for (const m of answer.matchAll(FIGURE)) {
    // Every number of the figure: one end of a range nobody gave makes the range made up.
    const values = numbersIn(m[0]);
    if (values.length === 0) continue;
    const percent = PERCENT.test(m[0]);
    if (values.every((value) => derivable(value, knownNumbers, percent))) continue;
    const before = answer.slice(Math.max(0, m.index - 40), m.index);
    // Only a percentage is ever a bar the founder sets: a price, a rate or a size is a claim about the market.
    const offered = percent && PROPOSED_CUE.test(before);
    (offered ? proposed : unsourced).push(m[0].trim());
  }
  return { unsourced, proposed };
}

/** An aside that offers an example: "(say, $10 a month)", "— e.g. 40% —", "(even $5–$10)". */
const EXAMPLE_ASIDE =
  /\s?\((?:say|e\.?g\.?|for example|for instance|something like|maybe|like|roughly|around|about|even|just|only)\b[^()\n]{0,120}\)|\s?[—–]\s?(?:say|e\.?g\.?|for example|for instance|something like|maybe)\b[^—–\n]{0,120}[—–]\s?/giu;

/**
 * An example price set off by commas, and the preposition it hangs from: "a local tutor at, say, 50–100 cedis an hour."
 * (lab run 42238272157), "Charge, say, $5 a crate, and…", "A tutor at, for example, GHS 80 a session would…". It ends
 * where its clause does (punctuation, or the verb or conjunction the sentence goes on with).
 */
const COMMA_EXAMPLE = new RegExp(
  String.raw`(?:\s+(?:at|for|of|around|about|costing|charging))?,\s*(?:say|e\.g\.|for example|for instance),?\s+(${FIGURE_SOURCE})(?:\s?(?:\/\s?|\ban? |\bper |\beach )\p{L}+)?(?=\s*(?:[,.;:!?)]|$)|\s+(?:would|will|could|might|can|is|are|was|and|or|but|so|which|that|to|still)\b)`,
  'giu',
);

/**
 * `answer` without the asides that only offer a made-up figure as an example (see the module comment): in parentheses
 * or dashes, or a money example set off by commas ({@link COMMA_EXAMPLE}). An aside whose figures the founder or a
 * source gave stays, and so does a percentage offered as a bar.
 */
export function withoutExampleFigures(
  answer: string,
  known: string,
): { readonly text: string; readonly removed: number } {
  let removed = 0;
  const withoutCommaExamples = answer.replace(COMMA_EXAMPLE, (aside, figure: string) => {
    if (PERCENT.test(figure)) return aside;
    const invented = inventedFigures(figure, known);
    if (invented.unsourced.length + invented.proposed.length === 0) return aside;
    removed += 1;
    return '';
  });
  const text = withoutCommaExamples.replace(EXAMPLE_ASIDE, (aside) => {
    if (
      inventedFigures(aside, known).proposed.length + inventedFigures(aside, known).unsourced.length ===
      0
    ) {
      return aside;
    }
    removed += 1;
    // A dash aside joins the words around it ("of that — say $1 — so" → "of that so").
    return /^\s?[—–]/.test(aside) ? ' ' : '';
  });
  return removed === 0
    ? { text: answer, removed: 0 }
    : { text: text.replace(/ {2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1'), removed };
}

/** A money or percentage figure, or a range of two ("$5–$10", "10 to 15 percent", "50–100 cedis"). */
const FIGURE_OR_RANGE = `(?:${FIGURE_SOURCE})`;

/** "a $10 gift card", "an 8% cut": an article, the figure, then the thing it prices. */
const PRICED_THING = new RegExp(
  String.raw`\b([Aa]n?) (${FIGURE_OR_RANGE}) (?!(?:per|a|an|each|for|to|or|and|in|of|on|at|from|off|more|less|or)\b)(?=(\p{L}[\p{L}'’-]*))`,
  'gu',
);

/** "$2/month", "$30 per unit", "$10 a session": a price per period or per item. */
const PRICE_PER = new RegExp(
  String.raw`(?<!\b(?:the|that|this|your|their|our|my|its|a|an) )(${FIGURE_OR_RANGE})\s?(?:/\s?|\ba |\bper |\beach )(month|week|year|seat|user|session|class|lesson|unit|order|head|person|student|household|customer|box|kit|test|visit|night|hour)\b`,
  'giu',
);

const PERIOD: Readonly<Record<string, string>> = { month: 'monthly', week: 'weekly', year: 'yearly' };

/** Where a verb of offering may stand: a clause's start, after "you", "we", a modal, "try", "then"… (never "they"). */
const OFFER_LEAD = String.raw`(?:^[\s*_"“]*|[:;(—–]\s*|,\s+|\b(?:you|we|i|to|could|would|should|might|can|will|then|and|or|just|first|maybe|perhaps|try|consider|start by)\s+)`;

/**
 * The clause before a figure offers or asks a price: a verb of offering, charging or selling ("Offer a small reward
 * (a…", "Add a…", "Sell it at…", "charge…"), or paying asked of someone ("would you pay…", "willing to pay…", "ask
 * them to pay…"). Only there is a made-up figure said by its role: a figure stated as an estimate or a fact ("Rent alone
 * is likely $1,200 a month", "A 30% margin is healthy", "Most cafés pay $4 a box") would lose its meaning without its
 * number, so it stays as written and is counted (review of coaching v3).
 */
const OFFERING = new RegExp(
  String.raw`(?:${OFFER_LEAD}(?:offer(?:ing)?|add(?:ing)?(?! up)|charg(?:e|ing)|sell(?:ing)?|pric(?:e|ing) (?:it|them|this|that|the \w+)|quot(?:e|ing)|propos(?:e|ing)|ask(?:ing)? for)\b|\b(?:would|will|could|ask \p{L}+ to|willing to|ready to|happy to|want to)\s+(?:(?:you|they|people|customers|parents|\p{L}+s)\s+)?pay\b|\b(?:you|they|we|people)['’]d\s+pay\b)[^.!?\n]*$`,
  'iu',
);

/** Whether the figure at `index` of `text` is offered or asked as a price ({@link OFFERING}). */
function offeredAt(text: string, index: number): boolean {
  const from = Math.max(0, index - 80);
  const parts = text.slice(from, index).split(/[.!?\n]\s/u);
  // A clause cut by the window does not start where the window does.
  const clause = parts.length === 1 && from > 0 ? `… ${parts[0] ?? ''}` : (parts.pop() ?? '');
  return OFFERING.test(clause);
}

/** The article for a word ("a gift card", "an evening class"). */
function articleFor(word: string, capital: boolean): string {
  const an = /^(?:[aeio]|u(?!n[aeiou]|ni|s[aeiou]|r[aeiou]|tility)|hour|honest)/iu.test(word);
  const article = an ? 'an' : 'a';
  return capital ? `${article.charAt(0).toUpperCase()}${article.slice(1)}` : article;
}

/**
 * `answer` with each figure nobody gave said by what it is where that reads as well (see the module comment): figures
 * the founder or a source gave, arithmetic on theirs, and figures offered as an example, condition or target are left
 * as they are (the last are counted as proposed). `removed` counts the figures taken out.
 */
export function withoutInventedFigures(
  answer: string,
  known: string,
): { readonly text: string; readonly removed: number } {
  const invented = new Set(inventedFigures(answer, known).unsourced.map((f) => f.replace(/\s+/g, ' ')));
  if (invented.size === 0) return { text: answer, removed: 0 };
  const madeUp = (figure: string): boolean => {
    for (const m of figure.matchAll(FIGURE)) if (invented.has(m[0].trim().replace(/\s+/g, ' '))) return true;
    return false;
  };
  let removed = 0;
  let text = answer.replace(
    PRICED_THING,
    (whole, article: string, figure: string, next: string, at: number) => {
      if (!madeUp(figure) || !offeredAt(answer, at)) return whole;
      removed += 1;
      return `${articleFor(next, article.startsWith('A'))} `;
    },
  );
  text = text.replace(PRICE_PER, (whole, figure: string, per: string, at: number, all: string) => {
    if (!madeUp(figure) || !offeredAt(all, at)) return whole;
    removed += 1;
    const period = PERIOD[per.toLowerCase()];
    return period === undefined ? `a set price per ${per}` : `a ${period} price`;
  });
  return removed === 0 ? { text: answer, removed: 0 } : { text, removed };
}
