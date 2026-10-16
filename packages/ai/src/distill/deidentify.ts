import { COMMON_WORDS } from '../risk/common-words.js';
import { escapeRegExp, foldDiacritics, normalizeForMatching, normalizeText } from '../risk/normalize.js';

/**
 * Deterministic de-identification check for lesson candidates (blueprint 02 §9: lessons are generalised
 * and de-identified before an EIR or program lead reviews them). It errs on the side of dropping: a
 * lesson is rejected on any sign that it could identify a venture, a person, a customer or an
 * organisation. Reasons are codes, never the offending text.
 */
export interface LessonDeidentifyContext {
  /** Names of every venture in the tenant (this one included). */
  ventureNames: readonly string[];
  /** Display names of people: founders, team members, EIRs, program staff, customer contacts. */
  personNames: readonly string[];
  /** Canaries of every venture. */
  canaries: readonly string[];
  /** Other proper nouns that must never appear: customers, labs, sponsors, universities, places, products. */
  denylist?: readonly string[];
  /** Capitalised terms that are fine in a lesson (e.g. the persona's framework names, "Mom Test"). */
  allowedTerms?: readonly string[];
}

export type DeidentifyReason =
  | 'venture_name'
  | 'person_name'
  | 'canary'
  | 'denylisted'
  | 'email'
  | 'url'
  | 'number'
  | 'money'
  | 'date'
  | 'place'
  | 'proper_noun';

export interface DeidentifyResult {
  ok: boolean;
  reasons: DeidentifyReason[];
}

/** Tokens with digits that are generic vocabulary, not identifying figures. */
const GENERIC_DIGIT_TOKENS =
  /(?<![\p{L}\p{N}])(?:b2b2c|b2b|b2c|b2g|d2c|p2p|c2c|24\/7|1:1|1-on-1|one-on-one|2d|3d|4g|5g|co2|mp3|mp4)(?![\p{L}\p{N}])/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
const URL =
  /\bhttps?:\/\/|\bwww\.|(?<![@\p{L}\p{N}])[\p{L}\p{N}-]+\.(?:com|org|net|edu|gov|io|ai|co|app|dev|uk|us|ca|de|fr|eu|info|biz|me|ly|so|xyz|health|tech)(?![\p{L}\p{N}])/iu;
const MONEY =
  /[$€£¥₹]|(?<![\p{L}])(?:hundred|thousand|million|billion|trillion|percent|per cent|dollars?|euros?|pounds?|cents?|usd|eur|gbp)(?![\p{L}])/iu;
const MONTHS =
  /(?<![\p{L}])(?:January|February|March|April|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?![\p{L}])|(?<![\p{L}])(?:in|by|since|until|during|of|early|late|mid|end of) May(?![\p{L}])/u;
const ORDINAL_YEAR = /(?<![\p{L}\p{N}])(?:19|20)\d{2}(?![\p{L}\p{N}])/u;
/**
 * Counts written as words ("forty clinics", "a dozen pilots"). "One" and "two" stay: "one or two",
 * "the last one" and "two-sided" are generic.
 */
const CARDINAL_WORDS =
  /(?<![\p{L}])(?:three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|dozens?)(?![\p{L}])/iu;
/** Regions that locate a venture or its customers ("clinics in the northeast", "Bay Area buyers"). */
const REGION =
  /(?<![\p{L}])(?:(?:north|south)[- ]?(?:east|west)(?:ern)?|mid-?west(?:ern)?|(?:east|west|gulf|pacific|atlantic) coast|bay area|(?:rust|sun|corn|bible)[- ]?belt|up-?state|down-?state|tri-?state|panhandle|(?:in|across|from|throughout) the (?:north|south|east|west)(?![- ]?star))(?![\p{L}])/iu;

/** Acronyms and mixed-case terms that are generic startup vocabulary. */
const GENERIC_CAPITALISED = new Set(
  [
    'AI',
    'ML',
    'API',
    'APIs',
    'MVP',
    'MVPs',
    'LOI',
    'LOIs',
    'NDA',
    'NDAs',
    'IP',
    'IRB',
    'FDA',
    'CE',
    'ISO',
    'HIPAA',
    'GDPR',
    'CEO',
    'CTO',
    'CFO',
    'COO',
    'CMO',
    'VP',
    'HR',
    'PR',
    'UX',
    'UI',
    'QA',
    'KPI',
    'KPIs',
    'OKR',
    'OKRs',
    'CAC',
    'LTV',
    'ARR',
    'MRR',
    'TAM',
    'SAM',
    'SOM',
    'PMF',
    'GTM',
    'ROI',
    'SaaS',
    'SKU',
    'SKUs',
    'OEM',
    'OEMs',
    'ERP',
    'CRM',
    'EIR',
    'EIRs',
    'vEIR',
    'SBIR',
    'STTR',
    'TRL',
    'PoC',
    'POC',
    'FAQ',
    'SEO',
    'PDF',
    'SMS',
    'PhD',
    'MBA',
    'OK',
    'I',
  ].map((t) => t.toLowerCase()),
);

