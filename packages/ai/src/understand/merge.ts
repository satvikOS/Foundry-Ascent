export { inputOf } from './merge-inputs.js';
import { inputOf } from './merge-inputs.js';
import type {
  JudgeReading,
  RawSum,
  RawUnderstanding,
  RouteReading,
  SumsReading,
  UnderstandReadings,
} from './schema.js';
import { decidedBy, secondQuestion, tellsUpdate, verdictStands } from './told.js';
import { UNDERSTOOD_KINDS, type SumUnit, type UnderstoodKind } from './types.js';

/**
 * The parts of a reading as one. Each is used as far as it came: a missing part leaves its fields empty, and without ROUTE
 * the others say what the message is (a figure they asked for, an option picked, a result read). Pure; nothing is checked
 * here (`readUnderstanding`).
 */

const NONE = /^(?:null|none|n\/a|nothing|no|-)?[.!]?$/iu;
const text = (value: string | null | undefined): string | null => {
  const said = (value ?? '').trim();
  return NONE.test(said) ? null : said;
};
const kindOf = (value: string): UnderstoodKind | null =>
  UNDERSTOOD_KINDS.find((k) => k === value.trim().toLowerCase()) ?? null;

/** The message asks for a figure by a word of its own. */
const FIGURE_ASKED =
  /\b(?:how (?:much|many|long|often|far|soon)|per (?:hour|day|week|month|year|cent|person|unit)|an hour|worth|left|keep|earn|profit|margin|break ?even|(?:making|make|losing|lose) (?:any )?money|percent|percentage|number|figure|adds? up|comes? (?:in|to)|runs? out|paid|costs?|total|average|payback|hit rate|accura(?:te|cy)|success rate)\b/iu;
/** Something is asked, marked or not. */
const QUESTION_PUT =
  /\?|\b(?:how|what|whats|when|which|am i|are we|do i|do we|did i|did we|is it|is that|does it|will i|can i|tell me|work out|calculate)\b/iu;
/** They put options side by side. */
const OPTIONS_PUT =
  /\b(?:or|vs|versus|which|either|between|one of|both|pick|choose|rather|instead|should (?:i|we)|shld (?:i|we))\b/iu;
/**
 * Whether the figure SUMS names is asked for: ROUTE reads the message as a sum, or the message asks for a figure in its own
 * words. Without ROUTE, SUMS's own word stands where the message asks something, and never where it asks for a step.
 */
const asks = (
  figure: string | null,
  route: boolean,
  kinds: readonly UnderstoodKind[],
  message: string,
): boolean =>
  figure !== null &&
  (route
    ? kinds.includes('sum') ||
      (FIGURE_ASKED.test(message) && QUESTION_PUT.test(message) && !ASKS_A_STEP.test(message))
    : // Without ROUTE, SUMS's word stands for a question, never for one that asks for a step ("what's next?").
      QUESTION_PUT.test(message) && !ASKS_A_STEP.test(message));

/** The play that says nothing of other founders: a message it answers asks about one. */
const PRIVACY_PLAY = 'other-teams-privacy';

/** The parts as one reading; null when what came says nothing that can stand alone. */
export function mergeReadings(
  readings: UnderstandReadings,
  shown: {
    readonly message: string;
    readonly keys: ReadonlySet<string>;
    /** What the founder said before, oldest first. */
    readonly earlier?: readonly string[];
  },
): RawUnderstanding | null {
  const route = readings.route ?? null;
  const sums = readings.sums ?? null;
  const judge = readings.judge ?? null;
  const { message } = shown;
  const kinds = (route?.k ?? []).flatMap((k) => kindOf(k) ?? []).filter((k, i, all) => all.indexOf(k) === i);
  const figure = text(sums?.q);
  const asked = asks(figure, route !== null, kinds, message);
  const reads = sums === null ? [] : sums.s.map((s) => sumOf(s, text(sums.w) ?? ''));
  // The figure is asked for where the call says so or the message's own words do.
  const put = asked || (figure !== null && asksForFigure(message));
  // A count of other things than the message asks for ("tins" where it asks how many studios) is not its figure.
  const wanted = countAsked(message);
  const worked = reads.flatMap((r) =>
    r === 'lacks' ? [] : [{ ...r, asked: put && (wanted === null || !countsOther(wanted, r)) }],
  );
  const lacks = put && reads.includes('lacks') ? LACKS_REST : null;
  const missing = put ? (text(sums?.m) ?? (worked.length === 0 ? lacks : null)) : null;
  const choice = judge?.o != null && (kinds.includes('choice') || OPTIONS_PUT.test(message)) ? judge.o : null;
  const pushed = kinds.includes('pushback');
  const result =
    judge?.t != null &&
    (pushed ||
      verdictStands(message, shown.earlier ?? [], kinds.includes('result') || kinds.includes('update')))
      ? judge.t
      : null;
  const found: UnderstoodKind[] = [
    ...(put && (worked.some((x) => x.asked) || missing !== null) ? (['sum'] as const) : []),
    ...(choice === null ? [] : (['choice'] as const)),
    ...(result === null || pushed ? [] : (['result'] as const)),
    ...(tellsUpdate(message) ? (['update'] as const) : []),
    ...(route?.p?.trim().toLowerCase() === PRIVACY_PLAY ? (['privacy'] as const) : []),
  ];
  const kind = kinds[0] ?? (route === null ? found[0] : 'question');
  if (kind === undefined) return null;
  const also = [...found, ...kinds].filter((k, i, all) => k !== kind && all.indexOf(k) === i).slice(0, 2);
  const ask = text(route?.a) ?? askOf(figure, asked, choice, route === null ? null : message);
  const decides = decidedBy(message);
  const read = route?.f ?? null;
  return {
    ask,
    second_ask: text(route?.b) ?? (route === null ? null : secondQuestion(message, ask)),
    kind,
    also,
    record: route?.r ?? [],
    contradicts: contradictionOf(route, judge, shown.keys),
    inputs: (sums?.n ?? []).flatMap((n) => inputOf(n) ?? []),
    sums: worked,
    missing,
    choice:
      choice === null
        ? null
        : { options: choice.o, pick: choice.p, because: choice.b, flips_if: text(choice.f) },
    result:
      result === null
        ? null
        : { verdict: result.v, shows: result.s, does_not_show: text(result.n), settles: text(result.e) },
    // Named beside a feeling or a grant's rules, and wherever the words leave no doubt of it.
    referral: read === null || read === 'wellbeing' || read === 'grants' ? (decides ?? read) : read,
    play: text(route?.p),
    step_play: text(route?.s),
    sure: route?.h === true ? 'high' : 'low',
    points: judge?.g ?? [],
    // Nothing asks for these: kept for what reads them (types.ts).
    first_action: null,
    avoid: null,
  };
}

