import { isEverydayWord } from '../distill/deidentify.js';
import {
  inventedFigures,
  isKnownNumber,
  knownNumbersIn,
  numbersIn,
  spelledNumbersIn,
  withoutExampleFigures,
  withoutInventedFigures,
} from './figures.js';
import { isProtectedLine } from './social.js';
import { sharedCount, stemsOf } from './stems.js';
import { isBlockUnit, unitsOf, wordsIn } from './units.js';

/**
 * Whether what a reply states is in what it was given (owner, 2026-11-24: "zero hallucination, cited"). Deterministic,
 * per sentence, the same for a streamed unit and a whole reply:
 *
 * 1. a citation stays only when the source it names supports its sentence: enough of the sentence's content words, and
 *    every number, date, proper name and quoted phrase of it, are in that source, the founder's words, the path's
 *    decision or plain arithmetic on their numbers. Otherwise the marker goes (the sentence may still stand as advice);
 * 2. a sentence that states a figure, names a program, a person, a law, a work or a company's story, or gives a
 *    deadline, that none of those holds is neutralised (the clause, the example or the attribution that carries it goes)
 *    or, when nothing is left of it, removed.
 *
 * Advice with no such claim is never touched. Names inside a quoted draft ("Hi Dr Lee, …") are the founder's to change.
 */

export interface SupportSource {
  /** `E1`, `E2`, … */
  readonly key: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface SupportInput {
  /** The evidence shown to the model this turn. */
  readonly evidence: readonly SupportSource[];
  /** What the founder said and what is kept of it (their messages, notes, the venture's record). */
  readonly founderText: string;
  /** What the path gave this turn (`guidanceText`). */
  readonly guidanceText?: string;
  /** The sources the path's answer cites: its own words count as theirs (`ask.evidenceKeys`, and the answer and why). */
  readonly pathSources?: { readonly keys: readonly string[]; readonly text: string };
  /** Names the program itself uses (the persona, the venture, the doctrine's referrals, today's date). */
  readonly alsoKnown?: string;
  /** The founder asked for a number: a reasoned range is the answer (validators/figures.ts). */
  readonly askedNumber?: boolean;
}

export type SupportFinding =
  | 'citation_unsupported'
  | 'citation_unknown'
  | 'figure_unsupported'
  | 'program_unsupported'
  | 'person_unsupported'
  | 'law_unsupported'
  | 'work_unsupported'
  | 'story_unsupported'
  | 'deadline_unsupported';

interface SourceIndex {
  readonly stems: ReadonlySet<string>;
  readonly text: string;
}

/** What may be stated this turn, indexed once and read per sentence. */
export interface SupportIndex {
  readonly sources: ReadonlyMap<string, SourceIndex>;
  readonly known: string;
  readonly knownRaw: string;
  readonly knownNumbers: readonly number[];
  readonly knownStems: ReadonlySet<string>;
  readonly knownDates: ReadonlySet<string>;
  readonly words: ReadonlySet<string>;
  /** The numbers of the founder's words and the path's decision (what a citation may also lean on). */
  readonly ownNumbers: readonly number[];
  /** The numbers of the founder's words alone: what a product said without its operands may use. */
  readonly founderNumbers: readonly number[];
  readonly askedNumber: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)';
const MONTH_DAY = new RegExp(
  String.raw`\b(${MONTH})\.? (\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH})\b|\b\d{4}-(\d{2})-(\d{2})\b`,
  'gu',
);

/** Dates as month-day keys ("10-12"), however they are written. */
function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(MONTH_DAY)) {
    if (m[5] !== undefined && m[6] !== undefined) {
      out.add(`${String(Number(m[5]))}-${String(Number(m[6]))}`);
      continue;
    }
    const month = MONTHS.indexOf((m[1] ?? m[4] ?? '').slice(0, 3).toLowerCase());
    const day = Number(m[2] ?? m[3]);
    if (month >= 0 && day >= 1 && day <= 31) out.add(`${String(month + 1)}-${String(day)}`);
  }
  return out;
}

function flat(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%.'&()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const w = m[0].replace(/'s$/, '');
    out.add(w);
    if (w.includes('-')) for (const part of w.split('-')) out.add(part);
  }
  return out;
}