/**
 * Everyday words that open a lesson sentence and are not in `COMMON_WORDS` ("Rare but costly problems…",
 * "Prospects praised…", "Scope the first claim…"): lesson verbs, adverbs and nouns. A capitalised word
 * at a sentence start is a proper noun unless it is one of these, a common or method word, a word the
 * lesson also uses in lower case, or an inflection of one ("Interviewees", "Rewrite").
 */
const SENTENCE_STARTERS = new Set(
  `abstract academic accordingly additionally adoption afterwards align allocate alternatively although
ambitious analyse analyze anchor anybody articulate asking assess assume audit avoid besides beyond
broader budget buyer calculate capture champion cheaper churn clarify clearer cohort collect commit
communicate compete conduct confront connect consequently constraint contrast costly craft crucially
debrief deeper define delegate demonstrate describe despite determine document drop earlier earn engage
engineer ensure enterprise enthusiastic especially establish estimate evaluate eventually examine
expensive explain explore faster filter formalise formalize fortunately frame frequent frequently gather
generally generic gradually guard handle hardware hence honest identify importantly incumbent initially
institutional interestingly invest invite involve isolate iterate justify label likewise limit listen
lock lower map meanwhile mention milestone mixed momentum mostly narrow negotiate nevertheless nobody
nonetheless notably notice novice objection observe occasionally operator otherwise outline overall
ownership partly polite practise prepare prioritise prioritize probe procurement prospect protect
prototype prove publish qualify quantify rank rare rarely recent recognise recognize recruit reflect
reframe regardless regulated regulator reject relax rely remember repeat request require researcher
resist respond retention revisit schedule scope screen separate shift ship shorten signal similarly
simplify skip slowly smaller solve specific specifically split stakeholder stay steer stress structure
summarise summarize surprisingly survey swap tailor teach technical therefore thus tie timeline
tomorrow traction treat trim typically ultimately uncertainty underline unfortunately unless unlike unpaid
update urgency vague validate verify via weak weigh whenever whereas whose widen workaround
yesterday`.split(/\s+/),
);

const INFLECTIONS = ['ees', 'ers', 'ings', 'ments', 'ness', 'es', 'ed', 'ing', 'ly', 'er', 's', 'd'];

/** A lower-case word, or the word it is inflected or prefixed from, is everyday vocabulary. */
function everyday(word: string, extra: ReadonlySet<string>): boolean {
  const known = (w: string): boolean =>
    COMMON_WORDS.has(w) ||
    SENTENCE_STARTERS.has(w) ||
    GENERIC_METHOD_WORDS.has(w) ||
    GENERIC_CAPITALISED.has(w) ||
    extra.has(w);
  if (known(word)) return true;
  const bases = [
    word.replace(/ies$/, 'y'),
    word.replace(/ied$/, 'y'),
    ...INFLECTIONS.filter((suffix) => word.endsWith(suffix)).map((suffix) => word.slice(0, -suffix.length)),
    word.replace(/^(?:re|un|pre|co|over|under|mis)/, ''),
  ];
  return bases.some((b) => b !== word && b.length >= 3 && known(b));
}

/** Words of well-known, generic methods that are often capitalised. */
const GENERIC_METHOD_WORDS = new Set([
  'mom',
  'test',
  'lean',
  'canvas',
  'startup',
  'jobs',
  'done',
  'wizard',
  'oz',
  'pirate',
  'metrics',
  'north',
  'star',
  'proposition',
  'value',
  'model',
  'business',
  'customer',
  'development',
  'discovery',
  'design',
  'thinking',
  'minimum',
  'viable',
  'product',
  'persona',
  'personas',
  'pareto',
  'socratic',
  'kanban',
  'scrum',
  'agile',
  'gantt',
  'fermi',
  'net',
  'promoter',
  'score',
]);

