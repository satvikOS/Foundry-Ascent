/**
 * Words as the path engine compares them: a message and the playbook's phrases normalised the same way (NFKC, lower
 * case, straight quotes, contractions written out, British and American spellings alike, plurals without their "s").
 * Pure and locale-free: the same text always gives the same words.
 */

/** Ends a sentence in a token list: no phrase matches across it. */
export const BREAK = '|';

const CONTRACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:can'?t|cannot)\b/g, 'can not'],
  [/\bwon'?t\b/g, 'will not'],
  [/\bshan't\b/g, 'shall not'],
  [/\b(do|does|did|is|are|was|were|has|have|had|would|should|could|must|need)n'?t\b/g, '$1 not'],
  [/\b(?:let'?s)\b/g, 'let us'],
  [/\b(?:i'm|im)\b/g, 'i am'],
  [/\b(i|you|we|they)'?ve\b/g, '$1 have'],
  [/\b(i|you|he|she|we|they)'ll\b/g, '$1 will'],
  [/\b(i|you|he|she|we|they)'d\b/g, '$1 would'],
  [/\b(you|we|they|who|what|how)'re\b/g, '$1 are'],
  [/\b(you|they)re\b/g, '$1 are'],
  [/\b(what|who|where|how|when|that|it|there|here|he|she)'s\b/g, '$1 is'],
  [/\bwhats\b/g, 'what is'],
  [/\bhows\b/g, 'how is'],
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
  [/\bgimme\b/g, 'give me'],
  [/\bpls\b|\bplz\b/g, 'please'],
  // As it is typed on a phone.
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/\brn\b/g, 'right now'],
  [/\b(?:idk|dunno)\b/g, 'i do not know'],
  [/\bdk\b/g, 'do not know'],
  [/\b(?:wut|wat|wht)\b/g, 'what'],
  [/\b(?:bc|cuz|coz|cos)\b/g, 'because'],
  [/\bppl\b/g, 'people'],
  [/\babt\b/g, 'about'],
  [/\bw\/ ?/g, 'with '],
  [/\b(?:lemme)\b/g, 'let me'],
  [/\bkinda\b/g, 'kind of'],
  [/\bsorta\b/g, 'sort of'],
  [/\bnxt\b/g, 'next'],
];

const ISE =
  /\b(organ|priorit|monet|commercial|formal|final|util|real|recogn|summar|custom|optim|minim|maxim|digit|special|general|initial|incentiv|capital)is(e|ed|es|ing|ation|er)\b/g;

/** One line of plain lower-case text: what the kind detectors read. Sentence ends stay as `.`, `?`, `!`. */
export function plain(text: string): string {
  let t = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-');
  for (const [pattern, replacement] of CONTRACTIONS) t = t.replace(pattern, replacement);
  return t
    .replace(/'s\b/g, '')
    .replace(ISE, '$1iz$2')
    .replace(/\b(\d{1,3})(?:,(\d{3}))+\b/g, (n) => n.replace(/,/g, ''))
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

/** A word without its plural ending ("labs" and "lab", "companies" and "company"); nothing else is stemmed. */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|ch|sh|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The words of `text` in order, with {@link BREAK} where a sentence ends. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const match of plain(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'&+-]*|[.?!;:\n]/gu)) {
    const raw = match[0];
    if (/^[.?!;:\n]$/.test(raw)) {
      if (out.length > 0 && out.at(-1) !== BREAK) out.push(BREAK);
      continue;
    }
    for (const part of raw.split(/[-+&']/)) if (part !== '') out.push(singular(part));
  }
  return out;
}

/** The sentences of `text`, normalised ({@link plain}), each with its closing mark. */
export function sentences(text: string): string[] {
  return plain(text)
    .split(/(?<=[.?!;])\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Words that carry no subject (articles, pronouns, auxiliaries, fillers), singular as {@link tokens} gives them. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    'a about after again all also am an and any are as at be because been before being but by can could did do does doing ' +
    'done for from get getting go going got had has have he her here hi him hi how i if in into is it just know let like ' +
    'make me more most much my need next no not now of off ok okay on one only or other our out over own please ' +
    'really right s same she should so some such than that the their them then there these they thi this those through to ' +
    'too up us use very want was wa we were what when where which while who whom why will with would yes yet you your ' +
    'hello hey thank help think thing way kind lot bit maybe actually basically currently today tomorrow yesterday week ' +
    'day month time good great new sure well still even ever never back down tell say said see look try give take put come'
  )
    .split(' ')
    .map(singular),
);

/** Words every founder uses about any venture: they say nothing about which venture it is. */
export const VENTURE_WORDS: ReadonlySet<string> = new Set(
  (
    'idea venture startup start business company companie app application platform service product tool software website ' +
    'site solution system project build building built create creating launch customer user client people person student ' +
    'founder cofounder team market marketing sell selling sale buy pay paid price pricing money cost revenue profit model ' +
    'plan step stage work working job find first develop offer agency consulting consultant technology tech online digital ' +
    'university campus college school class course engineer engineering degree problem need value test testing interview ' +
    'question answer advice feedback pitch deck investor funding fund grant competition money free better best different ' +
    'both between choose pick should organize organized structure side small big large early stage own offering'
  )
    .split(' ')
    .map(singular),
);

/** The distinct subject words of `text` (no function words, nothing shorter than 2), in order of appearance. */
export function contentStems(text: string): string[] {
  const seen = new Set<string>();
  for (const token of tokens(text)) {
    if (token === BREAK || token.length < 2 || FUNCTION_WORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/** The subject words that could tell one venture from another. */
export function subjectStems(text: string): string[] {
  return contentStems(text).filter((w) => w.length > 2 && !VENTURE_WORDS.has(w) && !/^\d+$/.test(w));
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
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
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** A word as a count ("12", "eight"); null when it is none. */
export function numberOf(word: string): number | null {
  if (/^\d{1,6}$/.test(word)) {
    const n = Number(word);
    return n >= 1900 && n <= 2100 ? null : n;
  }
  return NUMBER_WORDS[word] ?? null;
}

/** The numbers a text gives as counts (digits or words), without years, dates, money and percentages. */
export function countsIn(text: string): number[] {
  const out: number[] = [];
  const t = plain(text);
  for (const match of t.matchAll(/(?<![\p{L}\d$€£.-])(\d{1,6})(?![\d%]|\s?%|\.\d|-\d)(?:\b|(?=\p{L}))/gu)) {
    const n = Number(match[1]);
    if (n >= 1900 && n <= 2100) continue;
    out.push(n);
  }
  for (const match of t.matchAll(/\b[a-z]+\b/g)) {
    const n = NUMBER_WORDS[match[0]];
    if (n !== undefined) out.push(n);
  }
  return out;
}

const NOT_A_FACT =
  /\b(?:will|would|should|could|might|plan(?:s|ned|ning)? to|want(?:s|ed)? to|hop(?:e|es|ing) to|aim(?:s|ing)? to|goal|target|expect(?:s|ed)?|if|not|never|no one|nobody|unknown|have yet|to be|offer(?:ed|s)?)\b/;

/** A record's sentence that says something is so: no plan, wish, condition, offer or denial. */
export function statedAsFact(sentence: string): boolean {
  const s = plain(sentence);
  return !s.trim().endsWith('?') && !NOT_A_FACT.test(s);
}
