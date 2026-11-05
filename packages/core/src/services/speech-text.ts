/**
 * The words a vendor voice is handed, written out the way they are said (pure; unit tested).
 *
 * ElevenLabs Flash v2.5 does not normalise text (its `apply_text_normalization: on` is an Enterprise feature), so
 * "$1.5M", "25%", "3-5x" or "2026" can come out letter by letter or digit by digit. ElevenLabs' own advice is to
 * normalise before the request. {@link speechText} takes text that {@link speakableText} already made plain (no
 * citation keys, emphasis, headings, bullets or link targets) and also:
 * - never reads a web address or an email address: it says "the link on screen" / "the email address on screen"
 *   (the caption shows the address itself), with or without `https://` or `www.` ("ycombinator.com/apply",
 *   "foundry.ai": a name ending in a common top-level domain, written in lower case so "ASP.NET" stays a word);
 * - drops what is left of Markdown tables and code (`|`, `#`, backticks) and says a few symbols and abbreviations
 *   as words (`&`, `e.g.`, `vs.`, `→`);
 * - writes numbers as words: ranges first, with what either end carries said once ("3-5x" → "three to five times",
 *   "3-5%" → "three to five percent", "$500k-$1M" → "five hundred thousand to one million dollars"), then money
 *   ("$1.5M" → "one point five million dollars"), percentages, multipliers ("10x"), ordinals, times, ISO dates,
 *   versions ("2.0.1" → "two point zero point one"), "24/7", years after "in", "since", "by" and the like,
 *   fractions, phone numbers (digit by digit: "555-123-4567", and "555-1234" unless it is a round range such as
 *   "100-1000" with no "call" or "phone" before it) and plain numbers with thousands separators and decimals;
 * - leaves a number written into a word as it is ("GPT-4o", "Q3", "v2", "B2B"): the voice reads those as names.
 *
 * Amazon Polly normalises text itself, so Polly's own units are left as they were; a Polly unit that stands in for a
 * vendor unit says these same words.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [bigint, string][] = [
  [1_000_000_000_000n, 'trillion'],
  [1_000_000_000n, 'billion'],
  [1_000_000n, 'million'],
  [1_000n, 'thousand'],
];

function underHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const tens = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10] ?? ''}`;
}

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 0) return underHundred(rest);
  return rest === 0
    ? `${ONES[hundreds] ?? ''} hundred`
    : `${ONES[hundreds] ?? ''} hundred ${underHundred(rest)}`;
}

/** Digit by digit ("4 0 7" → "four zero seven"). */
function digitsAsWords(digits: string): string {
  return Array.from({ length: digits.length }, (_, i) => digits.charAt(i))
    .map((d) => ONES[Number(d)] ?? d)
    .join(' ');
}

