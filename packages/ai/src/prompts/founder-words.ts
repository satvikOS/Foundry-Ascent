/**
 * The founder's own words as the vEIR says them back (an opener, a recall, a callback): what they meant, in
 * plain written English, never their chat shorthand or lower case echoed. The w6 integrator's list: an opener
 * said "Last time you planned to run five more interviews at the bus station this week fr" and "…call facilities
 * monday". So chat slang that adds nothing is dropped ("fr", "lol", "ngl", "tbh"), shorthand is spelt out ("u" →
 * "you", "gonna" → "going to", "tmrw" → "tomorrow") and the names of days and months get their capital
 * ("monday" → "Monday"; "may" and "march" only where they name the month: "in may" → "in May").
 *
 * Deterministic and conservative: only whole words are touched, nothing is invented, and a phrase without any of
 * these is returned unchanged.
 */

/** Chat slang that carries no meaning in a sentence said back: dropped. */
const FILLER_SLANG = [
  'fr',
  'frfr',
  'ngl',
  'tbh',
  'tbf',
  'lol',
  'lmao',
  'lmfao',
  'rofl',
  'imo',
  'imho',
  'btw',
  'idk',
  'smh',
  'fwiw',
  'iykyk',
  'istg',
  'lowkey',
  'highkey',
  'bruh',
  'pls',
  'plz',
];

/** Shorthand spelt out. */
const SHORTHAND: Readonly<Record<string, string>> = {
  u: 'you',
  ur: 'your',
  ya: 'you',
  gonna: 'going to',
  wanna: 'want to',
  gotta: 'have to',
  kinda: 'kind of',
  sorta: 'sort of',
  cuz: 'because',
  coz: 'because',
  tho: 'though',
  thru: 'through',
  rn: 'right now',
  tmrw: 'tomorrow',
  tmr: 'tomorrow',
  tmrow: 'tomorrow',
  '2day': 'today',
  '2moro': 'tomorrow',
  b4: 'before',
  wk: 'week',
  wks: 'weeks',
  mins: 'minutes',
  convo: 'conversation',
  convos: 'conversations',
  ppl: 'people',
  msg: 'message',
  thx: 'thanks',
  ty: 'thanks',
};

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = [
  'january',
  'february',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/** Months that are also everyday words: capitalised only after a word that makes them a date. */
const AMBIGUOUS_MONTHS = ['may', 'march'];
const DATE_LEAD = String.raw`(?:in|by|until|till|before|after|since|from|early|mid|late|end of|start of|of)`;

/** Whole words only: never inside a word, a contraction or an abbreviation ("U.S."). */
const WORD = (alternation: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}'’.])(?:${alternation})(?![\\p{L}\\p{N}'’]|\\.\\p{L})`, 'giu');

const FILLER_PATTERN = new RegExp(
  `(?:[\\s,]+)(?:${FILLER_SLANG.join('|')})(?![\\p{L}\\p{N}'’])|^(?:${FILLER_SLANG.join('|')})(?![\\p{L}\\p{N}'’])[\\s,]*`,
  'giu',
);
const SHORTHAND_PATTERN = WORD(
  Object.keys(SHORTHAND)
    .sort((a, b) => b.length - a.length)
    .join('|'),
);
const DAY_PATTERN = WORD(`${DAYS.join('|')}|${MONTHS.join('|')}`);
const AMBIGUOUS_PATTERN = new RegExp(
  `(?<![\\p{L}])(${DATE_LEAD}\\s+)(${AMBIGUOUS_MONTHS.join('|')})(?![\\p{L}'’])`,
  'giu',
);

function capitalised(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

/**
 * `text` (founder words, or a line built from them) with chat slang dropped, shorthand spelt out and day and month
 * names capitalised (see the module comment). Whitespace is tidied; the rest is unchanged.
 */
export function tidyFounderWords(text: string): string {
  if (text === '') return text;
  const out = text
    .replace(FILLER_PATTERN, '')
    .replace(SHORTHAND_PATTERN, (word: string) => {
      const spelt = SHORTHAND[word.toLowerCase()] ?? word;
      // "U" opening a sentence stays capitalised: "You…".
      return /^\p{Lu}/u.test(word) && word.length > 0 ? capitalised(spelt) : spelt;
    })
    .replace(DAY_PATTERN, capitalised)
    .replace(AMBIGUOUS_PATTERN, (_m, lead: string, month: string) => `${lead}${capitalised(month)}`)
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}