/** What they ask, where the part that says it did not come. */
function askOf(
  figure: string | null,
  asked: boolean,
  choice: JudgeReading['o'],
  /** Their own words, where ROUTE came and found nothing asked. */
  message: string | null,
): string {
  if (asked && figure !== null) return figure;
  if (choice !== null) return `which to choose: ${choice.o.join(' or ')}`;
  return message === null
    ? 'what happened and what it shows'
    : message
        .split(/\s+/u)
        .filter((w) => w !== '')
        .slice(0, 16)
        .join(' ');
}

/** Both name the same line, each for itself; what it takes beyond that is the checks' (`conflictDrop`). */
function contradictionOf(
  route: RouteReading | null,
  judge: JudgeReading | null,
  keys: ReadonlySet<string>,
): RawUnderstanding['contradicts'] {
  const key = (value: string | null | undefined): string | null =>
    [...(value ?? '').toUpperCase().matchAll(/R\d{1,3}/gu)].map((m) => m[0]).find((k) => keys.has(k)) ?? null;
  const record = key(judge?.x?.r);
  const why = text(judge?.x?.w);
  const claim = text(judge?.x?.q);
  if (record === null || why === null || claim === null || record !== key(route?.c)) return null;
  return { record, claim, why };
}

const TIME_UNITS: readonly (readonly [RegExp, SumUnit])[] = [
  [/^(?:mins?|minutes?)\b/iu, 'minutes'],
  [/^(?:hrs?|hours?)\b/iu, 'hours'],
  [/^days?\b/iu, 'days'],
  [/^weeks?\b/iu, 'weeks'],
  [/^months?\b/iu, 'months'],
  [/^years?\b/iu, 'years'],
];
const PEOPLE =
  /\b(?:people|persons?|customers?|users?|students?|buyers?|famil(?:y|ies)|members?|visitors?|guests?|clients?|subscribers?|strangers?|parents?|teachers?)$/iu;