/** A whole number as words ("1,234" → "one thousand two hundred thirty-four"); past 999 trillion, digit by digit. */
export function integerWords(digits: string): string {
  const clean = digits.replace(/,/g, '');
  if (!/^\d+$/.test(clean)) return digits;
  if (clean.length > 15) return digitsAsWords(clean);
  let n = BigInt(clean);
  if (n === 0n) return 'zero';
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) {
      parts.push(`${underThousand(Number(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0n) parts.push(underThousand(Number(n)));
  return parts.join(' ');
}

/** A number as words, with its decimals read digit by digit ("1.25" → "one point two five"). */
export function numberWords(text: string): string {
  const [whole = '', fraction] = text.split('.');
  const words = integerWords(whole === '' ? '0' : whole);
  return fraction === undefined || fraction === '' ? words : `${words} point ${digitsAsWords(fraction)}`;
}

const ORDINAL_WORDS: Record<string, string> = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};

/** "21" → "twenty-first". */
function ordinalWords(digits: string): string {
  const words = integerWords(digits);
  const match = /([a-z]+)$/.exec(words);
  if (match === null) return words;
  const last = match[1] ?? '';
  const ordinal = ORDINAL_WORDS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, words.length - last.length) + ordinal;
}

/** A year as it is said ("2026" → "twenty twenty-six", "2005" → "two thousand five", "1990" → "nineteen ninety"). */
function yearWords(year: string): string {
  const n = Number(year);
  if (n >= 2000 && n < 2010) return integerWords(year);
  const head = Math.floor(n / 100);
  const tail = n % 100;
  if (tail === 0) return `${underHundred(head)} hundred`;
  return `${underHundred(head)} ${tail < 10 ? `oh ${ONES[tail] ?? ''}` : underHundred(tail)}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const SCALE_WORDS: Record<string, string> = {
  k: 'thousand',
  thousand: 'thousand',
  m: 'million',
  mm: 'million',
  mn: 'million',
  million: 'million',
  b: 'billion',
  bn: 'billion',
  billion: 'billion',
  t: 'trillion',
  tn: 'trillion',
  trillion: 'trillion',
};

const CURRENCIES: Record<string, [string, string, string, string]> = {
  // symbol: [one, many, cent, cents]
  $: ['dollar', 'dollars', 'cent', 'cents'],
  '€': ['euro', 'euros', 'cent', 'cents'],
  '£': ['pound', 'pounds', 'penny', 'pence'],
};

function money(symbol: string, amount: string, scale: string | undefined): string {
  const [one, many, cent, cents] = CURRENCIES[symbol] ?? ['', '', '', ''];
  const plain = amount.replace(/,/g, '');
  const scaleWord = scale === undefined ? undefined : SCALE_WORDS[scale.toLowerCase()];
  if (scaleWord !== undefined) return `${numberWords(plain)} ${scaleWord} ${many}`;
  const [whole = '0', fraction] = plain.split('.');
  const unit = whole === '1' ? one : many;
  if (fraction !== undefined && /^\d\d$/.test(fraction) && fraction !== '00') {
    const pennies = Number(fraction);
    const coins = `${integerWords(String(pennies))} ${pennies === 1 ? cent : cents}`;
    return whole === '0' ? coins : `${integerWords(whole)} ${unit} and ${coins}`;
  }
  return `${integerWords(whole)} ${unit}`;
}

const FRACTIONS: Record<string, string> = {
  '1/2': 'one half',
  '1/3': 'one third',
  '2/3': 'two thirds',
  '1/4': 'one quarter',
  '3/4': 'three quarters',
};

/** Top-level domains a bare web address ends with (lower case; never one that is also a common word). */
const TLDS =
  'com|org|net|edu|gov|io|ai|co|app|dev|xyz|info|biz|tech|gg|tv|fm|sh|vc|ly|eu|uk|ca|de|fr|au|jp|nl|ch|es|se|dk|fi|ie|nz|sg|hk|kr|br|mx|health|bio|ventures|capital|fund|academy|school';
/** A web address without its scheme ("ycombinator.com/apply", "foundry.ai"), up to the punctuation after it. */
const BARE_ADDRESS = new RegExp(
  `(?<![\\w@./-])(?:[A-Za-z0-9][A-Za-z0-9-]*\\.)+(?:${TLDS})(?![\\w-])(?:[/?#][^\\s<>"']*?)?(?=[.,;:!?)\\]'"]*(?:\\s|$))`,
  'g',
);

/** The scales a range end may carry; a lone `m`, `b` or `t` only after a currency sign ("$3-5m", never "3-5m"). */
const RANGE_SCALE = '(?:k|mm|mn|m|bn|b|tn|t|thousand|million|billion|trillion)';
const RANGE_NUMBER = '(\\d[\\d,]*(?:\\.\\d+)?)';
/** "3-5", "3-5x", "3%-5%", "$500k-$1M", "$1-2 million": a range between two numbers, with what each end carries. */
const RANGE = new RegExp(
  `(?<![\\w.,])([$€£])?${RANGE_NUMBER}(?:\\s?(${RANGE_SCALE})\\b)?(\\s?%|[x×](?![\\p{L}\\d]))?\\s?[-–—]\\s?([$€£])?${RANGE_NUMBER}(?:\\s?(${RANGE_SCALE})\\b)?(\\s?%|[x×](?![\\p{L}\\d]))?(?![\\d\\p{L}])`,
  'giu',
);

/** A range end's scale as a word, or undefined when the letter is a unit rather than a scale ("5m" with no "$"). */
function rangeScale(scale: string | undefined, currency: boolean): string | undefined {
  if (scale === undefined) return undefined;
  if (!currency && /^[mbt]$/.test(scale)) return undefined;
  if (!currency && /^[MB]$/.test(scale)) return scale === 'M' ? 'million' : 'billion';
  return SCALE_WORDS[scale.toLowerCase()];
}

function isYear(n: string): boolean {
  return /^(?:1[5-9]\d\d|20\d\d)$/.test(n);
}

/** A range said once: each end as a number with its scale, then the currency, percent or "times" they share. */
function rangeWords(
  whole: string,
  c1: string | undefined,
  n1: string,
  s1: string | undefined,
  u1: string | undefined,
  c2: string | undefined,
  n2: string,
  s2: string | undefined,
  u2: string | undefined,
): string {
  const symbol = c1 ?? c2;
  const names = symbol === undefined ? undefined : CURRENCIES[symbol];
  const currency = names !== undefined;
  const scale1 = rangeScale(s1, currency);
  const scale2 = rangeScale(s2, currency);
  // A letter that is a unit ("3-5m"), not a scale: the range is still said, the letter is left as written.
  if ((s1 !== undefined && scale1 === undefined) || (s2 !== undefined && scale2 === undefined)) {
    return whole.replace(
      /^.*?[-–—]\s?/,
      `${numberWords(n1.replace(/,/g, ''))}${s1 === undefined ? '' : ` ${s1}`} to `,
    );
  }
  const unit = (u1 ?? u2 ?? '').trim();
  const a = n1.replace(/,/g, '');
  const b = n2.replace(/,/g, '');
  if (
    symbol !== undefined &&
    scale1 === undefined &&
    scale2 === undefined &&
    (/\.\d\d$/.test(a) || /\.\d\d$/.test(b))
  ) {
    // Prices with cents: each said whole ("$5.99-$9.99").
    return `${money(symbol, a, undefined)} to ${money(symbol, b, undefined)}`;
  }
  if (!currency && unit === '' && scale1 === undefined && scale2 === undefined && isYear(a) && isYear(b)) {
    return `${yearWords(a)} to ${yearWords(b)}`;
  }
  const end = (n: string, scale: string | undefined) =>
    `${numberWords(n)}${scale === undefined ? '' : ` ${scale}`}`;
  const tail = names !== undefined ? ` ${names[1]}` : unit === '%' ? ' percent' : unit === '' ? '' : ' times';
  return `${end(a, scale1)} to ${end(b, scale2)}${tail}`;
}

/** Words before "555-1234" that make it a phone number even when it reads like a round range. */
const PHONE_CUE =
  /\b(?:call|calling|phone|tel|text|dial|fax|number|reach|ring|line|cell|mobile)\b[^.\d]{0,16}$/i;

/** Words a year follows ("in 2026", "since 2019"), so "2,026 users" and "2026 users" stay counts. */
const YEAR_CUE =
  /\b(?:in|since|by|from|until|till|through|of|during|before|after|around|early|late|mid|fall|spring|summer|winter|autumn|year|fiscal|class|January|February|March|April|May|June|July|August|September|October|November|December)\s+$/i;

/**
 * The spoken form of plain text for a vendor voice (see the file comment). Idempotent on its own output, and
 * never longer than it needs to be: text without digits, symbols or addresses comes back unchanged except for
 * spacing.
 */
export function speechText(plain: string): string {
  let text = plain;
  // Addresses are never read aloud: the caption shows them.
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+?(?=[.,;:!?)\]]*(?:\s|$))/gi, 'the link on screen');
  text = text.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, 'the email address on screen');
  text = text.replace(BARE_ADDRESS, 'the link on screen');
  // What is left of tables, code and lists.
  text = text.replace(/\s*\|\s*/g, ', ').replace(/[`•▪◦]/g, ' ');
  text = text.replace(/(^|\s)#(\d+)/g, '$1number $2').replace(/#/g, ' ');
  // Abbreviations and symbols said as words.
  text = text
    .replace(/\be\.g\.(?=\s|,|$)/gi, 'for example')
    .replace(/\bi\.e\.(?=\s|,|$)/gi, 'that is')
    .replace(/\betc\.(?=\s|,|$)/gi, 'et cetera')
    .replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\bw\/(?=\s)/gi, 'with')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*(?:->|→)\s*/g, ' to ')
    .replace(/[~≈]\s*(?=[$€£\d])/g, 'about ');
  // Dates and times.
  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y: string, m: string, d: string) => {
    const month = MONTHS[Number(m) - 1];
    const day = Number(d);
    return month === undefined || day < 1 || day > 31
      ? whole
      : `${month} ${ordinalWords(String(day))}, ${yearWords(y)}`;
  });
  text = text.replace(
    /\b(\d{1,2}):(\d{2})\s?([ap])(?:\.m(?=\.)|m\b)/gi,
    (_w, h: string, m: string, ap: string) =>
      `${integerWords(h)}${m === '00' ? '' : ` ${Number(m) < 10 ? `oh ${integerWords(m)}` : integerWords(m)}`} ${ap.toLowerCase() === 'a' ? 'a m' : 'p m'}`,
  );
  text = text.replace(/\b(\d{1,2}):(\d{2})\b/g, (_w, h: string, m: string) =>
    m === '00'
      ? `${integerWords(h)} o'clock`
      : `${integerWords(h)} ${Number(m) < 10 ? `oh ${integerWords(m)}` : integerWords(m)}`,
  );
  // Phone-like digit groups, digit by digit.
  text = text.replace(/(?<![\d.,])(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d])/g, (phone) =>
    phone.replace(/\D+/g, ' ').trim().split(' ').map(digitsAsWords).join(', '),
  );
  // A seven-digit phone number ("555-1234"), unless it reads as a round range ("100-1000") with no cue before it.
  text = text.replace(
    /(?<![\w.,$€£-])(\d{3})-(\d{4})(?![\d-])/g,
    (whole, a: string, b: string, offset: number, all: string) =>
      PHONE_CUE.test(all.slice(Math.max(0, offset - 30), offset)) || !(a.endsWith('0') && b.endsWith('0'))
        ? `${digitsAsWords(a)}, ${digitsAsWords(b)}`
        : whole,
  );
  // Versions ("2.0.1", "v1.10.2") and "24/7".
  text = text.replace(
    /(?<![\w.])(v)?(\d+(?:\.\d+){2,})(?![\w]|\.\d)/gi,
    (_w, v: string | undefined, version: string, offset: number, all: string) => {
      const said = version.split('.').map(integerWords).join(' point ');
      return v === undefined || /\bversion\s+$/i.test(all.slice(Math.max(0, offset - 10), offset))
        ? said
        : `version ${said}`;
    },
  );
  text = text.replace(/(?<![\d/])24\s?\/\s?7(?![\d/])/g, 'twenty-four seven');
  // Ranges, before money, percentages and multipliers, so what both ends share is said once.
  text = text.replace(
    RANGE,
    (
      whole: string,
      c1: string | undefined,
      n1: string,
      s1: string | undefined,
      u1: string | undefined,
      c2: string | undefined,
      n2: string,
      s2: string | undefined,
      u2: string | undefined,
    ) => rangeWords(whole, c1, n1, s1, u1, c2, n2, s2, u2),
  );
  // Money, with a scale ("$1.5M", "$20k", "$3 million").
  text = text.replace(
    /([$€£])\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|mm|mn|m|bn|b|tn|t|thousand|million|billion|trillion)\b)?/gi,
    (_w, symbol: string, amount: string, scale: string | undefined) => money(symbol, amount, scale),
  );
  // Percentages, multipliers, ranges, ordinals, scales, fractions.
  text = text.replace(
    /(\d[\d,]*(?:\.\d+)?)\s?%/g,
    (_w, n: string) => `${numberWords(n.replace(/,/g, ''))} percent`,
  );
  text = text.replace(/\b(\d+(?:\.\d+)?)\s?[x×](?=\W|$)/gi, (_w, n: string) => `${numberWords(n)} times`);
  text = text.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_w, n: string) => ordinalWords(n));
  text = text.replace(
    /\b(\d+(?:\.\d+)?)\s?(k|mm|mn|bn|tn)\b/gi,
    (_w, n: string, scale: string) => `${numberWords(n)} ${SCALE_WORDS[scale.toLowerCase()] ?? ''}`,
  );
  text = text.replace(
    /\b(\d+(?:\.\d+)?)([MB])\b/g,
    (_w, n: string, scale: string) => `${numberWords(n)} ${scale === 'M' ? 'million' : 'billion'}`,
  );
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (_w, a: string, b: string) => {
    const known = FRACTIONS[`${a}/${b}`];
    return known ?? `${integerWords(a)} out of ${integerWords(b)}`;
  });
  text = text.replace(
    /(\d[\d,]*(?:\.\d+)?)\s?[-–—]\s?(\d[\d,]*(?:\.\d+)?)(?=\D|$)/g,
    (_w, a: string, b: string) => `${a} to ${b}`,
  );
  text = text.replace(/(\d)\+(?=\s|$|[,.;:!?])/g, '$1 plus');
  // Years after a cue word, then every remaining number.
  text = text.replace(
    /\b(1[5-9]\d\d|20\d\d)\b(?![,.]?\d)/g,
    (year, _y: string, offset: number, all: string) =>
      YEAR_CUE.test(all.slice(Math.max(0, offset - 12), offset)) ? yearWords(year) : year,
  );
  text = text.replace(
    /(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,\p{L}])|(?<![\w.])-?\d+(?:\.\d+)?(?![\d\p{L}])/gu,
    (n) =>
      n.startsWith('-')
        ? `minus ${numberWords(n.slice(1).replace(/,/g, ''))}`
        : numberWords(n.replace(/,/g, '')),
  );
  // Slashes between words ("and/or"), leftover spacing.
  text = text.replace(/\band\/or\b/gi, 'and or').replace(/(\p{L})\/(?=\p{L})/gu, '$1 or ');
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim();
}