function wordsOf(value: string): string[] {
  return foldDiacritics(normalizeForMatching(value))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

function phrasePattern(phrase: string): RegExp | null {
  const words = wordsOf(phrase);
  if (words.join('').length < 3) return null;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
}

/** The full name and each of its distinctive words (3+ letters, not a common word). */
function namePatterns(names: readonly string[], minWordLength: number): RegExp[] {
  const out: RegExp[] = [];
  for (const name of names) {
    const full = phrasePattern(name);
    if (full) out.push(full);
    const words = wordsOf(name);
    if (words.length < 2) continue;
    for (const word of words) {
      if (word.length < minWordLength || COMMON_WORDS.has(word)) continue;
      const pattern = phrasePattern(word);
      if (pattern) out.push(pattern);
    }
  }
  return out;
}

/** Whether `index` starts a sentence (start of text, after . ! ? : ; or a line break, past quotes). */
function atSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/["'“‘([\s]+$/u, '');
  return before === '' || /[.!?:;\n]$/.test(before);
}

/**
 * Capitalised words that are not generic: likely proper nouns. At a sentence start a capital proves
 * nothing, so there the word must not be everyday vocabulary ("Stanford asked…", "Boston buyers…").
 */
function hasProperNoun(text: string, allowed: ReadonlySet<string>, titleCase: boolean): boolean {
  // Hyphenated parts are separate words ("Follow-Up", "Abernathy-Song"); contractions are folded ("I'd",
  // "Don't").
  for (const m of text.matchAll(/[\p{L}][\p{L}\p{M}'’.]*/gu)) {
    if (/^\p{L}+n['’]t$/iu.test(m[0])) continue;
    const token = m[0].replace(/['’](?:s|d|m|ll|re|ve|t)$/iu, '').replace(/[.'’]+$/, '');
    if (token === '' || !/\p{Lu}/u.test(token)) continue;
    const lower = foldDiacritics(token.toLowerCase());
    const isAcronymLike = /\p{Lu}.*\p{Lu}/u.test(token) || /^\p{Ll}+\p{Lu}/u.test(token);
    if (isAcronymLike) {
      // ALL-CAPS and mixed-case tokens ("UCLA", "iPhone") identify unless they are generic vocabulary.
      if (!GENERIC_CAPITALISED.has(lower) && !allowed.has(lower)) return true;
      continue;
    }
    if (titleCase) continue; // in a Title Case title every word is capitalised
    if (atSentenceStart(text, m.index)) {
      if (everyday(lower, allowed)) continue;
      return true;
    }
    if (
      GENERIC_CAPITALISED.has(lower) ||
      COMMON_WORDS.has(lower) ||
      GENERIC_METHOD_WORDS.has(lower) ||
      allowed.has(lower)
    )
      continue;
    return true;
  }
  return false;
}

function isTitleCase(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length < 2) return false;
  const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length;
  return capitalised / words.length > 0.6;
}

/**
 * Checks the fields of one lesson. `fields[0]` may be a title (Title Case allowed); every other field is
 * prose. Returns every reason found; `ok` only when there is none.
 */
export function checkDeidentified(
  fields: readonly string[],
  ctx: LessonDeidentifyContext,
  options: { titleIndex?: number } = {},
): DeidentifyResult {
  const reasons = new Set<DeidentifyReason>();
  const ventures = namePatterns(ctx.ventureNames, 4);
  const people = namePatterns(ctx.personNames, 3);
  const denied = namePatterns(ctx.denylist ?? [], 4);
  const allowed = new Set(
    (ctx.allowedTerms ?? []).flatMap((term) => wordsOf(term)).filter((w) => w.length >= 2),
  );
  const canaries = ctx.canaries.map(normalizeForMatching).filter((c) => c.length >= 4);
  // A word the lesson also writes in lower case is vocabulary, not a name ("Pricing … the pricing").
  const everydayTerms = new Set([
    ...allowed,
    ...fields.flatMap((f) =>
      (normalizeText(f).match(/(?<![\p{L}])\p{Ll}+(?![\p{L}])/gu) ?? []).map(foldDiacritics),
    ),
  ]);

  fields.forEach((raw, i) => {
    const text = normalizeText(raw);
    const lower = normalizeForMatching(text);
    const folded = foldDiacritics(lower);
    if (ventures.some((re) => re.test(folded))) reasons.add('venture_name');
    if (people.some((re) => re.test(folded))) reasons.add('person_name');
    if (denied.some((re) => re.test(folded))) reasons.add('denylisted');
    const compact = lower.replace(/\s+/g, '');
    if (canaries.some((c) => lower.includes(c) || compact.includes(c.replace(/\s+/g, ''))))
      reasons.add('canary');
    if (EMAIL.test(text)) reasons.add('email');
    if (URL.test(text)) reasons.add('url');
    const withoutGeneric = text.replace(GENERIC_DIGIT_TOKENS, ' ');
    if (ORDINAL_YEAR.test(withoutGeneric) || MONTHS.test(text)) reasons.add('date');
    if (/\p{Nd}/u.test(withoutGeneric) || CARDINAL_WORDS.test(text)) reasons.add('number');
    if (REGION.test(text)) reasons.add('place');
    if (MONEY.test(text)) reasons.add('money');
    const titleCase = i === options.titleIndex && isTitleCase(text);
    if (hasProperNoun(withoutGeneric, everydayTerms, titleCase)) reasons.add('proper_noun');
  });
  return { ok: reasons.size === 0, reasons: [...reasons].sort() };
}