const COUNT_ASKED = [
  /\bhow many ([a-z][a-z'-]{2,20})\b/iu,
  /\bnumber of ([a-z][a-z'-]{2,20})\b/iu,
  /\b([a-z][a-z'-]{2,20}) (?:are |is )?(?:needed|required|(?:do )?(?:we|i) (?:need|have to (?:get|sign|sell|find)))\b/iu,
];
/** Words that stand after "how many" and count nothing. */
const NO_NOUN =
  /^(?:more|less|fewer|of|do|does|did|would|will|are|is|was|can|could|should|have|has|times?|must|we|i|you|they|the|a|an|those|these|them|people|this|thus|plus|yes|its|his|hers|ours|yours|theirs|always|perhaps|sometimes)$/iu;
const TIME_WORD = /^(?:minutes?|hours?|hrs?|days?|nights?|weeks?|months?|years?|shifts?)$/iu;
/** What a message asks to count ("how many studios", "studios we need"); null: no count, or of time. */
export function countAsked(message: string): string | null {
  for (const pattern of COUNT_ASKED) {
    const word = pattern.exec(message)?.[1]?.toLowerCase();
    // A plural noun: "how many leave" counts people who do something, and asks nothing of what is counted.
    if (word !== undefined && word.endsWith('s') && !NO_NOUN.test(word) && !TIME_WORD.test(word)) return word;
  }
  return null;
}
const stem = (word: string): string =>
  word
    .toLowerCase()
    .replace(/ies$/u, 'y')
    .replace(/(?:ches|shes|sses|xes)$/u, (m) => m.slice(0, -2))
    .replace(/s$/u, '');
/** A count of another thing than the one asked for: never so for money, shares, times or people asked as people. */
export function countsOther(
  wanted: string,
  sum: { readonly unit: SumUnit; readonly noun: string | null },
): boolean {
  if (sum.unit === 'people') return !PEOPLE.test(wanted);
  if (sum.unit !== 'units' || sum.noun === null) return false;
  const last = sum.noun.split(/\s+/u).at(-1) ?? '';
  return stem(last) !== stem(wanted);
}

/** A unit as a sum is said in: `$`, `%`, a time, or what is counted. */
export function unitOf(said: string): { readonly unit: SumUnit; readonly noun: string | null } {
  const u = said.trim().toLowerCase();
  if (/^(?:\$|usd\b|us\$|dollars?\b|money\b)/u.test(u)) return { unit: '$', noun: null };
  if (/^(?:%|percent|per cent)/u.test(u)) return { unit: '%', noun: null };
  if (/^(?:x|times)$/u.test(u)) return { unit: 'x', noun: null };
  const time = TIME_UNITS.find(([pattern]) => pattern.test(u))?.[1];
  if (time !== undefined) return { unit: time, noun: null };
  if (/^(?:people|persons?)$/u.test(u)) return { unit: 'people', noun: null };
  if (u === '' || /^(?:units?|count|number|items?)$/u.test(u)) return { unit: 'units', noun: null };
  const noun = u.replace(/\s*(?:\/|\b(?:per|an?|each|every) ).*$/u, '');
  return { unit: PEOPLE.test(noun) ? 'people' : 'units', noun: noun === '' ? null : noun };
}

/** Asking for a figure, as people write it. */
/**
 * A figure asked for in the message's own words, as people write them: "how much", "hw many", "what does that make", "what am
 * I into it for", "whats the total". "What's" alone is no figure: "what's next" asks for a step.
 */
const ASK_FORM =
  /\b(?:how (?:much|many|long|often|far|soon|mu?ch)|hw (?:much|many|long)|howmuch|howmany|wh?at(?:['’]?s|s| is| are| was| were) (?:(?:the|my|our|your|it|that|this|a|an|all|in|for|of|per|each|one|we|i|left) ){0,4}(?:total|sum|cost|costs|price|prices|margin|profit|hourly|hour|rate|share|number|figure|split|worth|average|runway|mine|ours|month|week|year|come|comes|coming|\$?\d)\b|wh?at(?:['’]?s|s| is) left\b(?! (?:to|for (?:me|us) to))|wh?at (?:does|do|did|would|will|am) (?:i|we|you|they|it|that|this|us|the \w+)(?: \w+){0,2} (?:make|makes|earn|keep|charge|ask|get|clear|pocket|bring|land|leave|cost|pay|need|spend|come|owe|put|into|left)\b|wh?at (?:does|do) (?:that|it|this) say\b)/iu;
/** Words that ask for a figure only where nothing else is asked: "so far", "all in". */
const ASK_SUM_UP = /\b(?:so far|all in|in total|altogether|adds? up|add (?:it|them) up|work (?:it )?out)\b/iu;
/** A step, a plan or advice asked for: then "so far" is no figure. */
const ASKS_A_STEP =
  /\b(?:wh?at(?:['’]?s|s| is)? (?:next|now|new|the plan|the next|left to do)|what (?:should|shall|do|can|could) (?:i|we) (?:do|try|start)|where do (?:i|we) (?:start|go)|now what)\b/iu;
const asksForFigure = (message: string): boolean =>
  ASK_FORM.test(message) || (ASK_SUM_UP.test(message) && !ASKS_A_STEP.test(message));
/** A plan that takes something off: a sum of one number of theirs then lacks the rest. */
const COMES_OFF = /\b(?:minus|less|after|once|without|net of|take away|takes? off|subtract\w*)\b|\s[-−]\s/iu;
const LACKS_REST = 'the other numbers it needs';

/** One sum of SUMS; `lacks`: one number of theirs where the plan takes something off it ("price", the sitter left out). */
function sumOf(s: SumsReading['s'][number], plan: string): RawSum | 'lacks' {
  // A bracket or quote left over at its end is the answer's syntax, not the sum's.
  const expr = s.e.replace(/[\s}\]"'`]+$/u, '');
  if (/^[a-z_][a-z0-9_]*$/iu.test(expr) && COMES_OFF.test(plan)) return 'lacks';
  return { label: s.l, ...unitOf(s.u), expr, round: 'none', asked: false };
}
