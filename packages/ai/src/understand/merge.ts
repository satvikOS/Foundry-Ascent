import { figuresIn, saidAmounts } from './figures.js';
import type {
  JudgeReading,
  RawInput,
  RawSum,
  RawUnderstanding,
  RouteReading,
  SumsReading,
  UnderstandReadings,
} from './schema.js';
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
  /\b(?:how (?:much|many|long|often|far|soon)|per (?:hour|day|week|month|year|cent|person|unit)|an hour|worth|left|keep|earn|profit|margin|break ?even|(?:making|make|losing|lose) (?:any )?money|percent|percentage|number|figure|adds? up|comes? (?:in|to)|runs? out|paid|costs?|total|average|payback)\b/iu;
/** They put options side by side. */
const OPTIONS_PUT =
  /\b(?:or|vs|versus|which|either|between|one of|both|pick|choose|rather|instead|should (?:i|we)|shld (?:i|we))\b/iu;
/** Something happened, and they tell it. */
const TELLS =
  /\b(?:said|says|told|asked|sold|bought|got|did|tried|had|lost|showed|paid|emailed|wrote|left|quit|offered|ran|met|talked|spoke|came|signed|refused|agreed|called|phoned|booked|returned|went|gave|sent|heard|launched|interviewed|happened|dropped|joined|cancel+ed|replied|answered|changed|stopped|started|tested|used|moved|won|failed)\b/iu;

const asks = (
  figure: string | null,
  route: boolean,
  kinds: readonly UnderstoodKind[],
  message: string,
): boolean => figure !== null && (!route || kinds.includes('sum') || FIGURE_ASKED.test(message));

/** The play that says nothing of other founders: a message it answers asks about one. */
const PRIVACY_PLAY = 'other-teams-privacy';

/** The parts as one reading; null when what came says nothing that can stand alone. */
export function mergeReadings(
  readings: UnderstandReadings,
  shown: { readonly message: string; readonly keys: ReadonlySet<string> },
): RawUnderstanding | null {
  const route = readings.route ?? null;
  const sums = readings.sums ?? null;
  const judge = readings.judge ?? null;
  const { message } = shown;
  const kinds = (route?.k ?? []).flatMap((k) => kindOf(k) ?? []).filter((k, i, all) => all.indexOf(k) === i);
  const figure = text(sums?.q);
  const asked = asks(figure, route !== null, kinds, message);
  const missing = asked ? text(sums?.m) : null;
  const worked = sums === null ? [] : sums.s.map((s) => sumOf(s, asked));
  const choice = judge?.o != null && (kinds.includes('choice') || OPTIONS_PUT.test(message)) ? judge.o : null;
  const result =
    judge?.t != null &&
    (kinds.some((k) => k === 'result' || k === 'update' || k === 'pushback') || TELLS.test(message))
      ? judge.t
      : null;
  const found: UnderstoodKind[] = [
    ...(asked && (worked.length > 0 || missing !== null) ? (['sum'] as const) : []),
    ...(choice === null ? [] : (['choice'] as const)),
    ...(result === null || kinds.includes('pushback') ? [] : (['result'] as const)),
    ...(route?.p?.trim().toLowerCase() === PRIVACY_PLAY ? (['privacy'] as const) : []),
  ];
  const kind = kinds[0] ?? (route === null ? found[0] : 'question');
  if (kind === undefined) return null;
  const also = [...found, ...kinds].filter((k, i, all) => k !== kind && all.indexOf(k) === i).slice(0, 2);
  return {
    ask: text(route?.a) ?? (route === null ? askOf(figure, asked, choice) : ''),
    second_ask: text(route?.b),
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
    referral: route?.f ?? null,
    play: text(route?.p),
    step_play: text(route?.s),
    sure: route?.h === true ? 'high' : 'low',
    points: judge?.g ?? [],
    first_action: text(judge?.d),
    avoid: text(judge?.z),
  };
}

/** What they ask, where the part that says it did not come. */
function askOf(figure: string | null, asked: boolean, choice: JudgeReading['o']): string {
  if (asked && figure !== null) return figure;
  return choice === null ? 'what happened and what it shows' : `which to choose: ${choice.o.join(' or ')}`;
}

/** JUDGE tests the message against the record; ROUTE only points at the line, for when JUDGE is late. */
function contradictionOf(
  route: RouteReading | null,
  judge: JudgeReading | null,
  keys: ReadonlySet<string>,
): RawUnderstanding['contradicts'] {
  const key = (value: string | null | undefined): string | null =>
    [...(value ?? '').toUpperCase().matchAll(/R\d{1,3}/gu)].map((m) => m[0]).find((k) => keys.has(k)) ?? null;
  const pointed = key(route?.c);
  if (judge === null) return pointed === null ? null : { record: pointed, why: null };
  if (judge.x === null) return null;
  const why = text(judge.x.w);
  const record = key(judge.x.r) ?? pointed;
  return record === null || why === null ? null : { record, why };
}

/** `price=$70@R1` as a number of a sum; null: none. */
export function inputOf(said: string): RawInput | null {
  const cut = said.lastIndexOf('@');
  const body = cut < 0 ? said : said.slice(0, cut);
  const from = cut < 0 ? 'message' : said.slice(cut + 1).trim() || 'message';
  const eq = body.search(/[=:]/u);
  if (eq <= 0) return null;
  const name = body.slice(0, eq).trim();
  const shown = body.slice(eq + 1).trim();
  if (name === '' || shown === '') return null;
  const [figure] = figuresIn(shown);
  const negative = /^[-−]/u.test(shown) ? -1 : 1;
  const [amount] = saidAmounts(shown);
  if (figure === undefined && amount === undefined) return { name, value: Number.NaN, unit: 'count', from };
  const value = negative * (figure?.value ?? amount ?? Number.NaN);
  const mark = figure?.mark ?? null;
  const unit =
    mark === '$' || mark === 'foreign'
      ? '$'
      : mark === '%'
        ? '%'
        : /\b(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/iu.test(shown)
          ? 'time'
          : 'count';
  return { name, value, unit, from: /^conversation$/iu.test(from) ? 'history' : from };
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

const sumOf = (s: SumsReading['s'][number], asked: boolean): RawSum => ({
  label: s.l,
  ...unitOf(s.u),
  expr: s.e,
  round: 'none',
  asked,
});