/** Indexes what may be stated this turn. */
export function buildSupportIndex(input: SupportInput): SupportIndex {
  const sources = new Map<string, SourceIndex>();
  for (const e of input.evidence) {
    const own = input.pathSources?.keys.includes(e.key) === true ? `\n${input.pathSources.text}` : '';
    const text = `${e.title}\n${e.excerpt}${own}`;
    sources.set(e.key.toUpperCase(), { stems: stemsOf(text), text });
  }
  const own = [input.founderText, input.guidanceText ?? '', input.alsoKnown ?? ''].join('\n');
  const all = [own, ...input.evidence.map((e) => `${e.title}\n${e.excerpt}`)].join('\n');
  return {
    sources,
    known: ` ${flat(all)} `,
    knownRaw: all,
    knownNumbers: knownNumbersIn(all),
    knownStems: stemsOf(all),
    knownDates: datesIn(all),
    words: wordSet(all),
    ownNumbers: knownNumbersIn(own),
    founderNumbers: knownNumbersIn(input.founderText),
    askedNumber: input.askedNumber === true,
  };
}

// Citations ---------------------------------------------------------------------------------------------------

const MARKER = /\s?\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\](?!\()/giu;

/** Text without its citation markers, list marker and emphasis. */
function bodyOf(unit: string): string {
  return unit
    .replace(MARKER, '')
    .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u, '')
    .replace(/^\s*#{1,6}\s+/u, '')
    .replace(/[*_]{1,2}/g, '')
    .trim();
}

/** How many content words of a sentence its source must share. */
function needed(size: number): number {
  if (size <= 2) return Math.min(1, size);
  if (size <= 5) return 2;
  return Math.max(3, Math.ceil(size * 0.3));
}

function overlaps(stems: ReadonlySet<string>, source: ReadonlySet<string>): boolean {
  return sharedCount(stems, source) >= needed(stems.size);
}

/** Numbers a sentence states: digits (never its list marker or a citation), and words above three ("twenty"). */
function statedNumbers(body: string): number[] {
  return [...numbersIn(body), ...spelledNumbersIn(body).filter((n) => n > 3)].filter(
    (n) => n > 3 || !Number.isInteger(n),
  );
}

/** Quoted phrases a sentence presents as said or written by its source: never a question or a line to send. */
function quotedIn(body: string): string[] {
  if (
    /\b(?:ask|say|send|write|text|email|message|tell|open with|try|reply|script|subject|call it)\b[^"“]*["“]/iu.test(
      body,
    )
  )
    return [];
  return [...body.matchAll(/["“]([^"”]{3,200})["”]/gu)]
    .map((m) => (m[1] ?? '').trim())
    .filter((q) => wordsIn(q) >= 2 && !/[?]$/.test(q));
}

/** Capitalised words mid-sentence that are no everyday word ("Carta", "Hartwell"). */
function properNames(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/(?<=[\p{L}\p{N},;:)'’-]\s)(\p{Lu}[\p{L}\p{N}'’-]+)/gu)) {
    const w = (m[1] ?? '').replace(/['’]s$/u, '');
    if (
      w.length < 2 ||
      isEverydayWord(w) ||
      isEverydayWord(w.toLowerCase()) ||
      new RegExp(`^${MONTH}$`, 'u').test(w)
    )
      continue;
    if (/^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/u.test(w) || w === 'I') continue;
    out.push(w);
  }
  return out;
}

/** Whether a number is one of `numbers` as given (no arithmetic). */
function given(value: number, numbers: readonly number[]): boolean {
  return numbers.some((n) => Math.abs(n - value) < Math.max(0.005, Math.abs(n) * 1e-6));
}

/** What a period of time carries a shown number over ("$80 a month, or $960 a year"). */
const PERIODS = [4, 7, 12, 30, 52, 365];

/**
 * Whether a number is arithmetic on the given numbers shown in the same text ("3 seats at $25 is $75", "12 of 30 is
 * 40%"): its operands must be there, so a figure that only happens to be some ratio of two notes is never read as theirs.
 */
function shownArithmetic(value: number, text: string, numbers: readonly number[]): boolean {
  const all = [...numbersIn(text), ...spelledNumbersIn(text), ...(/\bone\b/iu.test(text) ? [1] : [])].filter(
    (n) => !given(n, [value]),
  );
  const shown = [...new Set(all.filter((n) => given(n, numbers) || n <= 3))];
  // A result shown on the way counts ("that is $80 a month, or $960 a year").
  const steps = [...new Set(all.filter((n) => !shown.includes(n) && isKnownNumber(n, shown)))];
  const operands = [...shown, ...steps].slice(0, 12);
  return (
    operands.length > 0 &&
    (isKnownNumber(value, operands, false) ||
      isKnownNumber(value, operands, true) ||
      operands.some((n) => PERIODS.some((f) => Math.abs(n * f - value) <= Math.abs(value) * 0.011)))
  );
}

/** A product of two of the founder's own numbers, said without its operands ("that is $80 a month"). */
function founderArithmetic(value: number, index: SupportIndex): boolean {
  const own = index.founderNumbers.slice(0, 24).filter((n) => n > 1);
  return own.some((a, i) =>
    own.some((b, j) => i < j && Math.abs(a * b - value) <= Math.max(0.005, Math.abs(value) * 0.011)),
  );
}

/** Whether every number, date, name and quoted phrase of a cited sentence is in its sources, the founder's words or the path. */
function detailsSupported(body: string, cited: readonly SourceIndex[], index: SupportIndex): boolean {
  const text = cited.map((s) => s.text).join('\n');
  const numbers = [...knownNumbersIn(text), ...index.ownNumbers];
  const dates = datesIn(text);
  for (const d of datesIn(body)) if (!dates.has(d) && !index.knownDates.has(d)) return false;
  const withoutDates = body.replace(MONTH_DAY, ' ');
  if (
    !statedNumbers(withoutDates).every((n) => given(n, numbers) || shownArithmetic(n, withoutDates, numbers))
  )
    return false;
  const words = wordSet(text);
  for (const name of properNames(body)) {
    const w = name.toLowerCase();
    if (!words.has(w) && !index.words.has(w)) return false;
  }
  const source = ` ${flat(text)} `;
  return quotedIn(body).every((q) => {
    const phrase = flat(q).replace(/[.]+$/u, '');
    return source.includes(phrase) || index.known.includes(phrase);
  });
}

// Claims ------------------------------------------------------------------------------------------------------

interface Claim {
  readonly finding: SupportFinding;
  readonly start: number;
  readonly end: number;
}

const CAP = String.raw`\p{Lu}[\p{L}\p{N}&'’.-]*`;
const SEQ = String.raw`${CAP}(?:\s+(?:${CAP}|of|the|for|and|in|at))*`;

const LAW = new RegExp(
  [
    String.raw`\b${CAP}(?:[\s-]+(?:${CAP}|of|and|for|the))*\s+(?:Act|Amendment|Directive|Statute)\b(?:\s+of\s+\d{4})?`,
    String.raw`\bBayh[-–]Dole\b`,
    String.raw`(?:\bSection|\bSec\.|§+)\s*(?:\d{3,}[\w()-]*|\d+\([a-z]\)[\w()-]*)`,
    String.raw`\b\d+\s*(?:CFR|C\.F\.R\.|USC|U\.S\.C\.)(?:\s*(?:Part\s*)?\d+)?`,
    String.raw`\bTitle\s+(?:IX|VII|VI|IV|II|III|V|X)\b`,
    String.raw`\b(?:Regulation|Reg)\s+(?:CF|A\+?|D|S)\b`,
    String.raw`\bRule\s+\d{2,}\w*(?:\([a-z]\))?`,
    String.raw`\bForm\s+(?:D|[A-Z]-?\d+|\d{3,}\w*)\b`,
    String.raw`\b(?:83\(b\)|510\(k\)|501\(c\)\(\d\)|409A)(?![\w(])`,
    String.raw`\b(?:HIPAA|FERPA|GDPR|CCPA|COPPA|ERISA|TCPA|CAN-SPAM)\b`,
  ].join('|'),
  'gu',
);

const PROGRAM_KIND =
  'Program(?:me)?|Accelerator|Incubator|Fund|Grants?|Fellowship|Competition|Challenge|Prize|Award|Initiative|Institute|Center|Centre|Foundation|Summit|Bootcamp|Hackathon|Society|Association|Ventures|University|College|Hospital|Clinic|Agency|Administration|Commission|Council|Conference|Workshop';
const PROGRAM = new RegExp(
  [
    String.raw`\b(?:Y ?Combinator|YC|Techstars|TechStars|500 (?:Startups|Global)|Antler|MassChallenge|I-Corps|SBIR|STTR|Hult Prize|Thiel Fellowship|Kauffman|NSF|NIH|SBA|SBDC|SCORE|DARPA|Startup Weekend|Seedcamp|Entrepreneur First|Dorm Room Fund|Rough Draft Ventures|Venture for America|Plug and Play)\b(?:\s+(?:${PROGRAM_KIND}))?`,
    String.raw`\b${SEQ}\s+(?:${PROGRAM_KIND})\b`,
  ].join('|'),
  'gu',
);

const PERSON_NAME = String.raw`\p{Lu}\p{Ll}[\p{L}'’-]*(?:\s+(?:\p{Lu}\.|\p{Lu}\p{Ll}[\p{L}'’-]*)){1,2}`;
const PERSON = new RegExp(
  [
    String.raw`\b(?:Dr|Prof|Professor|Mr|Mrs|Ms|Mx|Dean|Senator|Judge)\.?\s+\p{Lu}\p{Ll}[\p{L}'’-]*(?:\s+\p{Lu}\p{Ll}[\p{L}'’-]*)?`,
    String.raw`\b${PERSON_NAME}(?=\s+(?:says|said|argues|argued|calls|called|recommends|recommended|wrote|writes|puts it|teaches|suggests|suggested|advises|described|describes|popularized|popularised|coined)\b)`,
    String.raw`\b${PERSON_NAME}(?=['’]s\s+(?:book|framework|rule|method|advice|work|research|model|principle|term|idea|test|The\b|["“*]))`,
    String.raw`(?<=\b(?:according to|author|authors|investor|professor|researcher|economist|CEO|founder)\s+)${PERSON_NAME}`,
    String.raw`(?<=\b(?:book|written|essay|article|framework|coined|developed|popularized|created) by\s)${PERSON_NAME}`,
  ].join('|'),
  'gu',
);

const WORK = new RegExp(
  [
    String.raw`\bThe (?:Mom Test|Lean Startup|Innovator['’]s (?:Dilemma|Solution)|Startup Owner['’]s Manual|Founder['’]s Dilemmas|Cold Start Problem|Art of Strategy|Four Steps to the Epiphany|Hard Thing About Hard Things)\b`,
    String.raw`\b(?:Competing Against Luck|Business Model Generation|Testing Business Ideas|Disciplined Entrepreneurship|Lean Analytics|Obviously Awesome|Crossing the Chasm|Venture Deals|High Growth Handbook|Zero to One|Good to Great|Blue Ocean Strategy|Running Lean|Lean Customer Development)\b`,
    String.raw`(?<=\b(?:book|article|paper|podcast|essay),?\s+(?:called\s+|titled\s+)?)["“*]+\p{Lu}[^"”*]{3,80}["”*]+`,
  ].join('|'),
  'gu',
);

/** A company's history told as fact ("Airbnb sold cereal boxes"): an example nobody gave. */
const STORY = new RegExp(
  String.raw`\b(?:Airbnb|Dropbox|Stripe|Uber|Lyft|Zappos|Facebook|Meta|Slack|Instagram|DoorDash|Tesla|Netflix|Amazon|Apple|Google|Microsoft|Spotify|Twitter|YouTube|PayPal|Figma|Notion|Duolingo|Shopify|Warby Parker|Canva|Zoom|Reddit|Pinterest|Snapchat|Theranos|Groupon|WeWork)(?:['’]s (?:founders|team|first|early))?\s+(?:\w+\s+){0,2}?(?:started|began|launched|sold|grew|raised|did|used|pivoted|charged|tested|spent|got|went|built|made|failed|won|lost|hit|reached|was|were|had|ran|found|famously|originally|initially|validated)\b`,
  'gu',
);

const DEADLINE_CUE =
  /\b(?:deadlines?|due date|applications? (?:close|open|are due|is due)|apply (?:by|before)|closes? (?:on|in)|opens? (?:on|in)|registration|submissions?|enrol(?:l)?ments?)\b/iu;
const DEADLINE_DATE = new RegExp(
  String.raw`\b${MONTH}\.?(?: \d{1,2}(?:st|nd|rd|th)?)?(?:,? \d{4})?\b|\b(?:Q[1-4]|mid-${MONTH})\b`,
  'gu',
);

const STATISTIC = new RegExp(
  String.raw`\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:out of|in every|of every) (?:\d+|two|three|four|five|six|seven|eight|nine|ten|twenty|hundred)\b|\b\d+(?:\.\d+)?x\b|\b\d+(?:\.\d+)? times (?:more|as|higher|likelier|faster|cheaper|better)\b`,
  'giu',
);

/** Words a name may hold that name nothing by themselves. */
const GENERIC = new Set(
  (
    'the a an your our their this that of for and in at on with technology tech transfer office university college campus student students business law ' +
    'legal clinic career center centre innovation entrepreneurship entrepreneur entrepreneurs residence eir program programme lead wellbeing support ' +
    'service services research compliance institutional review board irb library makerspace engineering small development health ' +
    'counseling counselling dean graduate undergraduate school venture ventures startup startups local state city county national ' +
    'federal patent trademark copyright community chamber commerce department foundation institute society association network fund ' +
    'grant grants award prize competition challenge pitch summit conference workshop series hospital agency commission council ' +
    'capital accelerator incubator fellowship initiative bootcamp hackathon club ask see talk visit email call book check try join apply ' +
    'first next if when then before after customer discovery session weekly free new other any every each some most'
  ).split(' '),
);

function nameKnown(name: string, index: SupportIndex): boolean {
  const phrase = flat(name);
  if (index.known.includes(` ${phrase} `)) return true;
  const words = [...wordSet(name)].filter((w) => !GENERIC.has(w) && w.length > 1);
  return words.length === 0 || words.every((w) => index.words.has(w));
}

/**
 * Whether a capitalised run before "Program", "Fund"… is a name: one word that is no everyday word, or two capitalised
 * words of its own ("Tiger Launch Accelerator"); never a sentence's first word ("Join Program…") or generic ones.
 */
function namesProgram(name: string, before: string): boolean {
  const all = name.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w));
  if (all.length === 1) return true; // a program the pattern lists by name
  const opens = /(?:^|[.!?:]\s|\n)[\s*_>\-\d.)]*$/u.test(before);
  const words = all
    .slice(0, -1)
    .filter((w, i) => !(i === 0 && opens && isEverydayWord(w)))
    .filter((w) => !GENERIC.has(w.toLowerCase().replace(/['’]s$/u, '')));
  return words.length >= 2 || words.some((w) => !isEverydayWord(w));
}

/** The spans of `text` inside double quotes: a draft's names are the founder's to change. */
function quotedSpans(text: string): (readonly [number, number])[] {
  return [...text.matchAll(/["“][^"”]*["”]/gu)].map((m) => [m.index, m.index + m[0].length] as const);
}

/** A figure to read on its own: money, a percentage, millions (the shapes validators/figures.ts reads). */
function figureSpans(
  text: string,
): { readonly start: number; readonly end: number; readonly text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  // Against nothing known, every figure is unsourced or proposed: their places in the text, in order.
  const none = inventedFigures(text, '');
  const all = new Set([...none.unsourced, ...none.proposed]);
  for (const figure of all) {
    let from = 0;
    for (let at = text.indexOf(figure, from); at >= 0; at = text.indexOf(figure, from)) {
      from = at + figure.length;
      if (/\d/.test(text.charAt(from)) || /\d/.test(text.charAt(at - 1))) continue;
      out.push({ start: at, end: from, text: figure });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The figures of a sentence that are neither given nor arithmetic on given numbers shown here or just before. */
function unsupportedFigures(
  text: string,
  before: string,
  index: SupportIndex,
): { readonly start: number; readonly end: number; readonly text: string }[] {
  const context = `${before.slice(-400)} ${text}`;
  return figureSpans(text).filter((f) => {
    const values = numbersIn(f.text);
    const percent = /%|percent|per cent/iu.test(f.text);
    // "100% sure", "$0": no figure anyone has to give.
    if (values.every((v) => v === 0 || (percent && v === 100))) return false;
    return !values.every(
      (v) =>
        given(v, index.knownNumbers) ||
        shownArithmetic(v, context, index.knownNumbers) ||
        (!percent && founderArithmetic(v, index)),
    );
  });
}

/** The claims of a sentence nothing given this turn supports. */
function unsupportedClaims(text: string, index: SupportIndex, before: string): Claim[] {
  const out: Claim[] = [];
  const quoted = quotedSpans(text);
  const inQuote = (at: number): boolean => quoted.some(([a, b]) => at > a && at < b);
  const names = (pattern: RegExp, finding: SupportFinding): void => {
    for (const m of text.matchAll(pattern)) {
      if (inQuote(m.index) || nameKnown(m[0], index)) continue;
      out.push({ finding, start: m.index, end: m.index + m[0].length });
    }
  };
  names(LAW, 'law_unsupported');
  for (const m of text.matchAll(PERSON)) {
    if (inQuote(m.index) || nameKnown(m[0], index)) continue;
    // "Customer Discovery teaches…": everyday words, capitalised, are no one's name.
    const titled = /^(?:Dr|Prof|Mr|Mrs|Ms|Mx|Senator|Judge)/u.test(m[0]);
    if (!titled && m[0].split(/\s+/).every((w) => isEverydayWord(w.replace(/['’]s$/u, '')))) continue;
    out.push({ finding: 'person_unsupported', start: m.index, end: m.index + m[0].length });
  }
  names(WORK, 'work_unsupported');
  for (const m of text.matchAll(PROGRAM)) {
    if (inQuote(m.index) || nameKnown(m[0], index) || !namesProgram(m[0], text.slice(0, m.index))) continue;
    out.push({ finding: 'program_unsupported', start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(STORY)) {
    const company = /^\S+/u.exec(m[0])?.[0] ?? '';
    if (index.words.has(company.replace(/['’]s$/u, '').toLowerCase())) continue;
    out.push({ finding: 'story_unsupported', start: m.index, end: m.index + m[0].length });
  }
  if (DEADLINE_CUE.test(text)) {
    for (const m of text.matchAll(DEADLINE_DATE)) {
      const dates = datesIn(m[0]);
      const known =
        dates.size > 0
          ? [...dates].every((d) => index.knownDates.has(d))
          : index.known.includes(` ${flat(m[0])} `) ||
            (/^May$/u.test(m[0]) && !/\b(?:in|by|until|on) May\b/u.test(text));
      if (!known) out.push({ finding: 'deadline_unsupported', start: m.index, end: m.index + m[0].length });
    }
  }
  if (!index.askedNumber) {
    for (const f of unsupportedFigures(text, before, index))
      out.push({ finding: 'figure_unsupported', start: f.start, end: f.end });
    for (const m of text.matchAll(STATISTIC)) {
      const values = [...numbersIn(m[0]), ...spelledNumbersIn(m[0])].filter((n) => n > 3);
      const said = index.known.includes(` ${flat(m[0])} `);
      const counted =
        /\b(?:of|in)\b/iu.test(m[0]) &&
        values.length > 1 &&
        values.every((n) => given(n, index.knownNumbers));
      if (!said && !counted)
        out.push({ finding: 'figure_unsupported', start: m.index, end: m.index + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const MIN_LEFT_WORDS = 3;

function capital(text: string): string {
  return text.replace(/^([\s*_"“(]*)(\p{Ll})/u, (_m, pre: string, c: string) => `${pre}${c.toUpperCase()}`);
}

/** `text` without the aside, example, attribution or clause that holds `claim`, or null when there is none to cut. */
function cutAround(text: string, claim: Claim): string | null {
  const end = /[.!?…]["'”’)\]*_]*\s*$/u.exec(text)?.[0] ?? '';
  const stop = end.trim() === '' ? '' : end.trim();
  const finish = (kept: string): string | null => {
    const clean = kept
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/[\s,;:—–-]+$/u, '')
      .trim();
    if (wordsIn(clean) < MIN_LEFT_WORDS) return null;
    return /[.!?…]["'”’)\]*_]*$/u.test(clean) || stop === '' ? clean : `${clean}${stop}`;
  };
  // "(such as Techstars)", "— $40 a month —".
  for (const m of text.matchAll(/\s?\([^()]*\)|\s[—–][^—–.!?]*[—–](?=\s)/gu)) {
    if (claim.start >= m.index && claim.end <= m.index + m[0].length)
      return finish(`${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`);
  }
  // "As Steve Blank says, …", "According to Dr Lee, …".
  const lead = /^\s*(?:as|according to|per|in|like)\s[^,]{2,80},\s+/iu.exec(text);
  if (lead !== null && claim.end <= lead[0].length) return finish(capital(text.slice(lead[0].length)));
  // "…, such as Techstars or Y Combinator."
  for (const m of text.matchAll(
    /,?\s+(?:such as|like|for example|for instance|e\.g\.|including|especially|starting with|maybe|say),?\s/giu,
  )) {
    if (m.index < claim.start && !/[.!?]\s/u.test(text.slice(m.index, claim.start))) {
      const cut = finish(text.slice(0, m.index));
      if (cut !== null) return cut;
    }
  }
  // "…, which the Bayh-Dole Act covers.", "… — Techstars does this.", "…; 70% of them churn."
  const clauses = [
    ...text.matchAll(
      /,\s+(?:which|because|since|as|and|but|so|while|where|who|with|plus|or)\b|\s[—–-]\s|;\s|:\s|\s+(?:because|since|under|per)\s/giu,
    ),
  ].reverse();
  for (const m of clauses) {
    if (m.index < claim.start && wordsIn(text.slice(0, m.index)) >= 5) {
      const cut = finish(text.slice(0, m.index));
      if (cut !== null) return cut;
    }
  }
  return null;
}

/** The sentence without an aside that only offers an unsupported figure as an example, or null when it has none. */
function withoutExample(text: string, index: SupportIndex): string | null {
  const out = withoutExampleFigures(text, index.knownRaw);
  return out.removed > 0 ? out.text : null;
}

/** The sentence with the unsupported figure said by its role ("offer a $10 card" → "offer a card"), or null. */
function withoutFigure(text: string, index: SupportIndex, before: string): string | null {
  const unsupported = new Set(unsupportedFigures(text, before, index).map((f) => f.text));
  const kept = figureSpans(text)
    .filter((f) => !unsupported.has(f.text))
    .map((f) => f.text)
    .join(' ');
  const out = withoutInventedFigures(text, kept);
  return out.removed > 0 ? out.text : null;
}

export interface UnitSupport {
  /** The unit as it may be shown; '' when nothing of it may. */
  readonly text: string;
  readonly findings: readonly SupportFinding[];
  /** Citation keys left out. */
  readonly keysDropped: number;
}

/**
 * One unit of a reply (a sentence, a list item), as it may be shown: see the module comment. `protect`: a unit the server
 * wrote (the path's answer or step), or a safety line, is only read for its citations.
 */
export function supportUnit(
  unit: string,
  index: SupportIndex,
  options: {
    readonly protect?: boolean;
    /** What the reply said before it (its operands may be there). */
    readonly before?: string;
  } = {},
): UnitSupport {
  const findings: SupportFinding[] = [];
  let keysDropped = 0;
  let text = unit;
  const keys = [...unit.matchAll(MARKER)].flatMap((m) =>
    (m[1] ?? '').split(/[,;]/).map((k) => k.trim().toUpperCase()),
  );

  if (options.protect !== true && !isProtectedLine(unit, true) && !/^\s*(?:```|\|)/.test(unit)) {
    const before = options.before ?? '';
    for (let round = 0; round < 5; round += 1) {
      const claims = unsupportedClaims(text, index, before);
      const claim = claims[0];
      if (claim === undefined) break;
      for (const c of claims) if (!findings.includes(c.finding)) findings.push(c.finding);
      const head = /^\s*(?:(?:[-*+•]|\d{1,3}[.)])\s+)?/u.exec(text)?.[0] ?? '';
      const rest = text.slice(head.length);
      const cut =
        (claim.finding === 'figure_unsupported' ? withoutExample(rest, index) : null) ??
        cutAround(rest, { ...claim, start: claim.start - head.length, end: claim.end - head.length }) ??
        (claim.finding === 'figure_unsupported' ? withoutFigure(rest, index, before) : null);
      text = cut === null || cut === rest ? '' : `${head}${cut}`;
      if (text === '') break;
    }
  }
  if (text.trim() === '') return { text: '', findings, keysDropped: keys.length };

  if (keys.length > 0) {
    const body = bodyOf(text);
    const stems = stemsOf(body);
    const cited = [...new Set(keys)].flatMap((k) => {
      const s = index.sources.get(k);
      return s === undefined ? [] : [{ key: k, source: s }];
    });
    const unknown = keys.length - keys.filter((k) => index.sources.has(k)).length;
    if (unknown > 0) findings.push('citation_unknown');
    const union = new Set(cited.flatMap((c) => [...c.source.stems]));
    const good = new Set(
      detailsSupported(
        body,
        cited.map((c) => c.source),
        index,
      )
        ? cited
            .filter(
              (c) =>
                overlaps(stems, c.source.stems) ||
                (cited.length > 1 && overlaps(stems, union) && sharedCount(stems, c.source.stems) >= 2),
            )
            .map((c) => c.key)
        : [],
    );
    const dropped = keys.filter((k) => !good.has(k)).length;
    if (dropped > 0) {
      if (cited.some((c) => !good.has(c.key))) findings.push('citation_unsupported');
      keysDropped += dropped;
      text = text.replace(MARKER, (whole, list: string) => {
        const kept = [...new Set(list.split(/[,;]/).map((k) => k.trim().toUpperCase()))].filter((k) =>
          good.has(k),
        );
        return kept.length === 0 ? '' : `${/^\s/.test(whole) ? ' ' : ''}[${kept.join(', ')}]`;
      });
    }
  }
  return { text, findings, keysDropped };
}

export interface CitationSupport {
  readonly text: string;
  readonly findings: readonly SupportFinding[];
  readonly citationsDropped: number;
  readonly sentencesRemoved: number;
  readonly sentencesNeutralised: number;
}

/** Every unit of a whole reply as it may be shown ({@link supportUnit}); a numbered list that lost an item is renumbered. */
export function checkCitationSupport(
  answer: string,
  index: SupportIndex,
  options: { readonly protect?: (unit: string) => boolean } = {},
): CitationSupport {
  const findings = new Set<SupportFinding>();
  let citationsDropped = 0;
  let sentencesRemoved = 0;
  let sentencesNeutralised = 0;
  let removedItem = false;
  const kept: string[] = [];
  for (const unit of unitsOf(answer)) {
    const out = supportUnit(unit.raw, index, {
      protect: options.protect?.(unit.raw) === true,
      before: kept.join('').slice(-400),
    });
    for (const f of out.findings) findings.add(f);
    citationsDropped += out.keysDropped;
    if (out.text === '') {
      sentencesRemoved += 1;
      if (isBlockUnit(unit.text)) removedItem = true;
      // What stood before it keeps its paragraph break.
      if (/\n\s*\n/.test(unit.raw) && kept.length > 0 && !/\n\s*$/.test(kept.at(-1) ?? '')) kept.push('\n\n');
      continue;
    }
    if (out.text.replace(MARKER, '') !== unit.raw.replace(MARKER, '')) sentencesNeutralised += 1;
    const space = /^\s*/.exec(unit.raw)?.[0] ?? '';
    const lead = /^\s*/.exec(out.text)?.[0] ?? '';
    kept.push(lead === '' ? `${space}${out.text}` : out.text);
  }
  let text = kept
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (removedItem) text = renumbered(text);
  return { text, findings: [...findings], citationsDropped, sentencesRemoved, sentencesNeutralised };
}

/** Numbered lists counted from their first number again. */
function renumbered(text: string): string {
  let n = 0;
  return text
    .split('\n')
    .map((l) => {
      const m = /^(\s*)(\d{1,3})([.)]\s)/.exec(l);
      if (m === null) {
        if (l.trim() !== '') n = 0;
        return l;
      }
      n += 1;
      return `${m[1] ?? ''}${String(n)}${m[3] ?? ''}${l.slice(m[0].length)}`;
    })
    .join('\n');
}
